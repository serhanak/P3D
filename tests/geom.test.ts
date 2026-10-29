import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Op, PartGeom } from '../shared/ops';
import { initCsg, levelSetGeometry, sliceGeometry, sliceMany } from '../src/csg';
import { applyOps, partBox, partMatrix } from '../src/engine';
import { checkProject } from '../src/check';
import { buildObj, mergedMesh, parseProject, projectToJson, worldMesh } from '../src/io';
import { build3mf, buildStl, meshAssetFromSoup, parseMeshFile } from '../src/meshio';
import { solidGeometry, solidVolume } from '../src/model';
import { newProject, type Project } from '../src/types';

beforeAll(() => initCsg());

/** Kapalı ve tutarlı yönlü ağ: her yönlü kenar bir kez, tersi de bir kez. Dönen: hatalı kenar sayısı, işaretli hacim. */
function checkWorldMesh(pos: Float32Array, tris: number[]) {
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

function project(ops: Op[]): Project {
  const p = newProject('test');
  const res = applyOps(p, ops, null);
  expect(res.errors).toEqual([]);
  return p;
}

const at0 = { x: 0, y: 0, z: 0 };
const create = (name: string, shape: 'extrude' | 'revolve' | 'loft', geom: PartGeom, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape,
  name,
  geom,
  position: at0,
  ...extra,
});

function solid(p: Project, name: string) {
  const part = p.parts.find((x) => x.name === name)!;
  const m = worldMesh(p, part);
  return { part, ...checkWorldMesh(m.pos, m.tris), box: partBox(part, p.settings.resolution) };
}

const L: [number, number][] = [[0, 0], [30, 0], [30, 6], [6, 6], [6, 20], [0, 20]]; // alan 6*30 + 6*14 = 264

describe('extrude', () => {
  it('z ekseni: hacim = alan × uzunluk, merkezli', () => {
    const p = project([create('L', 'extrude', { kind: 'extrude', axis: 'z', profile: L }, { params: [{ name: 'height', value: 5 }] })]);
    const s = solid(p, 'L');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo(264 * 5, 3);
    expect(s.box.min.z).toBeCloseTo(-2.5);
    expect(s.box.max.x).toBeCloseTo(30);
  });

  it('x ve y eksenleri: doğru yönelim, dışa dönük', () => {
    const p = project([
      create('X', 'extrude', { kind: 'extrude', axis: 'x', profile: L }, { params: [{ name: 'height', value: 8 }] }),
      create('Y', 'extrude', { kind: 'extrude', axis: 'y', profile: L }, { params: [{ name: 'height', value: 8 }] }),
    ]);
    const x = solid(p, 'X');
    expect(x.bad).toBe(0);
    expect(x.vol).toBeCloseTo(264 * 8, 3);
    // axis x: profil [y, z]
    expect([x.box.min.x, x.box.max.x, x.box.max.y, x.box.max.z]).toEqual([-4, 4, 30, 20].map((v) => expect.closeTo(v, 4)));
    const y = solid(p, 'Y');
    expect(y.bad).toBe(0);
    expect(y.vol).toBeCloseTo(264 * 8, 3);
    // axis y: profil [x, z]
    expect([y.box.max.x, y.box.min.y, y.box.max.y, y.box.max.z]).toEqual([30, -4, 4, 20].map((v) => expect.closeTo(v, 4)));
  });

  it('iç boşluk hacimden düşer', () => {
    const sq = (h: number): [number, number][] => [[-h, -h], [h, -h], [h, h], [-h, h]];
    const p = project([create('çerçeve', 'extrude', { kind: 'extrude', axis: 'z', profile: sq(10), holes: [sq(5)] }, { params: [{ name: 'height', value: 2 }] })]);
    const s = solid(p, 'çerçeve');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo((400 - 100) * 2, 3);
  });
});

