// extrude / revolve / loft / hull / sweep / decal / mesh şekilleri: `geom` doğrulama ve ağ üretimi.
// Üreticiler kanonik çerçevede (profil u-v düzleminde, eksen w) indisli ağ kurar, sonra eksen eşlemesiyle
// yerel koordinatlara taşır (sweep yolu doğrudan yereldir). Sonuç her zaman kapalı ve dışa dönüktür (işaretli hacim > 0).
// Tek istisna `decal` (düz kaplama): kalınlıksız, açık, yüzü yerel +Z'ye bakan ağ (bkz. decalRaw).
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import type {
  DecalGeom,
  ExtrudeGeom,
  GeomAxis,
  GeomShape,
  HullGeom,
  LoftGeom,
  MeshGeom,
  PartGeom,
  Pt2,
  RevolveGeom,
  SweepGeom,
  SweepPoint,
} from '../shared/ops';
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

const samePt = (a: Pt2, b: Pt2) => a[0] === b[0] && a[1] === b[1];

/** Nokta listesini sayıya çevirir ve 1e-4 mm'ye yuvarlar (tekrarları atmaz). */
function loopPoints(raw: unknown, what: string): Pt2[] {
  if (!Array.isArray(raw)) throw new GeomError(`${what}: nokta listesi gerekli.`);
  return raw.map((p) => {
    if (!Array.isArray(p) || p.length < 2) throw new GeomError(`${what}: her nokta [a, b] olmalı.`);
    const q: Pt2 = [r4(Number(p[0])), r4(Number(p[1]))];
    if (!Number.isFinite(q[0]) || !Number.isFinite(q[1])) throw new GeomError(`${what}: geçersiz sayı.`);
    return q;
  });
}

/** Ardışık tekrarları (`interior`) ve sonda ilk noktayı tekrarlayan kapanış noktalarını (`closing`) atar. */
function dropRepeats(pts: Pt2[], interior: boolean, closing: boolean): Pt2[] {
  const out = interior ? pts.filter((p, i) => i === 0 || !samePt(p, pts[i - 1])) : pts.slice();
  if (closing) while (out.length > 1 && samePt(out[0], out[out.length - 1])) out.pop();
  return out;
}

/** Tekrarsız kapalı çokgeni denetler: nokta sayısı, kendini kesme, alan. */
function checkLoop(out: Pt2[], what: string): void {
  if (out.length < 3) throw new GeomError(`${what}: en az 3 farklı nokta gerekli.`);
  if (out.length > MAX_POINTS) throw new GeomError(`${what}: en fazla ${MAX_POINTS} nokta.`);
  if (selfIntersects(out)) throw new GeomError(`${what}: kenarlar birbirini kesiyor; noktaları çevre boyunca sırayla verin.`);
  if (Math.abs(signedArea(out)) < 1e-6) throw new GeomError(`${what}: alanı sıfır (noktalar aynı doğru üzerinde).`);
}

/** Kapalı çokgeni temizler: sayıya çevirir, ardışık/kapanış tekrarlarını atar, alan ve kesişme denetler. */
export function cleanLoop(raw: unknown, what: string): Pt2[] {
  const out = dropRepeats(loopPoints(raw, what), true, true);
  checkLoop(out, what);
  return out;
}

/**
 * Loft'un halka kesitleri birlikte temizlenir: ardışık çakışık noktalar (dejenere kenar) kesitler arası indis
 * eşleşmesinin yer tutucusudur — bir kesitte "erimiş" nokta öbür kesitte açılır (ör. kesit boyunca doğup büyüyen
 * çıkıntı). Tekrarları atmak nokta sayısını değiştirip eşleşmeyi kaydırırdı. Biçimler sırasıyla: kapanış tekrarı
 * atılmış, hiçbir tekrarı atılmamış, tüm tekrarları atılmış; halka kesitlerin nokta sayısını eşit tutan ilk biçim
 * seçilir (`MAX_POINTS`'i aşan biçim atlanır). Hiçbiri eşit tutmuyorsa tekrarsız biçim döner (farklı sayılar yeniden
 * örneklenir). `closing`: kapanış tekrarı atılan biçimde ham nokta sayısı — n…closing−1 indisleri atılan, ilk noktayla
 * çakışık kapanış noktalarıdır (`sharp` bunları 0'a eşler; ör. aynada 0–1 çakışık çifti sona geçer).
 */
function loftLoops(items: { raw: unknown; what: string }[]): { loops: Pt2[][]; closing: number } {
  if (!items.length) return { loops: [], closing: 0 };
  const raws: Pt2[][] = [];
  const forms = items.map(({ raw, what }) => {
    const pts = loopPoints(raw, what);
    const strict = dropRepeats(pts, true, true);
    checkLoop(strict, what);
    raws.push(pts);
    return [dropRepeats(pts, false, true), pts, strict];
  });
  for (let f = 0; f < 2; f++) {
    const n = forms[0][f].length;
    if (n > MAX_POINTS || !forms.every((x) => x[f].length === n)) continue;
    return { loops: forms.map((x) => x[f]), closing: f === 0 ? Math.max(...raws.map((p) => p.length)) : n };
  }
  return { loops: forms.map((x) => x[2]), closing: 0 };
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
      const parsed = g.sections.map((s, i) => {
        const o = (s ?? {}) as Record<string, unknown>;
        const at = r4(Number(o.at));
        if (!Number.isFinite(at)) throw new GeomError(`Kesit ${i + 1}: 'at' sayı olmalı.`);
        // Tek noktalı kesit = uç (apex): loft o noktada sivrilerek biter. Yalnızca ilk/son kesit olabilir.
        if (Array.isArray(o.points) && o.points.length === 1) {
          const q = o.points[0] as unknown[];
          const pt: Pt2 = [r4(Number(q?.[0])), r4(Number(q?.[1]))];
          if (!pt.every(Number.isFinite)) throw new GeomError(`Kesit ${i + 1}: geçersiz uç noktası.`);
          return { at, apex: pt };
        }
        return { at, raw: o.points, what: `Kesit ${i + 1}` };
      });
      const { loops, closing } = loftLoops(parsed.flatMap((s) => (s.apex ? [] : [{ raw: s.raw, what: s.what! }])));
      let r = 0;
      const sections = parsed.map((s) => ({ at: s.at, points: s.apex ? [s.apex] : loops[r++] }));
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
        // Atılan kapanış noktası (ilk noktayla çakışık) ilk noktanın kendisidir.
        const sharp = [...new Set(g.sharp.map(Number).map((k) => (Number.isInteger(k) && k >= n && k < closing ? 0 : k)))].sort((a, b) => a - b);
        if (sharp.some((k) => !Number.isInteger(k) || k < 0 || k >= n)) throw new GeomError(`'sharp' indisleri 0…${n - 1} arası tam sayı olmalı.`);
        out.sharp = sharp;
      }
      if (g.mirrored === true) out.mirrored = true;
      return out;
    }
    case 'hull':
      return sanitizeHull(g);
    case 'sweep':
      return sanitizeSweep(g);
    case 'decal':
      return sanitizeDecal(g);
    case 'mesh': {
      if (typeof g.asset !== 'string' || !g.asset) throw new GeomError('Mesh parçasının ağ kimliği (asset) eksik.');
      return { kind: 'mesh', asset: g.asset, ...meshSource(g) };
    }
  }
}

/**
 * Mesh geom'unun isteğe bağlı kaynak alanları (`src`, `maxTris`, `srcSize`, `srcHash`); geçersizleri atılır (sayılar
 * yalnızca gerçek tam sayıysa: "500" ya da 2,5 kabul edilmez).
 */
export function meshSource(g: Record<string, unknown>): Pick<MeshGeom, 'src' | 'maxTris' | 'srcSize' | 'srcHash'> {
  const out: Pick<MeshGeom, 'src' | 'maxTris' | 'srcSize' | 'srcHash'> = {};
  if (typeof g.src === 'string' && g.src.trim()) out.src = g.src.trim();
  if (typeof g.maxTris === 'number' && Number.isSafeInteger(g.maxTris) && g.maxTris > 0) out.maxTris = g.maxTris;
  if (typeof g.srcSize === 'number' && Number.isSafeInteger(g.srcSize) && g.srcSize >= 0) out.srcSize = g.srcSize;
  if (typeof g.srcHash === 'string' && /^[0-9a-f]{8,64}$/i.test(g.srcHash)) out.srcHash = g.srcHash.toLowerCase();
  return out;
}

const MAX_STATIONS = 512;
/** Tekne üçgen bütçesi sınırları (`HullGeom.maxTris`). */
export const HULL_MIN_TRIS = 100;
export const HULL_MAX_TRIS = 1_000_000;
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
  const out: HullGeom = { kind: 'hull', stations };
  // Üçgen bütçesi (oyun varlığı); yok, null ya da 0 = varsayılan ayrıntı.
  if (g.maxTris !== undefined && g.maxTris !== null && g.maxTris !== 0) {
    const m = Math.round(Number(g.maxTris));
    if (!(m >= HULL_MIN_TRIS && m <= HULL_MAX_TRIS)) {
      throw new GeomError(`Tekne 'maxTris' ${HULL_MIN_TRIS}–${HULL_MAX_TRIS.toLocaleString('tr-TR')} arası tam sayı olmalı (0 ya da yok = varsayılan ayrıntı).`);
    }
    out.maxTris = m;
  }
  return out;
}

