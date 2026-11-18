// Ağ dosyası içe aktarma (STL, OBJ, 3MF, GLB) ve dışa aktarma (STL, 3MF). Tarayıcıda ve Node'da (CLI) çalışır.
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MeshAsset, Vec3 } from '../shared/ops';
import { makeAsset } from './assets';

export const MESH_FORMATS = ['stl', 'obj', '3mf', 'glb'] as const;
export type MeshFormat = (typeof MESH_FORMATS)[number];

export function meshFormatOf(fileName: string): MeshFormat | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return (MESH_FORMATS as readonly string[]).includes(ext) ? (ext as MeshFormat) : null;
}

/** Tanınmayan ağ dosyası için açıklama (glTF metin biçimine ayrı ipucu). */
export function meshFormatHint(fileName: string): string {
  return /\.gltf$/i.test(fileName)
    ? 'glTF metin biçimi (.gltf) desteklenmiyor; tek dosyalık ikili .glb olarak dışa aktarın (ör. Blender: glTF Binary).'
    : 'Desteklenen biçimler: STL, OBJ, 3MF, GLB.';
}

/** İçe aktarmada varsayılan üçgen sınırı (STL/OBJ/3MF): taranmış referans ağlar bunun üstündeyse sadeleştirilir. */
export const DEFAULT_MAX_TRIS = 60000;
/** GLB'de varsayılan sınır: oyun varlığında üçgen topolojisi önemlidir, pratikte sadeleştirme yok. */
export const GLB_MAX_TRIS = 1_000_000;

/** Biçimin varsayılan üçgen sınırı (arayüz İçe aktar…/Aç…, `p3d import` ve `--file ağ`; `--max-tris` verilmemişse). */
export function defaultMaxTris(format: MeshFormat | null): number {
  return format === 'glb' ? GLB_MAX_TRIS : DEFAULT_MAX_TRIS;
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
  if (fmt === 'glb') return parseGlb(data);
  throw new Error(meshFormatHint(fileName));
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
// GLB (glTF 2.0 ikili) okuma. Bağımlılıksız ve eşzamanlı (three'nin GLTFLoader'ı async; parseMeshFile senkron kalır),
// yalnızca geometri: malzeme, doku, normal, animasyon ve morph hedefleri yok sayılır. Varsayılan sahnenin düğüm ağacı
// dünya matrisleriyle gezilir; tüm üçgen ilkelleri tek çorbada birleşir (STL/OBJ/3MF gibi: bir dosya → bir ağ parçası).
// Eksen ve birim gltf.ts'in tersi: glTF (X, Y, Z) → P3D (X, −Z, Y) × 1000 (`asset.extras.units` 'mm' ise × 1).

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON'
const GLB_CHUNK_BIN = 0x004e4942; // 'BIN\0'
/** Bileşen tipi → bayt. */
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
/** Geometriyi okunamaz kılan sıkıştırma uzantıları: dosyada kullanılıyorsa (zorunlu ya da değil) hata. */
const COMPRESSION_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco sıkıştırması',
  EXT_meshopt_compression: 'meshopt sıkıştırması',
};
/** Zorunluysa okunamayan uzantı (yalnızca normal/doku nicemlenmişse dosya okunur; nicemlenmiş konum ayrıca hata verir). */
const QUANTIZATION_EXTENSION = 'KHR_mesh_quantization';
/** Bir erişimcinin en fazla değer sayısı (count × bileşen): bozuk ya da şişirilmiş `count` belleği tüketmesin. */
const MAX_ACCESSOR_VALUES = 1e8;

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  sparse?: unknown;
}
interface GltfNode {
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extensions?: { EXT_mesh_gpu_instancing?: { attributes?: Record<string, number> } };
}
interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  mode?: number;
  extensions?: Record<string, unknown>;
}
interface GltfJson {
  asset?: { version?: string; extras?: { units?: unknown } };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives?: GltfPrimitive[] }[];
  skins?: { joints?: number[]; inverseBindMatrices?: number }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: Record<string, unknown> }[];
  buffers?: { uri?: string; byteLength?: number }[];
}

const glbCorrupt = (what: string) => new Error(`GLB bozuk: ${what}.`);
const unsupported = (names: string[]) =>
  new Error(
    `GLB ${names.map((e) => `${COMPRESSION_EXTENSIONS[e] ?? 'nicemlenmiş köşe verisi'} (${e})`).join(', ')} kullanıyor; desteklenmiyor. ` +
      'Sıkıştırmasız GLB olarak dışa aktarın (ör. Blender: Compression kapalı).',
  );
