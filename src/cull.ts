// Gizli iç yüz ayıklama: dışa aktarılan bir katının üçgeni başka bir opak kapalı katının tamamen içinde kalıyorsa hiç görünmez
// (üst üste duran parçaların birbirine değen kapakları, gövdeye gömülü pim). GLB `cullHidden` bu üçgenleri atar,
// `check --profile game --cull-hidden` bütçeyi ayıklanmış sayar. Yalnızca görsel bir eniyilemedir: ağın kapalılığını bozar,
// baskı biçimlerine (STL/3MF) uygulanmaz. Kaplamalar (`decal`) çağıran tarafından dışarıda bırakılır: ne atılır ne atar.
//
// Kural (kesin): üçgen T, iç teğet çemberinin merkezine doğru kenarlarından ε içeri küçültülür ve normali boyunca ε dışarı itilir
// (T′). T′'nün ağırlık merkezi başka bir örtücünün (B) içindeyse ve B'nin hiçbir üçgeni T′'yü kesmiyor ya da ona değmiyorsa, T′
// bağlı düzlemsel bir bölge olduğundan tamamen B'nin içindedir: T gizlidir. Kısmen örtülen üçgen kalır (bölme yok); iki ayrı
// örtücünün birlikte örttüğü üçgen de kalır. İtme, değen yüzü komşunun içine sokar; küçültme, eş kesitli yığında kapak kenarının
// komşunun yan duvarına değmesini engeller. Değmeyen yan yüzün T′'sü komşunun dışında kalır. Aynı yerde duran eş parçalar
// birbirini örtmez (T′ öbürünün dışında). Sayısal belirsizlik (sıyıran ışın, dokunma) hep "görünür" yönündedir.
//
// ε = max(1e-3 mm, 1e-6 × ölçek): ölçek iki parçanın kutu boyu ve koordinat büyüklüğünün en büyüğüdür (float32 köşe
// hassasiyetinin ~16 katı). İç teğet yarıçapı 2ε'dan küçük üçgen yarıçapının yarısı kadar küçültülür. Alanı sıfır üçgen kalır.
// Örtücü: kapalı (her yönlü kenarın tam bir karşılığı var) ve `occluder` false olmayan ağ (saydam parça örtmez).
//
// Değme kuralı (Boltrush isteği #24): itme testi, komşu katı T'nin bir kenarında sıfır kalınlığa iniyorsa (eksende buluşan
// dilimler, ince kama) başarısız olur: T′'nün kenarı komşunun öbür yüzünden dışarı taşar. Bu yüzden itmeyle gizlenmeyen T için
// ikinci, kalınlıktan bağımsız bir test: örtücülerin T düzleminde (köşeleri ε içinde, normali T'ye paralel) duran ve içi T'nin
// önünde kalan üçgenleri T'yi 2B'de tamamen kaplıyorsa T gizlidir — T'nin her iç noktasının hemen önü bir örtücünün malzemesidir.
// "İçi önünde" yüz başına ışın paritesiyle bulunur (yüzün ağırlık merkezinden T'nin önüne 2ε), ağın toplam yönüyle değil: yönü
// karışık kabuklu ağda aynı yöne bakan yüz ters sayılmasın. Kaplama kesin çıkarmayla denetlenir (T'den örtücü üçgenler sırayla
// çıkarılır, kalan alan float gürültüsü kadar olmalı); farklı köşegenden bölünmüş ortak dörtgen ve birden çok örtücünün yüzleri
// birlikte kaplayabilir. Aynı yöne bakan çakışık yüz (aynı yerde duran eş parçalar) örtmez: önü örtücünün dışıdır. Düzlem dışına
// ε'dan fazla eğilen (bükük) ortak yüz bu kurala girmez.
//
// T-kavşağı onarımı (`cullAndRepair`, Boltrush isteği #21): parçalar arasındaki birleşim çizgilerinde kenar uçları çoğu zaman
// eşleşmez (bir parçanın köşesi öbürünün kenarının ortasına düşer). Ayıklamadan önce bu kıl payı açıklığın arkasında gizli yüz
// vardı; o yüz atılınca çizgide tek piksellik delikler görünür. Onarım: atılan üçgenlerin köşeleri (aday T noktaları) kalan
// üçgenlerin kenarlarında iç nokta olarak aranır (geometrik eşleşme, ε toleransı, uçlara ε'dan yakın olan sayılmaz) ve o kenarı
// kullanan her kalan üçgen o noktada bölünür (aynı kenarda birden çok nokta sırayla). Yalnızca çatlak yapanlar bölünür: adayın
// kalan bir kenarı bölünecek kenarla aynı doğru üzerinde olmalı (iki parçanın yüzeyleri o doğru boyunca birleşir). Kenarın içine
// düşen ama kenarları o doğruda olmayan köşe (küçük kutunun köşesi büyük yüzün köşegeninde) çatlak yapmaz; bölmek yalnızca üçgen
// eklerdi. Yeni köşe adayın kendi dünya koordinatıdır (öbür parçanın köşesiyle bit bit aynı float32).
//
// Koordinatlar dünya mm'sidir (eksen önemsiz); girdi `worldMesh` ile aynı biçimdir (köşeler + üçgen indisleri).

/** Ayıklama girdisi: dünya koordinatlarında köşeler (x, y, z …) ve üçgen indisleri. */
export interface CullMesh {
  pos: ArrayLike<number>;
  tris: ArrayLike<number>;
  /**
   * false: başka parçaları örtmez (görünen saydamlığı < 1 olan parça: arkası görünür); kendi üçgenleri yine opak parçalarca
   * atılabilir. Yok = true.
   */
  occluder?: boolean;
}

