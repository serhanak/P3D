// Süpürme (`sweep`): kesitin yol boyunca süpürülmesi — hacimler (extrude, gönye, Pappus), çerçeve (up / rmf, dikey bölüm),
// doğrulama hataları, uç uca dikişsiz parçalar, kapalı yolda dikiş, çözünürlük, delik, GLB / check, dosya, Claude şeması
// ve Boltrush Retro boru tamponunun tek parça tekrarı.
import { beforeAll, describe, expect, it } from 'vitest';
import { RESPONSE_SCHEMA, normalizeLlmOp, type Op, type Pt2, type SweepGeom, type SweepPoint } from '../shared/ops';
import { checkProject } from '../src/check';
import { initCsg, manifoldVolume } from '../src/csg';
import { applyOps, partBox, sceneSummary } from '../src/engine';
import { buildGeomIndexed, describeGeom, sanitizeGeom } from '../src/geom';
import { buildGlb } from '../src/gltf';
import { parseProject, projectToJson, worldMesh } from '../src/io';
import { exportGeometry, solidVolume } from '../src/model';
import { newProject, type Part, type Project } from '../src/types';

beforeAll(() => initCsg());

/** Kapalı ve tutarlı yönlü ağ: hatalı yönlü kenar sayısı ve işaretli hacim. */
function closedMesh(pos: ArrayLike<number>, tris: ArrayLike<number>) {
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
  return { bad, vol, tris: tris.length / 3 };
}

function project(ops: Op[], seg = 24): Project {
  const p = newProject('süpürme');
  p.settings.resolution = seg;
  const res = applyOps(p, ops, null);
  expect(res.errors).toEqual([]);
  return p;
}

const byName = (p: Project, name: string): Part => {
  const part = p.parts.find((x) => x.name === name);
  if (!part) throw new Error(`parça yok: ${name}`);
  return part;
};

const at0 = { x: 0, y: 0, z: 0 };
const sweep = (name: string, geom: Omit<SweepGeom, 'kind'>, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'sweep',
  name,
  geom: { kind: 'sweep', ...geom } as SweepGeom,
  position: at0,
  ...extra,
});

function solid(p: Project, name: string) {
  const part = byName(p, name);
  const m = worldMesh(p, part);
  return { part, m, ...closedMesh(m.pos, m.tris), box: partBox(part, p.settings.resolution) };
}

/** Hata mesajı: süpürmeyi oluşturan işlemin hatası (parça oluşmaz). */
function errorOf(geom: Omit<SweepGeom, 'kind'> | Record<string, unknown>): string {
  const p = newProject('hata');
  const res = applyOps(p, [sweep('s', geom as Omit<SweepGeom, 'kind'>)], null);
  expect(p.parts).toHaveLength(0);
  expect(res.errors).toHaveLength(1);
  return res.errors[0];
}

const sq = (h: number): Pt2[] => [[-h, -h], [h, -h], [h, h], [-h, h]];
const L: Pt2[] = [[0, 0], [30, 0], [30, 6], [6, 6], [6, 20], [0, 20]]; // alan 264
/** Pahlı tampon kesiti (alan 12·12 − 4·2 = 136): u gidiş yönünün sağı, v yukarı. */
const CHAMFER: Pt2[] = [[-4, 0], [4, 0], [6, 2], [6, 10], [4, 12], [-4, 12], [-6, 10], [-6, 2]];
const polyArea = (n: number, r: number) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);

