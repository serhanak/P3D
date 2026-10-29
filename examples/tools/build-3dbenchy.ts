// 3DBenchy örneğinin üreteci (examples/3dbenchy.p3d.json). Orijinal CC0 STL'den endaze tablosu ve kabin/çatı/kasa
// ölçüleri alınır; model yalnızca uygulamanın kendi şekilleri ve işlemleriyle kurulur (hull, extrude, revolve, delikler,
// place_on_surface). Ayrıntılı açıklama: examples/README.md.
//
// Referansı indirin (repoya koymayın, 11 MB):
//   curl -L -o /tmp/3DBenchy.stl https://raw.githubusercontent.com/CreativeTools/3DBenchy/master/Single-part/3DBenchy.stl
// Çalıştırın:
//   npx tsx examples/tools/build-3dbenchy.ts /tmp/3DBenchy.stl examples/3dbenchy.p3d.json [ops.json]
// Üçüncü argüman verilirse işlem listesi de yazılır (köprüyle sahneye göndermek için: npm run -s p3d -- ops < ops.json).
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { checkProject } from '../../src/check.ts';
import { initCsg, manifoldVolume, sliceMany } from '../../src/csg.ts';
import { applyOps } from '../../src/engine.ts';
import { mergedMesh, projectToJson } from '../../src/io.ts';
import { parseMeshFile } from '../../src/meshio.ts';
import { exportableParts } from '../../src/model.ts';
import { newProject } from '../../src/types.ts';

type P = [number, number];
const r2 = (n: number) => Math.round(n * 100) / 100;

