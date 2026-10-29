// extrude / revolve / loft / mesh şekilleri: `geom` doğrulama ve ağ üretimi.
// Üreticiler kanonik çerçevede (profil u-v düzleminde, eksen w) indisli ağ kurar, sonra eksen eşlemesiyle
// yerel koordinatlara taşır. Sonuç her zaman kapalı ve dışa dönüktür (işaretli hacim > 0).
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ExtrudeGeom, GeomAxis, GeomShape, HullGeom, LoftGeom, PartGeom, Pt2, RevolveGeom } from '../shared/ops';
import { decodedAsset } from './assets';
import { frameRing, hullSolid } from './csg';

export class GeomError extends Error {}

const MAX_POINTS = 1024;
const MAX_SECTIONS = 128;
/** Gölgeleme kırılım eşiği: bundan büyük açılı komşu yüzler arasında keskin kenar. */
export const CREASE = (30 * Math.PI) / 180;
/** İçe aktarılan / örtük yüzeyden üretilen ağlar düzensiz üçgenlidir: daha geniş eşik (gerçek 90° kenarlar yine keskin). */
export const MESH_CREASE = (50 * Math.PI) / 180;
/** Örtük yüzeyden ya da dışarıdan gelen, düzensiz üçgenli ağlar (gölge kırılımı ve kenar çizgisi eşiği daha geniş). */
export const isScanLike = (shape: string) => shape === 'mesh' || shape === 'hull';
export const creaseFor = (shape: string) => (isScanLike(shape) ? MESH_CREASE : CREASE);

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ---------------------------------------------------------------------------
// Doğrulama

