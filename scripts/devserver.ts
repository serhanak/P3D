// `p3d dev --detach` ve `p3d stop` (BoltRush isteği #3): geliştirme sunucusunu terminalden bağımsız (ayrık) başlatmak ve
// hangi yolla başlatılmış olursa olsun durdurmak. Ön planda `p3d dev` çıktısı boruya bağlanınca (`| head`) boru kapanınca
// sunucu da kapanıyordu; Windows'ta arka plan görevini durdurmak alt node sürecini açık bırakıp portu meşgul tutuyordu.
//
// Ayrık süreç: `npm run dev -- …` kendi süreç grubunda, girdi kapalı, çıktısı geçici klasördeki günlüğe (port başına
// `p3d-dev-<port>.log`). PID ve adres `p3d-dev-<port>.json` durum dosyasına yazılır. `stop` yalnızca `/api/status`'ü P3D gibi
// yanıtlayan bir sunucuyu durdurur (aynı porttaki başka uygulamaya dokunmaz): durum dosyasındaki süreç ağacını ve portu
// dinleyen süreci kapatır (Windows `taskkill /T /F`, diğerlerinde süreç grubu SIGTERM).
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 5173;

/** Ayrık sunucunun durum dosyası. */
export interface DevState {
  pid: number;
  port: number;
  url: string;
  log: string;
  started: string;
}

export const devStateFile = (port: number) => path.join(tmpdir(), `p3d-dev-${port}.json`);
export const devLogFile = (port: number) => path.join(tmpdir(), `p3d-dev-${port}.log`);

export function readDevState(port: number): DevState | undefined {
  try {
    const s = JSON.parse(readFileSync(devStateFile(port), 'utf8')) as DevState;
    return Number.isInteger(s.pid) && s.port === port ? s : undefined;
  } catch {
    return undefined;
  }
}

/** `--port N` / `--port=N` bayrağı, yoksa adresin (P3D_URL) portu, o da yoksa 5173. */
export function devPort(args: string[], base: string): number {
  for (let i = 0; i < args.length; i++) {
    const v = args[i] === '--port' ? args[i + 1] : args[i].startsWith('--port=') ? args[i].slice('--port='.length) : undefined;
    if (v === undefined) continue;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`--port 1–65535 arası tam sayı olmalı ('${v}').`);
    return n;
  }
  const u = new URL(base);
  return u.port ? Number(u.port) : DEFAULT_PORT;
}

/** Portta P3D sunucusu mu çalışıyor (`/api/status` P3D'ye özgü alanlarla yanıt veriyor). */
export async function p3dAt(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch(`http://localhost:${port}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = (await r.json()) as Record<string, unknown>;
    return typeof j.bridge === 'boolean' && 'llm' in j && 'backend' in j;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Günlüğün son satırları (hata iletisi için). */
function logTail(file: string, lines = 15): string {
  try {
    return readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Sunucuyu ayrık başlatır ve `/api/status` yanıt verene kadar bekler (en çok `waitMs`). Başlatıcı bayrakları (`args`) aynen
 * `npm run dev -- …`'a gider. Sunucu erken kapanır ya da süre dolarsa günlüğün sonuyla hata.
 */
export async function startDetached(repoRoot: string, args: string[], port: number, waitMs = 60_000): Promise<DevState> {
  const log = devLogFile(port);
  const fd = openSync(log, 'w');
  const win = process.platform === 'win32';
  let exited: number | null | undefined;
  let child;
  try {
    child = spawn(win ? 'npm.cmd' : 'npm', ['run', 'dev', ...(args.length ? ['--', ...args] : [])], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      shell: win,
    });
  } finally {
    closeSync(fd);
  }
  child.on('exit', (code) => (exited = code));
  child.unref();
  if (!child.pid) throw new Error(`Sunucu başlatılamadı (npm bulunamadı?). Günlük: ${log}`);
  const state: DevState = { pid: child.pid, port, url: `http://localhost:${port}`, log, started: new Date().toISOString() };
  writeFileSync(devStateFile(port), JSON.stringify(state, null, 2));
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (await p3dAt(port, 1000)) return state;
    if (exited !== undefined) break;
    await sleep(300);
  }
  if (exited === undefined) killTree(child.pid);
  rmSync(devStateFile(port), { force: true });
  const tail = logTail(log);
  throw new Error(
    `${exited !== undefined ? `Sunucu başlarken kapandı (çıkış ${exited})` : `Sunucu ${Math.round(waitMs / 1000)} sn içinde yanıt vermedi (durduruldu)`}. ` +
      `Günlük: ${log}${tail ? `\n${tail}` : ''}`,
  );
}

/** Portu dinleyen sürecin PID'i (Windows: netstat; diğerleri: lsof); bulunamazsa undefined. */
export function listeningPid(port: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
      for (const line of out.split(/\r?\n/)) {
        const f = line.trim().split(/\s+/);
        // TCP  127.0.0.1:5173  0.0.0.0:0  LISTENING  1234   (IPv6: [::1]:5173)
        if (f.length >= 5 && f[3] === 'LISTENING' && f[1].endsWith(`:${port}`)) return Number(f[4]) || undefined;
      }
      // TCPv6 satırları ayrı listelenir.
      const out6 = execFileSync('netstat', ['-ano', '-p', 'TCPv6'], { encoding: 'utf8', windowsHide: true });
      for (const line of out6.split(/\r?\n/)) {
        const f = line.trim().split(/\s+/);
        if (f.length >= 5 && f[3] === 'LISTENING' && f[1].endsWith(`:${port}`)) return Number(f[4]) || undefined;
      }
      return undefined;
    }
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Süreci alt süreçleriyle kapatır. */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else {
      try {
        process.kill(-pid, 'SIGTERM'); // ayrık başlatılan: süreç grubunun lideri
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    // zaten kapanmış
  }
}

export type StopResult = { stopped: true; pids: number[] } | { stopped: false; reason: 'not-running' | 'not-p3d-pid' | 'still-running'; pids: number[] };

/**
 * Portta çalışan P3D sunucusunu durdurur: durum dosyasındaki süreç ağacı (ayrık başlatılan) ve portu dinleyen süreç (ön planda
 * ya da başka yolla başlatılan; `npm run dev`'in alt node süreci). Portta P3D yanıt vermiyorsa hiçbir şeyi kapatmaz.
 */
export async function stopServer(port: number, waitMs = 10_000): Promise<StopResult> {
  const state = readDevState(port);
  if (!(await p3dAt(port))) {
    if (state && !alive(state.pid)) rmSync(devStateFile(port), { force: true });
    return { stopped: false, reason: 'not-running', pids: [] };
  }
  const pids: number[] = [];
  if (state && alive(state.pid)) pids.push(state.pid);
  const listen = listeningPid(port);
  if (listen && !pids.includes(listen)) pids.push(listen);
  if (!pids.length) return { stopped: false, reason: 'not-p3d-pid', pids };
  for (const pid of pids) killTree(pid);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!(await p3dAt(port, 500))) {
      rmSync(devStateFile(port), { force: true });
      return { stopped: true, pids };
    }
    await sleep(200);
  }
  return { stopped: false, reason: 'still-running', pids };
}

/** Ayrık sunucunun durum dosyası varsa ve süreç yaşıyorsa. */
export function detachedInfo(port: number): DevState | undefined {
  const s = readDevState(port);
  if (s && !alive(s.pid)) {
    if (existsSync(devStateFile(port))) rmSync(devStateFile(port), { force: true });
    return undefined;
  }
  return s;
}