describe('revolve', () => {
  it('eksenden uzak profil → halka (Pappus)', () => {
    const p = project([create('halka', 'revolve', { kind: 'revolve', axis: 'z', profile: [[5, 0], [10, 0], [10, 4], [5, 4]] })]);
    const s = solid(p, 'halka');
    expect(s.bad).toBe(0);
    const n = p.settings.resolution;
    const polyFactor = (n / (2 * Math.PI)) * Math.sin((2 * Math.PI) / n);
    expect(s.vol / (Math.PI * (100 - 25) * 4 * polyFactor)).toBeCloseTo(1, 4);
  });

  it('eksene değen profil kapanır (koni + silindir), x ekseninde yatar', () => {
    const p = project([create('baca', 'revolve', { kind: 'revolve', axis: 'x', profile: [[0, 0], [5, 0], [5, 10], [2, 14], [0, 14]] })]);
    const s = solid(p, 'baca');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeGreaterThan(0);
    expect(s.box.min.x).toBeCloseTo(0);
    expect(s.box.max.x).toBeCloseTo(14);
    expect(s.box.max.y).toBeCloseTo(5, 1);
  });
});

describe('loft', () => {
  it('eş nokta sayılı kesitler: kesik piramit hacmi', () => {
    const sq = (h: number): [number, number][] => [[-h, -h], [h, -h], [h, h], [-h, h]];
    const p = project([
      create('piramit', 'loft', {
        kind: 'loft',
        axis: 'z',
        sections: [
          { at: 0, points: sq(10) },
          { at: 10, points: sq(5) },
        ],
      }),
    ]);
    const s = solid(p, 'piramit');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo((10 / 3) * (400 + 100 + 200), 2);
  });

  it('farklı nokta sayısı (kare → daire) ve x ekseni: kapalı, kesitler doğru yerde', () => {
    const circle = Array.from({ length: 32 }, (_, i) => [8 * Math.cos((i / 32) * 2 * Math.PI), 8 * Math.sin((i / 32) * 2 * Math.PI)] as [number, number]);
    const p = project([
      create('geçiş', 'loft', {
        kind: 'loft',
        axis: 'x',
        sections: [
          { at: -20, points: [[-10, 0], [10, 0], [10, 20], [-10, 20]] },
          { at: 0, points: [[-9, 1], [9, 1], [9, 19], [-9, 19]] },
          { at: 20, points: circle },
        ],
      }),
    ]);
    const s = solid(p, 'geçiş');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeGreaterThan(0);
    expect([s.box.min.x, s.box.max.x]).toEqual([expect.closeTo(-20, 4), expect.closeTo(20, 4)]);
  });

  it('ölçek işlemi geometriyi büyütür (hacim f³)', () => {
    const p = project([create('kutu', 'loft', { kind: 'loft', axis: 'z', sections: [{ at: 0, points: [[0, 0], [4, 0], [4, 4], [0, 4]] }, { at: 4, points: [[0, 0], [4, 0], [4, 4], [0, 4]] }] })]);
    applyOps(p, [{ op: 'scale', part: 'kutu', factor: 2 }], null);
    expect(solid(p, 'kutu').vol).toBeCloseTo(64 * 8, 3);
  });
});

describe('geom doğrulama', () => {
  const err = (ops: Op[]) => applyOps(newProject(), ops, null).errors.join(' ');
  it('kendini kesen profil, negatif yarıçap, tek kesit reddedilir', () => {
    expect(err([create('a', 'extrude', { kind: 'extrude', axis: 'z', profile: [[0, 0], [10, 10], [10, 0], [0, 10]] })])).toMatch(/kesiyor/);
    expect(err([create('b', 'revolve', { kind: 'revolve', axis: 'z', profile: [[-1, 0], [5, 0], [5, 5]] })])).toMatch(/negatif/);
    expect(err([create('c', 'loft', { kind: 'loft', axis: 'z', sections: [{ at: 0, points: L }] })])).toMatch(/en az 2 kesit/);
    expect(err([{ op: 'create', shape: 'box', name: 'd', geom: { kind: 'extrude', axis: 'z', profile: L } }])).toMatch(/geom almaz/);
  });
});

