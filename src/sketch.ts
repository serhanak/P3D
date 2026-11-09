// Eskiz (sketch): kullanıcının 3B görünümde çizdiği yollar. Yalnızca niyet verisidir: geometri üretmez, dışa aktarılmaz,
// `check`'e girmez. Claude (sahne özeti) ve Claude Code (`p3d scene` / `p3d sketch`) bu yolları okuyup parçaları var olan
// işlemlerle kurar. Bu modül saf yardımcılardır (DOM yok): tarayıcıda, Node'da (CLI, testler) aynı çalışır.
import type { GeomAxis, Pt2, SceneSummarySketch, SketchKind, SketchPath, SketchPlane, SketchPoint, Vec3 } from '../shared/ops';
import { newId } from './ids';
import { fold } from './text';
import type { Project } from './types';

export const SKETCH_MAX_POINTS = 1000;
export const SKETCH_NAME_MAX = 60;
export const SKETCH_NOTE_MAX = 200;
/** Eğri (tutamaçlı) kenar başına varsayılan örnek sayısı. */
export const SKETCH_SEGMENTS = 8;

const AXES: readonly GeomAxis[] = ['x', 'y', 'z'];

// ---------------------------------------------------------------------------
// Tür ve örnekleme

/** Sıfır olmayan tutamaç (sıfır uzunluklu tutamaç köşe sayılır). */
const hasHandle = (h: Vec3 | undefined): h is Vec3 => !!h && (h.x !== 0 || h.y !== 0 || h.z !== 0);
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Kenar sayısı: açık yolda n − 1, kapalı yolda (n ≥ 2) n (son → ilk kenarı dahil). */
function edgeCount(path: SketchPath): number {
  const n = path.points.length;
  return path.closed && n >= 2 ? n : Math.max(0, n - 1);
}

/** i. kenar (i → i+1) eğri mi: başlangıcın çıkış ya da bitişin giriş tutamacı var. */
function edgeCurved(path: SketchPath, i: number): boolean {
  const pts = path.points;
  return hasHandle(pts[i].hOut) || hasHandle(pts[(i + 1) % pts.length].hIn);
}

/** 1 nokta → marker; açık 2 nokta → arrow; kapalı ≥ 3 nokta → polygon; diğerleri → line. */
export function sketchKind(path: SketchPath): SketchKind {
  const n = path.points.length;
  if (n === 1) return 'marker';
  if (n === 2 && !path.closed) return 'arrow';
  if (path.closed && n >= 3) return 'polygon';
  return 'line';
}

/** Yolda en az bir eğri (tutamaçlı) kenar var mı. */
export function isCurved(path: SketchPath): boolean {
  for (let i = 0; i < edgeCount(path); i++) if (edgeCurved(path, i)) return true;
  return false;
}

function bezier(p0: Vec3, c1: Vec3, c2: Vec3, p3: Vec3, t: number): Vec3 {
  const m = 1 - t;
  const [a, b, c, d] = [m * m * m, 3 * m * m * t, 3 * m * t * t, t * t * t];
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
    z: a * p0.z + b * c1.z + c * c2.z + d * p3.z,
  };
}

/**
 * Yolun örneklenmiş noktaları (dünya mm). Tutamaçsız kenar düzdür (yalnız uç noktası eklenir); tutamaçlı kenar kübik
 * Bezier'dir (P0 = p_i, C1 = p_i + hOut_i, C2 = p_{i+1} + hIn_{i+1}, P3 = p_{i+1}) ve `segmentsPerCurve` parçaya bölünür
 * (1…64). Açık yolda ilk…son nokta dahil; kapalı yolda son → ilk kenarı da işlenir, ilk nokta tekrarlanmaz.
 */
