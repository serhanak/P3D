import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { strToU8, zipSync } from 'fflate';
import { SHAPES } from '../shared/ops';
import { isHexColor, normalizeHex } from './colors';
import { newId, partMatrix } from './engine';
import { PALETTE, buildGeometry, defaultParams, sanitizeParams } from './shapes';
import { newProject, type Part, type Project } from './types';

// ---------------------------------------------------------------------------
// Proje dosyası (.p3d.json)

export function projectToJson(project: Project): string {
  return JSON.stringify(project, null, 2);
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
  base.settings.resolution = Math.round(num(settings.resolution, base.settings.resolution, 16, 256));
  base.settings.bedX = num(settings.bedX, base.settings.bedX, 20, 2000);
  base.settings.bedY = num(settings.bedY, base.settings.bedY, 20, 2000);

  const ids = new Set<string>();
  const parts = Array.isArray(d.parts) ? d.parts : [];
  parts.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    if (!SHAPES.includes(r.shape as never)) return;
    const shape = r.shape as Part['shape'];
    const params = { ...defaultParams(shape), ...((r.params ?? {}) as Record<string, number>) };
    sanitizeParams(shape, params);
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

/** Parçanın dünya koordinatlarında, kaynaklı (köşe paylaşımlı) üçgen ağı. Birim: mm, Z yukarı. */
function partMesh(part: Part, seg: number): { pos: Float32Array; tris: number[] } {
  let g: THREE.BufferGeometry = buildGeometry(part.shape, part.params, seg);
  g.applyMatrix4(partMatrix(part));
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  g.clearGroups();
  const merged = mergeVertices(g, 1e-4);
  g.dispose();
  g = merged;
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
  return { pos, tris };
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
  const seg = project.settings.resolution;
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
    const { pos, tris } = partMesh(part, seg);
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

export type ExportKind = 'all-obj' | 'all-zip' | 'each-zip' | 'selected-obj';

export function exportModel(kind: ExportKind, project: Project, selectedId: string | null): string {
  const base = safeFileName(project.name);
  const visible = project.parts.filter((p) => p.visible);
  if (kind === 'selected-obj') {
    const part = project.parts.find((p) => p.id === selectedId);
    if (!part) throw new Error('Önce bir parça seçin.');
    const file = safeFileName(part.name);
    download(`${file}.obj`, buildObj([part], project, null).obj, 'model/obj');
    return `'${part.name}' → ${file}.obj`;
  }
  if (!visible.length) throw new Error('Dışa aktarılacak görünür parça yok.');
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
