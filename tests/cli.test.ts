import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GUIDE_DIR, SKILL_SOURCE, guideTopics } from '../scripts/guide';

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

  it('skill install P3D_SKILLS_DIR altına kopyalar; tekrarında aynı, değişmişse üzerine yazdığını söyler', () => {
    const skills = path.join(dir, 'skills');
    const env = { P3D_SKILLS_DIR: skills };
    const dest = path.join(skills, 'p3d', 'SKILL.md');
    expect(p3dRun(['skill', 'install'], dir, { env }).stdout).toContain(`✓ Skill kuruldu: ${dest}`);
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(SKILL_SOURCE, 'utf8'));
    expect(p3dRun(['skill', 'install'], dir, { env }).stdout).toContain('zaten güncel');
    writeFileSync(dest, 'eski');
    expect(p3dRun(['skill', 'install'], dir, { env }).stdout).toContain('üzerine yazıldı');
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(SKILL_SOURCE, 'utf8'));
    expect(p3dRun(['skill'], dir).code).toBe(1);
  }, 60_000);
});