/** Uzun metni (ör. data: URI) hata mesajı için kısaltır. */
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** GLB → üçgen çorbası (P3D mm, Z yukarı). */
function parseGlb(data: ArrayBuffer): Float32Array {
  const bytes = new Uint8Array(data);
  const dv = new DataView(data);
  if (bytes.length < 12 || dv.getUint32(0, true) !== GLB_MAGIC) throw new Error('GLB değil: dosya "glTF" imzasıyla başlamıyor (bozuk ya da başka bir biçim).');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB sürümü ${version} desteklenmiyor; yalnızca glTF 2.0.`);
  const end = Math.min(dv.getUint32(8, true), bytes.length);
  let json: GltfJson | undefined;
  let bin: Uint8Array | undefined;
  for (let o = 12; o + 8 <= end; ) {
    const len = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    const s = o + 8;
    if (s + len > bytes.length) throw glbCorrupt('bir veri bölümü (chunk) dosyanın sonunu aşıyor');
    if (type === GLB_CHUNK_JSON && !json) {
      try {
        json = JSON.parse(new TextDecoder().decode(bytes.subarray(s, s + len)));
      } catch (e) {
        throw glbCorrupt(`JSON bölümü okunamadı (${(e as Error).message})`);
      }
    } else if (type === GLB_CHUNK_BIN && !bin) bin = bytes.subarray(s, s + len);
    o = s + len;
  }
  if (!json || typeof json !== 'object') throw glbCorrupt('JSON bölümü yok');
  const gl = json;
  // Sıkıştırma uzantısı kullanılıyorsa (zorunlu olmasa da: yedek veri çoğu zaman boştur) okunmaz; ilkel ve bufferView
  // düzeyinde de aşağıda denetlenir.
  const declared = [...new Set([...(gl.extensionsRequired ?? []), ...(gl.extensionsUsed ?? [])])];
  const blocked = declared.filter((e) => e in COMPRESSION_EXTENSIONS);
  if ((gl.extensionsRequired ?? []).includes(QUANTIZATION_EXTENSION)) blocked.push(QUANTIZATION_EXTENSION);
  if (blocked.length) throw unsupported(blocked);
  const k = gl.asset?.extras?.units === 'mm' ? 1 : 1000;

  // Tamponlar: 0 numaralı, uri'siz tampon BIN bölümüdür; data: URI çözülür; harici dosya desteklenmez.
  const buffers = new Map<number, Uint8Array>();
  const buffer = (i: number): Uint8Array => {
    let b = buffers.get(i);
    if (b) return b;
    const def = gl.buffers?.[i];
    if (!def) throw glbCorrupt(`${i}. tampon tanımlı değil`);
    if (def.uri === undefined) {
      if (i !== 0 || !bin) throw glbCorrupt(`${i}. tamponun verisi yok`);
      b = bin;
    } else {
      const m = /^data:[^,]*;base64,(.*)$/s.exec(def.uri);
      if (!m) throw new Error(`GLB harici tampon dosyası kullanıyor (${clip(def.uri)}); desteklenmiyor — tek dosyalık .glb olarak dışa aktarın.`);
      b = Uint8Array.from(atob(m[1]), (ch) => ch.charCodeAt(0));
    }
    buffers.set(i, b);
    return b;
  };

  /** Erişimcinin değerleri (count × bileşen); bayt adımı, ofsetler ve normalize tamsayılar uygulanmış. */
  const readAccessor = (index: number, what: string): { data: Float64Array; size: number; count: number; acc: GltfAccessor } => {
    const a = gl.accessors?.[index];
    if (!a) throw glbCorrupt(`${what} erişimcisi (${index}) yok`);
    if (a.sparse) throw new Error(`GLB seyrek (sparse) erişimci kullanıyor (${what}); desteklenmiyor.`);
    const size = TYPE_SIZE[a.type];
    const cb = COMPONENT_BYTES[a.componentType];
    if (!size || !cb || !Number.isInteger(a.count) || a.count < 0) throw glbCorrupt(`${what} erişimcisinin tipi geçersiz`);
    if (a.count * size > MAX_ACCESSOR_VALUES) throw glbCorrupt(`${what} erişimcisi çok büyük (${a.count} öğe)`);
    // bufferView yoksa tanım gereği sıfırlar.
    if (a.bufferView === undefined || a.count === 0) return { data: new Float64Array(a.count * size), size, count: a.count, acc: a };
    const view = gl.bufferViews?.[a.bufferView];
    if (!view) throw glbCorrupt(`${what} erişimcisinin bufferView'ı (${a.bufferView}) yok`);
    const comp = Object.keys(view.extensions ?? {}).filter((e) => e in COMPRESSION_EXTENSIONS);
    if (comp.length) throw unsupported(comp);
    const buf = buffer(view.buffer);
    const elem = cb * size;
    const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : elem;
    const viewStart = view.byteOffset ?? 0;
    const start = viewStart + (a.byteOffset ?? 0);
    if (viewStart + view.byteLength > buf.length || (a.byteOffset ?? 0) + stride * (a.count - 1) + elem > view.byteLength) {
      throw glbCorrupt(`${what} erişimcisi tampon dışına taşıyor`);
    }
    // Sınır denetiminden sonra ayrılır: count veri boyutuyla sınırlıdır.
    const out = new Float64Array(a.count * size);
    const d = new DataView(buf.buffer, buf.byteOffset + start, view.byteLength - (a.byteOffset ?? 0));
    const get: (o: number) => number = {
      5120: (o: number) => d.getInt8(o),
      5121: (o: number) => d.getUint8(o),
      5122: (o: number) => d.getInt16(o, true),
      5123: (o: number) => d.getUint16(o, true),
      5125: (o: number) => d.getUint32(o, true),
      5126: (o: number) => d.getFloat32(o, true),
    }[a.componentType]!;
    const norm = a.normalized ? { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[a.componentType as 5120] : undefined;
    for (let i = 0; i < a.count; i++) {
      for (let c = 0; c < size; c++) {
        const v = get(i * stride + c * cb);
        out[i * size + c] = norm ? Math.max(v / norm, -1) : v;
      }
    }
    return { data: out, size, count: a.count, acc: a };
  };

  // Düğümlerin dünya matrisleri (ebeveyn zinciriyle; döngüye karşı korumalı).
  const nodes = gl.nodes ?? [];
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const worlds = new Map<number, THREE.Matrix4>();
  const localOf = (n: GltfNode): THREE.Matrix4 => {
    const m = new THREE.Matrix4();
    if (Array.isArray(n.matrix) && n.matrix.length === 16) return m.fromArray(n.matrix);
    const [tx, ty, tz] = n.translation ?? [0, 0, 0];
    const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1];
    const [sx, sy, sz] = n.scale ?? [1, 1, 1];
    return m.compose(new THREE.Vector3(tx, ty, tz), new THREE.Quaternion(qx, qy, qz, qw).normalize(), new THREE.Vector3(sx, sy, sz));
  };
  const worldOf = (i: number, depth = 0): THREE.Matrix4 => {
    const cached = worlds.get(i);
    if (cached) return cached;
    const n = nodes[i];
    if (!n) throw glbCorrupt(`${i}. düğüm yok`);
    if (depth > nodes.length) throw glbCorrupt('düğüm ağacında döngü var');
    const p = parent.get(i);
    const m = p === undefined ? localOf(n) : worldOf(p, depth + 1).clone().multiply(localOf(n));
    worlds.set(i, m);
    return m;
  };

  /**
   * EXT_mesh_gpu_instancing: düğümün örnek matrisleri (TRANSLATION / ROTATION / SCALE erişimcilerinden T · R · S); uzantı yoksa
   * null. Örnek sayısı 0 ise düğüm hiç çizilmez.
   */
  const instancesOf = (node: GltfNode): THREE.Matrix4[] | null => {
    const ext = node.extensions?.EXT_mesh_gpu_instancing;
    if (!ext) return null;
    const attrs = ext.attributes ?? {};
    const read = (name: string, size: number) => {
      if (attrs[name] === undefined) return null;
      const r = readAccessor(attrs[name], `örnek ${name}`);
      if (r.size !== size) throw glbCorrupt(`örnek ${name} erişimcisinin tipi geçersiz`);
      return r;
    };
    const t = read('TRANSLATION', 3);
    const r = read('ROTATION', 4);
    const s = read('SCALE', 3);
    const counts = [t, r, s].filter((x) => x).map((x) => x!.count);
    if (!counts.length) return null;
    if (counts.some((c) => c !== counts[0])) throw glbCorrupt('örnek (instancing) erişimcilerinin sayıları farklı');
    return Array.from({ length: counts[0] }, (_, i) =>
      new THREE.Matrix4().compose(
        t ? new THREE.Vector3().fromArray(t.data, i * 3) : new THREE.Vector3(),
        r ? new THREE.Quaternion().fromArray(r.data, i * 4).normalize() : new THREE.Quaternion(),
        s ? new THREE.Vector3().fromArray(s.data, i * 3) : new THREE.Vector3(1, 1, 1),
      ),
    );
  };

  // Varsayılan sahnenin düğümleri (sahne yoksa kök düğümler), derinlik öncelikli.
  const scene = gl.scenes?.length ? gl.scenes[gl.scene ?? 0] : undefined;
  if (gl.scenes?.length && !scene) throw glbCorrupt(`varsayılan sahne (${gl.scene}) yok`);
  const roots = scene ? (scene.nodes ?? []) : nodes.map((_, i) => i).filter((i) => !parent.has(i));
  const order: number[] = [];
  const seen = new Set<number>();
  const visit = (i: number) => {
    if (seen.has(i)) return;
    seen.add(i);
    order.push(i);
    for (const c of nodes[i]?.children ?? []) visit(c);
  };
  roots.forEach(visit);

  const chunks: Float32Array[] = [];
  const v = new THREE.Vector3();
  /** Dünya (glTF) konumlarından üçgenler, P3D eksen/birimiyle; aynalı köşeden başlayan üçgenin sarımı ters çevrilir. */
  const emit = (tri: number[], world: Float64Array, mirrored: Uint8Array) => {
    const out = new Float32Array(tri.length * 3);
    for (let t = 0; t < tri.length; t += 3) {
      const corners = mirrored[tri[t]] === 1 ? [tri[t], tri[t + 2], tri[t + 1]] : [tri[t], tri[t + 1], tri[t + 2]];
      corners.forEach((c, j) => {
        const o = (t + j) * 3;
        out[o] = world[c * 3] * k;
        out[o + 1] = -world[c * 3 + 2] * k;
        out[o + 2] = world[c * 3 + 1] * k;
      });
    }
    chunks.push(out);
  };
  for (const ni of order) {
    const node = nodes[ni];
    if (node?.mesh === undefined) continue;
    const mesh = gl.meshes?.[node.mesh];
    if (!mesh) throw glbCorrupt(`${node.mesh}. ağ (mesh) yok`);
    const skin = node.skin !== undefined ? gl.skins?.[node.skin] : undefined;
    if (node.skin !== undefined && !skin) throw glbCorrupt(`${node.skin}. iskelet (skin) yok`);
    const instances = instancesOf(node);
    for (const prim of mesh.primitives ?? []) {
      const mode = prim.mode ?? 4;
      if (mode < 4 || mode > 6) continue; // nokta / çizgi
      const comp = Object.keys(prim.extensions ?? {}).filter((e) => e in COMPRESSION_EXTENSIONS);
      if (comp.length) throw unsupported(comp);
      const attrs = prim.attributes ?? {};
      if (attrs.POSITION === undefined) continue;
      const pa = gl.accessors?.[attrs.POSITION];
      if (pa && (pa.componentType !== 5126 || pa.type !== 'VEC3')) {
        throw new Error('GLB konumları (POSITION) float VEC3 değil (nicemlenmiş ağ); desteklenmiyor.');
      }
      const pos = readAccessor(attrs.POSITION, 'konum (POSITION)');
      let idx: ArrayLike<number>;
      if (prim.indices !== undefined) {
        const ia = readAccessor(prim.indices, 'indis');
        if (ia.size !== 1 || ![5121, 5123, 5125].includes(ia.acc.componentType)) throw glbCorrupt('indis erişimcisi işaretsiz tamsayı SCALAR değil');
        idx = ia.data;
        for (let i = 0; i < idx.length; i++) if (idx[i] >= pos.count) throw glbCorrupt('indis köşe sayısını aşıyor');
      } else {
        idx = Array.from({ length: pos.count }, (_, i) => i);
      }
      const tri = triangleIndices(idx, mode);
      if (!tri.length) continue;

      // Köşelerin dünya konumu (glTF) ve dönüşümün ayna olup olmadığı (sarım ters çevrilir).
      const jointSets: [number, number][] = [];
      for (let s = 0; attrs[`JOINTS_${s}`] !== undefined && attrs[`WEIGHTS_${s}`] !== undefined; s++) jointSets.push([attrs[`JOINTS_${s}`], attrs[`WEIGHTS_${s}`]]);
      const nodeWorld = worldOf(ni);
      if (skin && jointSets.length) {
        if (instances) throw new Error('GLB iskeletli (skin) ağda örnekleme (EXT_mesh_gpu_instancing) kullanıyor; desteklenmiyor.');
        // Skinned mesh: düğümün kendi dönüşümü yok sayılır (glTF); köşe = Σ w · (eklemDünya · tersBağlama) · v.
        const joints = skin.joints ?? [];
        let ibm: Float64Array | null = null;
        if (skin.inverseBindMatrices !== undefined) {
          const r = readAccessor(skin.inverseBindMatrices, 'ters bağlama matrisi');
          if (r.size !== 16) throw glbCorrupt('ters bağlama matrisi erişimcisi MAT4 değil');
          if (r.count < joints.length) throw glbCorrupt(`ters bağlama matrisi sayısı (${r.count}) eklem sayısından (${joints.length}) az`);
          ibm = r.data;
        }
        const jointMats = joints.map((j, i) => {
          const m = worldOf(j).clone();
          return ibm ? m.multiply(new THREE.Matrix4().fromArray(ibm, i * 16)) : m;
        });
        const sets = jointSets.map(([j, w]) => {
          const ja = readAccessor(j, 'eklem (JOINTS)');
          const wa = readAccessor(w, 'ağırlık (WEIGHTS)');
          if (ja.size !== 4 || wa.size !== 4 || ja.count < pos.count || wa.count < pos.count) throw glbCorrupt('eklem/ağırlık erişimcisi VEC4 değil ya da köşe sayısından kısa');
          for (const x of ja.data) if (!(x >= 0 && x < joints.length)) throw glbCorrupt(`eklem indisi (${x}) iskeletin dışında (${joints.length} eklem)`);
          return { j: ja.data, w: wa.data };
        });
        const world = new Float64Array(pos.count * 3);
        const mirrored = new Uint8Array(pos.count);
        const sum = new THREE.Matrix4();
        for (let i = 0; i < pos.count; i++) {
          const e = sum.elements.fill(0);
          let total = 0;
          for (const s of sets) {
            for (let c = 0; c < 4; c++) {
              const w = s.w[i * 4 + c];
              if (!w) continue;
              const jm = jointMats[s.j[i * 4 + c]];
              for (let q = 0; q < 16; q++) e[q] += w * jm.elements[q];
              total += w;
            }
          }
          const m = total > 0 ? sum.multiplyScalar(1 / total) : nodeWorld;
          v.set(pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]).applyMatrix4(m).toArray(world, i * 3);
          mirrored[i] = m.determinant() < 0 ? 1 : 0;
        }
        emit(tri, world, mirrored);
        continue;
      }
      // Örneklemede her örnek ayrı kopya: dünya = düğüm dünyası · örnek matrisi (ayna örneğinde sarım ters çevrilir).
      for (const inst of instances ?? [null]) {
        const m = inst ? nodeWorld.clone().multiply(inst) : nodeWorld;
        const world = new Float64Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          v.set(pos.data[i * 3], pos.data[i * 3 + 1], pos.data[i * 3 + 2]).applyMatrix4(m).toArray(world, i * 3);
        }
        emit(tri, world, new Uint8Array(pos.count).fill(m.determinant() < 0 ? 1 : 0));
      }
    }
  }
  const soup = concat(chunks);
  if (!soup.length) throw new Error('GLB içinde üçgen bulunamadı (yalnızca nokta/çizgi ya da boş sahne).');
  return soup;
}

