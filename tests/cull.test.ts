// Gizli iç yüz ayıklama (`cullHidden`, Boltrush isteği #18): GLB'de başka bir katının içinde ya da ona değen yüzlerdeki
// üçgenler atılır; yapı (düğüm, grup, iskelet) aynı kalır; STL/3MF/OBJ'de seçenek hata; `check --profile game` sayısını bildirir.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Op } from '../shared/ops';
import { checkProject } from '../src/check';
import { initCsg } from '../src/csg';
import { cullAndRepair, hiddenTriangles } from '../src/cull';
import { applyOps } from '../src/engine';
import { exportFile } from '../src/files';
import { buildGlb, glbBuild } from '../src/gltf';
import { projectToJson, worldMesh } from '../src/io';
import { displayOpacity } from '../src/model';
import { newProject, type Project } from '../src/types';

let dir: string;
beforeAll(async () => {
  await initCsg();
  dir = mkdtempSync(path.join(tmpdir(), 'p3d-cull-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function project(ops: Op[], seg = 24): Project {
  const p = newProject('ayıklama');
  p.settings.resolution = seg;
  const res = applyOps(p, ops, null);
  expect(res.errors).toEqual([]);
  return p;
}

type At = { x: number; y: number; z: number };
const at = (x: number, y: number, z: number): At => ({ x, y, z });
const box = (name: string, w: number, d: number, h: number, position: At, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'box',
  name,
  params: [
    { name: 'width', value: w },
    { name: 'depth', value: d },
    { name: 'height', value: h },
  ],
  position,
  ...extra,
});
const cyl = (name: string, dia: number, h: number, position: At): Op => ({
  op: 'create',
  shape: 'cylinder',
  name,
  params: [
    { name: 'diameter', value: dia },
    { name: 'height', value: h },
  ],
  position,
});
/** Boltrush lastik yığını (`tire_wall_a`): 8 kenarlı prizma, Ø600, 250 yüksek. */
const tire = (i: number, x = 0): Op => ({
  op: 'create',
  shape: 'prism',
  name: `lastik${i}`,
  params: [
    { name: 'sides', value: 8 },
    { name: 'diameter', value: 600 },
    { name: 'height', value: 250 },
  ],
  position: at(x, 0, 125 + 250 * i),
  color: i % 2 ? '#222222' : '#e0e0e0',
});
const stack = () => [0, 1, 2, 3].map((i) => tire(i));
/**
 * Boltrush karpuzu (istek #24): N loft dilimi, y ekseni, R 150, konum (150, 0, 150); kesitler kutuplarda tek nokta, aradaki
 * 5 halkada [eksen, φ0, φ1] üçgeni.
 */
const gores = (N: number, extra: Record<number, Partial<Extract<Op, { op: 'create' }>>> = {}): Op[] =>
  Array.from({ length: N }, (_, g) => {
    const [a0, a1] = [(g / N) * 2 * Math.PI, ((g + 1) / N) * 2 * Math.PI];
    const rings = [30, 60, 90, 120, 150].map((d) => {
      const th = (d * Math.PI) / 180;
      const rho = 150 * Math.sin(th);
      return { at: -150 * Math.cos(th), points: [[0, 0], [rho * Math.cos(a0), rho * Math.sin(a0)], [rho * Math.cos(a1), rho * Math.sin(a1)]] as [number, number][] };
    });
    return {
      op: 'create',
      shape: 'loft',
      name: `dilim${g}`,
      position: at(150, 0, 150),
      geom: { kind: 'loft', axis: 'y', sections: [{ at: -150, points: [[0, 0]] }, ...rings, { at: 150, points: [[0, 0]] }] },
      ...extra[g],
    } as Op;
  });

/** GLB JSON bölümü ve mesh başına üçgen sayısı (indis erişimcisi / 3). */
function glbJson(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + dv.getUint32(12, true))));
  const tris = (m: { primitives: { indices: number }[] }) => m.primitives.reduce((s, p) => s + json.accessors[p.indices].count / 3, 0);
  return { json, trisByMesh: Object.fromEntries(json.meshes.map((m: { name: string; primitives: { indices: number }[] }) => [m.name, tris(m)])) as Record<string, number> };
}

/** Parça başına gizli üçgen sayısı (worldMesh üzerinden; check ile aynı girdi; saydam parça örtmez). */
function hiddenByPart(p: Project): Record<string, number> {
  const parts = p.parts.filter((x) => x.visible && !x.role);
  const h = hiddenTriangles(parts.map((x) => ({ ...worldMesh(p, x), occluder: displayOpacity(x) >= 1 })));
  return Object.fromEntries(parts.map((x, k) => [x.name, h[k].reduce((s, v) => s + v, 0)]));
}

