// Eskiz düzenleyicisinin saf matematiği (DOM ve three.js yok; Node'da test edilir): çizim düzlemi seçimi, ışın–düzlem /
// ışın–eksen kesişimi, yakalama, nokta taşıma, kenara nokta ekleme, ekran isabet testleri. Kalem aracı (sketch-tool.ts)
// bunları kullanır; sonuçlar Op olarak (`sketch_add` / `sketch_update`) uygulanır.
import type { GeomAxis, SketchPath, SketchPlane, SketchPoint, Vec3 } from '../shared/ops';
import { samplePath } from './sketch';

const AXES: readonly GeomAxis[] = ['x', 'y', 'z'];
const EPS = 1e-9;
/** Eksen ile bakış yönü arasındaki açının sinüsü bundan küçükse eksen boyunca ışın hesabı yapılmaz (≈ 11,5°). */
export const AXIS_MIN_SIN = 0.2;
/** Işın ile düzlem arasındaki açının sinüsü bundan küçükse kesişim yok sayılır (≈ 3°; ufka yakın dev koordinatlar). */
export const PLANE_MIN_SIN = 0.05;

type Box = { min: Vec3; max: Vec3 };
type Screen = { x: number; y: number };

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const unit = (axis: GeomAxis): Vec3 => ({ x: axis === 'x' ? 1 : 0, y: axis === 'y' ? 1 : 0, z: axis === 'z' ? 1 : 0 });
/** Sıfır uzunluklu tutamaç yok sayılır (köşe). */
const handle = (h: Vec3): Vec3 | undefined => (len(h) > EPS ? h : undefined);

const copyPoint = (pt: SketchPoint): SketchPoint => ({
  p: { ...pt.p },
  ...(pt.hIn ? { hIn: { ...pt.hIn } } : {}),
  ...(pt.hOut ? { hOut: { ...pt.hOut } } : {}),
});

// ---------------------------------------------------------------------------
// Düzlem

/** Bileşeninin mutlak değeri en büyük eksen (kamera bakış yönü → çizim düzlemi ekseni); eşitlikte z, sonra y. */
export function dominantAxis(dir: Vec3): GeomAxis {
  const [ax, ay, az] = [Math.abs(dir.x), Math.abs(dir.y), Math.abs(dir.z)];
  if (az >= ax && az >= ay) return 'z';
  return ay >= ax ? 'y' : 'x';
}

/**
 * Kalem açılırken varsayılan çizim düzlemi. Seçili parçanın kutusu verilirse kameraya bakan yüzü: kamera hedefin eksende
 * büyük tarafındaysa kutunun `max`'ı, değilse `min`'i (üstten bakınca üst yüz, önden bakınca ön yüz). Kutu yoksa eksende 0.
 */
export function defaultPlane(axis: GeomAxis, cameraPos: Vec3, target: Vec3, selectedBox: Box | null): SketchPlane {
  if (!selectedBox) return { axis, at: 0 };
  return { axis, at: cameraPos[axis] > target[axis] ? selectedBox.max[axis] : selectedBox.min[axis] };
}

/** Noktanın düzleme dik izdüşümü (eksen bileşeni `at` olur). */
export function onPlane(p: Vec3, plane: SketchPlane): Vec3 {
  return { ...p, [plane.axis]: plane.at };
}

// ---------------------------------------------------------------------------
// Işın kesişimleri

/**
 * Işın (origin + t·dir, t ≥ 0) ile düzlemin kesişimi. Işın düzleme paralelse ya da çok sığ açıyla geliyorsa (≈ 3°'den az:
 * küçük işaretçi hareketi dev kayma, ufukta binlerce mm), ya da düzlem arkada kalıyorsa null.
 */
export function rayPlane(origin: Vec3, dir: Vec3, plane: SketchPlane): Vec3 | null {
  const d = dir[plane.axis];
  const l = len(dir);
  if (l < EPS || Math.abs(d) < PLANE_MIN_SIN * l) return null;
  const t = (plane.at - origin[plane.axis]) / d;
  if (t < 0) return null;
  return onPlane(add(origin, mul(dir, t)), plane);
}

/**
 * `through`'dan geçen `axis` doğrusu üzerinde işaretçinin karşılığı (eksen koordinatı). Işın, doğruyu içeren ve kameraya
 * bakan düzlemle (normal = bakış yönünün eksene dik bileşeni) kesilir; kesişimin eksen bileşeni döner. Kamera eksen
 * boyunca (≈ 12°'den dar açıyla) bakıyorsa sonuç kötü koşulludur (küçük hareket dev kayma): null; ışın o düzleme paralelse ya
 * da düzlem arkadaysa da null.
 */
export function rayAxisCoord(origin: Vec3, dir: Vec3, through: Vec3, axis: GeomAxis, viewDir: Vec3): number | null {
  const e = unit(axis);
  const vl = len(viewDir);
  if (vl < EPS) return null;
  const v = mul(viewDir, 1 / vl);
  const n = sub(v, mul(e, dot(v, e)));
  const nl = len(n);
  if (nl < AXIS_MIN_SIN) return null;
  const denom = dot(dir, n) / nl;
  if (Math.abs(denom) < EPS) return null;
  const t = dot(sub(through, origin), n) / nl / denom;
  if (t < 0) return null;
  return origin[axis] + t * dir[axis];
}