const EPS_MIN = 1e-3;
const EPS_REL = 1e-6;
/** Işın–üçgen kesişiminde ağırlık merkezi koordinatının kenara bu kadar yakın olması "sıyırma" sayılır (başka yön denenir). */
const GRAZE = 1e-9;
/** Parite ışını yönleri (eksenlere ve köşegenlere hizalı değil); hepsi sıyırırsa nokta dışarıda sayılır (üçgen kalır). */
const DIRS: [number, number, number][] = [
  [0.5381, 0.3101, 0.7838],
  [-0.2846, 0.8823, 0.3749],
  [0.7071, -0.5878, 0.3931],
  [-0.6234, -0.4417, -0.6452],
].map(([x, y, z]) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
});
const LEAF = 4;

interface Body {
  mesh: CullMesh;
  min: [number, number, number];
  max: [number, number, number];
  /** max(kutu boyu, en büyük mutlak koordinat): ε'nin ölçeği. */
  scale: number;
  /** Kapalı ve tutarlı yönlü (her yönlü kenarın tam bir karşılığı var) ve örtücü: yalnızca bunlar örter. */
  covers: boolean;
  bvh?: TriBvh;
}

const epsOf = (scale: number) => Math.max(EPS_MIN, EPS_REL * scale);

function prepare(mesh: CullMesh): Body {
  const { pos, tris } = mesh;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i] * 3;
    for (let c = 0; c < 3; c++) {
      const x = pos[v + c];
      if (x < min[c]) min[c] = x;
      if (x > max[c]) max[c] = x;
    }
  }
  const scale = tris.length ? Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], ...min.map(Math.abs), ...max.map(Math.abs)) : 0;
  const covers = tris.length > 0 && mesh.occluder !== false && isClosed(tris, pos.length / 3);
  return { mesh, min, max, scale, covers };
}

/** Kapalı ve tutarlı yönlü: her yönlü kenar bir kez ve tersi de bir kez. */
function isClosed(tris: ArrayLike<number>, nv: number): boolean {
  const edges = new Map<number, number>();
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const key = tris[t + k] * nv + tris[t + ((k + 1) % 3)];
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of edges) {
    const u = Math.floor(key / nv);
    const v = key - u * nv;
    if (n !== 1 || edges.get(v * nv + u) !== 1) return false;
  }
  return true;
}

/** Kutuları (ε payıyla) kesişen çiftler: `out[i]` = i'yi örtebilecek parçalar (x'e göre sırala ve süpür). */
function overlapping(bodies: Body[]): number[][] {
  const out = bodies.map((): number[] => []);
  const live = bodies.map((_, i) => i).filter((i) => bodies[i].mesh.tris.length > 0);
  const pad = live.map((i) => epsOf(bodies[i].scale));
  const maxPad = Math.max(0, ...pad);
  const order = live.map((_, k) => k).sort((a, b) => bodies[live[a]].min[0] - bodies[live[b]].min[0]);
  for (let s = 0; s < order.length; s++) {
    const ka = order[s];
    const A = bodies[live[ka]];
    for (let r = s + 1; r < order.length; r++) {
      const kb = order[r];
      const B = bodies[live[kb]];
      if (B.min[0] > A.max[0] + 2 * maxPad) break;
      const p = pad[ka] + pad[kb];
      if (B.min[0] > A.max[0] + p || B.min[1] > A.max[1] + p || A.min[1] > B.max[1] + p || B.min[2] > A.max[2] + p || A.min[2] > B.max[2] + p) continue;
      const [i, j] = [live[ka], live[kb]];
      if (B.covers) out[i].push(j);
      if (A.covers) out[j].push(i);
    }
  }
  return out;
}

/**
 * Her ağ için üçgen başına 1 (gizli) / 0 (görünür). Yalnızca verilen ağlar birbirini örter; ağların hepsi dışa aktarılan
 * katılar olmalıdır (kaplamalar ve referanslar verilmez). Açık (kapalı olmayan) ya da `occluder: false` ağ örtmez ama kendi
 * üçgenleri atılabilir.
 */
