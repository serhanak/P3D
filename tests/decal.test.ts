// Düz kaplama (`decal`, Boltrush isteği #19): kalınlıksız, yüzü yerel +Z'ye bakan açık ağ. Üçgen sayısı ve yön, T-kavşağı,
// yüzeye oturtma, ayna, GLB `doubleSided`, baskıda atlanma, hacim 0, check (z-fighting kuralı), gizli yüz ayıklamasıyla
// etkileşim, dosya, delik rolü, Claude şeması; Boltrush plakası ve damalı bayrağı.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESPONSE_SCHEMA, normalizeLlmOp, type DecalGeom, type Op, type Pt2 } from '../shared/ops';
import { checkProject } from '../src/check';
import { initCsg } from '../src/csg';
import { applyOps, partBox, partVolume, sceneSummary } from '../src/engine';
import { exportFile } from '../src/files';
import { describeGeom, sanitizeGeom } from '../src/geom';
import { buildGlb, glbBuild } from '../src/gltf';
import { buildObj, mergedMesh, parseProject, projectToJson, worldMesh } from '../src/io';
import { solidVolume } from '../src/model';
import { newProject, type Part, type Project } from '../src/types';

let dir: string;
beforeAll(async () => {
  await initCsg();
  dir = mkdtempSync(path.join(tmpdir(), 'p3d-decal-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function project(ops: Op[], seg = 24): Project {
  const p = newProject('kaplama');
  p.settings.resolution = seg;
  const res = applyOps(p, ops, null);
  expect(res.errors).toEqual([]);
  return p;
}

const byName = (p: Project, name: string): Part => {
  const part = p.parts.find((x) => x.name === name);
  if (!part) throw new Error(`parça yok: ${name}`);
  return part;
};

type At = { x: number; y: number; z: number };
const at = (x: number, y: number, z: number): At => ({ x, y, z });
const rect = (w: number, h: number): Pt2[] => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
const decal = (name: string, geom: Omit<DecalGeom, 'kind'>, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'decal',
  name,
  geom: { kind: 'decal', ...geom },
  position: at(0, 0, 0),
  ...extra,
});
const box = (name: string, w: number, d: number, h: number, position: At, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'box',
  name,
  params: [
    { name: 'width', value: w },
    { name: 'depth', value: d },
    { name: 'height', value: h },
  ],
  position,
  ...extra,
});

/** Üçgenlerin birim normalleri ve alan toplamı (dünya). */
function faces(p: Project, name: string) {
  const m = worldMesh(p, byName(p, name));
  const normals: [number, number, number][] = [];
  let area = 0;
  for (let t = 0; t < m.tris.length; t += 3) {
    const [a, b, c] = [m.tris[t] * 3, m.tris[t + 1] * 3, m.tris[t + 2] * 3];
    const e1 = [m.pos[b] - m.pos[a], m.pos[b + 1] - m.pos[a + 1], m.pos[b + 2] - m.pos[a + 2]];
    const e2 = [m.pos[c] - m.pos[a], m.pos[c + 1] - m.pos[a + 1], m.pos[c + 2] - m.pos[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    area += l / 2;
    normals.push([n[0] / l, n[1] / l, n[2] / l]);
  }
  return { m, normals, area, tris: m.tris.length / 3 };
}

const expectNormal = (ns: [number, number, number][], n: [number, number, number]) => {
  for (const v of ns) for (let k = 0; k < 3; k++) expect(v[k]).toBeCloseTo(n[k], 6);
};

/** GLB JSON bölümü. */
function glbJson(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
}

describe('kaplama (decal): ağ', () => {
  it('üçgen sayısı, yüzü +Z, z = lift; dönüş yönünden bağımsız; ölçek yalnızca XY', () => {
    const L: Pt2[] = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 25], [0, 25]];
    const p = project([
      decal('dikdörtgen', { profile: rect(40, 20) }),
      decal('L', { profile: L }, { position: at(100, 0, 0) }),
      decal('L ters', { profile: [...L].reverse(), lift: 2 }, { position: at(200, 0, 0) }),
      decal('çerçeve', { profile: rect(40, 40), holes: [rect(20, 20)] }, { position: at(300, 0, 0) }),
      decal('büyük', { profile: rect(40, 20) }, { position: at(400, 0, 0), params: [{ name: 'scale', value: 2 }] }),
    ]);
    const cases: [string, number, number, number][] = [
      ['dikdörtgen', 2, 800, 0.5],
      ['L', 4, 30 * 10 + 10 * 15, 0.5],
      ['L ters', 4, 450, 2],
      ['çerçeve', 8, 1600 - 400, 0.5],
      ['büyük', 2, 3200, 0.5],
    ];
    for (const [name, tris, area, z] of cases) {
      const f = faces(p, name);
      expect(f.tris, name).toBe(tris);
      expect(f.area, name).toBeCloseTo(area, 3);
      expectNormal(f.normals, [0, 0, 1]);
      for (let i = 2; i < f.m.pos.length; i += 3) expect(f.m.pos[i], name).toBeCloseTo(z, 6);
    }
    expect(partBox(byName(p, 'büyük'), 24).max.x - partBox(byName(p, 'büyük'), 24).min.x).toBeCloseTo(80, 6);
  });

  it('doğrusal köşeler ve hizalı boşluklar: T-kavşağı kalmaz, sıfır alanlı üçgen yok', () => {
    // Aynı hizada iki / üç boşluk (earcut doğrusal köşeyi atlar; sweep/extrude T-kavşağı testleriyle aynı profiller) ve alt
    // kenarda doğrusal ara noktalar.
    const twoHoles: Pt2[][] = [[[-15, 2], [-5, 2], [-5, 8], [-15, 8]], [[5, 2], [15, 2], [15, 8], [5, 8]]];
    const threeHoles: Pt2[][] = [[[-15, 5], [-10, 5], [-10, 15], [-15, 15]], [[-3, 5], [3, 5], [3, 15], [-3, 15]], [[10, 5], [15, 5], [15, 15], [10, 15]]];
    const cases: [Pt2[], Pt2[][], number, number][] = [
      [[[-20, 0], [20, 0], [20, 10], [-20, 10]], twoHoles, 400 - 120, 100 + 2 * 32],
      [[[-20, 0], [20, 0], [20, 20], [-20, 20]], threeHoles, 800 - 160, 120 + 30 + 32 + 30],
      [[[-20, 0], [-5, 0], [5, 0], [20, 0], [20, 10], [-20, 10]], twoHoles, 280, 164],
    ];
    const p = project(cases.map(([profile, holes], i) => decal(`ızgara${i}`, { profile, holes }, { position: at(100 * i, 0, 0) })));
    cases.forEach(([, , area, perimeter], i) => {
      const { m, area: a } = faces(p, `ızgara${i}`);
      expect(a).toBeCloseTo(area, 6);
      const P = (v: number) => [m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]];
      const directed = new Map<string, number>();
      const used = new Set<number>();
      for (let t = 0; t < m.tris.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          used.add(m.tris[t + k]);
          const key = `${m.tris[t + k]}>${m.tris[t + ((k + 1) % 3)]}`;
          directed.set(key, (directed.get(key) ?? 0) + 1);
        }
      }
      expect([...directed.values()].every((n) => n === 1)).toBe(true);
      // Eşsiz kenarlar yalnızca dış çevre ve boşluk sınırları: toplam boyları çevreye eşit, üstlerinde kullanılan köşe yok.
      const open = [...directed.keys()].filter((k) => !directed.has(k.split('>').reverse().join('>'))).map((k) => k.split('>').map(Number));
      let len = 0;
      for (const [u, v] of open) {
        const [a0, b0] = [P(u), P(v)];
        const ab = [b0[0] - a0[0], b0[1] - a0[1]];
        const L = Math.hypot(ab[0], ab[1]);
        len += L;
        for (const w of used) {
          if (w === u || w === v) continue;
          const q = P(w);
          const s = ((q[0] - a0[0]) * ab[0] + (q[1] - a0[1]) * ab[1]) / (L * L);
          const off = Math.abs((q[0] - a0[0]) * ab[1] - (q[1] - a0[1]) * ab[0]) / L;
          expect(s > 1e-6 && s < 1 - 1e-6 && off < 1e-6, `ızgara${i}: köşe ${w} kenar ${u}→${v} üstünde (T-kavşağı)`).toBe(false);
        }
      }
      expect(len).toBeCloseTo(perimeter, 6);
    });
    expect(checkProject(p, { profile: 'game' })).toEqual([]); // bozuk üçgen yok
  });

  it('doğrulama: lift aralığı (0 / null = varsayılan), boşluk profile değemez; özet metni', () => {
    const g = (x: Record<string, unknown>) => sanitizeGeom('decal', { kind: 'decal', profile: rect(10, 10), ...x });
    expect(g({ lift: 0 })).toEqual({ kind: 'decal', profile: rect(10, 10) });
    expect(g({ lift: null, double: null, holes: null })).toEqual({ kind: 'decal', profile: rect(10, 10) });
    expect(g({ lift: 0.5, double: false })).toEqual({ kind: 'decal', profile: rect(10, 10) });
    expect(g({ lift: 1.25, double: true })).toEqual({ kind: 'decal', profile: rect(10, 10), double: true, lift: 1.25 });
    expect(() => g({ lift: 0.001 })).toThrow("Kaplama 'lift' (yüzeyden uzaklık) 0,01–100 mm olmalı");
    expect(() => g({ lift: -1 })).toThrow('0,01–100 mm');
    expect(() => g({ lift: 200 })).toThrow('0,01–100 mm');
    expect(() => g({ holes: [[[-5, -2], [0, -2], [0, 2], [-5, 2]]] })).toThrow('Kaplama boşluğu 1 profilin kenarına değiyor');
    expect(() => sanitizeGeom('decal', { kind: 'decal', profile: [[0, 0], [1, 1], [2, 2]] })).toThrow('Kaplama profili: alanı sıfır');
    expect(describeGeom({ kind: 'decal', profile: rect(10, 10), holes: [rect(2, 2)], double: true, lift: 2 })).toBe('profil 4 nokta, 1 boşluk, iki yüzlü, yüzeyden 2 mm');
    expect(describeGeom({ kind: 'decal', profile: rect(10, 10) })).toBe('profil 4 nokta, yüzeyden 0,5 mm');
  });

  it('hacim 0; birleşime ve baskı toplamına girmez; delik onu kesmez', () => {
    const p = project([
      box('kutu', 40, 40, 10, at(0, 0, 5)),
      decal('etiket', { profile: rect(20, 20) }, { position: at(0, 0, 10) }),
      { op: 'create', shape: 'cylinder', name: 'delik', role: 'hole', params: [{ name: 'diameter', value: 6 }, { name: 'height', value: 30 }], position: at(0, 0, 5) },
    ]);
    const e = byName(p, 'etiket');
    expect(solidVolume(p, e)).toBe(0);
    expect(partVolume(e)).toBe(0);
    expect(faces(p, 'etiket').tris).toBe(2); // delik kaplamayı kesmez
    expect(solidVolume(p, byName(p, 'kutu'))).toBeLessThan(40 * 40 * 10 - 200); // kutuyu keser
    const u = mergedMesh(p, [e, byName(p, 'kutu')]);
    const solo = mergedMesh(p, [byName(p, 'kutu')]);
    expect(u.tris.length).toBe(solo.tris.length);
    // Renk kaplamalar süzüldükten sonraki ilk parçadan; yalnız kaplama ya da boş liste: boş ağ (hata değil, belirsiz değil)
    applyOps(p, [{ op: 'update', part: 'etiket', color: '#ff0000' }, { op: 'update', part: 'kutu', color: '#0000ff' }], null);
    expect(mergedMesh(p, [e, byName(p, 'kutu')]).color).toBe('#0000ff');
    for (const list of [[e], []]) {
      const m = mergedMesh(p, list);
      expect([m.pos.length, m.tris.length, m.color]).toEqual([0, 0, '#cccccc']);
    }
  });
});

