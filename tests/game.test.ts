// Oyun motoru için: GLB yazıcı, gruplar + pivot, ayna, çoklu kopya, düşük poligon ve `check` oyun profili.
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeLlmOp, type Op, type PartGeom } from '../shared/ops';
import { getAsset, makeAsset } from '../src/assets';
import { checkProject } from '../src/check';
import { initCsg } from '../src/csg';
import { applyOps, partBox, partMatrix, sceneSummary } from '../src/engine';
import { buildGlb, srgbToLinear } from '../src/gltf';
import { parseProject, projectToJson, worldMesh } from '../src/io';
import { solidVolume } from '../src/model';
import { newProject, type Part, type Project } from '../src/types';

beforeAll(() => initCsg());

function project(ops: Op[], seg = 24): Project {
  const p = newProject('oyun');
  p.settings.resolution = seg;
  const res = applyOps(p, ops, null);
  expect(res.errors).toEqual([]);
  return p;
}

const byName = (p: Project, name: string) => {
  const part = p.parts.find((x) => x.name === name);
  if (!part) throw new Error(`parça yok: ${name}`);
  return part;
};

const box = (name: string, w: number, d: number, h: number, at: { x: number; y: number; z: number }, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'box',
  name,
  params: [
    { name: 'width', value: w },
    { name: 'depth', value: d },
    { name: 'height', value: h },
  ],
  position: at,
  ...extra,
});

const cyl = (name: string, dia: number, h: number, at: { x: number; y: number; z: number }, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'cylinder',
  name,
  params: [
    { name: 'diameter', value: dia },
    { name: 'height', value: h },
  ],
  position: at,
  ...extra,
});

/** Kapalı ve tutarlı yönlü ağ: hatalı yönlü kenar sayısı ve işaretli hacim. */
function closed(pos: Float32Array, tris: number[]) {
  const directed = new Map<string, number>();
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) directed.set(`${u}>${v}`, (directed.get(`${u}>${v}`) ?? 0) + 1);
  }
  let bad = 0;
  for (const [k, n] of directed) {
    const [u, v] = k.split('>');
    if (n !== 1 || directed.get(`${v}>${u}`) !== 1) bad++;
  }
  let vol = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const [p, q, r] = [tris[i] * 3, tris[i + 1] * 3, tris[i + 2] * 3];
    vol +=
      (pos[p] * (pos[q + 1] * pos[r + 2] - pos[q + 2] * pos[r + 1]) -
        pos[p + 1] * (pos[q] * pos[r + 2] - pos[q + 2] * pos[r]) +
        pos[p + 2] * (pos[q] * pos[r + 1] - pos[q + 1] * pos[r])) /
      6;
  }
  return { bad, vol };
}

// ---------------------------------------------------------------------------
// GLB ayrıştırma (spesifikasyon denetimiyle)

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as const;
const CTORS: Record<number, { new (b: ArrayBuffer, o: number, n: number): ArrayLike<number>; BYTES_PER_ELEMENT: number }> = {
  5126: Float32Array,
  5125: Uint32Array,
  5123: Uint16Array,
  5121: Uint8Array,
};

function parseGlb(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(dv.getUint32(0, true)).toBe(0x46546c67); // glTF
  expect(dv.getUint32(4, true)).toBe(2);
  expect(dv.getUint32(8, true)).toBe(bytes.length);
  const jsonLen = dv.getUint32(12, true);
  expect(jsonLen % 4).toBe(0);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a); // JSON
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const b = 20 + jsonLen;
  const binLen = dv.getUint32(b, true);
  expect(binLen % 4).toBe(0);
  expect(dv.getUint32(b + 4, true)).toBe(0x004e4942); // BIN
  expect(b + 8 + binLen).toBe(bytes.length);
  // Ayrı bir ArrayBuffer: tipli diziler hizalı okunur
  const bin = bytes.slice(b + 8, b + 8 + binLen).buffer;
  expect(json.asset.version).toBe('2.0');
  expect(json.buffers).toHaveLength(1);
  expect(json.buffers[0].byteLength).toBeLessThanOrEqual(binLen);
  for (const v of json.bufferViews) {
    expect(v.byteOffset % 4).toBe(0);
    expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(json.buffers[0].byteLength);
  }
  const read = (i: number): number[] => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const C = CTORS[a.componentType];
    const n = a.count * COMPONENTS[a.type as keyof typeof COMPONENTS];
    expect(n * C.BYTES_PER_ELEMENT).toBeLessThanOrEqual(v.byteLength);
    return Array.from(new C(bin, v.byteOffset + (a.byteOffset ?? 0), n));
  };
  // POSITION: min/max zorunlu ve verilerle aynı
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      const a = json.accessors[prim.attributes.POSITION];
      const data = read(prim.attributes.POSITION);
      for (let c = 0; c < 3; c++) {
        const comp = data.filter((_, k) => k % 3 === c);
        expect(a.min[c]).toBe(Math.min(...comp));
        expect(a.max[c]).toBe(Math.max(...comp));
      }
      const idx = read(prim.indices);
      expect(Math.max(...idx)).toBeLessThan(a.count);
      expect(json.bufferViews[json.accessors[prim.indices].bufferView].target).toBe(34963);
    }
  }
  return { json, read };
}

/** Bir primitifin üçgenleri: köşeler, normaller, indisler. */
function prim(g: ReturnType<typeof parseGlb>, meshIndex: number, primIndex = 0) {
  const p = g.json.meshes[meshIndex].primitives[primIndex];
  return { pos: g.read(p.attributes.POSITION), nor: g.read(p.attributes.NORMAL), idx: g.read(p.indices), p };
}