describe('sweep: hacim ve biçim', () => {
  it('düz yol = extrude: hacim, kutu; u gidiş yönünün sağı, v yukarı', () => {
    const p = project([
      sweep('düz', { path: [[0, 0, 0], [30, 0, 0]], profile: L }),
      { op: 'create', shape: 'extrude', name: 'ex', geom: { kind: 'extrude', axis: 'x', profile: L }, params: [{ name: 'height', value: 30 }], position: { x: 15, y: 0, z: 0 } },
    ]);
    const s = solid(p, 'düz');
    expect(s.bad).toBe(0);
    expect(s.vol).toBeCloseTo(264 * 30, 6);
    expect(s.vol).toBeCloseTo(solid(p, 'ex').vol, 6);
    // +x yönünde giderken sağ = −y, yukarı = +z
    expect([s.box.min.x, s.box.max.x, s.box.min.y, s.box.max.y, s.box.min.z, s.box.max.z]).toEqual([0, 30, -30, 0, 0, 20].map((v) => expect.closeTo(v, 5)));
  });

  it('gönyeli yol (L ve Z, düzlemsel) = alan × orta çizgi uzunluğu (kesitin ağırlık merkezi yolun üstünde)', () => {
    const p = project([
      sweep('L', { path: [[0, 0, 0], [50, 0, 0], [50, 40, 0]], profile: sq(5) }),
      sweep('Z', { path: [[0, 0, 20], [40, 0, 20], [60, 30, 20], [100, 30, 20]], profile: CHAMFER.map(([u, v]) => [u, v - 6] as Pt2) }),
    ]);
    const l = solid(p, 'L');
    expect(l.bad).toBe(0);
    expect(l.vol).toBeCloseTo(100 * 90, 4);
    const z = solid(p, 'Z');
    expect(z.bad).toBe(0);
    expect(z.vol / (136 * (40 + Math.hypot(20, 30) + 40))).toBeCloseTo(1, 6);
    // Gönye: köşedeki kesit dış yanda 1/cos(θ/2) uzar (L'nin dış köşesi (55, −5))
    expect([l.box.max.x, l.box.min.y]).toEqual([55, -5].map((v) => expect.closeTo(v, 5)));
  });

  it('kapalı daire yol + daire kesit ≈ torus (Pappus, iki çokgen düzeltmesiyle); boru kesiti iç halka', () => {
    // Kenar 40, köşe yarıçapı 20: yol tam daire (R = 20, 4 çeyrek yay × 6 kiriş = 24 kiriş)
    const ring = { path: [[-20, -20, 0], [20, -20, 0], [20, 20, 0], [-20, 20, 0]], closed: true, bend: 20 } as Omit<SweepGeom, 'kind'>;
    const p = project([sweep('halka', { ...ring, diameter: 6 }), sweep('boru', { ...ring, diameter: 6, innerDiameter: 4 }, { position: { x: 100, y: 0, z: 0 } })], 24);
    const chordFactor = (24 / (2 * Math.PI)) * Math.sin((2 * Math.PI) / 24);
    const h = solid(p, 'halka');
    expect(h.bad).toBe(0);
    expect(h.vol / (2 * Math.PI * 20 * polyArea(24, 3) * chordFactor)).toBeCloseTo(1, 6);
    const b = solid(p, 'boru');
    expect(b.bad).toBe(0);
    expect(b.vol / (2 * Math.PI * 20 * (polyArea(24, 3) - polyArea(24, 2)) * chordFactor)).toBeCloseTo(1, 6);
    expect(describeGeom(byName(p, 'halka').geom)).toBe('yol 4 nokta, 125,66 mm, kapalı, kesit Ø6, köşe yarıçapı 20');
  });

  it('yuvarlak kesit: bir düz kenar −v\'ye bakar (prizma kuralı); düz yol hacmi = çokgen alanı × uzunluk', () => {
    const p = project([sweep('çubuk', { path: [[0, 0, 0], [50, 0, 0]], diameter: 10 }), sweep('içi boş', { path: [[0, 20, 0], [50, 20, 0]], diameter: 10, innerDiameter: 6 })], 10);
    const s = solid(p, 'çubuk');
    expect(s.vol / (polyArea(10, 5) * 50)).toBeCloseTo(1, 6);
    expect(s.box.min.z).toBeCloseTo(-5 * Math.cos(Math.PI / 10), 5); // altta düz kenar
    expect(solid(p, 'içi boş').vol / ((polyArea(10, 5) - polyArea(10, 3)) * 50)).toBeCloseTo(1, 6);
  });

  it('3B yol: rmf kapalı ve kapalı ağ; yuvarlak kesitte kendiliğinden rmf; up ile düşey bölüm hatası', () => {
    const path3: SweepGeom['path'] = [[0, 0, 0], [40, 0, 0], [40, 30, 20], [0, 30, 40], [0, 0, 60]];
    const p = project([
      sweep('boru', { path: path3, closed: true, bend: 8, diameter: 6 }),
      sweep('profil rmf', { path: path3, closed: true, bend: 8, profile: sq(2), frame: 'rmf' }, { position: { x: 80, y: 0, z: 0 } }),
      // Düşey bölümlü boru: yuvarlak kesitte çerçeve kendiliğinden rmf
      sweep('dikey boru', { path: [[0, 0, 0], [30, 0, 0], [30, 0, 40], [0, 0, 40]], bend: 6, diameter: 6 }, { position: { x: 0, y: 80, z: 0 } }),
      // Düşey düzlemde kemer: up = düzlemin normali
      sweep('kemer', { path: [[0, 0, 0], [0, 0, 40], [40, 0, 40], [40, 0, 0]], bend: 10, profile: sq(2), up: [0, 1, 0] }, { position: { x: 80, y: 80, z: 0 } }),
    ]);
    for (const name of ['boru', 'profil rmf', 'dikey boru', 'kemer']) {
      const s = solid(p, name);
      expect(s.bad, name).toBe(0);
      expect(s.vol, name).toBeGreaterThan(0);
      const g = exportGeometry(p, s.part);
      expect(manifoldVolume(g), `${name}: manifold`).not.toBeNull();
      g.dispose();
    }
    const vertical = 'dikey bölüm var: frame: "rmf" verin ya da up\'ı değiştirin';
    expect(errorOf({ path: [[0, 0, 0], [30, 0, 0], [30, 0, 40]], bend: 6, profile: sq(2) })).toContain(vertical);
    expect(errorOf({ path: [[0, 0, 0], [30, 0, 0], [30, 0, 40]], bend: 6, profile: sq(2) })).toContain('Yol kenarı 2→3 up yönüyle 0° açı yapıyor');
    // Açık çerçeve tercihi kendiliğinden seçimi ezer: yuvarlak kesit + frame 'up' de düşey bölümde hata
    expect(errorOf({ path: [[0, 0, 0], [30, 0, 0], [30, 0, 40]], bend: 6, diameter: 4, frame: 'up' })).toContain(vertical);
    // Kenarlar düşey değil ama yay teğeti düşeyden geçiyor (xz düzleminde 146° dönüş)
    expect(errorOf({ path: [[0, 0, 0], [30, 0, 0], [0, 0, 20]], bend: 5, profile: sq(2) })).toMatch(/^'s': Yol noktası 2 köşesinde teğet up yönüne [\d,]+° yaklaşıyor: dikey bölüm var/);
  });
});