/** Kaplamanın yüzeyden uzaklığı (`DecalGeom.lift`, mm): varsayılan ve sınırlar. 0 yok: taşıyıcı yüzeyle çakışıp titreşir. */
export const DECAL_LIFT = 0.5;
export const DECAL_MIN_LIFT = 0.01;
export const DECAL_MAX_LIFT = 100;
/** Kaplamanın etkin uzaklığı (mm). */
export const decalLift = (g: DecalGeom) => g.lift ?? DECAL_LIFT;

/**
 * Düz kaplama: profil ve boşluklar extrude'daki gibi temizlenir; boşluklar profilin içinde, kenarına değmeyen ve birbirinden
 * ayrı olmalı (üçgenleme). `lift` yok, null ya da 0 = varsayılan 0,5 mm (yazılmaz; Claude şeması boş sayıyı 0 ile
 * doldurabilir); diğer değerler 0,01–100 mm. `double` yalnızca true iken yazılır.
 */
function sanitizeDecal(g: Record<string, unknown>): DecalGeom {
  const out: DecalGeom = { kind: 'decal', profile: cleanLoop(g.profile, 'Kaplama profili') };
  if (Array.isArray(g.holes) && g.holes.length) {
    out.holes = g.holes.map((h, i) => cleanLoop(h, `Kaplama boşluğu ${i + 1}`));
    checkLoopHoles(out.profile, out.holes, 'Kaplama');
  }
  if (g.double === true) out.double = true;
  if (g.lift !== undefined && g.lift !== null && g.lift !== 0) {
    const l = r4(Number(g.lift));
    if (!(l >= DECAL_MIN_LIFT && l <= DECAL_MAX_LIFT)) {
      throw new GeomError(
        `Kaplama 'lift' (yüzeyden uzaklık) ${mmText(DECAL_MIN_LIFT)}–${DECAL_MAX_LIFT} mm olmalı (yok ya da 0 = varsayılan ${mmText(DECAL_LIFT)} mm; ` +
          'yüzeye yapışık kaplama taşıyıcı yüzle çakışıp titreşir).',
      );
    }
    if (l !== DECAL_LIFT) out.lift = l;
  }
  return out;
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
    case 'sweep':
      // U biçimli boru: tablada yatay yol, köşeleri yay.
      return { kind: 'sweep', path: [[-20, -10, 0], [-20, 10, 0], [20, 10, 0], [20, -10, 0]], bend: 8, diameter: 6 };
    case 'decal':
      // 40 × 20 mm plaka, yüzü +Z.
      return { kind: 'decal', profile: [[-20, -10], [20, -10], [20, 10], [-20, 10]] };
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
      return `${g.stations.length} istasyon × ${g.stations[0].breadth.length} yükseklik${g.maxTris ? `, en fazla ${g.maxTris} üçgen` : ''}`;
    case 'sweep': {
      const sec = g.profile
        ? `kesit ${g.profile.length} nokta${g.holes?.length ? `, ${g.holes.length} boşluk` : ''}`
        : `kesit Ø${mmText(g.diameter ?? 0)}${g.innerDiameter ? ` (iç Ø${mmText(g.innerDiameter)})` : ''}`;
      const bend = g.bend ? `, köşe yarıçapı ${mmText(g.bend)}` : '';
      return `yol ${g.path.length} nokta, ${mmText(sweepLength(g))} mm, ${g.closed ? 'kapalı' : 'açık'}, ${sec}${bend}${g.frame ? `, çerçeve ${g.frame}` : ''}`;
    }
    case 'decal':
      return `profil ${g.profile.length} nokta${g.holes?.length ? `, ${g.holes.length} boşluk` : ''}${g.double ? ', iki yüzlü' : ''}, yüzeyden ${mmText(decalLift(g))} mm`;
    case 'mesh':
      return 'içe aktarılmış ağ';
  }
}

/** Ölçü metni (2 ondalık, Türkçe ondalık virgülü); `mmFloor` aşağı yuvarlar ("en fazla" değerleri sığsın diye). */
const mmText = (n: number) => Number(n.toFixed(2)).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
const mmFloor = (n: number) => mmText(Math.floor(n * 100 + 1e-9) / 100);
const degText = (rad: number) => Number(((rad * 180) / Math.PI).toFixed(1)).toLocaleString('tr-TR', { maximumFractionDigits: 1 });

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

/**
 * T-kavşağı onarımı: üçgenleme (earcut) doğrusal bir kapak köşesini atlayınca kapak kenarı o köşenin üstünden geçer, yan
 * duvar ise köşeyi kullanır (ör. aynı hizadaki iki boşluk) — ağ kapalı olmaz. Eşi olmayan her yönlü kenarın üstüne düşen
 * (yine eşsiz kenarlı) köşe bulunur ve kenarı taşıyan üçgen o köşeden ikiye bölünür; eşsiz kenar kalmayana dek. Ağ zaten
 * kapalıysa hiçbir şey değişmez (bayt bayt aynı).
 */
function fixTJunctions(m: RawMesh): void {
  for (let round = 0; round < 1024; round++) {
    const n = m.pos.length / 3;
    const edge = new Map<number, number>();
    for (let t = 0; t < m.idx.length; t += 3) for (let k = 0; k < 3; k++) edge.set(m.idx[t + k] * n + m.idx[t + ((k + 1) % 3)], t);
    const open: [number, number, number][] = [];
    const ends = new Set<number>();
    for (const [key, t] of edge) {
      const [u, v] = [Math.floor(key / n), key % n];
      if (edge.has(v * n + u)) continue;
      open.push([u, v, t]);
      ends.add(u);
      ends.add(v);
    }
    if (!open.length) return;
    const P = (i: number): V3 => [m.pos[3 * i], m.pos[3 * i + 1], m.pos[3 * i + 2]];
    const split = new Set<number>();
    for (const [u, v, t] of open) {
      if (split.has(t)) continue;
      const [a, b] = [P(u), P(v)];
      const ab = sub3(b, a);
      const L2 = dot3(ab, ab);
      // Kenarın üstündeki (ve uçların arasındaki) en yakın köşe
      let best = -1;
      let bestS = Infinity;
      for (const w of ends) {
        if (w === u || w === v) continue;
        const aw = sub3(P(w), a);
        const s = dot3(aw, ab) / L2;
        if (s <= 1e-9 || s >= 1 - 1e-9 || s >= bestS) continue;
        const off = sub3(aw, mul3(ab, s));
        if (dot3(off, off) > 1e-10 * L2) continue;
        best = w;
        bestS = s;
      }
      if (best < 0) continue;
      const tri = [m.idx[t], m.idx[t + 1], m.idx[t + 2]];
      const x = tri[(tri.findIndex((p, i) => p === u && tri[(i + 1) % 3] === v) + 2) % 3];
      [m.idx[t], m.idx[t + 1], m.idx[t + 2]] = [u, best, x];
      m.idx.push(best, v, x);
      split.add(t);
    }
    if (!split.size) return;
  }
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
  // Kapak üçgenlemesi doğrusal köşe atlamışsa (hizalı boşluklar) kapat; kapalı ağda değişiklik yok.
  fixTJunctions(out);
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
 * Halkadaki ardışık çakışık noktaları (dejenere kenar; döngüsel, sondaki nokta ilkiyle de) gruplar: `group[i]` i.
 * noktanın tekil nokta numarası (çevre sırasıyla 0…count−1). Çakışık nokta yoksa group[i] = i.
 */
function repeatGroups(pts: Pt2[]): { group: number[]; count: number } {
  const n = pts.length;
  const prev = (i: number) => (i - 1 + n) % n;
  let s = 0;
  while (s < n && samePt(pts[s], pts[prev(s)])) s++;
  if (s === n) return { group: new Array<number>(n).fill(0), count: 1 };
  const group = new Array<number>(n);
  let count = 0;
  for (let j = 0; j < n; j++) {
    const i = (s + j) % n;
    group[i] = j > 0 && samePt(pts[i], pts[prev(i)]) ? group[prev(i)] : count++;
  }
  return { group, count };
}

/**
 * Kapalı çokgeni monoton kübikle yumuşatır (parametre: kiriş uzunluğu); her kenar `sub` parçaya bölünür.
 * Keskin köşeler korunur. Dönen dizide i·sub indisli nokta özgün i. noktadır (kesitler arası eşleşme korunur).
 * Çakışık noktalar yumuşatmayı etkilemez: teğetler tekil noktalardan, dejenere kenar `sub` kopya olarak kalır.
 */
function smoothLoop(pts: Pt2[], sub: number, sharp: Set<number>): Pt2[] {
  const n = pts.length;
  const { group, count: m } = repeatGroups(pts);
  const u: Pt2[] = new Array(m);
  group.forEach((g, i) => (u[g] = pts[i]));
  const t = [0];
  for (let g = 0; g < m; g++) t.push(t[g] + Math.max(1e-6, Math.hypot(u[(g + 1) % m][0] - u[g][0], u[(g + 1) % m][1] - u[g][1])));
  const sharpU = new Set([...sharp].map((k) => group[k]));
  const tu = pchipTangents(u.map((p) => p[0]), t, true, sharpU);
  const tv = pchipTangents(u.map((p) => p[1]), t, true, sharpU);
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = [group[i], group[(i + 1) % n]];
    const h = t[a + 1] - t[a];
    for (let k = 0; k < sub; k++) {
      const s = k / sub;
      out.push(
        k === 0 || a === b
          ? pts[i]
          : [hermite1(u[a][0], u[b][0], tu[a][1] * h, tu[b][0] * h, s), hermite1(u[a][1], u[b][1], tv[a][1] * h, tv[b][0] * h, s)],
      );
    }
  }
  return out;
}