describe('kaplama: yerleştirme ve ayna', () => {
  // Boltrush plakası: 0,3 × 0,11 m (mm'de 300 × 110), kaputun ön yüzüne.
  const plate = (): Project =>
    project([
      box('kaput', 500, 300, 200, at(0, 0, 100)),
      decal('plaka', { profile: [[-150, -55], [150, -55], [150, 55], [-130, 55], [-150, 35]] }, { color: '#f2c94c' }),
      { op: 'place_on_surface', part: 'plaka', target: 'kaput', near: at(20, -400, 120) },
    ]);

  it('place_on_surface: kutunun ön yüzüne, lift kadar dışarıda, yüzü −Y', () => {
    const p = plate();
    const pl = byName(p, 'plaka');
    expect(pl.rotation).toEqual({ x: 90, y: 0, z: 0 });
    const f = faces(p, 'plaka');
    expectNormal(f.normals, [0, -1, 0]);
    for (let i = 1; i < f.m.pos.length; i += 3) expect(f.m.pos[i]).toBeCloseTo(-150.5, 4);
    // Yerel y yukarı (dünya z): plaka 120 yüksekliğinde ortalı
    const b = partBox(pl, 24);
    expect([b.min.x, b.max.x, b.min.z, b.max.z]).toEqual([-130, 170, 65, 175].map((v) => expect.closeTo(v, 4)));
  });

  it('place_on: yüzü yukarı kaplama hedefin üstünde lift kadar yukarıda (yüzeyle çakışmaz)', () => {
    const p = project([box('masa', 100, 60, 20, at(0, 0, 10)), decal('örtü', { profile: rect(40, 20), lift: 0.3 }), { op: 'place_on', part: 'örtü', target: 'masa' }]);
    const b = partBox(byName(p, 'örtü'), 24);
    expect(b.min.z).toBeCloseTo(20.3, 6);
    expect(b.max.z).toBeCloseTo(20.3, 6);
    expect(checkProject(p)).toEqual([]);
  });

  it('place_on: aşağı bakan kaplama hata verir (hedefin içine gömülmez); oluştururken parça eklenmez', () => {
    const p = project([box('k', 40, 20, 10, at(0, 0, 5)), decal('d', { profile: rect(10, 10) }, { rotation: at(180, 0, 0) })]);
    const before = structuredClone(byName(p, 'd'));
    const r = applyOps(p, [{ op: 'place_on', part: 'd', target: 'k' }], null);
    expect(r.errors).toEqual(["'d': aşağı bakan kaplama bir yüzeyin üstüne konamaz; place_on_surface kullanın ya da döndürün."]);
    expect(byName(p, 'd')).toEqual(before);
    const c = applyOps(p, [decal('e', { profile: rect(10, 10) }, { rotation: at(180, 0, 0), place_on: 'k', position: undefined })], null);
    expect(c.errors).toEqual(["'e': aşağı bakan kaplama bir yüzeyin üstüne konamaz; place_on_surface kullanın ya da döndürün."]);
    expect(p.parts.map((x) => x.name)).toEqual(['k', 'd']);
    // Yana bakan kaplama: alt kenarı hedefin üstüne (lift payı yok)
    applyOps(p, [decal('yan', { profile: rect(10, 10) }, { rotation: at(90, 0, 0) }), { op: 'place_on', part: 'yan', target: 'k' }], null);
    expect(partBox(byName(p, 'yan'), 24).min.z).toBeCloseTo(10, 6);
  });

  it('ayna: y düzleminde kopya +Y\'ye bakar (sarım düzelir); x düzleminde profil yansır, yön aynı; aynanın aynası özgün', () => {
    const p = plate();
    let r = applyOps(p, [{ op: 'mirror', part: 'plaka', plane: 'y', at: 0, name: 'arka plaka' }], null);
    expect(r.errors).toEqual([]);
    const back = faces(p, 'arka plaka');
    expectNormal(back.normals, [0, 1, 0]);
    for (let i = 1; i < back.m.pos.length; i += 3) expect(back.m.pos[i]).toBeCloseTo(150.5, 4);
    // Köşe kümesi özgünün y aynası
    const front = faces(p, 'plaka');
    const key = (m: { pos: Float32Array }, flipY: boolean) => {
      const out: string[] = [];
      for (let i = 0; i < m.pos.length; i += 3) out.push([m.pos[i], flipY ? -m.pos[i + 1] : m.pos[i + 1], m.pos[i + 2]].map((v) => v.toFixed(3)).join(','));
      return out.sort();
    };
    expect(key(back.m, true)).toEqual(key(front.m, false));
    r = applyOps(p, [{ op: 'mirror', part: 'plaka', plane: 'x', at: 0, name: 'sol plaka' }], null);
    expect(r.errors).toEqual([]);
    const left = faces(p, 'sol plaka');
    expectNormal(left.normals, [0, -1, 0]);
    const keyX = (m: { pos: Float32Array }, flip: boolean) => {
      const out: string[] = [];
      for (let i = 0; i < m.pos.length; i += 3) out.push([flip ? -m.pos[i] : m.pos[i], m.pos[i + 1], m.pos[i + 2]].map((v) => v.toFixed(3)).join(','));
      return out.sort();
    };
    expect(keyX(left.m, true)).toEqual(keyX(front.m, false));
    applyOps(p, [{ op: 'mirror', part: 'sol plaka', plane: 'x', at: 0, name: 'geri' }], null);
    expect(byName(p, 'geri').geom).toEqual(byName(p, 'plaka').geom);
  });
});