describe('gizli iç yüz ayıklama', () => {
  it('4 yığılı prizma (8 kenar): 112 → 76 üçgen, 6 iç kapak (36 üçgen) atılır', () => {
    const p = project(stack());
    const plain = glbBuild(p);
    const culled = glbBuild(p, { cullHidden: true });
    expect([plain.triangles, plain.culled]).toEqual([112, 0]);
    expect([culled.triangles, culled.culled]).toEqual([76, 36]);
    // Uçtaki lastikler bir kapak (6 üçgen), ortadakiler iki kapak kaybeder.
    expect(glbJson(culled.data).trisByMesh).toEqual({ lastik0: 22, lastik1: 16, lastik2: 16, lastik3: 22 });
    expect(hiddenByPart(p)).toEqual({ lastik0: 6, lastik1: 12, lastik2: 12, lastik3: 6 });
    // Atılanlar tam olarak iç kapaklar: gizli üçgenlerin hepsi yatay ve iç kapak yüksekliklerinde (250 / 500 / 750 mm).
    const parts = p.parts;
    const hidden = hiddenTriangles(parts.map((x) => worldMesh(p, x)));
    const zs = new Set<number>();
    parts.forEach((x, k) => {
      const m = worldMesh(p, x);
      hidden[k].forEach((h, t) => {
        if (!h) return;
        const z = [0, 1, 2].map((j) => m.pos[m.tris[3 * t + j] * 3 + 2]);
        expect(Math.max(...z) - Math.min(...z)).toBeLessThan(1e-6);
        zs.add(Math.round(z[0]));
      });
    });
    expect([...zs].sort((a, b) => a - b)).toEqual([250, 500, 750]);
  });

  it('büyük kutu üstünde küçük kutu: küçüğün altı atılır, büyüğün üstü kalır (kısmen örtülü)', () => {
    const p = project([box('taban', 100, 80, 10, at(0, 0, 5)), box('üst', 30, 20, 8, at(10, 5, 14))]);
    expect(hiddenByPart(p)).toEqual({ taban: 0, üst: 2 });
    const g = glbJson(buildGlb(p, { cullHidden: true }));
    expect(g.trisByMesh).toEqual({ taban: 12, üst: 10 });
  });

  it('gömülü pim: gövdedeki kapak atılır; tamamen gömülü parçanın düğümü ağsız kalır', () => {
    // Yarısı gömülü pim: alt kapağı gövdenin içinde (atılır); yan dörtgenler yüzeyden çıktığı için kısmen örtülü (kalır).
    const p = project([box('gövde', 40, 40, 20, at(0, 0, 10)), cyl('pim', 6, 20, at(0, 0, 20)), cyl('gizli', 4, 6, at(12, 12, 10))], 12);
    // Silindir 12 segmentte 48 üçgen: kapaklar 12'şer (merkez yelpazesi), yan 24.
    expect(hiddenByPart(p)).toEqual({ gövde: 0, pim: 12, gizli: 48 });
    const g = glbJson(buildGlb(p, { cullHidden: true }));
    expect(g.trisByMesh).toEqual({ gövde: 12, pim: 48 - 12 });
    // Düğüm yerinde (ad, çeviri), ağı yok: yapı değişmez.
    const node = g.json.nodes.find((n: { name: string }) => n.name === 'gizli');
    expect(node).toEqual({ name: 'gizli', translation: [0.012, 0.01, -0.012] });
    expect(g.json.scenes[0].nodes).toHaveLength(3);
  });

  it('ayrık parçalarda hiçbir şey atılmaz; çıktı bayt bayt aynı', () => {
    const p = project([...[0, 1].map((i) => tire(i, i * 1000)), box('kutu', 50, 50, 50, at(0, 2000, 25)), cyl('mil', 20, 40, at(-2000, 0, 20))]);
    expect(Object.values(hiddenByPart(p)).every((n) => n === 0)).toBe(true);
    const plain = buildGlb(p);
    expect(buildGlb(p, { cullHidden: true })).toEqual(plain);
    expect(buildGlb(p, { cullHidden: false })).toEqual(plain);
    expect(buildGlb(p, { skeleton: true, cullHidden: true })).toEqual(buildGlb(p, { skeleton: true }));
  });

  it('kısmen örtülen yüz kalır: kenardan taşan kutunun altı, aynı yüzü paylaşan eş kutular', () => {
    // Küçük kutu tabanın kenarından yarı taşıyor: alt yüz üçgenlerinin köşeleri havada → kalır.
    const p = project([box('taban', 20, 20, 10, at(0, 0, 5)), box('taşan', 10, 10, 4, at(10, 0, 12))]);
    expect(hiddenByPart(p)).toEqual({ taban: 0, taşan: 0 });
    // Aynı yerde iki eş kutu (z-fighting): itilen noktalar komşunun yüzeyinden ε uzakta → hiçbiri atılmaz.
    const q = project([box('a', 10, 10, 10, at(0, 0, 5)), box('b', 10, 10, 10, at(0, 0, 5))]);
    expect(hiddenByPart(q)).toEqual({ a: 0, b: 0 });
    // Yan yana, aynı kesitli iki kutu: değen yüzler (2 + 2) atılır, değmeyen yanlar kalır.
    const r = project([box('sol', 10, 10, 10, at(-5, 0, 5)), box('sağ', 10, 10, 10, at(5, 0, 5))]);
    expect(hiddenByPart(r)).toEqual({ sol: 2, sağ: 2 });
  });

  it('saydam parça örtmez: cam kutunun içindeki kutu kalır; camın kendi yüzü opak bir örtücüyle atılır', () => {
    const p = project([
      box('zemin', 100, 100, 10, at(0, 0, -5)),
      box('koltuk', 20, 20, 20, at(0, 0, 10)),
      box('cam', 60, 60, 60, at(0, 0, 30), { opacity: 0.3 }),
    ]);
    // Cam (görünen saydamlık < 1) örtücü değil: koltuğun hiçbir üçgeni atılmaz. Koltuğun altı ve camın altı opak zemine değer.
    expect(hiddenByPart(p)).toEqual({ zemin: 0, koltuk: 2, cam: 2 });
    const r = glbBuild(p, { cullHidden: true });
    expect(glbJson(r.data).trisByMesh).toEqual({ zemin: 12, koltuk: 10, cam: 10 });
    // Referans parçanın görünen saydamlığı rol varsayılanıdır; opak yapılmış katı (opacity 1) örter.
    const q = project([box('iç', 20, 20, 20, at(0, 0, 30)), box('kabuk', 60, 60, 60, at(0, 0, 30), { opacity: 1 })]);
    expect(hiddenByPart(q)).toEqual({ iç: 12, kabuk: 0 });
  });

  it('kesin içerik testi: örnek noktaların arasından görünen küçük açıklığın üstündeki büyük üçgen kalır', () => {
    // 100 × 100 plaka, (30, −10)'da Ø10 delik, üstünde kapak: kapağın alt yüzü delikten görünür (iki iri üçgen).
    const p = project([
      box('plaka', 100, 100, 10, at(0, 0, 5)),
      { op: 'create', shape: 'cylinder', name: 'delik', role: 'hole', cuts: ['plaka'], params: [{ name: 'diameter', value: 10 }, { name: 'height', value: 20 }], position: at(30, -10, 5) },
      box('kapak', 100, 100, 2, at(0, 0, 11)),
    ]);
    const h = hiddenByPart(p);
    const [hidPlate, hidLid] = hiddenTriangles(p.parts.filter((x) => !x.role).map((x) => worldMesh(p, x)));
    // Plakanın üst yüzü (deliğin çevresi dahil) tümüyle kapağın altında: hepsi atılır.
    const m = worldMesh(p, p.parts[0]);
    let top = 0;
    for (let t = 0; t < m.tris.length / 3; t++) {
      const z = [0, 1, 2].map((j) => m.pos[m.tris[3 * t + j] * 3 + 2]);
      if (z.every((v) => Math.abs(v - 10) < 1e-6)) {
        top++;
        expect(hidPlate[t], `üst üçgen ${t}`).toBe(1);
      }
    }
    expect(top).toBeGreaterThan(2);
    expect(h.plaka).toBe(top);
    // Kapağın alt yüzü (z = 10) iki iri üçgen: deliğin (30, −10) üstündeki kalır, öbürü gerçekten gizli.
    const lid = worldMesh(p, p.parts[2]);
    const inTri = (t: number, x: number, y: number) => {
      const v = [0, 1, 2].map((j) => [lid.pos[lid.tris[3 * t + j] * 3], lid.pos[lid.tris[3 * t + j] * 3 + 1]]);
      const s = [0, 1, 2].map((j) => {
        const [a, b] = [v[j], v[(j + 1) % 3]];
        return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
      });
      return s.every((q) => q >= 0) || s.every((q) => q <= 0);
    };
    const bottom = [...Array(lid.tris.length / 3).keys()].filter((t) => [0, 1, 2].every((j) => Math.abs(lid.pos[lid.tris[3 * t + j] * 3 + 2] - 10) < 1e-6));
    expect(bottom).toHaveLength(2);
    for (const t of bottom) expect(hidLid[t], `kapak alt üçgeni ${t}`).toBe(inTri(t, 30, -10) ? 0 : 1);
    expect(h.kapak).toBe(1);
  });

  it('büyük koordinat ve ölçek (oyun pisti, 150 m): ε ölçekle büyür, yine yalnız iç kapaklar atılır', () => {
    const p = project([0, 1, 2, 3].map((i) => tire(i, 74_000)));
    expect(hiddenByPart(p)).toEqual({ lastik0: 6, lastik1: 12, lastik2: 12, lastik3: 6 });
  });

  it('değme kuralı (Boltrush #24): eksende buluşan karpuz dilimlerinin ortak yüzleri kalınlıktan bağımsız atılır', () => {
    // Boltrush yeniden üretimi: N loft dilimi (y ekseni, R 150, uçlarda tek noktalı kutup, 5 halka); dilim 30° (N 12) ya da 7,5°
    // (N 48). Dilim başına 30 üçgen: 10 dış kabuk + iki yan yüzde 10'ar (komşu dilimle aynı köşeler, farklı köşegen, ters normal).
    for (const N of [12, 48]) {
      const p = project(gores(N));
      const r = glbBuild(p, { cullHidden: true });
      expect([r.triangles, r.culled]).toEqual([10 * N, 20 * N]);
      expect(Object.values(hiddenByPart(p)).every((n) => n === 20)).toBe(true);
    }
    // Kalanlar yalnızca dış kabuk: hiçbir kalan üçgen eksenden geçen bir düzlemde (yan yüz) değil.
    const p = project(gores(12));
    const hidden = hiddenTriangles(p.parts.map((x) => worldMesh(p, x)));
    p.parts.forEach((x, k) => {
      const m = worldMesh(p, x);
      hidden[k].forEach((h, t) => {
        const v = [0, 1, 2].map((j) => [0, 1, 2].map((c) => m.pos[m.tris[3 * t + j] * 3 + c] - [150, 0, 150][c]));
        // Yan yüz eksen (y) üzerinden geçer: normali y'ye dik ve düzlemi eksenden geçer → (v0 × v1) · eksen noktası = 0.
        const [a, b, c] = v;
        const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
        const side = Math.abs(n[1]) < 1e-6 * Math.hypot(...n) && Math.abs(n[0] * a[0] + n[2] * a[2]) < 1e-3 * Math.hypot(...n);
        expect(h, `${x.name} üçgen ${t}`).toBe(side ? 1 : 0);
      });
    });
  });

  it('değme kuralı: saydam dilim örtmez (komşuların ona bakan yüzü kalır), kendi yüzleri atılır; iki örtücü birlikte örter', () => {
    const p = project(gores(12, { 0: { opacity: 0.5 } }));
    const h = hiddenByPart(p);
    expect([h.dilim0, h.dilim1, h.dilim11, h.dilim5]).toEqual([20, 10, 10, 20]);
    // Tabanın üstünü yan yana iki kutu birlikte, tam kaplar (köşegen ikisinin sınırını keser): taban üstü de atılır.
    const q = project([box('taban', 20, 10, 5, at(0, 0, 2.5)), box('sol', 10, 10, 5, at(-5, 0, 7.5)), box('sağ', 10, 10, 5, at(5, 0, 7.5))]);
    expect(hiddenByPart(q)).toEqual({ taban: 2, sol: 4, sağ: 4 });
    // Bir kutu eksik: taban üstü yarı açık → kalır.
    const r = project([box('taban', 20, 10, 5, at(0, 0, 2.5)), box('sol', 10, 10, 5, at(-5, 0, 7.5))]);
    expect(hiddenByPart(r)).toEqual({ taban: 0, sol: 2 });
  });

  it('değme kuralı: örtücünün içi yüz başına bulunur (yönü karışık kabuklu ağ aynı yöne bakan yüzü örtmez; ters çevrilmiş ağ örter)', () => {
    // Eksene hizalı kutu ağı (12 üçgen, normaller dışa; `flip` ters sarım).
    const boxMesh = (lo: number[], hi: number[], flip = false, base = 0) => {
      const pos = [0, 1, 2, 3, 4, 5, 6, 7].flatMap((k) => [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]]);
      const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
      const tris = quads.flatMap(([a, b, c, d]) => (flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d]).map((v) => v + base));
      return { pos, tris };
    };
    const join = (...m: { pos: number[]; tris: number[] }[]) => {
      let n = 0;
      const out = { pos: [] as number[], tris: [] as number[] };
      for (const x of m) {
        out.pos.push(...x.pos);
        out.tris.push(...x.tris.map((v) => v + n));
        n += x.pos.length / 3;
      }
      return out;
    };
    const A = boxMesh([0, 0, 0], [10, 10, 20]);
    // B: A'nın üst yarısında dışa bakan kabuk + uzakta içe bakan büyük kabuk (net hacim negatif). B'nin üst yüzü A'nınkiyle aynı
    // yöne bakar: A'nın üstü görünür kalmalı. B'nin altı A'nın içinde (itme testi atar).
    const B = join(boxMesh([0, 0, 10], [10, 10, 20]), boxMesh([100, 100, 100], [200, 200, 200], true));
    const [hA, hB] = hiddenTriangles([A, B]);
    const top = (m: { pos: number[]; tris: number[] }, h: Uint8Array) =>
      [...h].filter((_, t) => [0, 1, 2].every((j) => m.pos[m.tris[3 * t + j] * 3 + 2] === 20)).reduce((s, v) => s + v, 0);
    expect(top(A, hA)).toBe(0);
    expect(top(B, hB)).toBe(0);
    // Tümüyle ters çevrilmiş komşu (normaller içe): ortak yüzde içi yine A'nın üst yüzünün önünde → atılır.
    const C = boxMesh([0, 0, 20], [10, 10, 30], true);
    expect(top(A, hiddenTriangles([A, C])[0])).toBe(2);
  });

  it('gruplu ve iskeletli GLB: düğümler, gruplar, pivot, eklemler aynı; yalnızca üçgenler azalır', () => {
    const p = project([
      ...stack(),
      { op: 'group', name: 'yığın', parts: ['lastik0', 'lastik1', 'lastik2', 'lastik3'], pivot: at(0, 0, 0) },
      box('tabela', 400, 20, 300, at(1000, 0, 150)),
    ]);
    for (const skeleton of [false, true]) {
      const a = glbJson(buildGlb(p, { skeleton }));
      const b = glbJson(buildGlb(p, { skeleton, cullHidden: true }));
      expect(b.json.nodes).toEqual(a.json.nodes);
      expect(b.json.scenes).toEqual(a.json.scenes);
      expect(b.json.skins).toEqual(a.json.skins);
      expect(b.json.materials).toEqual(a.json.materials);
      expect(b.json.meshes.map((m: { name: string; primitives: unknown[] }) => [m.name, m.primitives.length])).toEqual(
        a.json.meshes.map((m: { name: string; primitives: unknown[] }) => [m.name, m.primitives.length]),
      );
      const total = (g: typeof a) => Object.values(g.trisByMesh).reduce((s, n) => s + n, 0);
      expect(total(a) - total(b)).toBe(36);
    }
  });

  it('STL / 3MF / OBJ: seçenek hata verir (baskı kapalı ağ ister); GLB dosyası ve sonuç özeti', async () => {
    const p = project(stack());
    await expect(exportFile(p, path.join(dir, 'y.stl'), { cullHidden: true })).rejects.toThrow('STL: baskı için kapalı ağ gerekir; cull-hidden yalnızca GLB için.');
    await expect(exportFile(p, path.join(dir, 'y.3mf'), { cullHidden: true })).rejects.toThrow('3MF: baskı için kapalı ağ gerekir; cull-hidden yalnızca GLB için.');
    await expect(exportFile(p, path.join(dir, 'y.obj'), { cullHidden: true })).rejects.toThrow('cull-hidden yalnızca GLB için.');
    const r = await exportFile(p, path.join(dir, 'y.glb'), { cullHidden: true });
    expect([r.culled, r.triangles, r.parts]).toEqual([36, 76, 4]);
    // Seçenek yokken sonuç biçimi değişmez (özet alanları yok).
    const plain = await exportFile(p, path.join(dir, 'z.glb'));
    expect(Object.keys(plain).sort()).toEqual(['bytes', 'file', 'format', 'parts']);
  });

  it('check --profile game: gizli üçgen ayrı bildirilmez; bütçe aşılınca mesajda söylenir, cullHidden bütçeyi ayıklanmış sayar', () => {
    const p = project(stack());
    // Bütçe aşılmıyorsa temiz (yığılı model "check temiz" kuralına ulaşabilsin).
    expect(checkProject(p, { profile: 'game' })).toEqual([]);
    expect(checkProject(p, { profile: 'game', cullHidden: true })).toEqual([]);
    // 112 > 100: bütçe uyarısı atılabilecek gizli üçgenleri söyler; ayıklanmış sayı (76) bütçeye sığar.
    const over = checkProject(p, { profile: 'game', maxTris: 100 });
    expect(over).toHaveLength(1);
    expect(over[0].message).toMatch(/^Toplam 112 üçgen; bütçe 100 aşıldı\./);
    expect(over[0].message).toContain(' 36 üçgen görünmez; `export --cull-hidden` ile atılır (`check --cull-hidden` bütçeyi ona göre sayar).');
    expect(checkProject(p, { profile: 'game', maxTris: 100, cullHidden: true })).toEqual([]);
    // Ayıklanmış sayı da aşarsa mesaj onu söyler; gizli üçgen önerisi tekrarlanmaz.
    const still = checkProject(p, { profile: 'game', maxTris: 50, cullHidden: true });
    expect(still[0].message).toMatch(/^Toplam 76 üçgen \(36 gizli üçgen atıldıktan sonra\); bütçe 50 aşıldı\. Parça başına: lastik0 22, lastik3 22, lastik1 16, lastik2 16\./);
    expect(still[0].message).not.toContain('üçgen görünmez');
    // Gizli üçgeni olmayan model: bütçe mesajında öneri yok.
    const q = project([tire(0), tire(1, 1000)]);
    expect(checkProject(q, { profile: 'game', maxTris: 10 })[0].message).not.toContain('görünmez');
    expect(checkProject(p, { cullHidden: true })).toEqual(checkProject(p)); // print profilinde etkisiz
  });

  it('CLI: export --cull-hidden özet satırı; STL ile hata; check --cull-hidden', () => {
    const file = path.join(dir, 'yigin.p3d.json');
    writeFileSync(file, projectToJson(project(stack())));
    const bin = fileURLToPath(new URL('../bin/p3d.mjs', import.meta.url));
    const run = (args: string[]) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' });
    const ok = run(['export', 'yigin.glb', '--file', 'yigin.p3d.json', '--cull-hidden']);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/✓ 4 parça → .*yigin\.glb \(GLB, [\d,]+ kB; 36 gizli üçgen atıldı, 76 üçgen kaldı\)/);
    const bad = run(['export', 'yigin.stl', '--file', 'yigin.p3d.json', '--cull-hidden']);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('STL: baskı için kapalı ağ gerekir; cull-hidden yalnızca GLB için.');
    const over = run(['check', '--file', 'yigin.p3d.json', '--profile', 'game', '--max-tris', '100']);
    expect(over.stdout).toContain('36 üçgen görünmez; `export --cull-hidden` ile atılır');
    const culled = run(['check', '--file', 'yigin.p3d.json', '--profile', 'game', '--max-tris', '100', '--cull-hidden']);
    expect(culled.stdout).toContain('profil game (bütçe 100 üçgen, gizli üçgenler atılmış)');
    expect(culled.stdout).toContain('✓ Sorun bulunmadı.');
    const print = run(['check', '--file', 'yigin.p3d.json', '--cull-hidden']);
    expect(print.status).not.toBe(0);
    expect(print.stderr).toContain('--cull-hidden yalnızca --profile game ile kullanılır');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T-kavşağı onarımı (Boltrush isteği #21): ayıklanan yüz birleşim çizgisinin arkasındaki kıl payı açıklığı kapatıyordu.

/**
 * T-kavşakları: bir köşenin (konum olarak) başka bir kenarın iç noktası olduğu (köşe, kenar) çiftleri. `all` hepsi; `cracks`
 * yalnızca çatlak yapanlar — köşenin bir kenarı da o kenarla aynı doğru üzerinde (iki yüzey o doğru boyunca birleşiyor; köşesi
 * bir yüzün köşegenine düşen kutu gibi durumlar çatlak yapmaz: o yüz su geçirmez) ve köşe `focus` noktalarından biri, yani arkasındaki
 * yüz atılmış bir köşe (arkası kapalı T-kavşağı görünmez; ayıklamasız ağda da vardır). Üçgen listesi düz konumlardır (üçgen başına 9
 * sayı); tolerans konum biriminde.
 */
function tJunctions(soup: number[], tol: number, focus: number[][]): { all: number; cracks: number } {
  const key = (i: number) => `${soup[i].toFixed(6)},${soup[i + 1].toFixed(6)},${soup[i + 2].toFixed(6)}`;
  const verts = new Map<string, { p: number[]; nbrs: number[][] }>();
  const edges = new Map<string, [number[], number[]]>();
  for (let t = 0; t < soup.length; t += 9) {
    for (let k = 0; k < 3; k++) {
      const [a, b, c] = [t + 3 * k, t + 3 * ((k + 1) % 3), t + 3 * ((k + 2) % 3)];
      const v = verts.get(key(a)) ?? verts.set(key(a), { p: soup.slice(a, a + 3), nbrs: [] }).get(key(a))!;
      v.nbrs.push(soup.slice(b, b + 3), soup.slice(c, c + 3));
      const [ka, kb] = [key(a), key(b)].sort();
      edges.set(`${ka}|${kb}`, [soup.slice(a, a + 3), soup.slice(b, b + 3)]);
    }
  }
  const offLine = (x: number[], u: number[], d: number[], L2: number) => {
    const q = [x[0] - u[0], x[1] - u[1], x[2] - u[2]];
    const s = (q[0] * d[0] + q[1] * d[1] + q[2] * d[2]) / L2;
    return { s, q, dist: Math.hypot(q[0] - s * d[0], q[1] - s * d[1], q[2] - s * d[2]) };
  };
  let all = 0;
  let cracks = 0;
  for (const [u, v] of edges.values()) {
    const d = [v[0] - u[0], v[1] - u[1], v[2] - u[2]];
    const L2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    for (const { p, nbrs } of verts.values()) {
      const { s, q, dist } = offLine(p, u, d, L2);
      if (!(s > 0 && s < 1)) continue;
      if (Math.hypot(...q) <= tol || Math.hypot(q[0] - d[0], q[1] - d[1], q[2] - d[2]) <= tol) continue;
      if (dist > tol) continue;
      all++;
      if (focus.some((f) => Math.hypot(f[0] - p[0], f[1] - p[1], f[2] - p[2]) <= tol) && nbrs.some((x) => offLine(x, u, d, L2).dist <= tol)) cracks++;
    }
  }
  return { all, cracks };
}

/**
 * Kalan üçgenler dünya koordinatında (mm) — ayıklama + onarım (check ile aynı girdi; net kayıp kuralı dahil) ya da yalnız
 * ayıklama — ve odak: atılan üçgenlerin köşeleri (mm; GLB için `glFocus`).
 */
function keptSoup(p: Project, repair: boolean): { soup: number[]; focus: number[][] } {
  const parts = p.parts.filter((x) => x.visible && !x.role);
  const meshes = parts.map((x) => ({ ...worldMesh(p, x), occluder: displayOpacity(x) >= 1 }));
  const soup: number[] = [];
  const focus: number[][] = [];
  const r = repair ? cullAndRepair(meshes) : undefined;
  const hidden = r ? r.hidden : hiddenTriangles(meshes);
  meshes.forEach((m, k) => {
    const at = (v: number, c: number) => (v < m.pos.length / 3 ? m.pos[3 * v + c] : r!.added[k][3 * (v - m.pos.length / 3) + c]);
    for (let t = 0; t < m.tris.length / 3; t++) {
      for (let j = 0; j < 3; j++) {
        const v = m.tris[3 * t + j];
        if (hidden[k][t]) focus.push([m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]]);
        else if (!r) soup.push(m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]);
      }
    }
    if (r) for (const v of r.tris[k]) soup.push(at(v, 0), at(v, 1), at(v, 2));
  });
  return { soup, focus };
}