describe('delik (boolean) ve roller', () => {
  const plate = (): Op[] => [
    { op: 'create', shape: 'box', name: 'plaka', params: [{ name: 'width', value: 20 }, { name: 'depth', value: 20 }, { name: 'height', value: 10 }], position: { x: 0, y: 0, z: 5 } },
    { op: 'create', shape: 'cylinder', name: 'delik', role: 'hole', params: [{ name: 'diameter', value: 6 }, { name: 'height', value: 14 }], position: { x: 3, y: 0, z: 5 } },
  ];

  it('delik kesiştiği katıdan çıkarılır; ekranda ve dışa aktarımda aynı', () => {
    const p = project(plate());
    const n = p.settings.resolution;
    const hole = 0.5 * n * 9 * Math.sin((2 * Math.PI) / n) * 10;
    const s = solid(p, 'plaka');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo(4000 - hole, 1);
    expect(solidVolume(p, s.part)).toBeCloseTo(4000 - hole, 1);
    expect(solidGeometry(p, s.part).cut).toBe(true);
  });

  it('delik ve referans parçalar dışa aktarılmaz; gizli delik kesmez', () => {
    const p = project([...plate(), { op: 'create', shape: 'sphere', name: 'ref', role: 'reference' }]);
    const obj = buildObj(p.parts.filter((x) => x.visible && (x.role ?? 'solid') === 'solid'), p, null).obj;
    expect(obj.match(/^o /gm)).toHaveLength(1);
    applyOps(p, [{ op: 'update', part: 'delik', visible: false }], null);
    expect(solid(p, 'plaka').vol).toBeCloseTo(4000, 3);
  });

  it('rol değişikliği: delik → katı', () => {
    const p = project(plate());
    const r = applyOps(p, [{ op: 'update', part: 'delik', role: 'solid' }], null);
    expect(r.messages[0]).toMatch(/rol: katı/);
    expect(p.parts[1].role).toBeUndefined();
    expect(solid(p, 'plaka').vol).toBeCloseTo(4000, 3);
  });

  it('kesit: x = 0 düzleminde deliğin iki yanı', () => {
    const p = project(plate());
    const part = p.parts[0];
    const g = solidGeometry(p, part).geometry.applyMatrix4(partMatrix(part));
    const polys = sliceGeometry(g, 'x', 3); // deliğin ortası
    expect(polys).toHaveLength(2);
  });
});

describe('mesh içe/dışa aktarma', () => {
  async function boxAsset() {
    const p = newProject();
    applyOps(p, [{ op: 'create', shape: 'box', name: 'k', params: [{ name: 'width', value: 20 }, { name: 'depth', value: 10 }, { name: 'height', value: 5 }], position: { x: 50, y: 0, z: 2.5 } }], null);
    return { p, mesh: worldMesh(p, p.parts[0]) };
  }

  it('STL → içe aktar → hacim ve konum korunur', async () => {
    const { mesh } = await boxAsset();
    const soup = parseMeshFile('kutu.stl', buildStl([mesh]));
    const imp = await meshAssetFromSoup('kutu', soup);
    expect(imp.center).toEqual({ x: 50, y: 0, z: 2.5 });
    const p = project([{ op: 'import_mesh', asset: imp.asset, position: imp.center }]);
    const s = solid(p, 'kutu');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo(1000, 1);
    expect(solidVolume(p, s.part)).toBeCloseTo(1000, 1);
  });

  it('3MF ve OBJ okunur', async () => {
    const { p, mesh } = await boxAsset();
    const fromStl = parseMeshFile('a.stl', buildStl([mesh]));
    const from3mf = parseMeshFile('a.3mf', build3mf('t', [mesh]).buffer as ArrayBuffer);
    expect(from3mf.length).toBe(fromStl.length);
    const obj = buildObj(p.parts, p, null).obj;
    const fromObj = parseMeshFile('a.obj', new TextEncoder().encode(obj).buffer as ArrayBuffer);
    expect(fromObj.length).toBe(fromStl.length);
  });

  it('sadeleştirme üçgen sayısını sınırlar', async () => {
    const p = project([{ op: 'create', shape: 'sphere', name: 'küre', params: [{ name: 'diameter', value: 40 }] }]);
    const soup = parseMeshFile('k.stl', buildStl([worldMesh(p, p.parts[0])]));
    const imp = await meshAssetFromSoup('küre', soup, 2000);
    expect(imp.originalTriangles).toBeGreaterThan(2000);
    expect(imp.asset.triangles).toBeLessThanOrEqual(2000);
  });

  it('proje dosyası ağ verisini taşır', async () => {
    const { mesh } = await boxAsset();
    const imp = await meshAssetFromSoup('kutu', parseMeshFile('kutu.stl', buildStl([mesh])));
    const p = project([{ op: 'import_mesh', asset: imp.asset, role: 'reference' }]);
    const json = JSON.parse(projectToJson(p));
    expect(Object.keys(json.assets)).toEqual([imp.asset.id]);
    const back = parseProject(json);
    expect(back.parts[0].geom).toEqual({ kind: 'mesh', asset: imp.asset.id });
    expect(back.parts[0].role).toBe('reference');
    expect(back.assets).toBeUndefined();
  });
});