describe('GLB dışa aktarımı', () => {
  it('10 mm küp: metre, Y yukarı, düğüm çevirisi merkez, düz normaller dışa bakar', () => {
    const p = project([box('küp', 10, 10, 10, { x: 5, y: 20, z: 5 })]);
    const g = parseGlb(buildGlb(p));
    expect(g.json.nodes).toHaveLength(1);
    expect(g.json.nodes[0].name).toBe('küp');
    expect(g.json.meshes[0].name).toBe('küp');
    expect(g.json.scenes[0].nodes).toEqual([0]);
    // (x, y, z) → (x, z, −y) × 0.001
    g.json.nodes[0].translation.forEach((v: number, i: number) => expect(v).toBeCloseTo([0.005, 0.005, -0.02][i], 9));
    const { pos, nor, idx } = prim(g, 0);
    expect(pos.length / 3).toBe(36); // düz: üçgen başına 3 köşe
    for (const v of pos) expect(Math.abs(Math.abs(v) - 0.005)).toBeLessThan(1e-7);
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
      const e1 = new THREE.Vector3(pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]);
      const e2 = new THREE.Vector3(pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]);
      const fn = e1.cross(e2).normalize();
      const n = new THREE.Vector3(nor[a], nor[a + 1], nor[a + 2]);
      expect(fn.dot(n)).toBeCloseTo(1, 6); // sarım ile normal uyumlu
      const centroid = new THREE.Vector3(pos[a] + pos[b] + pos[c], pos[a + 1] + pos[b + 1] + pos[c + 1], pos[a + 2] + pos[b + 2] + pos[c + 2]);
      expect(n.dot(centroid)).toBeGreaterThan(0); // dışa bakar
    }
  });

  it('eksen eşlemesi: X genişlik → x, Z yükseklik → y (yukarı), Y derinlik → −z; mm birimi', () => {
    const p = project([box('kutu', 10, 20, 30, { x: 0, y: 0, z: 15 })]);
    const g = parseGlb(buildGlb(p, { units: 'mm' }));
    const a = g.json.accessors[g.json.meshes[0].primitives[0].attributes.POSITION];
    expect(a.min).toEqual([-5, -15, -10]);
    expect(a.max).toEqual([5, 15, 10]);
    expect(g.json.nodes[0].translation).toEqual([0, 15, 0]);
    // Önü −Y olan P3D'de ön yüz (y = −10) glTF'de +Z'ye bakar
    const q = project([box('ön', 10, 10, 10, { x: 0, y: -50, z: 5 })]);
    expect(parseGlb(buildGlb(q, { units: 'mm' })).json.nodes[0].translation).toEqual([0, 5, 50]);
  });

  it('malzemeler: aynı renk tek malzeme, sRGB → lineer, metallic 0, roughness 0,9', () => {
    const p = project([
      box('a', 5, 5, 5, { x: -20, y: 0, z: 2.5 }, { color: '#ff0000' }),
      box('b', 5, 5, 5, { x: 0, y: 0, z: 2.5 }, { color: '#FF0000' }),
      box('c', 5, 5, 5, { x: 20, y: 0, z: 2.5 }, { color: '#808080' }),
    ]);
    const g = parseGlb(buildGlb(p));
    expect(g.json.materials).toHaveLength(2);
    const grey = g.json.materials[g.json.meshes[2].primitives[0].material];
    expect(grey.pbrMetallicRoughness.baseColorFactor[0]).toBeCloseTo(0.2158605, 5);
    expect(grey.pbrMetallicRoughness.baseColorFactor[3]).toBe(1);
    expect(grey.pbrMetallicRoughness.metallicFactor).toBe(0);
    expect(grey.pbrMetallicRoughness.roughnessFactor).toBe(0.9);
    expect(g.json.meshes[0].primitives[0].material).toBe(g.json.meshes[1].primitives[0].material);
    expect(srgbToLinear(1)).toBeCloseTo(1, 9);
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 9);
  });

  it('flat ve smooth: köşe sayısı farkı, kutu köşeleri 50° eşikte keskin kalır', () => {
    const p = project([{ op: 'create', shape: 'sphere', name: 'küre', params: [{ name: 'diameter', value: 20 }], position: { x: 0, y: 0, z: 10 } }, box('k', 10, 10, 10, { x: 30, y: 0, z: 5 })], 16);
    const flat = parseGlb(buildGlb(p, { normals: 'flat' }));
    const smooth = parseGlb(buildGlb(p, { normals: 'smooth' }));
    const fs = prim(flat, 0);
    const ss = prim(smooth, 0);
    expect(fs.idx.length).toBe(ss.idx.length); // aynı üçgenler
    expect(fs.pos.length / 3).toBe(fs.idx.length);
    expect(ss.pos.length / 3).toBeLessThan((fs.pos.length / 3) / 3);
    // küre yumuşak: normal ≈ konum yönü
    for (let i = 0; i < ss.pos.length; i += 3) {
      const v = new THREE.Vector3(ss.pos[i], ss.pos[i + 1], ss.pos[i + 2]).normalize();
      expect(v.dot(new THREE.Vector3(ss.nor[i], ss.nor[i + 1], ss.nor[i + 2]))).toBeGreaterThan(0.97);
    }
    expect(prim(smooth, 1).pos.length / 3).toBe(24); // kutu: yüz başına 4 köşe
    expect(prim(flat, 1).pos.length / 3).toBe(36);
  });

  it('delikler uygulanır; delik ve referans parçalar dışa aktarılmaz; parts süzgeci', () => {
    const p = project([
      box('plaka', 20, 20, 4, { x: 0, y: 0, z: 2 }),
      cyl('delik', 6, 6, { x: 0, y: 0, z: 2 }, { role: 'hole' }),
      box('ref', 5, 5, 5, { x: 40, y: 0, z: 2.5 }, { role: 'reference' }),
      box('diğer', 5, 5, 5, { x: -40, y: 0, z: 2.5 }),
    ]);
    const g = parseGlb(buildGlb(p));
    expect(g.json.nodes.map((n: { name: string }) => n.name)).toEqual(['plaka', 'diğer']);
    expect(prim(g, 0).idx.length / 3).toBe(worldMesh(p, byName(p, 'plaka')).tris.length / 3);
    const only = parseGlb(buildGlb(p, { parts: ['diğer'] }));
    expect(only.json.nodes.map((n: { name: string }) => n.name)).toEqual(['diğer']);
    expect(() => buildGlb(p, { parts: ['ref'] })).toThrow(/katı parça değil/);
    expect(() => buildGlb(p, { parts: ['yok'] })).toThrow(/bulunamadı/);
  });

  it('grup düğümü: çeviri = pivot, üyeler çocuk düğüm (ofset = merkez − pivot)', () => {
    const p = project([
      box('gövde', 40, 20, 10, { x: 0, y: 0, z: 15 }),
      cyl('lastik', 16, 6, { x: 15, y: 13, z: 8 }, { rotation: { x: 90, y: 0, z: 0 } }),
      cyl('göbek', 6, 2, { x: 15, y: 17, z: 8 }, { rotation: { x: 90, y: 0, z: 0 } }),
      { op: 'group', name: 'teker', parts: ['lastik', 'göbek'], pivot: { x: 15, y: 13, z: 8 } },
    ]);
    const g = parseGlb(buildGlb(p, { units: 'mm' }));
    const nodes = g.json.nodes as { name: string; translation: number[]; children?: number[]; mesh?: number }[];
    expect(nodes.map((n) => n.name)).toEqual(['gövde', 'teker', 'lastik', 'göbek']);
    expect(g.json.scenes[0].nodes).toEqual([0, 1]);
    expect(nodes[1].translation).toEqual([15, 8, -13]);
    expect(nodes[1].mesh).toBeUndefined();
    expect(nodes[1].children).toEqual([2, 3]);
    nodes[2].translation.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 0][i], 9));
    nodes[3].translation.forEach((v, i) => expect(v).toBeCloseTo([0, 0, -4][i], 9));
    // köşeler düğüme göre: lastik döndürülmüş (eksen P3D Y → glTF −Z), yarıçap 8, kalınlık 6
    const a = g.json.accessors[g.json.meshes[nodes[2].mesh!].primitives[0].attributes.POSITION];
    expect(a.max[0]).toBeCloseTo(8, 4);
    expect(a.max[2]).toBeCloseTo(3, 4);
  });

  it('iskelet: kök + grup başına eklem, ağırlık 1, inverseBindMatrices = çevirinin tersi', () => {
    const p = project([
      box('gövde', 40, 20, 10, { x: 0, y: 0, z: 15 }, { color: '#cccccc' }),
      cyl('sol', 16, 6, { x: 15, y: 13, z: 8 }, { rotation: { x: 90, y: 0, z: 0 }, color: '#222222' }),
      cyl('sağ', 16, 6, { x: 15, y: -13, z: 8 }, { rotation: { x: 90, y: 0, z: 0 }, color: '#333333' }),
      { op: 'group', name: 'teker_sol', parts: ['sol'], pivot: null },
      { op: 'group', name: 'teker_sag', parts: ['sağ'], pivot: null },
    ]);
    const g = parseGlb(buildGlb(p, { skeleton: true }));
    const { json } = g;
    expect(json.skins).toHaveLength(1);
    const skin = json.skins[0];
    expect(skin.joints.map((j: number) => json.nodes[j].name)).toEqual(['root', 'teker_sol', 'teker_sag']);
    expect(skin.skeleton).toBe(skin.joints[0]);
    expect(json.nodes[skin.joints[0]].children).toEqual(skin.joints.slice(1));
    const meshNode = json.nodes.find((n: { skin?: number }) => n.skin === 0);
    expect(meshNode.mesh).toBe(0);
    expect(meshNode.translation).toBeUndefined();
    expect(json.meshes).toHaveLength(1);
    expect(json.scenes[0].nodes).toContain(skin.joints[0]);
    // eklem çevirileri = pivot (glTF, metre)
    const tSol = json.nodes[skin.joints[1]].translation;
    [0.015, 0.008, -0.013].forEach((v, i) => expect(tSol[i]).toBeCloseTo(v, 9));
    const ibm = g.read(skin.inverseBindMatrices);
    expect(json.accessors[skin.inverseBindMatrices].type).toBe('MAT4');
    expect(ibm.slice(0, 16)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    skin.joints.forEach((j: number, k: number) => {
      const t = json.nodes[j].translation ?? [0, 0, 0];
      const m = new THREE.Matrix4().fromArray(ibm.slice(16 * k, 16 * k + 16));
      const expected = new THREE.Matrix4().makeTranslation(t[0], t[1], t[2]).invert();
      m.elements.forEach((v, i) => expect(v).toBeCloseTo(expected.elements[i], 6));
    });
    // renk başına primitif; köşe eklemleri: gövde → 0, sol → 1, sağ → 2
    const jointOfColor: Record<string, number> = { cccccc: 0, '222222': 1, '333333': 2 };
    for (const pr of json.meshes[0].primitives) {
      const color = json.materials[pr.material].name.replace('P3D_', '');
      const joints = g.read(pr.attributes.JOINTS_0);
      const weights = g.read(pr.attributes.WEIGHTS_0);
      expect(json.accessors[pr.attributes.JOINTS_0].componentType).toBe(5121);
      for (let i = 0; i < joints.length; i += 4) {
        expect(joints.slice(i, i + 4)).toEqual([jointOfColor[color], 0, 0, 0]);
        expect(weights.slice(i, i + 4)).toEqual([1, 0, 0, 0]);
      }
    }
  });

  it("three'nin GLTFLoader'ı Node'da geri yükler (iskeletli ve iskeletsiz)", async () => {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const p = project([
      box('gövde', 40, 20, 10, { x: 0, y: 0, z: 15 }),
      cyl('sol', 16, 6, { x: 15, y: 13, z: 8 }, { rotation: { x: 90, y: 0, z: 0 } }),
      { op: 'group', name: 'teker', parts: ['sol'], pivot: null },
    ]);
    const load = (bytes: Uint8Array) =>
      new Promise<{ scene: THREE.Group }>((ok, fail) => new GLTFLoader().parse(bytes.slice().buffer, '', ok as never, fail));
    const plain = await load(buildGlb(p));
    expect(plain.scene.getObjectByName('teker')).toBeTruthy();
    const box3 = new THREE.Box3().setFromObject(plain.scene);
    expect(box3.max.y).toBeCloseTo(0.02, 5); // gövde üstü 20 mm
    const rig = await load(buildGlb(p, { skeleton: true }));
    // Renk (primitif) başına bir SkinnedMesh; hepsi aynı iskelet: root + teker
    const meshes: THREE.Mesh[] = [];
    rig.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2);
    for (const m of meshes) {
      expect((m as THREE.SkinnedMesh).isSkinnedMesh).toBe(true);
      expect((m as THREE.SkinnedMesh).skeleton.bones.map((b) => b.name)).toEqual(['root', 'teker']);
    }
  });
});

