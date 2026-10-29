import * as THREE from 'three';
import { strToU8, zipSync } from 'fflate';
import { SHAPES, isGeomShape } from '../shared/ops';
import { registerAsset, usedAssets } from './assets';
import { isHexColor, normalizeHex } from './colors';
import { newId, partMatrix } from './engine';
import { sanitizeGeom } from './geom';
import { build3mf, buildStl, type WorldMesh } from './meshio';
import { unionGeometries } from './csg';
import { exportGeometry, exportableParts } from './model';
import { PALETTE, defaultParams, sanitizeParams } from './shapes';
import { newProject, type Part, type Project } from './types';

// ---------------------------------------------------------------------------
// Proje dosyası (.p3d.json)

/** Proje dosyası metni; mesh parçalarının ağ verisi `assets` altında dosyaya gömülür. */
export function projectToJson(project: Project): string {
  const assets = usedAssets(project);
  return JSON.stringify(Object.keys(assets).length ? { ...project, assets } : project, null, 2);
}

/** Dosyadan/otomatik kayıttan gelen veriyi doğrular; bilinmeyen alanları atar, eksikleri tamamlar. */
export function parseProject(data: unknown): Project {
  if (!data || typeof data !== 'object') throw new Error('Geçersiz proje dosyası.');
  const d = data as Record<string, unknown>;
  if (d.format !== 'p3d') throw new Error('Bu bir P3D proje dosyası değil.');
  const base = newProject(typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'Proje');
  const view = (d.view ?? {}) as Record<string, unknown>;
  const settings = (d.settings ?? {}) as Record<string, unknown>;
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  base.view.showNames = view.showNames !== false;
  base.view.showDimensions = view.showDimensions !== false;
  base.view.showHoles = view.showHoles !== false;
  base.settings.resolution = Math.round(num(settings.resolution, base.settings.resolution, 16, 256));
  base.settings.bedX = num(settings.bedX, base.settings.bedX, 20, 2000);
  base.settings.bedY = num(settings.bedY, base.settings.bedY, 20, 2000);

  // Ağ verisi depoya alınır; proje nesnesinde tutulmaz (bkz. assets.ts).
  if (d.assets && typeof d.assets === 'object') {
    for (const a of Object.values(d.assets as Record<string, unknown>)) {
      try {
        registerAsset(a);
      } catch (e) {
        console.warn('[p3d] ağ verisi atlandı:', (e as Error).message);
      }
    }
  }

  const ids = new Set<string>();
  const parts = Array.isArray(d.parts) ? d.parts : [];
  parts.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    if (!SHAPES.includes(r.shape as never)) return;
    const shape = r.shape as Part['shape'];
    const params = { ...defaultParams(shape), ...((r.params ?? {}) as Record<string, number>) };
    sanitizeParams(shape, params);
    let geom: Part['geom'];
    if (isGeomShape(shape)) {
      try {
        geom = sanitizeGeom(shape, r.geom);
      } catch (e) {
        console.warn(`[p3d] '${String(r.name)}' atlandı:`, (e as Error).message);
        return;
      }
    }
    const vec = (v: unknown) => {
      const o = (v ?? {}) as Record<string, unknown>;
      return { x: num(o.x, 0, -1e5, 1e5), y: num(o.y, 0, -1e5, 1e5), z: num(o.z, 0, -1e5, 1e5) };
    };
    let id = typeof r.id === 'string' && r.id ? r.id : newId();
    if (ids.has(id)) id = newId();
    ids.add(id);
    base.parts.push({
      id,
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `Parça ${i + 1}`,
      shape,
      params,
      position: vec(r.position),
      rotation: vec(r.rotation),
      color: typeof r.color === 'string' && isHexColor(r.color) ? normalizeHex(r.color) : PALETTE[i % PALETTE.length],
      visible: r.visible !== false,
      ...(geom ? { geom } : {}),
      ...(r.role === 'hole' || r.role === 'reference' ? { role: r.role } : {}),
      ...(r.role === 'hole' && Array.isArray(r.cuts) && r.cuts.length ? { cuts: r.cuts.filter((c): c is string => typeof c === 'string') } : {}),
    });
  });
  return base;
}

// ---------------------------------------------------------------------------
// İndirme

export function safeFileName(s: string): string {
  return asciiName(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'model';
}

function asciiName(s: string): string {
  const map: Record<string, string> = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' };
  return s.replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => map[c]).normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function download(filename: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------------------
// OBJ / MTL

/** Parçanın son hâli (delikler çıkarılmış), dünya koordinatlarında kaynaklı üçgen ağ. Birim: mm, Z yukarı. */
export function worldMesh(project: Project, part: Part): WorldMesh {
  // İndisli son geometri olduğu gibi: konuma göre yeniden kaynaklamak, değen yüzeylerdeki ayrı köşeleri çökertir.
  const g = exportGeometry(project, part);
  g.applyMatrix4(partMatrix(part));
  const pos = g.getAttribute('position').array as Float32Array;
  const index = g.getIndex()!;
  const tris: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i);
    const b = index.getX(i + 1);
    const c = index.getX(i + 2);
    if (a !== b && b !== c && a !== c) tris.push(a, b, c); // kutup/tepe noktalarındaki dejenere üçgenler
  }
  g.dispose();
  return { name: part.name, color: part.color, pos, tris };
}

function objName(part: Part): string {
  return asciiName(part.name).replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '') || part.id;
}