describe('kaplama: dışa aktarım', () => {
  it('GLB: iki yüzlü malzeme doubleSided; malzeme renk + saydamlık + iki yüzlülükle ayrışır; üçgen çoğaltılmaz', () => {
    const p = project([
      box('kutu', 40, 40, 10, at(0, 0, 5), { color: '#ff0000' }),
      decal('tek', { profile: rect(10, 10) }, { position: at(0, 0, 10), color: '#ff0000' }),
      decal('çift', { profile: rect(10, 10), double: true }, { position: at(100, 0, 0), color: '#ff0000' }),
      decal('çift2', { profile: rect(10, 10), double: true }, { position: at(120, 0, 0), color: '#ff0000' }),
    ]);
    const j = glbJson(buildGlb(p));
    expect(j.materials.map((m: { name: string; doubleSided?: boolean }) => [m.name, m.doubleSided ?? false])).toEqual([
      ['P3D_ff0000', false],
      ['P3D_ff0000_ds', true],
    ]);
    expect(j.meshes.map((m: { primitives: { material: number }[] }) => m.primitives[0].material)).toEqual([0, 0, 1, 1]);
    const tris = j.meshes.map((m: { primitives: { indices: number }[] }) => j.accessors[m.primitives[0].indices].count / 3);
    expect(tris).toEqual([12, 2, 2, 2]);
    // İskelette de malzemeye göre ayrışır
    const s = glbJson(buildGlb(p, { skeleton: true }));
    expect(s.meshes[0].primitives).toHaveLength(2);
    expect(s.materials[1].doubleSided).toBe(true);
  });

  it('STL / 3MF: kaplama atlanır ve söylenir; yalnız kaplama varsa hata; OBJ ve GLB\'ye girer', async () => {
    const p = project([box('kutu', 40, 40, 10, at(0, 0, 5)), decal('plaka', { profile: rect(20, 10) }, { position: at(0, 0, 10) })]);
    const stl = await exportFile(p, path.join(dir, 'a.stl'));
    expect(stl.parts).toBe(1);
    expect(stl.bytes).toBe(84 + 50 * 12);
    expect(stl.warnings).toEqual(["1 kaplama atlandı ('plaka'): kalınlıksızdır, baskıya (STL) girmez; GLB ve OBJ'ye girer."]);
    const mf = await exportFile(p, path.join(dir, 'a.3mf'));
    expect(mf.warnings?.[0]).toContain('baskıya (3MF) girmez');
    await expect(exportFile(p, path.join(dir, 'b.stl'), { parts: ['plaka'] })).rejects.toThrow("Dışa aktarılacak katı parça yok: kaplamalar ('plaka') kalınlıksızdır, STL'e girmez");
    const obj = await exportFile(p, path.join(dir, 'a.obj'));
    expect([obj.parts, obj.warnings]).toEqual([2, undefined]);
    expect(buildObj(p.parts, p, null).obj).toContain('o plaka');
    const glb = await exportFile(p, path.join(dir, 'a.glb'));
    expect(glb.parts).toBe(2);
  });

  it('dosya gidiş-dönüşü; sahne özetinde tam geom; delik rolü dosyada kaldırılır', () => {
    const p = project([
      decal('a', { profile: rect(20, 20), holes: [rect(5, 5)], double: true, lift: 2 }),
      decal('b', { profile: rect(10, 10), lift: 0.5 }, { position: at(50, 0, 0), role: 'reference' }),
    ]);
    expect(byName(p, 'b').geom).toEqual({ kind: 'decal', profile: rect(10, 10) }); // varsayılan lift yazılmaz
    expect(parseProject(JSON.parse(projectToJson(p)))).toEqual(p);
    expect(sceneSummary(p, null).parts[0].geom).toEqual(byName(p, 'a').geom);
    const raw = JSON.parse(projectToJson(p));
    raw.parts[0].role = 'hole';
    raw.parts[0].cuts = ['b'];
    const warnings: string[] = [];
    const back = parseProject(raw, [], warnings);
    expect(back.parts[0].role).toBeUndefined();
    expect(back.parts[0].cuts).toBeUndefined();
    expect(warnings).toEqual(["'a': kaplama (decal) delik olamaz; rolü kaldırıldı (katı)."]);
  });

  it('delik rolü verilemez (create / update); referans olabilir', () => {
    const p = newProject();
    let r = applyOps(p, [decal('d', { profile: rect(10, 10) }, { role: 'hole' })], null);
    expect(r.errors).toEqual(["'d': Kaplama (decal) delik olamaz: kalınlığı yok, hiçbir şeyi kesemez. Oyuk için kapalı bir şekil (ör. extrude) delik yapın; kaplama katı ya da referans olabilir."]);
    expect(p.parts).toHaveLength(0);
    r = applyOps(p, [decal('d', { profile: rect(10, 10) })], null);
    r = applyOps(p, [{ op: 'update', part: 'd', role: 'hole', color: '#00ff00' }], null);
    expect(r.errors[0]).toMatch(/^'d': Kaplama \(decal\) delik olamaz/);
    expect(p.parts[0].role).toBeUndefined();
    expect(p.parts[0].color).not.toBe('#00ff00'); // hatalı işlem parçayı hiç değiştirmez
    r = applyOps(p, [{ op: 'update', part: 'd', role: 'reference' }], null);
    expect([r.errors, p.parts[0].role]).toEqual([[], 'reference']);
  });

  it('Claude şeması: decal anyOf içinde, tüm alanlar zorunlu; null doldurmaları temiz geom verir', () => {
    const items = RESPONSE_SCHEMA.properties.operations.items.anyOf as unknown as { properties: Record<string, { anyOf?: { properties?: Record<string, unknown>; required?: string[] }[]; enum?: string[] }> }[];
    const create = items.find((x) => (x.properties.op as unknown as { const: string }).const === 'create')!;
    expect(create.properties.shape.enum).toContain('decal');
    const s = create.properties.geom.anyOf!.find((x) => (x.properties?.kind as { const?: string } | undefined)?.const === 'decal')!;
    expect(s.required).toEqual(['kind', 'profile', 'holes', 'double', 'lift']);
    const op = normalizeLlmOp({
      op: 'create', shape: 'decal', name: 'far', params: [], position: at(0, 0, 0), rotation: null, color: '', place_on: '', role: '', cuts: [], opacity: null, resolution: null,
      geom: { kind: 'decal', profile: rect(30, 10), holes: null, double: null, lift: null },
    });
    const p = project([op]);
    expect(byName(p, 'far').geom).toEqual({ kind: 'decal', profile: rect(30, 10) });
  });
});

