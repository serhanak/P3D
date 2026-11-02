import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDigest, normalizeWs, wsFromPathname, wsNameError, wsPath } from '../shared/ops';
import { findConfig, insideDir, parseConfig, resolveWorkspace, samePath } from '../scripts/config';
import { ASSETS_KEY, AUTOSAVE_KEY, CORRUPT_KEY, META_KEY, claimAutosave, localStorageBackend } from '../src/autosave';
import { makeAsset } from '../src/assets';
import { Store } from '../src/store';
import { newProject } from '../src/types';

describe('çalışma alanı adı', () => {
  it('geçerli adları kabul eder', () => {
    for (const ok of ['', 'canta-v2', 'Çanta_1.2', 'a', 'x'.repeat(64), 'ölçü', '日本', '..a', 'v1.0']) expect(wsNameError(ok), ok).toBeNull();
  });

  it('geçersiz adları açıklamayla reddeder', () => {
    for (const bad of ['.', '..', 'a/b', 'a b', 'a\\b', 'a?b', 'x%y', 'x'.repeat(65), ' a', 'a:b']) {
      expect(wsNameError(bad), bad).toMatch(/Çalışma alanı adı|Geçersiz çalışma alanı adı/);
      expect(() => normalizeWs(bad)).toThrow();
    }
    expect(() => normalizeWs(5)).toThrow(/metin/);
  });

  it('NFC biçimine getirir; eksik ad köktür', () => {
    expect(normalizeWs('s\u0327')).toBe('ş');
    expect(normalizeWs(undefined)).toBe('');
    expect(normalizeWs(null)).toBe('');
  });

  it('adresten çalışma alanını ayrıştırır', () => {
    expect(wsFromPathname('/')).toBe('');
    expect(wsFromPathname('/index.html')).toBe('');
    expect(wsFromPathname('/w/canta-v2')).toBe('canta-v2');
    expect(wsFromPathname('/w/canta-v2/')).toBe('canta-v2');
    expect(wsFromPathname('/w/%C3%A7anta')).toBe('çanta');
    for (const bad of ['/w/', '/w', '/w/a/b', '/foo', '/w/..', '/w/a%20b', '/w/%E0%A4%A']) expect(() => wsFromPathname(bad), bad).toThrow();
  });

  it('wsPath ile gidiş-dönüş', () => {
    expect(wsPath('')).toBe('/');
    for (const ws of ['canta-v2', 'çanta', '日本.x', 'a_b']) expect(wsFromPathname(wsPath(ws))).toBe(ws);
  });
});

