// glTF 2.0 ikili (GLB) yazıcı: oyun motorları (Unreal, Godot, Unity) için. Bağımlılıksız; tarayıcıda ve Node'da aynı
// kod (three'nin GLTFExporter'ı Node'da FileReader ister). Girdi, diğer dışa aktarımlarla aynı son geometridir:
// görünür katılar, delikler uygulanmış indisli ağ (model.exportGeometry); konuma göre yeniden kaynaklanmaz.
//
// Eksen: P3D Z yukarı, mm, önü −Y → glTF Y yukarı, metre (varsayılan), önü +Z: (x, y, z) → (x, z, −y) × ölçek.
// Bu öz (det +1) bir dönüşümdür; üçgen sarımı değişmez. Unreal'in içe aktarıcısı glTF'yi kendi Z yukarı / cm düzenine çevirir.
import * as THREE from 'three';
import { findGroup, findPartExact, partMatrix } from './engine';
import { MESH_CREASE } from './geom';
import { exportGeometry, exportableParts } from './model';
import type { GroupDef, Part, Project } from './types';

export interface GlbOptions {
  /** Yalnızca bu parçalar ya da gruplar (ad veya kimlik); yoksa tüm görünür katılar. */
  parts?: string[];
  /** 'm' (varsayılan, glTF standardı) ya da 'mm' (P3D ölçüleri olduğu gibi). */
  units?: 'm' | 'mm';
  /** 'flat' (varsayılan): üçgen başına köşe ve yüz normali — düşük poligon görünümü. 'smooth': 50° kırılımlı normaller. */
  normals?: 'flat' | 'smooth';
  /**
   * true: tüm parçalar tek bir skinned mesh olur (Unreal Chaos Vehicles). Kökte `root` eklemi; her grup için pivotunda,
   * root'un çocuğu olan bir eklem. Grup üyelerinin köşeleri o eklemin, gruplanmamışlar root'un (ağırlık 1).
   */
  skeleton?: boolean;
}

type V3 = [number, number, number];

// glTF sabitleri
const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_BYTE = 5121;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const TRIANGLES = 4;
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** sRGB (0–1) → lineer: glTF baseColorFactor lineerdir. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToLinear(hex: string): V3 {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1] ?? 'cccccc';
  return [0, 2, 4].map((i) => Number(srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255).toFixed(6))) as V3;
}

const toGl = (v: { x: number; y: number; z: number }, s: number): V3 => [v.x * s + 0, v.z * s + 0, -v.y * s + 0];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0] + 0, a[1] - b[1] + 0, a[2] - b[2] + 0];

// ---------------------------------------------------------------------------
// Parça ağları (glTF koordinatlarında)

interface TriMesh {
  /** Köşe konumları (glTF dünya koordinatları, ölçekli). */
  pos: Float32Array;
  tris: number[];
  /** Parçanın yerel kutu merkezi, dünyada (glTF). */
  center: V3;
}

function partTriangles(project: Project, part: Part, s: number): TriMesh {
  const g = exportGeometry(project, part);
  g.computeBoundingBox();
  const m = partMatrix(part);
  const center = toGl(g.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(m), s);
  g.applyMatrix4(m);
  const src = g.getAttribute('position').array;
  const pos = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    pos[i] = src[i] * s;
    pos[i + 1] = src[i + 2] * s;
    pos[i + 2] = -src[i + 1] * s;
  }
  const index = g.getIndex()!;
  const tris: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c); // kutup/tepe noktalarındaki dejenere üçgenler
  }
  g.dispose();
  return { pos, tris, center };
}

/** Gölgelenmiş ağ: köşe başına konum + normal, üçgen indisleri. */
interface Shaded {
  pos: number[];
  nor: number[];
  idx: number[];
}

function faceNormals(pos: Float32Array, tris: number[]): { unit: Float64Array; weighted: Float64Array } {
  const n = tris.length / 3;
  const unit = new Float64Array(n * 3);
  const weighted = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    const [a, b, c] = [tris[3 * t] * 3, tris[3 * t + 1] * 3, tris[3 * t + 2] * 3];
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const x = e1[1] * e2[2] - e1[2] * e2[1];
    const y = e1[2] * e2[0] - e1[0] * e2[2];
    const z = e1[0] * e2[1] - e1[1] * e2[0];
    const len = Math.hypot(x, y, z);
    weighted.set([x, y, z], 3 * t); // uzunluk = 2 × alan: alan ağırlıklı ortalama için
    if (len > 0) unit.set([x / len, y / len, z / len], 3 * t);
  }
  return { unit, weighted };
}

