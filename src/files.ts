// Node dosya yardımcıları: proje dosyası okuma/yazma (referans ağlar yolla anılır), dosyaya dışa aktarım.
// Yalnızca Node'da çalışır (node:fs); tarayıcı paketi bu modülü içe aktarmaz. Başka projelere src/api.ts üzerinden
// sunulur; CLI (scripts/p3d.ts) de aynı fonksiyonları kullanır — kurallar tek yerde.
//
// Referans ağlar (mesh geom `src`): bellekte mutlak yol; dosyada proje dosyasının klasörüne göreli. Kaydederken kaynak
// dosya varsa ağ gömülmez (`embed: true` ile gömülür); açarken gömülü ağ yoksa kaynak dosya okunup `maxTris` ile aynı
// kimlikle depoya alınır. Kaynak bulunamazsa açıklayıcı hata: parça sessizce yer tutucu küpe dönmez.
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MeshAsset, MeshGeom } from '../shared/ops';
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

/** Dosyayı ArrayBuffer olarak okur (parseMeshFile girdisi). */
export function readArrayBuffer(file: string): ArrayBuffer {
  const buf = readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** STL / OBJ / 3MF dosyasını üçgen çorbasına okur (mm, dosya koordinatları). */
export function readMeshFile(file: string): Float32Array {
  return parseMeshFile(file, readArrayBuffer(file));
}

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
 * Yazılacak proje dosyası zaten varsa parça sayısı, yoksa null. Var ama P3D projesi değilse (format/parts yok, bozuk
 * JSON) ya da klasörse Error: üzerine hiç yazılmaz (yanlışlıkla başka bir dosyayı ezmemek için).
 */
export function existingProjectFile(file: string): { parts: number } | null {
  const st = statOf(file);
  if (!st) return null;
  if (st.isDirectory()) throw new Error(`Bu bir klasör: ${file}; dosya adı yazın (ör. model.p3d.json).`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    raw = undefined;
  }
  const o = raw as { format?: unknown; parts?: unknown } | undefined;
  if (!o || typeof o !== 'object' || o.format !== 'p3d' || !Array.isArray(o.parts)) {
    throw new Error(
      `${file} var ama bir P3D proje dosyası değil ("format": "p3d" ve "parts" yok); üzerine yazılmadı. ` +
        'Başka bir dosya adı verin ya da dosyayı kendiniz taşıyın/silin.',
    );
  }
  return { parts: o.parts.length };
}

// ---------------------------------------------------------------------------
// Proje dosyası

export interface LoadOptions {
  /**
   * Okunamayan parçalar ("ad: neden") buraya eklenir ve yükleme sürer. Verilmezse okunamayan parça varsa Error
   * fırlatılır: dosyadaki parça sessizce kaybolmasın.
   */
  dropped?: string[];
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
 * `src` kaynak dosyasından (proje dosyasının klasörüne göre çözülür; bellekte mutlak yol olur). Boolean çekirdeğini de
 * hazırlar (delikler, ölçüm, dışa aktarım için).
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
  await initCsg();
  await resolveMeshSources(project, path.dirname(abs), abs);
  return project;
}

/** Mesh `src`'lerini mutlak yola çevirir; ağı depoda olmayanları kaynak dosyadan okuyup projedeki kimlikle kaydeder. */
async function resolveMeshSources(project: Project, dir: string, where: string): Promise<void> {
  const missing: string[] = [];
  for (const p of project.parts) {
    const g = p.geom;
    if (g?.kind !== 'mesh') continue;
    if (g.src) g.src = path.resolve(dir, g.src);
    if (getAsset(g.asset)) continue;
    if (!g.src) {
      missing.push(`'${p.name}': ağ verisi dosyaya gömülü değil ve kaynak dosya (src) yok`);
      continue;
    }
    if (!statOf(g.src)?.isFile()) {
      missing.push(`'${p.name}': kaynak ağ dosyası bulunamadı: ${g.src}`);
      continue;
    }
    try {
      const imp = await meshAssetFromSoup(path.basename(g.src).replace(/\.[^.]+$/, ''), readMeshFile(g.src), g.maxTris);
      registerAsset(imp.asset, g.asset);
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
  /** true: `src`'si olan ağlar da dosyaya gömülür. Varsayılan: kaynak dosya varsa ağ gömülmez, yolla anılır. */
  embed?: boolean;
}

export interface SaveResult {
  /** Yazılan dosyanın mutlak yolu. */
  file: string;
  parts: number;
  /** Dosyaya gömülen farklı ağ sayısı. */
  embedded: number;
  /** Yolla anılan (gömülmeyen) farklı ağ sayısı. */
  referenced: number;
  /** Ör. kaynak dosyası bulunamadığı için gömülen ağlar. */
  warnings: string[];
}

/** `to` yolunu `dir`'e göre yazar (ileri eğik çizgiyle); başka sürücüdeyse mutlak kalır. */
function relativeSrc(dir: string, to: string): string {
  const rel = path.relative(dir, to);
  return path.isAbsolute(rel) ? to : rel.split(path.sep).join('/');
}

/**
 * Projeyi `.p3d.json` olarak atomik yazar (geçici dosya + yeniden adlandırma). Mesh parçalarında kaynak dosya (`src`)
 * varsa yol dosyanın klasörüne göreli yazılır ve ağ gömülmez (`embed` ile gömülür); kaynağı olmayan ya da kaynağı
 * bulunamayan ağlar gömülür. P3D dosyası olmayan bir dosyanın üzerine yazmaz; ağ verisi olmayan parça varsa yazmaz.
 */
export function saveProjectFile(project: Project, file: string, opts: SaveOptions = {}): SaveResult {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  if (!statOf(dir)?.isDirectory()) throw new Error(`Klasör bulunamadı: ${dir} (dosya: ${abs})`);
  existingProjectFile(abs);
  const assets: Record<string, MeshAsset> = {};
  const missing: string[] = [];
  const warnings: string[] = [];
  const referenced = new Set<string>();
  const parts: Part[] = project.parts.map((p) => {
    const g = p.geom;
    if (g?.kind !== 'mesh') return p;
    const src = g.src ? path.resolve(g.src) : undefined;
    const srcOk = !!src && !!statOf(src)?.isFile();
    const geom: MeshGeom = { ...g };
    if (src && srcOk) geom.src = relativeSrc(dir, src);
    if (srcOk && !opts.embed) {
      referenced.add(g.asset);
      return { ...p, geom };
    }
    const a = getAsset(g.asset);
    if (a) {
      assets[a.id] = a;
      if (src && !srcOk) warnings.push(`'${p.name}': kaynak ağ dosyası bulunamadı (${src}); ağ dosyaya gömüldü.`);
    } else {
      missing.push(`'${p.name}'${src && !srcOk ? ` (kaynak dosya da yok: ${src})` : ''}`);
    }
    return { ...p, geom };
  });
  if (missing.length) {
    throw new Error(
      `Şu ağ (mesh) parçalarının ağ verisi yok: ${missing.join(', ')} — ağ bellekte yüklü değil (ör. sekmede yer tutucu ` +
        `küp görünüyor: ağ otomatik kayda sığmamış). ${abs} yazılmadı; ağı yeniden içe aktarın (p3d import) ya da parçayı silin.`,
    );
  }
  const { assets: _ignored, ...rest } = project;
  const embedded = Object.keys(assets).length;
  writeFileAtomic(abs, JSON.stringify({ ...rest, parts, ...(embedded ? { assets } : {}) }, null, 2));
  return { file: abs, parts: parts.length, embedded, referenced: referenced.size, warnings };
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