function signedArea(pts: Pt2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function segmentsCross(a: Pt2, b: Pt2, c: Pt2, d: Pt2): boolean {
  const o = (p: Pt2, q: Pt2, r: Pt2) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function selfIntersects(pts: Pt2[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // komşu kenarlar
      if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** Kapalı çokgeni temizler: sayıya çevirir, ardışık/kapanış tekrarlarını atar, alan ve kesişme denetler. */
export function cleanLoop(raw: unknown, what: string): Pt2[] {
  if (!Array.isArray(raw)) throw new GeomError(`${what}: nokta listesi gerekli.`);
  const out: Pt2[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) throw new GeomError(`${what}: her nokta [a, b] olmalı.`);
    const q: Pt2 = [r4(Number(p[0])), r4(Number(p[1]))];
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) throw new GeomError(`${what}: geçersiz sayı.`);
    const last = out[out.length - 1];
    if (last && last[0] === q[0] && last[1] === q[1]) continue;
    out.push(q);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  if (out.length < 3) throw new GeomError(`${what}: en az 3 farklı nokta gerekli.`);
  if (out.length > MAX_POINTS) throw new GeomError(`${what}: en fazla ${MAX_POINTS} nokta.`);
  if (selfIntersects(out)) throw new GeomError(`${what}: kenarlar birbirini kesiyor; noktaları çevre boyunca sırayla verin.`);
  if (Math.abs(signedArea(out)) < 1e-6) throw new GeomError(`${what}: alanı sıfır (noktalar aynı doğru üzerinde).`);
  return out;
}

function axisOf(v: unknown): GeomAxis {
  if (v === undefined || v === null || v === '') return 'z';
  if (v === 'x' || v === 'y' || v === 'z') return v;
  throw new GeomError(`Geçersiz eksen: ${String(v)} (x, y ya da z).`);
}

/** Dışarıdan gelen (Claude, dosya, arayüz) geometriyi doğrular ve normalize eder. */
export function sanitizeGeom(shape: GeomShape, raw: unknown): PartGeom {
  const g = (raw ?? {}) as Record<string, unknown>;
  if (g.kind !== undefined && g.kind !== shape) throw new GeomError(`geom.kind '${String(g.kind)}' şekille ('${shape}') uyuşmuyor.`);
  switch (shape) {
    case 'extrude': {
      const out: ExtrudeGeom = { kind: 'extrude', axis: axisOf(g.axis), profile: cleanLoop(g.profile, 'Profil') };
      if (Array.isArray(g.holes) && g.holes.length) out.holes = g.holes.map((h, i) => cleanLoop(h, `Boşluk ${i + 1}`));
      const frame = Number(g.frame);
      if (Number.isFinite(frame) && frame > 0) {
        if (out.holes) throw new GeomError("'frame' ile 'holes' birlikte kullanılamaz: çerçevede profil açıklığın kendisidir.");
        if (frame > 1000) throw new GeomError("'frame' en fazla 1000 mm.");
        out.frame = r4(frame);
        if (g.open === true) out.open = true;
      }
      return out;
    }
    case 'revolve': {
      const profile = cleanLoop(g.profile, 'Profil');
      if (profile.some(([r]) => r < 0)) throw new GeomError('Döndürme profilinde r (ilk değer) negatif olamaz; profil eksenin bir yanında olmalı.');
      return { kind: 'revolve', axis: axisOf(g.axis), profile };
    }
    case 'loft': {
      if (!Array.isArray(g.sections) || g.sections.length < 2) throw new GeomError('Loft için en az 2 kesit gerekli.');
      if (g.sections.length > MAX_SECTIONS) throw new GeomError(`Loft için en fazla ${MAX_SECTIONS} kesit.`);
      const sections = g.sections.map((s, i) => {
        const o = (s ?? {}) as Record<string, unknown>;
        const at = r4(Number(o.at));
        if (!Number.isFinite(at)) throw new GeomError(`Kesit ${i + 1}: 'at' sayı olmalı.`);
        // Tek noktalı kesit = uç (apex): loft o noktada sivrilerek biter. Yalnızca ilk/son kesit olabilir.
        if (Array.isArray(o.points) && o.points.length === 1) {
          const q = o.points[0] as unknown[];
          const pt: Pt2 = [r4(Number(q?.[0])), r4(Number(q?.[1]))];
          if (!pt.every(Number.isFinite)) throw new GeomError(`Kesit ${i + 1}: geçersiz uç noktası.`);
          return { at, points: [pt] };
        }
        return { at, points: cleanLoop(o.points, `Kesit ${i + 1}`) };
      });
      sections.sort((a, b) => a.at - b.at);
      for (let i = 1; i < sections.length; i++) {
        if (sections[i].at - sections[i - 1].at < 1e-3) throw new GeomError(`İki kesit aynı konumda (at = ${sections[i].at}).`);
      }
      const apexIdx = sections.flatMap((s, i) => (s.points.length === 1 ? [i] : []));
      if (apexIdx.some((i) => i !== 0 && i !== sections.length - 1)) throw new GeomError('Tek noktalı (uç) kesit yalnızca ilk ya da son kesit olabilir.');
      const rings = sections.filter((s) => s.points.length > 1);
      if (!rings.length) throw new GeomError('Loft için en az bir çokgen kesit gerekli.');
      const out: LoftGeom = { kind: 'loft', axis: axisOf(g.axis), sections };
      if (g.smooth === true) out.smooth = true;
      if (Array.isArray(g.sharp) && g.sharp.length) {
        const n = rings[0].points.length;
        if (rings.some((s) => s.points.length !== n)) throw new GeomError("'sharp' için tüm kesitlerde nokta sayısı aynı olmalı.");
        const sharp = [...new Set(g.sharp.map(Number))].sort((a, b) => a - b);
        if (sharp.some((k) => !Number.isInteger(k) || k < 0 || k >= n)) throw new GeomError(`'sharp' indisleri 0…${n - 1} arası tam sayı olmalı.`);
        out.sharp = sharp;
      }
      return out;
    }
    case 'hull':
      return sanitizeHull(g);
    case 'mesh': {
      if (typeof g.asset !== 'string' || !g.asset) throw new GeomError('Mesh parçasının ağ kimliği (asset) eksik.');
      return { kind: 'mesh', asset: g.asset };
    }
  }
}

const MAX_STATIONS = 512;
const MAX_BREADTHS = 256;

function sanitizeHull(g: Record<string, unknown>): HullGeom {
  if (!Array.isArray(g.stations) || g.stations.length < 2) throw new GeomError('Tekne için en az 2 istasyon gerekli.');
  if (g.stations.length > MAX_STATIONS) throw new GeomError(`Tekne için en fazla ${MAX_STATIONS} istasyon.`);
  let n = -1;
  const stations = g.stations.map((raw, i) => {
    const o = (raw ?? {}) as Record<string, unknown>;
    const [x, keel, sheer] = [o.x, o.keel, o.sheer].map((v) => r4(Number(v)));
    if (![x, keel, sheer].every(Number.isFinite)) throw new GeomError(`İstasyon ${i + 1}: x, keel ve sheer sayı olmalı.`);
    if (sheer - keel < 0.01) throw new GeomError(`İstasyon ${i + 1}: küpeşte (sheer) omurgadan (keel) yüksek olmalı.`);
    if (!Array.isArray(o.breadth) || o.breadth.length < 2) throw new GeomError(`İstasyon ${i + 1}: en az 2 yarı genişlik (breadth) gerekli.`);
    if (o.breadth.length > MAX_BREADTHS) throw new GeomError(`İstasyon ${i + 1}: en fazla ${MAX_BREADTHS} yarı genişlik.`);
    if (n < 0) n = o.breadth.length;
    else if (o.breadth.length !== n) throw new GeomError(`İstasyon ${i + 1}: tüm istasyonlarda yarı genişlik sayısı aynı (${n}) olmalı.`);
    const breadth = o.breadth.map((v) => r4(Number(v)));
    if (breadth.some((v) => !Number.isFinite(v) || v < 0)) throw new GeomError(`İstasyon ${i + 1}: yarı genişlikler 0 ya da pozitif olmalı.`);
    return { x, keel, sheer, breadth };
  });
  stations.sort((a, b) => a.x - b.x);
  for (let i = 1; i < stations.length; i++) {
    if (stations[i].x - stations[i - 1].x < 1e-3) throw new GeomError(`İki istasyon aynı x'te (${stations[i].x}).`);
  }
  if (stations.every((s) => s.breadth.every((b) => b < 1e-3))) throw new GeomError('Tekne genişliği her yerde sıfır.');
  return { kind: 'hull', stations };
}

/** Arayüzden eklenen yeni parçalar için örnek geometri. */
export function defaultGeom(shape: GeomShape): PartGeom {
  switch (shape) {
    case 'extrude':
      return { kind: 'extrude', axis: 'z', profile: [[0, 0], [30, 0], [30, 6], [6, 6], [6, 20], [0, 20]] };
    case 'revolve':
      return { kind: 'revolve', axis: 'z', profile: [[0, 0], [10, 0], [12, 4], [8, 18], [9, 26], [7, 26], [6, 18], [0, 4]] };
    case 'loft':
      return {
        kind: 'loft',
        axis: 'z',
        sections: [
          { at: 0, points: [[-10, -10], [10, -10], [10, 10], [-10, 10]] },
          { at: 20, points: circle(6, 24) },
        ],
      };
    case 'hull': {
      // Küçük bir tekne: düz taban, dışa açılan yanlar, sivri baş, düz ayna.
      const xs = [-20, -10, 0, 10, 16, 20];
      const width = [7, 8, 8, 6.5, 4, 0];
      const keel = [1, 0, 0, 0, 2, 5];
      return {
        kind: 'hull',
        stations: xs.map((x, i) => ({ x, keel: keel[i], sheer: 10, breadth: [0.8, 0.9, 1, 1, 1].map((f) => r4(width[i] * f)) })),
      };
    }
    case 'mesh':
      throw new GeomError('Mesh parçası dosyadan içe aktarılarak eklenir.');
  }
}

function circle(r: number, n: number): Pt2[] {
  return Array.from({ length: n }, (_, i) => [r4(r * Math.cos((2 * Math.PI * i) / n)), r4(r * Math.sin((2 * Math.PI * i) / n))] as Pt2);
}

/** Özet: "profil 12 nokta", "5 kesit" … */
export function describeGeom(g: PartGeom | undefined): string {
  if (!g) return '';
  switch (g.kind) {
    case 'extrude':
      return `profil ${g.profile.length} nokta${g.holes?.length ? `, ${g.holes.length} boşluk` : ''}${g.frame ? `, çerçeve ${g.frame} mm${g.open ? ' (açık)' : ''}` : ''}, eksen ${g.axis}`;
    case 'revolve':
      return `profil ${g.profile.length} nokta, eksen ${g.axis}`;
    case 'loft':
      return `${g.sections.length} kesit, eksen ${g.axis}${g.smooth ? ', yumuşak' : ''}`;
    case 'hull':
      return `${g.stations.length} istasyon × ${g.stations[0].breadth.length} yükseklik`;
    case 'mesh':
      return 'içe aktarılmış ağ';
  }
}

// ---------------------------------------------------------------------------
// Ağ üretimi

interface RawMesh {
  pos: number[];
  idx: number[];
}

/** Kanonik (u, v, w) → yerel (x, y, z). x ekseni: (w, u, v); y ekseni: (u, w, v) (ayna: üçgenler ters çevrilir). */
function mapAxis(m: RawMesh, axis: GeomAxis): void {
  if (axis === 'z') return;
  const p = m.pos;
  for (let i = 0; i < p.length; i += 3) {
    const [u, v, w] = [p[i], p[i + 1], p[i + 2]];
    if (axis === 'x') [p[i], p[i + 1], p[i + 2]] = [w, u, v];
    else [p[i], p[i + 1], p[i + 2]] = [u, w, v];
  }
  if (axis === 'y') flip(m);
}

function flip(m: RawMesh): void {
  for (let i = 0; i < m.idx.length; i += 3) [m.idx[i + 1], m.idx[i + 2]] = [m.idx[i + 2], m.idx[i + 1]];
}

function signedVolume(pos: ArrayLike<number>, idx: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    v +=
      (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
        pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
        pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) /
      6;
  }
  return v;
}

function finish(m: RawMesh, axis: GeomAxis, scale: number): THREE.BufferGeometry {
  mapAxis(m, axis);
  if (signedVolume(m.pos, m.idx) < 0) flip(m);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.pos.map((v) => v * scale), 3));
  g.setIndex(m.idx);
  return g;
}

