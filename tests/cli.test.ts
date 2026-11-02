import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUIDE_DIR, SKILL_SOURCE, guideTopics } from '../scripts/guide';
import { findChrome, launchHeadless } from '../scripts/headless';
import { makeAsset } from '../src/assets';

// Global `p3d` komutu (bin/p3d.mjs) başka klasörlerden çalıştırılır; --file komutları sunucu gerektirmez.
const BIN = fileURLToPath(new URL('../bin/p3d.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 10 mm küp (OBJ, dışa bakan yüzler). */
const CUBE_OBJ = [
  ...[[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]].map((v) => `v ${v.join(' ')}`),
  'f 1 3 2', 'f 1 4 3', 'f 5 6 7', 'f 5 7 8', 'f 1 2 6', 'f 1 6 5',
  'f 2 3 7', 'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8',
].join('\n');

let dir: string;

/** Testin kendi npm ortamı (npm_lifecycle_event, INIT_CWD) ve P3D değişkenleri sızmasın. */
function cleanEnv(env: Record<string, string>): Record<string, string | undefined> {
  // Windows'ta ad büyük harfle de gelebilir (NPM_LIFECYCLE_EVENT); iki yazım birlikte verilirse alt süreçte hangisinin
  // kazanacağı belirsizdir.
  const drop = ['init_cwd', 'npm_lifecycle_event', 'p3d_ws', 'p3d_url', 'p3d_skills_dir'];
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !drop.includes(k.toLowerCase())));
  return { ...base, ...env };
}

function p3d(args: string[], cwd: string, env: Record<string, string> = {}): string {
  return execFileSync(process.execPath, [BIN, ...args], { cwd, env: cleanEnv(env), encoding: 'utf8' });
}

/** Çıkış kodunu da döndürür; `input` stdin'e yazılır. */
function p3dRun(args: string[], cwd: string, opts: { env?: Record<string, string>; input?: string } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: cleanEnv(opts.env ?? {}), encoding: 'utf8', input: opts.input ?? '' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'p3d-cli-'));
  mkdirSync(path.join(dir, 'alt'));
  writeFileSync(path.join(dir, 'alt', 'kup.obj'), CUBE_OBJ);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('p3d komutu başka klasörden', () => {
  it('göreli yolu çağıranın klasörüne göre çözer', () => {
    const out = p3d(['section', '--axis', 'z', '--at', '5', '--file', 'alt/kup.obj'], dir);
    expect(out).toContain('kup.obj: kutu 0,0,0 → 10,10,10');
    expect(out).toContain('alan 100 mm²');
  }, 60_000);

  it('`npm run p3d` altında depo kökünden çalışsa da INIT_CWD kullanılır', () => {
    const out = p3d(['section', '--axis', 'x', '--at', '5', '--file', 'alt/kup.obj'], ROOT, { npm_lifecycle_event: 'p3d', INIT_CWD: dir });
    expect(out).toContain('alan 100 mm²');
  }, 60_000);
});

