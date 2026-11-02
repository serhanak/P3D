// Kararlı kütüphane yüzeyi (src/api.ts) ve Node dosya yardımcıları (src/files.ts): sözleşme testi. Buradaki adlar
// tüketicilerin (`import … from 'p3d'`) dayandığı yüzeydir; bir ad kaldırılırsa bu test kırılmalı.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api';
import { fileStamp, projectFileText, writeFileAtomic } from '../src/files';
import { guideText, installSkill } from '../scripts/guide';

let dir: string;

/** 10 mm küp (OBJ, dışa bakan yüzler), köşesi orijinde. */
const CUBE_OBJ = [
  ...[[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]].map((v) => `v ${v.join(' ')}`),
  'f 1 3 2', 'f 1 4 3', 'f 5 6 7', 'f 5 7 8', 'f 1 2 6', 'f 1 6 5',
  'f 2 3 7', 'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8',
].join('\n');

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'p3d-api-'));
  await api.initCsg();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('src/api.ts yüzeyi', () => {
  it('sözleşmedeki tüm fonksiyonlar ve THREE dışa aktarılır', () => {
    const fns = [
      'newProject', 'applyOps', 'partBox', 'partMatrix', 'partsBox', 'initCsg', 'manifoldVolume', 'subtract', 'checkProject',
      'mergedMesh', 'projectToJson', 'parseProject', 'buildStl', 'meshAssetFromSoup', 'parseMeshFile', 'baseIndexed',
      'exportGeometry', 'exportableParts', 'roleOf', 'solidVolume', 'registerAsset', 'decodedAsset', 'worldMesh', 'sliceMany',
      'buildGlb', 'loadProjectFile', 'saveProjectFile', 'exportFile', 'sceneSummary', 'build3mf', 'getAsset', 'usedAssets',
      'readMeshFile',
    ];
    for (const f of fns) expect(typeof (api as Record<string, unknown>)[f], f).toBe('function');
    expect(new api.THREE.Vector3(3, 4, 0).length()).toBe(5);
    expect(api.SHAPES).toContain('box');
    expect(api.SHAPES).toContain('mesh');
  });

  it('package.json exports: "p3d" → src/api.ts', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.name).toBe('p3d');
    expect(pkg.exports).toEqual({ '.': './src/api.ts', './package.json': './package.json' });
  });

  it('kütüphaneyle uçtan uca: işlem → kontrol → hacim → dosya', async () => {
    const p = api.newProject('uc');
    const res = api.applyOps(
      p,
      [
        { op: 'create', shape: 'box', name: 'govde', params: [{ name: 'width', value: 20 }, { name: 'depth', value: 20 }, { name: 'height', value: 10 }] },
        { op: 'create', shape: 'cylinder', name: 'delik', role: 'hole', cuts: ['govde'], params: [{ name: 'diameter', value: 10 }, { name: 'height', value: 12 }], position: { x: 0, y: 0, z: 5 } },
      ],
      null,
    );
    expect(res.errors).toEqual([]);
    expect(api.checkProject(p).filter((i) => i.level === 'hata')).toEqual([]);
    const govde = p.parts.find((x) => x.name === 'govde')!;
    expect(api.solidVolume(p, govde)).toBeLessThan(20 * 20 * 10);
    const file = path.join(dir, 'uc.p3d.json');
    expect(api.saveProjectFile(p, file)).toMatchObject({ file, parts: 2, embedded: 0, referenced: 0, warnings: [] });
    const back = await api.loadProjectFile(file);
    expect(back).toEqual(p);
  });
});

