// `p3d snapshot --file` için makinedeki Chrome/Edge'i görünmez (headless) açar ve süreç ağacıyla birlikte kapatır
// (scripts/p3d.ts kullanır; ayrı modül ki testler içe aktarabilsin). WebGL görüntü alma SwiftShader ile çalışır.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Tarayıcı yolu: P3D_CHROME > standart kurulum yolları (Chrome, sonra Edge/Chromium) > PATH (macOS/Linux, `which`
 * gibi). Bulunamazsa null. P3D_CHROME verilmişse varlığı denetlenmeden döner (çağıran yoksa açıklayıcı hata verir).
 */
export function findChrome(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform, exists: (p: string) => boolean = existsSync): string | null {
  if (env.P3D_CHROME) return env.P3D_CHROME;
  const candidates: string[] = [];
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((r): r is string => !!r);
    for (const r of roots) candidates.push(path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const r of roots) candidates.push(path.win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (platform === 'darwin') {
    for (const root of ['/Applications', ...(env.HOME ? [path.posix.join(env.HOME, 'Applications')] : [])]) {
      candidates.push(
        `${root}/Google Chrome.app/Contents/MacOS/Google Chrome`,
        `${root}/Chromium.app/Contents/MacOS/Chromium`,
        `${root}/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
      );
    }
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge');
  }
  const hit = candidates.find((c) => exists(c));
  if (hit) return hit;
  if (platform !== 'win32') {
    for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
        const p = path.posix.join(dir, name);
        if (exists(p)) return p;
      }
    }
  }
  return null;
}

export interface HeadlessBrowser {
  /** Süreç beklenmedik biçimde bittiyse ya da başlatılamadıysa açıklama; çalışıyorsa null. */
  failure(): string | null;
  /** Süreç ağacını kapatır ve geçici profili siler (her durumda çağrılmalı; birden çok çağrı zararsız). */
  close(): Promise<void>;
}

/** Tarayıcıyı geçici bir profille görünmez açar ve `url`'yi yükler. */
export function launchHeadless(chrome: string, url: string): HeadlessBrowser {
  const profile = mkdtempSync(path.join(tmpdir(), 'p3d-chrome-'));
  let failure: string | null = null;
  let exited = false;
  let proc: ChildProcess;
  try {
    proc = spawn(
      chrome,
      [
        '--headless=new',
        '--no-first-run',
        '--no-default-browser-check',
        '--enable-unsafe-swiftshader',
        '--window-size=1280,800',
        `--user-data-dir=${profile}`,
        url,
      ],
      // POSIX'te ayrı süreç grubu: kapatırken tüm ağaç (-pid) öldürülür. Windows'ta taskkill /T.
      { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true },
    );
  } catch (e) {
    rmSync(profile, { recursive: true, force: true });
    throw new Error(`Tarayıcı başlatılamadı (${chrome}): ${(e as Error).message}`);
  }
  proc.once('error', (e) => {
    failure = `Tarayıcı başlatılamadı (${chrome}): ${e.message}`;
    exited = true;
  });
  const exitWait = new Promise<void>((resolve) =>
    proc.once('exit', (code, signal) => {
      exited = true;
      failure ??= `Tarayıcı beklenmedik biçimde kapandı (${signal ?? `çıkış kodu ${code}`}).`;
      resolve();
    }),
  );
  let closing: Promise<void> | null = null;
  return {
    failure: () => failure,
    close: () =>
      (closing ??= (async () => {
        failure ??= 'kapatıldı';
        const pid = proc.pid;
        if (pid !== undefined) {
          if (process.platform === 'win32') {
            // Ana süreç bitmiş olsa da çalıştırılır: /T alt süreçleri (GPU, render) de kapatır.
            await new Promise<void>((resolve) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
          } else {
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              try {
                proc.kill('SIGKILL');
              } catch {
                // zaten kapanmış
              }
            }
          }
          if (!exited) await Promise.race([exitWait, new Promise((r) => setTimeout(r, 5000))]);
        }
        // Windows'ta kapanan süreçler profil dosyalarını kısa bir süre kilitli tutabilir.
        try {
          rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
        } catch (e) {
          console.error(`⚠ Geçici tarayıcı profili silinemedi: ${profile} (${(e as Error).message})`);
        }
      })()),
  };
}
