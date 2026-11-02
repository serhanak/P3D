// Kararlı kütüphane yüzeyi (src/api.ts) ve Node dosya yardımcıları (src/files.ts): sözleşme testi. Buradaki adlar
// tüketicilerin (`import … from 'p3d'`) dayandığı yüzeydir; bir ad kaldırılırsa bu test kırılmalı.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api';
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
      'buildGlb', 'loadProjectFile', 'saveProjectFile', 'exportFile',
    ];
    for (const f of fns) expect(typeof (api as Record<string, unknown>)[f], f).toBe('function');
    expect(new api.THREE.Vector3(3, 4, 0).length()).toBe(5);
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
  let id: string;
  let asset: api.MeshAsset;

  beforeAll(async () => {
    mkdirSync(path.join(dir, 'ref'));
    mkdirSync(path.join(dir, 'model'));
    ref = path.join(dir, 'ref', 'kup.obj');
    writeFileSync(ref, CUBE_OBJ);
    const imp = await api.meshAssetFromSoup('kup', api.readMeshFile(ref), 500);
    asset = imp.asset;
    id = imp.asset.id;
    const p = api.newProject('ref');
    const res = api.applyOps(p, [{ op: 'import_mesh', asset: imp.asset, name: 'kup', role: 'reference', position: imp.center, src: ref, maxTris: 500 }], null);
    expect(res.errors).toEqual([]);
    expect(p.parts[0].geom).toEqual({ kind: 'mesh', asset: id, src: ref, maxTris: 500 });
    model = path.join(dir, 'model', 'm.p3d.json');
    expect(api.saveProjectFile(p, model)).toMatchObject({ embedded: 0, referenced: 1, warnings: [] });
    expect(api.saveProjectFile(p, path.join(dir, 'model', 'gomulu.p3d.json'), { embed: true })).toMatchObject({ embedded: 1, referenced: 0 });
  });

  it('kaydederken ağ gömülmez; src dosyanın klasörüne göreli, maxTris korunur', () => {
    const raw = JSON.parse(readFileSync(model, 'utf8'));
    expect(raw.assets).toBeUndefined();
    expect(raw.parts[0].geom).toEqual({ kind: 'mesh', asset: id, src: '../ref/kup.obj', maxTris: 500 });
  });

  it('--embed: ağ gömülür, src yine göreli yazılır', () => {
    const raw = JSON.parse(readFileSync(path.join(dir, 'model', 'gomulu.p3d.json'), 'utf8'));
    expect(raw.parts[0].geom.src).toBe('../ref/kup.obj');
    expect(raw.assets[id]).toEqual(asset);
  });

  it('gidiş-dönüş: boş depoyla açınca kaynak dosyadan aynı ağ, aynı kimlikle; src bellekte mutlak', async () => {
    vi.resetModules(); // yeni süreç gibi: ağ deposu boş
    const fresh = (await import('../src/api')) as typeof api;
    expect(fresh.getAsset(id)).toBeUndefined();
    const back = await fresh.loadProjectFile(model);
    expect(back.parts[0].geom).toEqual({ kind: 'mesh', asset: id, src: ref, maxTris: 500 });
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
      const embedded = await fresh.loadProjectFile(path.join(dir, 'model', 'gomulu.p3d.json'));
      expect(fresh.getAsset(id)?.triangles).toBe(12);
      // Kaynak yokken kaydetme: bellekteki ağ gömülür, uyarı verilir.
      const r = fresh.saveProjectFile(embedded, path.join(dir, 'model', 'kaynaksiz.p3d.json'));
      expect(r).toMatchObject({ embedded: 1, referenced: 0 });
      expect(r.warnings[0]).toContain('kaynak ağ dosyası bulunamadı');
    } finally {
      renameSync(moved, ref);
    }
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

  it('ağ verisi yüklü olmayan mesh parçası yer tutucu küp olarak dışa aktarılmaz', async () => {
    const q = api.newProject('eksik');
    q.parts.push({ id: 'p_m', name: 'tarama', shape: 'mesh', params: { scale: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#888888', visible: true, geom: { kind: 'mesh', asset: 'a_yok67890' } });
    await expect(api.exportFile(q, path.join(dir, 'eksik.stl'))).rejects.toThrow("ağ verisi yüklü değil: 'tarama'");
    expect(() => readFileSync(path.join(dir, 'eksik.stl'))).toThrow();
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

  it('skill install: kurar, aynıysa yazmaz, farklıysa üzerine yazdığını söyler', () => {
    const src = path.join(dir, 'SKILL.md');
    writeFileSync(src, '---\nname: p3d\n---\n');
    const skills = path.join(dir, 'skills');
    const dest = path.join(skills, 'p3d', 'SKILL.md');
    expect(installSkill(skills, src)).toEqual({ dest, status: 'kuruldu' });
    expect(installSkill(skills, src)).toEqual({ dest, status: 'aynı' });
    writeFileSync(dest, 'eski');
    expect(installSkill(skills, src)).toEqual({ dest, status: 'güncellendi' });
    expect(readFileSync(dest, 'utf8')).toBe('---\nname: p3d\n---\n');
  });
});