export function hiddenTriangles(meshes: CullMesh[]): Uint8Array[] {
  const bodies = meshes.map(prepare);
  const out = meshes.map((m) => new Uint8Array(m.tris.length / 3));
  const cands = overlapping(bodies);
  const T = new Float64Array(9); // T′ köşeleri
  const src = new Float64Array(9); // T köşeleri
  for (let i = 0; i < bodies.length; i++) {
    if (!cands[i].length) continue;
    const { pos, tris } = bodies[i].mesh;
    const hidden = out[i];
    for (let t = 0; t < tris.length / 3; t++) {
      for (let k = 0; k < 3; k++) for (let m = 0; m < 3; m++) src[3 * k + m] = pos[tris[3 * t + k] * 3 + m];
      const ax = src[0];
      const ay = src[1];
      const az = src[2];
      const bx = src[3];
      const by = src[4];
      const bz = src[5];
      const cx = src[6];
      const cy = src[7];
      const cz = src[8];
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const n2 = Math.hypot(nx, ny, nz); // 2 × alan
      // İç teğet çember: merkez = karşı kenar boylarıyla ağırlıklı köşeler, yarıçap = 2·alan / çevre.
      const la = Math.hypot(cx - bx, cy - by, cz - bz);
      const lb = Math.hypot(ax - cx, ay - cy, az - cz);
      const lc = Math.hypot(bx - ax, by - ay, bz - az);
      const per = la + lb + lc;
      if (!(n2 > 1e-12 * per * per)) continue; // alanı sıfır üçgen: kalır
      nx /= n2;
      ny /= n2;
      nz /= n2;
      const r = n2 / per;
      const ix = (la * ax + lb * bx + lc * cx) / per;
      const iy = (la * ay + lb * by + lc * cy) / per;
      const iz = (la * az + lb * bz + lc * cz) / per;
      for (const j of cands[i]) {
        const B = bodies[j];
        const eps = epsOf(Math.max(bodies[i].scale, B.scale));
        const k = 1 - Math.min(eps, r / 2) / r; // kenarlardan min(ε, r/2) içeri
        let inBox = true;
        for (let q = 0; q < 9; q += 3) {
          T[q] = ix + (src[q] - ix) * k + eps * nx;
          T[q + 1] = iy + (src[q + 1] - iy) * k + eps * ny;
          T[q + 2] = iz + (src[q + 2] - iz) * k + eps * nz;
          for (let m = 0; m < 3; m++) if (T[q + m] <= B.min[m] || T[q + m] >= B.max[m]) inBox = false;
        }
        if (!inBox) continue;
        B.bvh ??= new TriBvh(B.mesh);
        // (a) bir noktası içeride, (b) hiçbir üçgen T′'yü kesmiyor → T′ tamamen içeride.
        const gx = (T[0] + T[3] + T[6]) / 3;
        const gy = (T[1] + T[4] + T[7]) / 3;
        const gz = (T[2] + T[5] + T[8]) / 3;
        if (!B.bvh.inside(gx, gy, gz)) continue;
        if (B.bvh.touches(T)) continue;
        hidden[t] = 1;
        break;
      }
      if (!hidden[t] && contactCovered(bodies, i, cands[i], src, nx, ny, nz, per, n2 / 2)) hidden[t] = 1;
    }
  }
  return out;
}

/** Değme kuralında kalan alanın sınırı: T çevresinin karesinin bu katı (çıkarmanın float gürültüsü; gerçek boşluk değil). */
const COVER_TOL = 1e-12;
/** …ve T alanının bu katı (iğne üçgende alanın tamamı gürültü sayılmasın). */
const COVER_TOL_AREA = 1e-6;
/** Değme kuralında çıkarma parçası sınırı: aşılırsa T görünür sayılır (sayısal belirsizlik görünür yönünde). */
const MAX_PIECES = 64;
/** Değme kuralında örtücü üçgen T ile (ters ya da aynı yönde) paralel: normaller arası açının |kosinüsü| en az bu kadar. */
const PARALLEL = 0.999;

/**
 * Değme kuralı (bkz. dosya başı): örtücülerin T düzleminde duran ve içi T'nin önünde kalan üçgenleri T'yi tamamen kaplıyor mu. `src`
 * T'nin köşeleri, (nx, ny, nz) birim normali, `per` çevresi, `area` alanı. Önce adaylar toplanır (köşeleri T düzlemine ε'dan yakın,
 * normali T'ye paralel); örtücünün içi yüz başına ışın paritesiyle bulunur (adayın ağırlık merkezinden T'nin önüne 2ε: içeride mi) —
 * ağın toplam yönüne güvenilmez (yönü karışık kabuklu ağ). Sonra T kendi düzleminde 2B taban (e1 = AB yönü, e2 = n × e1) ile çokgen
 * olarak tutulur ve her örtücü üçgen çıkarılır; kalan parça kalmazsa gizlidir.
 */
function contactCovered(
  bodies: Body[],
  i: number,
  cands: number[],
  src: Float64Array,
  nx: number,
  ny: number,
  nz: number,
  per: number,
  area: number,
): boolean {
  const [ax, ay, az] = [src[0], src[1], src[2]];
  const tmin = [Math.min(src[0], src[3], src[6]), Math.min(src[1], src[4], src[7]), Math.min(src[2], src[5], src[8])];
  const tmax = [Math.max(src[0], src[3], src[6]), Math.max(src[1], src[4], src[7]), Math.max(src[2], src[5], src[8])];
  // Adaylar: (örtücü, ε, aday köşeleri). Sorgu sırasında BVH'nin yığını kullanıldığından parite sonra denetlenir.
  const found: { B: Body; eps: number; tris: number[] }[] = [];
  for (const j of cands) {
    const B = bodies[j];
    const eps = epsOf(Math.max(bodies[i].scale, B.scale));
    // Kutu kesişimi (içerme değil): birden çok örtücü T'yi birlikte kaplayabilir.
    if (tmax[0] < B.min[0] - eps || tmin[0] > B.max[0] + eps || tmax[1] < B.min[1] - eps || tmin[1] > B.max[1] + eps) continue;
    if (tmax[2] < B.min[2] - eps || tmin[2] > B.max[2] + eps) continue;
    B.bvh ??= new TriBvh(B.mesh);
    let tris: number[] | undefined;
    B.bvh.query([tmin[0] - eps, tmin[1] - eps, tmin[2] - eps], [tmax[0] + eps, tmax[1] + eps, tmax[2] + eps], (Q, o) => {
      for (let k = 0; k < 9; k += 3) {
        if (Math.abs((Q[o + k] - ax) * nx + (Q[o + k + 1] - ay) * ny + (Q[o + k + 2] - az) * nz) > eps) return false;
      }
      const [e1x, e1y, e1z] = [Q[o + 3] - Q[o], Q[o + 4] - Q[o + 1], Q[o + 5] - Q[o + 2]];
      const [e2x, e2y, e2z] = [Q[o + 6] - Q[o], Q[o + 7] - Q[o + 1], Q[o + 8] - Q[o + 2]];
      const [qx, qy, qz] = [e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x];
      const ql = Math.hypot(qx, qy, qz);
      if (!(ql > 0) || Math.abs(qx * nx + qy * ny + qz * nz) < PARALLEL * ql) return false;
      (tris ??= []).push(...Array.from({ length: 9 }, (_, k) => Q[o + k]));
      return false;
    });
    if (tris) found.push({ B, eps, tris });
  }
  if (!found.length) return false;

  const lc = Math.hypot(src[3] - ax, src[4] - ay, src[5] - az);
  const [ux, uy, uz] = [(src[3] - ax) / lc, (src[4] - ay) / lc, (src[5] - az) / lc];
  const [vx, vy, vz] = [ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux];
  const pu = (x: number, y: number, z: number) => (x - ax) * ux + (y - ay) * uy + (z - az) * uz;
  const pv = (x: number, y: number, z: number) => (x - ax) * vx + (y - ay) * vy + (z - az) * vz;
  const tiny = Math.min(COVER_TOL * per * per, COVER_TOL_AREA * area);
  // T 2B'de saat yönünün tersine (normal = AB × AC, e2 = n × e1).
  let pieces: number[][] | null = [[0, 0, lc, 0, pu(src[6], src[7], src[8]), pv(src[6], src[7], src[8])]];
  for (const { B, eps, tris } of found) {
    for (let o = 0; o < tris.length; o += 9) {
      // Örtücünün içi bu yüzde T'nin önünde mi (ışın paritesi; belirsizse dışarıda → örtmez).
      const g = [0, 1, 2].map((c) => (tris[o + c] + tris[o + 3 + c] + tris[o + 6 + c]) / 3 + 2 * eps * [nx, ny, nz][c]);
      if (!B.bvh!.inside(g[0], g[1], g[2])) continue;
      const q2 = [0, 3, 6].flatMap((k) => [pu(tris[o + k], tris[o + k + 1], tris[o + k + 2]), pv(tris[o + k], tris[o + k + 1], tris[o + k + 2])]);
      if (polyArea(q2) < 0) q2.splice(0, 6, q2[0], q2[1], q2[4], q2[5], q2[2], q2[3]);
      pieces = subtractTriangle(pieces, q2, tiny);
      if (!pieces || !pieces.length) return pieces !== null;
    }
  }
  return false;
}