/** Odak noktaları glTF koordinatında (metre, Y yukarı): GLB üçgenleriyle karşılaştırmak için. */
const glFocus = (focus: number[][]) => focus.map(([x, y, z]) => [x * 0.001, z * 0.001, -y * 0.001]);

/** GLB'deki üçgenler sahne koordinatında (düğüm çevirileri uygulanmış; P3D yalnızca çeviri yazar). */
function glbSoup(bytes: Uint8Array): number[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
  const bin = bytes.slice(28 + jsonLen).buffer;
  const read = (i: number) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const n = a.count * (a.type === 'VEC3' ? 3 : 1);
    const C = a.componentType === 5126 ? Float32Array : a.componentType === 5125 ? Uint32Array : Uint16Array;
    return Array.from(new C(bin, v.byteOffset, n));
  };
  const out: number[] = [];
  const walk = (ni: number, off: number[]) => {
    const node = json.nodes[ni];
    const t = node.translation ?? [0, 0, 0];
    const o = [off[0] + t[0], off[1] + t[1], off[2] + t[2]];
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        const pos = read(prim.attributes.POSITION);
        for (const i of read(prim.indices)) out.push(pos[3 * i] + o[0], pos[3 * i + 1] + o[1], pos[3 * i + 2] + o[2]);
      }
    }
    for (const c of node.children ?? []) walk(c, o);
  };
  for (const r of json.scenes[0].nodes) walk(r, [0, 0, 0]);
  return out;
}

