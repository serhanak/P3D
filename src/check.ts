// Model denetimi: ekranda titreşen çakışık yüzeyler (z-fighting), baskıyı zorlaştıran durumlar, boolean hataları.
// Yapay zekâ doğrulama döngüsünde `npm run -s p3d -- check` ile çalışır; Node ve tarayıcıda aynı kod.
// Profil: `print` (varsayılan; tabla teması, ince parça) ya da `game` (üçgen bütçesi — isteğe bağlı gizli üçgenler atılmış —, bozuk üçgen;
// baskı kuralları yok).
// Kaplamalar (decal) kalınlıksız açık ağdır: ince parça / tabla / gizli yüz kurallarına girmez; z-fighting'de yalnızca gerçekten
// çakışık (aynı düzlemde) oldukları yüzler bildirilir — taşıyıcı yüzden `lift` kadar ayrık kaplama temizdir.
// Z-fighting'de başka bir opak katının içinde kalan örtüşme sayılmaz (hiç görünmez; profil ve `cullHidden`'dan bağımsız).
import * as THREE from 'three';
import { Occluders, cullAndRepair } from './cull';
import { partBox } from './engine';
import { worldMesh } from './io';
import type { WorldMesh } from './meshio';
import { displayOpacity, exportableParts, holesFor, isDecal, roleOf, solidGeometry } from './model';
import { PLACEHOLDER_SIZE, geometryError, partSeg, usesResolution } from './shapes';
import type { Part, Project } from './types';

export interface CheckIssue {
  level: 'hata' | 'uyarı';
  message: string;
}

export interface CheckOptions {
  /** print (varsayılan): 3D baskı. game: oyun motoru (düşük poligon). */
  profile?: 'print' | 'game';
  /** game: toplam üçgen bütçesi (varsayılan 20000). */
  maxTris?: number;
  /**
   * game: bütçe, gizli üçgenler atıldıktan sonraki sayıyla hesaplanır (GLB `cullHidden` / `export --cull-hidden` çıktısı).
   * Verilmezse ve bütçe aşılırsa uyarı atılabilecek gizli üçgen sayısını söyler. print profilinde etkisiz.
   */
  cullHidden?: boolean;
}

/** Oyun profilinde varsayılan toplam üçgen bütçesi. */
export const DEFAULT_MAX_TRIS = 20000;

/** Bozuk üçgen: en uzun kenara göre yüksekliği bundan küçük (mm) — alanı ~0 (çakışık ya da doğrusal köşeler). */
const DEGENERATE_HEIGHT = 1e-4;

/** FDM için alt sınır (0.4 mm nozül ≈ iki çizgi). */
const MIN_WALL = 0.8;

type V2 = [number, number];

/** İki üçgenin 2B kesişimi (ayırıcı eksen testi; kenar teması kesişim sayılmaz). */
function trianglesOverlap(a: V2[], b: V2[]): boolean {
  for (const tri of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const [p, q] = [tri[i], tri[(i + 1) % 3]];
      const n: V2 = [q[1] - p[1], p[0] - q[0]];
      const proj = (t: V2[]) => t.map((v) => v[0] * n[0] + v[1] * n[1]);
      const [pa, pb] = [proj(a), proj(b)];
      const eps = 1e-6 * (Math.abs(n[0]) + Math.abs(n[1]));
      if (Math.max(...pa) <= Math.min(...pb) + eps || Math.max(...pb) <= Math.min(...pa) + eps) return false;
    }
  }
  return true;
}

/** 2B çokgenin işaretli alanı (saat yönünün tersi pozitif). */
function signedArea(p: V2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [a, b] = [p[i], p[(i + 1) % p.length]];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** İki üçgenin 2B kesişim çokgeni (Sutherland–Hodgman; ikisi de dışbükey). Kesişim yoksa boş. */
function triangleIntersection(a: V2[], b: V2[]): V2[] {
  const clip = signedArea(b) < 0 ? [b[0], b[2], b[1]] : b;
  let out: V2[] = signedArea(a) < 0 ? [a[0], a[2], a[1]] : a;
  for (let i = 0; i < 3 && out.length; i++) {
    const [p, q] = [clip[i], clip[(i + 1) % 3]];
    const side = (v: V2) => (q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0]);
    const next: V2[] = [];
    for (let k = 0; k < out.length; k++) {
      const [u, w] = [out[k], out[(k + 1) % out.length]];
      const [su, sw] = [side(u), side(w)];
      if (su >= 0) next.push(u);
      if ((su > 0 && sw < 0) || (su < 0 && sw > 0)) {
        const s = su / (su - sw);
        next.push([u[0] + s * (w[0] - u[0]), u[1] + s * (w[1] - u[1])]);
      }
    }
    out = next;
  }
  return out.length >= 3 ? out : [];
}