/** Düz dizili 2B çokgenin işaretli alanı (saat yönünün tersi pozitif). */
function polyArea(p: number[]): number {
  let s = 0;
  for (let k = 0; k < p.length; k += 2) {
    const n = (k + 2) % p.length;
    s += p[k] * p[n + 1] - p[n] * p[k + 1];
  }
  return s / 2;
}

/**
 * Dışbükey çokgen parçalarından saat yönünün tersindeki `q` üçgenini çıkarır: her parça üçgenin kenar doğrularıyla bölünür, dışta
 * kalanlar tutulur, içteki (kesişim) atılır. Alanı `tiny`'den küçük parçalar atılır (float gürültüsü); parça sayısı MAX_PIECES'ı
 * aşarsa null (belirsiz).
 */
function subtractTriangle(pieces: number[][], q: number[], tiny: number): number[][] | null {
  const out: number[][] = [];
  for (const P of pieces) {
    let cur: number[] | null = P;
    for (let e = 0; e < 3 && cur; e++) {
      const [px, py, qx, qy] = [q[2 * e], q[2 * e + 1], q[(2 * e + 2) % 6], q[(2 * e + 3) % 6]];
      const inside: number[] = [];
      const outside: number[] = [];
      const side = (k: number) => (qx - px) * (cur![k + 1] - py) - (qy - py) * (cur![k] - px);
      for (let k = 0; k < cur.length; k += 2) {
        const n = (k + 2) % cur.length;
        const [dc, dn] = [side(k), side(n)];
        if (dc >= 0) inside.push(cur[k], cur[k + 1]);
        if (dc <= 0) outside.push(cur[k], cur[k + 1]);
        if ((dc > 0 && dn < 0) || (dc < 0 && dn > 0)) {
          const s = dc / (dc - dn);
          const x = cur[k] + s * (cur[n] - cur[k]);
          const y = cur[k + 1] + s * (cur[n + 1] - cur[k + 1]);
          inside.push(x, y);
          outside.push(x, y);
        }
      }
      if (outside.length >= 6 && polyArea(outside) > tiny) out.push(outside);
      cur = inside.length >= 6 && polyArea(inside) > tiny ? inside : null;
    }
    if (out.length > MAX_PIECES) return null;
  }
  return out;
}

/** Ayıklama + T-kavşağı onarımı sonucu (ağ başına). */
export interface CullOutcome {
  /**
   * Kalan üçgenler (indisler). Sıra korunur; bölünen üçgenin yerinde parçaları durur. `pos.length / 3` ve üstü indisler
   * `added` köşeleridir.
   */
  tris: number[][];
  /** Onarımın eklediği köşeler (dünya mm, x y z …): başka bir parçanın köşesiyle aynı değerler. */
  added: number[][];
  /** Atılan üçgen sayısı. */
  culled: number[];
  /** Onarımın eklediği üçgen sayısı (her bölme bir üçgen ekler). */
  split: number[];
  /** Son atılma maskesi (girdi üçgeni başına 1 = atıldı; net kayıp kuralıyla geri konanlar 0). */
  hidden: Uint8Array[];
}

