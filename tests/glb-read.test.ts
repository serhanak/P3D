// GLB okuma (meshio.ts → parseMeshFile): P3D'nin kendi GLB'leriyle gidiş-dönüş (varsayılan, mm, iskelet, düz/yumuşak,
// gizli üçgen ayıklama), el yapımı GLB'lerle ilkel kipleri / bayt adımı / düğüm dönüşümleri / skin ve hata durumları;
// ağ dosyasından tek parçalı proje (projectFromMesh, loadMeshFileProject).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Op } from '../shared/ops';
import { getAsset } from '../src/assets';
import { initCsg } from '../src/csg';
import { applyOps } from '../src/engine';
import { loadMeshFileProject, loadProjectFile, saveProjectFile } from '../src/files';
import { glbBuild, selectParts, type GlbOptions } from '../src/gltf';
import { projectFromMesh, worldMesh } from '../src/io';
import { GLB_MAX_TRIS, defaultMaxTris, meshAssetFromSoup, parseMeshFile } from '../src/meshio';
import { solidVolume } from '../src/model';
import { newProject, type Project } from '../src/types';

let dir: string;
beforeAll(async () => {
  await initCsg();
  dir = mkdtempSync(path.join(tmpdir(), 'p3d-glb-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function project(ops: Op[], seg = 16): Project {
  const p = newProject('glb');
  p.settings.resolution = seg;
  const res = applyOps(p, ops, null);
  expect(res.errors).toEqual([]);
  return p;
}

const toBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

/** P3D'nin dışa aktarılan dünya ağı (GLB ile aynı parça kümesi ve aynı dejenere üçgen süzgeci), üçgen çorbası. */
function worldSoup(p: Project, parts?: string[]): number[] {
  const out: number[] = [];
  for (const part of selectParts(p, parts)) {
    const m = worldMesh(p, part);
    for (const v of m.tris) out.push(m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]);
  }
  return out;
}

/**
 * `actual` üçgenlerinden `expected`'te karşılığı (aynı sarım: köşelerin dönel kaydırması; her koordinat `tol` içinde) olmayan
 * sayısı. Ağırlık merkezi ızgarasıyla eşleştirir; her beklenen üçgen en çok bir kez kullanılır.
 */
function unmatched(actual: ArrayLike<number>, expected: ArrayLike<number>, tol = 1e-3): number {
  const key = (x: number, y: number, z: number) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  const centroid = (s: ArrayLike<number>, t: number) => [0, 1, 2].map((c) => (s[t * 9 + c] + s[t * 9 + 3 + c] + s[t * 9 + 6 + c]) / 3);
  const grid = new Map<string, number[]>();
  for (let t = 0; t < expected.length / 9; t++) {
    const k = key(...(centroid(expected, t) as [number, number, number]));
    grid.set(k, [...(grid.get(k) ?? []), t]);
  }
  const used = new Set<number>();
  let missing = 0;
  for (let t = 0; t < actual.length / 9; t++) {
    const [cx, cy, cz] = centroid(actual, t);
    let found = -1;
    search: for (const dx of [-1, 0, 1])
      for (const dy of [-1, 0, 1])
        for (const dz of [-1, 0, 1]) {
          for (const e of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            if (used.has(e)) continue;
            for (let r = 0; r < 3; r++) {
              let ok = true;
              for (let k = 0; k < 3 && ok; k++) {
                for (let c = 0; c < 3 && ok; c++) ok = Math.abs(actual[t * 9 + k * 3 + c] - expected[e * 9 + ((k + r) % 3) * 3 + c]) <= tol;
              }
              if (ok) {
                found = e;
                break search;
              }
            }
          }
        }
    if (found < 0) missing++;
    else used.add(found);
  }
  return missing;
}

/** Üçgen çorbasının işaretli hacmi (dışa bakan kapalı ağda pozitif). */
function signedVolume(s: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from({ length: 9 }, (_, k) => s[i + k]);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}

/** P3D projesi → GLB → parseMeshFile: üçgen kümesi dünya ağıyla aynı, sarım korunmuş. */
function roundTrip(p: Project, opts: GlbOptions) {
  const built = glbBuild(p, opts);
  const soup = parseMeshFile('model.glb', toBuffer(built.data));
  return { soup, built };
}

describe('GLB okuma: P3D GLB gidiş-dönüşü', () => {
  const scenes: [string, () => Project][] = [
    [
      'kutu + döndürülmüş silindir + koni',
      () =>
        project([
          { op: 'create', shape: 'box', name: 'govde', params: [{ name: 'width', value: 40 }, { name: 'depth', value: 20 }, { name: 'height', value: 10 }], position: { x: 0, y: 0, z: 5 } },
          { op: 'create', shape: 'cylinder', name: 'mil', params: [{ name: 'diameter', value: 12 }, { name: 'height', value: 30 }], position: { x: 40, y: 10, z: 20 }, rotation: { x: 30, y: 0, z: 45 } },
          { op: 'create', shape: 'cone', name: 'tepe', params: [{ name: 'bottomDiameter', value: 16 }, { name: 'topDiameter', value: 0 }, { name: 'height', value: 12 }], position: { x: -30, y: 15, z: 6 }, rotation: { x: 0, y: 70, z: 10 } },
        ]),
    ],
    [
      'grup + pivot (iki üye) + gruplanmamış parça',
      () =>
        project([
          { op: 'create', shape: 'box', name: 'kasa', params: [{ name: 'width', value: 60 }, { name: 'depth', value: 30 }, { name: 'height', value: 12 }], position: { x: 0, y: 0, z: 6 } },
          { op: 'create', shape: 'cylinder', name: 'lastik', params: [{ name: 'diameter', value: 20 }, { name: 'height', value: 6 }], position: { x: -20, y: -20, z: 10 }, rotation: { x: 90, y: 0, z: 0 } },
          { op: 'create', shape: 'cylinder', name: 'jant', params: [{ name: 'diameter', value: 12 }, { name: 'height', value: 7 }], position: { x: -20, y: -20, z: 10 }, rotation: { x: 90, y: 0, z: 0 }, color: '#cccccc' },
          { op: 'group', name: 'teker', parts: ['lastik', 'jant'], pivot: { x: -20, y: -20, z: 10 } },
        ]),
    ],
    [
      'aynalanmış parça (loft + döndürülmüş kutu)',
      () => {
        const p = project([
          {
            op: 'create',
            shape: 'loft',
            name: 'burun',
            geom: { kind: 'loft', axis: 'z', sections: [{ at: 0, points: [[-6, -4], [6, -4], [6, 4], [-6, 4]] }, { at: 14, points: [[-2, -1], [3, -1], [2, 2], [-2, 2]] }] },
            position: { x: 20, y: 5, z: 0 },
          },
          { op: 'create', shape: 'box', name: 'kanat', params: [{ name: 'width', value: 30 }, { name: 'depth', value: 4 }, { name: 'height', value: 8 }], position: { x: 25, y: 20, z: 10 }, rotation: { x: 10, y: 0, z: 25 } },
        ]);
        expect(applyOps(p, [{ op: 'mirror', part: 'burun', plane: 'x', at: 0 }, { op: 'mirror', part: 'kanat', plane: 'x', at: 0 }], null).errors).toEqual([]);
        expect(p.parts.find((x) => x.name === 'burun ayna')?.geom).toMatchObject({ mirrored: true });
        return p;
      },
    ],
    [
      'yumuşak loft',
      () =>
        project([
          {
            op: 'create',
            shape: 'loft',
            name: 'damla',
            geom: {
              kind: 'loft',
              axis: 'y',
              smooth: true,
              sections: [
                { at: 0, points: [[-5, 0], [5, 0], [5, 6], [-5, 6]] },
                { at: 10, points: [[-7, 0], [7, 0], [7, 9], [-7, 9]] },
                { at: 22, points: [[0, 3]] },
              ],
            },
            position: { x: 0, y: 0, z: 0 },
          },
        ]),
    ],
  ];

  const variants: [string, GlbOptions][] = [
    ['varsayılan (metre, düz)', {}],
    ["units: 'mm'", { units: 'mm' }],
    ['yumuşak normaller', { normals: 'smooth' }],
    ['iskelet (skinned mesh)', { skeleton: true }],
  ];

  for (const [label, make] of scenes) {
    it.each(variants)(`${label} — %s: üçgen kümesi P3D dünya ağıyla aynı (1e-3 mm), sarım dışa`, (_name, opts) => {
      const p = make();
      const expected = worldSoup(p);
      const { soup, built } = roundTrip(p, opts);
      expect(soup.length / 9).toBe(built.triangles);
      expect(soup.length).toBe(expected.length);
      expect(unmatched(soup, expected)).toBe(0);
      const vol = selectParts(p).reduce((s, part) => s + solidVolume(p, part), 0);
      expect(signedVolume(soup)).toBeGreaterThan(0);
      expect(Math.abs(signedVolume(soup) - signedVolume(expected))).toBeLessThan(1e-3 * vol + 1e-3);
    });
  }

  it('cullHidden: okunan üçgenler ayıklanmış GLB kadar ve hepsi dünya ağında var (4 yığılı prizma 112 → 76)', () => {
    const ops: Op[] = [0, 1, 2, 3].map((i) => ({
      op: 'create',
      shape: 'prism',
      name: `p${i}`,
      params: [{ name: 'sides', value: 8 }, { name: 'diameter', value: 20 }, { name: 'height', value: 5 }],
      position: { x: 0, y: 0, z: 2.5 + 5 * i },
    }));
    const p = project(ops);
    for (const opts of [{ cullHidden: true }, { cullHidden: true, skeleton: true }, { cullHidden: true, units: 'mm' as const }]) {
      const { soup, built } = roundTrip(p, opts);
      expect(built.added).toBe(0);
      expect(built.culled).toBe(36);
      expect(soup.length / 9).toBe(76);
      expect(unmatched(soup, worldSoup(p))).toBe(0);
    }
  });

  it('parts süzgeci ve gizli parça: GLB’ye girmeyen parça okunmaz', () => {
    const p = scenes[1][1]();
    const { soup } = roundTrip(p, { parts: ['teker'] });
    expect(unmatched(soup, worldSoup(p, ['teker']))).toBe(0);
    expect(soup.length).toBe(worldSoup(p, ['teker']).length);
  });
});

// ---------------------------------------------------------------------------
// El yapımı GLB'ler

/** JSON + ikili veriden GLB (4 bayt hizalı bölümler). */
function glbOf(json: object, bin?: Uint8Array): ArrayBuffer {
  const pad = (n: number) => n + ((4 - (n % 4)) % 4);
  const j = new TextEncoder().encode(JSON.stringify(json));
  const jl = pad(j.length);
  const bl = bin ? pad(bin.length) : 0;
  const total = 12 + 8 + jl + (bin ? 8 + bl : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  out.fill(0x20, 20 + j.length, 20 + jl);
  if (bin) {
    dv.setUint32(20 + jl, bl, true);
    dv.setUint32(24 + jl, 0x004e4942, true);
    out.set(bin, 28 + jl);
  }
  return out.buffer;
}

/** Bayt dizisi oluşturucu: tipli dizileri 4 bayt hizalı ekler, başlangıç ofsetini döndürür. */
class Bin {
  private parts: Uint8Array[] = [];
  length = 0;
  add(a: ArrayBufferView, align = 4): number {
    const pad = (align - (this.length % align)) % align;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    const at = this.length;
    this.parts.push(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
    this.length += a.byteLength;
    return at;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length + ((4 - (this.length % 4)) % 4));
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

/** Çorbadaki üçgenler (P3D) ve normalleri. */
const tris = (s: Float32Array) =>
  Array.from({ length: s.length / 9 }, (_, t) => {
    const v = [0, 1, 2].map((k) => [s[t * 9 + k * 3], s[t * 9 + k * 3 + 1], s[t * 9 + k * 3 + 2]].map((x) => Math.round(x * 1e4) / 1e4 + 0));
    const e1 = [0, 1, 2].map((c) => v[1][c] - v[0][c]);
    const e2 = [0, 1, 2].map((c) => v[2][c] - v[0][c]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    return { v, nz: Math.sign(Math.round(n[2] * 1e6)) };
  });

/** glTF düzleminde (y = 0) kare: A(0,0,0) B(10,0,0) C(0,0,−10) D(10,0,−10) → P3D z = 0 düzleminde (0..10, 0..10). */
const QUAD = [0, 0, 0, 10, 0, 0, 0, 0, -10, 10, 0, -10];
const MM = { asset: { version: '2.0', extras: { units: 'mm' } } };

describe('GLB okuma: el yapımı dosyalar', () => {
  it('şerit (strip) ve yelpaze (fan) üçgene çevrilir; ayrı bufferView, byteStride, accessor ofseti; çizgi ilkeli atlanır', () => {
    const b = new Bin();
    // Konum + normal iç içe (byteStride 24), indisler ayrı bufferView'larda (u8 şerit, u16 yelpaze; accessor byteOffset 2).
    const inter = new Float32Array(4 * 6);
    for (let i = 0; i < 4; i++) inter.set([...QUAD.slice(i * 3, i * 3 + 3), 0, 1, 0], i * 6);
    const vOff = b.add(inter);
    const sOff = b.add(new Uint8Array([0, 1, 2, 3]));
    const fOff = b.add(new Uint16Array([9999, 0, 1, 3, 2]));
    const lOff = b.add(new Uint8Array([0, 3]));
    const json = {
      ...MM,
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0 }, { mesh: 1, translation: [0, 5, 0] }],
      meshes: [
        { primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, mode: 5 }, { attributes: { POSITION: 0 }, indices: 4, mode: 1 }] },
        { primitives: [{ attributes: { POSITION: 0 }, indices: 3, mode: 6 }] },
      ],
      accessors: [
        { bufferView: 0, byteOffset: 0, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 0, byteOffset: 12, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 1, componentType: 5121, count: 4, type: 'SCALAR' },
        { bufferView: 2, byteOffset: 2, componentType: 5123, count: 4, type: 'SCALAR' },
        { bufferView: 3, componentType: 5121, count: 2, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: vOff, byteLength: inter.byteLength, byteStride: 24 },
        { buffer: 0, byteOffset: sOff, byteLength: 4 },
        { buffer: 0, byteOffset: fOff, byteLength: 10 },
        { buffer: 0, byteOffset: lOff, byteLength: 2 },
      ],
      buffers: [{ byteLength: b.length }],
    };
    const soup = parseMeshFile('el.glb', glbOf(json, b.bytes()));
    const t = tris(soup);
    expect(t.map((x) => x.v)).toEqual([
      // şerit: (A, B, C), (B, D, C)
      [[0, 0, 0], [10, 0, 0], [0, 10, 0]],
      [[10, 0, 0], [10, 10, 0], [0, 10, 0]],
      // yelpaze (düğüm glTF y + 5 → P3D z + 5): (B, D, A), (D, C, A)
      [[10, 0, 5], [10, 10, 5], [0, 0, 5]],
      [[10, 10, 5], [0, 10, 5], [0, 0, 5]],
    ]);
    expect(t.every((x) => x.nz === 1)).toBe(true); // hepsi +Z'ye bakar
  });

  it('düğüm ağacı: TRS ve matrix, ebeveyn çarpımı; negatif ölçekte (ayna) sarım ters çevrilir; birim metre → mm', () => {
    const b = new Bin();
    const pos = new Float32Array([0, 0, 0, 0.01, 0, 0, 0, 0, -0.01]); // metre: A, B, C (P3D'de +Z'ye bakan üçgen)
    const off = b.add(pos);
    const s = Math.SQRT1_2;
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0, 2, 3] }],
      nodes: [
        { translation: [0.1, 0, 0], children: [1] },
        { mesh: 0, rotation: [0, s, 0, s] }, // glTF Y ekseninde +90° (P3D Z ekseninde)
        { mesh: 0, scale: [-1, 1, 1] }, // ayna
        { mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.007, 0, 1] }, // sütun öncelikli öteleme (glTF y = 7 mm)
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteOffset: off, byteLength: pos.byteLength }],
      buffers: [{ byteLength: b.length }],
    };
    const t = tris(parseMeshFile('agac.glb', glbOf(json, b.bytes())));
    expect(t).toHaveLength(3);
    // Döndürülmüş + ötelenmiş: glTF B(10,0,0) → Y'de 90° → (0,0,−10) → +100 x → P3D (100, 10, 0).
    expect(t[0].v).toEqual([[100, 0, 0], [100, 10, 0], [90, 0, 0]]);
    expect(t[0].nz).toBe(1);
    // Ayna: x işaret değiştirir, sarım ters → normal yine +Z.
    expect(t[1].v).toEqual([[0, 0, 0], [0, 10, 0], [-10, 0, 0]]);
    expect(t[1].nz).toBe(1);
    // matrix: glTF y + 7 mm → P3D z + 7.
    expect(t[2].v).toEqual([[0, 0, 7], [10, 0, 7], [0, 10, 7]]);
  });

  it('sahne yoksa kök düğümler; indissiz ilkel; data: URI tampon', () => {
    const pos = new Float32Array(QUAD.slice(0, 9));
    const uri = `data:application/octet-stream;base64,${Buffer.from(pos.buffer).toString('base64')}`;
    const json = {
      ...MM,
      nodes: [{ children: [1], translation: [0, 0, 0] }, { mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36, uri }],
    };
    const t = tris(parseMeshFile('uri.glb', glbOf(json)));
    expect(t.map((x) => x.v)).toEqual([[[0, 0, 0], [10, 0, 0], [0, 10, 0]]]); // çocuk düğüm bir kez
  });

  it('skin: düğümün kendi dönüşümü yok sayılır; köşe = Σ w · (eklem dünyası · ters bağlama) · v (float ve normalize u8 ağırlık)', () => {
    const b = new Bin();
    const pos = new Float32Array(QUAD.slice(0, 9));
    const pOff = b.add(pos);
    const joints = new Uint8Array([0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0]);
    const jOff = b.add(joints);
    const weights = new Uint8Array([128, 127, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]); // A: yarı yarıya, B: eklem 0, C: eklem 1
    const wOff = b.add(weights);
    // Ters bağlama: eklem 0 birim, eklem 1 T(−10, 0, 0) (bağlama pozunda eklem 1 x = 10'daydı).
    const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -10, 0, 0, 1]);
    const iOff = b.add(ibm);
    const json = {
      ...MM,
      scene: 0,
      scenes: [{ nodes: [0, 1, 3] }],
      nodes: [{ name: 'kok', children: [2] }, { name: 'ag', mesh: 0, skin: 0, translation: [1000, 0, 0] }, { name: 'kol', translation: [10, 0, -20] }, { name: 'bos' }],
      skins: [{ joints: [0, 2], inverseBindMatrices: 3 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
        { bufferView: 2, componentType: 5121, normalized: true, count: 3, type: 'VEC4' },
        { bufferView: 3, componentType: 5126, count: 2, type: 'MAT4' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: pOff, byteLength: pos.byteLength },
        { buffer: 0, byteOffset: jOff, byteLength: 12 },
        { buffer: 0, byteOffset: wOff, byteLength: 12 },
        { buffer: 0, byteOffset: iOff, byteLength: ibm.byteLength },
      ],
      buffers: [{ byteLength: b.length }],
    };
    const [t] = tris(parseMeshFile('skin.glb', glbOf(json, b.bytes())));
    // Eklem 1 bağlamadan bu yana glTF (0, 0, −20) kaydı (P3D y + 20): C tam, A ağırlığının 127/255'i kadar kayar; düğüm çevirisi (1000) yok.
    const ay = Math.round(((20 * 127) / 255) * 1e4) / 1e4;
    expect(t.v[0][0]).toBe(0);
    expect(t.v[0][1]).toBeCloseTo(ay, 3);
    expect(t.v[1]).toEqual([10, 0, 0]);
    expect(t.v[2]).toEqual([0, 30, 0]);
  });

  it('hatalar: bozuk imza, sürüm, Draco/meshopt/nicemleme, .gltf, üçgensiz, seyrek erişimci, float olmayan konum, taşan erişimci', () => {
    const err = (name: string, data: ArrayBuffer) => {
      try {
        parseMeshFile(name, data);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error('hata bekleniyordu');
    };
    expect(err('x.glb', new Uint8Array(40).buffer)).toContain('GLB değil');
    const v1 = new Uint8Array(glbOf(MM));
    new DataView(v1.buffer).setUint32(4, 1, true);
    expect(err('x.glb', v1.buffer)).toContain('GLB sürümü 1 desteklenmiyor');
    expect(err('x.glb', glbOf({ ...MM, extensionsRequired: ['KHR_draco_mesh_compression'] }))).toContain('Draco sıkıştırması (KHR_draco_mesh_compression) kullanıyor; desteklenmiyor');
    expect(err('x.glb', glbOf({ ...MM, extensionsRequired: ['EXT_meshopt_compression', 'KHR_mesh_quantization'] }))).toMatch(/meshopt.*nicemlenmiş/);
    expect(err('x.gltf', glbOf(MM))).toContain('glTF metin biçimi (.gltf) desteklenmiyor');
    expect(err('x.glb', glbOf({ ...MM, nodes: [] }))).toContain('GLB içinde üçgen bulunamadı');

    const b = new Bin();
    const off = b.add(new Float32Array(QUAD.slice(0, 9)));
    const base = (accessor: object) => ({
      ...MM,
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [accessor],
      bufferViews: [{ buffer: 0, byteOffset: off, byteLength: 36 }],
      buffers: [{ byteLength: b.length }],
    });
    const bin = b.bytes();
    expect(err('x.glb', glbOf(base({ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', sparse: { count: 1 } }), bin))).toContain('seyrek (sparse)');
    expect(err('x.glb', glbOf(base({ bufferView: 0, componentType: 5123, normalized: true, count: 3, type: 'VEC3' }), bin))).toContain('float VEC3 değil');
    expect(err('x.glb', glbOf(base({ bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }), bin))).toContain('GLB bozuk');
    // Yalnızca çizgi ilkeli: üçgen yok.
    const lines = base({ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' });
    lines.meshes[0].primitives[0] = { attributes: { POSITION: 0 }, mode: 1 } as never;
    expect(err('x.glb', glbOf(lines, bin))).toContain('üçgen bulunamadı');
  });

  it('sıkıştırma yalnızca extensionsUsed, ilkel ya da bufferView düzeyinde de reddedilir; şişirilmiş count ayırmadan önce hata', () => {
    const { json, bin } = triangleGlb();
    expect(glbError(glbOf({ ...json, extensionsUsed: ['KHR_draco_mesh_compression'] }, bin))).toContain('Draco sıkıştırması (KHR_draco_mesh_compression) kullanıyor; desteklenmiyor');
    const prim = structuredClone(json);
    prim.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } };
    expect(glbError(glbOf(prim, bin))).toContain('Draco sıkıştırması');
    const view = structuredClone(json);
    view.bufferViews[0].extensions = { EXT_meshopt_compression: { buffer: 0, byteLength: 36, byteStride: 12, count: 3, mode: 'ATTRIBUTES' } };
    expect(glbError(glbOf(view, bin))).toContain('meshopt sıkıştırması (EXT_meshopt_compression)');
    // Yalnızca normal nicemleme bildirilmiş (zorunlu değil), konum float: okunur.
    expect(parseMeshFile('n.glb', glbOf({ ...json, extensionsUsed: ['KHR_mesh_quantization'] }, bin)).length).toBe(9);
    // bufferView'sız şişirilmiş erişimci ve tampondan uzun erişimci: ayırmadan hata.
    const huge = structuredClone(json);
    huge.accessors[0] = { componentType: 5126, count: 1e9, type: 'VEC3' };
    expect(glbError(glbOf(huge, bin))).toContain('GLB bozuk: konum (POSITION) erişimcisi çok büyük');
    const long = structuredClone(json);
    long.accessors[0].count = 2e7;
    expect(glbError(glbOf(long, bin))).toContain('tampon dışına taşıyor');
    // Harici tampon: uri kısaltılır.
    const ext = structuredClone(json);
    ext.buffers[0] = { byteLength: 36, uri: `${'çok-uzun-klasör/'.repeat(20)}veri.bin` } as never;
    const msg = glbError(glbOf(ext));
    expect(msg).toContain('harici tampon dosyası');
    expect(msg.length).toBeLessThan(200);
  });

  it('düğüm ağacında döngü hata verir (sonsuz özyineleme yok)', () => {
    const { json, bin } = triangleGlb();
    const cyc = { ...json, scenes: [{ nodes: [0] }], nodes: [{ children: [1] }, { mesh: 0, children: [0] }] };
    expect(glbError(glbOf(cyc, bin))).toContain('düğüm ağacında döngü var');
  });

  it('skin: aynalı eklem sarımı çevirir; ters bağlama matrisi eklemlerden azsa ya da eklem indisi dışarıdaysa hata', () => {
    const skinned = (o: { joints: number[]; ibmCount?: number; jointIndex?: number; scale?: number[] }) => {
      const b = new Bin();
      const pOff = b.add(new Float32Array(QUAD.slice(0, 9)));
      const jOff = b.add(new Uint8Array(Array.from({ length: 3 }, () => [o.jointIndex ?? 0, 0, 0, 0]).flat()));
      const wOff = b.add(new Float32Array(Array.from({ length: 3 }, () => [1, 0, 0, 0]).flat()));
      const ibmCount = o.ibmCount ?? o.joints.length;
      const iOff = b.add(new Float32Array(Array.from({ length: ibmCount }, () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).flat()));
      return glbOf(
        {
          ...MM,
          scene: 0,
          scenes: [{ nodes: [0, 1, 2] }],
          nodes: [{ scale: o.scale ?? [1, 1, 1] }, { mesh: 0, skin: 0 }, { translation: [5, 0, 0] }],
          skins: [{ joints: o.joints, inverseBindMatrices: 3 }],
          meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
          accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
            { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
            { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
            { bufferView: 3, componentType: 5126, count: ibmCount, type: 'MAT4' },
          ],
          bufferViews: [
            { buffer: 0, byteOffset: pOff, byteLength: 36 },
            { buffer: 0, byteOffset: jOff, byteLength: 12 },
            { buffer: 0, byteOffset: wOff, byteLength: 48 },
            { buffer: 0, byteOffset: iOff, byteLength: 64 * ibmCount },
          ],
          buffers: [{ byteLength: b.length }],
        },
        b.bytes(),
      );
    };
    // Eklem 0 x'te aynalı (ölçek −1): köşeler yansır, sarım ters çevrilir → yüz yine +Z'ye bakar.
    const [t] = tris(parseMeshFile('ayna.glb', skinned({ joints: [0, 2], scale: [-1, 1, 1] })));
    expect(t.v).toEqual([[0, 0, 0], [0, 10, 0], [-10, 0, 0]]);
    expect(t.nz).toBe(1);
    expect(glbError(skinned({ joints: [0, 2], ibmCount: 1 }))).toContain('ters bağlama matrisi sayısı (1) eklem sayısından (2) az');
    expect(glbError(skinned({ joints: [0, 2], jointIndex: 2 }))).toContain('eklem indisi (2) iskeletin dışında (2 eklem)');
  });

  it('EXT_mesh_gpu_instancing: her örnek ayrı kopya (düğüm dünyası · örnek T·R·S); ayna örneğinde sarım çevrilir', () => {
    const { json } = triangleGlb();
    const b = new Bin();
    const pOff = b.add(new Float32Array(QUAD.slice(0, 9)));
    const tOff = b.add(new Float32Array([0, 0, 0, 0, 0, -20, 30, 0, 0])); // glTF z −20 → P3D y +20
    const s = Math.SQRT1_2;
    const rOff = b.add(new Float32Array([0, 0, 0, 1, 0, s, 0, s, 0, 0, 0, 1])); // ikinci örnek glTF Y'de +90°
    const sOff = b.add(new Float32Array([1, 1, 1, 1, 1, 1, -1, 1, 1])); // üçüncü örnek aynalı
    const inst = {
      ...json,
      extensionsUsed: ['EXT_mesh_gpu_instancing'],
      nodes: [{ mesh: 0, translation: [0, 7, 0], extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1, ROTATION: 2, SCALE: 3 } } } }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
        { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: pOff, byteLength: 36 },
        { buffer: 0, byteOffset: tOff, byteLength: 36 },
        { buffer: 0, byteOffset: rOff, byteLength: 48 },
        { buffer: 0, byteOffset: sOff, byteLength: 36 },
      ],
      buffers: [{ byteLength: b.length }],
    };
    const t = tris(parseMeshFile('ornek.glb', glbOf(inst, b.bytes())));
    expect(t.map((x) => x.v)).toEqual([
      [[0, 0, 7], [10, 0, 7], [0, 10, 7]],
      // Y'de 90°: B(10,0,0) → glTF (0,0,−10) → P3D (0,10,·); C(0,0,−10) → glTF (−10,0,0); + örnek (0,20) + düğüm z 7
      [[0, 20, 7], [0, 30, 7], [-10, 20, 7]],
      // Aynalı + x 30: B → (20, 0); sarım ters
      [[30, 0, 7], [30, 10, 7], [20, 0, 7]],
    ]);
    expect(t.every((x) => x.nz === 1)).toBe(true);
    // Sayıları farklı örnek erişimcileri hata.
    const bad = structuredClone(inst);
    bad.accessors[3].count = 2;
    expect(glbError(glbOf(bad, b.bytes()))).toContain('örnek (instancing) erişimcilerinin sayıları farklı');
  });
});

/** Tek üçgenlik GLB (mm): A(0,0,0) B(10,0,0) C(glTF 0,0,−10). Testler JSON'u değiştirip yeniden paketler. */
function triangleGlb() {
  const b = new Bin();
  const off = b.add(new Float32Array(QUAD.slice(0, 9)));
  const json = {
    ...MM,
    nodes: [{ mesh: 0 }] as Record<string, unknown>[],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } } as Record<string, unknown>] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }] as Record<string, unknown>[],
    bufferViews: [{ buffer: 0, byteOffset: off, byteLength: 36 }] as Record<string, unknown>[],
    buffers: [{ byteLength: b.length }] as Record<string, unknown>[],
  };
  return { json, bin: b.bytes() };
}