/** Dışbükey 3B düzlem çokgeninin en dar genişliği: kenarlardan birine yaslanan en dar şerit (döner kumpas). */
function minWidth(p: THREE.Vector3[]): number {
  let best = Infinity;
  const dir = new THREE.Vector3();
  const r = new THREE.Vector3();
  for (let i = 0; i < p.length; i++) {
    dir.subVectors(p[(i + 1) % p.length], p[i]);
    const len = dir.length();
    if (len < 1e-12) continue;
    dir.divideScalar(len);
    let far = 0;
    for (const v of p) {
      r.subVectors(v, p[i]);
      far = Math.max(far, r.addScaledVector(dir, -r.dot(dir)).length());
    }
    best = Math.min(best, far);
  }
  return Number.isFinite(best) ? best : 0;
}

/**
 * Kıl payı örtüşme: gerçek örtüşme alanı, örtüşen üçgen çiftlerinin küçüğünün alanları toplamının bu kesrinden azsa yüzler ince
 * bir şeritte üst üste biniyordur (değmesi gereken iki parçanın ortak noktaları birebir aynı değil: yuvarlama, teğet kırığı).
 */
const SLIVER_FRACTION = 0.05;
/** …ve örtüşme parçalarının en dar genişliği bundan (mm) küçükse: geniş ama büyük üçgenlere göre küçük kama kıl payı değildir. */
const SLIVER_WIDTH = 1;

/** İzdüşümde atılacak eksen (0 = x, 1 = y, 2 = z): mutlak değeri en büyük bileşen; eşitlikte z, sonra y. */
function dropAxis(r: number[]): 0 | 1 | 2 {
  const [x, y, z] = r.map(Math.abs);
  if (z >= x && z >= y) return 2;
  return y >= x ? 1 : 0;
}

interface PlaneTri {
  part: string;
  pts: V2[];
  area: number;
  /** Düzlemin orijine uzaklığı (mm, yuvarlanmamış). */
  d: number;
  /** Birim normal (izdüşümü geri almak ve alanı düzeltmek için). */
  n: [number, number, number];
  /** İzdüşümde atılan eksen. */
  drop: 0 | 1 | 2;
}

/** İzdüşümdeki 2B noktayı üçgenin düzlemine geri kaldırır (atılan koordinat düzlem denkleminden). */
function unproject(t: PlaneTri, [u, v]: V2): THREE.Vector3 {
  const [nx, ny, nz] = t.n;
  if (t.drop === 0) return new THREE.Vector3((t.d - ny * u - nz * v) / nx, u, v);
  if (t.drop === 1) return new THREE.Vector3(u, (t.d - nx * u - nz * v) / ny, v);
  return new THREE.Vector3(u, v, (t.d - nx * u - ny * v) / nz);
}

/**
 * Kaplama ile katı arasında yalnızca bundan yakın (mm) düzlemler çakışık sayılır: kova 0,02 mm'lik dilimdir, ama yüzeyden
 * `lift` (≥ 0,01 mm) kadar ayrık kaplama taşıyıcı yüzüyle titreşmez (görünümde polygonOffset de var).
 */
const DECAL_COPLANAR = 1e-3;

/**
 * Gizli örtüşme (Boltrush isteği #26): örtüşme bölgesinin önünde bu kadar (mm) derinlikte başka bir opak katının malzemesi varsa
 * bölge görünmez. Kova dilimi (0,02 mm) bundan dar: aynı kovadaki eş düzlemli, aynı yöne bakan yüzler (öbür parça, üçüncü bir
 * titreşen parça) bölgeyi örtmüş sayılmaz.
 */
const HIDDEN_PUSH = 0.05;
/**
 * Kısmen örtülü örtüşme üçgeni en çok bu kadar kez dörde bölünür (kenar 1/16). En küçük bölmede karışık kalan parça, iç örnek
 * noktalarının hepsi örtücülerin içindeyse gizli (iki bloğun birleşim çizgisi), değilse görünür sayılır.
 */
