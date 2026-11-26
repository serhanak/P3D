// Node'da görüntü (BoltRush isteği #2): bir projenin PNG görüntüleri, betikten (`p3d run`) ve `p3d snapshot --file`'dan.
// Görüntüyü uygulamanın kendisi çizer (WebGL, görünmez Chrome/Edge): proje geçici bir çalışma alanının sekmesine yüklenir ve
// köprüyle `snapshot` istenir (ekrandaki görüntüyle aynı). Sunucu: verilen adres, yoksa çalışan P3D sunucusu (`P3D_URL`,
// varsayılan http://localhost:5173), o da yoksa bu süreçte **geçici** bir Vite sunucusu (127.0.0.1, boş port, köprü açık,
// dosya izleme ve HMR kapalı) açılır ve oturum kapanınca kapatılır — betik için ayrıca `p3d dev` gerekmez.
//
// Tek görüntü: `snapshot(project, {views, size, out})` (sunucu ve tarayıcıyı açar, kapatır). Çok görüntü: `snapshotSession()`
// ile bir kez açıp `session.snapshot(…)` (her çağrıda proje aynı sekmeye yeniden yüklenir), sonunda `session.close()`.
// Yalnızca Node (tarayıcı paketine girmez).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SNAPSHOT_VIEWS,
  fitSnapshotSize,
  wsPath,
  type BridgeResult,
  type BridgeWorkspace,
  type SnapshotOptions,
  type SnapshotView,
} from '../shared/ops';
import { usedAssets } from './assets';
import type { Project } from './types';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Görünmez sekmenin bağlanması için en uzun bekleme. */
const CONNECT_MS = 30_000;

/** Görüntü seçenekleri: `SnapshotOptions` alanları (hepsi isteğe bağlı) + boyut, çıktı klasörü. */
export interface NodeSnapshotOptions extends Partial<Omit<SnapshotOptions, 'width' | 'height'>> {
  /** 'GENxYÜK' (ör. '1000x750'); ya da `width` / `height`. Kenar 200–4096 piksel aralığına orantılı oturtulur. */
  size?: string;
  width?: number;
  height?: number;
  /** Verilirse PNG'ler bu klasöre `<görünüm>.png` olarak yazılır (göreli yol süreç klasörüne göre). */
  out?: string;
}

/** Sunucu seçimi: 'auto' (varsayılan: çalışan P3D sunucusu, yoksa geçici), 'temporary' (her zaman geçici) ya da adres. */
export interface NodeSnapshotSessionOptions {
  server?: 'auto' | 'temporary' | string;
}

export interface NodeSnapshotResult {
  images: { view: SnapshotView; png: Buffer; file?: string }[];
  /** Yükleme ve görüntü hataları (ör. bulunamayan `parts` adı); boşsa her görüntü alındı. */
  errors: string[];
  /** Sekmenin sahne özeti (yüklenen proje). */
  scene: BridgeResult['scene'];
}

export interface SnapshotSession {
  /** Kullanılan sunucunun adresi. */
  readonly server: string;
  /** Sunucu bu oturum için açıldıysa true (`close` kapatır). */
  readonly temporary: boolean;
  snapshot(project: Project, opts?: NodeSnapshotOptions): Promise<NodeSnapshotResult>;
  /** Tarayıcıyı ve (geçiciyse) sunucuyu kapatır; birden çok çağrı zararsız. */
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call(base: string, method: string, p: string, body?: unknown): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(base + p, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new HttpError(0, `${base} adresine bağlanılamadı.`);
  }
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new HttpError(r.status, data.error ?? `HTTP ${r.status}`);
  return data;
}

/** Adreste köprüsü açık bir P3D sunucusu var mı. */
async function bridgeUp(base: string): Promise<boolean> {
  try {
    return Array.isArray(await call(base, 'GET', '/api/bridge/workspaces'));
  } catch {
    return false;
  }
}

/**
 * Geçici sunucuların değiştirdiği ortam: köprü açık olmalı (`P3D_BRIDGE`, istek anında okunur) ve vite.config.ts çağıranın
 * klasöründeki `.env`'den eksik anahtarları yazar. İlk sunucu açılırken anlık görüntü alınır, son sunucu kapanınca (hata
 * yollarında da) geri yüklenir; aynı süreçte iç içe oturumlar sayaçla.
 */