describe('kaplama: check ve gizli yüz ayıklaması', () => {
  it('kutu yüzündeki kaplama: check print ve game temiz', () => {
    const p = project([
      box('kaput', 500, 300, 200, at(0, 0, 100)),
      decal('plaka', { profile: rect(300, 110) }),
      { op: 'place_on_surface', part: 'plaka', target: 'kaput', near: at(0, -400, 100) },
      decal('üst', { profile: rect(100, 100), lift: 0.01 }, { position: at(0, 0, 200) }), // en küçük lift de temiz
    ]);
    expect(checkProject(p)).toEqual([]);
    expect(checkProject(p, { profile: 'game' })).toEqual([]);
  });

  it('iki kaplama tam çakışınca z-fighting bildirilir; kaplama taşıyıcı yüzle tam çakışırsa da', () => {
    const p = project([
      box('kutu', 100, 100, 10, at(0, 0, 5)),
      decal('a', { profile: rect(40, 40) }, { position: at(0, 0, 10) }),
      decal('b', { profile: rect(20, 20) }, { position: at(5, 5, 10) }),
    ]);
    const z = checkProject(p).filter((i) => /z-fighting/.test(i.message));
    expect(z).toHaveLength(1);
    expect(z[0].level).toBe('hata');
    expect(z[0].message).toMatch(/^'(a' ile 'b|b' ile 'a)' aynı düzlemde .*düzlem 10\.50 mm, örtüşme ≈400\.00 mm²/);
    // lift'i geri alan konum (mesh tam yüzeyde): gerçek çakışma
    const q = project([box('kutu', 100, 100, 10, at(0, 0, 5)), decal('yapışık', { profile: rect(40, 40) }, { position: at(0, 0, 9.5) })]);
    expect(checkProject(q).filter((i) => /z-fighting/.test(i.message))[0].message).toMatch(/^'kutu' ile 'yapışık'|^'yapışık' ile 'kutu'/);
  });

  it('cullHidden: kaplama atılmaz, altındaki yüz de kaplama yüzünden atılmaz', () => {
    const p = project([
      box('küp', 10, 10, 10, at(0, 0, 5)),
      decal('kapak', { profile: rect(10, 10), lift: 0.1 }, { position: at(0, 0, 10) }), // küpün üstünü tümüyle örter
      box('taban', 100, 100, 10, at(100, 0, 5)),
      decal('iz', { profile: rect(20, 20) }, { position: at(100, 0, 10) }),
      box('blok', 30, 30, 10, at(100, 0, 15)), // izi içine alır, alt yüzü tabana değer
    ]);
    const r = glbBuild(p, { cullHidden: true });
    expect(r.culled).toBe(2); // yalnızca bloğun alt yüzü
    const j = glbJson(r.data);
    const tris = Object.fromEntries(j.meshes.map((m: { name: string; primitives: { indices: number }[] }) => [m.name, j.accessors[m.primitives[0].indices].count / 3]));
    expect(tris).toEqual({ küp: 12, kapak: 2, taban: 12, iz: 2, blok: 10 });
    expect(checkProject(p, { profile: 'game' })).toEqual([]);
    // Bütçe aşılınca öneri: yalnızca bloğun alt yüzü (kaplamalar sayılmaz, örtmez)
    expect(checkProject(p, { profile: 'game', maxTris: 30 })[0].message).toContain(' 2 üçgen görünmez;'); // toplam 40
  });

  it('Boltrush damalı bayrağı: 4000 × 50 × 1200 kutu, iki yüzüne 16\'şar kare; 12 + 32 × 2 = 76 üçgen, check temiz', () => {
    // Kare 500 × 300; 8 × 4 ızgaranın koyu yarısı. Ön yüz (−Y): rotation x 90 → yerel +Z dünya −Y'ye, yerel y dünya z'ye.
    const squares: Op[] = [];
    let k = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2) continue;
        squares.push(decal(`kare${k++}`, { profile: rect(500, 300) }, { position: at(-1750 + 500 * c, -25, 150 + 300 * r), rotation: at(90, 0, 0), color: '#111111' }));
      }
    }
    const p = project([
      box('bayrak', 4000, 50, 1200, at(0, 0, 600), { color: '#f5f5f5' }),
      ...squares,
      { op: 'group', name: 'ön', parts: squares.map((_, i) => `kare${i}`) },
      { op: 'mirror', part: 'ön', plane: 'y', at: 0, name: 'arka' }, // arka yüz: kopyalar +Y'ye bakar
    ]);
    expect(p.parts).toHaveLength(1 + 32);
    const back = p.parts.filter((x) => x.group === 'arka');
    expect(back).toHaveLength(16);
    for (const part of back) expectNormal(faces(p, part.name).normals, [0, 1, 0]);
    const r = glbBuild(p);
    expect(r.triangles).toBe(12 + 32 * 2);
    expect(checkProject(p)).toEqual([]);
    expect(checkProject(p, { profile: 'game', maxTris: 80 })).toEqual([]);
  });

  it('CLI: scene satırı kısa (nokta, iki yüz, lift); STL dışa aktarımında atlanma uyarısı; measure kaplamayı katı toplamına katmaz', () => {
    const p = project([
      box('kutu', 40, 40, 10, at(0, 0, 5)),
      decal('plaka', { profile: rect(20, 10), double: true, lift: 1 }, { position: at(0, 0, 10) }),
    ]);
    const file = path.join(dir, 'kaplama.p3d.json');
    writeFileSync(file, projectToJson(p));
    const bin = fileURLToPath(new URL('../bin/p3d.mjs', import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });
    const scene = run(['scene', '--file', 'kaplama.p3d.json']);
    expect(scene.stdout).toMatch(/ plaka \[decal\] kaplama:4nokta\/iki-yüz\/lift1 +\| konum=0,0,10/);
    const stl = run(['export', 'k.stl', '--file', 'kaplama.p3d.json']);
    expect(stl.status).toBe(0);
    expect(stl.stdout).toContain("⚠ 1 kaplama atlandı ('plaka'): kalınlıksızdır, baskıya (STL) girmez; GLB ve OBJ'ye girer.");
    expect(stl.stdout).toMatch(/✓ 1 parça → .*k\.stl/);
    // measure / section: varsayılan kümede kaplama sessizce atlanır; --parts ile açıkça verilirse kısa not.
    const measure = run(['measure', '--file', 'kaplama.p3d.json']);
    expect(measure.stdout).not.toContain('plaka');
    expect(measure.stdout).toContain('BİRLEŞİK hacim (örtüşmeler bir kez): 16 cm³');
    const named = run(['measure', '--file', 'kaplama.p3d.json', '--parts', 'kutu,plaka']);
    expect(named.stdout).toMatch(/plaka \[kaplama\]: kutu .*, hacim 0 cm³ \(kalınlıksız\)/);
    expect(named.stdout).toContain('BİRLEŞİK hacim (örtüşmeler bir kez): 16 cm³');
    const section = run(['section', '--file', 'kaplama.p3d.json', '--axis', 'z', '--at', '5']);
    expect(section.stdout).not.toContain('plaka');
    expect(section.stdout).not.toContain('kesit alınamadı');
    const sectionNamed = run(['section', '--file', 'kaplama.p3d.json', '--axis', 'z', '--at', '5', '--parts', 'plaka']);
    expect(sectionNamed.stdout).toContain('plaka: kaplama: kalınlıksız, kesit yok');
  }, 60_000);
});