describe('loft yumuşatma, uç ve keskin köşeler', () => {
  const ngon = (r: number, n: number) => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)] as [number, number]);

  it('smooth: sekizgen kesitler daireye yaklaşır, ağ kapalı kalır', () => {
    const sections = [0, 10, 20].map((at) => ({ at, points: ngon(10, 8) }));
    const p = project([create('silindirimsi', 'loft', { kind: 'loft', axis: 'z', sections, smooth: true })]);
    const s = solid(p, 'silindirimsi');
    expect(s.bad).toBe(0);
    const circle = Math.PI * 100 * 20;
    const octagon = 0.5 * 8 * 100 * Math.sin(Math.PI / 4) * 20;
    expect(s.vol).toBeGreaterThan(octagon * 1.05);
    expect(s.vol / circle).toBeGreaterThan(0.97);
    expect(s.vol / circle).toBeLessThan(1.01);
  });

  it('tek noktalı son kesit: koni (uç) — hacim ≈ πr²h/3', () => {
    const p = project([create('koni', 'loft', { kind: 'loft', axis: 'z', sections: [{ at: 0, points: ngon(10, 64) }, { at: 30, points: [[0, 0]] }] })]);
    const s = solid(p, 'koni');
    expect(s.bad).toBe(0);
    expect(s.vol / ((Math.PI * 100 * 30) / 3)).toBeCloseTo(1, 2);
    expect(s.box.max.z).toBeCloseTo(30);
  });

  it('sharp: tüm köşeleri keskin kare yumuşatmada kutu kalır', () => {
    const sq: [number, number][] = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
    const p = project([create('kutu', 'loft', { kind: 'loft', axis: 'z', sections: [{ at: 0, points: sq }, { at: 4, points: sq }, { at: 10, points: sq }], smooth: true, sharp: [0, 1, 2, 3] })]);
    const s = solid(p, 'kutu');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo(1000, 3);
  });

  it('uç yalnızca ilk/son kesit olabilir; sharp eş nokta sayısı ister', () => {
    const err = (ops: Op[]) => applyOps(newProject(), ops, null).errors.join(' ');
    expect(err([create('a', 'loft', { kind: 'loft', axis: 'z', sections: [{ at: 0, points: ngon(5, 6) }, { at: 5, points: [[0, 0]] }, { at: 9, points: ngon(5, 6) }] })])).toMatch(/yalnızca ilk ya da son/);
    expect(err([create('b', 'loft', { kind: 'loft', axis: 'z', sections: [{ at: 0, points: ngon(5, 6) }, { at: 5, points: ngon(5, 8) }], sharp: [0] })])).toMatch(/nokta sayısı aynı/);
  });
});