describe('proje dosyası: loadProjectFile / saveProjectFile', () => {
  it('okunamayan parça: varsayılan hata (sessiz kayıp yok), dropped verilirse listelenip atlanır', async () => {
    const file = path.join(dir, 'garip.p3d.json');
    const p = api.newProject('garip');
    api.applyOps(p, [{ op: 'create', shape: 'box', name: 'saglam' }], null);
    writeFileSync(file, JSON.stringify({ ...p, parts: [...p.parts, { ...p.parts[0], id: 'p_x', name: 'garip', shape: 'yildiz' }] }));
    await expect(api.loadProjectFile(file)).rejects.toThrow("1 parça okunamadı:\n  - 'garip': bilinmeyen şekil 'yildiz'");
    const dropped: string[] = [];
    const back = await api.loadProjectFile(file, { dropped });
    expect(back.parts.map((x) => x.name)).toEqual(['saglam']);
    expect(dropped).toEqual(["'garip': bilinmeyen şekil 'yildiz'"]);
    await expect(api.loadProjectFile(path.join(dir, 'yok.p3d.json'))).rejects.toThrow('Dosya bulunamadı');
  });

  it('P3D dosyası olmayanın ve klasörün üzerine yazmaz', () => {
    const notes = path.join(dir, 'notlar.json');
    writeFileSync(notes, '{"x":1}');
    expect(() => api.saveProjectFile(api.newProject(), notes)).toThrow('bir P3D proje dosyası değil');
    expect(readFileSync(notes, 'utf8')).toBe('{"x":1}');
    expect(() => api.saveProjectFile(api.newProject(), path.join(dir, 'yok', 'm.p3d.json'))).toThrow('Klasör bulunamadı');
  });

  it('overwrite: false mevcut dosyanın üzerine yazmaz; yoksa yazar', () => {
    const file = path.join(dir, 'korunan.p3d.json');
    const p = api.newProject('ilk');
    api.saveProjectFile(p, file, { overwrite: false });
    const before = readFileSync(file, 'utf8');
    expect(() => api.saveProjectFile(api.newProject('ikinci'), file, { overwrite: false })).toThrow(`${file} zaten var; üzerine yazılmadı`);
    expect(readFileSync(file, 'utf8')).toBe(before);
    api.saveProjectFile(api.newProject('ikinci'), file);
    expect(JSON.parse(readFileSync(file, 'utf8')).name).toBe('ikinci');
  });

  it('writeFileAtomic: yazılamazsa dosya yolunu içeren hata, geçici dosya kalmaz, hedef bozulmaz', () => {
    const sub = path.join(dir, 'atomik');
    mkdirSync(sub);
    // Hedef bir klasör: geçici dosya yazılır ama yeniden adlandırma başarısız olur.
    const target = path.join(sub, 'klasor.p3d.json');
    mkdirSync(target);
    expect(() => writeFileAtomic(target, 'x')).toThrow(`${target} yazılamadı:`);
    expect(readdirSync(sub)).toEqual(['klasor.p3d.json']);
    // Klasör yok: geçici dosya da yazılamaz.
    const nowhere = path.join(sub, 'yok', 'm.p3d.json');
    expect(() => writeFileAtomic(nowhere, 'x')).toThrow(`${nowhere} yazılamadı:`);
    expect(readdirSync(sub)).toEqual(['klasor.p3d.json']);
    // Başarılı yazma: yalnızca hedef kalır.
    writeFileAtomic(path.join(sub, 'tamam.txt'), 'merhaba');
    expect(readdirSync(sub).sort()).toEqual(['klasor.p3d.json', 'tamam.txt']);
    expect(readFileSync(path.join(sub, 'tamam.txt'), 'utf8')).toBe('merhaba');
  });

  it('parseProject mesh kaynak alanlarını korur; geçersiz maxTris / srcSize / srcHash atılır', () => {
    const mesh = (geom: Record<string, unknown>, name = 'ag') => ({
      id: `p_${name}`, name, shape: 'mesh', params: { scale: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      color: '#888888', visible: true, geom: { kind: 'mesh', asset: 'a_kaynak01', ...geom },
    });
    const ok = { src: '../ref/kup.obj', maxTris: 500, srcSize: 171, srcHash: '3cddc1fe606f0e36' };
    const raw = { ...api.newProject('k'), parts: [mesh(ok)] };
    expect(api.parseProject(raw).parts[0].geom).toEqual({ kind: 'mesh', asset: 'a_kaynak01', ...ok });
    for (const bad of [{ maxTris: '500' }, { maxTris: 2.5 }, { maxTris: 0 }, { maxTris: -3 }, { srcSize: -1 }, { srcSize: '171' }, { srcHash: 'xyz' }, { srcHash: 5 }]) {
      const g = api.parseProject({ ...api.newProject('k'), parts: [mesh(bad)] }).parts[0].geom;
      expect(g, JSON.stringify(bad)).toEqual({ kind: 'mesh', asset: 'a_kaynak01' });
    }
  });

  it('registerAsset kimlik verilirse varlığın kendi kimliği yerine onu kullanır', () => {
    const imp = api.registerAsset({ id: 'a_kendi', name: 'x', positions: btoa(String.fromCharCode(...new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer))), indices: btoa(String.fromCharCode(...new Uint8Array(new Uint32Array([0, 1, 2]).buffer))) }, 'a_verilen');
    expect(imp.id).toBe('a_verilen');
    expect(api.getAsset('a_verilen')?.triangles).toBe(1);
    expect(api.getAsset('a_kendi')).toBeUndefined();
  });
});