/** Bir halkanın (ya da uç noktasının) eksen boyunca ara değerlemesi için i. noktası. */
const ringPoint = (ring: Pt2[], i: number) => (ring.length === 1 ? ring[0] : ring[i]);

/**
 * Loft'un kesit halkaları (uç kesit tek nokta): nokta sayıları eşitse saat yönünün tersine çevrilmiş kesitler; farklıysa
 * hepsi en büyük sayıya, ağırlık merkezinin altındaki noktadan başlayarak eşit yay uzunluğuyla yeniden örneklenir
 * (1e-4 mm'ye yuvarlı: loftCommonSections aynı halkaları kesit olarak verebilsin).
 */
function loftRings(g: LoftGeom): Pt2[][] {
  const ringSecs = g.sections.filter((s) => s.points.length > 1);
  const sameCount = ringSecs.every((s) => s.points.length === ringSecs[0].points.length);
  const n = Math.min(MAX_POINTS, Math.max(...ringSecs.map((s) => s.points.length)));
  return g.sections.map((s) => {
    if (s.points.length === 1) return s.points;
    if (sameCount) return ccw(s.points);
    return resample(startAtBottom(ccw(s.points)), n).map(([u, v]) => [r4(u), r4(v)] as Pt2);
  });
}

/**
 * Farklı nokta sayılı loft'u, ağ üretiminin zaten kullandığı ortak nokta sayılı kesitlere çevirir (ağ aynı kalır).
 * Sayılar eşitse `g` döner. Aynalama için: yeniden örneklemenin başlangıcı (alttaki nokta, eşitlikte ortaya en yakın)
 * aynalanan kesitte simetrik seçilmeyebilir; önceden örneklenmiş kesitlerin aynası ise birebirdir.
 */
export function loftCommonSections(g: LoftGeom): LoftGeom {
  const ringSecs = g.sections.filter((s) => s.points.length > 1);
  if (ringSecs.every((s) => s.points.length === ringSecs[0].points.length)) return g;
  const rings = loftRings(g);
  // `sharp` farklı sayılarda kullanılmaz (sanitizeGeom reddeder); eşit sayıda anlamı değişeceği için taşınmaz.
  return {
    kind: 'loft',
    axis: g.axis,
    sections: g.sections.map((s, k) => ({ ...s, points: rings[k] })),
    ...(g.smooth ? { smooth: true } : {}),
    ...(g.mirrored ? { mirrored: true } : {}),
  };
}

function loftRaw(g: LoftGeom, seg: number): RawMesh {
  const ringSecs = g.sections.filter((s) => s.points.length > 1);
  const sameCount = ringSecs.every((s) => s.points.length === ringSecs[0].points.length);
  let rings: Pt2[][] = loftRings(g);
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
  // Halkanın ardışık çakışık noktaları (dejenere kenar) tek köşedir: yan dörtgen üçgene iner, ağ kapalı kalır.
  const groups = rings.map((ring) => repeatGroups(ring));
  const base: number[] = [];
  rings.forEach((ring, k) => {
    base.push(pos.length / 3);
    const { group, count } = groups[k];
    const first = new Array<number>(count);
    group.forEach((g, i) => (first[g] ??= i));
    for (const i of first) pos.push(ring[i][0], ring[i][1], ats[k]);
  });
  const vid = (k: number, i: number) => (rings[k].length === 1 ? base[k] : base[k] + groups[k].group[i % N]);
  const tri = (a: number, b: number, c: number) => {
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  };
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < N; i++) {
      const [A, B, C, D] = [vid(k, i), vid(k, i + 1), vid(k + 1, i + 1), vid(k + 1, i)];
      // Yan dörtgen A–C köşegeninden bölünür; aynalanmış loft'ta kesitler ters dolaşıldığından B–D (özgünün A–C'sinin
      // aynası). Düzlemsel olmayan (bükülmüş) dörtgende bu seçim yüzeyi değiştirir.
      if (g.mirrored) {
        tri(A, B, D);
        tri(B, C, D);
      } else {
        tri(A, B, C);
        tri(A, C, D);
      }
    }
  }
  // Kapaklar (uç noktası olmayan uçlar): ilk kesit -w, son kesit +w yönüne bakar.
  const cap = (k: number, up: boolean) => {
    if (rings[k].length === 1) return;
    // Kontur tekil köşelerden (köşe sırası = pos'a yazılış sırası).
    const pts = new Array<Pt2>(groups[k].count);
    groups[k].group.forEach((g, i) => (pts[g] ??= rings[k][i]));
    const contour = pts.map(([u, v]) => new THREE.Vector2(u, v));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      const [pa, pb, pc] = [pts[a], pts[b], pts[c]];
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

/**
 * Tekne ızgarasının nokta bütçesi. Kenar boyu mutlak mm olduğundan nokta sayısı gövde hacmiyle büyür (3DBenchy teknesi
 * çözünürlük 96'da 1,4 milyon, ~1,5 sn; 240 mm'lik gövde 50 milyon, ~1 dk; 1 m'lik gövde WASM belleğini aşıyordu). Çıktı
 * zaten ~60 bin üçgene sadeleştirildiği için bütçenin üstündeki ayrıntı yalnızca süre ekler; bütçede bile göreli
 * çözünürlük (kenar / gövde boyu) Benchy'ninkinden incedir.
 */
export const HULL_MAX_CELLS = 2.5e6;

/** `maxTris` verilmezse ağın sadeleştirme hedefi (sapma sınırlı; düşük çözünürlükte ham ağ bunun altında kalır). */
const HULL_TRIS = 60000;

/**
 * `maxTris` (üçgen bütçesi) verilince ızgara bütçesi: hedef üçgen başına nokta, alt sınırla. Ayrıntı zaten sadeleştirmede
 * atılır; 2,2 m'lik gövdede 1000 üçgen için 250 bin nokta 2,5 milyonla aynı ağı ~0,4 sn'de verir (3,5 yerine).
 */
const HULL_CELLS_PER_TRI = 250;
const HULL_MIN_CELLS = 250e3;
const hullCellBudget = (g: HullGeom) =>
  g.maxTris ? Math.min(HULL_MAX_CELLS, Math.max(HULL_MIN_CELLS, g.maxTris * HULL_CELLS_PER_TRI)) : HULL_MAX_CELLS;

/** Tablonun her uzunluğu 1/k ile çarpılmış kopyası. */
const scaledHull = (g: HullGeom, k: number): HullGeom => ({
  ...g,
  stations: g.stations.map((s) => ({ ...s, x: s.x * k, keel: s.keel * k, sheer: s.sheer * k, breadth: s.breadth.map((b) => b * k) })),
});

/**
 * Örtük gövde ile ızgara sınırı arasındaki boşluk (mm). Gövde kendi taşma düzlemlerinde kapanır, sınıra gerek yoktur; yüzey
 * sınıra bir hücreden yakın kalınca (eski düzen: taşma 1 mm, pay 1,2 mm → 0,2 mm) manifold 3.5 `levelSet` bazı
 * hizalamalarda WASM içinde "memory access out of bounds" ile çöküyordu. İki hücrelik boşlukta çökme görülmedi.
 */
const hullGap = (edge: number) => 2 * edge;

/** Tablodan tekne ağı; `edge` örtük yüzey ızgarasının kenar boyu (mm). */
function hullMesh(g: HullGeom, edge: number): THREE.BufferGeometry {
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
  // Gövdenin taşma dahil kutusu: x [X0 − 1, X1 + 1], y [−maxB, maxB], z [minZ − 1, maxZ + 1]; ızgara bundan `gap` büyük.
  const gap = hullGap(edge);
  const bounds = {
    min: [X0 - 1 - gap, -maxB - gap, minZ - 1 - gap] as [number, number, number],
    max: [X1 + 1 + gap, maxB + gap, maxZ + 1 + gap] as [number, number, number],
  };
  const target = g.maxTris ? { tris: g.maxTris, strict: true } : { tris: HULL_TRIS };
  return hullSolid(hullSdf(g), bounds, edge, profile, maxB + 2, target);
}

/**
 * Tekne ağı (önbellekli: örtük yüzey pahalıdır; aynı tablo ve çözünürlük için bir kez üretilir). Izgara bütçeyi aşan büyük
 * gövde, tablo küçültülerek aynı kenar boyuyla üretilip geri büyütülür: sonuç küçük gövdenin birebir ölçekli kopyasıdır
 * (mm cinsinden taşma payları ve düz taban/V eşikleri de gövdeyle orantılı büyür). `maxTris` verilince bütçe ona göre küçülür.
 */
function hullGeometry(g: HullGeom, seg: number): THREE.BufferGeometry {
  const key = `${seg}|${JSON.stringify(g)}`;
  let cached = hullCache.get(key);
  if (!cached) {
    const st = g.stations;
    const edge = Math.min(1, Math.max(0.15, 34 / seg)); // çözünürlük 96 → 0.35 mm
    const size = [
      st[st.length - 1].x - st[0].x,
      2 * Math.max(...st.flatMap((s) => s.breadth)),
      Math.max(...st.map((s) => s.sheer)) - Math.min(...st.map((s) => s.keel)),
    ];
    // Küçültülmüş tablonun ızgarası (taşma ve boşluk dahil, bkz. hullMesh) bütçeye sığana kadar büyüt.
    const gap = hullGap(edge);
    const cells = (k: number) => ((size[0] / k + 2 + 2 * gap) * (size[1] / k + 2 * gap) * (size[2] / k + 2 + 2 * gap)) / edge ** 3;
    const budget = hullCellBudget(g);
    let k = Math.max(1, Math.cbrt(cells(1) / budget));
    while (cells(k) > budget) k *= 1.05;
    if (k === 1) cached = hullMesh(g, edge);
    else {
      cached = hullMesh(scaledHull(g, 1 / k), edge);
      cached.scale(k, k, k);
    }
    if (hullCache.size > 16) hullCache.clear();
    hullCache.set(key, cached);
  }
  return cached.clone();
}

// ---------------------------------------------------------------------------
// Süpürme (sweep): kapalı kesit 3B çoklu çizgi boyunca. Köşeler yay (tam daire başına `seg` kiriş) ya da gönye (kesit
// açıortay düzleminde, dönüş yönünde 1/cos(θ/2) uzar). Kesit çerçevesi: v = up'ın teğete dik bileşeni ('up') ya da yol
// boyunca kendi çevresinde dönmeyen çerçeve ('rmf'); u = teğet × v (gidiş yönünün sağı). Doğrulama (sığma, katlanma,
// gönye açısı, dikey bölüm) çözünürlükten bağımsızdır ve `sanitizeGeom`'da yapılır; üretim yalnızca köşe bütçesini denetler.

type V3 = [number, number, number];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a: V3) => Math.sqrt(dot3(a, a));
const unit3 = (a: V3): V3 => mul3(a, 1 / len3(a));