/** Düz gölgeleme: her üçgenin kendi köşeleri ve yüz normali. */
function flatShaded(m: TriMesh, origin: V3): Shaded {
  const { unit } = faceNormals(m.pos, m.tris);
  const out: Shaded = { pos: [], nor: [], idx: [] };
  for (let t = 0; t < m.tris.length / 3; t++) {
    let [nx, ny, nz] = [unit[3 * t], unit[3 * t + 1], unit[3 * t + 2]];
    if (nx === 0 && ny === 0 && nz === 0) ny = 1; // alanı sıfır üçgen: geçerli bir normal yeter
    for (let k = 0; k < 3; k++) {
      const v = m.tris[3 * t + k] * 3;
      out.pos.push(m.pos[v] - origin[0], m.pos[v + 1] - origin[1], m.pos[v + 2] - origin[2]);
      out.nor.push(nx, ny, nz);
      out.idx.push(out.idx.length);
    }
  }
  return out;
}

/**
 * Kırılımlı yumuşak gölgeleme: köşe normali, o köşeyi paylaşan ve yüz normali bu üçgeninkine `crease`'ten yakın
 * üçgenlerin alan ağırlıklı ortalamasıdır. İndis topolojisi korunur (konuma göre kaynaklama yok); aynı köşe + aynı
 * normal tek köşe olur.
 */
function smoothShaded(m: TriMesh, origin: V3, crease: number): Shaded {
  const nt = m.tris.length / 3;
  const nv = m.pos.length / 3;
  const { unit, weighted } = faceNormals(m.pos, m.tris);
  // Köşe → üçgen listesi (CSR)
  const start = new Uint32Array(nv + 1);
  for (const v of m.tris) start[v + 1]++;
  for (let i = 0; i < nv; i++) start[i + 1] += start[i];
  const fill = start.slice(0, nv);
  const inc = new Uint32Array(m.tris.length);
  m.tris.forEach((v, i) => (inc[fill[v]++] = Math.floor(i / 3)));

  const cos = Math.cos(crease);
  const out: Shaded = { pos: [], nor: [], idx: [] };
  const seen = new Map<string, number>();
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const v = m.tris[3 * t + k];
      let [x, y, z] = [0, 0, 0];
      for (let j = start[v]; j < start[v + 1]; j++) {
        const f = inc[j];
        if (unit[3 * f] * unit[3 * t] + unit[3 * f + 1] * unit[3 * t + 1] + unit[3 * f + 2] * unit[3 * t + 2] < cos) continue;
        x += weighted[3 * f];
        y += weighted[3 * f + 1];
        z += weighted[3 * f + 2];
      }
      const len = Math.hypot(x, y, z);
      const n: V3 = len > 0 ? [x / len, y / len, z / len] : [0, 1, 0];
      const key = `${v}|${n.map((c) => Math.round(c * 1e5)).join(',')}`;
      let id = seen.get(key);
      if (id === undefined) {
        id = out.pos.length / 3;
        seen.set(key, id);
        out.pos.push(m.pos[3 * v] - origin[0], m.pos[3 * v + 1] - origin[1], m.pos[3 * v + 2] - origin[2]);
        out.nor.push(...n);
      }
      out.idx.push(id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// İkili tampon ve erişimciler

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: 'SCALAR' | 'VEC3' | 'VEC4' | 'MAT4';
  min?: number[];
  max?: number[];
  normalized?: boolean;
}

class BinBuilder {
  private parts: Uint8Array[] = [];
  length = 0;
  views: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] = [];
  accessors: Accessor[] = [];

  /** Veriyi 4 bayt hizalı yeni bir bufferView olarak ekler. */
  private view(data: ArrayBufferView, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    this.parts.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: data.byteLength, ...(target ? { target } : {}) });
    this.length += data.byteLength;
    return this.views.length - 1;
  }

  accessor(data: Float32Array | Uint32Array | Uint16Array | Uint8Array, type: Accessor['type'], target?: number, minMax = false): number {
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    const componentType =
      data instanceof Float32Array ? FLOAT : data instanceof Uint32Array ? UNSIGNED_INT : data instanceof Uint16Array ? UNSIGNED_SHORT : UNSIGNED_BYTE;
    const acc: Accessor = { bufferView: this.view(data, target), componentType, count: data.length / size, type };
    if (minMax) {
      // Saklanan (float32) değerlerden: doğrulayıcılar bunlarla karşılaştırır.
      const min = new Array<number>(size).fill(Infinity);
      const max = new Array<number>(size).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const c = i % size;
        if (data[i] < min[c]) min[c] = data[i];
        if (data[i] > max[c]) max[c] = data[i];
      }
      acc.min = min.map((v) => v + 0);
      acc.max = max.map((v) => v + 0);
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  /** Konum + normal + indis (+ isteğe bağlı eklem/ağırlık) erişimcileriyle bir üçgen primitifi. */
  primitive(sh: Shaded, material: number, joint?: number[], jointCount = 0): Record<string, unknown> {
    const count = sh.pos.length / 3;
    const attributes: Record<string, number> = {
      POSITION: this.accessor(new Float32Array(sh.pos), 'VEC3', ARRAY_BUFFER, true),
      NORMAL: this.accessor(new Float32Array(sh.nor), 'VEC3', ARRAY_BUFFER),
    };
    if (joint) {
      const J = jointCount <= 256 ? new Uint8Array(count * 4) : new Uint16Array(count * 4);
      const W = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        J[4 * i] = joint[i];
        W[4 * i] = 1;
      }
      attributes.JOINTS_0 = this.accessor(J, 'VEC4', ARRAY_BUFFER);
      attributes.WEIGHTS_0 = this.accessor(W, 'VEC4', ARRAY_BUFFER);
    }
    const idx = count < 65535 ? new Uint16Array(sh.idx) : new Uint32Array(sh.idx);
    return { attributes, indices: this.accessor(idx, 'SCALAR', ELEMENT_ARRAY_BUFFER), material, mode: TRIANGLES };
  }

  bytes(): Uint8Array {
    const total = this.length + ((4 - (this.length % 4)) % 4);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

function glb(json: object, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = jsonBytes.length + ((4 - (jsonBytes.length % 4)) % 4);
  const binLen = bin.length + ((4 - (bin.length % 4)) % 4);
  const total = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen); // JSON dolgusu boşluk
  const b = 20 + jsonLen;
  dv.setUint32(b, binLen, true);
  dv.setUint32(b + 4, CHUNK_BIN, true);
  out.set(bin, b + 8); // BIN dolgusu sıfır
  return out;
}