await initCsg();
const buf = readFileSync(process.argv[2]);
const soup = parseMeshFile('a.stl', buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const ref = new THREE.BufferGeometry();
ref.setAttribute('position', new THREE.BufferAttribute(soup, 3));

/** Çokgen kenarlarının u = c doğrusuyla kesişimlerindeki v değerleri (sıralı). */
function cross(polys: P[][], c: number, swap = false): number[] {
  const out: number[] = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      let [a, b] = [poly[i], poly[(i + 1) % poly.length]];
      if (swap) [a, b] = [[a[1], a[0]], [b[1], b[0]]];
      if ((a[0] - c) * (b[0] - c) < 0) out.push(a[1] + ((c - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
    }
  }
  return out.sort((p, q) => p - q);
}

// ---------------------------------------------------------------- tekne: endaze tablosu → örtük yüzey (loft yok)
// Her istasyonda dış yarı genişlik, omurga→küpeşte arasındaki normalleştirilmiş yükseklikte (s = 0…1) NS noktada
// ölçülür. Tekne içi: min(yarı genişlik − |y|, z − omurga, küpeşte − z, x − ayna) > 0 ve güverte kuyusunun dışı.
const NS = 61;
const HAWSE = { x0: 22.6, x1: 27.9, z0: 17.5, z1: 23.6 }; // loça flanşı bandı: ölçülmez, ara değerlenir
const XS: number[] = [];
for (let x = -29.15; x <= 30.31; x += 0.5) XS.push(r2(x));
const slices = sliceMany(ref, 'x', XS);

interface St { x: number; keel: number; zs: number; hb: number[]; well: boolean; zd: number; yd: number; yi: number }
const stations: St[] = [];
XS.forEach((x, k) => {
  const polys = slices[k];
  const pts = polys.flat();
  if (!pts.length) return;
  const maxY = Math.max(...pts.map((p) => Math.abs(p[0])));
  const zs = Math.max(...pts.filter((p) => Math.abs(p[0]) > maxY - 2.5).map((p) => p[1]));
  const keel = Math.min(...pts.filter((p) => Math.abs(p[0]) < maxY * 0.6).map((p) => p[1]));
  const hits = (z: number) => cross(polys, z, true).filter((y) => y > 0).sort((a, b) => b - a);
  const zOf = (j: number) => Math.min(zs - 0.03, Math.max(keel + 0.03, keel + ((zs - keel) * j) / (NS - 1)));
  let hb = Array.from({ length: NS }, (_, j) => hits(zOf(j))[0] ?? 0);
  if (x > HAWSE.x0 && x < HAWSE.x1) {
    const inBand = (j: number) => zOf(j) >= HAWSE.z0 && zOf(j) <= HAWSE.z1;
    const lo = [...Array(NS).keys()].findIndex(inBand);
    if (lo > 0) {
      let hi = lo;
      while (hi < NS - 1 && inBand(hi)) hi++;
      for (let j = lo; j < hi; j++) hb[j] = hb[lo - 1] + ((hb[hi] - hb[lo - 1]) * (j - lo + 1)) / (hi - lo + 1);
    }
  }
  hb = hb.map((y, i) => Math.max(y, Math.min(Math.max(...hb.slice(0, i + 1)), Math.max(...hb.slice(i)))));
  const top = hits(zs - 0.2);
  const yi = top.length > 1 ? top[1] : 0;
  const v = cross(polys, Math.max(0.3, yi - 2.4));
  const zd = v.length >= 2 ? v[1] : zs;
  const well = yi > 1.2 && zd < zs - 0.4;
  const dh = well ? hits(zd + 0.3) : [];
  const yd = well ? Math.min(dh.length > 1 ? dh[1] : yi - 1.5, yi) : 0;
  stations.push({ x, keel, zs, hb, well, zd: well ? zd : zs, yd, yi });
});
// Ölçüm gürültüsünü azalt: yarı genişlikleri x boyunca 3 noktalı ağırlıklı ortalamayla süz (uç istasyonlar hariç).
{
  const raw = stations.map((st) => st.hb.slice());
  for (let i = 1; i < stations.length - 1; i++) {
    for (let j = 0; j < NS; j++) stations[i].hb[j] = 0.25 * raw[i - 1][j] + 0.5 * raw[i][j] + 0.25 * raw[i + 1][j];
  }
  // Kuyu ölçüleri (iç kenar, güverte kenarı, güverte) de süzülür: küpeştenin iç kenarı üstten dalgalı görünmesin.
  for (let pass = 0; pass < 2; pass++) {
    const w = stations.map((st) => ({ yi: st.yi, yd: st.yd, zd: st.zd }));
    for (let i = 1; i < stations.length - 1; i++) {
      if (!stations[i - 1].well || !stations[i].well || !stations[i + 1].well) continue;
      for (const k of ['yi', 'yd', 'zd'] as const) stations[i][k] = 0.25 * w[i - 1][k] + 0.5 * w[i][k] + 0.25 * w[i + 1][k];
    }
  }
}
// Baş ucu: bodoslama x 30.83'te z ≈ 26'da sıfır genişlikle kapanır.
stations.push({ x: 30.83, keel: 25.9, zs: 26.1, hb: Array(NS).fill(0), well: false, zd: 26.1, yd: 0, yi: 0 });
console.log(`${stations.length} istasyon; kuyu ${stations.filter((s) => s.well).length} istasyonda`);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sampleHb = (hb: number[], sc: number) => {
  const f = sc * (NS - 1);
  const j = Math.min(NS - 2, Math.floor(f));
  return lerp(hb[j], hb[j + 1], f - j);
};
/** İstasyonun kuyu iç yarı genişliği z'de (kuyu yoksa negatif). */
const wellHalf = (st: St, z: number) => (st.well ? lerp(st.yd, st.yi, Math.min(1, Math.max(0, (z - st.zd) / (st.zs - st.zd)))) : -1);
// ---- Uygulamanın "tekne" (hull) şekline çevir: ölçü tablosu projede saklanır, yüzeyi uygulama üretir.
const HB = 31; // istasyon başına yarı genişlik sayısı (omurga → küpeşte, eşit aralıklı)
const down = (hb: number[], n: number) => Array.from({ length: n }, (_, j) => r2(sampleHb(hb, j / (n - 1))));
const hullGeom = {
  kind: 'hull',
  stations: stations.map((st) => ({ x: st.x, keel: r2(st.keel), sheer: r2(st.zs), breadth: down(st.hb, HB) })),
};
// Güverte kuyusu: omurgası güverte, küpeştesi teknenin 3 mm üstü; yarı genişlik güverte kenarından küpeşte iç
// kenarına doğrusal, küpeşteden yukarı dik.
const WB = 11;
const wellGeom = {
  kind: 'hull',
  stations: stations
    .filter((st) => st.well)
    .map((st) => {
      const top = st.zs + 3;
      return {
        x: st.x,
        keel: r2(st.zd),
        sheer: r2(top),
        breadth: Array.from({ length: WB }, (_, j) => {
          const z = st.zd + ((top - st.zd) * j) / (WB - 1);
          return r2(z >= st.zs ? st.yi : st.yd + ((st.yi - st.yd) * (z - st.zd)) / (st.zs - st.zd));
        }),
      };
    }),
};
console.log(`tekne tablosu ${hullGeom.stations.length}×${HB}, kuyu ${wellGeom.stations.length}×${WB}`);
const cabinDeck = Math.min(...stations.filter((st) => st.well && st.x > -7.7 && st.x < 12.9).map((st) => st.zd));
const FLOOR = r2(Math.min(8.5, cabinDeck) - 0.1);
console.log('kabin bölgesi güverte en düşük', r2(cabinDeck), '→ kabin tabanı', FLOOR);

// ---------------------------------------------------------------- üst yapı (ölçülerle)
const C = { tekne: '#f08a24', kabin: '#f4f1ea', cati: '#2c3e50', baca: '#c0392b', siyah: '#222222', kasa: '#8d6e63', metal: '#5b5b5b' };
const O = { x: 0, y: 0, z: 0 };
const box = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string, role = 'solid') => ({
  op: 'create', shape: 'box', name, color, role,
  params: [{ name: 'width', value: r2(x1 - x0) }, { name: 'depth', value: r2(y1 - y0) }, { name: 'height', value: r2(z1 - z0) }],
  position: { x: r2((x0 + x1) / 2), y: r2((y0 + y1) / 2), z: r2((z0 + z1) / 2) },
});
const cyl = (name: string, d: number, h: number, pos: { x: number; y: number; z: number }, rot: { x: number; y: number; z: number } | null, color: string, role = 'solid') => ({
  op: 'create', shape: 'cylinder', name, color, role, params: [{ name: 'diameter', value: d }, { name: 'height', value: h }], position: pos, ...(rot ? { rotation: rot } : {}),
});
/** Yamuk plan (arka x0'da ±w0, ön x1'de ±w1), z0..z1 arası dik ekstrüzyon. */
const trap = (name: string, x0: number, x1: number, w0: number, w1: number, z0: number, z1: number, color: string, role = 'solid') => ({
  op: 'create', shape: 'extrude', name, color, role, position: O, params: [{ name: 'height', value: r2(z1 - z0) }],
  geom: { kind: 'extrude', axis: 'z', profile: [[x0, -w0], [x1, -w1], [x1, w1], [x0, w0]] },
  // extrude merkezli: z0..z1 için konum z = (z0+z1)/2
  _z: (z0 + z1) / 2,
});
const fixZ = (op: Record<string, unknown>) => {
  if ('_z' in op) {
    op.position = { x: 0, y: 0, z: r2(op._z as number) };
    delete op._z;
  }
  return op;
};

/** Kemerli kapı pervazı: profil = kapı açıklığı (x −2.36…6.64, kemer r 4.5), 1.5 mm çerçeve, alt kenar açık. */
function doorFrame(name: string, y: number) {
  const cx = 2.14;
  const cz = 27.36;
  const arc = Array.from({ length: 17 }, (_, i) => {
    const a = (i / 16) * Math.PI;
    return [r2(cx + 4.6 * Math.cos(a)), r2(cz + 4.6 * Math.sin(a))] as P;
  });
  return {
    op: 'create', shape: 'extrude', name, color: C.kabin, position: { x: 0, y, z: 0 },
    params: [{ name: 'height', value: 0.8 }],
    geom: { kind: 'extrude', axis: 'y', profile: [[cx + 4.6, FLOOR - 0.1], ...arc, [cx - 4.6, FLOOR - 0.1]], frame: 1.4, open: true },
  };
}

const ops: Record<string, unknown>[] = [
  // Tekne: uygulamanın endaze (hull) şekli — küpeşte, taban, ayna ve bodoslama şeklin kendisinden keskin çıkar
  { op: 'create', shape: 'hull', name: 'tekne', color: C.tekne, position: O, geom: hullGeom },
  { op: 'create', shape: 'hull', name: 'güverte_kuyusu', color: C.tekne, role: 'hole', cuts: ['tekne'], position: O, geom: wellGeom },
  // kabin: yamuk gövde (duvarlar), iç boşluk, kemerli kapılar, ön cam, arka yuvarlak pencere
  // kabin ve boşlukları aynı yükseklikten (8.3) başlar: kabinden ince taban levhası kalmaz, zeminde
  // iki ayrı parçanın çakışan yüzeyi (z-fighting) oluşmaz; zemin teknenin kesilmiş yüzeyidir.
  // Her delik yalnızca kendi parçasını keser (cuts): aynı delik iki katıyı kesince aynı düzlemde iki yüzey oluşur
  // (z-fighting). Kabin zemini teknenin yüzeyidir; tekneyi kabin duvarlarının içinde biten ayrı bir delik oyar.
  trap('kabin', -7.64, 12.93, 7.5, 8.6, FLOOR, 36.8, C.kabin),
  { ...trap('kabin_ici', -5.64, 10.92, 5.71, 6.63, FLOOR - 0.1, 36.3, C.kabin, 'hole'), cuts: ['kabin'] },
  { ...trap('kabin_tabanı', -6.14, 11.42, 6.21, 7.13, FLOOR, FLOOR + 12, C.tekne, 'hole'), cuts: ['tekne'] },
  { ...box('kapı', -2.36, 6.64, -8.9, 8.9, FLOOR - 0.1, 27.36, C.kabin, 'hole'), cuts: ['kabin'] },
  { ...cyl('kapı_kemeri', 9, 17.8, { x: 2.14, y: 0, z: 27.36 }, { x: 90, y: 0, z: 0 }, C.kabin, 'hole'), cuts: ['kabin'] },
  doorFrame('kapı_pervazı_iskele', 8.2),
  doorFrame('kapı_pervazı_sancak', -8.2),
  { ...box('ön_cam', 10.5, 14, -5.25, 5.25, 24.61, 34.11, C.kabin, 'hole'), cuts: ['kabin'] },
  {
    op: 'create', shape: 'extrude', name: 'ön_cam_çerçevesi', color: C.kabin, position: { x: 13.08, y: 0, z: 0 },
    params: [{ name: 'height', value: 0.8 }],
    // açıklık camdan 0.1 mm geniş: çerçevenin iç yüzü kabinin kesim yüzüyle çakışmasın
    geom: { kind: 'extrude', axis: 'x', profile: [[-5.35, 24.51], [5.35, 24.51], [5.35, 34.21], [-5.35, 34.21]], frame: 1.4 },
  },
  { ...cyl('arka_pencere', 9, 4, { x: -7.2, y: 0, z: 27.27 }, { x: 0, y: 90, z: 0 }, C.kabin, 'hole'), cuts: ['kabin'] },
  { op: 'create', shape: 'tube', name: 'arka_pencere_çerçeve', color: C.kabin, params: [{ name: 'outerDiameter', value: 12 }, { name: 'innerDiameter', value: 9.2 }, { name: 'height', value: 0.8 }], position: { x: -7.84, y: 0, z: 27.27 }, rotation: { x: 0, y: 90, z: 0 } },
  // çatı: arkadan öne genişleyen, öne doğru yükselen levha (5.5°)
  {
    // çatı (loft'suz): yan profil y boyunca ekstrüzyon (5.5° eğim, ön pah, arka dudak); plandaki öne genişleme
    // (17 → 19.7 mm) iki yan kesimle
    op: 'create', shape: 'extrude', name: 'çatı', color: C.cati, position: O, params: [{ name: 'height', value: 19.7 }],
    geom: {
      kind: 'extrude', axis: 'y',
      profile: [[-8.95, 35.5], [-7.6, 36.4], [13.6, 36.61], [14.16, 37.67], [14.16, 39.95], [13.6, 40.28], [-7.6, 38.2], [-8.95, 37.76]],
    },
  },
  ...[1, -1].map((sy) => ({
    op: 'create', shape: 'extrude', name: `çatı_daralma_${sy > 0 ? 'iskele' : 'sancak'}`, color: C.cati, role: 'hole', cuts: ['çatı'],
    position: { x: 0, y: 0, z: 38 }, params: [{ name: 'height', value: 10 }],
    // arka kenar ±8.5 (x −8.95) → ön kenar ±9.85 (x 14.16) doğrusunun dışı
    geom: { kind: 'extrude', axis: 'z', profile: (sy > 0 ? [[-9.5, 8.47], [14.7, 9.88], [14.7, 11], [-9.5, 11]] : [[-9.5, -11], [14.7, -11], [14.7, -9.88], [-9.5, -8.47]]) as P[] },
  })),
  // baca: Ø6 gövde yukarı hafif genişler, Ø7 başlık, üstte 11 mm derin Ø3 ağız
  {
    op: 'create', shape: 'revolve', name: 'baca', color: C.baca, position: { x: -4, y: 0, z: 0 },
    geom: { kind: 'revolve', axis: 'z', profile: [[0, 36.7], [2.8, 36.7], [2.8, 38.3], [3.02, 44.72], [3.5, 45.27], [3.5, 47.73], [3.25, 48], [1.5, 48], [1.5, 37], [0, 37]] },
  },
  // kargo kasası: dış 10.81 × 12, iç 7 × 8, iç taban güverte altında (z 6.5)
  // kasa duvarları güverte altına iner; kasa içi yalnızca kasayı, kuyu yalnızca tekneyi keser (kesim yüzü duvar içinde)
  box('kasa', -18, -7.19, -6, 6, 6.4, 15.5, C.kasa),
  { ...box('kasa_ici', -16, -9, -4, 4, 6.5, 16, C.kasa, 'hole'), cuts: ['kasa'] },
  { ...box('kasa_kuyusu', -17.8, -7.4, -5.8, 5.8, 6.45, 9, C.tekne, 'hole'), cuts: ['tekne'] },
  // dümen (kabin içinde)
  box('dümen_ayağı', 6.2, 7.4, -1, 1, FLOOR - 0.1, 21, C.siyah),
  { op: 'create', shape: 'torus', name: 'dümen', color: C.siyah, params: [{ name: 'diameter', value: 9 }, { name: 'thickness', value: 1.2 }], position: { x: 7.2, y: 0, z: 22.4 }, rotation: { x: 0, y: 90, z: 0 } },
  // loçalar (Ø4, iki yandan geçer) ve olta tutucu
  // loçalar: delik ve flanş tekne yüzeyine dik oturur (place_on_surface; nokta Hawsepipe STL'den, z 20.6)
  ...[1, -1].flatMap((sy) => {
    const side = sy > 0 ? 'iskele' : 'sancak';
    const near = { x: 25.4, y: sy * 5.8, z: 20.6 };
    return [
      // delik borudan geniş (Ø4.6): teknenin kesim yüzü borunun duvarı içinde kalır; boru duvarı boydan boya geçer,
      // dışa 0.4 mm taşar (çerçeve), içeride kuyuya uzanır
      { ...cyl(`loça_${side}`, 4.6, 9, near, null, C.metal, 'hole'), cuts: ['tekne'] },
      { op: 'place_on_surface', part: `loça_${side}`, target: 'tekne', near, offset: 0 },
      { op: 'create', shape: 'tube', name: `loça_borusu_${side}`, color: C.metal, params: [{ name: 'outerDiameter', value: 5.8 }, { name: 'innerDiameter', value: 4 }, { name: 'height', value: 4 }], position: near },
      { op: 'place_on_surface', part: `loça_borusu_${side}`, target: 'tekne', near, offset: -1.6 },
    ];
  }),
  { op: 'create', shape: 'tube', name: 'olta_tutucu', color: C.metal, params: [{ name: 'outerDiameter', value: 3.4 }, { name: 'innerDiameter', value: 2 }, { name: 'height', value: 3 }], position: { x: -27.3, y: 0, z: 12.1 } },
  { op: 'view', show_names: false, show_dimensions: false, show_holes: false },
].map(fixZ);

if (process.argv[4]) writeFileSync(process.argv[4], JSON.stringify(ops));

// İşlemleri uygulamanın motoruyla projeye uygula, denetle, hacmi orijinalle karşılaştır, örnek dosyasını yaz.
const project = newProject('3DBenchy');
const res = applyOps(project, ops as never, null);
if (res.errors.length) throw new Error(`İşlem hataları: ${res.errors.join(' | ')}`);
const issues = checkProject(project);
for (const i of issues) console.log(`${i.level === 'hata' ? '✕' : '⚠'} ${i.message}`);
const m = mergedMesh(project, exportableParts(project.parts));
const ug = new THREE.BufferGeometry();
ug.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
ug.setIndex(m.tris);
console.log(`${project.parts.length} parça, ${ops.length} işlem; birleşik hacim ${((manifoldVolume(ug) ?? NaN) / 1000).toFixed(2)} cm³ (orijinal 15,55)`);
writeFileSync(process.argv[3], `${projectToJson(project)}\n`);
console.log(`yazıldı: ${process.argv[3]}${issues.some((i) => i.level === 'hata') ? ' (denetim hatası var!)' : ''}`);