describe('p3d run', () => {
  it("geçici klasördeki betik kurulumsuz `import { applyOps, THREE } from 'p3d'` yapar; argümanlar ve klasör betiğindir", () => {
    const sub = path.join(dir, 'betik');
    mkdirSync(sub);
    writeFileSync(
      path.join(sub, 'uret.mts'),
      [
        "import { applyOps, newProject, THREE, type Project } from 'p3d';",
        "const p: Project = newProject('betik');",
        "const r = applyOps(p, [{ op: 'create', shape: 'box', name: 'k' }], null);",
        'const v: THREE.Vector3 = new THREE.Vector3(3, 4, 0);',
        'console.log(JSON.stringify({ parts: p.parts.length, errors: r.errors, len: v.length(), argv: process.argv.slice(2), cwd: process.cwd() }));',
      ].join('\n'),
    );
    const r = p3dRun(['run', 'betik/uret.mts', 'a', '--ws', 'b'], dir);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ parts: 1, errors: [], len: 5, argv: ['a', '--ws', 'b'], cwd: dir });
  }, 60_000);

  it('`npm run p3d -- run` yolu (tsx ile scripts/p3d.ts, INIT_CWD): çözümleme kancasını p3d.ts kaydeder', () => {
    const sub = path.join(dir, 'npmrun');
    mkdirSync(sub);
    writeFileSync(
      path.join(sub, 'b.mts'),
      [
        "import { newProject, SHAPES } from 'p3d';",
        "console.log(JSON.stringify({ name: newProject('npm').name, box: SHAPES.includes('box'), cwd: process.cwd(), argv: process.argv.slice(2) }));",
      ].join('\n'),
    );
    // `npm run p3d` = `tsx scripts/p3d.ts` depo kökünde; komutun yazıldığı klasör INIT_CWD'de.
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'scripts', 'p3d.ts'), 'run', 'b.mts', 'x'], {
      cwd: ROOT,
      env: cleanEnv({ npm_lifecycle_event: 'p3d', INIT_CWD: sub }),
      encoding: 'utf8',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ name: 'npm', box: true, cwd: sub, argv: ['x'] });
  }, 60_000);

  it('betik yoksa açıklayıcı hata; betiğin hatası yığın iziyle, çıkış kodu 1', () => {
    const missing = p3dRun(['run', 'yok.mts'], dir);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(`Betik bulunamadı: ${path.join(dir, 'yok.mts')}`);
    writeFileSync(path.join(dir, 'patla.mjs'), "throw new Error('betik patladı');");
    const bad = p3dRun(['run', 'patla.mjs'], dir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('Error: betik patladı');
    expect(bad.stderr).toContain('patla.mjs');
  }, 60_000);
});