describe('sweep: doğrulama', () => {
  it('sığmayan yarıçap hata; mesaj o köşede sığan en büyük yarıçapı söyler (komşu yayın payı hesaba katılır)', () => {
    expect(errorOf({ path: [[0, 0, 0], [20, 0, 0], [20, 20, 0]], bend: 30, diameter: 6 })).toBe(
      "'s': Yol noktası 2: köşe yarıçapı 30 mm ('bend') sığmıyor (90° dönüş, kenarlar 20 / 20 mm); bu köşeye en fazla 20 mm verin ya da noktaları açın.",
    );
    // Kapalı kare (kenar 40): iki yay her kenarı paylaşır → en fazla 20
    expect(errorOf({ path: [[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0]], closed: true, bend: 25, diameter: 6 })).toContain('Yol noktası 1: köşe yarıçapı 25 mm');
    expect(errorOf({ path: [[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0]], closed: true, bend: 25, diameter: 6 })).toContain('en fazla 20 mm');
    // Komşu yay küçükse büyük yay kenarın yarısından fazlasını kullanabilir (30 + 5 ≤ 40); 38 + 5 > 40 → en fazla 35
    project([sweep('ok', { path: [[0, 0, 0], [40, 0, 0, 30], [40, 40, 0, 5], [0, 40, 0]], diameter: 6 })]);
    expect(errorOf({ path: [[0, 0, 0], [40, 0, 0, 38], [40, 40, 0, 5], [0, 40, 0]], diameter: 6 })).toContain('Yol noktası 2: köşe yarıçapı 38 mm sığmıyor');
    expect(errorOf({ path: [[0, 0, 0], [40, 0, 0, 38], [40, 40, 0, 5], [0, 40, 0]], diameter: 6 })).toContain('en fazla 35 mm');
    // Noktadaki r > 0 global bend'i ezer (8 + 30 ≤ 40 sığar; ikisi de 30 olsa sığmazdı)
    project([sweep('karışık', { path: [[0, 0, 0], [40, 0, 0, 8], [40, 40, 0], [0, 40, 0]], bend: 30, profile: sq(2) })]);
  });

  it('iç yanın katlanması: yayda yarıçap ≤ iç uzanım, gönyede kenar < iki uçtaki gönye payı (yöne bağlı)', () => {
    expect(errorOf({ path: [[0, 0, 0], [30, 0, 0], [30, 30, 0]], bend: 4, profile: sq(5) })).toBe(
      "'s': Yol noktası 2: köşe yarıçapı 4 mm ('bend'), kesitin dönüşün iç yanındaki uzanımından (5 mm) büyük olmalı; iç yan katlanır. Yarıçapı büyütün ya da kesiti küçültün.",
    );
    project([sweep('ok', { path: [[0, 0, 0], [30, 0, 0], [30, 30, 0]], bend: 5.5, profile: sq(5) })]);
    expect(errorOf({ path: [[0, 0, 0], [30, 0, 0], [30, 30, 0]], bend: 3, diameter: 6 })).toContain('iç yanındaki uzanımından (3 mm)');
    // U yol, kısa orta kenar: iki sola dönüşte iç yan (sol, u < 0) iki kez 5 mm ister
    expect(errorOf({ path: [[0, 0, 0], [30, 0, 0], [30, 4, 0], [0, 4, 0]], profile: sq(5) })).toBe(
      "'s': Yol kenarı 2→3 (4 mm) uçlarındaki köşelere yetmiyor: kesitin iç yanı en az 10 mm istiyor (gönye payı); kesit katlanır. Kenarı uzatın ya da köşeye yarıçap verin ('bend' ya da noktanın 4. değeri).",
    );
    // Kesit tümüyle dış yanda (u ≥ 0, sağ): aynı kısa kenar katlanmaz
    const p = project([sweep('dış', { path: [[0, 0, 0], [30, 0, 0], [30, 4, 0], [0, 4, 0]], profile: [[0, 0], [3, 0], [3, 5], [0, 5]] })]);
    expect(solid(p, 'dış').bad).toBe(0);
    // Yuvarlak kesitte daire sınırı (güvenli yan): 2 × 3·tan45° = 6 > 5
    expect(errorOf({ path: [[0, 0, 0], [30, 0, 0], [30, 5, 0], [0, 5, 0]], diameter: 6 })).toContain('en az 6 mm istiyor');
  });

  it('gönyede ≥ 150° dönüş hata (bend önerir); yayla aynı yol geçerli', () => {
    expect(errorOf({ path: [[0, 0, 0], [50, 0, 0], [0, 10, 0]], diameter: 3 })).toBe(
      "'s': Yol noktası 2: 168,7° dönüş gönye için fazla (en fazla 150°; gönye payı sonsuza gider). Köşeye yarıçap verin ('bend' ya da noktanın 4. değeri).",
    );
    project([sweep('ok', { path: [[0, 0, 0], [50, 0, 0], [0, 10, 0]], bend: 2, diameter: 3 })]);
  });

  it('biçim hataları: kendini kesen kesit, profil + çap, kesit yok, çakışık nokta, geri dönüş, uçta yarıçap, up, frame', () => {
    const path: SweepGeom['path'] = [[0, 0, 0], [30, 0, 0]];
    expect(errorOf({ path, profile: [[0, 0], [10, 10], [10, 0], [0, 10]] })).toContain('Kesit profili: kenarlar birbirini kesiyor');
    expect(errorOf({ path, profile: sq(2), diameter: 5 })).toContain("ya 'profile' (çokgen [u, v]) ya 'diameter' (yuvarlak) verin, ikisi birden değil");
    expect(errorOf({ path })).toContain('Süpürme kesiti eksik');
    expect(errorOf({ path, diameter: 5, innerDiameter: 5 })).toContain("'innerDiameter' 0 ile dış çap (5) arasında olmalı");
    expect(errorOf({ path, profile: sq(2), innerDiameter: 1 })).toContain("'innerDiameter' yalnızca 'diameter' ile");
    expect(errorOf({ path: [[0, 0, 0]], diameter: 5 })).toContain('en az 2 nokta');
    expect(errorOf({ path: [[0, 0, 0], [10, 0, 0], [10, 0, 0], [20, 5, 0]], diameter: 5 })).toContain('Yol noktası 2 ile 3 aynı yerde');
    expect(errorOf({ path: [[0, 0, 0], [10, 0, 0], [0, 0, 0]], diameter: 5 })).toContain('Yol noktası 2: yol burada tam geri dönüyor');
    expect(errorOf({ path: [[0, 0, 0, 5], [30, 0, 0]], diameter: 5 })).toContain('açık yolun ucunda köşe yok');
    expect(errorOf({ path: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], closed: true, bend: -1, diameter: 1 })).toContain("'bend'");
    expect(errorOf({ path, diameter: 5, up: [0, 0, 0] })).toContain("'up' sıfırdan farklı");
    expect(errorOf({ path, diameter: 5, frame: 'frenet' })).toContain('Geçersiz çerçeve');
    expect(errorOf({ path: [[0, 0, 0], [10, 0, 0], [0, 0, 0]], closed: true, diameter: 1 })).toContain('en az 3 farklı nokta');
  });

  it('normalize: boş alanlar düşer, kapanış tekrarı atılır, +Z up yazılmaz; sanitize kendine eşittir', () => {
    const g = sanitizeGeom('sweep', {
      kind: 'sweep',
      path: [[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 0, 0]],
      closed: true,
      bend: 0,
      profile: null,
      holes: [],
      diameter: 4.00001,
      innerDiameter: 0,
      up: [0, 0, 5],
      frame: null,
    });
    expect(g).toEqual({ kind: 'sweep', path: [[0, 0, 0], [40, 0, 0], [40, 40, 0]], closed: true, diameter: 4 });
    expect(sanitizeGeom('sweep', g)).toEqual(g);
  });
});

