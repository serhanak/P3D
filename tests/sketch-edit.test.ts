import { describe, expect, it } from 'vitest';
import type { SketchPath, SketchPoint, Vec3 } from '../shared/ops';
import { samplePath } from '../src/sketch';
import {
  closestSegment,
  defaultPlane,
  dominantAxis,
  edgeSamples,
  handlesFromDrag,
  hitEdge,
  hitPoint,
  movePoints,
  nearestCandidate,
  rayAxisCoord,
  rayPlane,
  removePoints,
  roundPoints,
  setAxisCoord,
  snapCandidates,
  snapPoint,
  snapValue,
  splitEdge,
} from '../src/sketch-edit';

// Kalem aracının saf matematiği (sketch-edit.ts): düzlem seçimi, ışın kesişimleri, yakalama, nokta düzenleme, isabet.

const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const P = (x: number, y: number, z: number, hIn?: Vec3, hOut?: Vec3): SketchPoint => ({
  p: V(x, y, z),
  ...(hIn ? { hIn } : {}),
  ...(hOut ? { hOut } : {}),
});
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z);
  return V(v.x / l, v.y / l, v.z / l);
};
const dir = (from: Vec3, to: Vec3) => norm(V(to.x - from.x, to.y - from.y, to.z - from.z));
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const path = (points: SketchPoint[], closed = false): SketchPath => ({ id: 't', name: 't', closed, plane: { axis: 'z', at: 0 }, points });

describe('düzlem', () => {
  it('dominantAxis: |bileşen| en büyük eksen; eşitlikte z', () => {
    expect(dominantAxis(V(0.1, -0.2, -0.97))).toBe('z');
    expect(dominantAxis(V(-0.55, 0.65, -0.5))).toBe('y'); // varsayılan izometrik kamera
    expect(dominantAxis(V(-0.9, 0.3, 0.1))).toBe('x');
    expect(dominantAxis(V(1, 1, 1))).toBe('z');
  });

  it('defaultPlane: seçili kutunun kameraya bakan yüzü; kutu yoksa 0', () => {
    const box = { min: V(-10, -20, 0), max: V(10, 20, 5) };
    const t = V(0, 0, 0);
    expect(defaultPlane('z', V(50, -50, 200), t, box)).toEqual({ axis: 'z', at: 5 }); // üstten: üst yüz
    expect(defaultPlane('z', V(50, -50, -200), t, box)).toEqual({ axis: 'z', at: 0 }); // alttan: alt yüz
    expect(defaultPlane('y', V(0, -300, 20), t, box)).toEqual({ axis: 'y', at: -20 }); // önden (−y): ön yüz
    expect(defaultPlane('y', V(0, 300, 20), t, box)).toEqual({ axis: 'y', at: 20 }); // arkadan: arka yüz
    expect(defaultPlane('x', V(300, 0, 20), t, box)).toEqual({ axis: 'x', at: 10 });
    expect(defaultPlane('x', V(-300, 0, 20), t, box)).toEqual({ axis: 'x', at: -10 });
    expect(defaultPlane('z', V(0, 0, 100), t, null)).toEqual({ axis: 'z', at: 0 });
  });
});