describe('tarayıcısız komutlar (--file)', () => {
  let model: string;
  const OPS = [
    { op: 'create', shape: 'box', name: 'govde', params: [{ name: 'width', value: 40 }, { name: 'depth', value: 20 }, { name: 'height', value: 10 }], position: { x: 0, y: 0, z: 5 } },
    { op: 'create', shape: 'cylinder', name: 'teker1', params: [{ name: 'diameter', value: 12 }, { name: 'height', value: 4 }], position: { x: -12, y: -12, z: 6 }, rotation: { x: 90, y: 0, z: 0 } },
    { op: 'group', name: 'teker', parts: ['teker1'], pivot: { x: -12, y: -12, z: 6 } },
  ];

  beforeAll(() => {
    model = path.join(dir, 'model.p3d.json');
    writeFileSync(path.join(dir, 'ops.json'), JSON.stringify(OPS));
  });

  it('apply --new: dosya yoksa boş projeyle başlar, işlemleri uygular, yazar; --new olmadan hata', () => {
    const none = p3dRun(['apply', '--file', 'yok.p3d.json', '--ops', 'ops.json'], dir);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('yeni proje için --new');
    const r = p3dRun(['apply', '--file', 'model.p3d.json', '--ops', 'ops.json', '--new'], dir);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Yeni proje: ${model}`);
    expect(r.stdout).toContain(`✓ Kaydedildi: ${model} (2 parça)`);
    const saved = JSON.parse(readFileSync(model, 'utf8'));
    expect(saved.name).toBe('model');
    expect(saved.parts.map((p: { name: string }) => p.name)).toEqual(['govde', 'teker1']);
    expect(saved.groups).toEqual([{ name: 'teker', pivot: { x: -12, y: -12, z: 6 } }]);
  }, 60_000);

  it('apply: hata varsa dosya yazılmaz (diğer işlemler de), çıkış 1; --dry-run yazmaz; stdin ve {"ops": …} kabul edilir', () => {
    const before = readFileSync(model, 'utf8');
    const bad = p3dRun(['apply', '--file', 'model.p3d.json'], dir, {
      input: JSON.stringify([{ op: 'create', shape: 'sphere', name: 'top' }, { op: 'update', part: 'olmayan', color: 'kırmızı' }]),
    });
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("✕ 'olmayan' adında parça bulunamadı.");
    expect(bad.stdout).toContain('yazılmadı (dosya değişmedi)');
    expect(readFileSync(model, 'utf8')).toBe(before);

    const dry = p3dRun(['apply', '--file', 'model.p3d.json', '--dry-run', '--label', 'küre'], dir, { input: JSON.stringify({ ops: [{ op: 'create', shape: 'sphere', name: 'top' }] }) });
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('İşlem: küre');
    expect(dry.stdout).toContain(' top [sphere]');
    expect(dry.stdout).toContain('(deneme)');
    expect(readFileSync(model, 'utf8')).toBe(before);

    const out = p3dRun(['apply', '--file', 'model.p3d.json', '--out', 'kopya.p3d.json'], dir, { input: JSON.stringify([{ op: 'create', shape: 'sphere', name: 'top' }]) });
    expect(out.code).toBe(0);
    expect(readFileSync(model, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(path.join(dir, 'kopya.p3d.json'), 'utf8')).parts).toHaveLength(3);

    const notOps = p3dRun(['apply', '--file', 'model.p3d.json'], dir, { input: '{"op": "create"}' });
    expect(notOps.code).toBe(1);
    expect(notOps.stderr).toContain('bir işlem dizisi olmalı');
  }, 60_000);

  it('apply --out: hedef başka bir mevcut dosyaysa --force ister; kaynak dosyanın kendisi (farklı yazımla) serbest', () => {
    const kopya = path.join(dir, 'kopya.p3d.json');
    const before = readFileSync(kopya, 'utf8');
    const input = JSON.stringify([{ op: 'create', shape: 'box', name: 'ek' }]);
    const r = p3dRun(['apply', '--file', 'model.p3d.json', '--out', 'kopya.p3d.json'], dir, { input });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${kopya} zaten var (--out kaynak dosyadan farklı: ${model}); üzerine yazmak için --force ekleyin`);
    expect(readFileSync(kopya, 'utf8')).toBe(before);
    // --dry-run yazmadığı için engellenmez.
    expect(p3dRun(['apply', '--file', 'model.p3d.json', '--out', 'kopya.p3d.json', '--dry-run'], dir, { input }).code).toBe(0);
    const f = p3dRun(['apply', '--file', 'model.p3d.json', '--out', 'kopya.p3d.json', '--force'], dir, { input });
    expect(f.code).toBe(0);
    expect(JSON.parse(readFileSync(kopya, 'utf8')).parts.map((p: { name: string }) => p.name)).toEqual(['govde', 'teker1', 'ek']);
    // --out kaynak dosyanın kendisi: --force gerekmez.
    copyFileSync(model, path.join(dir, 'ayni.p3d.json'));
    const same = p3dRun(['apply', '--file', 'ayni.p3d.json', '--out', `alt${path.sep}..${path.sep}ayni.p3d.json`], dir, { input });
    expect(same.stderr).toBe('');
    expect(same.code).toBe(0);
  }, 60_000);

  it('okunamayan parça: check hata sayar (çıkış 1), measure / scene stdout\'ta uyarır, export yazmaz', () => {
    const raw = JSON.parse(readFileSync(model, 'utf8'));
    raw.parts.push({ ...raw.parts[0], id: 'p_garip', name: 'garip', shape: 'yildiz' });
    writeFileSync(path.join(dir, 'garip.p3d.json'), JSON.stringify(raw));
    const why = "'garip': bilinmeyen şekil 'yildiz'";
    const c = p3dRun(['check', '--file', 'garip.p3d.json'], dir);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain(`✕ Parça okunamadı, denetlenmedi: ${why}`);
    expect(c.stdout).not.toContain('Sorun bulunmadı');
    const m = p3dRun(['measure', '--file', 'garip.p3d.json'], dir);
    expect(m.code).toBe(0);
    expect(m.stdout).toContain(`⚠ 1 parça okunamadı ve atlandı (sonuçlara dahil değil):\n  - ${why}`);
    const s = p3dRun(['scene', '--file', 'garip.p3d.json'], dir);
    expect(s.stdout).toContain(`⚠ 1 parça okunamadı ve atlandı`);
    const full = p3dRun(['scene', '--file', 'garip.p3d.json', '--full'], dir);
    expect(JSON.parse(full.stdout).parts).toHaveLength(2); // stdout yalnızca JSON
    expect(full.stderr).toContain(why);
    const e = p3dRun(['export', 'garip.stl', '--file', 'garip.p3d.json'], dir);
    expect(e.code).toBe(1);
    expect(e.stderr).toContain(`1 parça okunamadı:\n  - ${why}`);
    expect(readdirSync(dir)).not.toContain('garip.stl');
  }, 60_000);

  it('scene --file --full dosyadaki gibi: src göreli, dosyada gömülü ağ gömülü, yoksa gömülmez', () => {
    const raw = JSON.parse(readFileSync(model, 'utf8'));
    const mesh = { ...raw.parts[0], id: 'p_ref', name: 'ref', shape: 'mesh', params: { scale: 1 }, role: 'reference', geom: { kind: 'mesh', asset: 'a_clikup01', src: 'alt/kup.obj', maxTris: 500 } };
    writeFileSync(path.join(dir, 'yol.p3d.json'), JSON.stringify({ ...raw, parts: [mesh] }));
    const yol = JSON.parse(p3dRun(['scene', '--file', 'yol.p3d.json', '--full'], dir).stdout);
    expect(yol.parts[0].geom).toMatchObject({ kind: 'mesh', asset: 'a_clikup01', src: 'alt/kup.obj', maxTris: 500 });
    expect(yol.assets).toBeUndefined();
    const asset = makeAsset('dortyuz', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]), 'a_clikup02');
    const embedded = { ...mesh, geom: { ...mesh.geom, asset: asset.id } };
    writeFileSync(path.join(dir, 'gomulu.p3d.json'), JSON.stringify({ ...raw, parts: [embedded], assets: { [asset.id]: asset } }));
    const gom = JSON.parse(p3dRun(['scene', '--file', 'gomulu.p3d.json', '--full'], dir).stdout);
    expect(gom.parts[0].geom).toEqual({ kind: 'mesh', asset: asset.id, src: 'alt/kup.obj', maxTris: 500 });
    expect(gom.assets).toEqual({ [asset.id]: asset });
  }, 60_000);

  it('scene --file: parça satırında grup, sonda grup listesi ve pivot', () => {
    const out = p3d(['scene', '--file', 'model.p3d.json'], dir);
    expect(out).toContain(`dosya: ${model}`);
    expect(out).toMatch(/ teker1 \[cylinder\] diameter=12 height=4 grup=teker \| konum=-12,-12,6/);
    expect(out).toContain('gruplar (1):\n  teker pivot=-12,-12,6 · 1 parça');
    expect(out).not.toMatch(/govde .*grup=/);
  }, 60_000);

  it('check --file --profile game: üçgen bütçesi; geçersiz profil hata', () => {
    const r = p3dRun(['check', '--file', 'model.p3d.json', '--profile', 'game', '--max-tris', '10'], dir);
    expect(r.code).toBe(0); // yalnızca uyarı
    expect(r.stdout).toContain('profil game (bütçe 10 üçgen)');
    expect(r.stdout).toMatch(/⚠ Toplam [\d.]+ üçgen; bütçe 10 aşıldı\. Parça başına: teker1/);
    const print = p3dRun(['check', '--file', 'model.p3d.json'], dir);
    expect(print.code).toBe(0);
    expect(print.stdout).toContain('✓ Sorun bulunmadı.');
    const bad = p3dRun(['check', '--file', 'model.p3d.json', '--profile', 'oyun'], dir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--profile print ya da game olmalı');
  }, 60_000);

  it('export --file: STL (başlık + üçgen sayısı), 3MF (parça başına nesne), GLB (başlık ve chunk\'lar)', () => {
    p3d(['export', 'out.stl', '--file', 'model.p3d.json'], dir);
    const stl = readFileSync(path.join(dir, 'out.stl'));
    const count = stl.readUInt32LE(80);
    expect(count).toBeGreaterThan(12);
    expect(stl.length).toBe(84 + 50 * count);

    p3d(['export', 'out.3mf', '--file', 'model.p3d.json'], dir);
    const files = unzipSync(new Uint8Array(readFileSync(path.join(dir, 'out.3mf'))));
    const xml = strFromU8(files['3D/3dmodel.model']);
    expect(xml.match(/<object /g)).toHaveLength(2);
    expect(xml).toContain('name="teker1"');

    const out = p3d(['export', 'out.glb', '--file', 'model.p3d.json', '--units', 'mm', '--parts', 'teker'], dir);
    expect(out).toContain('✓ 1 parça →');
    const glb = readFileSync(path.join(dir, 'out.glb'));
    expect(glb.toString('ascii', 0, 4)).toBe('glTF');
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const jsonLen = glb.readUInt32LE(12);
    expect(glb.toString('ascii', 16, 20)).toBe('JSON');
    const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));
    expect(json.asset).toMatchObject({ version: '2.0', generator: 'P3D', extras: { units: 'mm' } });
    expect(json.nodes.map((n: { name: string }) => n.name)).toEqual(['teker', 'teker1']);
    const binLen = glb.readUInt32LE(20 + jsonLen);
    expect(glb.toString('ascii', 24 + jsonLen, 28 + jsonLen)).toBe('BIN\0');
    expect(binLen).toBe(json.buffers[0].byteLength);
    expect(28 + jsonLen + binLen).toBe(glb.length);

    const bad = p3dRun(['export', 'x.stl', '--file', 'model.p3d.json', '--skeleton'], dir);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('yalnızca GLB için');
  }, 60_000);

  it('measure / section --file proje dosyasında; ağ dosyası scene için reddedilir', () => {
    expect(p3d(['measure', '--file', 'model.p3d.json', '--parts', 'govde'], dir)).toContain('govde [solid]: kutu -20,-10,0 → 20,10,10 (40,20,10), hacim 8 cm³');
    expect(p3d(['section', '--file', 'model.p3d.json', '--parts', 'govde', '--axis', 'z', '--at', '5'], dir)).toContain('alan 800 mm²');
    const mesh = p3dRun(['scene', '--file', 'alt/kup.obj'], dir);
    expect(mesh.code).toBe(1);
    expect(mesh.stderr).toContain('yalnızca section --file');
  }, 60_000);
});