export function samplePath(path: SketchPath, segmentsPerCurve = SKETCH_SEGMENTS): Vec3[] {
  const pts = path.points;
  if (!pts.length) return [];
  const seg = Number.isFinite(segmentsPerCurve) ? Math.min(64, Math.max(1, Math.round(segmentsPerCurve))) : SKETCH_SEGMENTS;
  const out: Vec3[] = [{ ...pts[0].p }];
  const edges = edgeCount(path);
  for (let i = 0; i < edges; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!edgeCurved(path, i)) {
      out.push({ ...b.p });
      continue;
    }
    const c1 = hasHandle(a.hOut) ? { x: a.p.x + a.hOut.x, y: a.p.y + a.hOut.y, z: a.p.z + a.hOut.z } : a.p;
    const c2 = hasHandle(b.hIn) ? { x: b.p.x + b.hIn.x, y: b.p.y + b.hIn.y, z: b.p.z + b.hIn.z } : b.p;
    for (let k = 1; k <= seg; k++) out.push(bezier(a.p, c1, c2, b.p, k / seg));
  }
  if (edges === pts.length) out.pop(); // kapalı yol: son örnek ilk noktanın kendisi
  return out;
}

/** Örneklenmiş nokta dizisinin uzunluğu; `closed` ise son → ilk kenarı dahil. */
function polyLength(s: Vec3[], closed: boolean): number {
  let len = 0;
  for (let i = 1; i < s.length; i++) len += dist(s[i - 1], s[i]);
  if (closed && s.length > 1) len += dist(s[s.length - 1], s[0]);
  return len;
}

/** Örneklenmiş yolun uzunluğu (mm); kapalı yolda çevre. */
export function pathLength(path: SketchPath, segmentsPerCurve = SKETCH_SEGMENTS): number {
  return polyLength(samplePath(path, segmentsPerCurve), path.closed && path.points.length >= 2);
}

function boxOf(s: Vec3[]): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of s) {
    for (const a of AXES) {
      min[a] = Math.min(min[a], v[a]);
      max[a] = Math.max(max[a], v[a]);
    }
  }
  return { min, max };
}

/** Örneklenmiş yolun (eğriler dahil) sınırlayıcı kutusu (dünya mm). */
export function pathBox(path: SketchPath, segmentsPerCurve = SKETCH_SEGMENTS): { min: Vec3; max: Vec3 } {
  return boxOf(samplePath(path, segmentsPerCurve));
}

// ---------------------------------------------------------------------------
// Düzlem ve 2B izdüşüm

/**
 * Yolun (eğriler dahil) tüm noktaları bir eksende `tol` içinde eşitse o düzlem; değilse null. Birden çok eksen
 * uyuyorsa (ör. tek nokta, eksene paralel doğru) önce yolun kendi düzlemi, sonra z, y, x.
 */
export function isPlanar(path: SketchPath, tol = 0.01): SketchPlane | null {
  const s = samplePath(path);
  if (!s.length) return null;
  const order = [...new Set<GeomAxis>([...(path.plane ? [path.plane.axis] : []), 'z', 'y', 'x'])];
  for (const a of order) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of s) {
      lo = Math.min(lo, v[a]);
      hi = Math.max(hi, v[a]);
    }
    if (hi - lo <= tol) return { axis: a, at: (lo + hi) / 2 };
  }
  return null;
}

/** Noktalardan çizim düzlemi: tüm z eşit → z; tüm y eşit → y; tüm x eşit → x; değilse {axis: 'z', at: en küçük z}. */
export function planeFromPoints(points: SketchPoint[]): SketchPlane {
  if (!points.length) return { axis: 'z', at: 0 };
  for (const a of ['z', 'y', 'x'] as const) {
    const v0 = points[0].p[a];
    if (points.every((pt) => Math.abs(pt.p[a] - v0) <= 1e-9)) return { axis: a, at: v0 };
  }
  return { axis: 'z', at: Math.min(...points.map((pt) => pt.p.z)) };
}

/** Dünya noktasının `axis` düzlemindeki 2B karşılığı; geom ile aynı kural: z → [x, y], x → [y, z], y → [x, z]. */
export function toPlane2D(v: Vec3, axis: GeomAxis): Pt2 {
  return axis === 'z' ? [v.x, v.y] : axis === 'x' ? [v.y, v.z] : [v.x, v.z];
}