// ---------------------------------------------------------------------------

/** Dışa aktarılacak parçalar: görünür katılar; `refs` verilirse yalnızca o parçalar / grupların üyeleri (proje sırasıyla). */
function selectParts(project: Project, refs?: string[]): Part[] {
  const solids = exportableParts(project.parts);
  if (!refs?.length) return solids;
  const keep = new Set<Part>();
  const ctx = { selectedId: null, lastPartId: null };
  for (const r of refs) {
    const p = findPartExact(project, r, ctx);
    if (p) {
      if (!solids.includes(p)) throw new Error(`'${p.name}' görünür bir katı parça değil; dışa aktarılmaz.`);
      keep.add(p);
      continue;
    }
    const g = findGroup(project, r);
    if (!g) throw new Error(`'${r}' adında parça ya da grup bulunamadı.`);
    for (const s of solids) if (s.group === g.name) keep.add(s);
  }
  return solids.filter((p) => keep.has(p));
}

/**
 * Projeyi GLB (glTF 2.0 ikili) olarak yazar. Parça başına düğüm + mesh (düğüm çevirisi parçanın merkezi, döndürme
 * köşelere gömülü); grup bir düğümdür (çevirisi pivot, üyeleri çocuk düğüm). Renk → lineer `baseColorFactor`
 * (metallic 0, roughness 0,9); aynı renkler tek malzeme. `skeleton` için bkz. GlbOptions.
 */