describe('snapshot --file tarayıcısı (scripts/headless.ts)', () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p);

  it('findChrome: P3D_CHROME önce gelir (varlığı denetlenmez)', () => {
    expect(findChrome({ P3D_CHROME: 'X:/tarayici.exe' }, 'win32', () => false)).toBe('X:/tarayici.exe');
  });

  it("findChrome Windows: önce Chrome (Program Files → (x86) → LOCALAPPDATA), sonra Edge; PATH aranmaz", () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const chromeLocal = 'C:\\Users\\u\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    const chromePf = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    expect(findChrome(env, 'win32', has(edge, chromeLocal, chromePf))).toBe(chromePf);
    expect(findChrome(env, 'win32', has(edge, chromeLocal))).toBe(chromeLocal);
    expect(findChrome(env, 'win32', has(edge))).toBe(edge);
    expect(findChrome(env, 'win32', has())).toBeNull();
    expect(findChrome({ ...env, PATH: 'C:\\bin' }, 'win32', (p) => p.startsWith('C:\\bin'))).toBeNull();
    // Ortam değişkeni eksik kök atlanır.
    expect(findChrome({ LOCALAPPDATA: 'D:\\L' }, 'win32', has('D:\\L\\Google\\Chrome\\Application\\chrome.exe'))).toBe('D:\\L\\Google\\Chrome\\Application\\chrome.exe');
  });

  it('findChrome macOS: /Applications, sonra ~/Applications; Chrome → Chromium → Edge', () => {
    const user = '/Users/u/Applications/Chromium.app/Contents/MacOS/Chromium';
    expect(findChrome({ HOME: '/Users/u' }, 'darwin', has(user))).toBe(user);
    expect(findChrome({}, 'darwin', has('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    );
    expect(findChrome({ HOME: '/Users/u' }, 'darwin', has())).toBeNull();
  });

  it('findChrome Linux: standart yollar, sonra PATH sırasıyla', () => {
    expect(findChrome({ PATH: '/usr/local/bin' }, 'linux', has('/usr/bin/chromium', '/usr/local/bin/google-chrome'))).toBe('/usr/bin/chromium');
    expect(findChrome({ PATH: '/opt/x/bin:/usr/local/bin' }, 'linux', has('/usr/local/bin/chromium', '/opt/x/bin/microsoft-edge'))).toBe('/opt/x/bin/microsoft-edge');
    expect(findChrome({}, 'linux', has())).toBeNull();
  });

  it('launchHeadless: hemen kapanan süreç failure() ile bildirilir; close() profili siler', async () => {
    const mine = () => readdirSync(tmpdir()).filter((f) => f.startsWith('p3d-chrome-'));
    const before = new Set(mine());
    // Node, Chrome bayraklarını tanımaz ve hemen çıkar: ana süreç bitmişken kapatma yolu (Windows'ta taskkill çalışmaz).
    const b = launchHeadless(process.execPath, 'http://127.0.0.1:9/');
    for (let i = 0; i < 200 && !b.failure(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(b.failure()).toMatch(/^Tarayıcı beklenmedik biçimde kapandı \(çıkış kodu \d+\)\.$/);
    expect(mine().filter((f) => !before.has(f))).toHaveLength(1);
    await b.close();
    await b.close(); // ikinci çağrı zararsız
    expect(mine().filter((f) => !before.has(f))).toEqual([]);
  }, 30_000);
});

describe('p3d guide / skill install', () => {
  it('guide: konu listesi, konu metni, bilinmeyen konuda çıkış 1', () => {
    const topics = guideTopics();
    expect(topics.length).toBeGreaterThan(0);
    const index = p3dRun(['guide'], dir);
    expect(index.code).toBe(0);
    expect(index.stdout).toContain(`Konular: ${topics.join(', ')}`);
    const topic = p3dRun(['guide', topics[0]], dir);
    expect(topic.code).toBe(0);
    expect(topic.stdout.trimEnd()).toBe(readFileSync(path.join(GUIDE_DIR, `${topics[0]}.md`), 'utf8').trimEnd());
    const unknown = p3dRun(['guide', 'boyle-bir-konu-yok'], dir);
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toContain("Bilinmeyen konu: 'boyle-bir-konu-yok'.");
    expect(unknown.stdout).toContain('Konular:');
  }, 60_000);

  it('skill install P3D_SKILLS_DIR altına kopyalar; tekrarında aynı, değişmişse yedekleyip üzerine yazdığını söyler', () => {
    const skills = path.join(dir, 'skills');
    const env = { P3D_SKILLS_DIR: skills };
    const dest = path.join(skills, 'p3d', 'SKILL.md');
    expect(p3dRun(['skill', 'install'], dir, { env }).stdout).toContain(`✓ Skill kuruldu: ${dest}`);
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(SKILL_SOURCE, 'utf8'));
    expect(p3dRun(['skill', 'install'], dir, { env }).stdout).toContain('zaten güncel');
    writeFileSync(dest, 'eski');
    const upd = p3dRun(['skill', 'install'], dir, { env }).stdout;
    expect(upd).toContain('üzerine yazıldı');
    expect(upd).toContain(`önceki içerik yedeklendi: ${dest}.bak`);
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(SKILL_SOURCE, 'utf8'));
    expect(readFileSync(`${dest}.bak`, 'utf8')).toBe('eski');
    expect(p3dRun(['skill'], dir).code).toBe(1);
  }, 60_000);
});