describe('sweep: çerçeve ve dikiş', () => {
  /** Halkaları (her biri `M` köşe) ve halka çiftleri arası kenarlar. */
  function rings(g: SweepGeom, seg: number) {
    const geo = buildGeomIndexed(sanitizeGeom('sweep', g), { scale: 1 }, seg);
    const pos = Array.from(geo.getAttribute('position').array);
    const idx = Array.from(geo.getIndex()!.array);
    geo.dispose();
    return { pos, idx };
  }

  it('kapalı 3B yuvarlak yol: kapanış farkı dağıtılır, dikişte halka indisi kayar (dikiş kenarları kısa)', () => {
    for (const seg of [6, 7, 10, 16, 24]) {
      const { pos, idx } = rings({ kind: 'sweep', path: [[0, 0, 0], [40, 0, 0], [40, 30, 20], [0, 30, 40], [0, 0, 60]], closed: true, bend: 8, diameter: 6 }, seg);
      const M = seg;
      const m = pos.length / 3 / M;
      const ring = (i: number) => Math.floor(i / M);
      const center = (k: number) => [0, 1, 2].map((q) => Array.from({ length: M }, (_, j) => pos[3 * (k * M + j) + q]).reduce((s, v) => s + v, 0) / M);
      const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      const P = (i: number) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
      let seam = 0;
      for (let t = 0; t < idx.length; t += 3) {
        for (const [a, b] of [[idx[t], idx[t + 1]], [idx[t + 1], idx[t + 2]], [idx[t + 2], idx[t]]]) {
          if (!((ring(a) === 0 && ring(b) === m - 1) || (ring(b) === 0 && ring(a) === m - 1))) continue;
          seam = Math.max(seam, d(P(a), P(b)) / d(center(0), center(m - 1)));
        }
      }
      // Dikiş düz kenar: bağlanan köşeler halka merkezleri kadar uzak (yanlış kayma çapı aşan kenarlar verirdi)
      expect(seam, `seg ${seg}`).toBeGreaterThan(0.99);
      expect(seam, `seg ${seg}`).toBeLessThan(1.01);
      expect(closedMesh(pos, idx).bad).toBe(0);
    }
  });

  it('rmf: düz kenarlar burulmaz (ardışık halkalar öteleme); son uç up\'a hizalanır', () => {
    const seg = 16;
    const path: SweepGeom['path'] = [[0, 0, 0], [40, 0, 0], [40, 30, 20], [0, 30, 40]];
    const { pos } = rings({ kind: 'sweep', path, bend: 8, diameter: 6 }, seg);
    const m = pos.length / 3 / seg;
    let translations = 0;
    for (let k = 0; k + 1 < m; k++) {
      const off = [0, 1, 2].map((q) => pos[3 * ((k + 1) * seg) + q] - pos[3 * (k * seg) + q]);
      const same = Array.from({ length: seg }, (_, j) => [0, 1, 2].every((q) => Math.abs(pos[3 * ((k + 1) * seg + j) + q] - pos[3 * (k * seg + j) + q] - off[q]) < 1e-5));
      if (same.every(Boolean)) translations++;
    }
    expect(translations).toBe(3); // P0 → yay 1, yay 1 → yay 2, yay 2 → P3
    // Son halka: teğet (P3 − P2), v = up'ın teğete dik bileşeni → çokgenin alttaki düz kenarı aşağıda (iki en alçak köşe aynı z'de)
    const last = Array.from({ length: seg }, (_, j) => pos[3 * ((m - 1) * seg + j) + 2]).sort((a, b) => a - b);
    expect(last[1] - last[0]).toBeLessThan(1e-5);
  });

  it('uç uca iki parça dikişsiz: aynı kesit, uç noktası ve teğeti aynı → uç halkaları birebir (up ve rmf)', () => {
    const p = project([
      // Rental tampon halkası gibi: yatay yol, pahlı kesit, R 30 köşeler; iki parça (100, 0)'da +y teğetiyle buluşur
      sweep('ön', { path: [[-100, -60, 0], [100, -60, 0], [100, 0, 0]], bend: 30, profile: CHAMFER }),
      sweep('arka', { path: [[100, 0, 0], [100, 60, 0], [-100, 60, 0]], bend: 30, profile: CHAMFER }),
      // 3B boru (rmf): (40, 60, 20)'de +y teğetiyle buluşur
      sweep('boru1', { path: [[0, 0, 0], [40, 0, 0], [40, 30, 20], [40, 60, 20]], bend: 8, diameter: 6 }),
      sweep('boru2', { path: [[40, 60, 20], [40, 90, 20], [0, 90, 40]], bend: 8, diameter: 6 }),
    ]);
    const ringAt = (name: string, test: (x: number, y: number, z: number) => boolean) => {
      const m = worldMesh(p, byName(p, name));
      const out: number[][] = [];
      for (let i = 0; i < m.pos.length; i += 3) if (test(m.pos[i], m.pos[i + 1], m.pos[i + 2])) out.push([m.pos[i], m.pos[i + 1], m.pos[i + 2]]);
      return out.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    };
    const seamA = (x: number, y: number) => Math.abs(y) < 1e-4 && x > 90;
    const a = ringAt('ön', seamA);
    expect(a).toHaveLength(CHAMFER.length);
    expect(ringAt('arka', seamA)).toEqual(a);
    const seamB = (x: number, y: number) => Math.abs(y - 60) < 1e-4 && x > 30;
    const b1 = ringAt('boru1', seamB);
    const b2 = ringAt('boru2', seamB);
    expect(b1).toHaveLength(24);
    expect(b2).toHaveLength(24);
    // rmf: son uç up'a hizalanır, çokgen kendi simetrisiyle döner → köşe kümeleri aynı (sıra farklı olabilir)
    for (const v of b1) expect(Math.min(...b2.map((w) => Math.hypot(v[0] - w[0], v[1] - w[1], v[2] - w[2])))).toBeLessThan(1e-4);
    expect(checkProject(p, { profile: 'game' })).toEqual([]);
  });

  it('ayna: aynanın aynası özgün geom; up yansır (z düzleminde [0, 0, −1]), profil u işaret değiştirir', () => {
    const p = project([sweep('t', { path: [[0, 0, 0], [40, 0, 5], [40, 30, 10]], bend: 8, profile: CHAMFER })]);
    const r = applyOps(
      p,
      [
        { op: 'mirror', part: 't', plane: 'z', at: 0, name: 't z' },
        { op: 'mirror', part: 't z', plane: 'z', at: 0, name: 't geri' },
        { op: 'mirror', part: 't', plane: 'x', at: 0, name: 't x' },
      ],
      null,
    );
    expect(r.errors).toEqual([]);
    const g = (name: string) => byName(p, name).geom as SweepGeom;
    expect(g('t z').up).toEqual([0, 0, -1]);
    expect(g('t z').path[1]).toEqual([40, 0, -5]);
    expect(g('t z').profile).toEqual(CHAMFER.map(([u, v]) => [u === 0 ? 0 : -u, v]).reverse());
    expect(g('t geri')).toEqual(g('t'));
    expect(g('t x').up).toBeUndefined();
    expect(g('t x').path[1]).toEqual([-40, 0, 5]);
  });
});