/** Çerçeve halkasının çokgenlerinden (dış çevre + delikler) three.js şekilleri. */
function frameShapes(g: ExtrudeGeom): THREE.Shape[] {
  const polys = frameRing(g.profile, g.frame!, g.open === true);
  const outers = polys.filter((p) => signedArea(p) > 0);
  const holes = polys.filter((p) => signedArea(p) < 0);
  const inside = (pt: Pt2, poly: Pt2[]) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  return outers.map((o) => {
    const shape = new THREE.Shape(o.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of holes) if (inside(h[0], o)) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    return shape;
  });
}

function extrudeRaw(g: ExtrudeGeom, height: number): RawMesh {
  let shapes: THREE.Shape[];
  if (g.frame) shapes = frameShapes(g);
  else {
    const shape = new THREE.Shape(g.profile.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const h of g.holes ?? []) shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
    shapes = [shape];
  }
  const eg = new THREE.ExtrudeGeometry(shapes, { depth: height, bevelEnabled: false, curveSegments: 1 });
  eg.translate(0, 0, -height / 2);
  eg.deleteAttribute('normal');
  eg.deleteAttribute('uv');
  eg.clearGroups();
  const merged = mergeVertices(eg, 1e-5);
  eg.dispose();
  const out = { pos: Array.from(merged.getAttribute('position').array), idx: Array.from(merged.getIndex()!.array) };
  merged.dispose();
  return out;
}