describe('delik hedefi (cuts)', () => {
  it('cuts verilen delik yalnızca hedefi keser', () => {
    const p = project([
      { op: 'create', shape: 'box', name: 'alt', params: [{ name: 'width', value: 20 }, { name: 'depth', value: 20 }, { name: 'height', value: 10 }], position: { x: 0, y: 0, z: 5 } },
      { op: 'create', shape: 'box', name: 'üst', params: [{ name: 'width', value: 6 }, { name: 'depth', value: 6 }, { name: 'height', value: 10 }], position: { x: 0, y: 0, z: 12 } },
      { op: 'create', shape: 'box', name: 'kuyu', role: 'hole', cuts: ['alt'], params: [{ name: 'width', value: 16 }, { name: 'depth', value: 16 }, { name: 'height', value: 20 }], position: { x: 0, y: 0, z: 18 } },
    ]);
    expect(solid(p, 'alt').vol).toBeCloseTo(4000 - 16 * 16 * 2, 1);
    expect(solid(p, 'üst').vol).toBeCloseTo(360, 3);
    const r = applyOps(p, [{ op: 'update', part: 'kuyu', cuts: ['*'] }], null);
    expect(r.messages[0]).toMatch(/kesiştiği tüm katılar/);
    expect(solid(p, 'üst').vol).toBeLessThan(360);
  });

  it('katı parçaya hedef verilemez', () => {
    const r = applyOps(newProject(), [{ op: 'create', shape: 'box', name: 'k', cuts: ['x'] }], null);
    expect(r.errors.join(' ')).toMatch(/delik değil/);
  });
});