describe('p3d.json keşfi', () => {
  let root: string;
  const write = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  };

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'p3d-ws-'));
    write('p3d.json', JSON.stringify({ workspace: 'ust', file: 'model/m.p3d.json', onAmbiguity: 'assume' }));
    mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
    write('x/p3d.json', JSON.stringify({ workspace: 'alt' }));
    mkdirSync(path.join(root, 'x', 'y'), { recursive: true });
    write('bozuk/p3d.json', '{ "workspace": "kirik", ');
    mkdirSync(path.join(root, 'bozuk', 'ic'), { recursive: true });
    write('gecersiz/p3d.json', JSON.stringify({ workspace: 'a/b' }));
    write('kacis/p3d.json', JSON.stringify({ workspace: 'k', file: '../m.p3d.json' }));
    write('mutlak/p3d.json', JSON.stringify({ workspace: 'k', file: path.join(root, 'baska', 'm.p3d.json') }));
    mkdirSync(path.join(root, 'bos', 'ic'), { recursive: true });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('iç içe klasörlerden yukarı doğru ilk p3d.json bulunur; file ona göre çözülür', () => {
    const f = findConfig(path.join(root, 'a', 'b', 'c'))!;
    expect(f.path).toBe(path.join(root, 'p3d.json'));
    expect(f.config).toEqual({ workspace: 'ust', file: 'model/m.p3d.json', onAmbiguity: 'assume' });
    expect(f.file).toBe(path.join(root, 'model', 'm.p3d.json'));
    // En yakın dosya kazanır.
    expect(findConfig(path.join(root, 'x', 'y'))!.config.workspace).toBe('alt');
  });

  it('sıra: --ws > P3D_WS > p3d.json > kök', () => {
    const cwd = path.join(root, 'a', 'b');
    expect(resolveWorkspace({ cwd })).toMatchObject({ ws: 'ust', source: 'p3d.json' });
    expect(resolveWorkspace({ cwd, env: 'ortam' })).toMatchObject({ ws: 'ortam', source: 'P3D_WS' });
    expect(resolveWorkspace({ cwd, env: 'ortam', flag: 'bayrak' })).toMatchObject({ ws: 'bayrak', source: '--ws' });
    expect(resolveWorkspace({ cwd, flag: '/' })).toMatchObject({ ws: '', source: '--ws' });
    expect(resolveWorkspace({ cwd, env: '' })).toMatchObject({ ws: 'ust', source: 'p3d.json' }); // boş ortam değişkeni yok sayılır
    // --ws ile seçilse de p3d.json bulunur (open/save dosyası için).
    expect(resolveWorkspace({ cwd, flag: 'bayrak' }).config?.config.workspace).toBe('ust');
    expect(() => resolveWorkspace({ cwd, flag: 'a b' })).toThrow(/--ws/);
    // p3d.json yoksa kök. Arama `stopAt`'te durur: makinedeki üst klasörlerde p3d.json olsa da sonuç aynı.
    const bos = path.join(root, 'bos', 'ic');
    expect(resolveWorkspace({ cwd: bos, stopAt: path.join(root, 'bos') })).toMatchObject({ ws: '', source: 'varsayılan', config: null });
    expect(findConfig(bos, path.join(root, 'bos'))).toBeNull();
    expect(findConfig(bos, root)!.config.workspace).toBe('ust'); // stopAt'in kendisi de aranır
  });

  it('"file" p3d.json klasörünün dışını gösteremez (.. ya da mutlak yol)', () => {
    for (const where of ['kacis', 'mutlak']) {
      const f = findConfig(path.join(root, where))!;
      expect(f.file).toBeUndefined();
      expect(f.fileError).toMatch(/p3d\.json'ın klasörünün dışını gösteriyor/);
      expect(f.fileError).toContain(path.join(root, where, 'p3d.json'));
    }
    expect(findConfig(root)!.fileError).toBeUndefined();
    expect(insideDir(root, path.join(root, 'a', 'b.json'))).toBe(true);
    expect(insideDir(root, path.join(root, '..x', 'b.json'))).toBe(true); // '..' ile başlayan ad, üst klasör değil
    expect(insideDir(root, path.join(root, '..', 'b.json'))).toBe(false);
    expect(insideDir(root, root)).toBe(false);
  });

  it("samePath: normalleştirir; Windows'ta büyük/küçük harf duyarsız", () => {
    expect(samePath('C:\\Proje\\Model.p3d.json', 'c:/proje/alt/../model.P3D.json', 'win32')).toBe(true);
    expect(samePath('C:\\proje\\a.p3d.json', 'C:\\proje\\b.p3d.json', 'win32')).toBe(false);
    expect(samePath('/proje/alt/../model.p3d.json', '/proje/model.p3d.json', 'linux')).toBe(true);
    expect(samePath('/proje/Model.p3d.json', '/proje/model.p3d.json', 'linux')).toBe(false);
  });

  it('bozuk p3d.json açıklayıcı hata verir; --ws verilmişse yalnızca bekletilir', () => {
    const cwd = path.join(root, 'bozuk', 'ic');
    expect(() => resolveWorkspace({ cwd })).toThrow(/p3d\.json geçerli JSON değil/);
    expect(() => resolveWorkspace({ cwd })).toThrow(path.join(root, 'bozuk', 'p3d.json'));
    const c = resolveWorkspace({ cwd, flag: 'el' });
    expect(c.ws).toBe('el');
    expect(c.configError?.message).toMatch(/geçerli JSON değil/);
    expect(() => findConfig(path.join(root, 'gecersiz'))).toThrow(/Geçersiz çalışma alanı adı 'a\/b'/);
  });

  it('alanları doğrular', () => {
    expect(() => parseConfig('[]', 'p3d.json')).toThrow(/JSON nesnesi/);
    expect(() => parseConfig('{}', 'p3d.json')).toThrow(/"workspace" alanı gerekli/);
    expect(() => parseConfig('{"workspace":"a","file":""}', 'p3d.json')).toThrow(/"file"/);
    expect(() => parseConfig('{"workspace":"a","onAmbiguity":"sor"}', 'p3d.json')).toThrow(/ask-critical, assume, ask-all/);
    expect(parseConfig('\uFEFF{"workspace":"","extra":1}', 'p3d.json')).toEqual({ workspace: '' });
  });
});

