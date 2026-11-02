// Node dosya yardımcıları: proje dosyası okuma/yazma (referans ağlar yolla anılır), dosyaya dışa aktarım.
// Yalnızca Node'da çalışır (node:fs); tarayıcı paketi bu modülü içe aktarmaz. Başka projelere src/api.ts üzerinden
// sunulur; CLI (scripts/p3d.ts) de aynı fonksiyonları kullanır — kurallar tek yerde.
//
// Referans ağlar (mesh geom `src`): bellekte mutlak yol; dosyada proje dosyasının klasörüne göreli. Kaydederken kaynak
// dosya varsa ağ gömülmez (`embed: true` ile gömülür); açarken gömülü ağ yoksa kaynak dosya okunup `maxTris` ile aynı
// kimlikle depoya alınır. Kaynak bulunamazsa açıklayıcı hata: parça sessizce yer tutucu küpe dönmez.
// Dosyada gömülü gelen ağ, `embed` verilmeden kaydedilse de gömülü kalır (sessizce atılmasın). Kaynak dosyanın boyutu
// ve kısa özeti (`srcSize` / `srcHash`) geom'da tutulur: kaynak sonradan değişirse açarken uyarılır, gömülü ağ varsa o
// kullanılır; kaydederken değişmiş kaynağa yolla anmak yerine bellekteki ağ gömülür.
import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MeshAsset, MeshGeom } from '../shared/ops';
import { samePath } from '../scripts/config';
import { getAsset, registerAsset } from './assets';
import { initCsg } from './csg';
import { buildGlb, selectParts } from './gltf';
import { buildObj, mergedMesh, parseProject, worldMesh } from './io';
import { build3mf, buildStl, meshAssetFromSoup, parseMeshFile } from './meshio';
import type { Part, Project } from './types';

const listed = (items: string[]) => items.map((s) => `\n  - ${s}`).join('');

function statOf(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

const toArrayBuffer = (buf: Uint8Array) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;

/** Dosyayı ArrayBuffer olarak okur (parseMeshFile girdisi). */
export function readArrayBuffer(file: string): ArrayBuffer {
  return toArrayBuffer(readFileSync(file));
}

/** STL / OBJ / 3MF dosyasını üçgen çorbasına okur (mm, dosya koordinatları). */
export function readMeshFile(file: string): Float32Array {
  return parseMeshFile(file, readArrayBuffer(file));
}

/** Kaynak ağ dosyasının damgası (geom `srcSize` / `srcHash`): bayt boyutu + SHA-256'nın ilk 16 onaltılık hanesi. */
export interface SourceStamp {
  srcSize: number;
  srcHash: string;
}

export function sourceStamp(data: Uint8Array): SourceStamp {
  return { srcSize: data.byteLength, srcHash: createHash('sha256').update(data).digest('hex').slice(0, 16) };
}

/** Dosyanın damgası (okunamazsa Error). */
export function fileStamp(file: string): SourceStamp {
  return sourceStamp(readFileSync(file));
}

/** Geom'da damga var mı (eski dosyalarda yoktur: o zaman değişiklik denetlenemez). */
const hasStamp = (g: MeshGeom) => g.srcSize !== undefined || g.srcHash !== undefined;
/** Geom'daki damga dosyanınkiyle uyuşuyor mu (yalnızca bulunan alanlar karşılaştırılır). */
const stampMatches = (g: MeshGeom, s: SourceStamp) =>
  (g.srcSize === undefined || g.srcSize === s.srcSize) && (g.srcHash === undefined || g.srcHash === s.srcHash);

/**
 * Bu süreçte bir proje dosyasından gömülü olarak yüklenen ağ kimlikleri (loadProjectFile doldurur). Kaydederken bunlar
 * `embed` verilmese de gömülü kalır: `--embed` ile yazılmış bir dosya sonradan `--embed`siz kaydedilince ağ atılmasın.
 * Proje biçimine alan eklemeden tutulur (kimlikler rastgele; aynı kimlik aynı ağdır).
 */
const loadedEmbedded = new Set<string>();

/** Önce aynı klasörde geçici dosyaya yazar, sonra yeniden adlandırır: yarıda kalan yazma mevcut dosyayı bozmasın. */
export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`${file} yazılamadı: ${(e as Error).message}`);
  }
}