// ---------------------------------------------------------------------------
// Yakalama

/** `step`'in en yakın katı (step ≤ 0 ya da sonlu değilse değer olduğu gibi). */
export function snapValue(v: number, step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return v;
  return Number((Math.round(v / step) * step).toFixed(6)) + 0; // + 0: -0 yerine 0
}

/** Noktayı ızgaraya yakalar; `fixedAxis` bileşenine dokunulmaz (çizim düzleminin kendi konumu korunur). */
export function snapPoint(p: Vec3, step: number, fixedAxis?: GeomAxis): Vec3 {
  const out = { ...p };
  for (const a of AXES) if (a !== fixedAxis) out[a] = snapValue(p[a], step);
  return out;
}

/** Yakalama adayları: her kutunun 8 köşesi, 6 yüz merkezi ve merkezi; ardından eskiz noktaları. */
export function snapCandidates(boxes: Box[], sketchPoints: Vec3[]): Vec3[] {
  const out: Vec3[] = [];
  for (const b of boxes) {
    const c = lerp(b.min, b.max, 0.5);
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.push({ x, y, z });
    for (const a of AXES) for (const v of [b.min[a], b.max[a]]) out.push({ ...c, [a]: v });
    out.push(c);
  }
  for (const p of sketchPoints) out.push({ ...p });
  return out;
}

/** `maxDist` içindeki en yakın aday (yoksa null). */
export function nearestCandidate(p: Vec3, candidates: Vec3[], maxDist: number): Vec3 | null {
  let best: Vec3 | null = null;
  let bestD = maxDist;
  for (const c of candidates) {
    const d = len(sub(c, p));
    if (d <= bestD) {
      bestD = d;
      best = c;
    }
  }
  return best ? { ...best } : null;
}

// ---------------------------------------------------------------------------
// Nokta düzenleme

/** Tıkla-sürükle ile yumuşak nokta: çıkış tutamacı sürükleme yönünde (bırakma − çapa), giriş tutamacı onun tersi. */
export function handlesFromDrag(anchor: Vec3, release: Vec3): { hIn: Vec3; hOut: Vec3 } {
  const hOut = sub(release, anchor);
  return { hIn: { x: -hOut.x + 0, y: -hOut.y + 0, z: -hOut.z + 0 }, hOut }; // + 0: -0 yerine 0
}

/** Seçili noktaları `delta` kadar taşır (yeni dizi). Tutamaçlar `p`'ye göreli olduğundan değişmez, noktayla gider. */
export function movePoints(points: SketchPoint[], indices: number[], delta: Vec3): SketchPoint[] {
  const sel = new Set(indices);
  return points.map((pt, i) => {
    const c = copyPoint(pt);
    if (sel.has(i)) c.p = add(c.p, delta);
    return c;
  });
}

/** Seçili noktaların yalnızca `axis` bileşenini `value` yapar (yeni dizi). */
export function setAxisCoord(points: SketchPoint[], indices: number[], axis: GeomAxis, value: number): SketchPoint[] {
  const sel = new Set(indices);
  return points.map((pt, i) => {
    const c = copyPoint(pt);
    if (sel.has(i)) c.p = { ...c.p, [axis]: value };
    return c;
  });
}

/** Seçili noktaları çıkarır (yeni dizi). */
export function removePoints(points: SketchPoint[], indices: number[]): SketchPoint[] {
  const sel = new Set(indices);
  return points.filter((_, i) => !sel.has(i)).map(copyPoint);
}

const r3 = (n: number) => Number(n.toFixed(3)) + 0;
const r3v = (v: Vec3): Vec3 => ({ x: r3(v.x), y: r3(v.y), z: r3(v.z) });

/** Noktaları 0,001 mm'ye yuvarlar (projeye yazmadan önce); sıfıra inen tutamaç atılır. */
export function roundPoints(points: SketchPoint[]): SketchPoint[] {
  return points.map((pt) => {
    const hIn = pt.hIn ? handle(r3v(pt.hIn)) : undefined;
    const hOut = pt.hOut ? handle(r3v(pt.hOut)) : undefined;
    return { p: r3v(pt.p), ...(hIn ? { hIn } : {}), ...(hOut ? { hOut } : {}) };
  });
}

/** Yolun kenar sayısı: açıkta n − 1, kapalıda (n ≥ 2) n. */
export function edgeTotal(path: Pick<SketchPath, 'points' | 'closed'>): number {
  const n = path.points.length;
  return path.closed && n >= 2 ? n : Math.max(0, n - 1);
}

/** i. kenarın (i → i+1, kapalıda son → ilk) örnekleri, iki uç dahil; düz kenarda yalnızca iki uç. */
export function edgeSamples(path: Pick<SketchPath, 'points' | 'plane'>, edge: number, seg = 8): Vec3[] {
  const pts = path.points;
  const a = pts[edge];
  const b = pts[(edge + 1) % pts.length];
  return samplePath({ id: '', name: '', closed: false, plane: path.plane, points: [a, b] }, seg);
}

