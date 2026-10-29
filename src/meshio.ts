// Ağ dosyası içe aktarma (STL, OBJ, 3MF) ve dışa aktarma (STL, 3MF). Tarayıcıda ve Node'da (CLI) çalışır.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MeshAsset, Vec3 } from '../shared/ops';
import { makeAsset } from './assets';

export const MESH_FORMATS = ['stl', 'obj', '3mf'] as const;
export type MeshFormat = (typeof MESH_FORMATS)[number];

export function meshFormatOf(fileName: string): MeshFormat | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return (MESH_FORMATS as readonly string[]).includes(ext) ? (ext as MeshFormat) : null;
}

// ---------------------------------------------------------------------------
// Okuma → üçgen çorbası (her üçgen 9 sayı, mm)

export function parseMeshFile(fileName: string, data: ArrayBuffer): Float32Array {
  const fmt = meshFormatOf(fileName);
  if (fmt === 'stl') return soupOf(new STLLoader().parse(data));
  if (fmt === 'obj') {
    const group = new OBJLoader().parse(new TextDecoder().decode(data));
    const parts: Float32Array[] = [];
    group.updateMatrixWorld(true);
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) parts.push(soupOf((o.geometry as THREE.BufferGeometry).clone().applyMatrix4(o.matrixWorld)));
    });
    return concat(parts);
  }
  if (fmt === '3mf') return parse3mf(new Uint8Array(data));
  throw new Error('Desteklenen biçimler: STL, OBJ, 3MF.');
}

function soupOf(g: THREE.BufferGeometry): Float32Array {
  const ni = g.getIndex() ? g.toNonIndexed() : g;
  return new Float32Array(ni.getAttribute('position').array);
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];

/** 3MF çekirdek biçimi: nesneler (mesh / components) ve build öğeleri, dönüşümlerle birlikte. */
function parse3mf(bytes: Uint8Array): Float32Array {
  const files = unzipSync(bytes);
  const modelPath = Object.keys(files).find((k) => /(^|\/)3D\/3dmodel\.model$/i.test(k)) ?? Object.keys(files).find((k) => k.endsWith('.model'));
  if (!modelPath) throw new Error('3MF içinde model dosyası yok.');
  const xml = strFromU8(files[modelPath]);
  const unit = UNIT_MM[attr(/<model\b[^>]*>/.exec(xml)?.[0] ?? '', 'unit') ?? 'millimeter'] ?? 1;

  const meshes = new Map<string, Float32Array>();
  const comps = new Map<string, { id: string; m: THREE.Matrix4 }[]>();
  for (const om of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = attr(om[1], 'id')!;
    const body = om[2];
    const vs: number[] = [];
    for (const v of body.matchAll(/<vertex\b([^>]*)\/?>/g)) vs.push(Number(attr(v[1], 'x')), Number(attr(v[1], 'y')), Number(attr(v[1], 'z')));
    if (vs.length) {
      const tri: number[] = [];
      for (const t of body.matchAll(/<triangle\b([^>]*)\/?>/g)) {
        for (const k of ['v1', 'v2', 'v3']) {
          const i = Number(attr(t[1], k)) * 3;
          tri.push(vs[i], vs[i + 1], vs[i + 2]);
        }
      }
      meshes.set(id, new Float32Array(tri));
    }
    const cs = [...body.matchAll(/<component\b([^>]*)\/?>/g)].map((c) => ({ id: attr(c[1], 'objectid')!, m: matrix3mf(attr(c[1], 'transform')) }));
    if (cs.length) comps.set(id, cs);
  }
  const out: Float32Array[] = [];
  const emit = (id: string, m: THREE.Matrix4, depth: number) => {
    if (depth > 16) return;
    const mesh = meshes.get(id);
    if (mesh) out.push(transformSoup(mesh, m));
    for (const c of comps.get(id) ?? []) emit(c.id, m.clone().multiply(c.m), depth + 1);
  };
  const build = /<build\b[^>]*>([\s\S]*?)<\/build>/.exec(xml)?.[1] ?? '';
  for (const it of build.matchAll(/<item\b([^>]*)\/?>/g)) emit(attr(it[1], 'objectid')!, matrix3mf(attr(it[1], 'transform')), 0);
  const soup = concat(out);
  if (unit !== 1) for (let i = 0; i < soup.length; i++) soup[i] *= unit;
  if (!soup.length) throw new Error('3MF içinde üçgen bulunamadı.');
  return soup;
}

/** 3MF dönüşümü "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (satır vektörü, son satır öteleme). */
function matrix3mf(s: string | undefined): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!s) return m;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((n) => !Number.isFinite(n))) return m;
  return m.set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
}