/**
 * Örneklenmiş yolun kendi düzlemine (`path.plane.axis`) izdüşümü: kapalı yolda doğrudan `extrude` profili olarak
 * kullanılabilir (`axis` = düzlem ekseni, `position` {0,0,0}; profil merkezli çekildiğinden düzlemden yukarı büyümesi
 * için `position`'ın eksen bileşeni `at + height / 2`).
 */
export function pathProfile(path: SketchPath, segmentsPerCurve = SKETCH_SEGMENTS): Pt2[] {
  return samplePath(path, segmentsPerCurve).map((v) => toPlane2D(v, path.plane.axis));
}

// ---------------------------------------------------------------------------
// Doğrulama (işlem girdisi ve dosya)

function readVec(v: unknown): Vec3 | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  return ok(o.x) && ok(o.y) && ok(o.z) ? { x: o.x, y: o.y, z: o.z } : null;
}

/** Ham nokta listesini doğrular (1…1000 nokta, tüm sayılar sonlu); geçersizse Türkçe neden döner. */
export function readSketchPoints(raw: unknown): SketchPoint[] | string {
  if (!Array.isArray(raw) || !raw.length) return 'en az 1 nokta gerekli';
  if (raw.length > SKETCH_MAX_POINTS) return `en fazla ${SKETCH_MAX_POINTS} nokta olabilir (${raw.length} verildi)`;
  const out: SketchPoint[] = [];
  for (const [i, r] of raw.entries()) {
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
    const p = readVec(o.p);
    if (!p) return `${i + 1}. nokta geçersiz ({"p": {"x", "y", "z"}} sonlu sayılar olmalı)`;
    const pt: SketchPoint = { p };
    for (const k of ['hIn', 'hOut'] as const) {
      if (o[k] === undefined || o[k] === null) continue;
      const h = readVec(o[k]);
      if (!h) return `${i + 1}. noktanın ${k} tutamacı geçersiz ({"x", "y", "z"} sonlu sayılar olmalı)`;
      pt[k] = h;
    }
    out.push(pt);
  }
  return out;
}

/** {axis: 'x'|'y'|'z', at: sonlu sayı} ise düzlem, değilse null. */
export function readSketchPlane(raw: unknown): SketchPlane | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!AXES.includes(o.axis as GeomAxis) || typeof o.at !== 'number' || !Number.isFinite(o.at)) return null;
  return { axis: o.axis as GeomAxis, at: o.at };
}

// ---------------------------------------------------------------------------
// Bulma ve adlandırma (eskiz adları yalnızca eskiz yolları arasında benzersizdir)

const nameKey = (s: string) => fold(s).trim();

function nameTakenIn(paths: readonly SketchPath[], name: string, exceptId?: string): boolean {
  const f = nameKey(name);
  return paths.some((s) => s.id !== exceptId && nameKey(s.name) === f);
}

function uniqueIn(paths: readonly SketchPath[], base?: string): string {
  const clean = base?.trim();
  if (clean) {
    if (!nameTakenIn(paths, clean)) return clean;
    for (let n = 2; ; n++) if (!nameTakenIn(paths, `${clean} ${n}`)) return `${clean} ${n}`;
  }
  for (let n = 1; ; n++) if (!nameTakenIn(paths, `Yol ${n}`)) return `Yol ${n}`;
}

/** Ad başka bir eskiz yolunda kullanılıyor mu (büyük/küçük harf ve aksan duyarsız). */
export function sketchNameTaken(project: Project, name: string, exceptId?: string): boolean {
  return nameTakenIn(project.sketch ?? [], name, exceptId);
}

/** Benzersiz eskiz adı: `base` yoksa "Yol N" (kullanılmayan en küçük N), varsa çakışınca sonuna sayı eklenir. */
export function uniqueSketchName(project: Project, base?: string): string {
  return uniqueIn(project.sketch ?? [], base);
}

/** Eskiz yolunu kimliğiyle ya da tam adıyla (büyük/küçük harf ve aksan duyarsız) bulur. */
export function findSketch(project: Project, ref: string | undefined): SketchPath | undefined {
  if (!ref || !project.sketch) return undefined;
  const byId = project.sketch.find((s) => s.id === ref);
  if (byId) return byId;
  const f = nameKey(ref);
  return project.sketch.find((s) => nameKey(s.name) === f);
}