describe('sweep: çözünürlük, delik, dışa aktarım, dosya', () => {
  it('çözünürlük: yay kiriş sayısı ve yuvarlak kesit kenar sayısı (parça başına); yaysız köşeli kesitte uyarıyla yok sayılır', () => {
    const geom = { path: [[0, 0, 0], [40, 0, 0], [40, 40, 0]], bend: 10, diameter: 6 } as Omit<SweepGeom, 'kind'>;
    const p = project([sweep('8', geom, { resolution: 8 }), sweep('32', geom, { resolution: 32, position: { x: 0, y: 60, z: 0 } })], 24);
    // 8: 8 kenar, 90° yay 2 kiriş → 5 halka: 4 × 16 + kapaklar 2 × 6 = 76; 32: 32 kenar, 8 kiriş → 11 halka: 10 × 64 + 2 × 30 = 700
    expect(solid(p, '8').tris).toBe(76);
    expect(solid(p, '32').tris).toBe(700);
    const res = applyOps(p, [sweep('köşeli', { path: [[0, 0, 0], [40, 0, 0], [40, 40, 0]], profile: sq(2) }, { resolution: 8, position: { x: 80, y: 0, z: 0 } })], null);
    expect(res.errors).toEqual([]);
    expect(res.messages.join(' ')).toContain('süpürme için yok sayıldı. Süpürme ancak köşe yarıçapı (bend) ya da yuvarlak kesit (diameter) varken segment kullanır.');
    expect(byName(p, 'köşeli').resolution).toBeUndefined();
    // Profil + yay: çözünürlük yalnızca kiriş sayısını değiştirir
    const q = project([sweep('a', { path: [[0, 0, 0], [40, 0, 0], [40, 40, 0]], bend: 10, profile: sq(2) }, { resolution: 8 })]);
    expect(solid(q, 'a').tris).toBe(4 * 4 * 2 + 2 * 2); // 5 halka × 4 nokta
  });

  it('6 segmentte her tür kapalı ve manifold (gönye, yay, kapalı, boşluklu profil, içi boş boru)', () => {
    const p = project(
      [
        sweep('gönye', { path: [[0, 0, 0], [30, 0, 0], [30, 30, 10], [0, 30, 20]], profile: sq(2) }),
        sweep('yay', { path: [[0, 0, 0], [30, 0, 0], [30, 30, 10], [0, 30, 20]], bend: 5, diameter: 4 }, { position: { x: 50, y: 0, z: 0 } }),
        sweep('halka', { path: [[0, 0, 0], [30, 0, 0], [30, 30, 0], [0, 30, 0]], closed: true, bend: 8, profile: CHAMFER }, { position: { x: 100, y: 0, z: 0 } }),
        sweep('boşluklu', { path: [[0, 0, 0], [30, 0, 0], [30, 30, 0]], bend: 8, profile: sq(3), holes: [sq(1)] }, { position: { x: 0, y: 50, z: 0 } }),
        sweep('boru', { path: [[0, 0, 0], [30, 0, 0], [30, 30, 15], [0, 30, 30]], closed: true, bend: 6, diameter: 4, innerDiameter: 2 }, { position: { x: 50, y: 50, z: 0 } }),
      ],
      6,
    );
    for (const part of p.parts) {
      const s = solid(p, part.name);
      expect(s.bad, part.name).toBe(0);
      expect(s.vol, part.name).toBeGreaterThan(0);
      const g = exportGeometry(p, part);
      expect(manifoldVolume(g), `${part.name}: manifold`).not.toBeNull();
      g.dispose();
    }
    // Pappus, kirişli yay (90° = 2 kiriş, çarpan sin(45°)/45°): alan 32 × (44 düz + 4π yay × düzeltme)
    expect(solid(p, 'boşluklu').vol).toBeCloseTo(32 * (44 + 16 * Math.sin(Math.PI / 4)), 3);
  });

  it('delik olarak keser (kanal); GLB ve check --profile game temiz; dosya gidiş-dönüşü; sahne özetinde tam geom', () => {
    const p = project([
      { op: 'create', shape: 'box', name: 'plaka', params: [{ name: 'width', value: 80 }, { name: 'depth', value: 60 }, { name: 'height', value: 10 }], position: { x: 0, y: 0, z: 5 } },
      sweep('kanal', { path: [[-30, -40, 10], [-30, 20, 10], [30, 20, 10], [30, -40, 10]], bend: 10, diameter: 6 }, { role: 'hole', cuts: ['plaka'] }),
      sweep('tampon', { path: [[-100, -60, 0], [100, -60, 0], [100, 60, 0], [-100, 60, 0]], closed: true, bend: 30, profile: CHAMFER }, { position: { x: 0, y: 150, z: 0 } }),
    ]);
    const plate = solidVolume(p, byName(p, 'plaka'));
    expect(plate).toBeLessThan(80 * 60 * 10 - 100);
    expect(plate).toBeGreaterThan(80 * 60 * 10 - 3000);
    expect(checkProject(p, { profile: 'game' })).toEqual([]);
    const glb = buildGlb(p);
    expect(new DataView(glb.buffer, glb.byteOffset).getUint32(0, true)).toBe(0x46546c67);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true))));
    expect(json.meshes.map((m: { name: string }) => m.name)).toEqual(['plaka', 'tampon']);
    expect(parseProject(JSON.parse(projectToJson(p)))).toEqual(p);
    const summary = sceneSummary(p, null).parts.find((x) => x.name === 'tampon')!;
    expect(summary.geom).toEqual(byName(p, 'tampon').geom);
  });

  it('varsayılan geom (U boru), update ile geom ve scale', () => {
    const p = project([{ op: 'create', shape: 'sweep', name: 'u' }]);
    const part = byName(p, 'u');
    expect(part.geom).toEqual({ kind: 'sweep', path: [[-20, -10, 0], [-20, 10, 0], [20, 10, 0], [20, -10, 0]], bend: 8, diameter: 6 });
    expect(partBox(part, 24).min.z).toBeCloseTo(0, 2); // otomatik yerleşim konumu 3 ondalığa yuvarlar
    const v0 = solid(p, 'u').vol;
    applyOps(p, [{ op: 'scale', part: 'u', factor: 2 }], null);
    expect(solid(p, 'u').vol / v0).toBeCloseTo(8, 6);
    const r = applyOps(p, [{ op: 'update', part: 'u', geom: { kind: 'sweep', path: [[0, 0, 0], [10, 0, 0]], diameter: 0 } as SweepGeom }], null);
    expect(r.errors.join(' ')).toContain("'u': Süpürme kesiti eksik");
  });

  it('Claude şeması: sweep anyOf içinde, tüm alanlar zorunlu; null / 0 / [] boş değerleri temiz geom verir', () => {
    const items = RESPONSE_SCHEMA.properties.operations.items.anyOf as unknown as { properties: Record<string, { anyOf?: { properties?: Record<string, unknown>; required?: string[] }[] }> }[];
    const create = items.find((x) => (x.properties.op as unknown as { const: string }).const === 'create')!;
    const s = create.properties.geom.anyOf!.find((x) => (x.properties?.kind as { const?: string } | undefined)?.const === 'sweep')!;
    expect(s.required).toEqual(['kind', 'path', 'closed', 'bend', 'profile', 'holes', 'diameter', 'innerDiameter', 'up', 'frame']);
    expect(s.properties!.frame).toEqual({ anyOf: [{ type: 'string', enum: ['up', 'rmf'] }, { type: 'null' }] });
    const path = [[-350, -606, 109], [-350, -766, 109], [350, -766, 109], [350, -606, 109]];
    const llm = (geom: Record<string, unknown>) =>
      normalizeLlmOp({
        op: 'create', shape: 'sweep', name: 'boru', params: [], position: at0, rotation: null, color: '', place_on: '', role: '', cuts: [], opacity: null, resolution: null,
        geom: { kind: 'sweep', path, ...geom },
      });
    const empty = { closed: null, bend: 62, profile: null, holes: null, diameter: 28, innerDiameter: null, up: null, frame: null };
    const zeros = { closed: false, bend: 62, profile: [], holes: [], diameter: 28, innerDiameter: 0, up: [], frame: null };
    for (const g of [empty, zeros]) {
      const p = project([llm(g)]);
      expect(byName(p, 'boru').geom).toEqual({ kind: 'sweep', path, bend: 62, diameter: 28 });
    }
  });
});

