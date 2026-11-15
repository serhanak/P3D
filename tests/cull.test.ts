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
import { hiddenTriangles } from '../src/cull';
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