function revolveRaw(g: RevolveGeom, seg: number): RawMesh {
  const pos: number[] = [];
  const idx: number[] = [];
  const n = g.profile.length;
  // Her profil noktası için halka (eksendeki nokta tek köşe).
  const ring: number[][] = g.profile.map(([r, a]) => {
    if (r < 1e-9) {
      pos.push(0, 0, a);
      return [pos.length / 3 - 1];
    }
    const ids: number[] = [];
    for (let j = 0; j < seg; j++) {
      const t = (2 * Math.PI * j) / seg;
      pos.push(r * Math.cos(t), r * Math.sin(t), a);
      ids.push(pos.length / 3 - 1);
    }
    return ids;
  });
  const at = (i: number, j: number) => (ring[i].length === 1 ? ring[i][0] : ring[i][j % seg]);
  for (let i = 0; i < n; i++) {
    const k = (i + 1) % n;
    for (let j = 0; j < seg; j++) {
      const A = at(i, j);
      const B = at(k, j);
      const C = at(k, j + 1);
      const D = at(i, j + 1);
      if (A !== B && B !== C && A !== C) idx.push(A, B, C);
      if (A !== C && C !== D && A !== D) idx.push(A, C, D);
    }
  }
  return { pos, idx };
}

function resample(pts: Pt2[], n: number): Pt2[] {
  const segLen = pts.map((p, i) => Math.hypot(pts[(i + 1) % pts.length][0] - p[0], pts[(i + 1) % pts.length][1] - p[1]));
  const total = segLen.reduce((s, l) => s + l, 0);
  const out: Pt2[] = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / n;
    while (acc + segLen[i] < target && i < pts.length - 1) acc += segLen[i++];
    const t = segLen[i] > 0 ? (target - acc) / segLen[i] : 0;
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** Saat yönünün tersine çevirir; ilk nokta (başlangıç eşlemesi) korunur. */
function ccw(pts: Pt2[]): Pt2[] {
  return signedArea(pts) >= 0 ? pts : [pts[0], ...pts.slice(1).reverse()];
}

/** Farklı nokta sayılı kesitleri eşlemek için: ağırlık merkezinin altındaki (-v) noktadan başlat. */
function startAtBottom(pts: Pt2[]): Pt2[] {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  // En alttaki nokta; eşitlikte ortaya en yakın olan.
  let best = 0;
  pts.forEach(([u, v], i) => {
    const [bu, bv] = pts[best];
    if (v < bv - 1e-9 || (Math.abs(v - bv) < 1e-9 && Math.abs(u - cx) < Math.abs(bu - cx))) best = i;
  });
  return [...pts.slice(best), ...pts.slice(0, best)];
}

/** Kübik Hermite taban fonksiyonlarıyla tek boyutlu değer (teğetler aralık uzunluğuyla ölçekli). */
function hermite1(f0: number, f1: number, m0: number, m1: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * f0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * f1 + (t3 - t2) * m1;
}

/**
 * Monoton kübik (PCHIP, Fritsch–Butland) teğetleri: ara değer hiçbir zaman iki komşu düğümün dışına taşmaz
 * (düz taban düz kalır, z = 0'ın altına inmez). Keskin düğümde sol/sağ teğet ayrı: komşu kenarın eğimi.
 * Dönen: her düğüm için [sola giden aralıktaki teğet, sağa giden aralıktaki teğet] (df/dt).
 */
function pchipTangents(f: number[], t: number[], closed: boolean, sharp?: Set<number>): [number, number][] {
  const n = f.length;
  const seg = closed ? n : n - 1;
  const h = Array.from({ length: seg }, (_, i) => (closed && i === n - 1 ? t[n] - t[n - 1] : t[i + 1] - t[i]));
  const d = Array.from({ length: seg }, (_, i) => (f[(i + 1) % n] - f[i]) / (h[i] || 1e-12));
  return f.map((_, k) => {
    const hasL = closed || k > 0;
    const hasR = closed || k < n - 1;
    const iL = (k - 1 + seg) % seg;
    const iR = k % seg;
    if (!hasL) return [d[iR], d[iR]];
    if (!hasR) return [d[iL], d[iL]];
    if (sharp?.has(k)) return [d[iL], d[iR]];
    const [d0, d1, h0, h1] = [d[iL], d[iR], h[iL], h[iR]];
    if (d0 * d1 <= 0) return [0, 0];
    const w1 = 2 * h1 + h0;
    const w2 = h1 + 2 * h0;
    const m = (w1 + w2) / (w1 / d0 + w2 / d1);
    return [m, m];
  });
}

/**
 * Kapalı çokgeni monoton kübikle yumuşatır (parametre: kiriş uzunluğu); her kenar `sub` parçaya bölünür.
 * Keskin köşeler korunur. Dönen dizide i·sub indisli nokta özgün i. noktadır (kesitler arası eşleşme korunur).
 */
function smoothLoop(pts: Pt2[], sub: number, sharp: Set<number>): Pt2[] {
  const n = pts.length;
  const t = [0];
  for (let i = 0; i < n; i++) t.push(t[i] + Math.max(1e-6, Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1])));
  const tu = pchipTangents(pts.map((p) => p[0]), t, true, sharp);
  const tv = pchipTangents(pts.map((p) => p[1]), t, true, sharp);
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const h = t[i + 1] - t[i];
    for (let k = 0; k < sub; k++) {
      const s = k / sub;
      out.push(
        k === 0
          ? pts[i]
          : [hermite1(pts[i][0], pts[j][0], tu[i][1] * h, tu[j][0] * h, s), hermite1(pts[i][1], pts[j][1], tv[i][1] * h, tv[j][0] * h, s)],
      );
    }
  }
  return out;
}