const DEG = Math.PI / 180;
/** Gönyede en büyük dönüş: 150°'de gönye payı kesit yarı genişliğinin ~3,7 katı, 180°'de sonsuz. */
const SWEEP_MAX_MITER = 150 * DEG;
/** 'up' çerçevesinde teğet up'a bundan yakınsa kesit yönü tanımsız sayılır (dikey bölüm). */
const SWEEP_VERTICAL = 10 * DEG;
/** Ağdaki en fazla köşe (halka × kesit noktası; ~2 milyon üçgen). */
const SWEEP_MAX_VERTS = 1_000_000;
/** Yuvarlak kesitin en az kenar sayısı (en düşük çözünürlük, shapes.ts → MIN_RESOLUTION): bütçenin alt sınırı için. */
const SWEEP_MIN_SIDES = 6;
/** Bundan küçük dönüş (rad) düz geçiştir: köşe ve halka yok. */
const SWEEP_STRAIGHT = 1e-6;
/** Çakışık sayılan ardışık örnekler (mm): yay sonu = sonraki yayın başı ya da yolun ucu (teğetleri de aynı). */
const SWEEP_MERGE = 1e-6;
/** Doğrulamada yay örnekleme adımı: denetimler çözünürlükten bağımsız. */
const SWEEP_CHECK_STEP = 2 * DEG;
/** 'up' çerçevesinde ardışık halkalar arasında en fazla burulma (en küçük dönmeyle taşınan çerçeveye göre). */
const SWEEP_MAX_TWIST = 45 * DEG;
/** Yol, kesit, bend ve up değerlerinin mutlak sınırı (mm): üstünde kayan nokta hesabı taşar (NaN ağ). */
const SWEEP_MAX_COORD = 1e6;
/**
 * Yol noktasının kendi köşe yarıçapı (4. değer; yalnızca > 0 iken `bend`'i ezer), yoksa undefined. 0 "yarıçap yok" demektir:
 * her noktaya 0 yazan bir model `bend`'i sessizce kapatmasın.
 */
const cornerRadius = (p: SweepPoint): number | undefined => {
  const r = (p as number[])[3];
  return r !== undefined && r > 0 ? r : undefined;
};

interface SweepEdge {
  a: number;
  b: number;
  /** Birim yön (a → b). */
  d: V3;
  len: number;
}
interface SweepCorner {
  /** Yol noktasının indisi. */
  at: number;
  p: V3;
  /** Gelen ve giden kenarın birim yönleri. */
  t1: V3;
  t2: V3;
  /** Dönüş açısı (rad, 0…π). */
  theta: number;
  /** Yay yarıçapı; 0 = gönye. */
  r: number;
  /** Yayın teğet boyu r·tan(θ/2) (köşeden kenar boyunca). */
  tlen: number;
  /** Yarıçap noktanın kendi 4. değeri mi (değilse `bend`). */
  own: boolean;
}
interface SweepPlan {
  pts: V3[];
  edges: SweepEdge[];
  /**
   * Köşeden köşeye (ya da yolun ucuna) kenar zinciri: tam doğrusal ara noktalar (düz geçiş) birleşir, `len` toplam uzunluktur.
   * Yay payı ve katlanma bu zincirde denetlenir (eskizden örneklenen yollarda ara noktalar sahte "sığmıyor" vermesin).
   */
  spans: SweepEdge[];
  /** Yol noktası başına köşe; uçta ya da düz geçişte null. */
  corners: (SweepCorner | null)[];
  closed: boolean;
}
interface SweepSample {
  /** Halkanın merkezi (yol üstünde). */
  p: V3;
  /** Çerçeve teğeti: kenar yönü, yay teğeti ya da gönyede açıortay. */
  t: V3;
  /** Yol boyunca uzunluk (yaylar gerçek yay boyuyla) ve yalnızca yaylarda biriken uzunluk (burulma dağıtımı). */
  s: number;
  arc: number;
  /** Gönye: kesit `d` yönünde `k` = 1/cos(θ/2) kat uzar. */
  miter?: { d: V3; k: number };
  /** Yay örneği: dönüşün merkezine bakan birim yön (iç yan katlanma denetimi). */
  bend?: V3;
  /** Ait olduğu köşenin yol indisi; yolun uçlarında −1. */
  corner: number;
}

/**
 * Yolun kenarları, köşeleri ve kenar zincirleri; çözünürlükten bağımsız hatalar burada: tam geri dönüş, 150°'yi aşan gönye ve
 * sığmayan yay. Bir yay, komşu köşesi de yay olan zincirin en az yarısını (komşunun teğet boyu yarıdan kısaysa kalanını),
 * komşusu gönye ya da yolun ucu olan zincirin tamamını kullanabilir (doğrusal ara noktalar zinciri bölmez); hata o köşede
 * sığan en büyük yarıçapı söyler.
 */
function sweepPlan(g: SweepGeom): SweepPlan {
  const pts = g.path.map((p) => [p[0], p[1], p[2]] as V3);
  const n = pts.length;
  const closed = g.closed === true;
  const E = closed ? n : n - 1;
  const edges: SweepEdge[] = Array.from({ length: E }, (_, a) => {
    const b = (a + 1) % n;
    const v = sub3(pts[b], pts[a]);
    const len = len3(v);
    return { a, b, d: mul3(v, 1 / len), len };
  });
  const corners = pts.map((p, i): SweepCorner | null => {
    if (!closed && (i === 0 || i === n - 1)) return null;
    const t1 = edges[(i - 1 + E) % E].d;
    const t2 = edges[i].d;
    const theta = Math.atan2(len3(cross3(t1, t2)), dot3(t1, t2));
    if (theta < SWEEP_STRAIGHT) return null;
    if (theta > Math.PI - 1e-6) throw new GeomError(`Yol noktası ${i + 1}: yol burada tam geri dönüyor (180°); araya bir nokta ekleyin.`);
    const own = cornerRadius(g.path[i]);
    const r = own ?? g.bend ?? 0;
    if (r === 0 && theta >= SWEEP_MAX_MITER - 1e-9) {
      throw new GeomError(
        `Yol noktası ${i + 1}: ${degText(theta)}° dönüş gönye için fazla (en fazla 150°; gönye payı sonsuza gider). Köşeye yarıçap verin ('bend' ya da noktanın 4. değeri).`,
      );
    }
    return { at: i, p, t1, t2, theta, r, tlen: r * Math.tan(theta / 2), own: own !== undefined };
  });
  // Zincir düğümleri: köşeler ve açık yolun uçları (doğrusal ara noktalar atlanır).
  const nodes = pts.map((_, i) => i).filter((i) => corners[i] || (!closed && (i === 0 || i === n - 1)));
  if (nodes.length < 2) throw new GeomError('Süpürme yolunda köşe yok: kapalı yol düz bir çizgi olamaz.');
  const span = (a: number, b: number): SweepEdge => {
    let len = 0;
    for (let i = a; i !== b; i = (i + 1) % n) len += edges[i].len;
    return { a, b, d: edges[a].d, len };
  };
  const spans = (closed ? nodes : nodes.slice(0, -1)).map((a, k) => span(a, nodes[(k + 1) % nodes.length]));
  const into = new Map(spans.map((s) => [s.b, s]));
  const outOf = new Map(spans.map((s) => [s.a, s]));
  for (const c of corners) {
    if (!c || c.r === 0) continue;
    const ein = into.get(c.at)!;
    const eout = outOf.get(c.at)!;
    const share = (e: SweepEdge, other: number) => {
      const o = corners[other];
      return e.len - Math.min(o && o.r > 0 ? o.tlen : 0, e.len / 2);
    };
    const avail = Math.min(share(ein, ein.a), share(eout, eout.b));
    // Pay yalnızca yuvarlama için: tam sığan yaylar (kenarı birlikte dolduranlar) halkayı paylaşır (SWEEP_MERGE).
    if (c.tlen > avail + 1e-9) {
      throw new GeomError(
        `Yol noktası ${c.at + 1}: köşe yarıçapı ${mmText(c.r)} mm${c.own ? '' : " ('bend')"} sığmıyor (${degText(c.theta)}° dönüş, kenarlar ` +
          `${mmText(ein.len)} / ${mmText(eout.len)} mm); bu köşeye en fazla ${mmFloor(avail / Math.tan(c.theta / 2))} mm verin ya da noktaları açın.`,
      );
    }
  }
  return { pts, edges, spans, corners, closed };
}