const HIDDEN_DEPTH = 4;

/**
 * Örtüşme çokgeninin (dışbükey, düzlemde; `n` önü) görünür alan kesri: yelpaze üçgenleri örtücülere göre sınıflanır, kısmen
 * örtülen üçgen dörde bölünür. Hiçbir örtücü yakında değilse tam 1 (alanlar değişmez).
 */
function visibleFraction(poly: THREE.Vector3[], n: [number, number, number], occ: Occluders, skip: ReadonlySet<number>): number {
  const box = new THREE.Box3().setFromPoints(poly);
  const cands = occ.near(box.min.toArray(), box.max.toArray(), HIDDEN_PUSH, skip);
  if (!cands.length) return 1;
  const area = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
  const mid = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().add(b).multiplyScalar(0.5);
  const walk = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, s: number, depth: number): number => {
    const cls = occ.classify([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], n, HIDDEN_PUSH, cands, depth === HIDDEN_DEPTH);
    if (cls === 1) return 0;
    if (cls === 0 || depth === HIDDEN_DEPTH) return s;
    const [ab, bc, ca] = [mid(a, b), mid(b, c), mid(c, a)];
    return [[a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]].reduce((sum, [p, q, r]) => sum + walk(p, q, r, s / 4, depth + 1), 0);
  };
  let total = 0;
  let visible = 0;
  for (let k = 1; k + 1 < poly.length; k++) {
    const s = area(poly[0], poly[k], poly[k + 1]);
    total += s;
    visible += walk(poly[0], poly[k], poly[k + 1], s, 0);
  }
  return total > 0 ? visible / total : 1;
}

/**
 * Aynı düzlemde, aynı yöne bakan, üst üste binen yüzeyler: farklı parçalar arasında z-fighting. Kaplama–katı çiftinde yalnızca
 * tam çakışık düzlemler (DECAL_COPLANAR); kaplama–kaplama çifti katılar gibi. Örtüşmenin başka bir opak katının içinde kalan
 * kısmı sayılmaz (`visibleFraction`; örtücüler ayıklamadakiyle aynı: kaplama olmayan, görünen saydamlığı 1, kapalı katılar).
 */