/** Bir halkanın (ya da uç noktasının) eksen boyunca ara değerlemesi için i. noktası. */
const ringPoint = (ring: Pt2[], i: number) => (ring.length === 1 ? ring[0] : ring[i]);

function loftRaw(g: LoftGeom, seg: number): RawMesh {
  const isApex = (s: { points: Pt2[] }) => s.points.length === 1;
  const ringSecs = g.sections.filter((s) => !isApex(s));
  const sameCount = ringSecs.every((s) => s.points.length === ringSecs[0].points.length);
  const n = Math.min(MAX_POINTS, Math.max(...ringSecs.map((s) => s.points.length)));
  let rings: Pt2[][] = g.sections.map((s) =>
    isApex(s) ? s.points : sameCount ? ccw(s.points) : resample(startAtBottom(ccw(s.points)), n),
  );
  let ats = g.sections.map((s) => s.at);

  if (g.smooth) {
    // Çevre boyunca: kenar başına ~seg/24 alt bölüm; eksen boyunca: kesit aralığı başına ~seg/32 alt bölüm.
    const sub = Math.max(1, Math.round(seg / 24));
    const subA = Math.max(1, Math.round(seg / 32));
    const sharp = new Set(sameCount ? (g.sharp ?? []) : []);
    rings = rings.map((r) => (r.length === 1 ? r : smoothLoop(r, sub, sharp)));
    const N = Math.max(...rings.map((r) => r.length));
    const K = rings.length;
    // Eksen boyunca: her çevre noktası için u(at) ve v(at) ayrı ayrı monoton kübikle ara değerlenir.
    const tanU: [number, number][][] = [];
    const tanV: [number, number][][] = [];
    for (let i = 0; i < N; i++) {
      tanU.push(pchipTangents(rings.map((r) => ringPoint(r, i)[0]), ats, false));
      tanV.push(pchipTangents(rings.map((r) => ringPoint(r, i)[1]), ats, false));
    }
    const outRings: Pt2[][] = [];
    const outAts: number[] = [];
    for (let k = 0; k < K; k++) {
      outRings.push(rings[k]);
      outAts.push(ats[k]);
      if (k === K - 1) break;
      const h = ats[k + 1] - ats[k];
      for (let s = 1; s < subA; s++) {
        const t = s / subA;
        const ring: Pt2[] = [];
        for (let i = 0; i < N; i++) {
          const [a, b] = [ringPoint(rings[k], i), ringPoint(rings[k + 1], i)];
          ring.push([
            hermite1(a[0], b[0], tanU[i][k][1] * h, tanU[i][k + 1][0] * h, t),
            hermite1(a[1], b[1], tanV[i][k][1] * h, tanV[i][k + 1][0] * h, t),
          ]);
        }
        outRings.push(ring);
        outAts.push(ats[k] + t * h);
      }
    }
    rings = outRings;
    ats = outAts;
  }

  const N = Math.max(...rings.map((r) => r.length));
  const pos: number[] = [];
  const idx: number[] = [];
  const base: number[] = [];
  rings.forEach((ring, k) => {
    base.push(pos.length / 3);
    for (const [u, v] of ring) pos.push(u, v, ats[k]);
  });
  const vid = (k: number, i: number) => (rings[k].length === 1 ? base[k] : base[k] + (i % N));
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < N; i++) {
      const [A, B, C, D] = [vid(k, i), vid(k, i + 1), vid(k + 1, i + 1), vid(k + 1, i)];
      if (A !== B && B !== C && A !== C) idx.push(A, B, C);
      if (A !== C && C !== D && A !== D) idx.push(A, C, D);
    }
  }
  // Kapaklar (uç noktası olmayan uçlar): ilk kesit -w, son kesit +w yönüne bakar.
  const cap = (k: number, up: boolean) => {
    if (rings[k].length === 1) return;
    const contour = rings[k].map(([u, v]) => new THREE.Vector2(u, v));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      const [pa, pb, pc] = [rings[k][a], rings[k][b], rings[k][c]];
      const z = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if ((z > 0) === up) idx.push(base[k] + a, base[k] + b, base[k] + c);
      else idx.push(base[k] + a, base[k] + c, base[k] + b);
    }
  };
  cap(0, false);
  cap(rings.length - 1, true);
  return { pos, idx };
}