/** Orta çizginin uzunluğu (yaylar dahil, mm). */
function sweepLength(g: SweepGeom): number {
  try {
    const plan = sweepPlan(g);
    let L = plan.edges.reduce((s, e) => s + e.len, 0);
    for (const c of plan.corners) if (c && c.r > 0) L -= 2 * c.tlen - c.r * c.theta;
    return L;
  } catch {
    return 0;
  }
}

/**
 * Yolun halka örnekleri: açık yolun ucu, gönye köşesi, yay boyunca `chords(θ)` kiriş. Çakışık ardışık örnekler (yay sonu =
 * sonraki yayın başı ya da yolun ucu) birleştirilir; gönye örneği birleştirilmez. `miterAt`: gönye köşesi → örnek indisi.
 * `length` kapalı yolda kapanış kenarını da içerir.
 */
function sweepSamples(plan: SweepPlan, chords: (theta: number) => number) {
  const out: SweepSample[] = [];
  const miterAt = new Map<number, number>();
  let s = 0;
  let arc = 0;
  const add = (x: Omit<SweepSample, 's' | 'arc'>, arcStep: number) => {
    const prev = out[out.length - 1];
    if (prev) {
      const ds = arcStep > 0 ? arcStep : len3(sub3(x.p, prev.p));
      if (arcStep === 0 && ds < SWEEP_MERGE && !x.miter && !prev.miter) return;
      s += ds;
      arc += arcStep;
    }
    out.push({ ...x, s, arc });
  };
  const corner = (i: number) => {
    const c = plan.corners[i];
    if (!c) return;
    const { t1, t2, theta, r, tlen } = c;
    if (r === 0) {
      miterAt.set(i, out.length);
      add({ p: c.p, t: unit3(add3(t1, t2)), miter: { d: unit3(sub3(t2, t1)), k: 1 / Math.cos(theta / 2) }, corner: i }, 0);
      return;
    }
    // Yay: A = p − tlen·t1'den B = p + tlen·t2'ye; n1 dönüş düzleminde t1'e dik, merkeze doğru.
    const n1 = unit3(sub3(t2, mul3(t1, dot3(t1, t2))));
    const center = add3(sub3(c.p, mul3(t1, tlen)), mul3(n1, r));
    const K = chords(theta);
    for (let k = 0; k <= K; k++) {
      const phi = (theta * k) / K;
      const [cs, sn] = [Math.cos(phi), Math.sin(phi)];
      const p = k === 0 ? sub3(c.p, mul3(t1, tlen)) : k === K ? add3(c.p, mul3(t2, tlen)) : add3(center, add3(mul3(n1, -r * cs), mul3(t1, r * sn)));
      const t = k === 0 ? t1 : k === K ? t2 : unit3(add3(mul3(t1, cs), mul3(n1, sn)));
      add({ p, t, bend: sub3(mul3(n1, cs), mul3(t1, sn)), corner: i }, k === 0 ? 0 : (r * theta) / K);
    }
  };
  const { pts, edges, closed } = plan;
  if (!closed) add({ p: pts[0], t: edges[0].d, corner: -1 }, 0);
  for (let i = 0; i < pts.length; i++) corner(i);
  if (!closed) add({ p: pts[pts.length - 1], t: edges[edges.length - 1].d, corner: -1 }, 0);
  let length = s;
  if (closed) {
    const [first, last] = [out[0], out[out.length - 1]];
    const wrap = len3(sub3(first.p, last.p));
    if (wrap < SWEEP_MERGE && !first.miter && !last.miter) out.pop();
    else length += wrap;
  }
  return { samples: out, length, arcLength: arc, miterAt };
}

const sweepUp = (g: SweepGeom): V3 => (g.up ? unit3(g.up) : [0, 0, 1]);
/** Etkin çerçeve: verilmişse o; yoksa yuvarlak kesitte 'rmf' (dönmesi görünmez), profilde 'up'. */
const sweepFrameMode = (g: SweepGeom): 'up' | 'rmf' => g.frame ?? (g.diameter !== undefined ? 'rmf' : 'up');

/** a'yı b'ye çeviren en küçük dönmeyi (eksen a × b) v'ye uygular; a, b birim, zıt değil. */
function rotMin(v: V3, a: V3, b: V3): V3 {
  const k = cross3(a, b);
  if (dot3(k, k) < 1e-30) return v;
  const c = dot3(a, b);
  return add3(add3(mul3(v, c), cross3(k, v)), mul3(k, dot3(k, v) / (1 + c)));
}

/**
 * Çerçeve ekseni v'yi bir örnekten komşusuna taşır (dönmeyi en aza indiren çerçeve): teğetten kirişe, kirişten öbür teğete en
 * küçük dönme. Düz kenarda (kenar boyunca dönme yok) ve düzlemsel yayda (yay ekseni çevresinde) kesindir; double reflection
 * (Wang ve diğ. 2008) bu iki durumda aynı sonucu verir. `d`: yol yönündeki kiriş (geri taşımada da aynı yön).
 */