describe('ayıklama sonrası T-kavşağı onarımı', () => {
  const P = (name: string, value: number) => ({ name, value }) as never;
  /** 16 kenarlı prizma, iki düz yanı (±Y) kutunun ön ve arka yüzüyle aynı düzlemde: alt kapak (14 üçgen) atılır, yanların alt
   * kenarları kutunun üst ön/arka kenarına T-kavşağıyla oturur (4 nokta × 2 üçgen = 8 bölme < 14: onarım kalır). */
  const flush: Op[] = [
    box('kutu', 100, Number((60 * Math.cos(Math.PI / 16)).toFixed(4)), 20, at(0, 0, 10)),
    { op: 'create', shape: 'prism', name: 'prizma', params: [P('sides', 16), P('diameter', 60), P('height', 30)], position: at(0, 0, 35) },
  ];
  /**
   * [ad, işlemler, atılan, eklenen, onarımsız ayıklamada çatlak var mı]. Net kayıp kuralı: iki kutu / ters / yan yana sahnelerinde
   * onarım (8 / 8 / 4) atılanı (2) aşar; atılanlar geri konur, çıktı seçeneksizle aynı.
   */
  const scenes: [string, Op[], number, number, boolean][] = [
    // Boltrush yeniden üretimi: uç yüzler aynı düzlemde, kalınlığı farklı üst üste iki kutu (üst dar)
    ['iki kutu', [box('alt', 2000, 430, 360, at(0, 0, 180)), box('ust', 2000, 396, 320, at(0, 0, 520))], 0, 0, true],
    // Ters: üst geniş, altın üst yüzü atılırdı
    ['ters', [box('alt', 2000, 396, 360, at(0, 0, 180)), box('ust', 2000, 430, 320, at(0, 0, 520))], 0, 0, true],
    // Yan yana, farklı kesit (alt yüzler aynı düzlemde)
    ['yan yana', [box('a', 100, 100, 100, at(-50, 0, 50)), box('b', 100, 60, 60, at(50, 0, 30))], 0, 0, true],
    ['prizma kutuda (yanlar aynı düzlemde)', flush, 14, 8, true],
    // Çerçeve + içine oturan ince levha: levhanın yanları atılır; köşeleri çerçevenin dikey iç köşe kenarına düşer ama levhanın o
    // doğruda kenarı kalmaz (çatlak yok, bölme yok)
    [
      'çerçeve + levha',
      [
        { op: 'create', shape: 'extrude', name: 'çerçeve', position: at(0, 0, 0), params: [P('height', 10)], geom: { kind: 'extrude', axis: 'z', profile: [[-50, -50], [50, -50], [50, 50], [-50, 50]], frame: 10 } },
        box('levha', 100, 100, 4, at(0, 0, 0)),
      ],
      8,
      0,
      false,
    ],
    // Plakada kutu: kutunun alt köşeleri plakanın üst yüz köşegenine düşer (çatlak değil, bölme yok)
    ['köşegen', [box('plaka', 100, 100, 10, at(0, 0, 5)), box('kutu', 20, 20, 20, at(10, 10, 20))], 2, 0, false],
  ];

  it.each(scenes)('%s: kalan yüzeyde çatlak yapan T-kavşağı yok (dünya, GLB düz/yumuşak, iskelet); sayılar', (_name, ops, culled, added, cracked) => {
    const p = project(ops);
    const raw = keptSoup(p, false);
    const before = tJunctions(raw.soup, 1e-4, raw.focus);
    expect(before.cracks > 0, 'onarımsız ayıklamada çatlak').toBe(cracked);
    const fixed = keptSoup(p, true);
    const after = tJunctions(fixed.soup, 1e-4, fixed.focus);
    expect(after.cracks, 'onarımlı (dünya)').toBe(0);
    // Yalnızca çatlak yapan T noktaları bölünür: atılan varsa kalan (çatlaksız) T-kavşakları dokunulmadan kalır.
    if (culled) expect(after.all).toBe(before.all - before.cracks);
    const plain = glbBuild(p);
    const focus = glFocus(fixed.focus);
    for (const normals of ['flat', 'smooth'] as const) {
      const r = glbBuild(p, { cullHidden: true, normals });
      expect([r.culled, r.added, r.triangles]).toEqual([culled, added, plain.triangles - culled + added]);
      // Net kayıp kuralı: ayıklama üçgen sayısını hiçbir sahnede artırmaz; hiç atılmazsa çıktı seçeneksizle bayt bayt aynı.
      expect(r.triangles).toBeLessThanOrEqual(plain.triangles);
      if (!culled) expect(r.data).toEqual(glbBuild(p, { normals }).data);
      expect(tJunctions(glbSoup(r.data), 1e-7, focus).cracks, `GLB ${normals}`).toBe(0);
    }
    // İskelet modunda da (köşeler dünya koordinatında, malzemeye göre birleşmiş)
    expect(tJunctions(glbSoup(buildGlb(p, { cullHidden: true, skeleton: true })), 1e-7, focus).cracks).toBe(0);
    // check --cull-hidden bütçesi GLB ile aynı sayıyı kullanır
    const msg = checkProject(p, { profile: 'game', cullHidden: true, maxTris: 1 })[0].message;
    const note = added ? `${culled} gizli üçgen atıldıktan, T-kavşağı onarımı ${added} üçgen ekledikten sonra` : `${culled} gizli üçgen atıldıktan sonra`;
    expect(msg).toContain(`Toplam ${plain.triangles - culled + added} üçgen (${note})`);
  });

  it('net kayıp kuralı: onarımı atılanı aşan parçanın atılanları geri konur; geri konan yüz çatlağı kapatır', () => {
    // İki kutu: üst kutunun atılan alt yüzü (2) 8 bölme doğururdu → geri konur, hiçbir şey atılmaz.
    const p = project(scenes[0][1]);
    const meshes = p.parts.map((x) => worldMesh(p, x));
    expect(hiddenTriangles(meshes).map((h) => h.reduce((s, v) => s + v, 0))).toEqual([0, 2]);
    const r0 = cullAndRepair(meshes);
    expect({ ...r0, hidden: r0.hidden.map((h) => h.reduce((s, v) => s + v, 0)) }).toEqual({ tris: meshes.map((m) => m.tris), added: [[], []], culled: [0, 0], split: [0, 0], hidden: [0, 0] });
    // Karışık sahne: kârlı parça ayıklanır, kârsız olan geri konur; toplam azalır, çatlak yok.
    const q = project([
      ...flush,
      box('alt2', 2000, 430, 360, at(5000, 0, 180)),
      box('ust2', 2000, 396, 320, at(5000, 0, 520)),
    ]);
    const plain = glbBuild(q);
    const r = glbBuild(q, { cullHidden: true });
    expect([r.culled, r.added, r.triangles]).toEqual([14, 8, plain.triangles - 6]);
    const fq = keptSoup(q, true);
    expect(tJunctions(fq.soup, 1e-4, fq.focus).cracks).toBe(0);
  });

  it('eklenen köşe öbür parçanın köşesiyle bit bit aynı; bölünen üçgenler yüzlerinin normalini korur; GLB yapısı aynı', () => {
    const p = project(flush);
    const [alt, ust] = p.parts.map((x) => worldMesh(p, x));
    const r = cullAndRepair([alt, ust]);
    expect([r.culled, r.split]).toEqual([[0, 14], [8, 0]]);
    // Kutuya eklenen 4 köşe, prizmanın alt köşelerinin float32 değerleri
    const ustVerts = new Set<string>();
    for (let i = 0; i < ust.pos.length; i += 3) ustVerts.add(`${ust.pos[i]},${ust.pos[i + 1]},${ust.pos[i + 2]}`);
    const extra = r.added[0];
    expect(extra).toHaveLength(12);
    for (let i = 0; i < extra.length; i += 3) expect(ustVerts.has(`${extra[i]},${extra[i + 1]},${extra[i + 2]}`)).toBe(true);
    // Kutunun her üçgeni (bölünenler dahil) eksen yönlü, dışa bakan bir normal taşır
    const at3 = (v: number) => (v < alt.pos.length / 3 ? [...alt.pos.slice(3 * v, 3 * v + 3)] : extra.slice(3 * (v - alt.pos.length / 3), 3 * (v - alt.pos.length / 3) + 3));
    const t = r.tris[0];
    expect(t).toHaveLength(3 * (12 + 8));
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [at3(t[i]), at3(t[i + 1]), at3(t[i + 2])];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const l = Math.hypot(...n);
      expect(l).toBeGreaterThan(0);
      expect(Math.max(...n.map((x) => Math.abs(x) / l))).toBeCloseTo(1, 9);
      const g = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3 - 10];
      expect(n[0] * g[0] + n[1] * g[1] + n[2] * g[2]).toBeGreaterThan(0);
    }
    // GLB: düğümler ve malzemeler aynı; yalnızca üçgenler değişir
    const plain = glbJson(buildGlb(p)).json;
    const culled = glbJson(buildGlb(p, { cullHidden: true })).json;
    expect(culled.nodes).toEqual(plain.nodes);
    expect(culled.materials).toEqual(plain.materials);
  });

  it('4 prizma: onarım üçgen eklemez (eş kesit: köşeler eşleşir)', () => {
    const p = project(stack());
    const r = glbBuild(p, { cullHidden: true });
    expect([r.culled, r.added, r.triangles]).toEqual([36, 0, 76]);
    const fp = keptSoup(p, true);
    expect(tJunctions(fp.soup, 1e-4, fp.focus).cracks).toBe(0);
  });
});