function meshGeometry(asset: string, scale: number): THREE.BufferGeometry {
  const m = decodedAsset(asset);
  const g = new THREE.BufferGeometry();
  if (!m) {
    // Ağ verisi yok (ör. otomatik kayda sığmadı): yer tutucu küp.
    const box = new THREE.BoxGeometry(10, 10, 10);
    return box;
  }
  const pos = scale === 1 ? m.positions.slice() : m.positions.map((v) => v * scale);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices.slice(), 1));
  return g;
}

// ---------------------------------------------------------------------------
// Tekne (endaze): tablo → örtük yüzey ∩ yan profil

const hullCache = new Map<string, THREE.BufferGeometry>();

/**
 * Alttan taşma (0…1 mm): düz tabanlı istasyonda (taban yarı genişliği ≥ 1.5) gövde omurganın 1 mm altına taşar ve
 * yan profil omurgadan keskin keser; V biçimli istasyonda (≤ 0.5) taşmaz, kesmez — bodoslama örtük yüzeyin kendi V'si.
 */
const bottomOvershoot = (b0: number) => Math.min(1, Math.max(0, b0 - 0.5));

/** Tablodan örtük fonksiyon: içeride pozitif. Gövde üstte, kıçta ve düz tabanda 1 mm taşar; keskin sınırları yan profil keser. */
function hullSdf(g: HullGeom): (p: [number, number, number]) => number {
  const st = g.stations;
  const n = st[0].breadth.length;
  const X0 = st[0].x;
  const X1 = st[st.length - 1].x;
  const sample = (b: number[], s: number) => {
    const f = s * (n - 1);
    const j = Math.min(n - 2, Math.floor(f));
    return b[j] + (b[j + 1] - b[j]) * (f - j);
  };
  return ([x, y, z]) => {
    const xc = Math.min(X1, Math.max(X0, x));
    let lo = 0;
    let hi = st.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (st[m].x <= xc) lo = m;
      else hi = m;
    }
    const [A, B] = [st[lo], st[hi]];
    const t = (xc - A.x) / (B.x - A.x);
    const keel = A.keel + (B.keel - A.keel) * t;
    const sheer = A.sheer + (B.sheer - A.sheer) * t;
    const s = Math.min(1, Math.max(0, (z - keel) / Math.max(1e-6, sheer - keel)));
    const b = sample(A.breadth, s) + (sample(B.breadth, s) - sample(A.breadth, s)) * t;
    const under = bottomOvershoot(A.breadth[0]) + (bottomOvershoot(B.breadth[0]) - bottomOvershoot(A.breadth[0])) * t;
    return Math.min(b - Math.abs(y), z - (keel - under), sheer + 1 - z, x - (X0 - 1), X1 + 1 - x);
  };
}