function coplanarOverlaps(project: Project, solids: Part[], meshOf: (p: Part) => WorldMesh): CheckIssue[] {
  const decalIds = new Set(solids.filter(isDecal).map((p) => p.id));
  // İlk örtüşmede kurulur: temiz modelde maliyeti yok.
  let occ: { set: Occluders; index: Map<string, number> } | undefined;
  const occluders = () => {
    if (!occ) {
      const bodies = solids.filter((p) => !isDecal(p));
      occ = { set: new Occluders(bodies.map((p) => ({ ...meshOf(p), occluder: displayOpacity(p) >= 1 }))), index: new Map(bodies.map((p, k) => [p.id, k])) };
    }
    return occ;
  };
  const buckets = new Map<string, PlaneTri[]>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const part of solids) {
    const m = meshOf(part);
    for (let i = 0; i < m.tris.length; i += 3) {
      a.fromArray(m.pos, m.tris[i] * 3);
      b.fromArray(m.pos, m.tris[i + 1] * 3);
      c.fromArray(m.pos, m.tris[i + 2] * 3);
      n.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const area = n.length() / 2;
      if (area < 1e-3) continue;
      n.normalize();
      const d = n.dot(a);
      const r = [Math.round(n.x * 200), Math.round(n.y * 200), Math.round(n.z * 200)];
      const key = `${r[0]},${r[1]},${r[2]}|${Math.round(d * 50)}`;
      // Düzleme izdüşüm: normalin en büyük bileşeni atılır. Kovadaki tüm üçgenler aynı düzleme izdüşsün diye kova
      // anahtarındaki yuvarlanmış normalden seçilir (float normalden seçilirse |nx| ≈ |ny| iken aynı kovada iki ayrı
      // izdüşüm olur, uzak yüzler çakışık görünür); eşitlikte sabit sıra z, y, x.
      const drop = dropAxis(r);
      const to2 = (v: THREE.Vector3): V2 => (drop === 0 ? [v.y, v.z] : drop === 1 ? [v.x, v.z] : [v.x, v.y]);
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push({ part: part.id, pts: [to2(a), to2(b), to2(c)], area, d, n: [n.x, n.y, n.z], drop });
    }
  }
  /**
   * Çift başına: `est` tespit ölçüsü (örtüşen üçgen çiftlerinin küçüğünün alanı; eşik bununla, davranış değişmesin), `real` gerçek
   * örtüşme alanı (üçgen ∩ üçgen, düzlemde), `width` örtüşme parçalarının en dar genişliklerinin en büyüğü (kıl payı şeridi).
   */
  const pairs = new Map<string, { est: number; real: number; best: number; width: number; normal: string; d: string }>();
  for (const [key, list] of buckets) {
    const owners = new Set(list.map((t) => t.part));
    if (owners.size < 2) continue;
    const byPart = new Map<string, PlaneTri[]>();
    for (const t of list) (byPart.get(t.part) ?? byPart.set(t.part, []).get(t.part)!).push(t);
    const ids = [...byPart.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        let est = 0;
        let real = 0;
        let width = 0;
        let checks = 0;
        const decalPair = decalIds.has(ids[i]) !== decalIds.has(ids[j]);
        let skip: Set<number> | undefined;
        outer: for (const ta of byPart.get(ids[i])!) {
          for (const tb of byPart.get(ids[j])!) {
            if (++checks > 200000) break outer;
            if (decalPair && Math.abs(ta.d - tb.d) >= DECAL_COPLANAR) continue;
            if (!trianglesOverlap(ta.pts, tb.pts)) continue;
            const poly = triangleIntersection(ta.pts, tb.pts);
            const poly3 = poly.map((v) => unproject(ta, v));
            // Görünür kesir: başka bir opak katının içinde kalan kısım sayılmaz (iki parça kendini örtmez).
            let vis = 1;
            if (poly3.length >= 3) {
              const o = occluders();
              skip ??= new Set([ids[i], ids[j]].flatMap((id) => (o.index.has(id) ? [o.index.get(id)!] : [])));
              vis = visibleFraction(poly3, ta.n, o.set, skip);
              if (vis === 0) continue;
            }
            est += Math.min(ta.area, tb.area) * vis;
            if (!poly.length) continue;
            // İzdüşüm alanı / |n·atılan eksen| = düzlemdeki alan.
            real += (Math.abs(signedArea(poly)) / Math.abs(ta.n[ta.drop])) * vis;
            width = Math.max(width, minWidth(poly3));
          }
        }
        if (est < 0.01) continue;
        const pk = [ids[i], ids[j]].sort().join('|');
        const [nx, ny, nz, d] = key.split(/[,|]/).map(Number);
        const where = { normal: `${(nx / 200).toFixed(2)}, ${(ny / 200).toFixed(2)}, ${(nz / 200).toFixed(2)}`, d: (d / 50).toFixed(2) };
        const prev = pairs.get(pk);
        if (!prev) pairs.set(pk, { est, real, best: real, width, ...where });
        else {
          // İletideki düzlem: gerçek örtüşmesi en büyük kova.
          if (real > prev.best) Object.assign(prev, { best: real, ...where });
          prev.est += est;
          prev.real += real;
          prev.width = Math.max(prev.width, width);
        }
      }
    }
  }
  const name = (id: string) => project.parts.find((p) => p.id === id)?.name ?? id;
  return [...pairs].map(([pk, v]) => {
    const [x, y] = pk.split('|');
    const sliver = v.real < SLIVER_FRACTION * v.est && v.width < SLIVER_WIDTH;
    const tr = (n: number) => n.toLocaleString('tr-TR', { maximumSignificantDigits: 2 });
    return {
      level: 'hata' as const,
      message:
        `'${name(x)}' ile '${name(y)}' aynı düzlemde üst üste yüzeylere sahip (normal ${v.normal}, düzlem ${v.d} mm, ` +
        `örtüşme ≈${v.real >= 0.01 ? v.real.toFixed(2) : '<0.01'} mm²): ekranda titreşir (z-fighting). ` +
        (sliver
          ? `Kıl payı örtüşme (en fazla ~${v.width < 0.001 ? '<0,001' : tr(v.width)} mm genişlikte şerit, örtüşen üçgenlere oranı %${tr((100 * v.real) / v.est)}): ` +
            'birbirine değmesi gereken iki parçanın ortak noktaları birebir aynı değil (yuvarlama, birleşimde teğet kırığı). ' +
            'Ortak noktaları iki parçada da aynı değerlerle verin.'
          : 'Birini 0,05–0,2 mm kaydırın, gömün ya da delikle o yüzeyi tek parçaya bırakın.'),
    };
  });
}