describe('referans ağlar yolla (mesh geom src)', () => {
  let ref: string;
  let model: string;
  let gomulu: string;
  let id: string;
  let asset: api.MeshAsset;
  /** İçe aktarmadaki kaynak damgası (boyut + özet). */
  let stamp: { srcSize: number; srcHash: string };

  beforeAll(async () => {
    mkdirSync(path.join(dir, 'ref'));
    mkdirSync(path.join(dir, 'model'));
    ref = path.join(dir, 'ref', 'kup.obj');
    writeFileSync(ref, CUBE_OBJ);
    const imp = await api.meshAssetFromSoup('kup', api.readMeshFile(ref), 500);
    asset = imp.asset;
    id = imp.asset.id;
    stamp = fileStamp(ref);
    expect(stamp).toEqual({ srcSize: Buffer.byteLength(CUBE_OBJ), srcHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    const p = api.newProject('ref');
    const res = api.applyOps(p, [{ op: 'import_mesh', asset: imp.asset, name: 'kup', role: 'reference', position: imp.center, src: ref, maxTris: 500, ...stamp }], null);
    expect(res.errors).toEqual([]);
    expect(p.parts[0].geom).toEqual({ kind: 'mesh', asset: id, src: ref, maxTris: 500, ...stamp });
    model = path.join(dir, 'model', 'm.p3d.json');
    gomulu = path.join(dir, 'model', 'gomulu.p3d.json');
    expect(api.saveProjectFile(p, model)).toMatchObject({ embedded: 0, referenced: 1, warnings: [] });
    expect(api.saveProjectFile(p, gomulu, { embed: true })).toMatchObject({ embedded: 1, referenced: 0 });
  });

  it('kaydederken ağ gömülmez; src dosyanın klasörüne göreli, maxTris ve kaynak damgası korunur', () => {
    const raw = JSON.parse(readFileSync(model, 'utf8'));
    expect(raw.assets).toBeUndefined();
    expect(raw.parts[0].geom).toEqual({ kind: 'mesh', asset: id, src: '../ref/kup.obj', maxTris: 500, ...stamp });
  });

  it('--embed: ağ gömülür, src yine göreli yazılır', () => {
    const raw = JSON.parse(readFileSync(gomulu, 'utf8'));
    expect(raw.parts[0].geom.src).toBe('../ref/kup.obj');
    expect(raw.assets[id]).toEqual(asset);
  });

  it('gidiş-dönüş: boş depoyla açınca kaynak dosyadan aynı ağ, aynı kimlikle; src bellekte mutlak', async () => {
    vi.resetModules(); // yeni süreç gibi: ağ deposu boş
    const fresh = (await import('../src/api')) as typeof api;
    expect(fresh.getAsset(id)).toBeUndefined();
    const back = await fresh.loadProjectFile(model);
    expect(back.parts[0].geom).toEqual({ kind: 'mesh', asset: id, src: ref, maxTris: 500, ...stamp });
    const a = fresh.getAsset(id)!;
    expect([a.positions, a.indices, a.triangles]).toEqual([asset.positions, asset.indices, asset.triangles]);
    // Yeniden kaydedince aynı dosya çıkar.
    const again = path.join(dir, 'model', 'tekrar.p3d.json');
    fresh.saveProjectFile(back, again);
    expect(readFileSync(again, 'utf8')).toBe(readFileSync(model, 'utf8'));
  });

  it('kaynak dosya yoksa açıklayıcı hata (yer tutucu yok); gömülü dosya yine açılır; kaydederken gömülür', async () => {
    const moved = `${ref}.tasindi`;
    renameSync(ref, moved);
    try {
      vi.resetModules();
      const fresh = (await import('../src/api')) as typeof api;
      await expect(fresh.loadProjectFile(model)).rejects.toThrow(`'kup': kaynak ağ dosyası bulunamadı: ${ref}`);
      const embedded = await fresh.loadProjectFile(gomulu);
      expect(fresh.getAsset(id)?.triangles).toBe(12);
      // Kaynak yokken kaydetme: bellekteki ağ gömülür, uyarı verilir.
      const r = fresh.saveProjectFile(embedded, path.join(dir, 'model', 'kaynaksiz.p3d.json'));
      expect(r).toMatchObject({ embedded: 1, referenced: 0 });
      expect(r.warnings[0]).toContain('kaynak ağ dosyası bulunamadı');
    } finally {
      renameSync(moved, ref);
    }
  });

  it('dosyada gömülü gelen ağ, embed verilmeden yeniden kaydedilince gömülü kalır (apply, apply --out, sekmeden save)', async () => {
    vi.resetModules();
    const fresh = (await import('../src/api')) as typeof api;
    const back = await fresh.loadProjectFile(gomulu);
    // Aynı dosyaya (apply) ve başka dosyaya (apply --out): kaynak dosya var ama ağ yine gömülü.
    expect(fresh.saveProjectFile(back, gomulu)).toMatchObject({ embedded: 1, referenced: 0, warnings: [] });
    expect(JSON.parse(readFileSync(gomulu, 'utf8')).assets[id]).toEqual(asset);
    const kopya = path.join(dir, 'model', 'gomulu-kopya.p3d.json');
    expect(fresh.saveProjectFile(back, kopya)).toMatchObject({ embedded: 1, referenced: 0 });
    // scene --file --full çıktısı dosyadaki gibi: src göreli, ağ gömülü.
    const text = JSON.parse(projectFileText(back, gomulu));
    expect(text.parts[0].geom).toEqual({ kind: 'mesh', asset: id, src: '../ref/kup.obj', maxTris: 500, ...stamp });
    expect(text.assets[id]).toEqual(asset);

    // Yüklemeyi görmemiş başka bir süreç (sekmeden p3d save): hedef dosyada gömülü olan ağ gömülü kalır.
    vi.resetModules();
    const other = (await import('../src/api')) as typeof api;
    other.registerAsset(asset);
    const p = other.newProject('sekme');
    other.applyOps(p, [{ op: 'import_mesh', asset, name: 'kup', src: ref, maxTris: 500, ...stamp }], null);
    expect(other.saveProjectFile(p, kopya)).toMatchObject({ embedded: 1, referenced: 0 });
    // Hedefte gömülü değilse yolla anılır; embed hepsini gömer.
    expect(other.saveProjectFile(p, path.join(dir, 'model', 'yeni.p3d.json'))).toMatchObject({ embedded: 0, referenced: 1 });
    expect(other.saveProjectFile(p, path.join(dir, 'model', 'yeni2.p3d.json'), { embed: true })).toMatchObject({ embedded: 1, referenced: 0 });
  });

  it('kaynak dosya değişmiş: açarken uyarı; gömülü ağ varsa o kullanılır, yoksa yeni içerik okunur; kaydederken bellekteki ağ gömülür', async () => {
    const original = readFileSync(ref, 'utf8');
    // Aynı topoloji, iki kat büyük küp: içerik ve boyut değişti.
    writeFileSync(ref, original.replace(/^v (.*)$/gm, (_, xyz: string) => `v ${xyz.split(' ').map((n) => Number(n) * 2).join(' ')}`));
    const now = fileStamp(ref);
    expect(now.srcHash).not.toBe(stamp.srcHash);
    try {
      // Gömülü: kaynak okunmaz, eski damga kalır, uyarı.
      vi.resetModules();
      const a1 = (await import('../src/api')) as typeof api;
      const w1: string[] = [];
      const emb = await a1.loadProjectFile(gomulu, { warnings: w1 });
      expect(w1).toEqual([`'kup': kaynak dosya değişmiş (${ref}); dosyaya gömülü ağ kullanıldı, kaynak okunmadı.`]);
      expect(a1.getAsset(id)!.positions).toBe(asset.positions);
      expect(emb.parts[0].geom).toMatchObject(stamp);
      expect(a1.saveProjectFile(emb, path.join(dir, 'model', 'degisti-gomulu.p3d.json'))).toMatchObject({ embedded: 1, referenced: 0 });
      // warnings verilmezse console.warn (sessiz değil).
      vi.resetModules();
      const a1b = (await import('../src/api')) as typeof api;
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await a1b.loadProjectFile(gomulu);
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("⚠ 'kup': kaynak dosya değişmiş"));
      } finally {
        spy.mockRestore();
      }

      // Yolla anılan: yeni içerik okunur, uyarı, damga güncellenir (bir sonraki kayıtta tekrar uyarmaz).
      vi.resetModules();
      const a2 = (await import('../src/api')) as typeof api;
      const w2: string[] = [];
      const refd = await a2.loadProjectFile(model, { warnings: w2 });
      expect(w2).toEqual([`'kup': kaynak dosya değişmiş (${ref}); ağ dosyanın yeni içeriğinden okundu, kaydedildiği hâlden farklı olabilir.`]);
      expect(a2.getAsset(id)!.positions).not.toBe(asset.positions);
      expect(refd.parts[0].geom).toMatchObject(now);
      expect(a2.saveProjectFile(refd, path.join(dir, 'model', 'degisti-yol.p3d.json'))).toMatchObject({ embedded: 0, referenced: 1, warnings: [] });

      // Bellekteki ağ eski içerikten (eski damga), kaynak değişmiş: yolla anılmaz, gömülür.
      vi.resetModules();
      const a3 = (await import('../src/api')) as typeof api;
      a3.registerAsset(asset);
      const p = a3.newProject('eski');
      a3.applyOps(p, [{ op: 'import_mesh', asset, name: 'kup', src: ref, maxTris: 500, ...stamp }], null);
      const r = a3.saveProjectFile(p, path.join(dir, 'model', 'degisti.p3d.json'));
      expect(r).toMatchObject({ embedded: 1, referenced: 0 });
      expect(r.warnings).toEqual([`'kup': kaynak dosya değişmiş (${ref}); bellekteki ağ dosyaya gömüldü (kaynağın yeni içeriği kullanılmadı).`]);
      // Verisi bellekte olmayan (yer tutucu) parça: korunacak veri yok, yeni içeriğe yolla anılır.
      const q = a3.newProject('yer-tutucu');
      q.parts.push({ id: 'p_y', name: 'tarama', shape: 'mesh', params: { scale: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#888888', visible: true, geom: { kind: 'mesh', asset: 'a_yokdeg01', src: ref, ...stamp } });
      const rq = a3.saveProjectFile(q, path.join(dir, 'model', 'degisti-verisiz.p3d.json'));
      expect(rq).toMatchObject({ embedded: 0, referenced: 1 });
      expect(rq.warnings[0]).toContain("'tarama': kaynak dosya değişmiş");
      expect(JSON.parse(readFileSync(path.join(dir, 'model', 'degisti-verisiz.p3d.json'), 'utf8')).parts[0].geom).toMatchObject(now);
    } finally {
      writeFileSync(ref, original);
    }
  });

  it('sadeleştirilen ağ (maxTris altına) kaynaktan aynı üçgenlerle, aynı kimlikle yeniden üretilir', async () => {
    const g = new api.THREE.IcosahedronGeometry(10, 10); // indissiz, 20 × 11² = 2420 üçgen
    const pos = g.getAttribute('position');
    const lines: string[] = [];
    for (let i = 0; i < pos.count; i++) lines.push(`v ${pos.getX(i)} ${pos.getY(i)} ${pos.getZ(i)}`);
    for (let i = 0; i < pos.count; i += 3) lines.push(`f ${i + 1} ${i + 2} ${i + 3}`);
    g.dispose();
    const kure = path.join(dir, 'ref', 'kure.obj');
    writeFileSync(kure, lines.join('\n'));
    const imp = await api.meshAssetFromSoup('kure', api.readMeshFile(kure), 500);
    // Sadeleştirme tetiklendi (meshoptimizer hata sınırında durabilir; tam 500'e inmesi gerekmez).
    expect(imp.originalTriangles).toBe(2420);
    expect(imp.asset.triangles).toBeLessThan(imp.originalTriangles / 2);
    expect(imp.asset.triangles).toBeGreaterThan(100);
    const p = api.newProject('kure');
    api.applyOps(p, [{ op: 'import_mesh', asset: imp.asset, name: 'kure', src: kure, maxTris: 500, ...fileStamp(kure) }], null);
    const file = path.join(dir, 'model', 'kure.p3d.json');
    expect(api.saveProjectFile(p, file)).toMatchObject({ embedded: 0, referenced: 1 });
    vi.resetModules();
    const fresh = (await import('../src/api')) as typeof api;
    const warnings: string[] = [];
    await fresh.loadProjectFile(file, { warnings });
    expect(warnings).toEqual([]);
    const a = fresh.getAsset(imp.asset.id)!;
    expect([a.positions, a.indices, a.triangles]).toEqual([imp.asset.positions, imp.asset.indices, imp.asset.triangles]);
  });

  it('ağ verisi de kaynağı da yoksa dosya yazılmaz', () => {
    const p = api.newProject();
    p.parts.push({ id: 'p_m', name: 'tarama', shape: 'mesh', params: { scale: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#888888', visible: true, geom: { kind: 'mesh', asset: 'a_yok12345' } });
    const file = path.join(dir, 'eksik.p3d.json');
    expect(() => api.saveProjectFile(p, file)).toThrow("ağ verisi yok: 'tarama'");
    expect(() => readFileSync(file)).toThrow();
  });
});

describe('exportFile', () => {
  let p: api.Project;
  beforeAll(() => {
    p = api.newProject('ihr');
    api.applyOps(p, [{ op: 'create', shape: 'box', name: 'a' }, { op: 'create', shape: 'box', name: 'b' }], null);
  });

  it('biçim uzantıdan; STL üçgen sayısı, birleştirme', async () => {
    const r = await api.exportFile(p, path.join(dir, 'iki.stl'));
    expect(r).toMatchObject({ format: 'stl', parts: 2, bytes: 84 + 50 * 24 });
    const one = await api.exportFile(p, path.join(dir, 'tek.stl'), { parts: ['b'] });
    expect(one.bytes).toBe(84 + 50 * 12);
    const m = await api.exportFile(p, path.join(dir, 'birlesik.3mf'), { merge: true });
    expect(m.format).toBe('3mf');
  });

  it('geçersiz seçenekler açıklayıcı hata verir ve dosya yazmaz', async () => {
    await expect(api.exportFile(p, path.join(dir, 'x.stl'), { skeleton: true })).rejects.toThrow('yalnızca GLB için');
    await expect(api.exportFile(p, path.join(dir, 'x.glb'), { merge: true })).rejects.toThrow('yalnızca STL ve 3MF');
    await expect(api.exportFile(p, path.join(dir, 'x.fbx'))).rejects.toThrow('.stl, .3mf, .obj ya da .glb');
    await expect(api.exportFile(p, path.join(dir, 'x.glb'), { parts: ['yok'] })).rejects.toThrow("'yok' adında parça ya da grup bulunamadı");
    expect(() => readFileSync(path.join(dir, 'x.stl'))).toThrow();
  });

  it("çıktı bir parçanın kaynak ağ dosyasıysa yazmaz (normalleştirilmiş; Windows'ta büyük/küçük harf duyarsız)", async () => {
    const src = path.join(dir, 'kaynak-ag.stl');
    writeFileSync(src, 'orijinal');
    const q = api.newProject('kaynak');
    api.applyOps(q, [{ op: 'create', shape: 'box', name: 'k' }], null);
    // Referans parça dışa aktarılmaz; yine de kaynağı korunur.
    q.parts.push({ id: 'p_ref', name: 'ref', shape: 'mesh', params: { scale: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#888888', visible: true, role: 'reference', geom: { kind: 'mesh', asset: 'a_yokref01', src } });
    const same = [path.join(dir, 'alt', '..', 'kaynak-ag.stl'), ...(process.platform === 'win32' ? [src.toUpperCase()] : [])];
    for (const out of same) {
      await expect(api.exportFile(q, out), out).rejects.toThrow("'ref' parçasının kaynak ağ dosyası (src); üzerine yazılmadı");
    }
    expect(readFileSync(src, 'utf8')).toBe('orijinal');
    expect((await api.exportFile(q, path.join(dir, 'kaynak-disi.stl'))).parts).toBe(1);
  });

  it('ağ verisi yüklü olmayan mesh parçası yer tutucu küp olarak dışa aktarılmaz', async () => {
    const q = api.newProject('eksik');
    q.parts.push({ id: 'p_m', name: 'tarama', shape: 'mesh', params: { scale: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#888888', visible: true, geom: { kind: 'mesh', asset: 'a_yok67890' } });
    await expect(api.exportFile(q, path.join(dir, 'eksik.stl'))).rejects.toThrow("ağ verisi yüklü değil: 'tarama'");
    expect(() => readFileSync(path.join(dir, 'eksik.stl'))).toThrow();
  });
});

describe('sceneSummary: yerel yol sızmaz (Claude isteği, köprü özeti)', () => {
  it('mesh için yalnızca kaynak dosyanın adı; maxTris / srcSize / srcHash yok; proje değişmez', () => {
    const p = api.newProject('ozet');
    const cases = [['win', 'C:\\Users\\gizli\\proje\\ref\\kup.obj'], ['posix', '/home/gizli/ref/tekne.stl'], ['yok', undefined]] as const;
    for (const [name, src] of cases) {
      p.parts.push({
        id: `p_${name}`, name, shape: 'mesh', params: { scale: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#888888', visible: true,
        geom: { kind: 'mesh', asset: 'a_ozet0001', ...(src ? { src, maxTris: 500, srcSize: 171, srcHash: '3cddc1fe606f0e36' } : {}) },
      });
    }
    const s = api.sceneSummary(p, null);
    expect(s.parts.map((x) => x.geom)).toEqual([
      { kind: 'mesh', asset: 'a_ozet0001', triangles: 0, src: 'kup.obj' },
      { kind: 'mesh', asset: 'a_ozet0001', triangles: 0, src: 'tekne.stl' },
      { kind: 'mesh', asset: 'a_ozet0001', triangles: 0 },
    ]);
    expect(JSON.stringify(s)).not.toContain('gizli');
    expect(p.parts[0].geom).toEqual({ kind: 'mesh', asset: 'a_ozet0001', src: 'C:\\Users\\gizli\\proje\\ref\\kup.obj', maxTris: 500, srcSize: 171, srcHash: '3cddc1fe606f0e36' });
  });
});

describe('p3d guide / skill install (fonksiyonlar)', () => {
  it('guide: giriş + konu listesi, konu, bilinmeyen konu, yol kaçışı', () => {
    const g = path.join(dir, 'rehber');
    mkdirSync(g);
    writeFileSync(path.join(g, 'index.md'), '# Giriş\n');
    writeFileSync(path.join(g, 'cli.md'), '# Komutlar\n');
    writeFileSync(path.join(g, 'ops.md'), '# İşlemler\n');
    expect(guideText(undefined, g)).toEqual({ ok: true, text: '# Giriş\n\nKonular: cli, ops  →  p3d guide <konu>' });
    expect(guideText('CLI', g)).toEqual({ ok: true, text: '# Komutlar' });
    const unknown = guideText('yok', g);
    expect(unknown.ok).toBe(false);
    expect(unknown.text).toContain("Bilinmeyen konu: 'yok'.\nKonular: cli, ops");
    expect(guideText('../rehber/cli', g).ok).toBe(false);
    rmSync(path.join(g, 'index.md'));
    expect(guideText(undefined, g).text).toContain('index.md yok');
  });

  it('skill install: kurar, aynıysa yazmaz, farklıysa önce yedekler (SKILL.md.bak) ve üzerine yazdığını söyler', () => {
    const src = path.join(dir, 'SKILL.md');
    writeFileSync(src, '---\nname: p3d\n---\n');
    const skills = path.join(dir, 'skills');
    const dest = path.join(skills, 'p3d', 'SKILL.md');
    expect(installSkill(skills, src)).toEqual({ dest, status: 'kuruldu' });
    expect(installSkill(skills, src)).toEqual({ dest, status: 'aynı' });
    writeFileSync(dest, 'eski');
    expect(installSkill(skills, src)).toEqual({ dest, status: 'güncellendi', backup: `${dest}.bak` });
    expect(readFileSync(dest, 'utf8')).toBe('---\nname: p3d\n---\n');
    expect(readFileSync(`${dest}.bak`, 'utf8')).toBe('eski');
    // Sonraki güncelleme: yedek bir önceki içerikle yenilenir.
    writeFileSync(dest, 'elle düzenlenmiş');
    expect(installSkill(skills, src).status).toBe('güncellendi');
    expect(readFileSync(`${dest}.bak`, 'utf8')).toBe('elle düzenlenmiş');
  });
});