describe('kök otomatik kaydı (localStorage)', () => {
  const fake = () => {
    const m = new Map<string, string>();
    return { m, storage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } };
  };

  it('anahtarlar ve biçim değişmedi; dosya bağı ayrı anahtarda', async () => {
    const { m, storage } = fake();
    const b = localStorageBackend(() => storage);
    const p = newProject('kök');
    const warn: string[] = [];
    b.save({ project: p, dirty: false }, (w) => warn.push(w));
    expect([...m.keys()]).toEqual([AUTOSAVE_KEY]);
    expect(m.get(AUTOSAVE_KEY)).toBe(JSON.stringify(p));
    expect(AUTOSAVE_KEY).toBe('p3d.autosave.v1');
    expect(ASSETS_KEY).toBe('p3d.autosave.assets.v1');

    // Ağ kullanılınca ağ anahtarı yazılır (yalnızca küme değişince).
    const asset = makeAsset('kup', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint32Array([0, 1, 2]), 'a_wstest1');
    const { registerAsset } = await import('../src/assets');
    registerAsset(asset);
    const withMesh = { ...p, parts: [{ id: 'p1', name: 'ag', shape: 'mesh' as const, params: { scale: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#ffffff', visible: true, geom: { kind: 'mesh' as const, asset: asset.id } }] };
    b.save({ project: withMesh, file: 'C:/m.p3d.json', dirty: true }, (w) => warn.push(w));
    expect(JSON.parse(m.get(ASSETS_KEY)!)).toEqual({ [asset.id]: asset });
    expect(JSON.parse(m.get(META_KEY)!)).toEqual({ file: 'C:/m.p3d.json', dirty: true });
    expect(warn).toEqual([]);

    const back = await localStorageBackend(() => storage).load();
    expect(back).toEqual({ project: JSON.parse(JSON.stringify(withMesh)), file: 'C:/m.p3d.json', dirty: true });

    // Dosya bağı kalkınca anahtar silinir.
    b.save({ project: withMesh, dirty: false }, () => {});
    expect(m.has(META_KEY)).toBe(false);
  });

  it('ağ verisi olmayan mesh parçası: yer tutucu kalıcılaşmaz, kimlik ve kaynak bilgisi (src, damga) kayıtta korunur', async () => {
    const { m, storage } = fake();
    const b = localStorageBackend(() => storage);
    const geom = { kind: 'mesh' as const, asset: 'a_verisiz1', src: '../ref/tekne.stl', maxTris: 500, srcSize: 171, srcHash: '3cddc1fe606f0e36' };
    const p = { ...newProject('verisiz'), parts: [{ id: 'p1', name: 'ag', shape: 'mesh' as const, params: { scale: 1 }, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, color: '#ffffff', visible: true, geom }] };
    b.save({ project: p, dirty: true }, () => {});
    expect(m.has(ASSETS_KEY)).toBe(false); // gömülecek veri yok; yer tutucu küp yazılmaz
    const back = await localStorageBackend(() => storage).load();
    const { parseProject, meshPartsWithoutData } = await import('../src/io');
    const restored = parseProject(back!.project);
    expect(restored.parts[0]).toMatchObject({ shape: 'mesh', geom });
    expect(meshPartsWithoutData(restored).map((x) => x.name)).toEqual(['ag']);
  });

  it('eski biçimdeki kayıt (yalnızca proje anahtarı) aynen yüklenir', async () => {
    const { m, storage } = fake();
    const p = newProject('eski');
    m.set(AUTOSAVE_KEY, JSON.stringify(p));
    expect(await localStorageBackend(() => storage).load()).toEqual({ project: p });
    expect(await localStorageBackend(() => fake().storage).load()).toBeNull();
  });

  it('okunamayan kayıt yedeğe taşınır (silinmez); yedeklenemezse asıl kayıt yerinde kalır', async () => {
    const { m, storage } = fake();
    expect(CORRUPT_KEY).toBe('p3d.autosave.v1.bozuk');
    m.set(AUTOSAVE_KEY, '{bozuk');
    m.set(META_KEY, JSON.stringify({ file: 'C:/m.p3d.json', dirty: false }));
    const b = localStorageBackend(() => storage);
    const rec = await b.load();
    expect(rec?.error).toMatch(/bozuk JSON/);
    expect(await b.quarantine()).toBe(`localStorage '${CORRUPT_KEY}'`);
    expect(m.get(CORRUPT_KEY)).toBe('{bozuk');
    expect(m.has(AUTOSAVE_KEY)).toBe(false);
    expect(m.has(META_KEY)).toBe(false);
    // İkinci bozuk kayıt ilk yedeği ezmez.
    m.set(AUTOSAVE_KEY, '"ikinci"');
    expect(await b.quarantine()).toMatch(/^localStorage 'p3d\.autosave\.v1\.bozuk\.\d+'$/);
    expect(m.get(CORRUPT_KEY)).toBe('{bozuk');
    expect([...m.values()]).toContain('"ikinci"');

    // Kota dolu: yedek yazılamaz → hata, asıl kayıt silinmez.
    const full = {
      ...storage,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    m.set(AUTOSAVE_KEY, '{yine bozuk');
    await expect(localStorageBackend(() => full).quarantine()).rejects.toThrow(/Quota/);
    expect(m.get(AUTOSAVE_KEY)).toBe('{yine bozuk');
  });
});

describe('içerik özeti', () => {
  it('belirlenimci, 16 onaltılık karakter; küçük farkı ayırır', () => {
    const p = JSON.stringify(newProject('özet'));
    expect(contentDigest(p)).toMatch(/^[0-9a-f]{16}$/);
    expect(contentDigest(p)).toBe(contentDigest(JSON.stringify(JSON.parse(p))));
    expect(contentDigest(p)).not.toBe(contentDigest(p.replace('özet', 'ozet')));
    expect(contentDigest('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('Store: kirlilik, dosya bağı, replace, markSaved (otomatik kayıtsız)', () => {
  const create = (name: string) => [{ op: 'create' as const, shape: 'box' as const, name }];

  it('değişiklik kirletir; geri al kaydedilmiş hâle döner; seçim ve etkisiz işlem kirletmez', () => {
    const s = new Store(newProject('t'));
    expect(s.dirty).toBe(false);
    s.apply(create('a'));
    expect(s.dirty).toBe(true);
    s.undo();
    expect(s.dirty).toBe(false);
    s.redo();
    expect(s.dirty).toBe(true);
    expect(s.markSaved('C:/m.p3d.json')).toBe(true);
    expect(s).toMatchObject({ dirty: false, file: 'C:/m.p3d.json' });
    s.select(null);
    s.select(s.project.parts[0].id);
    s.apply([]);
    expect(s.dirty).toBe(false);
    s.mutate((p) => (p.name = 'yeni ad'));
    expect(s.dirty).toBe(true);
  });

  it('replace geri alınabilir ve dosya bağını kurar; dirty bayrağıyla kirli kalır', () => {
    const s = new Store(newProject('t'));
    s.apply(create('a'));
    s.replace(newProject('dosya'), 'C:/d.p3d.json');
    expect(s).toMatchObject({ dirty: false, file: 'C:/d.p3d.json' });
    expect(s.project.name).toBe('dosya');
    expect(s.canUndo).toBe(true);
    s.undo();
    expect(s.project.parts.map((p) => p.name)).toEqual(['a']);
    expect(s.dirty).toBe(true);
    s.replace(newProject('kısmi'), 'C:/k.p3d.json', true);
    expect(s).toMatchObject({ dirty: true, file: 'C:/k.p3d.json' });
  });

  it('markSaved özet uyuşmazsa sekme kirli kalır (dosya bağı yine kurulur)', () => {
    const s = new Store(newProject('t'));
    s.apply(create('a'));
    const read = JSON.stringify(s.project); // `p3d save` bu hâli okudu
    s.apply(create('b')); // ... o arada sekmede değişiklik
    expect(s.markSaved('C:/m.p3d.json', contentDigest(read))).toBe(false);
    expect(s).toMatchObject({ dirty: true, file: 'C:/m.p3d.json' });
    expect(s.markSaved('C:/m.p3d.json', contentDigest(JSON.stringify(s.project)))).toBe(true);
    expect(s.dirty).toBe(false);
  });

  it('load dosya bağını kaldırır; başlangıç durumu (file, dirty) kayıttan gelir', () => {
    const s = new Store(newProject('t'), null, { file: 'C:/x.p3d.json', dirty: true });
    expect(s).toMatchObject({ dirty: true, file: 'C:/x.p3d.json' });
    s.load(newProject('y'));
    expect(s.file).toBeUndefined();
    expect(s.dirty).toBe(false);
  });
});

describe('aynı çalışma alanı iki sekmede', () => {
  it('ilk sekme otomatik kaydın sahibidir, sonraki değil; başka ws etkilenmez', async () => {
    // Node'da navigator.locks yok: BroadcastChannel yolu sınanır (tarayıcıda kilit kullanılır).
    expect(await claimAutosave('iki-sekme')).toBe(true);
    expect(await claimAutosave('iki-sekme')).toBe(false);
    expect(await claimAutosave('baska-sekme')).toBe(true);
  });
});