/**
 * Gizli üçgenleri atar ve atılanların arkasında kalan T-kavşaklarını onarır (bkz. dosya başı). Hiçbir üçgen atılmazsa onarım
 * yapılmaz: kalan üçgenler girdinin aynısıdır. GLB `cullHidden` ve `check --cull-hidden` bunu kullanır (sayılar tutarlı).
 *
 * Net kayıp kuralı: ayıklama üçgen sayısını artırmaz. Her parçanın atılan üçgenlerinin köşelerinden doğan bölmeler (başka parçalarda
 * da olabilir) o parçanın maliyetidir; maliyet atılanı aşan ya da ona eşit olan parçanın atılan üçgenleri geri konur (geri konan yüz
 * çatlağı zaten kapatır) ve onarım kalan kümeyle baştan hesaplanır. Başka bir parçanın aynı noktadaki adayı bölme gerektiriyorsa o
 * bölme kalır (su geçirmezlik bozulmaz). Geri konan yüzler başka adayların bölmelerini artırabileceğinden kural kararlı olana dek
 * tekrarlanır; her geçiş en az bir parçayı geri koyar. Sonuçta her bölme atılan bir köşeye bağlı ve parça başına bölme < atılan
 * olduğundan toplam üçgen sayısı, bir şey atılmışsa kesin azalır.
 */
export function cullAndRepair(meshes: CullMesh[]): CullOutcome {
  const hidden = hiddenTriangles(meshes);
  // Tolerans: ayıklamanın ε'u, sahnenin en büyük ölçeğiyle (kutu boyu ve koordinat büyüklüğü).
  let scale = 0;
  for (const m of meshes) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < m.tris.length; i++) {
      for (let c = 0; c < 3; c++) {
        const x = m.pos[m.tris[i] * 3 + c];
        if (x < lo[c]) lo[c] = x;
        if (x > hi[c]) hi[c] = x;
      }
    }
    if (m.tris.length) scale = Math.max(scale, ...[0, 1, 2].map((c) => hi[c] - lo[c]), ...lo.map(Math.abs), ...hi.map(Math.abs));
  }
  const tol = epsOf(scale);
  for (;;) {
    const r = repairPass(meshes, hidden, tol);
    const restore = r.culled.flatMap((n, k) => (n > 0 && r.cost[k] >= n ? [k] : []));
    if (!restore.length) return { tris: r.tris, added: r.added, culled: r.culled, split: r.split, hidden };
    for (const k of restore) hidden[k].fill(0);
  }
}

/**
 * Tek onarım geçişi (`hidden` = atılacak üçgenler): kalan üçgenler, eklenen köşeler, bölme sayıları ve parça başına maliyet
 * (o parçanın atılan köşelerinden doğan bölmeler; köşe birden çok parçanın atılan üçgenindeyse her birine sayılır).
 */