/** İlkel kipine göre üçgen köşe indisleri: 4 üçgen, 5 şerit (strip), 6 yelpaze (fan); sarım glTF tanımındaki gibi. */
function triangleIndices(idx: ArrayLike<number>, mode: number): number[] {
  const out: number[] = [];
  const n = idx.length;
  if (mode === 4) for (let i = 0; i + 2 < n; i += 3) out.push(idx[i], idx[i + 1], idx[i + 2]);
  else if (mode === 5) for (let i = 0; i + 2 < n; i++) out.push(idx[i], idx[i + 1 + (i % 2)], idx[i + 2 - (i % 2)]);
  else if (mode === 6) for (let i = 0; i + 2 < n; i++) out.push(idx[i + 1], idx[i + 2], idx[0]);
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
  /** Parçanın görsel saydamlığı (0–1; yoksa opak): 3MF `displaycolor` alfası. */
  opacity?: number;
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

/** `#RRGGBBAA` için alfa: saydamlık yoksa `FF`. */
const alphaHex = (opacity?: number) => Math.round(Math.min(1, Math.max(0, opacity ?? 1)) * 255).toString(16).padStart(2, '0').toUpperCase();

/** 3MF: her parça ayrı nesne ve kendi rengiyle (çok renkli baskı için dilimleyicide parça/renk ataması kolay); saydamlık alfa olarak. */
export function build3mf(title: string, meshes: WorldMesh[]): Uint8Array {
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="tr-TR" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    `  <metadata name="Title">${xmlEsc(title)}</metadata>`,
    '  <metadata name="Application">P3D</metadata>',
    '  <resources>',
    '    <basematerials id="1">',
    ...meshes.map((m) => `      <base name="${xmlEsc(m.name)}" displaycolor="${m.color.toUpperCase()}${alphaHex(m.opacity)}" />`),
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