describe('sweep: Boltrush Retro boru tamponu (tek parça)', () => {
  it('U çember Ø28, köşe R 62: tek kapalı ağ, check temiz; üçgen sayısı', () => {
    // go-body-2.mts → retroNose: hoop = (−350, −606) → (−350, −766) → (350, −766) → (350, −606), z 109; fillet(62) + pipe.
    // Bugün 11 prizma parçası (ardışık parçalarda 0,4 mm çap farkıyla z-fighting önlenir); burada tek süpürme.
    const hoop: SweepGeom['path'] = [[-350, -606, 109], [-350, -766, 109], [350, -766, 109], [350, -606, 109]];
    const p = project([
      sweep('hoop', { path: hoop, bend: 62, diameter: 28 }, { resolution: 10, color: '#cfd4da' }),
      sweep('hoop16', { path: hoop, bend: 62, diameter: 28 }, { resolution: 16, position: { x: 0, y: -300, z: 0 } }),
    ]);
    const s = solid(p, 'hoop');
    expect(s.bad).toBe(0);
    // 10 kenar, 90° yay 3 kiriş (36°'lik adım): 10 halka → 9 × 20 + kapaklar 2 × 8 = 196 üçgen
    expect(s.tris).toBe(196);
    expect(solid(p, 'hoop16').tris).toBe(380); // 16 kenar, 4 kiriş (22,5°): 12 halka → 11 × 32 + 2 × 14
    expect([s.box.min.x, s.box.max.x, s.box.min.y, s.box.max.y]).toEqual([-364, 364, -780, -606].map((v) => expect.closeTo(v, 4)));
    expect(s.box.min.z).toBeCloseTo(109 - 14 * Math.cos(Math.PI / 10), 4); // altta düz kenar
    const g = exportGeometry(p, s.part);
    expect(manifoldVolume(g)).not.toBeNull();
    g.dispose();
    expect(checkProject(p, { profile: 'game' })).toEqual([]);
    expect(checkProject(p).filter((i) => i.level === 'hata')).toEqual([]);
  });
});

/** Alanı ~0 (bozuk) üçgen sayısı. */
function degenerate(pos: ArrayLike<number>, tris: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [tris[i] * 3, tris[i + 1] * 3, tris[i + 2] * 3];
    const u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
    const v = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
    if (Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) < 1e-9) n++;
  }
  return n;
}

/** Yerel ağ (sanitize + üretim): kapalılık, bozuk üçgen, hacim. */
function local(g: Omit<SweepGeom, 'kind'>, seg = 24) {
  const geo = buildGeomIndexed(sanitizeGeom('sweep', { kind: 'sweep', ...g }), { scale: 1 }, seg);
  const pos = geo.getAttribute('position').array;
  const idx = geo.getIndex()!.array;
  geo.dispose();
  return { ...closedMesh(pos, idx), degen: degenerate(pos, idx), pos };
}