function repairPass(meshes: CullMesh[], hidden: Uint8Array[], tol: number): Omit<CullOutcome, 'hidden'> & { cost: number[] } {
  const kept: number[][] = [];
  const culled = hidden.map((h, k) => {
    const t: number[] = [];
    let n = 0;
    const src = meshes[k].tris;
    for (let i = 0; i < h.length; i++) {
      if (h[i]) n++;
      else t.push(src[3 * i], src[3 * i + 1], src[3 * i + 2]);
    }
    kept.push(t);
    return n;
  });
  const added = meshes.map((): number[] => []);
  const split = meshes.map(() => 0);
  const cost = meshes.map(() => 0);
  if (!culled.some((n) => n > 0)) return { tris: kept, added, culled, split, cost };

  // Aday T noktaları: atılan üçgenlerin köşeleri (benzersiz, dünya mm) ve sahipleri (köşesi atılan parçalar).
  const cand: number[] = [];
  const owners: Set<number>[] = [];
  const candIndex = new Map<string, number>();
  meshes.forEach((m, k) => {
    for (let t = 0; t < hidden[k].length; t++) {
      if (!hidden[k][t]) continue;
      for (let j = 0; j < 3; j++) {
        const v = m.tris[3 * t + j] * 3;
        const key = `${m.pos[v]},${m.pos[v + 1]},${m.pos[v + 2]}`;
        let p = candIndex.get(key);
        if (p === undefined) {
          p = owners.length;
          candIndex.set(key, p);
          owners.push(new Set());
          cand.push(m.pos[v], m.pos[v + 1], m.pos[v + 2]);
        }
        owners[p].add(k);
      }
    }
  });
  const tol2 = tol * tol;
  // Adayın kalan üçgenlerdeki komşuları (adayla aynı konumdaki köşeden çıkan kenarların öbür uçları): çatlak yalnızca adayın kalan
  // bir kenarı bölünecek kenarla aynı doğru üzerindeyse oluşur (iki parçanın yüzeyleri o doğru boyunca birleşir). Kenarın içine düşen
  // ama ona dik/eğik kenarları olan köşe (ör. küçük kutunun köşesi büyük yüzün köşegeninde) çatlak yapmaz: o yüz su geçirmezdir.
  const nbrs = new Map<number, number[]>();
  meshes.forEach((m, k) => {
    const t = kept[k];
    for (let i = 0; i < t.length; i++) {
      const v = t[i] * 3;
      const p = candIndex.get(`${m.pos[v]},${m.pos[v + 1]},${m.pos[v + 2]}`);
      if (p === undefined) continue;
      const list = nbrs.get(p) ?? nbrs.set(p, []).get(p)!;
      const tri = i - (i % 3);
      for (const j of [tri + ((i - tri + 1) % 3), tri + ((i - tri + 2) % 3)]) list.push(m.pos[t[j] * 3], m.pos[t[j] * 3 + 1], m.pos[t[j] * 3 + 2]);
    }
  });
  /** Adayın kalan kenarlarından biri a–d doğrusu üzerinde mi (öbür ucu doğruya tol'den yakın). */
  const collinear = (p: number, ax: number, ay: number, az: number, dx: number, dy: number, dz: number, L2: number) => {
    const list = nbrs.get(p);
    if (!list) return false;
    for (let i = 0; i < list.length; i += 3) {
      const [qx, qy, qz] = [list[i] - ax, list[i + 1] - ay, list[i + 2] - az];
      const s = (qx * dx + qy * dy + qz * dz) / L2;
      if ((qx - s * dx) ** 2 + (qy - s * dy) ** 2 + (qz - s * dz) ** 2 <= tol2) return true;
    }
    return false;
  };
  // Adaylar x'e göre sıralı (üçgen kutusundaki adaylar ikili aramayla).
  const nc = cand.length / 3;
  const order = Array.from({ length: nc }, (_, i) => i).sort((a, b) => cand[3 * a] - cand[3 * b]);
  const xs = order.map((i) => cand[3 * i]);
  const lowerBound = (x: number) => {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  meshes.forEach((m, k) => {
    const nv = m.pos.length / 3;
    const extra = added[k];
    const coord = (v: number, c: number) => (v < nv ? m.pos[3 * v + c] : extra[3 * (v - nv) + c]);
    /**
     * p (aday) u–v kenarında çatlak yapan T noktası mı: kenarın iç noktası (kenara tol'den yakın, uçlara tol'den uzak, izdüşümü
     * kenarın içinde) ve adayın kalan bir kenarı aynı doğru üzerinde.
     */
    const interior = (u: number, v: number, p: number) => {
      const [ax, ay, az] = [coord(u, 0), coord(u, 1), coord(u, 2)];
      const [dx, dy, dz] = [coord(v, 0) - ax, coord(v, 1) - ay, coord(v, 2) - az];
      const [qx, qy, qz] = [cand[3 * p] - ax, cand[3 * p + 1] - ay, cand[3 * p + 2] - az];
      const L2 = dx * dx + dy * dy + dz * dz;
      const s = (qx * dx + qy * dy + qz * dz) / L2;
      if (!(s > 0 && s < 1)) return false;
      if (qx * qx + qy * qy + qz * qz <= tol2) return false;
      if ((qx - dx) ** 2 + (qy - dy) ** 2 + (qz - dz) ** 2 <= tol2) return false;
      if ((qx - s * dx) ** 2 + (qy - s * dy) ** 2 + (qz - s * dz) ** 2 > tol2) return false;
      return collinear(p, ax, ay, az, dx, dy, dz, L2);
    };
    const newIndex = new Map<number, number>();
    const vertexOf = (p: number) => {
      let v = newIndex.get(p);
      if (v === undefined) {
        v = nv + extra.length / 3;
        extra.push(cand[3 * p], cand[3 * p + 1], cand[3 * p + 2]);
        newIndex.set(p, v);
      }
      return v;
    };
    const src = kept[k];
    const out: number[] = [];
    for (let t = 0; t < src.length; t += 3) {
      const tri = [src[t], src[t + 1], src[t + 2]];
      const lo = [0, 1, 2].map((c) => Math.min(...tri.map((v) => coord(v, c))) - tol);
      const hi = [0, 1, 2].map((c) => Math.max(...tri.map((v) => coord(v, c))) + tol);
      const hits: number[] = [];
      for (let r = lowerBound(lo[0]); r < xs.length && xs[r] <= hi[0]; r++) {
        const p = order[r];
        if (cand[3 * p + 1] < lo[1] || cand[3 * p + 1] > hi[1] || cand[3 * p + 2] < lo[2] || cand[3 * p + 2] > hi[2]) continue;
        if (interior(tri[0], tri[1], p) || interior(tri[1], tri[2], p) || interior(tri[2], tri[0], p)) hits.push(p);
      }
      if (!hits.length) {
        out.push(tri[0], tri[1], tri[2]);
        continue;
      }
      // Sırayla böl: her nokta, kenarında bulunduğu alt üçgeni (u, v, w) → (u, P, w) + (P, v, w) yapar (sarım korunur).
      let sub: number[][] = [tri];
      for (const p of hits) {
        const next: number[][] = [];
        let done = false;
        for (const s of sub) {
          const e = done ? -1 : [0, 1, 2].find((i) => interior(s[i], s[(i + 1) % 3], p)) ?? -1;
          if (e < 0) {
            next.push(s);
            continue;
          }
          const [u, v, w] = [s[e], s[(e + 1) % 3], s[(e + 2) % 3]];
          const P = vertexOf(p);
          next.push([u, P, w], [P, v, w]);
          done = true;
          for (const o of owners[p]) cost[o]++;
        }
        sub = next;
      }
      split[k] += sub.length - 1;
      for (const s of sub) out.push(s[0], s[1], s[2]);
    }
    kept[k] = out;
  });
  return { tris: kept, added, culled, split, cost };
}

// ---------------------------------------------------------------------------
// Üçgen BVH: ışın paritesi ve üçgen–üçgen kesişim sorgusu

class TriBvh {
  /** Üçgen köşeleri (9 değer; düğüm sırasında). */
  private readonly tri: Float64Array;
  /** Düğüm kutusu (6 değer: min xyz, max xyz). */
  private readonly box: number[] = [];
  /** İç düğümde çocuklar, yaprakta −1. */
  private readonly left: number[] = [];
  private readonly right: number[] = [];
  private readonly start: number[] = [];
  private readonly count: number[] = [];
  /** Gezinme yığını (ortanca bölmede derinlik ≤ log2(n) + 1; her adım en çok iki düğüm ekler). */
  private readonly stack = new Int32Array(256);

  constructor(mesh: CullMesh) {
    const { pos, tris } = mesh;
    const n = tris.length / 3;
    const cen = new Float64Array(3 * n);
    const tb = new Float64Array(6 * n);
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < 3; k++) {
        const x = pos[tris[3 * t] * 3 + k];
        const y = pos[tris[3 * t + 1] * 3 + k];
        const z = pos[tris[3 * t + 2] * 3 + k];
        cen[3 * t + k] = (x + y + z) / 3;
        tb[6 * t + k] = Math.min(x, y, z);
        tb[6 * t + 3 + k] = Math.max(x, y, z);
      }
    }
    const order = new Int32Array(n).map((_, i) => i);
    const stack: [number, number, number][] = [[this.node(), 0, n]];
    while (stack.length) {
      const [id, s, e] = stack.pop()!;
      const bx = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      const cb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      for (let r = s; r < e; r++) {
        const t = order[r];
        for (let k = 0; k < 3; k++) {
          bx[k] = Math.min(bx[k], tb[6 * t + k]);
          bx[3 + k] = Math.max(bx[3 + k], tb[6 * t + 3 + k]);
          cb[k] = Math.min(cb[k], cen[3 * t + k]);
          cb[3 + k] = Math.max(cb[3 + k], cen[3 * t + k]);
        }
      }
      for (let k = 0; k < 6; k++) this.box[6 * id + k] = bx[k];
      if (e - s <= LEAF) {
        this.start[id] = s;
        this.count[id] = e - s;
        continue;
      }
      const ext = [cb[3] - cb[0], cb[4] - cb[1], cb[5] - cb[2]];
      const ax = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
      order.subarray(s, e).sort((p, q) => cen[3 * p + ax] - cen[3 * q + ax]);
      const mid = (s + e) >> 1;
      const [l, r] = [this.node(), this.node()];
      this.left[id] = l;
      this.right[id] = r;
      stack.push([l, s, mid], [r, mid, e]);
    }
    this.tri = new Float64Array(9 * n);
    for (let r = 0; r < n; r++) {
      const t = order[r];
      for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) this.tri[9 * r + 3 * k + c] = pos[tris[3 * t + k] * 3 + c];
    }
  }

  private node(): number {
    const id = this.left.length;
    this.left.push(-1);
    this.right.push(-1);
    this.start.push(0);
    this.count.push(0);
    return id;
  }

  /** Nokta katının içinde mi (ışın paritesi; tüm yönler kenar sıyırırsa dışarıda sayılır). */
  inside(x: number, y: number, z: number): boolean {
    for (const d of DIRS) {
      const c = this.crossings(x, y, z, d);
      if (c >= 0) return (c & 1) === 1;
    }
    return false;
  }

  /** Kutusu [qmin, qmax] ile kesişen yapraklardaki üçgenleri (köşeler `tri[o…o+8]`) ziyaret eder; `visit` true dönerse durur. */
  query(qmin: number[], qmax: number[], visit: (tri: Float64Array, o: number) => boolean): void {
    const B = this.box;
    const stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const id = stack[--sp];
      const o = 6 * id;
      if (B[o] > qmax[0] || B[o + 1] > qmax[1] || B[o + 2] > qmax[2] || B[o + 3] < qmin[0] || B[o + 4] < qmin[1] || B[o + 5] < qmin[2]) continue;
      if (this.left[id] >= 0) {
        stack[sp++] = this.left[id];
        stack[sp++] = this.right[id];
        continue;
      }
      const end = this.start[id] + this.count[id];
      for (let r = this.start[id]; r < end; r++) if (visit(this.tri, 9 * r)) return;
    }
  }

  /** Yüzeyin bir üçgeni `q` üçgenini (9 değer) kesiyor ya da ona değiyor mu. */
  touches(q: Float64Array): boolean {
    const qmin = [Math.min(q[0], q[3], q[6]), Math.min(q[1], q[4], q[7]), Math.min(q[2], q[5], q[8])];
    const qmax = [Math.max(q[0], q[3], q[6]), Math.max(q[1], q[4], q[7]), Math.max(q[2], q[5], q[8])];
    const B = this.box;
    const stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const id = stack[--sp];
      const o = 6 * id;
      if (B[o] > qmax[0] || B[o + 1] > qmax[1] || B[o + 2] > qmax[2] || B[o + 3] < qmin[0] || B[o + 4] < qmin[1] || B[o + 5] < qmin[2]) continue;
      if (this.left[id] >= 0) {
        stack[sp++] = this.left[id];
        stack[sp++] = this.right[id];
        continue;
      }
      const end = this.start[id] + this.count[id];
      for (let r = this.start[id]; r < end; r++) if (!separated(this.tri, 9 * r, q)) return true;
    }
    return false;
  }

  /** (x, y, z)'den `d` yönündeki ışının yüzeyi kaç kez kestiği; bir kesişim kenar/köşe sıyırıyorsa −1. */
  private crossings(x: number, y: number, z: number, d: [number, number, number]): number {
    const dx = d[0];
    const dy = d[1];
    const dz = d[2];
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const B = this.box;
    const T = this.tri;
    const stack = this.stack;
    let hits = 0;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const id = stack[--sp];
      const o = 6 * id;
      // Kutu–ışın (t ≥ 0; yönlerin bileşenleri sıfır değil)
      let a = (B[o] - x) * ix;
      let b = (B[o + 3] - x) * ix;
      let t0 = Math.max(0, Math.min(a, b));
      let t1 = Math.max(a, b);
      a = (B[o + 1] - y) * iy;
      b = (B[o + 4] - y) * iy;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
      a = (B[o + 2] - z) * iz;
      b = (B[o + 5] - z) * iz;
      t0 = Math.max(t0, Math.min(a, b));
      t1 = Math.min(t1, Math.max(a, b));
      if (t0 > t1) continue;
      if (this.left[id] >= 0) {
        stack[sp++] = this.left[id];
        stack[sp++] = this.right[id];
        continue;
      }
      const end = this.start[id] + this.count[id];
      for (let r = this.start[id]; r < end; r++) {
        const q = 9 * r;
        // Möller–Trumbore
        const e1x = T[q + 3] - T[q];
        const e1y = T[q + 4] - T[q + 1];
        const e1z = T[q + 5] - T[q + 2];
        const e2x = T[q + 6] - T[q];
        const e2y = T[q + 7] - T[q + 1];
        const e2z = T[q + 8] - T[q + 2];
        const hx = dy * e2z - dz * e2y;
        const hy = dz * e2x - dx * e2z;
        const hz = dx * e2y - dy * e2x;
        const det = e1x * hx + e1y * hy + e1z * hz;
        const scale = Math.sqrt((e1x * e1x + e1y * e1y + e1z * e1z) * (e2x * e2x + e2y * e2y + e2z * e2z));
        if (Math.abs(det) <= 1e-14 * scale) continue; // ışın üçgen düzlemine paralel
        const f = 1 / det;
        const sx = x - T[q];
        const sy = y - T[q + 1];
        const sz = z - T[q + 2];
        const u = f * (sx * hx + sy * hy + sz * hz);
        if (u < -GRAZE || u > 1 + GRAZE) continue;
        const kx = sy * e1z - sz * e1y;
        const ky = sz * e1x - sx * e1z;
        const kz = sx * e1y - sy * e1x;
        const v = f * (dx * kx + dy * ky + dz * kz);
        if (v < -GRAZE || u + v > 1 + GRAZE) continue;
        const t = f * (e2x * kx + e2y * ky + e2z * kz);
        if (t < 0) continue;
        // Kenar/köşe sıyırma ya da noktanın yüzeyin üstünde olması: belirsiz, başka yön
        if (t === 0 || u <= GRAZE || v <= GRAZE || u + v >= 1 - GRAZE) return -1;
        hits++;
      }
    }
    return hits;
  }
}