describe('çerçeve, yüzeye yerleştirme, birleştirme, denetim', () => {
  const rect = (w: number, h: number): [number, number][] => [[-w / 2, 0], [w / 2, 0], [w / 2, h], [-w / 2, h]];

  it('frame: kapalı çerçeve = (dış − iç) alan × kalınlık', () => {
    const p = project([create('çerçeve', 'extrude', { kind: 'extrude', axis: 'z', profile: rect(10, 8), frame: 1.5 }, { params: [{ name: 'height', value: 2 }] })]);
    const s = solid(p, 'çerçeve');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo((13 * 11 - 10 * 8) * 2, 2);
  });

  it('frame + open: son→ilk kenar boyunca çerçeve yok (U pervaz)', () => {
    // Profil: alt kenar son→ilk kenar olsun (sağ alttan başla, saat yönünün tersi, sol altta bit)
    const profile: [number, number][] = [[5, 0], [5, 8], [-5, 8], [-5, 0]];
    const p = project([create('pervaz', 'extrude', { kind: 'extrude', axis: 'z', profile, frame: 1, open: true }, { params: [{ name: 'height', value: 1 }] })]);
    const s = solid(p, 'pervaz');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo(12 * 10 - 10 * 8 - 12 * 1, 1); // dış 12×10 − iç 10×8 − açık alt kenar bandı 12×1 = 28
    expect(s.box.min.y).toBeCloseTo(0, 3);
  });

  it('frame ile holes birlikte reddedilir', () => {
    const r = applyOps(newProject(), [create('x', 'extrude', { kind: 'extrude', axis: 'z', profile: rect(10, 8), holes: [rect(2, 2).map(([a, b]) => [a, b + 3] as [number, number])], frame: 1 })], null);
    expect(r.errors.join(' ')).toMatch(/birlikte kullanılamaz/);
  });

  it('place_on_surface: eğik yüzeye dik oturur', () => {
    const p = project([
      { op: 'create', shape: 'box', name: 'rampa', params: [{ name: 'width', value: 40 }, { name: 'depth', value: 20 }, { name: 'height', value: 4 }], position: { x: 0, y: 0, z: 10 }, rotation: { x: 0, y: 30, z: 0 } },
      { op: 'create', shape: 'cylinder', name: 'perçin', params: [{ name: 'diameter', value: 3 }, { name: 'height', value: 1 }] },
    ]);
    const r = applyOps(p, [{ op: 'place_on_surface', part: 'perçin', target: 'rampa', near: { x: 5, y: 0, z: 30 }, offset: 0.5 }], null);
    expect(r.errors).toEqual([]);
    const rivet = p.parts[1];
    // üst yüzey normali: (0,0,1) Y etrafında 30° döner → (sin30, 0, cos30)
    const m = partMatrix(rivet);
    const axis = new (partBox(rivet, 96).min.constructor as any)(0, 0, 1).transformDirection(m);
    expect(axis.x).toBeCloseTo(Math.sin(Math.PI / 6), 2);
    expect(axis.z).toBeCloseTo(Math.cos(Math.PI / 6), 2);
  });

  it('birleştirme: örtüşen iki kutu tek gövde, hacim = birleşim', () => {
    const p = project([
      { op: 'create', shape: 'box', name: 'a', params: [{ name: 'width', value: 10 }, { name: 'depth', value: 10 }, { name: 'height', value: 10 }], position: { x: 0, y: 0, z: 5 } },
      { op: 'create', shape: 'box', name: 'b', params: [{ name: 'width', value: 10 }, { name: 'depth', value: 10 }, { name: 'height', value: 10 }], position: { x: 5, y: 0, z: 5 } },
    ]);
    const m = mergedMesh(p, p.parts);
    const c = checkWorldMesh(m.pos, m.tris);
    expect(c.bad).toBe(0);
    expect(c.vol).toBeCloseTo(1500, 2);
  });

  it('check: çakışan yüzeyleri bulur, temiz modelde hata vermez', () => {
    const p = project([
      { op: 'create', shape: 'box', name: 'zemin', params: [{ name: 'width', value: 20 }, { name: 'depth', value: 20 }, { name: 'height', value: 2 }], position: { x: 0, y: 0, z: 1 } },
      { op: 'create', shape: 'box', name: 'levha', params: [{ name: 'width', value: 10 }, { name: 'depth', value: 10 }, { name: 'height', value: 2 }], position: { x: 0, y: 0, z: 1 } },
    ]);
    const issues = checkProject(p);
    expect(issues.some((i) => i.level === 'hata' && /zemin.*levha|levha.*zemin/.test(i.message))).toBe(true);
    applyOps(p, [{ op: 'move', part: 'levha', dx: 0, dy: 0, dz: 2 }], null); // üstüne otursun: yüzeyler zıt yönlü
    expect(checkProject(p).filter((i) => i.level === 'hata')).toEqual([]);
  });
});