describe('ışın kesişimleri', () => {
  it('rayPlane: kesişim, paralel ışın ve arkada kalan düzlem', () => {
    const o = V(0, -100, 100);
    const target = V(12, 7, 5);
    const hit = rayPlane(o, dir(o, target), { axis: 'z', at: 5 })!;
    expect(dist(hit, target)).toBeLessThan(1e-9);
    expect(hit.z).toBe(5); // eksen bileşeni tam düzlemde
    expect(rayPlane(o, V(1, 0, 0), { axis: 'z', at: 0 })).toBeNull(); // paralel
    expect(rayPlane(o, V(0, 0, 1), { axis: 'z', at: 0 })).toBeNull(); // düzlem arkada
    const side = rayPlane(V(-50, 3, 4), V(1, 0, 0), { axis: 'x', at: 10 })!;
    expect(side).toEqual(V(10, 3, 4));
  });

  it('rayPlane: sığ açı (≈ 3°\'den az) yok sayılır; dev koordinat üretmez; yön birim olmasa da aynı', () => {
    const o = V(0, 0, 100);
    const at = (deg: number) => V(Math.cos((deg * Math.PI) / 180), 0, -Math.sin((deg * Math.PI) / 180));
    expect(rayPlane(o, at(2), { axis: 'z', at: 0 })).toBeNull(); // 100 / tan 2° ≈ 2864 mm ötede olurdu
    expect(rayPlane(o, at(2.8), { axis: 'z', at: 0 })).toBeNull();
    const hit = rayPlane(o, at(3.5), { axis: 'z', at: 0 })!;
    expect(hit.x).toBeCloseTo(100 / Math.tan((3.5 * Math.PI) / 180), 6);
    const d = at(2);
    expect(rayPlane(o, V(d.x * 50, 0, d.z * 50), { axis: 'z', at: 0 })).toBeNull(); // ölçekli yön de reddedilir
    expect(rayPlane(o, V(0, 0, 0), { axis: 'z', at: 0 })).toBeNull();
  });

  it('rayAxisCoord: eksen doğrusunda işaretçinin karşılığı; eksen boyunca bakışta null', () => {
    // Önden-üstten bakan kamera, z ekseni (0, 0, 0)'dan geçer: (0, 0, 15)'e giden ışın → z = 15.
    const cam = V(0, -100, 100);
    const view = dir(cam, V(0, 0, 0));
    expect(rayAxisCoord(cam, dir(cam, V(0, 0, 15)), V(0, 0, 0), 'z', view)).toBeCloseTo(15, 9);
    // Işın doğrunun yanından geçse de en yakın koordinat: (8, 0, -6)'ya giden ışın → z = −6.
    expect(rayAxisCoord(cam, dir(cam, V(8, 0, -6)), V(0, 0, 0), 'z', view)).toBeCloseTo(-6, 9);
    // Eğik izometrik kamera, x ekseni (0, 10, 5)'ten geçer.
    const iso = V(200, -240, 190);
    const isoView = dir(iso, V(0, 0, 0));
    expect(rayAxisCoord(iso, dir(iso, V(-30, 10, 5)), V(0, 10, 5), 'x', isoView)).toBeCloseTo(-30, 9);
    // Tam (ya da neredeyse, "Üst" görünümü gibi) üstten bakarken z ekseni ekranda noktadır: tanımsız / kötü koşullu.
    expect(rayAxisCoord(V(0, 0, 100), V(0, 0, -1), V(0, 0, 0), 'z', V(0, 0, -1))).toBeNull();
    const top = norm(V(0, 0.001, -1));
    expect(rayAxisCoord(V(0, -0.1, 100), dir(V(0, -0.1, 100), V(3, 2, 0)), V(0, 0, 0), 'z', top)).toBeNull();
  });
});

describe('yakalama', () => {
  it('snapValue ve snapPoint (fixedAxis bileşenine dokunmaz)', () => {
    expect(snapValue(12.4, 1)).toBe(12);
    expect(snapValue(-0.4, 1)).toBe(0);
    expect(Object.is(snapValue(-0.4, 1), -0)).toBe(false);
    expect(snapValue(0.3, 0.25)).toBe(0.25);
    expect(snapValue(7.77, 0)).toBe(7.77);
    expect(snapPoint(V(1.4, 2.6, 3.33), 1, 'z')).toEqual(V(1, 3, 3.33));
    expect(snapPoint(V(1.4, 2.6, 3.33), 1)).toEqual(V(1, 3, 3));
  });

  it('snapCandidates: kutu başına 8 köşe + 6 yüz merkezi + merkez, ardından eskiz noktaları; nearestCandidate toleransla', () => {
    const c = snapCandidates([{ min: V(0, 0, 0), max: V(10, 20, 4) }], [V(50, 50, 0)]);
    expect(c).toHaveLength(16);
    expect(c).toContainEqual(V(10, 20, 4));
    expect(c).toContainEqual(V(5, 10, 4)); // üst yüz merkezi
    expect(c).toContainEqual(V(5, 10, 2)); // merkez
    expect(c[15]).toEqual(V(50, 50, 0));
    expect(nearestCandidate(V(9.6, 19.5, 4), c, 1)).toEqual(V(10, 20, 4));
    expect(nearestCandidate(V(30, 30, 0), c, 1)).toBeNull();
  });
});