function glbError(data: ArrayBuffer): string {
  try {
    parseMeshFile('x.glb', data);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('hata bekleniyordu');
}

// ---------------------------------------------------------------------------

describe('ağ dosyasından proje', () => {
  it('varsayılan üçgen sınırı: GLB 1 000 000 (pratikte sadeleştirme yok), diğerleri 60 000', () => {
    expect(defaultMaxTris('glb')).toBe(GLB_MAX_TRIS);
    expect(GLB_MAX_TRIS).toBe(1_000_000);
    for (const f of ['stl', 'obj', '3mf', null] as const) expect(defaultMaxTris(f)).toBe(60000);
  });

  it('projectFromMesh: tek ağ parçası dosyadaki yerinde; tabla ağı sığdıracak kadar büyür (en fazla 20 m)', async () => {
    const src = project([
      { op: 'create', shape: 'box', name: 'kiriş', params: [{ name: 'width', value: 100 }, { name: 'depth', value: 1000 }, { name: 'height', value: 100 }], position: { x: 50, y: 500, z: 50 } },
    ]);
    const soup = parseMeshFile('k.glb', toBuffer(glbBuild(src, {}).data));
    const imp = await meshAssetFromSoup('kiriş', soup, defaultMaxTris('glb'));
    const p = projectFromMesh('kiriş', imp);
    expect(p.name).toBe('kiriş');
    expect(p.parts).toHaveLength(1);
    expect(p.parts[0]).toMatchObject({ name: 'kiriş', shape: 'mesh', position: { x: 50, y: 500, z: 50 } });
    expect(p.settings.bedX).toBe(220); // 0..100: sığıyor
    expect(p.settings.bedY).toBe(2100); // 0..1000 → 2 × 1000 × 1,05
    const far = projectFromMesh('uzak', { ...imp, center: { x: 0, y: 30000, z: 50 } });
    expect(far.settings.bedY).toBe(20000);
  });

  it('loadMeshFileProject: src + damga + sınır p3d import ile aynı; kaydedip açınca kaynaktan aynı ağ yeniden üretilir', async () => {
    const src = project([
      { op: 'create', shape: 'box', name: 'a', params: [{ name: 'width', value: 20 }, { name: 'depth', value: 10 }, { name: 'height', value: 4 }], position: { x: 10, y: 5, z: 2 } },
      { op: 'create', shape: 'cylinder', name: 'b', params: [{ name: 'diameter', value: 8 }, { name: 'height', value: 8 }], position: { x: -20, y: 0, z: 4 }, rotation: { x: 0, y: 30, z: 0 } },
    ]);
    const file = path.join(dir, 'parca.glb');
    writeFileSync(file, glbBuild(src, {}).data);
    const { project: p, mesh } = await loadMeshFileProject(file);
    const part = p.parts[0];
    expect(part.name).toBe('parca');
    expect(part.geom).toMatchObject({ kind: 'mesh', src: file, maxTris: 1_000_000 });
    expect(part.geom?.kind === 'mesh' && part.geom.srcHash).toMatch(/^[0-9a-f]{16}$/);
    const world = worldSoup(src);
    expect(mesh.asset.triangles).toBe(mesh.originalTriangles); // sadeleştirilmedi
    expect(mesh.asset.triangles).toBe(world.length / 9);
    // Parça dosyadaki yerinde: konum = dünya ağının kutu merkezi (1e-3 mm).
    const box = new THREE.Box3().setFromArray(world);
    const c = box.getCenter(new THREE.Vector3());
    expect(Math.abs(part.position.x - c.x) + Math.abs(part.position.y - c.y) + Math.abs(part.position.z - c.z)).toBeLessThan(2e-3);
    expect(Math.abs(solidVolume(p, part) - signedVolume(world))).toBeLessThan(1e-4 * signedVolume(world));

    const saved = path.join(dir, 'parca.p3d.json');
    expect(saveProjectFile(p, saved)).toMatchObject({ embedded: 0, referenced: 1 });
    const back = await loadProjectFile(saved);
    const g = back.parts[0].geom!;
    expect(g).toMatchObject({ kind: 'mesh', src: file, maxTris: 1_000_000 });
    expect(getAsset(g.kind === 'mesh' ? g.asset : '')!.triangles).toBe(mesh.asset.triangles);
  });
});