const ENV_KEYS = ['P3D_BRIDGE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'P3D_MODEL', 'P3D_EFFORT', 'P3D_LLM', 'P3D_CLAUDE_BIN'];
let envUsers = 0;
let envSaved: Record<string, string | undefined> = {};
function acquireEnv(): void {
  if (envUsers++ === 0) envSaved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.P3D_BRIDGE = '1';
}
function releaseEnv(): void {
  if (--envUsers > 0) return;
  for (const k of ENV_KEYS) {
    if (envSaved[k] === undefined) delete process.env[k];
    else process.env[k] = envSaved[k];
  }
}

/** Bu süreçte geçici Vite sunucusu (depodaki vite.config.ts; köprü açık). */
async function startTemporaryServer(): Promise<{ url: string; close: () => Promise<void> }> {
  acquireEnv();
  let server: import('vite').ViteDevServer | undefined;
  try {
    const { createServer } = await import('vite');
    server = await createServer({
      root: REPO_ROOT,
      configFile: path.join(REPO_ROOT, 'vite.config.ts'),
      logLevel: 'error',
      clearScreen: false,
      server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
    });
    await server.listen();
    const addr = server.httpServer?.address();
    if (!addr || typeof addr === 'string') throw new Error('Geçici P3D sunucusunun adresi okunamadı.');
    const s = server;
    let closed = false;
    return {
      url: `http://127.0.0.1:${addr.port}`,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await s.close();
        } finally {
          releaseEnv();
        }
      },
    };
  } catch (e) {
    try {
      await server?.close();
    } finally {
      releaseEnv();
    }
    throw e;
  }
}

/** 'GENxYÜK' / width-height → sınırlara oturtulmuş boyut (geçersiz yazımda hata). */
function sizeOf(opts: NodeSnapshotOptions): { width: number; height: number } {
  let w = opts.width ?? 1000;
  let h = opts.height ?? 750;
  if (opts.size !== undefined) {
    const m = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(opts.size);
    if (!m) throw new Error(`size GENİŞLİKxYÜKSEKLİK (piksel) olmalı, ör. '1000x750' ('${opts.size}').`);
    [w, h] = [Number(m[1]), Number(m[2])];
  }
  if (!(w >= 1 && h >= 1)) throw new Error(`Görüntü boyutu pozitif olmalı (${w}x${h}).`);
  return fitSnapshotSize(w, h);
}

/** Seçeneklerden köprüye giden istek (CLI ile aynı doğrulamalar). */
export function nodeSnapshotRequest(opts: NodeSnapshotOptions = {}): SnapshotOptions {
  const views = opts.views?.length ? [...opts.views] : (['iso', 'front', 'right', 'top'] as SnapshotView[]);
  const unknown = views.filter((v) => !(SNAPSHOT_VIEWS as readonly string[]).includes(v));
  if (unknown.length) throw new Error(`Bilinmeyen görünüm: ${unknown.join(', ')} (olanlar: ${SNAPSHOT_VIEWS.join(', ')}).`);
  if (views.includes('camera') && !opts.camera?.eye) throw new Error('camera görünümü camera.eye ister (kamera konumu, mm).');
  if (opts.parts?.length && opts.focus?.length) throw new Error('parts (yalnızca bu parçalar) ile focus (bu parçalara sığdır) birlikte verilmez.');
  return {
    views,
    ...sizeOf(opts),
    dims: opts.dims === true,
    ...(opts.camera ? { camera: opts.camera } : {}),
    ...(opts.style ? { style: opts.style } : {}),
    ...(opts.projection ? { projection: opts.projection } : {}),
    ...(opts.parts?.length ? { parts: opts.parts } : {}),
    ...(opts.focus?.length ? { focus: opts.focus } : {}),
  };
}

/** Görünmez sekme (iç kullanım: `snapshotSession` ve `p3d snapshot --file`). `send` sekmeye köprü isteği yollar. */
export interface SnapshotTab {
  server: string;
  temporary: boolean;
  send(project: Project, req: SnapshotOptions): Promise<{ load: BridgeResult; result: BridgeResult }>;
  close(): Promise<void>;
}

/**
 * Sunucuyu seçer (gerekirse geçici açar), görünmez Chrome/Edge'i geçici bir çalışma alanında açar ve sekmenin bağlanmasını
 * bekler. Tarayıcı `P3D_CHROME` ya da standart kurulum yollarından bulunur.
 */
