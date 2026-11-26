// `p3d dev --detach` ve `p3d stop` (BoltRush isteği #3): geliştirme sunucusunu terminalden bağımsız (ayrık) başlatmak ve
// hangi yolla başlatılmış olursa olsun durdurmak. Ön planda `p3d dev` çıktısı boruya bağlanınca (`| head`) boru kapanınca
// sunucu da kapanıyordu; Windows'ta arka plan görevini durdurmak alt node sürecini açık bırakıp portu meşgul tutuyordu.
//
// Ayrık süreç: `npm run dev -- …` kendi süreç grubunda, girdi kapalı, çıktısı geçici klasördeki günlüğe (port başına
// `p3d-dev-<port>.log`). PID ve adres `p3d-dev-<port>.json` durum dosyasına yazılır (yalnızca bilgi: `status`). `stop` yalnızca
// `/api/status`'ü P3D gibi yanıtlayan bir sunucuyu durdurur (aynı porttaki başka uygulamaya dokunmaz) ve yalnızca **portu dinleyen**
// süreci (alt süreçleriyle) kapatır — durum dosyasındaki PID'e güvenilmez: sunucu çöktükten ya da makine yeniden başladıktan sonra
// o PID başka bir sürece geçmiş olabilir. Dinleyen node süreci kapanınca `npm` / `cmd` sarmalayıcıları kendiliğinden çıkar.
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

/** `--host` bayrağı (başlatıcıya giden); joker adreste (0.0.0.0, ::) ya da yoksa localhost'tan denetlenir. */
export function devHost(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const v = args[i] === '--host' ? args[i + 1] : args[i].startsWith('--host=') ? args[i].slice('--host='.length) : undefined;
    if (v && v !== '0.0.0.0' && v !== '::' && v !== 'true') return v.includes(':') ? `[${v}]` : v;
  }
  return 'localhost';
}

/** Portta P3D sunucusu mu çalışıyor (`/api/status` P3D'ye özgü alanlarla yanıt veriyor). */
export async function p3dAt(port: number, timeoutMs = 1500, host = 'localhost'): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}/api/status`, { signal: AbortSignal.timeout(timeoutMs) });
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
  // Port açıkça başlatıcıya gider (P3D_URL'den gelen port da): beklenen portla sunucunun portu ayrışmasın.
  const flags = args.some((a) => a === '--port' || a.startsWith('--port=')) ? args : [...args, `--port=${port}`];
  // Port başka bir uygulamada: Vite bir sonraki porta kayar, beklenen port hiç yanıt vermezdi.
  if (listeningPid(port)) throw new Error(`Port ${port} başka bir uygulamada (P3D değil); başka port verin: p3d dev --detach --port N`);
  const host = devHost(flags);
  const log = devLogFile(port);
  const fd = openSync(log, 'w');
  const win = process.platform === 'win32';
  let exited: number | null | undefined;
  let spawnError: string | undefined;
  let child;
  try {
    child = spawn(win ? 'npm.cmd' : 'npm', ['run', 'dev', '--', ...flags], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      shell: win,
    });
  } finally {
    closeSync(fd);
  }
  child.on('error', (e) => (spawnError = e.message));
  child.on('exit', (code) => (exited = code));
  child.unref();
  if (!child.pid) {
    await sleep(50); // 'error' olayı bir sonraki turda gelir
    throw new Error(`Sunucu başlatılamadı (npm bulunamadı?${spawnError ? ` ${spawnError}` : ''}). Günlük: ${log}`);
  }
  const state: DevState = { pid: child.pid, port, url: `http://${host}:${port}`, log, started: new Date().toISOString() };
  writeFileSync(devStateFile(port), JSON.stringify(state, null, 2));
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (await p3dAt(port, 1000, host)) return state;
    if (exited !== undefined || spawnError) break;
    await sleep(300);
  }
  if (exited === undefined) killTree(child.pid, true);
  rmSync(devStateFile(port), { force: true });
  const tail = logTail(log);
  throw new Error(
    `${exited !== undefined ? `Sunucu başlarken kapandı (çıkış ${exited})` : `Sunucu ${Math.round(waitMs / 1000)} sn içinde yanıt vermedi (durduruldu)`}. ` +
      `Günlük: ${log}${tail ? `\n${tail}` : ''}`,
  );
}

/** Portu dinleyen sürecin PID'i (Windows: netstat; diğerleri: lsof, yoksa ss); bulunamazsa undefined. */
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
    try {
      const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const pid = Number(out.trim().split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // lsof yok ya da dinleyen yok: ss'e bak
    }
    // ss -ltnpH 'sport = :5173' → … users:(("node",pid=1234,fd=23))
    const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /pid=(\d+)/.exec(out);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Süreci alt süreçleriyle kapatır. `group`: süreç grubunun lideri olduğu biliniyor (yalnızca kendi başlattığımız, henüz
 * yaşayan çocuk) — POSIX'te tüm grup; değilse yalnızca süreç (dinleyen node; sarmalayıcılar kendiliğinden çıkar).
 */
function killTree(pid: number, group = false): void {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(group ? -pid : pid, 'SIGTERM');
  } catch {
    // zaten kapanmış
  }
}

export type StopResult = { stopped: true; pids: number[] } | { stopped: false; reason: 'not-running' | 'not-p3d-pid' | 'still-running'; pids: number[] };

/**
 * Portta çalışan P3D sunucusunu durdurur: portu dinleyen süreç (ayrık, ön planda ya da başka yolla başlatılmış; `npm run dev`'in
 * alt node süreci) alt süreçleriyle kapatılır. Durum dosyasındaki PID kullanılmaz (yeniden kullanılmış olabilir). Portta P3D yanıt
 * vermiyorsa hiçbir şeyi kapatmaz.
 */
export async function stopServer(port: number, waitMs = 10_000): Promise<StopResult> {
  const state = readDevState(port);
  if (!(await p3dAt(port))) {
    if (state) rmSync(devStateFile(port), { force: true });
    return { stopped: false, reason: 'not-running', pids: [] };
  }
  const listen = listeningPid(port);
  if (!listen) return { stopped: false, reason: 'not-p3d-pid', pids: [] };
  const pids = [listen];
  killTree(listen);
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