/** Tekne ağı (önbellekli: örtük yüzey pahalıdır; aynı tablo ve çözünürlük için bir kez üretilir). */
function hullGeometry(g: HullGeom, seg: number): THREE.BufferGeometry {
  const key = `${seg}|${JSON.stringify(g)}`;
  let cached = hullCache.get(key);
  if (!cached) {
    const st = g.stations;
    const maxB = Math.max(...st.flatMap((s) => s.breadth));
    const minZ = Math.min(...st.map((s) => s.keel));
    const maxZ = Math.max(...st.map((s) => s.sheer));
    const X0 = st[0].x;
    const X1 = st[st.length - 1].x;
    // Yan profil: omurga çizgisi kıçtan başa, küpeşte çizgisi geri. V biçimli istasyonlarda omurga çizgisi 1.5 mm
    // aşağıda (kesmez); düz tabanda tam omurgada (keskin taban kenarı).
    const profile: Pt2[] = [
      // taşma olan her istasyonda tam omurgadan keser; yalnız hiç taşmayan V istasyonda aşağıda kalır (en düşük omurgaya kadar)
      ...st.map((s) => [s.x, Math.max(minZ, s.keel - (bottomOvershoot(s.breadth[0]) > 0 ? 0 : 1.5))] as Pt2),
      ...st.slice().reverse().map((s) => [s.x, s.sheer] as Pt2),
    ];
    const edge = Math.min(1, Math.max(0.15, 34 / seg)); // çözünürlük 96 → 0.35 mm
    cached = hullSolid(hullSdf(g), { min: [X0 - 1.2, -maxB - 1, minZ - 1.2], max: [X1 + 1.2, maxB + 1, maxZ + 1.2] }, edge, profile, maxB + 2);
    if (hullCache.size > 16) hullCache.clear();
    hullCache.set(key, cached);
  }
  return cached.clone();
}

