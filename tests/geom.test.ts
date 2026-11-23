import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Op, PartGeom } from '../shared/ops';
import { initCsg, levelSetGeometry, sliceGeometry, sliceMany } from '../src/csg';
import { applyOps, partBox, partMatrix, partsBox } from '../src/engine';
import { checkProject } from '../src/check';
import { buildObj, mergedMesh, parseProject, projectToJson, worldMesh } from '../src/io';
import { build3mf, buildStl, meshAssetFromSoup, parseMeshFile } from '../src/meshio';
import { exportableParts, solidBox, solidGeometry, solidPartsBox, solidVolume } from '../src/model';
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

  // BoltRush isteği #8: ardışık çakışık nokta atılınca kesitler farklı sayıya düşüp yeniden örnekleniyor, eşleşme kayıyordu.
  it('ardışık çakışık noktalar (dejenere kenar) indis eşleşmesini korur: doğan çıkıntının hacmi tam', () => {
    const sec = (t: number): [number, number][] => [[0, 0], [20, 0], [20, 30], [20 + 40 * t, 30 + 10 * t], [20 + 40 * t, 70 - 10 * t], [20, 70], [20, 100], [0, 100]];
    const p = project([create('çıkıntı', 'loft', { kind: 'loft', axis: 'y', sections: [{ at: -100, points: sec(0) }, { at: 100, points: sec(1) }] })]);
    const part = p.parts[0];
    expect(part.geom?.kind === 'loft' && part.geom.sections.map((x) => x.points.length)).toEqual([8, 8]);
    const s = solid(p, 'çıkıntı');
    expect(s.bad).toBe(0);
    // Kesit alanı A(t) = 2000 + 1600t − 400t² (t: 0…1), y boyunca 200 mm; yan dörtgenler düzlemsel → tam.
    expect(s.vol).toBeCloseTo(200 * (2000 + 800 - 400 / 3), 1);
    expect(checkProject(p, { profile: 'game' })).toEqual([]); // bozuk (alanı ~0) üçgen de yok
    // Ayna: nokta sayısı ve hacim korunur.
    const r = applyOps(p, [{ op: 'mirror', part: 'çıkıntı', plane: 'x', at: 0, name: 'ayna' }], null);
    expect(r.errors).toEqual([]);
    const m = solid(p, 'ayna');
    expect(m.bad).toBe(0);
    expect(m.vol).toBeCloseTo(s.vol, 1);
  });

  it('çakışık nokta biçimleri: kapanış tekrarı, kapanışta dejenere kenar, eşleşmeyi bozan tekrar', () => {
    const lens = (p: Project, name: string) => {
      const g = p.parts.find((x) => x.name === name)!.geom;
      return g?.kind === 'loft' ? g.sections.map((x) => x.points.length) : [];
    };
    // Tüm kesitler ilk noktayı sonda tekrarlıyorsa (kapalı çokgen yazımı) tekrar atılır — eski davranış.
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const p1 = project([create('kapalı', 'loft', { kind: 'loft', axis: 'z', sections: [{ at: 0, points: sq }, { at: 5, points: sq }] })]);
    expect(lens(p1, 'kapalı')).toEqual([4, 4]);
    expect(solid(p1, 'kapalı').vol).toBeCloseTo(500, 3);
    // Üçgen → kare: sol köşe ikiye açılır. Çakışık nokta kapanışta ya da başta olsun, eşleşme aynı → aynı gövde.
    const tri = (a: [number, number][], b: [number, number][], name: string) =>
      create(name, 'loft', { kind: 'loft', axis: 'z', sections: [{ at: 0, points: a }, { at: 10, points: b }] });
    const [p0, p1_, p2] = [[0, 5], [10, 0], [10, 10]] as [number, number][];
    const [q0, q1, q2, q3] = [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][];
    const p2p = project([tri([p0, p1_, p2, p0], [q0, q1, q2, q3], 'sonda'), tri([p0, p0, p1_, p2], [q3, q0, q1, q2], 'başta')]);
    expect(lens(p2p, 'sonda')).toEqual([4, 4]);
    const [a, b] = [solid(p2p, 'sonda'), solid(p2p, 'başta')];
    expect(a.bad).toBe(0);
    expect(b.bad).toBe(0);
    // Tüm köşeler iki paralel düzlemde (prizmatoid): V = h/6·(A0 + 4·Aorta + A1) = 10/6·(50 + 4·75 + 100) tam.
    expect(a.vol).toBeCloseTo(750, 4);
    expect(b.vol).toBeCloseTo(750, 4);
    // Tekrar korununca sayılar yine farklıysa tekrarlar atılır (4 = 4 nokta eşleşmesi).
    const p3 = project([tri([q0, q1, q1, q2, q3], [q0, q1, q2, q3], 'atılır')]);
    expect(lens(p3, 'atılır')).toEqual([4, 4]);
    // Çakışık noktalarla MAX_POINTS (1024) aşılıyorsa tekrarsız biçime düşülür (hata değil).
    const big = Array.from({ length: 1020 }, (_, i) => [10 * Math.cos((2 * Math.PI * i) / 1020), 10 * Math.sin((2 * Math.PI * i) / 1020)] as [number, number]);
    const bigDup = big.flatMap((p, i) => (i % 102 === 0 ? [p, p] : [p]));
    const p4 = project([tri(bigDup, bigDup, 'büyük')]);
    expect(lens(p4, 'büyük')).toEqual([1020, 1020]);
  });

  it('çakışık nokta: uç kesit, 3 kesitte kısmi çakışma (düz ve yumuşak), ayna + sharp', () => {
    const sec = (t: number): [number, number][] => [[0, 0], [20, 0], [20, 30], [20 + 40 * t, 30 + 10 * t], [20 + 40 * t, 70 - 10 * t], [20, 70], [20, 100], [0, 100]];
    // Parçalar X'te ayrık (üst üste binip check'te çakışma vermesin).
    const loft = (name: string, x: number, sections: { at: number; points: [number, number][] }[], extra: Record<string, unknown> = {}) =>
      create(name, 'loft', { kind: 'loft', axis: 'y', sections, ...extra } as PartGeom, { position: { x, y: 0, z: 0 } });
    const three = [{ at: -100, points: sec(0) }, { at: 0, points: sec(0.5) }, { at: 100, points: sec(1) }];
    const p = project([
      loft('uç', -100, [{ at: -100, points: sec(0) }, { at: 100, points: [[10, 50]] }]),
      loft('düz', 0, three),
      loft('yumuşak', 100, three, { smooth: true }),
    ]);
    for (const name of ['uç', 'düz', 'yumuşak']) {
      const s = solid(p, name);
      expect(s.bad, name).toBe(0);
      expect(s.vol, name).toBeGreaterThan(0);
    }
    // Düz 3 kesit: ara kesit sec(0.5) tam olarak doğrusal ara değer → hacim 2 kesitlinin aynısı.
    expect(solid(p, 'düz').vol).toBeCloseTo(200 * (2000 + 800 - 400 / 3), 1);
    expect(checkProject(p, { profile: 'game' })).toEqual([]);
    // Tüm kesitlerde 0–1 çakışık + sharp o noktada: aynada çift sona geçip kapanış tekrarı olarak atılır, sharp 0'a eşlenir.
    const sq: [number, number][] = [[0, 0], [0, 0], [10, 0], [10, 10], [0, 10]];
    const q = project([create('a', 'loft', { kind: 'loft', axis: 'z', sections: [{ at: 0, points: sq }, { at: 10, points: sq }], smooth: true, sharp: [1] })]);
    const r = applyOps(q, [{ op: 'mirror', part: 'a', plane: 'x', at: 0, name: 'b' }], null);
    expect(r.errors).toEqual([]);
    const gb = q.parts.find((x) => x.name === 'b')!.geom;
    expect(gb?.kind === 'loft' && [gb.sections[0].points.length, gb.sharp]).toEqual([4, [0]]);
    expect(solid(q, 'b').vol).toBeCloseTo(solid(q, 'a').vol, 3);
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

  it('smooth: çakışık nokta yüzeyi değiştirmez (teğetler tekil noktalardan)', () => {
    const oct = ngon(10, 8);
    const dup = [...oct.slice(0, 4), oct[3], ...oct.slice(4)];
    const make = (pts: [number, number][], name: string) =>
      create(name, 'loft', { kind: 'loft', axis: 'z', sections: [0, 10, 20].map((at) => ({ at, points: pts })), smooth: true, sharp: [] });
    const p = project([make(oct, 'düz'), make(dup, 'çakışık')]);
    expect(p.parts[1].geom?.kind === 'loft' && p.parts[1].geom.sections[0].points.length).toBe(9);
    const [a, b] = [solid(p, 'düz'), solid(p, 'çakışık')];
    expect(b.bad).toBe(0);
    expect(b.vol).toBeCloseTo(a.vol, 4);
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

  it('check: iletide gerçek örtüşme alanı (üçgen alanı değil); kıl payı şeritte ortak nokta ipucu (BoltRush #25)', () => {
    const zf = (p: Project) => checkProject(p).filter((i) => /z-fighting/.test(i.message));
    // İki kutu 10 mm bindiriyor: üst + alt 10 × 100, ön + arka 10 × 10 → 2200 mm²; geniş örtüşme, kaydırma önerisi.
    const box = (name: string, x: number) =>
      ({ op: 'create', shape: 'box', name, params: [{ name: 'width', value: 100 }, { name: 'depth', value: 100 }, { name: 'height', value: 10 }], position: { x, y: 0, z: 5 } }) as Op;
    const q = zf(project([box('a', 0), box('b', 90)]));
    expect(q).toHaveLength(1);
    expect(q[0].message).toMatch(/örtüşme ≈2200\.00 mm²\): ekranda titreşir \(z-fighting\)\. Birini 0,05–0,2 mm kaydırın/);
    // Eğik düzlemde de (izdüşüm düzeltmesi): döndürülmüş aynı çift aynı alanı verir (float32 köşe gürültüsü kadar fark).
    for (const degrees of [30, 45, 60]) {
      const r = project([box('a', 0), box('b', 90), { op: 'group', parts: ['a', 'b'], name: 'g' } as Op, { op: 'rotate', part: 'g', axis: 'y', degrees }]);
      expect(Number(/örtüşme ≈([\d.]+) mm²/.exec(zf(r)[0].message)![1])).toBeCloseTo(2200, 0);
    }

    // Kemer iki süpürmeden: birleşimde teğet ortak (tam birleşim temiz); birleşim noktası z'de 0,05 mm kayınca teğet ~1e-4 rad
    // kırılır, yüzler ~0,015 mm'lik şeritte üst üste biner. Eski ileti üçgen alanını (~10⁵ mm²) yazıyordu.
    const arch = (dz: number) =>
      project([
        { op: 'create', shape: 'sweep', name: 'sol', position: { x: 0, y: 0, z: 0 }, geom: { kind: 'sweep', path: [[-2000, 0, 0], [-2000, 0, 1000], [-1000, 0, 2000], [0, 0, 2000 + dz]], profile: [[-150, -100], [150, -100], [150, 100], [-150, 100]], up: [0, 1, 0], bend: 400 } },
        { op: 'create', shape: 'sweep', name: 'sağ', position: { x: 0, y: 0, z: 0 }, geom: { kind: 'sweep', path: [[0, 0, 2000 + dz], [1000, 0, 2000], [2000, 0, 1000], [2000, 0, 0]], profile: [[-150, -100], [150, -100], [150, 100], [-150, 100]], up: [0, 1, 0], bend: 400 } },
      ]);
    expect(zf(arch(0))).toEqual([]);
    const s = zf(arch(0.05));
    expect(s).toHaveLength(1);
    const area = Number(/örtüşme ≈([\d.]+) mm²/.exec(s[0].message)![1]);
    expect(area).toBeGreaterThan(1);
    expect(area).toBeLessThan(20);
    expect(s[0].message).toMatch(/Kıl payı örtüşme \(en fazla ~0,01\d* mm genişlikte şerit, örtüşen üçgenlere oranı %[\d,]+\): .*Ortak noktaları iki parçada da aynı değerlerle verin\.$/);
  });

  it('check: başka opak katının içinde kalan örtüşme z-fighting sayılmaz (BoltRush #26)', () => {
    const box = (name: string, w: number, d: number, h: number, [x, y, z]: number[], extra: Partial<Op> = {}) =>
      ({ op: 'create', shape: 'box', name, params: [{ name: 'width', value: w }, { name: 'depth', value: d }, { name: 'height', value: h }], position: { x, y, z }, ...extra }) as Op;
    const zf = (ops: Op[]) => {
      const p = project(ops);
      const all = [checkProject(p), checkProject(p, { profile: 'game' }), checkProject(p, { profile: 'game', cullHidden: true })].map((r) =>
        r.filter((i) => /z-fighting/.test(i.message)).map((i) => i.message),
      );
      expect(all[1]).toEqual(all[0]); // profil ve cullHidden'dan bağımsız
      expect(all[2]).toEqual(all[0]);
      return all[0];
    };
    const area = (m: string) => Number(/örtüşme ≈([\d.]+) mm²/.exec(m)![1]);
    // İstekteki gibi: a (y −20…30) ile b'nin arka yüzleri y = 30'da çakışık, x 0…100 × z 470…530 = 6000 mm²; duvar y 0…200.
    const a = box('a', 200, 50, 100, [0, 5, 500]);
    const b = box('b', 200, 40, 60, [100, 10, 500]); // ön yüzü a'nınkinden ayrık (y −10)
    const wall = (extra: Partial<Op> = {}) => box('duvar', 1000, 200, 1000, [0, 100, 500], extra);
    expect(zf([a, b])).toHaveLength(1);
    expect(area(zf([a, b])[0])).toBeCloseTo(6000, 1);
    expect(zf([wall(), a, b])).toEqual([]);
    // İstekteki b (y −20…30): ön yüzler de y = −20'de çakışık ve duvarın dışında: yalnızca onlar kalır (12 000 → 6000).
    const b50 = box('b', 200, 50, 60, [100, 5, 500]);
    expect(area(zf([a, b50])[0])).toBeCloseTo(12000, 1);
    const front = zf([wall(), a, b50]);
    expect(front).toHaveLength(1);
    expect(front[0]).toMatch(/normal 0\.00, -1\.00, 0\.00, düzlem 20\.00 mm, örtüşme ≈6000\.00 mm²/);
    // Saydam duvar örtmez (ayıklamadaki gibi); arka yüzler duvar yüzeyinde (y = 0) de gizli.
    expect(zf([wall({ opacity: 0.5 }), a, b])).toHaveLength(1);
    expect(zf([wall(), box('a', 200, 50, 100, [0, -25, 500]), box('b', 200, 40, 60, [100, -20, 500])])).toEqual([]);
    // Duvar iki bloktan, birleşim çizgisi örtüşmenin ortasında (x = 50): her nokta bir bloğun içinde → gizli.
    const blocks = [box('d1', 550, 200, 1000, [-225, 100, 500]), box('d2', 450, 200, 1000, [275, 100, 500])];
    expect(zf([...blocks, a, b])).toEqual([]);
    // Yalnız x < 50'yi örten duvar: görünen yarı (3000 mm²) bildirilir (bölme yaklaşığı: %1).
    const half = zf([blocks[0], a, b]);
    expect(half).toHaveLength(1);
    expect(area(half[0]) / 3000 - 1).toBeGreaterThanOrEqual(0);
    expect(area(half[0]) / 3000 - 1).toBeLessThan(0.01);
    // Aynı düzlemde aynı yöne bakan üçüncü parça (c'nin arka yüzü de y = 30) örtmez: üç çift de titreşir.
    expect(zf([box('c', 300, 100, 300, [0, -20, 500]), a, b])).toHaveLength(3);
    // Eğik düzlemde de: sahne birlikte döndürülünce aynı sonuç.
    const turned = (ops: Op[]) => [...ops, { op: 'group', parts: ops.map((o) => (o as { name: string }).name), name: 'g' } as Op, { op: 'rotate', part: 'g', axis: 'z', degrees: 37 } as Op, { op: 'rotate', part: 'g', axis: 'x', degrees: 23 } as Op];
    expect(zf(turned([wall(), a, b]))).toEqual([]);
    expect(area(zf(turned([a, b]))[0])).toBeCloseTo(6000, -1);
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

  it('büyük gövde (1 m) ızgara bütçesiyle üretilir: kutu tablosu tam hacim, yer tutucuya düşmez', () => {
    // Eskiden kenar boyu mutlak (0,35 mm) olduğundan ızgara milyarlarca noktaya çıkıp WASM belleğini aşıyordu.
    const p = project([hull([-500, 0, 500].map((x) => ({ x, keel: 0, sheer: 300, breadth: [250, 250, 250] })))]);
    const s = solid(p, 'tekne');
    expect(s.bad).toBe(0);
    expect(s.vol / (1000 * 500 * 300)).toBeCloseTo(1, 2);
    expect([s.box.min.x, s.box.max.x, s.box.min.y, s.box.max.y, s.box.min.z, s.box.max.z]).toEqual(
      [-500, 500, -250, 250, 0, 300].map((v) => expect.closeTo(v, 0)),
    );
    expect(checkProject(p).filter((i) => i.level === 'hata')).toEqual([]);
  }, 30000);

  it('büyük gövde küçüğünün ölçekli kopyasıdır (eğri tablo, 10 kat)', () => {
    const st = (k: number) => [
      { x: 0, keel: 1 * k, sheer: 8 * k, breadth: [0, 0, 0] },
      { x: 15 * k, keel: 0, sheer: 7 * k, breadth: [3 * k, 7 * k, 9 * k] },
      { x: 45 * k, keel: 0, sheer: 7 * k, breadth: [4 * k, 8 * k, 10 * k] },
      { x: 60 * k, keel: 0.5 * k, sheer: 7.5 * k, breadth: [3 * k, 6 * k, 7 * k] },
    ];
    const small = solid(project([hull(st(1))]), 'tekne');
    const big = solid(project([hull(st(10))]), 'tekne');
    expect(big.bad).toBe(0);
    expect(big.vol / small.vol / 1000).toBeCloseTo(1, 1);
    const [a, b] = [small.box.getSize(new THREE.Vector3()), big.box.getSize(new THREE.Vector3())];
    expect([b.x / a.x, b.y / a.y, b.z / a.z]).toEqual([10, 10, 10].map((v) => expect.closeTo(v, 0)));
  }, 30000);

  it('örtük yüzey ızgarası sınırı aşarsa WASM çağrılmadan reddedilir, çekirdek bozulmaz', () => {
    const ball = (r: number) => (p: [number, number, number]) => r - Math.hypot(...p);
    expect(() => levelSetGeometry(ball(500), { min: [-501, -501, -501], max: [501, 501, 501] }, 0.35)).toThrow(/ızgarası çok büyük/);
    const g = levelSetGeometry(ball(5), { min: [-6, -6, -6], max: [6, 6, 6] }, 0.5);
    expect(g.getIndex()!.count).toBeGreaterThan(0);
    g.dispose();
  });

  // 2,2 m'lik muz gövdesi (BoltRush): sivri uçlar, eğri omurga.
  const banana = (maxTris?: number) =>
    create('tekne', 'hull' as never, {
      kind: 'hull',
      maxTris,
      stations: [
        [-1090, 370, 400, [0, 0, 0, 0]], [-990, 220, 455, [50, 90, 90, 50]], [-840, 100, 455, [170, 270, 270, 160]],
        [-620, 15, 435, [300, 440, 450, 300]], [-430, -20, 412, [360, 535, 545, 360]], [-100, -32, 398, [400, 585, 595, 400]],
        [220, -22, 402, [385, 565, 572, 385]], [450, 0, 420, [330, 505, 520, 330]], [700, 45, 440, [255, 420, 430, 255]],
        [920, 130, 462, [150, 255, 265, 145]], [1080, 270, 480, [55, 90, 90, 50]], [1165, 405, 430, [0, 0, 0, 0]],
      ].map(([x, keel, sheer, breadth]) => ({ x, keel, sheer, breadth })),
    } as never);

  it('maxTris üçgen bütçesi: ağ bütçeyi aşmaz, şekil korunur, bozuk üçgen yok', () => {
    const tris = (p: Project) => worldMesh(p, p.parts[0]).tris.length / 3;
    const p1 = project([banana(1000)]);
    const p4 = project([banana(4000)]);
    p1.settings.resolution = 12;
    expect(p1.parts[0].geom).toMatchObject({ maxTris: 1000 });
    const [a, b] = [solid(p1, 'tekne'), solid(p4, 'tekne')];
    expect(a.bad).toBe(0);
    expect(tris(p1)).toBeLessThanOrEqual(1000);
    expect(tris(p1)).toBeGreaterThan(800);
    expect(tris(p4)).toBeLessThanOrEqual(4000);
    expect(Math.abs(a.vol / b.vol - 1)).toBeLessThan(0.01);
    expect(a.box.getSize(new THREE.Vector3()).toArray()).toEqual([2255, 1190, 512].map((v) => expect.closeTo(v, -1)));
    expect(checkProject(p1, { profile: 'game' }).filter((i) => /bozuk/.test(i.message))).toEqual([]);
    // Çok küçük bütçe de kapalı ağ ve yakın hacim verir (kesimden sonra sadeleştirilir, gövde çökmez).
    const p0 = project([banana(200)]);
    expect(tris(p0)).toBeLessThanOrEqual(200);
    expect(Math.abs(solid(p0, 'tekne').vol / b.vol - 1)).toBeLessThan(0.03);
    // Alt sınır 20 (BoltRush #27: bitki öbeği, saksı): kapalı ağ, bütçe içinde, bozuk üçgen yok. Köşeler yüzeyde kaldığından
    // sivri uçlu gövde küçülür (çalı 20 üçgende ~−%33, 60'ta ~−%2); düz aynalı saksı ~−%4.
    const bush = (maxTris: number) =>
      create('tekne', 'hull' as never, {
        kind: 'hull',
        maxTris,
        stations: [
          [-200, 40, 220, [0, 0, 0, 0]], [-120, 10, 280, [80, 120, 110, 60]], [0, 0, 300, [110, 150, 140, 80]],
          [120, 10, 280, [80, 120, 110, 60]], [200, 40, 220, [0, 0, 0, 0]],
        ].map(([x, keel, sheer, breadth]) => ({ x, keel, sheer, breadth })),
      } as never);
    const full = solid(project([bush(4000)]), 'tekne').vol;
    for (const [m, loss] of [[20, 0.4], [60, 0.05]]) {
      const p = project([bush(m)]);
      const s = solid(p, 'tekne');
      expect(s.bad).toBe(0);
      expect(tris(p)).toBeLessThanOrEqual(m);
      expect(tris(p)).toBeGreaterThan(m * 0.8);
      expect(1 - s.vol / full).toBeLessThan(loss);
      expect(checkProject(p, { profile: 'game' }).filter((i) => i.level === 'hata' || /bozuk/.test(i.message))).toEqual([]);
    }
    // İnce/uzun gövde (genişlik 20 ya da 2 mm, yükseklik 5, boy 1000 mm) sınırsız sapmalı sadeleştirmede kendi üstüne çökebiliyordu (boş ağ ya da hacmin
    // %1'i, hata yok): büyük ön hedeflerle de denenir; hiçbiri yetmezse bütçe önerisiyle işlem hatası.
    const thin = (w: number, maxTris: number) => {
      const p = newProject();
      const r = applyOps(p, [create('ince', 'hull' as never, { kind: 'hull', maxTris, stations: [0, 500, 1000].map((x) => ({ x, keel: 0, sheer: 5, breadth: [w, w, w] })) } as never)], null);
      return { p, err: r.errors.join(' ') };
    };
    const t10 = thin(10, 20);
    expect(t10.err).toBe('');
    expect(tris(t10.p)).toBeLessThanOrEqual(20);
    expect(solid(t10.p, 'ince').bad).toBe(0);
    expect(solid(t10.p, 'ince').vol / 100000).toBeGreaterThan(0.9);
    const t1 = thin(1, 20);
    expect(t1.err).toMatch(/sadeleştirilemiyor \(maxTris 20: .*maxTris en az ~\d+ verin/);
    expect(t1.p.parts).toHaveLength(0);
  }, 60000);

  it('maxTris doğrulama: aralık dışı hata, 0 ya da null varsayılan, kesir yuvarlanır', () => {
    const geomOf = (maxTris: unknown) => {
      const p = newProject();
      const r = applyOps(p, [hull([0, 5, 10].map((x) => ({ x, keel: 0, sheer: 5, breadth: [3, 3, 3] })))].map((op) => ({ ...op, geom: { ...(op as { geom: object }).geom, maxTris } }) as Op), null);
      return { err: r.errors.join(' '), geom: p.parts[0]?.geom as { maxTris?: number } | undefined };
    };
    expect(geomOf(10).err).toMatch(/maxTris.*20/);
    expect(geomOf(20).err).toBe('');
    expect(geomOf(20).geom?.maxTris).toBe(20);
    expect(geomOf(2e6).err).toMatch(/maxTris/);
    expect(geomOf('çok').err).toMatch(/maxTris/);
    expect(geomOf(0).geom).not.toHaveProperty('maxTris');
    expect(geomOf(null).geom).not.toHaveProperty('maxTris');
    expect(geomOf(1500.4).geom?.maxTris).toBe(1500);
  });

  it('doğrulama: eşit olmayan genişlik sayısı, ters omurga/küpeşte reddedilir', () => {
    const err = (st: { x: number; keel: number; sheer: number; breadth: number[] }[]) => applyOps(newProject(), [hull(st)], null).errors.join(' ');
    expect(err([{ x: 0, keel: 0, sheer: 5, breadth: [1, 2] }, { x: 5, keel: 0, sheer: 5, breadth: [1, 2, 3] }])).toMatch(/aynı \(2\)/);
    expect(err([{ x: 0, keel: 5, sheer: 1, breadth: [1, 2] }, { x: 5, keel: 0, sheer: 5, breadth: [1, 2] }])).toMatch(/yüksek olmalı/);
  });
});

describe('kutu: partBox kesimsiz, solidBox delikler çıkarılmış (BoltRush isteği #11)', () => {
  const box = (name: string, w: number, d: number, h: number, at: [number, number, number], extra: Partial<Op> = {}) =>
    ({
      op: 'create',
      shape: 'box',
      name,
      params: [{ name: 'width', value: w }, { name: 'depth', value: d }, { name: 'height', value: h }],
      position: { x: at[0], y: at[1], z: at[2] },
      ...extra,
    }) as Op;
  const meshBox = (p: Project, name: string) => {
    const m = worldMesh(p, p.parts.find((q) => q.name === name)!);
    const b = new THREE.Box3();
    for (const i of m.tris) b.expandByPoint(new THREE.Vector3(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]));
    return b;
  };

  it('kesilen parçada dışa aktarılan ağın kutusu; kesimsiz kutu değişmez', () => {
    const p = newProject();
    const r = applyOps(p, [box('govde', 100, 100, 100, [0, 0, 50]), box('kesik', 60, 120, 120, [30, 0, 50], { role: 'hole', cuts: ['govde'] })], null);
    expect(r.errors).toEqual([]);
    const solids = exportableParts(p.parts);
    expect(partsBox(solids, p.settings.resolution).max.x).toBeCloseTo(50, 6); // sözleşme: şeklin kutusu
    const sb = solidPartsBox(p, solids);
    expect(sb.max.x).toBeCloseTo(0, 4);
    expect(sb.min.toArray()).toEqual([-50, -50, 0].map((v) => expect.closeTo(v, 4)));
    expect(sb.max.toArray()).toEqual(meshBox(p, 'govde').max.toArray().map((v) => expect.closeTo(v, 4)));
    // Delik parçasının kendi kutusu (solidBox katı olmayanda partBox'tır).
    const hole = p.parts.find((q) => q.name === 'kesik')!;
    expect(solidBox(p, hole).equals(partBox(hole, p.settings.resolution))).toBe(true);
  });

  it('döndürülmüş parça, deliksiz parça ve tümüyle kesilen parça', () => {
    const p = newProject();
    applyOps(
      p,
      [
        box('a', 100, 40, 20, [0, 0, 10], { rotation: { x: 0, y: 0, z: 90 } }),
        box('ka', 50, 50, 50, [0, 40, 10], { role: 'hole', cuts: ['a'] }),
        box('b', 10, 10, 10, [200, 0, 5]),
        box('c', 10, 10, 10, [-200, 0, 5]),
        box('kc', 20, 20, 20, [-200, 0, 5], { role: 'hole', cuts: ['c'] }),
      ],
      null,
    );
    const get = (n: string) => p.parts.find((q) => q.name === n)!;
    // 'a' döndürülünce y −50…50; delik y 15…65'i alır → y −50…15.
    const a = solidBox(p, get('a'));
    expect(a.min.y).toBeCloseTo(-50, 4);
    expect(a.max.y).toBeCloseTo(15, 4);
    expect(a.max.toArray()).toEqual(meshBox(p, 'a').max.toArray().map((v) => expect.closeTo(v, 4)));
    expect(solidBox(p, get('b')).equals(partBox(get('b'), p.settings.resolution))).toBe(true);
    expect(solidBox(p, get('c')).isEmpty()).toBe(true);
    // Önbellek: parça taşınınca kutu da taşınır (y −60…40; delik y 15…65'i almaya devam eder).
    applyOps(p, [{ op: 'move', part: 'a', dx: 0, dy: -10, dz: 0 } as Op], null);
    const moved = solidBox(p, get('a'));
    expect(moved.min.y).toBeCloseTo(-60, 4);
    expect(moved.max.y).toBeCloseTo(15, 4);
  });
});

describe('prizma köşe fazı (rehber: modeling.md, BoltRush isteği #13)', () => {
  const zRange = (n: number, rotation: { x: number; y: number; z: number }) => {
    const p = newProject();
    applyOps(
      p,
      [{ op: 'create', shape: 'prism', name: 'p', params: [{ name: 'sides', value: n }, { name: 'diameter', value: 1000 }, { name: 'height', value: 100 }], position: { x: 0, y: 0, z: 600 }, rotation } as Op],
      null,
    );
    const part = p.parts[0];
    const b = partBox(part, 12);
    return { below: part.position.z - b.min.z, above: b.max.z - part.position.z };
  };
  const apothem = (n: number) => 500 * Math.cos(Math.PI / n);

  it('eksen Y (x 90) her n için düz taban; eksen X (y 90) yalnız n 4\'ün katıysa, değilse rotation.z = 90 mod (360/n)', () => {
    for (let n = 3; n <= 16; n++) {
      expect(zRange(n, { x: 90, y: 0, z: 0 }).below, `x90 n=${n}`).toBeCloseTo(apothem(n), 3);
      const plain = zRange(n, { x: 0, y: 90, z: 0 }).below;
      if (n % 4 === 0) expect(plain, `y90 n=${n}`).toBeCloseTo(apothem(n), 3);
      if (n % 4 === 2) expect(plain, `y90 n=${n}`).toBeCloseTo(500, 3);
      expect(zRange(n, { x: 0, y: 90, z: 90 % (360 / n) }).below, `y90+faz n=${n}`).toBeCloseTo(apothem(n), 3);
    }
    // Boltrush ölçümü (çap 1000, y 90): n = 4 ±353,6; 6 ±500; 8 ±461,9; 10 ±500; 12 ±483.
    expect([4, 6, 8, 10, 12].map((n) => Math.round(zRange(n, { x: 0, y: 90, z: 0 }).above * 10) / 10)).toEqual([353.6, 500, 461.9, 500, 483]);
  });
});