function transformSoup(soup: Float32Array, m: THREE.Matrix4): Float32Array {
  const out = new Float32Array(soup.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < soup.length; i += 3) {
    v.set(soup[i], soup[i + 1], soup[i + 2]).applyMatrix4(m);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Çorba → varlık (kaynak, sadeleştirme, merkezleme)

export interface ImportedMesh {
  asset: MeshAsset;
  /** Ağın dosyadaki sınırlayıcı kutu merkezi; parçayı dosyadaki yerinde tutmak için konum olarak verilebilir. */
  center: Vec3;
  size: Vec3;
  originalTriangles: number;
}

/** `maxError`: sadeleştirmede izin verilen sapma, ağ boyutuna oranla (0.02 = %2). Keskin kenarlar için küçük tutun. */
export async function meshAssetFromSoup(name: string, soup: Float32Array, maxTriangles = 60000, maxError = 0.02): Promise<ImportedMesh> {
  if (!soup.length || soup.length % 9) throw new Error('Ağda üçgen yok.');
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  const merged = mergeVertices(g, 1e-4);
  g.dispose();
  let positions = new Float32Array(merged.getAttribute('position').array);
  const raw = merged.getIndex()!.array;
  merged.dispose();
  let tris: number[] = [];
  for (let i = 0; i < raw.length; i += 3) if (raw[i] !== raw[i + 1] && raw[i + 1] !== raw[i + 2] && raw[i] !== raw[i + 2]) tris.push(raw[i], raw[i + 1], raw[i + 2]);
  const originalTriangles = tris.length / 3;
  if (originalTriangles > maxTriangles) {
    await MeshoptSimplifier.ready;
    // Regularize: daha düzgün üçgenler (varsayılan sadeleştirme iğne üçgenler bırakır → gölge ve kenar çizgisinde gürültü).
    const [simple] = MeshoptSimplifier.simplify(new Uint32Array(tris), positions, 3, maxTriangles * 3, maxError, ['Regularize']);
    tris = Array.from(simple);
  }
  // Kullanılmayan köşeleri at, merkezle.
  const remap = new Map<number, number>();
  const indices = new Uint32Array(tris.length);
  const kept: number[] = [];
  tris.forEach((v, i) => {
    let n = remap.get(v);
    if (n === undefined) {
      n = kept.length / 3;
      remap.set(v, n);
      kept.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }
    indices[i] = n;
  });
  positions = new Float32Array(kept);
  const box = new THREE.Box3().setFromArray(positions);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= c.x;
    positions[i + 1] -= c.y;
    positions[i + 2] -= c.z;
  }
  const r3 = (n: number) => Number(n.toFixed(3));
  return {
    asset: makeAsset(name, positions, indices),
    center: { x: r3(c.x), y: r3(c.y), z: r3(c.z) },
    size: { x: r3(s.x), y: r3(s.y), z: r3(s.z) },
    originalTriangles,
  };
}

// ---------------------------------------------------------------------------
// Yazma

export interface WorldMesh {
  name: string;
  color: string;
  pos: Float32Array;
  tris: number[];
}

/** İkili STL (tüm ağlar tek dosyada). */
export function buildStl(meshes: WorldMesh[]): ArrayBuffer {
  const count = meshes.reduce((s, m) => s + m.tris.length / 3, 0);
  const buf = new ArrayBuffer(84 + 50 * count);
  const dv = new DataView(buf);
  const header = strToU8('P3D binary STL, mm, Z up');
  new Uint8Array(buf, 0, 80).set(header.subarray(0, 80));
  dv.setUint32(80, count, true);
  let o = 84;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const m of meshes) {
    for (let i = 0; i < m.tris.length; i += 3) {
      a.fromArray(m.pos, m.tris[i] * 3);
      b.fromArray(m.pos, m.tris[i + 1] * 3);
      c.fromArray(m.pos, m.tris[i + 2] * 3);
      n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
      for (const v of [n, a, b, c]) {
        dv.setFloat32(o, v.x, true);
        dv.setFloat32(o + 4, v.y, true);
        dv.setFloat32(o + 8, v.z, true);
        o += 12;
      }
      dv.setUint16(o, 0, true);
      o += 2;
    }
  }
  return buf;
}

const xmlEsc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);
const f4 = (v: number) => {
  const s = v.toFixed(4);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

/** 3MF: her parça ayrı nesne ve kendi rengiyle (çok renkli baskı için dilimleyicide parça/renk ataması kolay). */
export function build3mf(title: string, meshes: WorldMesh[]): Uint8Array {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="tr-TR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    `  <metadata name="Title">${xmlEsc(title)}</metadata>`,
    '  <metadata name="Application">P3D</metadata>',
    '  <resources>',
    '    <basematerials id="1">',
    ...meshes.map((m) => `      <base name="${xmlEsc(m.name)}" displaycolor="${m.color.toUpperCase()}FF" />`),
    '    </basematerials>',
  ];
  meshes.forEach((m, i) => {
    out.push(`    <object id="${i + 2}" type="model" name="${xmlEsc(m.name)}" pid="1" pindex="${i}">`, '      <mesh>', '        <vertices>');
    for (let k = 0; k < m.pos.length; k += 3) out.push(`          <vertex x="${f4(m.pos[k])}" y="${f4(m.pos[k + 1])}" z="${f4(m.pos[k + 2])}" />`);
    out.push('        </vertices>', '        <triangles>');
    for (let k = 0; k < m.tris.length; k += 3) out.push(`          <triangle v1="${m.tris[k]}" v2="${m.tris[k + 1]}" v3="${m.tris[k + 2]}" />`);
    out.push('        </triangles>', '      </mesh>', '    </object>');
  });
  out.push('  </resources>', '  <build>', ...meshes.map((_, i) => `    <item objectid="${i + 2}" />`), '  </build>', '</model>');
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />' +
        '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" /></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" /></Relationships>',
    ),
    '3D/3dmodel.model': strToU8(out.join('\n') + '\n'),
  });
}