export async function openSnapshotTab(opts: NodeSnapshotSessionOptions = {}): Promise<SnapshotTab> {
  const want = opts.server ?? 'auto';
  let base: string | undefined;
  let stopServer: (() => Promise<void>) | undefined;
  if (want !== 'temporary') {
    const url = (want === 'auto' ? process.env.P3D_URL || 'http://localhost:5173' : want).replace(/\/$/, '');
    if (await bridgeUp(url)) base = url;
    else if (want !== 'auto') throw new Error(`${url}: köprüsü açık bir P3D sunucusu yanıt vermiyor.`);
  }
  if (!base) {
    const t = await startTemporaryServer();
    base = t.url;
    stopServer = t.close;
  }
  // Tarayıcı açılamazsa (bulunamadı, çalıştırılamadı) geçici sunucu kapatılır.
  let browser: import('../scripts/headless').HeadlessBrowser;
  let chrome: string;
  const ws = `_snap-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const { findChrome, launchHeadless } = await import('../scripts/headless');
    const { existsSync } = await import('node:fs');
    const found = findChrome();
    if (!found) throw new Error('Chrome ya da Edge bulunamadı. Tarayıcının çalıştırılabilir dosyasını P3D_CHROME ortam değişkenine yazın.');
    if (!existsSync(found)) throw new Error(`Tarayıcı bulunamadı: ${found}${process.env.P3D_CHROME ? ' (P3D_CHROME)' : ''}`);
    chrome = found;
    browser = launchHeadless(chrome, base + wsPath(ws));
  } catch (e) {
    await stopServer?.();
    throw e;
  }
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      try {
        await browser.close();
      } finally {
        await stopServer?.();
      }
    })());
  // Bağlanma beklenirken Ctrl+C: görünmez tarayıcı, geçici profil ve geçici sunucu geride kalmasın (bekleme bitince kaldırılır).
  const interrupted = () => void close().finally(() => process.exit(130));
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const deadline = Date.now() + CONNECT_MS;
    for (;;) {
      const spaces = (await call(base, 'GET', '/api/bridge/workspaces')) as BridgeWorkspace[];
      if (spaces.some((s) => s.ws === ws && s.tabs > 0)) break;
      const failed = browser.failure();
      if (failed) throw new Error(`${failed} (${chrome})`);
      if (Date.now() > deadline) throw new Error(`Görünmez tarayıcı ${CONNECT_MS / 1000} sn içinde sekmeyi bağlayamadı (${base + wsPath(ws)}).`);
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    await close();
    throw e;
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
  const post = async (body: Record<string, unknown>) => (await call(base!, 'POST', '/api/bridge/ops', { ws, ...body })) as BridgeResult;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    server: base,
    temporary: !!stopServer,
    close,
    // Aynı sekmede load + snapshot çifti bölünmemeli: eşzamanlı çağrılar sıraya girer (A'nın görüntüsü B olmasın).
    send(project, req) {
      const run = async () => {
        if (closing) throw new Error('Görüntü oturumu kapatıldı.');
        const load = await post({ action: 'load', project, assets: usedAssets(project), label: `snapshot: ${project.name}` });
        return { load, result: await post({ action: 'snapshot', snapshot: req }) };
      };
      const next = queue.then(run, run);
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** Görüntü oturumu: sunucu ve görünmez tarayıcı bir kez açılır, her `snapshot` projeyi aynı sekmeye yükler. */
export async function snapshotSession(opts: NodeSnapshotSessionOptions = {}): Promise<SnapshotSession> {
  const tab = await openSnapshotTab(opts);
  return {
    server: tab.server,
    temporary: tab.temporary,
    close: tab.close,
    async snapshot(project: Project, o: NodeSnapshotOptions = {}): Promise<NodeSnapshotResult> {
      const req = nodeSnapshotRequest(o); // geçersiz seçenek yüklemeden önce hata versin
      const { load, result: r } = await tab.send(project, req);
      const out = o.out ? path.resolve(o.out) : undefined;
      if (out) mkdirSync(out, { recursive: true });
      const images = (r.images ?? []).map((img) => {
        const png = Buffer.from(img.png.replace(/^data:image\/png;base64,/, ''), 'base64');
        const file = out ? path.join(out, `${img.view}.png`) : undefined;
        if (file) writeFileSync(file, png);
        return { view: img.view, png, ...(file ? { file } : {}) };
      });
      return { images, errors: [...load.errors, ...r.errors], scene: r.scene };
    },
  };
}

/** Tek seferlik görüntü: oturumu açar, görüntüyü alır, kapatır (bkz. `snapshotSession`). */
export async function snapshot(project: Project, opts: NodeSnapshotOptions & NodeSnapshotSessionOptions = {}): Promise<NodeSnapshotResult> {
  const s = await snapshotSession({ server: opts.server });
  try {
    return await s.snapshot(project, opts);
  } finally {
    await s.close();
  }
}