/**
 * Yazılacak proje dosyası zaten varsa parça sayısı ve dosyada gömülü ağ kimlikleri, yoksa null. Var ama P3D projesi
 * değilse (format/parts yok, bozuk JSON) ya da klasörse Error: üzerine hiç yazılmaz (yanlışlıkla başka bir dosyayı
 * ezmemek için).
 */
export function existingProjectFile(file: string): { parts: number; assets: string[] } | null {
  const st = statOf(file);
  if (!st) return null;
  if (st.isDirectory()) throw new Error(`Bu bir klasör: ${file}; dosya adı yazın (ör. model.p3d.json).`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    raw = undefined;
  }
  const o = raw as { format?: unknown; parts?: unknown; assets?: unknown } | undefined;
  if (!o || typeof o !== 'object' || o.format !== 'p3d' || !Array.isArray(o.parts)) {
    throw new Error(
      `${file} var ama bir P3D proje dosyası değil ("format": "p3d" ve "parts" yok); üzerine yazılmadı. ` +
        'Başka bir dosya adı verin ya da dosyayı kendiniz taşıyın/silin.',
    );
  }
  return { parts: o.parts.length, assets: embeddedIds(o.assets) };
}

/** Proje dosyasının `assets` alanındaki ağ kimlikleri (doğrulanmadan). */
function embeddedIds(assets: unknown): string[] {
  if (!assets || typeof assets !== 'object') return [];
  return Object.values(assets as Record<string, unknown>)
    .map((a) => (a as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

// ---------------------------------------------------------------------------
// Proje dosyası

export interface LoadOptions {
  /**
   * Okunamayan parçalar ("ad: neden") buraya eklenir ve yükleme sürer. Verilmezse okunamayan parça varsa Error
   * fırlatılır: dosyadaki parça sessizce kaybolmasın.
   */
  dropped?: string[];
  /**
   * Uyarılar (ör. "kaynak dosya değişmiş") buraya eklenir. Verilmezse `console.warn` ile basılır (sessiz kalmasın).
   */
  warnings?: string[];
}

/** JSON metnini (BOM'lu olabilir) okur; dosya yoksa ya da bozuksa dosya yolunu içeren Türkçe Error. */
export function readJsonFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(statOf(file) ? `${file} okunamadı: ${(e as Error).message}` : `Dosya bulunamadı: ${file}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`${file} geçerli JSON değil: ${(e as Error).message}`);
  }
}

/**
 * `.p3d.json` dosyasını okur, doğrular (parseProject) ve ağları depoya alır: gömülü ağlar dosyadan, gömülü olmayanlar
 * `src` kaynak dosyasından (proje dosyasının klasörüne göre çözülür; bellekte mutlak yol olur). Gömülü gelen ağlar
 * hatırlanır (kaydederken gömülü kalır). Kaynak dosya kayıttaki damgayla (`srcSize` / `srcHash`) uyuşmazsa uyarı verir;
 * gömülü ağ varsa o kullanılır. Boolean çekirdeğini de hazırlar (delikler, ölçüm, dışa aktarım için).
 */
export async function loadProjectFile(file: string, opts: LoadOptions = {}): Promise<Project> {
  const abs = path.resolve(file);
  const raw = readJsonFile(abs);
  const dropped: string[] = [];
  let project: Project;
  try {
    project = parseProject(raw, dropped);
  } catch (e) {
    throw new Error(`${abs}: ${(e as Error).message}`);
  }
  const rawParts = (raw as { parts?: unknown }).parts;
  const rawCount = Array.isArray(rawParts) ? rawParts.length : 0;
  if (rawCount !== project.parts.length && !dropped.length) dropped.push(`${rawCount - project.parts.length} parça (neden bilinmiyor)`);
  if (dropped.length) {
    if (!opts.dropped) throw new Error(`${abs}: ${dropped.length} parça okunamadı:${listed(dropped)}`);
    opts.dropped.push(...dropped);
  }
  const embedded = new Set(embeddedIds((raw as { assets?: unknown }).assets).filter((id) => getAsset(id)));
  await initCsg();
  const warnings: string[] = [];
  await resolveMeshSources(project, path.dirname(abs), abs, embedded, warnings);
  for (const id of embedded) loadedEmbedded.add(id);
  if (opts.warnings) opts.warnings.push(...warnings);
  else for (const w of warnings) console.warn(`⚠ ${w}`);
  return project;
}

/**
 * Mesh `src`'lerini mutlak yola çevirir; ağı depoda olmayanları kaynak dosyadan okuyup projedeki kimlikle kaydeder ve
 * damgasını (srcSize / srcHash) günceller. Ağı zaten olan parçada (`embedded`: bu dosyada gömülü) kaynak okunmaz;
 * yalnızca damgası tutmuyorsa uyarılır.
 */
async function resolveMeshSources(project: Project, dir: string, where: string, embedded: ReadonlySet<string>, warnings: string[]): Promise<void> {
  const missing: string[] = [];
  for (const p of project.parts) {
    const g = p.geom;
    if (g?.kind !== 'mesh') continue;
    if (g.src) g.src = path.resolve(dir, g.src);
    if (getAsset(g.asset)) {
      let stamp: SourceStamp | null = null;
      try {
        if (g.src && hasStamp(g) && statOf(g.src)?.isFile()) stamp = fileStamp(g.src);
      } catch {
        // okunamayan kaynak: karşılaştırılamaz, eldeki ağ kullanılır
      }
      if (stamp && !stampMatches(g, stamp)) {
        const used = embedded.has(g.asset) ? 'dosyaya gömülü ağ' : 'bellekte yüklü ağ';
        warnings.push(`'${p.name}': kaynak dosya değişmiş (${g.src}); ${used} kullanıldı, kaynak okunmadı.`);
      }
      continue;
    }
    if (!g.src) {
      missing.push(`'${p.name}': ağ verisi dosyaya gömülü değil ve kaynak dosya (src) yok`);
      continue;
    }
    if (!statOf(g.src)?.isFile()) {
      missing.push(`'${p.name}': kaynak ağ dosyası bulunamadı: ${g.src}`);
      continue;
    }
    try {
      const data = readFileSync(g.src);
      const stamp = sourceStamp(data);
      const imp = await meshAssetFromSoup(path.basename(g.src).replace(/\.[^.]+$/, ''), parseMeshFile(g.src, toArrayBuffer(data)), g.maxTris);
      registerAsset(imp.asset, g.asset);
      if (hasStamp(g) && !stampMatches(g, stamp)) {
        warnings.push(`'${p.name}': kaynak dosya değişmiş (${g.src}); ağ dosyanın yeni içeriğinden okundu, kaydedildiği hâlden farklı olabilir.`);
      }
      // Ağ artık bu içerikten: damga onu anlatır.
      g.srcSize = stamp.srcSize;
      g.srcHash = stamp.srcHash;
    } catch (e) {
      missing.push(`'${p.name}': ${g.src} okunamadı: ${(e as Error).message}`);
    }
  }
  if (missing.length) {
    throw new Error(
      `${where}: ${missing.length} ağ (mesh) parçasının verisi yüklenemedi:${listed(missing)}\n` +
        'Kaynak dosyayı yerine koyun, yolu (geom.src, proje dosyasına göreli) düzeltin ya da parçayı silin.',
    );
  }
}

export interface SaveOptions {
  /**
   * true: `src`'si olan ağlar da dosyaya gömülür. Varsayılan: kaynak dosya varsa ağ gömülmez, yolla anılır — ama bir
   * proje dosyasından gömülü yüklenmiş ya da hedef dosyada zaten gömülü olan ağ gömülü kalır.
   */
  embed?: boolean;
  /** false: hedef dosya zaten varsa yazılmaz (Error). Varsayılan true: mevcut bir P3D dosyasının üzerine yazılır. */
  overwrite?: boolean;
}

export interface SaveResult {
  /** Yazılan dosyanın mutlak yolu. */
  file: string;
  parts: number;
  /** Dosyaya gömülen farklı ağ sayısı. */
  embedded: number;
  /** Yolla anılan (gömülmeyen) farklı ağ sayısı. */
  referenced: number;
  /** Ör. kaynak dosyası bulunamadığı ya da değiştiği için gömülen ağlar. */
  warnings: string[];
}

/** `to` yolunu `dir`'e göre yazar (ileri eğik çizgiyle); başka sürücüdeyse mutlak kalır. */
function relativeSrc(dir: string, to: string): string {
  const rel = path.relative(dir, to);
  return path.isAbsolute(rel) ? to : rel.split(path.sep).join('/');
}

/**
 * Projenin `abs` dosyasına yazılacak metni. Mesh parçalarında kaynak dosya (`src`) varsa yol dosyanın klasörüne göreli
 * yazılır; ağ gömülmez, damgası (srcSize / srcHash) yazılır. Gömülenler: `embedAll`, `keep` kümesindekiler (dosyadan
 * gömülü gelenler, hedefte zaten gömülü olanlar), kaynağı olmayan / bulunamayan / okunamayan ve kaynağı kayıttaki
 * damgadan farklı olanlar (bellekteki ağ değişmiş kaynağın yerine geçmesin). Ağ verisi bellekte olmayan gömülecek
 * parçalar `missing`'e girer (çağıran yazmaz).
 */
function serializeProject(
  project: Project,
  abs: string,
  embedAll: boolean,
  keep: ReadonlySet<string>,
): Omit<SaveResult, 'file'> & { text: string; missing: string[] } {
  const dir = path.dirname(abs);
  const assets: Record<string, MeshAsset> = {};
  const missing: string[] = [];
  const warnings: string[] = [];
  const referenced = new Set<string>();
  const stamps = new Map<string, SourceStamp | null>(); // aynı kaynak bir kez okunur
  const stampOf = (file: string) => {
    if (!stamps.has(file)) {
      try {
        stamps.set(file, fileStamp(file));
      } catch {
        stamps.set(file, null);
      }
    }
    return stamps.get(file)!;
  };
  const parts: Part[] = project.parts.map((p) => {
    const g = p.geom;
    if (g?.kind !== 'mesh') return p;
    const src = g.src ? path.resolve(g.src) : undefined;
    const srcOk = !!src && !!statOf(src)?.isFile();
    const geom: MeshGeom = { ...g };
    if (src && srcOk) geom.src = relativeSrc(dir, src);
    const a = getAsset(g.asset);
    const stamp = src && srcOk && !embedAll && !keep.has(g.asset) ? stampOf(src) : null;
    if (stamp) {
      const changed = hasStamp(g) && !stampMatches(g, stamp);
      if (!changed || !a) {
        // Değişmiş kaynak yalnızca bellekte ağ yoksa (yer tutucu) yolla anılır: korunacak başka veri yok.
        if (changed) warnings.push(`'${p.name}': kaynak dosya değişmiş (${src}) ve ağ bellekte yok; kaynağın yeni içeriğine yolla anıldı.`);
        referenced.add(g.asset);
        return { ...p, geom: { ...geom, ...stamp } };
      }
      warnings.push(`'${p.name}': kaynak dosya değişmiş (${src}); bellekteki ağ dosyaya gömüldü (kaynağın yeni içeriği kullanılmadı).`);
    }
    if (a) {
      assets[a.id] = a;
      if (src && !srcOk) warnings.push(`'${p.name}': kaynak ağ dosyası bulunamadı (${src}); ağ dosyaya gömüldü.`);
    } else {
      missing.push(`'${p.name}'${src && !srcOk ? ` (kaynak dosya da yok: ${src})` : ''}`);
    }
    return { ...p, geom };
  });
  const { assets: _ignored, ...rest } = project;
  const embedded = Object.keys(assets).length;
  const text = JSON.stringify({ ...rest, parts, ...(embedded ? { assets } : {}) }, null, 2);
  return { text, parts: parts.length, embedded, referenced: referenced.size, warnings, missing };
}

function missingError(missing: string[], abs: string): Error {
  return new Error(
    `Şu ağ (mesh) parçalarının ağ verisi yok: ${missing.join(', ')} — ağ bellekte yüklü değil (ör. sekmede yer tutucu ` +
      `küp görünüyor: ağ otomatik kayda sığmamış). ${abs} yazılmadı; ağı yeniden içe aktarın (p3d import) ya da parçayı silin.`,
  );
}

/**
 * `embed` verilmese de gömülü kalacak ağlar: bu süreçte bir proje dosyasından gömülü yüklenenler + hedef dosyada zaten
 * gömülü olanlar (ör. sekmeden `p3d save`: yüklemeyi başka süreç yaptı ama hedef dosya ağı gömülü taşıyor).
 */
function keptEmbedded(existing: { assets: string[] } | null): Set<string> {
  return new Set([...loadedEmbedded, ...(existing?.assets ?? [])]);
}

/**
 * Projeyi `.p3d.json` olarak atomik yazar (geçici dosya + yeniden adlandırma). Mesh parçalarında kaynak dosya (`src`)
 * varsa yol dosyanın klasörüne göreli yazılır ve ağ gömülmez (`embed` ile gömülür); kaynağı olmayan, bulunamayan ya da
 * değişmiş ağlar ve dosyadan gömülü gelenler gömülür (bkz. serializeProject). P3D dosyası olmayan bir dosyanın üzerine
 * yazmaz (`overwrite: false` ile hiçbir dosyanın); ağ verisi olmayan parça varsa yazmaz.
 */
export function saveProjectFile(project: Project, file: string, opts: SaveOptions = {}): SaveResult {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  if (!statOf(dir)?.isDirectory()) throw new Error(`Klasör bulunamadı: ${dir} (dosya: ${abs})`);
  const existing = existingProjectFile(abs);
  if (existing && opts.overwrite === false) throw new Error(`${abs} zaten var; üzerine yazılmadı.`);
  const out = serializeProject(project, abs, !!opts.embed, keptEmbedded(existing));
  if (out.missing.length) throw missingError(out.missing, abs);
  writeFileAtomic(abs, out.text);
  return { file: abs, parts: out.parts, embedded: out.embedded, referenced: out.referenced, warnings: out.warnings };
}

/**
 * Projenin `file`'a kaydedilseydi yazılacak metni (saveProjectFile ile aynı kurallar; dosyaya yazmaz). `p3d scene
 * --file --full` bunu basar: `src` göreli, dosyada gömülü gelen ağlar gömülü.
 */
export function projectFileText(project: Project, file: string, opts: Pick<SaveOptions, 'embed'> = {}): string {
  const abs = path.resolve(file);
  let existing: { assets: string[] } | null = null;
  try {
    existing = existingProjectFile(abs);
  } catch {
    // P3D dosyası değil: yalnızca bu süreçte gömülü yüklenenler korunur
  }
  const out = serializeProject(project, abs, !!opts.embed, keptEmbedded(existing));
  if (out.missing.length) throw missingError(out.missing, abs);
  return out.text;
}

// ---------------------------------------------------------------------------
// Dışa aktarım

export const EXPORT_FORMATS = ['stl', '3mf', 'obj', 'glb'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportOptions {
  /** Yalnızca bu parçalar ya da grupların üyeleri (ad veya kimlik); yoksa tüm görünür katılar. */
  parts?: string[];
  /** STL / 3MF: parçaların birleşimi (union) tek kapalı gövde olarak. */
  merge?: boolean;
  /** GLB: tek skinned mesh + grup başına eklem (bkz. GlbOptions). */
  skeleton?: boolean;
  /** GLB: 'm' (varsayılan) ya da 'mm'. */
  units?: 'm' | 'mm';
  /** GLB: 'flat' (varsayılan) ya da 'smooth'. */
  normals?: 'flat' | 'smooth';
}

export interface ExportResult {
  /** Yazılan dosyanın mutlak yolu. */
  file: string;
  format: ExportFormat;
  /** Dosyaya giren parça sayısı (birleştirmede birleştirilen parça sayısı). */
  parts: number;
  bytes: number;
}

/**
 * Görünür katıları (delikler uygulanmış) dosyaya yazar; biçim uzantıdan: .stl, .3mf, .obj, .glb. Birim mm, Z yukarı
 * (GLB: Y yukarı, varsayılan metre). Yazma atomiktir. Boolean çekirdeğini kendisi hazırlar.
 */
export async function exportFile(project: Project, outPath: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const abs = path.resolve(outPath);
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!(EXPORT_FORMATS as readonly string[]).includes(ext)) {
    throw new Error(`Dışa aktarım biçimi uzantıdan anlaşılamadı ('${path.basename(abs)}'): .stl, .3mf, .obj ya da .glb kullanın.`);
  }
  const format = ext as ExportFormat;
  if (format !== 'glb') {
    const glbOnly = (['skeleton', 'units', 'normals'] as const).filter((k) => opts[k] !== undefined && opts[k] !== false);
    if (glbOnly.length) throw new Error(`${glbOnly.join(', ')} yalnızca GLB için; ${format.toUpperCase()} her zaman mm, Z yukarı.`);
  }
  if (opts.merge && format !== 'stl' && format !== '3mf') throw new Error('Birleştirme (merge) yalnızca STL ve 3MF için.');
  if (opts.units !== undefined && opts.units !== 'm' && opts.units !== 'mm') throw new Error(`Birim 'm' ya da 'mm' olmalı ('${String(opts.units)}').`);
  if (opts.normals !== undefined && opts.normals !== 'flat' && opts.normals !== 'smooth') {
    throw new Error(`Normaller 'flat' ya da 'smooth' olmalı ('${String(opts.normals)}').`);
  }
  if (!statOf(path.dirname(abs))?.isDirectory()) throw new Error(`Klasör bulunamadı: ${path.dirname(abs)}`);
  // Referans ağın kaynak dosyası ezilmesin (ör. export ref.stl): yalnızca dışa aktarılanlar değil, tüm parçalar.
  const clash = project.parts.find((p) => p.geom?.kind === 'mesh' && p.geom.src && samePath(p.geom.src, abs));
  if (clash) {
    throw new Error(`${abs} '${clash.name}' parçasının kaynak ağ dosyası (src); üzerine yazılmadı. Başka bir çıktı dosyası adı verin.`);
  }
  await initCsg();
  const parts = selectParts(project, opts.parts);
  if (!parts.length) throw new Error('Dışa aktarılacak görünür katı parça yok.');
  // Ağ verisi yüklü olmayan mesh parçası dosyaya yer tutucu küp olarak girerdi.
  const noMesh = parts.filter((p) => p.geom?.kind === 'mesh' && !getAsset(p.geom.asset)).map((p) => `'${p.name}'`);
  if (noMesh.length) {
    throw new Error(`Şu ağ (mesh) parçalarının ağ verisi yüklü değil: ${noMesh.join(', ')} — dosyaya yer tutucu küp girerdi; ${abs} yazılmadı.`);
  }
  const meshes = () => (opts.merge ? [mergedMesh(project, parts)] : parts.map((p) => worldMesh(project, p)));
  let data: Uint8Array;
  switch (format) {
    case 'stl':
      data = new Uint8Array(buildStl(meshes()));
      break;
    case '3mf':
      data = build3mf(project.name, meshes());
      break;
    case 'obj':
      data = new TextEncoder().encode(buildObj(parts, project, null).obj);
      break;
    case 'glb':
      data = buildGlb(project, { parts: opts.parts, skeleton: opts.skeleton, units: opts.units, normals: opts.normals });
      break;
  }
  writeFileAtomic(abs, data);
  return { file: abs, format, parts: parts.length, bytes: data.length };
}