/**
 * İki üçgen (P[o…o+8], Q[0…8]) ayrık mı: ayırıcı eksen testi. Eksenler iki normal, dokuz kenar–kenar çarpımı ve düzlem içi altı
 * eksen (normal × kenar; eş düzlemli üçgenler için). Herhangi bir eksende izdüşümler örtüşmüyorsa ayrıktır; değme ayrık sayılmaz.
 * Sıfıra yakın eksenler atlanır: yalnızca "ayrık" bulmayı zorlaştırır (üçgen görünür kalır).
 */
function separated(P: Float64Array, o: number, Q: Float64Array): boolean {
  // Kenarlar (EP: P'ninkiler, EQ: Q'nunkiler; 3 × 3) ve normaller; ayırma yerine sabit tamponlar (sıcak döngü).
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    for (let c = 0; c < 3; c++) {
      EP[3 * i + c] = P[o + 3 * j + c] - P[o + 3 * i + c];
      EQ[3 * i + c] = Q[3 * j + c] - Q[3 * i + c];
    }
  }
  let scale = 0;
  for (let i = 0; i < 3; i++) {
    scale = Math.max(scale, EP[3 * i] ** 2 + EP[3 * i + 1] ** 2 + EP[3 * i + 2] ** 2, EQ[3 * i] ** 2 + EQ[3 * i + 1] ** 2 + EQ[3 * i + 2] ** 2);
  }
  const min2 = 1e-24 * scale * scale;
  const sepOn = (ax: number, ay: number, az: number): boolean => {
    if (!(ax * ax + ay * ay + az * az > min2)) return false;
    let pmin = Infinity;
    let pmax = -Infinity;
    let qmin = Infinity;
    let qmax = -Infinity;
    for (let k = 0; k < 9; k += 3) {
      const vp = P[o + k] * ax + P[o + k + 1] * ay + P[o + k + 2] * az;
      const vq = Q[k] * ax + Q[k + 1] * ay + Q[k + 2] * az;
      if (vp < pmin) pmin = vp;
      if (vp > pmax) pmax = vp;
      if (vq < qmin) qmin = vq;
      if (vq > qmax) qmax = vq;
    }
    return pmax < qmin || qmax < pmin;
  };
  /** a × b ekseninde ayrık mı (a, b: tampon + kaydırma). */
  const sepCross = (A: Float64Array, i: number, B: Float64Array, j: number) =>
    sepOn(A[i + 1] * B[j + 2] - A[i + 2] * B[j + 1], A[i + 2] * B[j] - A[i] * B[j + 2], A[i] * B[j + 1] - A[i + 1] * B[j]);
  // Normaller: N[0..2] = P'nin, N[3..5] = Q'nun
  N[0] = EP[1] * EP[5] - EP[2] * EP[4];
  N[1] = EP[2] * EP[3] - EP[0] * EP[5];
  N[2] = EP[0] * EP[4] - EP[1] * EP[3];
  N[3] = EQ[1] * EQ[5] - EQ[2] * EQ[4];
  N[4] = EQ[2] * EQ[3] - EQ[0] * EQ[5];
  N[5] = EQ[0] * EQ[4] - EQ[1] * EQ[3];
  if (sepOn(N[0], N[1], N[2]) || sepOn(N[3], N[4], N[5])) return true;
  for (let i = 0; i < 9; i += 3) for (let j = 0; j < 9; j += 3) if (sepCross(EP, i, EQ, j)) return true;
  for (let i = 0; i < 9; i += 3) if (sepCross(N, 0, EP, i) || sepCross(N, 3, EQ, i)) return true;
  return false;
}
const EP = new Float64Array(9);
const EQ = new Float64Array(9);
const N = new Float64Array(6);