/**
 * `edge` kenarını Bezier parametresi `t`'de (0…1) böler ve araya nokta ekler (yeni dizi; yeni nokta `edge + 1`'de).
 * Düz kenarda köşe noktası; eğri kenarda de Casteljau bölmesi: komşu tutamaçlar kısalır, yeni nokta teğet tutamaçlar alır,
 * eğrinin şekli değişmez.
 */
export function splitEdge(points: SketchPoint[], closed: boolean, edge: number, t: number): SketchPoint[] {
  const out = points.map(copyPoint);
  const n = out.length;
  if (n < 2 || edge < 0 || edge >= (closed ? n : n - 1)) return out;
  const a = out[edge];
  const b = out[(edge + 1) % n];
  const tt = Math.min(1, Math.max(0, t));
  const ha = a.hOut && handle(a.hOut);
  const hb = b.hIn && handle(b.hIn);
  if (!ha && !hb) {
    out.splice(edge + 1, 0, { p: lerp(a.p, b.p, tt) });
    return out;
  }
  const c1 = ha ? add(a.p, ha) : a.p;
  const c2 = hb ? add(b.p, hb) : b.p;
  const q0 = lerp(a.p, c1, tt);
  const q1 = lerp(c1, c2, tt);
  const q2 = lerp(c2, b.p, tt);
  const r0 = lerp(q0, q1, tt);
  const r1 = lerp(q1, q2, tt);
  const m = lerp(r0, r1, tt);
  const setH = (pt: SketchPoint, k: 'hIn' | 'hOut', v: Vec3) => {
    const h = handle(v);
    if (h) pt[k] = h;
    else delete pt[k];
  };
  setH(a, 'hOut', sub(q0, a.p));
  setH(b, 'hIn', sub(q2, b.p));
  const mid: SketchPoint = { p: m };
  setH(mid, 'hIn', sub(r0, m));
  setH(mid, 'hOut', sub(r1, m));
  out.splice(edge + 1, 0, mid);
  return out;
}

/** Çoklu çizgide `p`'ye en yakın kenar: indeks (i → i+1; kapalıda son → ilk dahil), kenar üzerindeki t, uzaklık, nokta. */
export function closestSegment(polyline: Vec3[], closed: boolean, p: Vec3): { index: number; t: number; dist: number; point: Vec3 } {
  if (!polyline.length) return { index: -1, t: 0, dist: Infinity, point: { ...p } };
  if (polyline.length === 1) return { index: 0, t: 0, dist: len(sub(p, polyline[0])), point: { ...polyline[0] } };
  const segs = closed && polyline.length >= 3 ? polyline.length : polyline.length - 1;
  let best = { index: -1, t: 0, dist: Infinity, point: { ...p } };
  for (let i = 0; i < segs; i++) {
    const a = polyline[i];
    const b = polyline[(i + 1) % polyline.length];
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 > EPS ? Math.min(1, Math.max(0, dot(sub(p, a), ab) / l2)) : 0;
    const q = add(a, mul(ab, t));
    const d = len(sub(p, q));
    if (d < best.dist) best = { index: i, t, dist: d, point: q };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Ekran isabet testleri (piksel)

/** Ekran noktalarından (kamera arkasındakiler null) `radiusPx` içindeki en yakının indeksi; yoksa −1. */
export function hitPoint(screenPts: (Screen | null)[], x: number, y: number, radiusPx: number): number {
  let best = -1;
  let bestD = radiusPx;
  screenPts.forEach((s, i) => {
    if (!s) return;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** 2B nokta–doğru parçası uzaklığı ve parça üzerindeki t. */
export function segmentDist2D(p: Screen, a: Screen, b: Screen): { dist: number; t: number } {
  const [dx, dy] = [b.x - a.x, b.y - a.y];
  const l2 = dx * dx + dy * dy;
  const t = l2 > EPS ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return { dist: Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y), t };
}

/**
 * Kenar örneklerinin ekran izdüşümlerinden (`edges[i]` = i. kenarın örnekleri, iki uç dahil) `radiusPx` içindeki en yakın
 * kenar ve o kenarın Bezier parametresi t (örnekler eşit t aralıklı: alt parça indeksi + yerel t). Yoksa null.
 */
export function hitEdge(edges: (Screen | null)[][], x: number, y: number, radiusPx: number): { edge: number; t: number; dist: number } | null {
  let best: { edge: number; t: number; dist: number } | null = null;
  edges.forEach((s, edge) => {
    const parts = s.length - 1;
    for (let k = 0; k < parts; k++) {
      const [a, b] = [s[k], s[k + 1]];
      if (!a || !b) continue;
      const h = segmentDist2D({ x, y }, a, b);
      if (h.dist <= radiusPx && (!best || h.dist < best.dist)) best = { edge, t: (k + h.t) / parts, dist: h.dist };
    }
  });
  return best;
}