describe('sweep: inceleme düzeltmeleri', () => {
  it('uç kapağı: içi boş boru ve hizalı boşluklarda T-kavşağı yok (kapalı ağ, bozuk üçgen yok); delikle kesilince check temiz', () => {
    const straight: SweepGeom['path'] = [[0, 0, 10], [50, 0, 10]];
    for (const [d, di, seg] of [[6, 3, 96], [6, 3, 6], [6, 3, 192], [6, 3, 12], [20, 10, 24], [10, 5, 24]]) {
      const r = local({ path: straight, diameter: d, innerDiameter: di }, seg);
      expect(r.bad, `Ø${d}/${di} @${seg}`).toBe(0);
      expect(r.degen, `Ø${d}/${di} @${seg}: bozuk üçgen`).toBe(0);
      expect(r.vol / ((polyArea(seg, d / 2) - polyArea(seg, di / 2)) * 50)).toBeCloseTo(1, 5);
    }
    // Aynı hizada iki/üç boşluk (earcut doğrusal köşeyi atar)
    const twoHoles: Pt2[][] = [[[-15, 2], [-5, 2], [-5, 8], [-15, 8]], [[5, 2], [15, 2], [15, 8], [5, 8]]];
    const threeHoles: Pt2[][] = [[[-15, 5], [-10, 5], [-10, 15], [-15, 15]], [[-3, 5], [3, 5], [3, 15], [-3, 15]], [[10, 5], [15, 5], [15, 15], [10, 15]]];
    for (const [holes, h, area] of [[twoHoles, 10, 400 - 120], [threeHoles, 20, 800 - 50 - 60 - 50]] as const) {
      for (const path of [straight, [[0, 0, 0], [50, 0, 0], [50, 40, 0]]] as SweepGeom['path'][]) {
        const r = local({ path, profile: [[-20, 0], [20, 0], [20, h], [-20, h]], holes: holes as unknown as Pt2[][] });
        expect(r.bad).toBe(0);
        expect(r.degen).toBe(0);
        if (path.length === 2) expect(r.vol).toBeCloseTo(area * 50, 3);
      }
    }
    const p = project(
      [
        sweep('boru', { path: straight, diameter: 6, innerDiameter: 3 }),
        { op: 'create', shape: 'box', name: 'delik', role: 'hole', cuts: ['boru'], params: [{ name: 'width', value: 4 }, { name: 'depth', value: 20 }, { name: 'height', value: 20 }], position: { x: 25, y: 0, z: 10 } },
      ],
      96,
    );
    expect(checkProject(p).filter((i) => i.level === 'hata')).toEqual([]);
  });

  it('extrude: hizalı iki boşlukta da kapalı ağ (T-kavşağı onarımı)', () => {
    const p = project([
      {
        op: 'create',
        shape: 'extrude',
        name: 'ex',
        position: at0,
        params: [{ name: 'height', value: 50 }],
        geom: { kind: 'extrude', axis: 'x', profile: [[-20, 0], [20, 0], [20, 10], [-20, 10]], holes: [[[-15, 2], [-5, 2], [-5, 8], [-15, 8]], [[5, 2], [15, 2], [15, 8], [5, 8]]] },
      },
    ]);
    const s = solid(p, 'ex');
    expect(s.bad).toBe(0);
    expect(degenerate(s.m.pos, s.m.tris)).toBe(0);
    expect(s.vol).toBeCloseTo(280 * 50, 3);
  });

  it("'up' çerçevesinde hızlı burulma hata (rmf önerir); gerçekçi yollar (tampon, rampa korkuluğu, sarmal küpeşte, kemer) geçer", () => {
    const twist = { path: [[54, -30.03, 11.53], [100.66, 9.85, 0], [143.64, -22.99, 7.14]], profile: sq(4.52), up: [-0.558, -0.228, 0.061] } as Omit<SweepGeom, 'kind'>;
    const msg = errorOf(twist);
    expect(msg).toContain('up bu yolda hızla dönüyor');
    expect(msg).toContain('frame: "rmf" verin');
    expect(local({ ...twist, frame: 'rmf' }, 12).bad).toBe(0);
    const spiral = Array.from({ length: 13 }, (_, i) => [Math.round(80 * Math.cos(i / 2) * 1e4) / 1e4, Math.round(80 * Math.sin(i / 2) * 1e4) / 1e4, i * 12] as SweepPoint);
    project([
      sweep('tampon', { path: [[-100, -60, 0], [100, -60, 0], [100, 60, 0], [-100, 60, 0]], closed: true, bend: 30, profile: CHAMFER }),
      sweep('rampa', { path: [[0, 0, 0], [100, 0, 0], [200, 0, 60], [300, 0, 60]], bend: 20, profile: CHAMFER }, { position: { x: 0, y: 100, z: 0 } }),
      sweep('rampa gönye', { path: [[0, 0, 0], [100, 0, 0], [200, 0, 60], [300, 0, 60]], profile: CHAMFER }, { position: { x: 0, y: 150, z: 0 } }),
      sweep('sarmal', { path: spiral, bend: 10, profile: sq(3) }, { position: { x: 0, y: 300, z: 0 } }),
      sweep('sarmal gönye', { path: spiral, profile: sq(3) }, { position: { x: 200, y: 300, z: 0 } }),
      sweep('kemer', { path: [[0, 0, 0], [0, 0, 40], [40, 0, 40], [40, 0, 0]], bend: 10, up: [0, 1, 0], profile: sq(2) }, { position: { x: 300, y: 0, z: 0 } }),
      // Düşey düzlemde 120° zikzak gönye: çerçeve tutarlı, burulma 0 (v'nin kendi dönüşü sayılmaz)
      sweep('zikzak', { path: [[0, 0, 0], [30, 0, 52], [60, 0, 0], [90, 0, 52]], profile: sq(2) }, { position: { x: 400, y: 0, z: 0 } }),
      // Tırmanırken 90° dönen merdiven küpeştesi, yaylı köşe (burulma ~24°)
      sweep('merdiven', { path: [[0, 0, 0], [100, 0, 50], [100, 100, 100], [0, 100, 150]], bend: 20, profile: sq(3) }, { position: { x: 0, y: 500, z: 0 } }),
    ]);
    // Aynı merdiven keskin gönyeyle: köşede kesit kenar boyunca ~48° burulur → hata, yay önerilir
    expect(errorOf({ path: [[0, 0, 0], [100, 0, 50], [100, 100, 100], [0, 100, 150]], profile: sq(3) })).toContain("köşeye yarıçap verin (bend");
  });

  it('baştan sona up yönündeki yolda yuvarlak olmayan kesit hata; up yola dik verilince birebir aynalanır', () => {
    expect(errorOf({ path: [[0, 0, 0], [0, 0, 50]], profile: sq(2), frame: 'rmf' })).toContain("yol baştan sona up yönünde: kesit yönünü belirlemek için up'ı yola dik verin");
    project([sweep('boru', { path: [[0, 0, 0], [0, 0, 50]], diameter: 4 })]); // yuvarlak kesitte yedek çerçeve
    const p = project([sweep('dik', { path: [[0, 0, 0], [0, 0, 50]], profile: [[-2, 0], [3, 0], [3, 4], [-2, 4]], up: [1, 0, 0], frame: 'rmf' }, { position: { x: 10, y: 5, z: 0 } })]);
    expect(applyOps(p, [{ op: 'mirror', part: 'dik', plane: 'y', at: 0, name: 'ayna' }], null).errors).toEqual([]);
    const a = worldMesh(p, byName(p, 'dik'));
    const b = worldMesh(p, byName(p, 'ayna'));
    expect(b.pos.length).toBe(a.pos.length);
    for (let i = 0; i < a.pos.length; i += 3) {
      const best = Math.min(...Array.from({ length: b.pos.length / 3 }, (_, j) => Math.hypot(a.pos[i] - b.pos[3 * j], -a.pos[i + 1] - b.pos[3 * j + 1], a.pos[i + 2] - b.pos[3 * j + 2])));
      expect(best).toBeLessThan(1e-4);
    }
  });

  it('doğrusal ara nokta kenar zincirinde birleşir: sahte "yetmiyor" / "sığmıyor" yok', () => {
    const control = local({ path: [[0, 0, 0], [41, 0, 0], [41, 30, 0]], profile: sq(5) });
    const helper = local({ path: [[0, 0, 0], [40, 0, 0], [41, 0, 0], [41, 30, 0]], profile: sq(5) });
    expect(helper.bad).toBe(0);
    expect(helper.vol).toBeCloseTo(control.vol, 6);
    const arc = local({ path: [[0, 0, 0], [41, 0, 0], [41, 30, 0]], diameter: 4, bend: 6 });
    for (const path of [[[0, 0, 0], [40, 0, 0], [41, 0, 0], [41, 30, 0]], [[0, 0, 0], [39, 0, 0], [41, 0, 0], [41, 30, 0]]] as SweepGeom['path'][]) {
      expect(local({ path, diameter: 4, bend: 6 }).vol).toBeCloseTo(arc.vol, 6);
    }
    expect(local({ path: [[0, 0, 0], [97, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]], closed: true, diameter: 4, bend: 10 }).bad).toBe(0);
    // Gerçekten sığmayan yarıçapta mesaj zincirin toplam uzunluğunu söyler
    expect(errorOf({ path: [[0, 0, 0], [10, 0, 0], [20, 0, 0], [20, 30, 0]], diameter: 4, bend: 25 })).toContain('kenarlar 20 / 30 mm); bu köşeye en fazla 20 mm');
  });

  it('mutlak koordinat sınırı ±1 000 000 mm (yol, kesit, bend, up)', () => {
    expect(errorOf({ path: [[0, 0, 0], [1e150, 0, 0]], diameter: 4 })).toContain('±1.000.000 mm');
    expect(errorOf({ path: [[0, 0, 0], [2e6, 0, 0]], diameter: 4 })).toContain('Yol noktası 2');
    expect(errorOf({ path: [[0, 0, 0], [100, 0, 0]], profile: [[0, 0], [2e6, 0], [0, 5]] })).toContain('±1.000.000 mm');
    expect(errorOf({ path: [[0, 0, 0], [100, 0, 0], [100, 100, 0]], diameter: 2e6 })).toContain('±1.000.000 mm');
    expect(errorOf({ path: [[0, 0, 0], [100, 0, 0], [100, 100, 0]], diameter: 4, bend: 1e7 })).toContain('±1.000.000 mm');
    expect(errorOf({ path: [[0, 0, 0], [100, 0, 0]], diameter: 4, up: [0, 1e200, 0] })).toContain('±1.000.000 mm');
    expect(local({ path: [[0, 0, 0], [1e6, 0, 0], [1e6, 1e6, 0]], diameter: 4000, bend: 1e5 }).bad).toBe(0);
  });

  it('köşe bütçesi: yol × kesit noktası doğrulamada, çözünürlüğe bağlı aşım üretimde açıklayıcı hata', () => {
    const path = Array.from({ length: 1001 }, (_, i) => [i, i % 2, 0] as SweepPoint);
    const profile = Array.from({ length: 1000 }, (_, j) => [Math.round(10 * Math.cos((2 * Math.PI * j) / 1000) * 1e4) / 1e4, Math.round(10 * Math.sin((2 * Math.PI * j) / 1000) * 1e4) / 1e4] as Pt2);
    expect(errorOf({ path, profile })).toContain('köşe sınırını');
    const helix = Array.from({ length: 1000 }, (_, i) => [Math.round(200 * Math.cos(i * 0.35) * 1e4) / 1e4, Math.round(200 * Math.sin(i * 0.35) * 1e4) / 1e4, i * 3] as SweepPoint);
    const p = newProject('bütçe');
    p.settings.resolution = 192;
    const res = applyOps(p, [sweep('sarmal', { path: helix, bend: 20, diameter: 8 })], null);
    expect(res.errors.join(' ')).toContain('çözünürlüğü düşürün');
  });

  it('boşluk doğrulaması (yalnızca sweep): profilin içinde, kenara değmeyen, birbirini kesmeyen/kapsamayan; extrude eskisi gibi kabul eder', () => {
    const path: SweepGeom['path'] = [[0, 0, 0], [50, 0, 0]];
    const outer: Pt2[] = [[-10, 0], [10, 0], [10, 10], [-10, 10]];
    expect(errorOf({ path, profile: outer, holes: [[[-5, 2], [15, 2], [15, 8], [-5, 8]]] })).toContain('Kesit boşluğu 1');
    expect(errorOf({ path, profile: outer, holes: [[[-5, 0], [5, 0], [5, 8], [-5, 8]]] })).toContain('profilin kenarına değiyor');
    expect(errorOf({ path, profile: outer, holes: [[[-5, 2], [1, 2], [1, 8], [-5, 8]], [[0, 3], [5, 3], [5, 7], [0, 7]]] })).toContain('Kesit boşlukları 1 ve 2');
    expect(errorOf({ path, profile: outer, holes: [[[-8, 1], [8, 1], [8, 9], [-8, 9]], [[-2, 3], [2, 3], [2, 7], [-2, 7]]] })).toContain('Kesit boşlukları 1 ve 2');
    project([{ op: 'create', shape: 'extrude', name: 'ex', position: at0, geom: { kind: 'extrude', axis: 'z', profile: outer, holes: [[[-5, 0], [5, 0], [5, 8], [-5, 8]]] } }]);
  });

  it("yol noktasındaki 4. değer 0 = bend (yok gibi); yalnızca > 0 bend'i ezer; sanitize 0'ı atar", () => {
    const g = sanitizeGeom('sweep', { kind: 'sweep', path: [[0, 0, 0], [40, 0, 0, 0], [40, 40, 0, 0], [0, 40, 0, 0]], bend: 10, diameter: 6 });
    expect(g).toEqual({ kind: 'sweep', path: [[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0]], bend: 10, diameter: 6 });
    const zero = local({ path: [[0, 0, 0], [40, 0, 0, 0], [40, 40, 0], [0, 40, 0]], bend: 10, diameter: 6 });
    const none = local({ path: [[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0]], bend: 10, diameter: 6 });
    expect(zero.vol).toBe(none.vol);
    expect(zero.tris).toBe(none.tris);
    expect(local({ path: [[0, 0, 0], [40, 0, 0, 15], [40, 40, 0], [0, 40, 0]], bend: 10, diameter: 6 }).vol).not.toBeCloseTo(none.vol, 3);
  });
});