function transport(v: V3, from: V3, to: V3, d: V3 | null): V3 {
  const w = d ? rotMin(rotMin(v, from, d), d, to) : rotMin(v, from, to);
  return unit3(sub3(w, mul3(to, dot3(w, to))));
}
const chordDir = (a: V3, b: V3): V3 | null => {
  const c = sub3(b, a);
  const l = len3(c);
  return l < 1e-12 ? null : mul3(c, 1 / l);
};
const angleAbout = (a: V3, b: V3, axis: V3) => Math.atan2(dot3(cross3(a, b), axis), dot3(a, b));
const rotAbout = (v: V3, axis: V3, ang: number): V3 => add3(mul3(v, Math.cos(ang)), mul3(cross3(axis, v), Math.sin(ang)));
/** up tanımsızken (yol baştan sona up yönünde) kullanılan dik yön; yalnızca yuvarlak kesitte (profilde checkSweep hata verir). */
function fallbackPerp(t: V3): V3 {
  const a: V3 = Math.abs(t[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  return unit3(sub3(a, mul3(t, dot3(a, t))));
}

/**
 * Örneklerin v eksenleri ve kapalı yuvarlak kesitte dikişteki halka indisi kayması. 'up': v = up'ın teğete dik bileşeni.
 * 'rmf': ilk örnekte up'tan (teğet up'a ~1°'den yakınsa up'ın tanımlı olduğu ilk örnekten geri taşınarak), sonra taşınarak.
 * Uçlar up'a hizalanır: kapalı yolda kapanış açısı farkı, açık yolda son uçtaki up farkı (son teğet dikey değilse) yay
 * boyuna göre dağıtılır — yolda yay varsa yalnızca yaylara (düz kenarlar burulmaz), yoksa tüm uzunluğa. Böylece aynı kesitle
 * uç uca süpürülen parçaların halkaları çakışır. Yuvarlak kesitte (`sides` kenar) fark 360°/sides kipine indirilir (çokgen
 * kendi simetrisiyle döner; burulma en fazla yarım kenar), kapalı yolda dikişte halka indisi `shift` kadar kayar.
 */
function sweepFrames(smp: SweepSample[], closed: boolean, up: V3, mode: 'up' | 'rmf', sides: number, length: number, arcLength: number) {
  const perp = (t: V3): V3 | null => {
    const w = sub3(up, mul3(t, dot3(up, t)));
    const l = len3(w);
    return l < Math.sin(DEG) ? null : mul3(w, 1 / l);
  };
  const m = smp.length;
  if (mode === 'up') return { v: smp.map((x) => perp(x.t) ?? fallbackPerp(x.t)), shift: 0 };
  const v: V3[] = new Array(m);
  const k0 = smp.findIndex((x) => perp(x.t));
  if (k0 < 0) v[0] = fallbackPerp(smp[0].t);
  else {
    let w = perp(smp[k0].t)!;
    for (let k = k0; k > 0; k--) w = transport(w, smp[k].t, smp[k - 1].t, chordDir(smp[k - 1].p, smp[k].p));
    v[0] = w;
  }
  for (let k = 1; k < m; k++) v[k] = transport(v[k - 1], smp[k - 1].t, smp[k].t, chordDir(smp[k - 1].p, smp[k].p));
  let delta = 0;
  if (closed) delta = angleAbout(transport(v[m - 1], smp[m - 1].t, smp[0].t, chordDir(smp[m - 1].p, smp[0].p)), v[0], smp[0].t);
  else {
    const target = perp(smp[m - 1].t);
    if (target) delta = angleAbout(v[m - 1], target, smp[m - 1].t);
  }
  let shift = 0;
  if (sides > 0) {
    const step = (2 * Math.PI) / sides;
    shift = Math.round(delta / step);
    delta -= shift * step;
  }
  if (delta !== 0) {
    const byArc = arcLength > 1e-9;
    for (let k = 0; k < m; k++) v[k] = rotAbout(v[k], smp[k].t, delta * (byArc ? smp[k].arc / arcLength : smp[k].s / length));
  }
  return { v, shift: closed ? shift : 0 };
}

/**
 * Kenar zinciri boyunca katlanma: her kesit noktası için baştaki köşenin zincirden yediği boy (gönye payı ya da yay teğeti)
 * ile sondakinin toplamı zincirden kısa olmalı. `pulls(i)`: gönye köşesinde nokta başına pay (tek değer = tüm noktalar için).
 * Yay–yay ve uç kenarları sığma denetimi kapsar.
 */
function checkSweepEdges(plan: SweepPlan, pulls: (corner: number) => number[]): void {
  for (const e of plan.spans) {
    const [ca, cb] = [plan.corners[e.a], plan.corners[e.b]];
    const miterA = !!ca && ca.r === 0;
    const miterB = !!cb && cb.r === 0;
    if (!miterA && !miterB) continue;
    const pa = miterA ? pulls(e.a) : [ca ? ca.tlen : 0];
    const pb = miterB ? pulls(e.b) : [cb ? cb.tlen : 0];
    let need = 0;
    for (let j = 0; j < Math.max(pa.length, pb.length); j++) need = Math.max(need, pa[pa.length === 1 ? 0 : j] + pb[pb.length === 1 ? 0 : j]);
    if (need >= e.len - 1e-6) {
      const arcs = (ca && ca.r > 0) || (cb && cb.r > 0);
      throw new GeomError(
        `Yol kenarı ${e.a + 1}→${e.b + 1} (${mmText(e.len)} mm) uçlarındaki köşelere yetmiyor: kesitin iç yanı en az ${mmText(need)} mm istiyor ` +
          `(gönye payı${arcs ? ' + yay teğeti' : ''}); kesit katlanır. Kenarı uzatın ya da köşeye yarıçap verin ('bend' ya da noktanın 4. değeri).`,
      );
    }
  }
}

/**
 * 'up' çerçevesinde burulma sınırı: teğet up'tan uzak olsa da eğik bir up ile v ardışık halkalar arasında hızla dönebilir; dörtgenler
 * burulup ağ kendini keser. Burulma, çerçevenin en küçük dönmeyle taşınmış hâline göre açıdır (düzlemsel yolda up düzlemin içinde
 * ya da normaliyken 0). Düz bağlantılarda halka çifti başına (gönyede ayrıca gönye halkası ile kenarın kendi çerçevesi arasında),
 * yayda toplam burulmanın en düşük çözünürlükteki (6) kiriş sayısına bölümü `SWEEP_MAX_TWIST`'i aşmamalı.
 */
function checkUpTwist(plan: SweepPlan, samples: SweepSample[], up: V3): void {
  const perp = (t: V3): V3 => unit3(sub3(up, mul3(t, dot3(up, t))));
  const v = samples.map((x) => perp(x.t));
  const twist = (vFrom: V3, from: V3, to: V3, vTo: V3, d: V3 | null) => Math.abs(angleAbout(transport(vFrom, from, to, d), vTo, to));
  const fail = (corner: number, ang: number) =>
    new GeomError(
      `up bu yolda hızla dönüyor (yol noktası ${corner + 1} çevresinde ${degText(ang)}° burulma; en fazla ${degText(SWEEP_MAX_TWIST)}°): ` +
        `frame: "rmf" verin, köşeye yarıçap verin (bend; burulma yaya yayılır) ya da up'ı yola daha dik verin.`,
    );
  const arcTwist = new Map<number, number>();
  const m = samples.length;
  for (let k = 0; k < (plan.closed ? m : m - 1); k++) {
    const [a, b] = [samples[k], samples[(k + 1) % m]];
    const [va, vb] = [v[k], v[(k + 1) % m]];
    const d = chordDir(a.p, b.p);
    const ang = twist(va, a.t, b.t, vb, d);
    if (a.bend && b.bend && a.corner === b.corner) {
      arcTwist.set(a.corner, (arcTwist.get(a.corner) ?? 0) + ang);
      continue;
    }
    const at = a.corner >= 0 ? a.corner : b.corner;
    if (ang > SWEEP_MAX_TWIST) throw fail(at, ang);
    // Gönye halkası ile kenarın kendi çerçevesi (kenar boyunca up'a göre dik kesit) arasında da
    if (d && (a.miter || b.miter)) {
      const ve = perp(d);
      const parts = [twist(va, a.t, d, ve, null), twist(ve, d, b.t, vb, null)];
      for (const p of parts) if (p > SWEEP_MAX_TWIST) throw fail(a.miter ? a.corner : b.corner, p);
    }
  }
  for (const [i, total] of arcTwist) {
    const chords = Math.max(1, Math.ceil((SWEEP_MIN_SIDES * plan.corners[i]!.theta) / (2 * Math.PI) - 1e-9));
    if (total / chords > SWEEP_MAX_TWIST) throw fail(i, total / chords);
  }
}

const bendFold = (c: SweepCorner, w: number) =>
  new GeomError(
    `Yol noktası ${c.at + 1}: köşe yarıçapı ${mmText(c.r)} mm${c.own ? '' : " ('bend')"}, kesitin dönüşün iç yanındaki uzanımından (${mmText(w)} mm) ` +
      'büyük olmalı; iç yan katlanır. Yarıçapı büyütün ya da kesiti küçültün.',
  );

/**
 * Süpürmenin çözünürlükten bağımsız denetimi: sığma/gönye (sweepPlan), 'up' çerçevesinde dikey bölüm, yayda ve gönyede iç
 * yanın katlanması. Yuvarlak kesit daire sayılır (çokgen içine çizili: daire sınırı güvenli yandadır); profilde nokta nokta,
 * çerçeveyle (yaylar 2°'lik adımla örneklenir).
 */
function checkSweep(g: SweepGeom): void {
  const plan = sweepPlan(g);
  const { samples, length, arcLength, miterAt } = sweepSamples(plan, (theta) => Math.max(2, Math.ceil(theta / SWEEP_CHECK_STEP)));
  const up = sweepUp(g);
  const mode = sweepFrameMode(g);
  if (mode === 'up') {
    const lim = Math.cos(SWEEP_VERTICAL);
    const hint = `dikey bölüm var: frame: "rmf" verin ya da up'ı değiştirin ('up' çerçevesinde kesitin yönü tanımsız)`;
    const deg = (t: V3) => degText(Math.acos(Math.min(1, Math.abs(dot3(t, up)))));
    for (const e of plan.edges) {
      if (Math.abs(dot3(e.d, up)) > lim) throw new GeomError(`Yol kenarı ${e.a + 1}→${e.b + 1} up yönüyle ${deg(e.d)}° açı yapıyor: ${hint}.`);
    }
    for (const x of samples) {
      if (x.corner >= 0 && Math.abs(dot3(x.t, up)) > lim) throw new GeomError(`Yol noktası ${x.corner + 1} köşesinde teğet up yönüne ${deg(x.t)}° yaklaşıyor: ${hint}.`);
    }
    checkUpTwist(plan, samples, up);
  }
  // Yol her yerde up'a paralelse (rmf) çerçevenin başlangıcı yalnızca yedek eksenden gelirdi; o yedek aynaya göre eşdeğişken
  // değil. Yuvarlak kesitte görünmez (yedek kalır), profilde kesitin yönü belirsiz: hata.
  if (g.profile && samples.every((x) => len3(sub3(up, mul3(x.t, dot3(up, x.t)))) < Math.sin(DEG))) {
    throw new GeomError("Süpürme: yol baştan sona up yönünde: kesit yönünü belirlemek için up'ı yola dik verin (ör. [1, 0, 0]).");
  }
  const tanHalf = (i: number) => Math.tan(plan.corners[i]!.theta / 2);
  if (g.diameter !== undefined) {
    const rad = g.diameter / 2;
    for (const c of plan.corners) if (c && c.r > 0 && c.r <= rad + 1e-6) throw bendFold(c, rad);
    checkSweepEdges(plan, (i) => [rad * tanHalf(i)]);
    return;
  }
  // Doğrusal fonksiyonun çokgendeki en büyüğü bir köşededir: boşluklar dış çevrenin içinde kaldığından dış çevre yeter.
  const outer = g.profile!;
  const { v } = sweepFrames(samples, plan.closed, up, mode, 0, length, arcLength);
  const worst = new Map<number, number>();
  samples.forEach((x, k) => {
    if (!x.bend) return;
    const u = cross3(x.t, v[k]);
    const [un, vn] = [dot3(u, x.bend), dot3(v[k], x.bend)];
    const w = Math.max(...outer.map(([pu, pv]) => pu * un + pv * vn));
    worst.set(x.corner, Math.max(worst.get(x.corner) ?? -Infinity, w));
  });
  for (const [i, w] of worst) if (plan.corners[i]!.r <= w + 1e-6) throw bendFold(plan.corners[i]!, w);
  checkSweepEdges(plan, (i) => {
    const k = miterAt.get(i)!;
    const x = samples[k];
    const u = cross3(x.t, v[k]);
    const [ud, vd, th] = [dot3(u, x.miter!.d), dot3(v[k], x.miter!.d), tanHalf(i)];
    return [...outer.map(([pu, pv]) => (pu * ud + pv * vd) * th), 0];
  });
}

/** Süpürme geom'unu doğrular ve normalize eder (boş alanlar: yok, null, 0, [] — Claude şeması boşu null ile doldurur). */
function sanitizeSweep(g: Record<string, unknown>): SweepGeom {
  const empty = (v: unknown) => v === undefined || v === null || v === 0 || v === '' || (Array.isArray(v) && v.length === 0);
  const closed = g.closed === true;
  if (!Array.isArray(g.path) || g.path.length < 2) throw new GeomError("Süpürme yolu ('path') için en az 2 nokta gerekli: [[x, y, z], …].");
  const tooBig = (vs: number[]) => vs.some((v) => Math.abs(v) > SWEEP_MAX_COORD);
  const LIMIT = `±${SWEEP_MAX_COORD.toLocaleString('tr-TR')} mm`;
  let path = g.path.map((raw, i) => {
    if (!Array.isArray(raw) || (raw.length !== 3 && raw.length !== 4)) throw new GeomError(`Yol noktası ${i + 1}: [x, y, z] ya da [x, y, z, r] olmalı.`);
    const q = raw.map((v) => r4(Number(v)));
    if (!q.every(Number.isFinite)) throw new GeomError(`Yol noktası ${i + 1}: geçersiz sayı.`);
    if (tooBig(q)) throw new GeomError(`Yol noktası ${i + 1}: değerler en fazla ${LIMIT}.`);
    if (q.length === 4 && q[3] < 0) throw new GeomError(`Yol noktası ${i + 1}: köşe yarıçapı (4. değer) 0 ya da pozitif olmalı.`);
    // 4. değer 0 = yarıçap verilmedi (`bend` geçerli): yazılmaz.
    if (q.length === 4 && q[3] === 0) q.pop();
    return q as SweepPoint;
  });
  const same = (a: SweepPoint, b: SweepPoint) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
  // Kapalı yolda ilk noktayı sonda tekrarlamak kapanış demektir (çokgenlerdeki gibi atılır).
  if (closed && path.length > 1 && same(path[0], path[path.length - 1])) path = path.slice(0, -1);
  if (closed && path.length < 3) throw new GeomError('Kapalı süpürme yolu için en az 3 farklı nokta gerekli.');
  if (path.length > MAX_POINTS) throw new GeomError(`Süpürme yolu en fazla ${MAX_POINTS} nokta.`);
  for (let i = 0; i + 1 < path.length; i++) {
    if (same(path[i], path[i + 1])) throw new GeomError(`Yol noktası ${i + 1} ile ${i + 2} aynı yerde; ardışık noktalar farklı olmalı.`);
  }
  if (!closed) {
    for (const i of [0, path.length - 1]) {
      if ((cornerRadius(path[i]) ?? 0) > 0) throw new GeomError(`Yol noktası ${i + 1}: açık yolun ucunda köşe yok; yarıçap (4. değer) yalnızca ara noktalara verilir.`);
    }
  }
  const out: SweepGeom = { kind: 'sweep', path };
  if (closed) out.closed = true;
  if (!empty(g.bend)) {
    const b = r4(Number(g.bend));
    if (!(b >= 0)) throw new GeomError("'bend' (köşe yay yarıçapı, mm) 0 ya da pozitif sayı olmalı.");
    if (b > SWEEP_MAX_COORD) throw new GeomError(`'bend' en fazla ${LIMIT}.`);
    if (b > 0) out.bend = b;
  }
  const hasProfile = !empty(g.profile);
  const hasDia = !empty(g.diameter);
  if (hasProfile && hasDia) throw new GeomError("Süpürme kesiti için ya 'profile' (çokgen [u, v]) ya 'diameter' (yuvarlak) verin, ikisi birden değil.");
  if (!hasProfile && !hasDia) {
    throw new GeomError("Süpürme kesiti eksik: 'profile' (çokgen [u, v]; u gidiş yönünün sağı, v yukarı, (0, 0) yolun üstünde) ya da 'diameter' (yuvarlak kesit) verin.");
  }
  if (hasProfile) {
    out.profile = cleanLoop(g.profile, 'Kesit profili');
    if (tooBig(out.profile.flat())) throw new GeomError(`Kesit profili: değerler en fazla ${LIMIT}.`);
    if (!empty(g.innerDiameter)) throw new GeomError("'innerDiameter' yalnızca 'diameter' ile kullanılır; profilde iç boşluk için 'holes' verin.");
    if (Array.isArray(g.holes) && g.holes.length) {
      out.holes = g.holes.map((h, i) => cleanLoop(h, `Kesit boşluğu ${i + 1}`));
      if (tooBig(out.holes.flat(2))) throw new GeomError(`Kesit boşlukları: değerler en fazla ${LIMIT}.`);
      checkLoopHoles(out.profile, out.holes, 'Kesit');
    }
  } else {
    const d = r4(Number(g.diameter));
    if (!(d > 0)) throw new GeomError("'diameter' (yuvarlak kesit çapı) pozitif sayı olmalı.");
    if (d > SWEEP_MAX_COORD) throw new GeomError(`'diameter' en fazla ${LIMIT}.`);
    out.diameter = d;
    if (!empty(g.holes)) throw new GeomError("'holes' yalnızca 'profile' ile kullanılır; içi boş boru için 'innerDiameter' verin.");
    if (!empty(g.innerDiameter)) {
      const di = r4(Number(g.innerDiameter));
      if (!(di > 0 && di < d)) throw new GeomError(`'innerDiameter' 0 ile dış çap (${d}) arasında olmalı.`);
      out.innerDiameter = di;
    }
  }
  if (!empty(g.up)) {
    const u = Array.isArray(g.up) && g.up.length === 3 ? g.up.map((v) => r4(Number(v))) : [];
    if (u.length === 3 && u.every(Number.isFinite) && tooBig(u)) throw new GeomError(`'up' değerleri en fazla ${LIMIT} (yalnızca yönü önemli; ör. [0, 1, 0]).`);
    if (u.length !== 3 || !u.every(Number.isFinite) || Math.hypot(u[0], u[1], u[2]) < 1e-6) {
      throw new GeomError("'up' sıfırdan farklı bir [x, y, z] yön vektörü olmalı (ör. [0, 0, 1]; düşey düzlemdeki yol için o düzlemin normali).");
    }
    // +Z (varsayılan) yazılmaz.
    if (!(u[0] === 0 && u[1] === 0 && u[2] > 0)) out.up = [u[0], u[1], u[2]];
  }
  if (!empty(g.frame)) {
    if (g.frame !== 'up' && g.frame !== 'rmf') throw new GeomError(`Geçersiz çerçeve (frame): ${String(g.frame)} ('up' ya da 'rmf').`);
    out.frame = g.frame;
  }
  // Köşe bütçesinin çözünürlükten bağımsız alt sınırı (her yol noktası en az bir halka; yuvarlak kesit en az 6 kenar):
  // dosyadan yüklerken parça yer tutucu küpe düşmeden yakalansın. Çözünürlüğe bağlı aşım üretimde hata verir.
  const sectionPts = out.profile ? out.profile.length + (out.holes ?? []).reduce((s, h) => s + h.length, 0) : (out.innerDiameter ? 2 : 1) * SWEEP_MIN_SIDES;
  if (path.length * sectionPts > SWEEP_MAX_VERTS) {
    throw new GeomError(
      `Süpürme ağı köşe sınırını aşıyor: ${path.length} yol noktası × ${sectionPts} kesit noktası > ${SWEEP_MAX_VERTS.toLocaleString('tr-TR')}; yol ya da kesit noktalarını azaltın.`,
    );
  }
  checkSweep(out);
  return out;
}

/** 2B nokta çokgenin içinde mi (ışın sayma; sınırdaki nokta belirsiz — sınır teması ayrıca denetlenir). */
function pointInPoly([x, y]: Pt2, poly: Pt2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** İki kapalı çokgenin kenarları kesişiyor ya da birbirine değiyor mu (1e-6 mm'den yakın). */
function loopsTouch(p: Pt2[], q: Pt2[]): boolean {
  const ptSeg = ([px, py]: Pt2, [ax, ay]: Pt2, [bx, by]: Pt2) => {
    const [dx, dy] = [bx - ax, by - ay];
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  for (let i = 0; i < p.length; i++) {
    const [a, b] = [p[i], p[(i + 1) % p.length]];
    for (let j = 0; j < q.length; j++) {
      const [c, d] = [q[j], q[(j + 1) % q.length]];
      if (segmentsCross(a, b, c, d) || Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b)) < 1e-6) return true;
    }
  }
  return false;
}

/**
 * Süpürme kesitindeki (`label` 'Kesit') ya da kaplamadaki ('Kaplama') boşluklar: profilin içinde, kenarına değmeyen, birbirini
 * kesmeyen ve kapsamayan çokgenler olmalı (aksi hâlde kapak / yüz üçgenlenemez). Extrude'da bu denetim yok (var olan dosyalar
 * yüklenmeye devam etsin).
 */
function checkLoopHoles(profile: Pt2[], holes: Pt2[][], label: 'Kesit' | 'Kaplama'): void {
  holes.forEach((h, i) => {
    const what = `${label} boşluğu ${i + 1}`;
    if (loopsTouch(h, profile)) throw new GeomError(`${what} profilin kenarına değiyor ya da onu kesiyor; boşluk ile dış çevre arasında et bırakın.`);
    if (!pointInPoly(h[0], profile)) throw new GeomError(`${what} profilin dışında; boşluk köşeleri profilin içinde olmalı.`);
    for (let j = 0; j < i; j++) {
      if (loopsTouch(h, holes[j]) || pointInPoly(h[0], holes[j]) || pointInPoly(holes[j][0], h)) {
        throw new GeomError(`${label} boşlukları ${j + 1} ve ${i + 1} birbirine değiyor, kesişiyor ya da biri ötekinin içinde; her boşluk ayrı olmalı.`);
      }
    }
  });
}

/** Yuvarlak kesit: köşeden köşeye çaplı n kenarlı çokgen, bir düz kenarı −v'ye bakar (prizma kuralı), saat yönünün tersi. */
function roundLoop(r: number, n: number): Pt2[] {
  return Array.from({ length: n }, (_, j) => {
    const a = -Math.PI / 2 + Math.PI / n + (2 * Math.PI * j) / n;
    return [r * Math.cos(a), r * Math.sin(a)] as Pt2;
  });
}

function sweepRaw(g: SweepGeom, seg: number): RawMesh {
  const plan = sweepPlan(g);
  const { samples, length, arcLength } = sweepSamples(plan, (theta) => Math.max(1, Math.ceil((seg * theta) / (2 * Math.PI) - 1e-9)));
  const round = g.diameter !== undefined;
  const sides = round ? Math.max(3, Math.round(seg)) : 0;
  // Kesit halkaları [u, v]: dış çevre saat yönünün tersine, boşluklar saat yönünde (yuvarlak iç çevre ters sırada).
  const cw = (h: Pt2[]) => (signedArea(h) > 0 ? [h[0], ...h.slice(1).reverse()] : h);
  const loops: Pt2[][] = round
    ? [roundLoop(g.diameter! / 2, sides), ...(g.innerDiameter ? [roundLoop(g.innerDiameter / 2, sides).reverse()] : [])]
    : [ccw(g.profile!), ...(g.holes ?? []).map(cw)];
  const m = samples.length;
  const M = loops.reduce((s, l) => s + l.length, 0);
  if (m * M > SWEEP_MAX_VERTS) {
    throw new GeomError(
      `Süpürme ağı çok büyük (${m} halka × ${M} kesit noktası > ${SWEEP_MAX_VERTS.toLocaleString('tr-TR')} köşe): çözünürlüğü düşürün (yay kirişleri ve ` +
        'yuvarlak kesitin kenar sayısı ondan gelir) ya da yol/kesit noktalarını azaltın.',
    );
  }
  const { v: frames, shift } = sweepFrames(samples, plan.closed, sweepUp(g), sweepFrameMode(g), sides, length, arcLength);
  const pos: number[] = [];
  samples.forEach((x, k) => {
    const v = frames[k];
    const u = cross3(x.t, v);
    for (const loop of loops) {
      for (const [pu, pv] of loop) {
        let c = add3(mul3(u, pu), mul3(v, pv));
        if (x.miter) c = add3(c, mul3(x.miter.d, dot3(c, x.miter.d) * (x.miter.k - 1)));
        pos.push(x.p[0] + c[0], x.p[1] + c[1], x.p[2] + c[2]);
      }
    }
  });
  const idx: number[] = [];
  const dist2 = (a: number, b: number) => (pos[3 * a] - pos[3 * b]) ** 2 + (pos[3 * a + 1] - pos[3 * b + 1]) ** 2 + (pos[3 * a + 2] - pos[3 * b + 2]) ** 2;
  // Yan dörtgen (A, B halka k'da; D, C halka k+1'de; dışa bakan sıra A → D → C → B) kısa köşegeninden bölünür: kural konumdan
  // gelir, indis sırasından değil — aynalanan kesitte sıra ters döndüğünde de aynı köşegen seçilir (birebir ayna).
  const quad = (A: number, B: number, C: number, D: number) => {
    if (dist2(B, D) < dist2(A, C) * (1 - 1e-9)) idx.push(A, D, B, D, C, B);
    else idx.push(A, D, C, A, C, B);
  };
  let off = 0;
  for (const [l, loop] of loops.entries()) {
    const n = loop.length;
    const at = (ring: number, j: number) => ring * M + off + (((j % n) + n) % n);
    for (let k = 0; k < (plan.closed ? m : m - 1); k++) {
      const k2 = (k + 1) % m;
      // Kapalı yuvarlak kesitte dikiş: son halkanın j. noktası ilk halkanın j + shift. noktasıdır (iç çevre ters sıralı).
      const sh = plan.closed && k === m - 1 ? (l === 0 ? shift : -shift) : 0;
      for (let j = 0; j < n; j++) quad(at(k, j), at(k, j + 1), at(k2, j + 1 + sh), at(k2, j + sh));
    }
    off += n;
  }
  if (!plan.closed) {
    // Uç kapakları yola dik: başlangıç −t'ye bakar ((u, v)'de saat yönünün tersi, çünkü u × v = −t), bitiş ters.
    const flat = loops.flat();
    let faces: number[][];
    if (round && loops.length === 2) {
      // İçi boş boru: iki eş açılı halka arasında şerit (earcut eş açılı çokgenlerde köşe atlayıp sıfır alanlı üçgen verir).
      // Dış j. köşe ile iç çevrede aynı açıdaki köşe (ters sıralı: yerel n − 1 − j).
      const inner = (j: number) => sides + sides - 1 - (j % sides);
      faces = Array.from({ length: sides }, (_, j) => [
        [j, (j + 1) % sides, inner(j + 1)],
        [j, inner(j + 1), inner(j)],
      ]).flat();
    } else {
      const toV2 = (l: Pt2[]) => l.map(([a, b]) => new THREE.Vector2(a, b));
      faces = THREE.ShapeUtils.triangulateShape(toV2(loops[0]), loops.slice(1).map(toV2));
    }
    const end = (m - 1) * M;
    for (const [a, b, c] of faces) {
      const [pa, pb, pc] = [flat[a], flat[b], flat[c]];
      const [b0, c0] = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]) > 0 ? [b, c] : [c, b];
      idx.push(a, b0, c0, end + a, end + c0, end + b0);
    }
  }
  const out = { pos, idx };
  // Earcut'un atladığı doğrusal kapak köşeleri (ör. aynı hizadaki boşluklar): kapak üçgeni o köşeden bölünür.
  fixTJunctions(out);
  return out;
}

/**
 * Düz kaplama: profil + boşluklar earcut ile üçgenlenir, her üçgen +Z'ye bakacak sırada (profilin dönüş yönünden bağımsız),
 * köşeler z = lift'te; `scale` yalnızca XY'yi büyütür (lift yüzeyden uzaklıktır). Sıfır alanlı üçgenler (doğrusal köşeler)
 * atılır, earcut'un atladığı doğrusal köşeler (T-kavşağı) onarılır: açık ağda eşsiz kenar olağandır (dış çevre), onarım
 * yalnızca başka bir eşsiz kenarın ucu üstüne düşen kenarı böler. Ağ açıktır; hacmi yoktur.
 */
function decalGeometry(g: DecalGeom, scale: number): THREE.BufferGeometry {
  const flat = [g.profile, ...(g.holes ?? [])].flat();
  const toV2 = (l: Pt2[]) => l.map(([a, b]) => new THREE.Vector2(a, b));
  const faces = THREE.ShapeUtils.triangulateShape(toV2(g.profile), (g.holes ?? []).map(toV2));
  const z = decalLift(g);
  const m: RawMesh = { pos: flat.flatMap(([x, y]) => [x * scale, y * scale, z]), idx: [] };
  for (const [a, b, c] of faces) {
    const [pa, pb, pc] = [flat[a], flat[b], flat[c]];
    const [ux, uy, vx, vy] = [pb[0] - pa[0], pb[1] - pa[1], pc[0] - pa[0], pc[1] - pa[1]];
    const cross = ux * vy - uy * vx;
    const longest = Math.max(ux * ux + uy * uy, vx * vx + vy * vy, (pc[0] - pb[0]) ** 2 + (pc[1] - pb[1]) ** 2);
    if (Math.abs(cross) <= 1e-12 * longest) continue;
    if (cross > 0) m.idx.push(a, b, c);
    else m.idx.push(a, c, b);
  }
  fixTJunctions(m);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
  geo.setIndex(m.idx);
  return geo;
}

/** Yerel koordinatlarda indisli, kapalı ağ (normal yok; `decal` kalınlıksız açık ağdır). */
export function buildGeomIndexed(geom: PartGeom, params: Record<string, number>, seg: number): THREE.BufferGeometry {
  const scale = params.scale ?? 1;
  switch (geom.kind) {
    case 'extrude':
      return finish(extrudeRaw(geom, params.height ?? 10), geom.axis, scale);
    case 'revolve':
      return finish(revolveRaw(geom, seg), geom.axis, scale);
    case 'loft':
      return finish(loftRaw(geom, seg), geom.axis, scale);
    case 'sweep':
      return finish(sweepRaw(geom, seg), 'z', scale);
    case 'decal':
      return decalGeometry(geom, scale);
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