export function buildGlb(project: Project, opts: GlbOptions = {}): Uint8Array {
  const parts = selectParts(project, opts.parts);
  if (!parts.length) throw new Error('Dışa aktarılacak görünür katı parça yok.');
  const s = opts.units === 'mm' ? 1 : 0.001;
  const smooth = opts.normals === 'smooth';
  const shade = (m: TriMesh, origin: V3) => (smooth ? smoothShaded(m, origin, MESH_CREASE) : flatShaded(m, origin));
  const groupOf = (p: Part): GroupDef | undefined => (p.group ? project.groups?.find((g) => g.name === p.group) : undefined);

  const bin = new BinBuilder();
  const materials: object[] = [];
  const materialIndex = new Map<string, number>();
  const material = (color: string) => {
    const key = color.toLowerCase();
    let i = materialIndex.get(key);
    if (i === undefined) {
      i = materials.length;
      materialIndex.set(key, i);
      materials.push({
        name: `P3D_${key.replace('#', '')}`,
        pbrMetallicRoughness: { baseColorFactor: [...hexToLinear(key), 1], metallicFactor: 0, roughnessFactor: 0.9 },
      });
    }
    return i;
  };

  const nodes: Record<string, unknown>[] = [];
  const meshes: object[] = [];
  const roots: number[] = [];
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'P3D', extras: { units: opts.units === 'mm' ? 'mm' : 'm', source: 'P3D (Z yukarı, mm) → glTF (Y yukarı)' } },
    scene: 0,
  };

  if (opts.skeleton) {
    // Eklemler: root (orijinde) + dışa aktarılan üyesi olan her grup (pivotunda, root'un çocuğu).
    const groups = (project.groups ?? []).filter((g) => parts.some((p) => p.group === g.name));
    const rootName = groups.some((g) => g.name.toLowerCase() === 'root') ? 'root_' : 'root';
    nodes.push({ name: rootName });
    const jointOf = new Map<string, number>(); // grup adı → skin.joints indisi
    const children: number[] = [];
    const ibm = new Float32Array(16 * (groups.length + 1));
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 0);
    groups.forEach((g, i) => {
      const t = toGl(g.pivot, s);
      children.push(nodes.length);
      nodes.push({ name: g.name, translation: t });
      jointOf.set(g.name, i + 1);
      // Bağlama pozunda eklemin dünya dönüşümü T(pivot); tersi T(−pivot) (sütun öncelikli).
      ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -t[0] + 0, -t[1] + 0, -t[2] + 0, 1], 16 * (i + 1));
    });
    if (children.length) nodes[0].children = children;
    const jointCount = groups.length + 1;

    // Renk başına tek primitif; köşeler dünya (glTF) koordinatlarında, ağ düğümü kökte ve dönüşümsüz.
    const byColor = new Map<string, { sh: Shaded; joint: number[] }>();
    for (const p of parts) {
      const sh = shade(partTriangles(project, p, s), [0, 0, 0]);
      const key = p.color.toLowerCase();
      let acc = byColor.get(key);
      if (!acc) byColor.set(key, (acc = { sh: { pos: [], nor: [], idx: [] }, joint: [] }));
      const base = acc.sh.pos.length / 3;
      for (const v of sh.pos) acc.sh.pos.push(v); // büyük ağlarda push(...dizi) yığını taşırır
      for (const v of sh.nor) acc.sh.nor.push(v);
      for (const i of sh.idx) acc.sh.idx.push(base + i);
      const j = (p.group && jointOf.get(p.group)) || 0;
      for (let i = 0; i < sh.pos.length / 3; i++) acc.joint.push(j);
    }
    const primitives = [...byColor].map(([color, acc]) => bin.primitive(acc.sh, material(color), acc.joint, jointCount));
    meshes.push({ name: project.name, primitives });
    const meshNode = nodes.length;
    nodes.push({ name: project.name, mesh: 0, skin: 0 });
    roots.push(0, meshNode);
    json.skins = [
      {
        name: `${project.name} iskelet`,
        joints: [0, ...children],
        skeleton: 0,
        inverseBindMatrices: bin.accessor(ibm, 'MAT4'),
      },
    ];
  } else {
    const groupNode = new Map<string, number>();
    for (const p of parts) {
      const m = partTriangles(project, p, s);
      const mesh = meshes.length;
      meshes.push({ name: p.name, primitives: [bin.primitive(shade(m, m.center), material(p.color))] });
      const g = groupOf(p);
      if (!g) {
        roots.push(nodes.length);
        nodes.push({ name: p.name, mesh, translation: m.center });
        continue;
      }
      const pivot = toGl(g.pivot, s);
      let gi = groupNode.get(g.name);
      if (gi === undefined) {
        gi = nodes.length;
        groupNode.set(g.name, gi);
        roots.push(gi);
        nodes.push({ name: g.name, translation: pivot, children: [] });
      }
      (nodes[gi].children as number[]).push(nodes.length);
      nodes.push({ name: p.name, mesh, translation: sub(m.center, pivot) });
    }
  }

  json.scenes = [{ name: project.name, nodes: roots }];
  json.nodes = nodes;
  json.meshes = meshes;
  json.materials = materials;
  json.accessors = bin.accessors;
  json.bufferViews = bin.views;
  const data = bin.bytes();
  json.buffers = [{ byteLength: data.length }];
  return glb(json, data);
}