/** Yerel koordinatlarda indisli, kapalı ağ (normal yok). */
export function buildGeomIndexed(geom: PartGeom, params: Record<string, number>, seg: number): THREE.BufferGeometry {
  const scale = params.scale ?? 1;
  switch (geom.kind) {
    case 'extrude':
      return finish(extrudeRaw(geom, params.height ?? 10), geom.axis, scale);
    case 'revolve':
      return finish(revolveRaw(geom, seg), geom.axis, scale);
    case 'loft':
      return finish(loftRaw(geom, seg), geom.axis, scale);
    case 'hull': {
      const g = hullGeometry(geom, seg);
      if (scale !== 1) g.scale(scale, scale, scale);
      return g;
    }
    case 'mesh':
      return meshGeometry(geom.asset, scale);
  }
}

/** Görünüm için: keskin kenarlar (30°+) düz, yumuşak yüzeyler yumuşak gölgeli. */
export function buildGeomDisplay(geom: PartGeom, params: Record<string, number>, seg: number): THREE.BufferGeometry {
  const g = buildGeomIndexed(geom, params, seg);
  const out = toCreasedNormals(g, isScanLike(geom.kind) ? MESH_CREASE : CREASE);
  g.dispose();
  return out;
}

/** İndisli ya da indissiz ağın işaretli hacmi (mm³). */
export function geometryVolume(g: THREE.BufferGeometry): number {
  const pos = g.getAttribute('position').array;
  const index = g.getIndex();
  if (index) return signedVolume(pos, index.array);
  const idx = Array.from({ length: pos.length / 3 }, (_, i) => i);
  return signedVolume(pos, idx);
}
