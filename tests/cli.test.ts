import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Global `p3d` komutu (bin/p3d.mjs) başka klasörlerden çalıştırılır; section --file sunucu gerektirmez.
const BIN = fileURLToPath(new URL('../bin/p3d.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 10 mm küp (OBJ, dışa bakan yüzler). */
const CUBE_OBJ = [
  ...[[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]].map((v) => `v ${v.join(' ')}`),
  'f 1 3 2', 'f 1 4 3', 'f 5 6 7', 'f 5 7 8', 'f 1 2 6', 'f 1 6 5',
  'f 2 3 7', 'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8',
].join('\n');

let dir: string;

function p3d(args: string[], cwd: string, env: Record<string, string> = {}): string {
  // Testin kendi npm ortamı (npm_lifecycle_event, INIT_CWD) sızmasın. Windows'ta ad büyük harfle de gelebilir
  // (NPM_LIFECYCLE_EVENT); iki yazım birlikte verilirse alt süreçte hangisinin kazanacağı belirsizdir.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['init_cwd', 'npm_lifecycle_event'].includes(k.toLowerCase())));
  return execFileSync(process.execPath, [BIN, ...args], { cwd, env: { ...base, ...env }, encoding: 'utf8' });
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