describe('örtük yüzey, çoklu kesit, düzgün sadeleştirme', () => {
  it('levelSetGeometry: küre hacmi ≈ 4/3 πr³, ağ kapalı', () => {
    const g = levelSetGeometry(([x, y, z]) => 10 - Math.hypot(x, y, z), { min: [-11, -11, -11], max: [11, 11, 11] }, 0.5);
    const pos = g.getAttribute('position').array as Float32Array;
    const c = checkWorldMesh(pos, Array.from(g.getIndex()!.array));
    expect(c.bad).toBe(0);
    expect(c.vol / ((4 / 3) * Math.PI * 1000)).toBeCloseTo(1, 1);
  });

  it('sliceMany, tek tek sliceGeometry ile aynı sonucu verir', () => {
    const p = project([{ op: 'create', shape: 'sphere', name: 'k', params: [{ name: 'diameter', value: 20 }], position: { x: 0, y: 0, z: 10 } }]);
    const m = worldMesh(p, p.parts[0]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
    geo.setIndex(m.tris);
    const many = sliceMany(geo, 'z', [5, 10, 15]);
    expect(many[1]).toEqual(sliceGeometry(geo, 'z', 10));
    expect(many.map((polys) => polys.length)).toEqual([1, 1, 1]);
  });

  it('içe aktarmada sadeleştirme iğne üçgen bırakmaz (Regularize)', async () => {
    const g = levelSetGeometry(([x, y, z]) => Math.min(8 - Math.hypot(x, y), 10 - Math.abs(z)), { min: [-9, -9, -11], max: [9, 9, 11] }, 0.3);
    const idx = g.getIndex()!.array;
    const pos = g.getAttribute('position').array;
    const soup = new Float32Array(idx.length * 3);
    for (let i = 0; i < idx.length; i++) for (let c = 0; c < 3; c++) soup[i * 3 + c] = pos[idx[i] * 3 + c];
    const imp = await meshAssetFromSoup('silindir', soup, 4000, 0.005);
    const P = new Float32Array(Uint8Array.from(atob(imp.asset.positions), (ch) => ch.charCodeAt(0)).buffer);
    const I = new Uint32Array(Uint8Array.from(atob(imp.asset.indices), (ch) => ch.charCodeAt(0)).buffer);
    let needles = 0;
    for (let t = 0; t < I.length; t += 3) {
      const v = [0, 1, 2].map((k) => [P[I[t + k] * 3], P[I[t + k] * 3 + 1], P[I[t + k] * 3 + 2]]);
      const e = [0, 1, 2].map((k) => Math.hypot(v[(k + 1) % 3][0] - v[k][0], v[(k + 1) % 3][1] - v[k][1], v[(k + 1) % 3][2] - v[k][2]));
      const ang = [0, 1, 2].map((k) => Math.acos(Math.min(1, Math.max(-1, (e[k] ** 2 + e[(k + 1) % 3] ** 2 - e[(k + 2) % 3] ** 2) / (2 * e[k] * e[(k + 1) % 3])))));
      if (Math.min(...ang) < (3 * Math.PI) / 180) needles++;
    }
    expect(needles / (I.length / 3)).toBeLessThan(0.01);
  });
});

describe('tekne (endaze) şekli', () => {
  const hull = (stations: { x: number; keel: number; sheer: number; breadth: number[] }[]) =>
    create('tekne', 'hull' as never, { kind: 'hull', stations } as never);

  it('sabit genişlikli tablo tam bir kutu verir (yanlar düzlem, kenarlar keskin)', () => {
    const p = project([hull([0, 5, 10].map((x) => ({ x, keel: 0, sheer: 5, breadth: [3, 3, 3] })))]);
    const s = solid(p, 'tekne');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo(10 * 6 * 5, 0);
    expect([s.box.min.x, s.box.max.x, s.box.min.z, s.box.max.z]).toEqual([0, 10, 0, 5].map((v) => expect.closeTo(v, 2)));
  });

  it('genişliği sıfıra inen uç istasyon gövdeyi kapatır (baş), kapalı ağ', () => {
    const p = project([hull([
      { x: 0, keel: 0, sheer: 6, breadth: [4, 5, 5] },
      { x: 10, keel: 0, sheer: 6, breadth: [4, 5, 5] },
      { x: 16, keel: 2, sheer: 7, breadth: [0, 0, 0] },
    ])]);
    const s = solid(p, 'tekne');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeGreaterThan(10 * 6 * 9 * 0.9);
    expect(s.box.max.x).toBeLessThanOrEqual(16.01);
  });

  it('doğrulama: eşit olmayan genişlik sayısı, ters omurga/küpeşte reddedilir', () => {
    const err = (st: { x: number; keel: number; sheer: number; breadth: number[] }[]) => applyOps(newProject(), [hull(st)], null).errors.join(' ');
    expect(err([{ x: 0, keel: 0, sheer: 5, breadth: [1, 2] }, { x: 5, keel: 0, sheer: 5, breadth: [1, 2, 3] }])).toMatch(/aynı \(2\)/);
    expect(err([{ x: 0, keel: 5, sheer: 1, breadth: [1, 2] }, { x: 5, keel: 0, sheer: 5, breadth: [1, 2] }])).toMatch(/yüksek olmalı/);
  });
});