/** Bozuk (alanı ~0) üçgen sayısı. */
function degenerateCount(m: WorldMesh): number {
  let n = 0;
  const { pos, tris } = m;
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [tris[i] * 3, tris[i + 1] * 3, tris[i + 2] * 3];
    const e1 = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const e2 = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    const e3 = [pos[c] - pos[b], pos[c + 1] - pos[b + 1], pos[c + 2] - pos[b + 2]];
    const cross = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    const longest = Math.max(Math.hypot(...e1), Math.hypot(...e2), Math.hypot(...e3));
    // yükseklik = 2·alan / taban = |e1 × e2| / en uzun kenar
    if (longest < DEGENERATE_HEIGHT || cross / longest < DEGENERATE_HEIGHT) n++;
  }
  return n;
}

/**
 * Parça başına ayıklama sayıları (GLB `cullHidden` ile aynı kural, girdi ve T-kavşağı onarımı): atılan, onarımın eklediği ve
 * kalan üçgen. Kaplamalar girmez, görünen saydamlığı < 1 olan parça örtmez.
 */
function cullCounts(solids: Part[], meshOf: (p: Part) => WorldMesh): Map<Part, { culled: number; added: number; tris: number }> {
  const bodies = solids.filter((p) => !isDecal(p));
  const r = cullAndRepair(bodies.map((p) => ({ ...meshOf(p), occluder: displayOpacity(p) >= 1 })));
  return new Map(bodies.map((p, k) => [p, { culled: r.culled[k], added: r.split[k], tris: r.tris[k].length / 3 }]));
}

/**
 * Oyun profili: toplam üçgen bütçesi (aşılırsa parça başına dağılım) ve bozuk üçgenler. `cullHidden`: bütçe, gizli üçgenler
 * atıldıktan sonraki sayıyla (GLB `--cull-hidden` çıktısı) hesaplanır; verilmemişse ve bütçe aşılmışsa mesaj atılabilecek gizli
 * üçgen sayısını söyler. Gizli üçgenler ayrıca bildirilmez (bütçe yoksa ya da aşılmıyorsa sorun değildir).
 */
function gameChecks(solids: Part[], meshOf: (p: Part) => WorldMesh, maxTris: number, seg: number, cullHidden: boolean): CheckIssue[] {
  const out: CheckIssue[] = [];
  const cull = cullHidden ? cullCounts(solids, meshOf) : undefined;
  const counts = solids.map((p) => ({ part: p, tris: cull?.get(p)?.tris ?? meshOf(p).tris.length / 3 }));
  const total = counts.reduce((s, c) => s + c.tris, 0);
  if (total > maxTris) {
    const sum = (m: Map<Part, { culled: number; added: number }>, key: 'culled' | 'added') => [...m.values()].reduce((s, c) => s + c[key], 0);
    const now = cull ? undefined : cullCounts(solids, meshOf);
    const tr = (n: number) => n.toLocaleString('tr-TR');
    // Onarım (T-kavşağı) birkaç üçgen ekler: sayı GLB'deki ile aynı.
    const cullNote = cull
      ? ` (${tr(sum(cull, 'culled'))} gizli üçgen atıldıktan${sum(cull, 'added') ? `, T-kavşağı onarımı ${tr(sum(cull, 'added'))} üçgen ekledikten` : ''} sonra)`
      : '';
    const hiddenNow = now ? sum(now, 'culled') : 0;
    const addedNow = now ? sum(now, 'added') : 0;
    const cullHint =
      hiddenNow > 0
        ? ` ${tr(hiddenNow)} üçgen görünmez; \`export --cull-hidden\` ile atılır${addedNow ? ` (birleşim çizgisi onarımı ${tr(addedNow)} üçgen ekler)` : ''} (\`check --cull-hidden\` bütçeyi ona göre sayar).`
        : '';
    counts.sort((a, b) => b.tris - a.tris);
    const list = counts.map((c) => `${c.part.name} ${c.tris.toLocaleString('tr-TR')}`).join(', ');
    // En çok üçgenli yuvarlak parçalar (bütçenin ≥ %5'i): parça başına çözünürlükle tek tek sadeleşir.
    const heavy = counts
      .filter((c) => usesResolution(c.part) && c.tris >= maxTris * 0.05)
      .slice(0, 5)
      .map((c) => `${c.part.name} (${partSeg(c.part, seg)})`);
    const hint = heavy.length ? ` Çok üçgenli yuvarlak parçalar (segment): ${heavy.join(', ')} — bunlara parça başına \`resolution\` (ör. 8–16) verin.` : '';
    out.push({
      level: 'uyarı',
      message:
        `Toplam ${total.toLocaleString('tr-TR')} üçgen${cullNote}; bütçe ${maxTris.toLocaleString('tr-TR')} aşıldı. Parça başına: ${list}. ` +
        'Yuvarlak yüzey çözünürlüğünü düşürün (proje ayarı 6–16 ya da parça başına `resolution`), `hull` parçalarına `geom.maxTris` verin ya da ayrıntıyı azaltın.' +
        hint +
        cullHint,
    });
  }
  for (const p of solids) {
    const n = degenerateCount(meshOf(p));
    if (n) out.push({ level: 'uyarı', message: `'${p.name}': ${n} bozuk (alanı ~0) üçgen; oyun motoru normal/gölge hatası verebilir.` });
  }
  return out;
}