const f4 = (n: number) => {
  const s = n.toFixed(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

export interface ObjOutput {
  obj: string;
  mtl: string;
}

/** Parçaları tek bir OBJ'de ayrı nesneler olarak yazar; `mtlFile` verilirse renkler için MTL'ye bağlar. */
export function buildObj(parts: Part[], project: Project, mtlFile: string | null): ObjOutput {
  const lines: string[] = [
    `# P3D - ${project.name}`,
    '# Birim: mm, Z ekseni yukari (tabla XY duzlemi)',
  ];
  if (mtlFile) lines.push(`mtllib ${mtlFile}`);
  const mtl: string[] = [`# P3D - ${project.name}`];
  const usedNames = new Set<string>();
  let offset = 1;
  for (const part of parts) {
    let name = objName(part);
    while (usedNames.has(name)) name += '_';
    usedNames.add(name);
    const { pos, tris } = worldMesh(project, part);
    const c = new THREE.Color(part.color);
    mtl.push('', `newmtl mat_${name}`, `Kd ${f4(c.r)} ${f4(c.g)} ${f4(c.b)}`, 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1');
    lines.push('', `o ${name}`, `# ${part.name}`);
    if (mtlFile) lines.push(`usemtl mat_${name}`);
    for (let i = 0; i < pos.length; i += 3) lines.push(`v ${f4(pos[i])} ${f4(pos[i + 1])} ${f4(pos[i + 2])}`);
    for (let i = 0; i < tris.length; i += 3) lines.push(`f ${tris[i] + offset} ${tris[i + 1] + offset} ${tris[i + 2] + offset}`);
    offset += pos.length / 3;
  }
  return { obj: lines.join('\n') + '\n', mtl: mtl.join('\n') + '\n' };
}

export type ExportKind =
  | 'all-obj'
  | 'all-zip'
  | 'each-zip'
  | 'selected-obj'
  | 'all-stl'
  | 'selected-stl'
  | 'all-3mf'
  | 'merged-stl'
  | 'merged-3mf';

/** Görünür katıların birleşimi (union): örtüşen parçalar tek kapalı gövde olur (dilimleyiciye tek parça). */
export function mergedMesh(project: Project, parts: Part[]): WorldMesh {
  const geoms = parts.map((p) => {
    const m = worldMesh(project, p);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    g.setIndex(m.tris);
    return g;
  });
  const u = unionGeometries(geoms);
  for (const g of geoms) g.dispose();
  const pos = u.getAttribute('position').array as Float32Array;
  const tris = Array.from(u.getIndex()!.array);
  u.dispose();
  return { name: project.name, color: parts[0]?.color ?? '#cccccc', pos, tris };
}

/** Dışa aktarır ve indirir. Yalnızca görünür katılar çıkar; delik ve referans parçalar dosyaya girmez. */
export function exportModel(kind: ExportKind, project: Project, selectedId: string | null): string {
  const base = safeFileName(project.name);
  const visible = exportableParts(project.parts);
  if (kind === 'selected-obj' || kind === 'selected-stl') {
    const part = project.parts.find((p) => p.id === selectedId);
    if (!part) throw new Error('Önce bir parça seçin.');
    if ((part.role ?? 'solid') !== 'solid') throw new Error(`'${part.name}' bir ${part.role === 'hole' ? 'delik' : 'referans'} parçası; dışa aktarılmaz.`);
    const file = safeFileName(part.name);
    if (kind === 'selected-stl') {
      download(`${file}.stl`, buildStl([worldMesh(project, part)]), 'model/stl');
      return `'${part.name}' → ${file}.stl`;
    }
    download(`${file}.obj`, buildObj([part], project, null).obj, 'model/obj');
    return `'${part.name}' → ${file}.obj`;
  }
  if (!visible.length) throw new Error('Dışa aktarılacak görünür katı parça yok.');
  if (kind === 'all-stl') {
    download(`${base}.stl`, buildStl(visible.map((p) => worldMesh(project, p))), 'model/stl');
    return `${visible.length} parça → ${base}.stl`;
  }
  if (kind === 'merged-stl' || kind === 'merged-3mf') {
    const m = mergedMesh(project, visible);
    if (kind === 'merged-stl') download(`${base}_birlesik.stl`, buildStl([m]), 'model/stl');
    else download(`${base}_birlesik.3mf`, build3mf(project.name, [m]) as BlobPart, 'model/3mf');
    return `${visible.length} parça birleştirildi → ${base}_birlesik.${kind === 'merged-stl' ? 'stl' : '3mf'} (tek gövde)`;
  }
  if (kind === 'all-3mf') {
    download(`${base}.3mf`, build3mf(project.name, visible.map((p) => worldMesh(project, p))) as BlobPart, 'model/3mf');
    return `${visible.length} parça → ${base}.3mf (renkli, parça başına nesne)`;
  }
  if (kind === 'all-obj') {
    download(`${base}.obj`, buildObj(visible, project, null).obj, 'model/obj');
    return `${visible.length} parça → ${base}.obj`;
  }
  if (kind === 'all-zip') {
    const { obj, mtl } = buildObj(visible, project, `${base}.mtl`);
    const zip = zipSync({ [`${base}.obj`]: strToU8(obj), [`${base}.mtl`]: strToU8(mtl) });
    download(`${base}_obj.zip`, zip as BlobPart, 'application/zip');
    return `${visible.length} parça → ${base}_obj.zip (OBJ + MTL renkler)`;
  }
  const files: Record<string, Uint8Array> = {};
  for (const part of visible) {
    let file = safeFileName(part.name);
    while (files[`${file}.obj`]) file += '_';
    const { obj, mtl } = buildObj([part], project, `${file}.mtl`);
    files[`${file}.obj`] = strToU8(obj);
    files[`${file}.mtl`] = strToU8(mtl);
  }
  download(`${base}_parcalar.zip`, zipSync(files) as BlobPart, 'application/zip');
  return `${visible.length} parça ayrı dosyalar olarak → ${base}_parcalar.zip`;
}