/** Dosyadan gelen eskiz kimliği bu biçimde değilse yenisi üretilir (arayüzde öznitelik değeri olarak da yazılır). */
const SKETCH_ID_RE = /^[\w-]{1,64}$/;

/**
 * Dosyadan/otomatik kayıttan gelen eskiz dizisini doğrular. Nesne olmayan, noktası olmayan ya da sayısı sonlu olmayan yol
 * atlanır (`warn` ile "eskiz 'ad' atlandı: neden"); ad yoksa "Yol N", çakışıyorsa benzersizleştirilir (≤ 60 karakter);
 * kimlik yoksa, `[\w-]{1,64}` değilse ya da yineleniyorsa üretilir; `closed` boolean değilse ya da yol 3 noktadan azsa
 * false; `plane` geçersizse noktalardan türetilir; `note` metin değilse atılır, 200 karaktere kırpılır.
 */
export function sanitizeSketch(raw: unknown, warn?: (msg: string) => void): SketchPath[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn?.('eskiz: alan bir dizi değil, okunmadı');
    return [];
  }
  const out: SketchPath[] = [];
  const ids = new Set<string>();
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      warn?.(`eskiz #${i + 1} atlandı: yol bir nesne değil`);
      return;
    }
    const r = item as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, SKETCH_NAME_MAX).trim() : '';
    const points = readSketchPoints(r.points);
    if (typeof points === 'string') {
      warn?.(`eskiz ${name ? `'${name}'` : `#${i + 1}`} atlandı: ${points}`);
      return;
    }
    let id = typeof r.id === 'string' && SKETCH_ID_RE.test(r.id) ? r.id : newId();
    if (ids.has(id)) id = newId();
    ids.add(id);
    const note = typeof r.note === 'string' ? r.note.slice(0, SKETCH_NOTE_MAX) : '';
    out.push({
      id,
      name: uniqueIn(out, name || undefined),
      closed: r.closed === true && points.length >= 3,
      plane: readSketchPlane(r.plane) ?? planeFromPoints(points),
      points,
      ...(note.trim() ? { note } : {}),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------
// Sahne özeti (Claude isteği, köprü, p3d scene / sketch)

const r2 = (n: number) => Number(n.toFixed(2)) + 0; // + 0: -0 yerine 0
const r3 = (n: number) => Number(n.toFixed(3)) + 0;
const v2 = (v: Vec3): Vec3 => ({ x: r2(v.x), y: r2(v.y), z: r2(v.z) });

/** Projenin eskiz yollarının özeti (2 ondalık; ok yönü 3 ondalık); eskiz yoksa undefined. */
export function sketchSummary(project: Project, segmentsPerCurve = SKETCH_SEGMENTS): SceneSummarySketch[] | undefined {
  if (!project.sketch?.length) return undefined;
  return project.sketch.map((s) => {
    const kind = sketchKind(s);
    const samples = samplePath(s, segmentsPerCurve);
    const box = boxOf(samples);
    let direction: Vec3 | undefined;
    if (kind === 'arrow') {
      const [a, b] = [s.points[0].p, s.points[1].p];
      const len = dist(a, b);
      if (len > 0) direction = { x: r3((b.x - a.x) / len), y: r3((b.y - a.y) / len), z: r3((b.z - a.z) / len) };
    }
    return {
      id: s.id,
      name: s.name,
      kind,
      closed: s.closed,
      plane: { axis: s.plane.axis, at: r2(s.plane.at) },
      points: s.points.map((pt) => ({
        p: v2(pt.p),
        ...(pt.hIn ? { hIn: v2(pt.hIn) } : {}),
        ...(pt.hOut ? { hOut: v2(pt.hOut) } : {}),
      })),
      ...(isCurved(s) ? { polyline: samples.map(v2) } : {}),
      ...(kind !== 'marker' ? { length: r2(polyLength(samples, s.closed && s.points.length >= 2)) } : {}),
      ...(direction ? { direction } : {}),
      bbox: { min: v2(box.min), max: v2(box.max) },
      ...(s.note ? { note: s.note } : {}),
    };
  });
}