// ---------------------------------------------------------------------------

describe('gruplar ve pivot', () => {
  const wheel = (): Op[] => [
    box('gövde', 40, 20, 10, { x: 0, y: 0, z: 15 }),
    cyl('lastik', 16, 6, { x: 10, y: 0, z: 8 }, { rotation: { x: 90, y: 0, z: 0 } }),
    box('cıvata', 2, 2, 2, { x: 14, y: 0, z: 8 }),
    { op: 'group', name: 'teker', parts: ['lastik', 'cıvata'], pivot: null },
  ];

  it('grup: varsayılan pivot kutu merkezi; sahne özeti ve dosya gidiş-dönüşü', () => {
    const p = project(wheel());
    expect(p.groups).toHaveLength(1);
    expect(p.groups![0].pivot).toEqual({ x: 10, y: 0, z: 8 }); // lastik kutusu cıvatayı kapsar
    expect(byName(p, 'lastik').group).toBe('teker');
    expect(byName(p, 'gövde').group).toBeUndefined();
    const s = sceneSummary(p, null);
    expect(s.groups).toEqual([{ name: 'teker', pivot: { x: 10, y: 0, z: 8 } }]);
    expect(s.parts.find((x) => x.name === 'cıvata')!.group).toBe('teker');
    expect(parseProject(JSON.parse(projectToJson(p)))).toEqual(p);
    // grupsuz projede alan yok
    const q = project([box('a', 1, 1, 1, { x: 0, y: 0, z: 0.5 })]);
    expect('groups' in parseProject(JSON.parse(projectToJson(q)))).toBe(false);
    expect(sceneSummary(q, null).groups).toBeUndefined();
  });

  it('move: üyeler ve pivot birlikte taşınır', () => {
    const p = project(wheel());
    const r = applyOps(p, [{ op: 'move', part: 'teker', dx: 5, dy: -2, dz: 1 }], null);
    expect(r.errors).toEqual([]);
    expect(byName(p, 'lastik').position).toEqual({ x: 15, y: -2, z: 9 });
    expect(byName(p, 'cıvata').position).toEqual({ x: 19, y: -2, z: 9 });
    expect(byName(p, 'gövde').position).toEqual({ x: 0, y: 0, z: 15 });
    expect(p.groups![0].pivot).toEqual({ x: 15, y: -2, z: 9 });
  });

  it('rotate: pivot etrafında 90° — konumlar ve döndürmeler (dünya köşeleri döner)', () => {
    const p = project(wheel());
    const before = new Map(p.parts.map((x) => [x.name, worldMesh(p, x).pos.slice()]));
    const r = applyOps(p, [{ op: 'rotate', part: 'teker', axis: 'y', degrees: 90 }], null);
    expect(r.errors).toEqual([]);
    expect(byName(p, 'cıvata').position).toEqual({ x: 10, y: 0, z: 4 }); // (4, 0, 0) göreli → Y'de 90°: (0, 0, −4)
    expect(byName(p, 'lastik').position).toEqual({ x: 10, y: 0, z: 8 });
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    const pivot = new THREE.Vector3(10, 0, 8);
    for (const name of ['lastik', 'cıvata']) {
      const a = before.get(name)!;
      const b = worldMesh(p, byName(p, name)).pos;
      for (let i = 0; i < a.length; i += 3) {
        const v = new THREE.Vector3(a[i], a[i + 1], a[i + 2]).sub(pivot).applyQuaternion(q).add(pivot);
        expect(Math.hypot(v.x - b[i], v.y - b[i + 1], v.z - b[i + 2])).toBeLessThan(1e-3);
      }
    }
    expect(byName(p, 'gövde').rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(p.groups![0].pivot).toEqual({ x: 10, y: 0, z: 8 });
  });

  it('duplicate: grup kopyası (adet + kaydırma), delik hedefi kopyaya yönelir', () => {
    const p = project([
      ...wheel(),
      cyl('mil deliği', 3, 10, { x: 10, y: 0, z: 8 }, { rotation: { x: 90, y: 0, z: 0 }, role: 'hole', cuts: ['lastik'] }),
      { op: 'group', name: 'teker', parts: ['lastik', 'cıvata', 'mil deliği'], pivot: null },
    ]);
    const r = applyOps(p, [{ op: 'duplicate', part: 'teker', new_name: 'teker', offset: { x: 0, y: 30, z: 0 }, count: 2 }], null);
    expect(r.errors).toEqual([]);
    expect(p.groups!.map((g) => g.name)).toEqual(['teker', 'teker 1', 'teker 2']);
    expect(p.groups![2].pivot).toEqual({ x: 10, y: 60, z: 8 });
    const second = p.parts.filter((x) => x.group === 'teker 2');
    expect(second).toHaveLength(3);
    expect(new Set(p.parts.map((x) => x.name)).size).toBe(p.parts.length); // adlar benzersiz
    expect(second.map((x) => x.position.y)).toEqual([60, 60, 60]);
    const hole = second.find((x) => x.role === 'hole')!;
    const rim = second.find((x) => x.shape === 'cylinder' && x.role !== 'hole')!;
    expect(hole.cuts).toEqual([rim.id]);
    // kopyanın deliği kopyanın lastiğini keser (hacmi özgünle aynı, kesimsizden küçük)
    const uncut = 0.5 * 24 * 64 * Math.sin((2 * Math.PI) / 24) * 6;
    expect(solidVolume(p, byName(p, 'lastik'))).toBeLessThan(uncut - 10);
    expect(solidVolume(p, rim)).toBeCloseTo(solidVolume(p, byName(p, 'lastik')), 3);
    const r2 = applyOps(p, [{ op: 'duplicate', part: 'teker', count: 3 }], null);
    expect(r2.errors.join(' ')).toMatch(/kaydırma \(offset\) gerekli/);
  });

  it('duplicate: grup varsayılanı — yanına tek kopya, ad soneki, aynı göreli yerleşim', () => {
    const p = project(wheel());
    const r = applyOps(p, [{ op: 'duplicate', part: 'teker' }], null);
    expect(r.errors).toEqual([]);
    expect(p.groups!.map((g) => g.name)).toEqual(['teker', 'teker kopya']);
    const copies = p.parts.filter((x) => x.group === 'teker kopya');
    expect(copies.map((x) => x.name)).toEqual(['lastik kopya', 'cıvata kopya']);
    const dx = copies[0].position.x - byName(p, 'lastik').position.x;
    expect(dx).toBeCloseTo(16 + 5, 3); // grup kutusu genişliği + 5 mm
    expect(copies[1].position.x - byName(p, 'cıvata').position.x).toBeCloseTo(dx, 6);
    expect(p.groups![1].pivot.x - p.groups![0].pivot.x).toBeCloseTo(dx, 6);
  });

  it('delete grubu ve üyelerini siler; ungroup üyeliği kaldırır; set_pivot', () => {
    const p = project(wheel());
    applyOps(p, [{ op: 'set_pivot', group: 'teker', pivot: { x: 1, y: 2, z: 3 } }], null);
    expect(p.groups![0].pivot).toEqual({ x: 1, y: 2, z: 3 });
    const q = structuredClone(p);
    const r = applyOps(p, [{ op: 'delete', part: 'teker' }], byName(p, 'lastik').id);
    expect(r.errors).toEqual([]);
    expect(r.clearSelection).toBe(true);
    expect(p.parts.map((x) => x.name)).toEqual(['gövde']);
    expect(p.groups).toBeUndefined();
    applyOps(q, [{ op: 'ungroup', name: 'teker' }], null);
    expect(q.parts.every((x) => x.group === undefined)).toBe(true);
    expect(q.groups).toBeUndefined();
    expect(q.parts).toHaveLength(3);
  });

  it('üyelik tutarlı: başka gruba alma, parça silme, yeniden adlandırma, ad çakışması', () => {
    const p = project(wheel());
    applyOps(p, [{ op: 'group', name: 'tek', parts: ['cıvata'], pivot: null }], null);
    expect(byName(p, 'cıvata').group).toBe('tek');
    expect(p.groups!.map((g) => g.name)).toEqual(['teker', 'tek']);
    applyOps(p, [{ op: 'delete', part: 'cıvata' }], null);
    expect(p.groups!.map((g) => g.name)).toEqual(['teker']); // üyesiz grup kalmaz
    applyOps(p, [{ op: 'update', part: 'lastik', name: 'ön lastik' }], null);
    expect(byName(p, 'ön lastik').group).toBe('teker');
    const r = applyOps(p, [{ op: 'group', name: 'gövde', parts: ['ön lastik'], pivot: null }], null);
    expect(r.errors.join(' ')).toMatch(/adında bir parça var/);
    const r2 = applyOps(p, [{ op: 'scale', part: 'teker', factor: 2 }], null);
    expect(r2.errors.join(' ')).toMatch(/bir grup/);
    const r3 = applyOps(p, [{ op: 'group', name: 'yeni', parts: [], pivot: null }], null);
    expect(r3.errors.join(' ')).toMatch(/üye parçalar/);
  });

  it('update ile grup rengi ve görünürlüğü; diğer alanlar reddedilir', () => {
    const p = project(wheel());
    applyOps(p, [{ op: 'update', part: 'teker', color: '#112233', visible: false }], null);
    expect(p.parts.filter((x) => x.group === 'teker').every((x) => x.color === '#112233' && !x.visible)).toBe(true);
    expect(byName(p, 'gövde').visible).toBe(true);
    const r = applyOps(p, [{ op: 'update', part: 'teker', params: [{ name: 'height', value: 3 }] }], null);
    expect(r.errors.join(' ')).toMatch(/yalnızca renk ve görünürlük/);
  });
});

describe('duplicate count', () => {
  it('count kopya, kaydırma birikerek; offset yoksa hata; adlar', () => {
    const p = project([box('çıta', 2, 20, 2, { x: 0, y: 0, z: 1 })]);
    const r = applyOps(p, [{ op: 'duplicate', part: 'çıta', offset: { x: 5, y: 0, z: 0 }, count: 3 }], null);
    expect(r.errors).toEqual([]);
    expect(p.parts.map((x) => [x.name, x.position.x])).toEqual([
      ['çıta', 0],
      ['çıta kopya', 5],
      ['çıta kopya 2', 10],
      ['çıta kopya 3', 15],
    ]);
    applyOps(p, [{ op: 'duplicate', part: 'çıta', new_name: 'dilim', offset: { x: 0, y: 0, z: 3 }, count: 2 }], null);
    expect(p.parts.slice(-2).map((x) => [x.name, x.position.z])).toEqual([
      ['dilim 1', 4],
      ['dilim 2', 7],
    ]);
    expect(applyOps(p, [{ op: 'duplicate', part: 'çıta', count: 2 }], null).errors.join(' ')).toMatch(/offset/);
    expect(applyOps(p, [{ op: 'duplicate', part: 'çıta', offset: { x: 1, y: 0, z: 0 }, count: 2.5 }], null).errors.join(' ')).toMatch(/count/);
    const n = p.parts.length;
    applyOps(p, [{ op: 'duplicate', part: 'çıta', count: 0 }], null); // 0 = tek kopya
    expect(p.parts.length).toBe(n + 1);
  });

  it('normalizeLlmOp: count 0/1 opsiyonel alana çevrilir', () => {
    expect(normalizeLlmOp({ op: 'duplicate', part: 'a', new_name: '', offset: null, count: 0 })).toEqual({ op: 'duplicate', part: 'a' });
    expect(normalizeLlmOp({ op: 'duplicate', part: 'a', new_name: '', offset: null, count: 1 })).toEqual({ op: 'duplicate', part: 'a' });
    expect(normalizeLlmOp({ op: 'duplicate', part: 'a', new_name: 'b', offset: { x: 1, y: 0, z: 0 }, count: 4 })).toEqual({
      op: 'duplicate',
      part: 'a',
      new_name: 'b',
      offset: { x: 1, y: 0, z: 0 },
      count: 4,
    });
    expect(normalizeLlmOp({ op: 'mirror', part: 'a', plane: 'y', at: null, name: '' })).toEqual({ op: 'mirror', part: 'a', plane: 'y' });
  });
});

// ---------------------------------------------------------------------------

describe('ayna', () => {
  const L: [number, number][] = [[0, 0], [30, 0], [30, 6], [6, 6], [6, 20], [0, 20]];
  const sq = (h: number, dx = 0): [number, number][] => [[-h + dx, -h], [h + dx, -h], [h + dx, h], [-h + dx, h]];
  const geomOps: [string, Op][] = [
    ['box', box('box', 10, 6, 4, { x: 0, y: 0, z: 0 })],
    ['cylinder', cyl('cylinder', 10, 6, { x: 0, y: 0, z: 0 })],
    ['tube', { op: 'create', shape: 'tube', name: 'tube' }],
    ['cone', { op: 'create', shape: 'cone', name: 'cone', params: [{ name: 'topDiameter', value: 6 }] }],
    ['sphere', { op: 'create', shape: 'sphere', name: 'sphere' }],
    ['torus', { op: 'create', shape: 'torus', name: 'torus' }],
    ['prism', { op: 'create', shape: 'prism', name: 'prism', params: [{ name: 'sides', value: 5 }] }],
    ['extrude', { op: 'create', shape: 'extrude', name: 'extrude', geom: { kind: 'extrude', axis: 'x', profile: L, holes: [[[1, 1], [4, 1], [4, 4]]] } }],
    ['extrude frame', { op: 'create', shape: 'extrude', name: 'extrude frame', geom: { kind: 'extrude', axis: 'z', profile: [[5, 0], [5, 8], [-3, 8], [-3, 0]], frame: 1, open: true } }],
    ['revolve', { op: 'create', shape: 'revolve', name: 'revolve', geom: { kind: 'revolve', axis: 'y', profile: [[0, 0], [5, 0], [5, 10], [2, 14], [0, 14]] } }],
    [
      'loft',
      {
        op: 'create',
        shape: 'loft',
        name: 'loft',
        geom: { kind: 'loft', axis: 'y', sections: [{ at: 0, points: sq(5) }, { at: 8, points: sq(3, 2) }, { at: 12, points: [[3, 1]] }], smooth: true, sharp: [0, 1] } as PartGeom,
      },
    ],
    ['hull', { op: 'create', shape: 'hull', name: 'hull' }],
  ];

  /** Her köşenin yansıması öbür ağda bir köşeye denk gelir. */
  function sameUnderReflection(a: Float32Array, b: Float32Array, plane: 'x' | 'y' | 'z', at: number, tol: number) {
    const k = { x: 0, y: 1, z: 2 }[plane];
    let worst = 0;
    for (let i = 0; i < a.length; i += 3) {
      const r = [a[i], a[i + 1], a[i + 2]];
      r[k] = 2 * at - r[k];
      let best = Infinity;
      for (let j = 0; j < b.length; j += 3) best = Math.min(best, Math.hypot(r[0] - b[j], r[1] - b[j + 1], r[2] - b[j + 2]));
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThan(tol);
  }

  /**
   * exact: köşeler birebir yansımış, hacim eşit. loft: köşeler yansımış ama dörtgenlerin köşegeni ters (eğri yüzeyde
   * hacim ~%0,1 oynar). hull: örtük yüzey ağı tam simetrik değil (kenar ~1 mm), aynı ağ döndürülür.
   */
  function checkMirror(p: Project, orig: Part, copy: Part, plane: 'x' | 'y' | 'z', at: number, mode: 'exact' | 'loft' | 'hull') {
    const a = worldMesh(p, orig);
    const b = worldMesh(p, copy);
    const cb = closed(b.pos, b.tris);
    expect(cb.bad, `${orig.shape}: kapalı`).toBe(0);
    expect(cb.vol / closed(a.pos, a.tris).vol, `${orig.shape}: hacim`).toBeCloseTo(1, mode === 'loft' ? 2 : 5);
    const ba = partBox(orig, p.settings.resolution);
    const bb = partBox(copy, p.settings.resolution);
    const tol = mode === 'hull' ? 0.6 : 2e-3;
    const near = (x: number, y: number, what: string) => expect(Math.abs(x - y), `${orig.shape} ${what}`).toBeLessThan(tol);
    near(bb.min[plane], 2 * at - ba.max[plane], `min ${plane}`);
    near(bb.max[plane], 2 * at - ba.min[plane], `max ${plane}`);
    for (const o of (['x', 'y', 'z'] as const).filter((x) => x !== plane)) {
      near(bb.min[o], ba.min[o], `min ${o}`);
      near(bb.max[o], ba.max[o], `max ${o}`);
    }
    if (mode !== 'hull') {
      expect(b.pos.length).toBe(a.pos.length);
      sameUnderReflection(a.pos, b.pos, plane, at, 2e-3);
    }
    // det(R') = +1: geçerli döndürme
    expect(new THREE.Matrix4().extractRotation(partMatrix(copy)).determinant()).toBeCloseTo(1, 6);
  }

  it.each(geomOps)('%s: aynalanmış kopya — hacim aynı, kutu ve köşeler yansımış, ağ kapalı (döndürülmüş ve düz, üç düzlem)', (label, op) => {
    const mode = label === 'hull' ? 'hull' : label === 'loft' ? 'loft' : 'exact';
    for (const rotation of [{ x: 20, y: 35, z: 50 }, { x: 0, y: 0, z: 0 }]) {
      const p = project([{ ...(op as Extract<Op, { op: 'create' }>), position: { x: 3, y: -4, z: 12 }, rotation }]);
      const orig = byName(p, label);
      for (const [plane, at] of [['x', 7], ['y', -2], ['z', 0]] as const) {
        const r = applyOps(p, [{ op: 'mirror', part: label, plane, at, name: `${label} ${plane}` }], null);
        expect(r.errors).toEqual([]);
        checkMirror(p, orig, byName(p, `${label} ${plane}`), plane, at, mode);
      }
    }
  });

  it('döndürülmemiş parça simetri ekseninde aynalanınca döndürme değişmez', () => {
    const p = project([box('k', 10, 6, 4, { x: 20, y: 5, z: 2 }), cyl('s', 8, 4, { x: 0, y: 20, z: 2 })]);
    applyOps(p, [{ op: 'mirror', part: 'k', plane: 'x', at: 0 }, { op: 'mirror', part: 's', plane: 'y', at: 0 }], null);
    expect(byName(p, 'k ayna').rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(byName(p, 'k ayna').position).toEqual({ x: -20, y: 5, z: 2 });
    // silindir yerel y'de simetri adayı değil (tek segment sayısı); x'te aynalanır, Z'de 180° döner — aynı şekil
    expect(byName(p, 's ayna').position).toEqual({ x: 0, y: -20, z: 2 });
  });

  it('mesh: x negatif + sarım ters yeni ağ; aynanın aynası özgün ağdır', () => {
    const src = project([{ op: 'create', shape: 'extrude', name: 'L', geom: { kind: 'extrude', axis: 'z', profile: L }, position: { x: 0, y: 0, z: 0 } }]);
    const m = worldMesh(src, src.parts[0]);
    const asset = makeAsset('L ağı', m.pos, Uint32Array.from(m.tris));
    const p = project([{ op: 'import_mesh', asset, name: 'ağ', position: { x: 5, y: 0, z: 10 } }]);
    applyOps(p, [{ op: 'rotate', part: 'ağ', axis: 'z', degrees: 30 }], null);
    const r = applyOps(p, [{ op: 'mirror', part: 'ağ', plane: 'y', at: 3 }], null);
    expect(r.errors).toEqual([]);
    const copy = byName(p, 'ağ ayna');
    // z'de 30° döndürülmüş parça, y düzlemi: yerel y ekseni normale en yakın
    expect(copy.geom).toEqual({ kind: 'mesh', asset: `${asset.id}_my` });
    expect(getAsset(`${asset.id}_my`)!.triangles).toBe(asset.triangles);
    checkMirror(p, byName(p, 'ağ'), copy, 'y', 3, 'exact');
    applyOps(p, [{ op: 'mirror', part: 'ağ ayna', plane: 'y', at: 0, name: 'geri' }], null);
    expect(byName(p, 'geri').geom).toEqual({ kind: 'mesh', asset: asset.id });
  });

  it('grup aynası: yeni grup, pivot yansır, üye adları önekle; tek parçanın aynası gruba girmez', () => {
    const p = project([
      cyl('sol_lastik', 16, 6, { x: 10, y: 20, z: 8 }, { rotation: { x: 90, y: 0, z: 0 } }),
      box('sol_cıvata', 2, 2, 2, { x: 14, y: 24, z: 8 }),
      { op: 'group', name: 'sol', parts: ['sol_lastik', 'sol_cıvata'], pivot: { x: 10, y: 20, z: 8 } },
    ]);
    const r = applyOps(p, [{ op: 'mirror', part: 'sol', plane: 'y', at: 0, name: 'sag' }], null);
    expect(r.errors).toEqual([]);
    expect(p.groups!.map((g) => [g.name, g.pivot])).toEqual([
      ['sol', { x: 10, y: 20, z: 8 }],
      ['sag', { x: 10, y: -20, z: 8 }],
    ]);
    expect(p.parts.filter((x) => x.group === 'sag').map((x) => x.name)).toEqual(['sag_lastik', 'sag_cıvata']);
    expect(byName(p, 'sag_cıvata').position).toEqual({ x: 14, y: -24, z: 8 });
    expect(byName(p, 'sag_cıvata').rotation).toEqual({ x: 0, y: 0, z: 0 });
    expect(byName(p, 'sag_lastik').rotation).toEqual({ x: 90, y: 0, z: 0 });
    checkMirror(p, byName(p, 'sol_lastik'), byName(p, 'sag_lastik'), 'y', 0, 'exact');
    applyOps(p, [{ op: 'mirror', part: 'sol_cıvata', plane: 'x', at: 0 }], null);
    expect(byName(p, 'sol_cıvata ayna').group).toBeUndefined();
    expect(applyOps(p, [{ op: 'mirror', part: 'sol', plane: 'w' as never }], null).errors.join(' ')).toMatch(/düzlemi/);
  });
});

// ---------------------------------------------------------------------------

describe('check: oyun profili', () => {
  it('print davranışı değişmedi: ince parça ve tabla teması yalnızca print; game bunları atlar', () => {
    const p = project([box('levha', 10, 10, 0.5, { x: 0, y: 0, z: 10 })]);
    const print = checkProject(p);
    expect(checkProject(p, { profile: 'print' })).toEqual(print);
    expect(print.map((i) => i.message).join(' ')).toMatch(/0\.50 mm kalınlığında/);
    expect(print.map((i) => i.message).join(' ')).toMatch(/tablaya değmiyor/);
    expect(checkProject(p, { profile: 'game' })).toEqual([]);
  });

  it('üçgen bütçesi aşılınca uyarı ve parça başına dağılım', () => {
    const p = project(
      [
        { op: 'create', shape: 'sphere', name: 'küre', params: [{ name: 'diameter', value: 20 }], position: { x: 0, y: 0, z: 10 } },
        box('kutu', 10, 10, 10, { x: 30, y: 0, z: 5 }),
      ],
      48,
    );
    const tris = p.parts.map((x) => worldMesh(p, x).tris.length / 3);
    const total = tris[0] + tris[1];
    expect(checkProject(p, { profile: 'game' })).toEqual([]); // varsayılan 20000
    const issues = checkProject(p, { profile: 'game', maxTris: 1000 });
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('uyarı');
    expect(issues[0].message).toContain(`Toplam ${total.toLocaleString('tr-TR')} üçgen`);
    expect(issues[0].message).toMatch(/küre [\d.]+, kutu 12/);
  });

  it('bozuk (alanı ~0) üçgenleri bulur; z-fighting oyun profilinde de hata', () => {
    // Dörtyüzlü + doğrusal köşeli (alanı sıfır) bir üçgen
    const pos = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10, 5, 0, 0]);
    const idx = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3, 0, 4, 1]);
    const p = project([{ op: 'import_mesh', asset: makeAsset('bozuk', pos, idx), name: 'bozuk', position: { x: 0, y: 0, z: 5 } }]);
    const issues = checkProject(p, { profile: 'game' });
    expect(issues.map((i) => i.message).join(' ')).toMatch(/'bozuk': 1 bozuk/);
    const q = project([box('zemin', 20, 20, 2, { x: 0, y: 0, z: 1 }), box('levha', 10, 10, 2, { x: 0, y: 0, z: 1 })]);
    expect(checkProject(q, { profile: 'game' }).some((i) => i.level === 'hata' && /z-fighting/.test(i.message))).toBe(true);
  });
});