export function checkProject(project: Project, opts: CheckOptions = {}): CheckIssue[] {
  const seg = project.settings.resolution;
  const game = opts.profile === 'game';
  const out: CheckIssue[] = [];
  const solids = exportableParts(project.parts);
  if (!solids.length) return [{ level: 'uyarı', message: 'Görünür katı parça yok.' }];
  // Son (delikli) ağ parça başına bir kez üretilir: boolean pahalıdır.
  const meshes = new Map<string, WorldMesh>();
  const meshOf = (p: Part) => meshes.get(p.id) ?? meshes.set(p.id, worldMesh(project, p)).get(p.id)!;

  // Üretilemeyen geometri yerine çizilen yer tutucu küp ekranda/dosyada parça gibi görünür; açıkça hata olarak bildirilir.
  for (const p of project.parts.filter((x) => x.visible)) {
    const err = geometryError(p.shape, p.params, partSeg(p, seg), p.geom);
    if (err) out.push({ level: 'hata', message: `'${p.name}': geometri üretilemedi, yerine ${PLACEHOLDER_SIZE} mm'lik yer tutucu küp çiziliyor (${err}).` });
  }
  for (const p of solids) {
    const r = solidGeometry(project, p);
    r.geometry.dispose();
    if (r.error) out.push({ level: 'hata', message: `'${p.name}': ${r.error}` });
  }
  for (const h of project.parts.filter((p) => p.visible && roleOf(p) === 'hole')) {
    if (!solids.some((s) => holesFor(project, s).includes(h))) out.push({ level: 'uyarı', message: `Delik '${h.name}' hiçbir katıyı kesmiyor.` });
  }
  if (game) out.push(...gameChecks(solids, meshOf, opts.maxTris ?? DEFAULT_MAX_TRIS, seg, opts.cullHidden === true));
  else {
    // Baskı kuralları yalnızca katılarda: kaplama kalınlıksızdır ve baskıya girmez.
    const bodies = solids.filter((p) => !isDecal(p));
    for (const p of bodies) {
      const s = partBox(p, seg).getSize(new THREE.Vector3());
      const min = Math.min(s.x, s.y, s.z);
      if (min < MIN_WALL) out.push({ level: 'uyarı', message: `'${p.name}' ${min.toFixed(2)} mm kalınlığında; ${MIN_WALL} mm altı FDM'de basılmayabilir (başka parçaya gömülüyse sorun değil).` });
    }
    // Tabla teması son (delikler uygulanmış) geometriye göre: tabla altı bilerek kesilmiş parçalar yanlış uyarı vermesin.
    const box = new THREE.Box3();
    for (const p of bodies) box.union(new THREE.Box3().setFromArray(meshOf(p).pos));
    // Yalnızca kaplama varsa kutu boştur: tabla kuralı yok.
    if (!box.isEmpty() && box.min.z < -0.01) out.push({ level: 'uyarı', message: `Model tablanın ${(-box.min.z).toFixed(2)} mm altına taşıyor.` });
    else if (!box.isEmpty() && box.min.z > 0.01) out.push({ level: 'uyarı', message: `Model tablaya değmiyor (en alt nokta z = ${box.min.z.toFixed(2)} mm).` });
  }

  out.push(...coplanarOverlaps(project, solids, meshOf));
  return out;
}