describe('nokta düzenleme', () => {
  it('handlesFromDrag: çıkış tutamacı sürükleme yönünde, giriş tersi', () => {
    expect(handlesFromDrag(V(10, 0, 5), V(14, 3, 5))).toEqual({ hIn: V(-4, -3, 0), hOut: V(4, 3, 0) });
  });

  it('movePoints yalnızca seçili noktaları taşır, tutamaçlar (göreli) aynı kalır; girdi değişmez', () => {
    const pts = [P(0, 0, 0), P(10, 0, 0, V(-2, 0, 0), V(2, 0, 0)), P(20, 0, 0)];
    const snap = JSON.stringify(pts);
    const out = movePoints(pts, [1, 2], V(0, 0, 7));
    expect(out.map((pt) => pt.p)).toEqual([V(0, 0, 0), V(10, 0, 7), V(20, 0, 7)]);
    expect(out[1].hIn).toEqual(V(-2, 0, 0));
    expect(out[1].hOut).toEqual(V(2, 0, 0));
    expect(JSON.stringify(pts)).toBe(snap);
  });

  it('setAxisCoord yalnızca eksen bileşenini değiştirir; removePoints ve roundPoints', () => {
    const pts = [P(1, 2, 3), P(4, 5, 6, undefined, V(1, 0, 0)), P(7, 8, 9)];
    const out = setAxisCoord(pts, [0, 1], 'z', 15);
    expect(out.map((pt) => pt.p)).toEqual([V(1, 2, 15), V(4, 5, 15), V(7, 8, 9)]);
    expect(out[1].hOut).toEqual(V(1, 0, 0));
    expect(removePoints(pts, [0, 2])).toEqual([P(4, 5, 6, undefined, V(1, 0, 0))]);
    expect(roundPoints([P(1.23456, -0.0001, 2, V(0.0001, 0, 0), V(1.00049, 0, 0))])).toEqual([{ p: V(1.235, 0, 2), hOut: V(1, 0, 0) }]);
  });

  it('splitEdge: düz kenara köşe noktası; eğri kenarı şeklini koruyarak böler (kapalı yolun son kenarı dahil)', () => {
    const sq = [P(0, 0, 0), P(10, 0, 0), P(10, 10, 0), P(0, 10, 0)];
    expect(splitEdge(sq, true, 3, 0.5).map((pt) => pt.p)).toEqual([V(0, 0, 0), V(10, 0, 0), V(10, 10, 0), V(0, 10, 0), V(0, 5, 0)]);
    expect(splitEdge(sq, false, 0, 0.25)[1].p).toEqual(V(2.5, 0, 0));

    const curve = [P(0, 0, 0, undefined, V(0, 10, 0)), P(20, 0, 0, V(0, 10, 0))];
    const before = samplePath(path(curve), 64);
    const t = 0.3;
    const split = splitEdge(curve, false, 0, t);
    expect(split).toHaveLength(3);
    // Yeni nokta eğrinin t'deki noktası; iki yarının örnekleri orijinal eğrinin üstünde.
    expect(dist(split[1].p, before[Math.round(t * 64)])).toBeLessThan(0.3);
    for (const v of samplePath(path(split), 32)) expect(closestSegment(before, false, v).dist).toBeLessThan(0.02);
    // Uçlar yerinde, eğri yine iki uçtan geçer.
    expect(split[0].p).toEqual(V(0, 0, 0));
    expect(split[2].p).toEqual(V(20, 0, 0));
  });

  it('closestSegment: kapalı yolda son → ilk kenarı da dener', () => {
    const sq = [V(0, 0, 0), V(10, 0, 0), V(10, 10, 0), V(0, 10, 0)];
    const c = closestSegment(sq, true, V(-1, 4, 0));
    expect(c.index).toBe(3);
    expect(c.t).toBeCloseTo(0.6, 9);
    expect(c.dist).toBeCloseTo(1, 9);
    expect(c.point).toEqual(V(0, 4, 0));
    expect(closestSegment(sq, false, V(-1, 4, 0)).index).toBe(0); // açık yolda o kenar yok
    expect(closestSegment([V(1, 1, 1)], false, V(1, 1, 3)).dist).toBe(2);
  });
});

describe('ekran isabeti', () => {
  it('hitPoint: yarıçap içindeki en yakın nokta; kamera arkasındakiler (null) atlanır', () => {
    const scr = [{ x: 100, y: 100 }, null, { x: 106, y: 100 }, { x: 300, y: 300 }];
    expect(hitPoint(scr, 104, 100, 8)).toBe(2);
    expect(hitPoint(scr, 101, 100, 8)).toBe(0);
    expect(hitPoint(scr, 200, 200, 8)).toBe(-1);
    expect(hitPoint([], 0, 0, 8)).toBe(-1);
  });

  it('hitEdge: kenar indeksi ve Bezier parametresi; edgeSamples eğri kenarı örnekler', () => {
    const p = path([P(0, 0, 0), P(10, 0, 0, undefined, V(2, 2, 0)), P(20, 0, 0, V(-2, 2, 0)), P(30, 0, 0)]);
    expect(edgeSamples(p, 0)).toHaveLength(2); // düz kenar: iki uç
    expect(edgeSamples(p, 1, 8)).toHaveLength(9); // eğri kenar: 8 parça
    // Ekran = dünya x, y (birebir izdüşüm varsayımı).
    const toScr = (v: Vec3) => ({ x: v.x, y: v.y });
    const edges = [0, 1, 2].map((i) => edgeSamples(p, i, 8).map(toScr));
    const h = hitEdge(edges, 25, 1, 3)!;
    expect(h.edge).toBe(2);
    expect(h.t).toBeCloseTo(0.5, 9);
    expect(hitEdge(edges, 2.5, 0, 3)).toEqual({ edge: 0, t: 0.25, dist: 0 });
    expect(hitEdge(edges, 15, -20, 3)).toBeNull();
  });
});
