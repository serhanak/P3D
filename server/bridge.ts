// Claude Code köprüsü: terminaldeki bir ajan (ya da `npm run cli`) açık tarayıcı sayfasının sahnesini okur
// ve ona işlem (Op) listesi gönderir. Sunucu durumsuzdur: sahneyi tarayıcı bildirir, işlemleri tarayıcı uygular.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SNAPSHOT_VIEWS,
  type BridgeAction,
  type BridgeCommand,
  type BridgeResult,
  type MeshAsset,
  type Op,
  type SceneSummary,
  type SnapshotOptions,
  type SnapshotView,
} from '../shared/ops.ts';

interface SceneState {
  summary: SceneSummary;
  project: unknown;
  at: string;
}

const RESULT_TIMEOUT_MS = 10_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const MB = 1024 * 1024;

/**
 * Köprü durumu globalThis'te tutulur: geliştirme sunucusu bu modülü değişiklikte yeniden yüklediğinde
 * (ssrLoadModule) bağlı sekmeler, sahne ve bekleyen istekler kaybolmasın.
 */
interface BridgeState {
  scene: SceneState | null;
  assets: Map<string, MeshAsset>;
  clients: ServerResponse[];
  pending: Map<string, (r: BridgeResult) => void>;
  seq: number;
}
const G = globalThis as typeof globalThis & { __p3dBridge?: BridgeState };
const state: BridgeState = (G.__p3dBridge ??= { scene: null, assets: new Map(), clients: [], pending: new Map(), seq: 0 });


function keepAssets(list: unknown[]): void {
  for (const a of list) {
    const m = a as Partial<MeshAsset> | null;
    if (m && typeof m.id === 'string' && typeof m.positions === 'string' && typeof m.indices === 'string') state.assets.set(m.id, m as MeshAsset);
  }
}

function sceneAssets(project: unknown): Record<string, MeshAsset> {
  const out: Record<string, MeshAsset> = {};
  const parts = (project as { parts?: { geom?: { kind?: string; asset?: string } }[] }).parts ?? [];
  for (const p of parts) {
    const a = p.geom?.kind === 'mesh' && p.geom.asset ? state.assets.get(p.geom.asset) : undefined;
    if (a) out[a.id] = a;
  }
  return out;
}

function snapshotOptions(raw: unknown): SnapshotOptions {
  const o = (raw ?? {}) as Partial<SnapshotOptions>;
  const views = Array.isArray(o.views) ? o.views.filter((v): v is SnapshotView => (SNAPSHOT_VIEWS as readonly string[]).includes(v)) : [];
  const size = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Math.min(2400, Math.max(200, Math.round(Number(v)))) : d);
  return { views: views.length ? views : ['iso', 'front', 'right', 'top'], width: size(o.width, 1000), height: size(o.height, 750), dims: o.dims === true };
}

export class BridgeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  // application/json zorunlu: başka sitelerin tarayıcıdan "basit istek" ile işlem göndermesini engeller (CORS ön kontrolü).
  if (!req.headers['content-type']?.startsWith('application/json')) throw new BridgeError(415, 'Content-Type: application/json gerekli.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BridgeError(413, 'İstek çok büyük.');
    chunks.push(chunk as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new BridgeError(400, 'Geçersiz JSON.');
  }
}

function openEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': p3d\n\n');
  state.clients.push(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    const i = state.clients.indexOf(res);
    if (i >= 0) state.clients.splice(i, 1);
  });
}

function dispatch(cmd: Omit<BridgeCommand, 'id'>, timeoutMs = RESULT_TIMEOUT_MS): Promise<BridgeResult> {
  // Komut yalnızca en son bağlanan sekmeye gider (birden çok sekme aynı işlemi iki kez uygulamasın).
  const target = state.clients.at(-1);
  if (!target) throw new BridgeError(409, 'Bağlı tarayıcı sayfası yok. Uygulamayı tarayıcıda açın.');
  const id = `c${++state.seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new BridgeError(504, 'Tarayıcı yanıt vermedi.'));
    }, timeoutMs);
    state.pending.set(id, (r) => {
      clearTimeout(timer);
      state.pending.delete(id);
      resolve(r);
    });
    target.write(`data: ${JSON.stringify({ ...cmd, id } satisfies BridgeCommand)}\n\n`);
  });
}

/** /api/bridge/* uçlarını işler; başka bir yol ise false döner. */
export async function handleBridge(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/api/bridge/')) return false;
  const route = `${req.method} ${pathname.slice('/api/bridge'.length)}`;
  try {
    switch (route) {
      // Tarayıcı tarafı
      case 'GET /events':
        openEvents(req, res);
        return true;
      case 'PUT /scene': {
        const b = await readJson(req, 80 * MB);
        if (!b.summary || !b.project) throw new BridgeError(400, 'Sahne eksik.');
        if (b.assets && typeof b.assets === 'object') keepAssets(Object.values(b.assets));
        state.scene = { summary: b.summary as SceneSummary, project: b.project, at: new Date().toISOString() };
        send(res, 204, null);
        return true;
      }
      case 'POST /result': {
        const b = (await readJson(req, 60 * MB)) as unknown as BridgeResult;
        state.pending.get(b.id)?.(b);
        send(res, 204, null);
        return true;
      }
      // Ajan / CLI tarafı
      case 'GET /scene': {
        const scene = state.scene;
        if (!scene) throw new BridgeError(409, 'Henüz sahne bildirilmedi. Uygulamayı tarayıcıda açın.');
        const full = new URL(req.url ?? '/', 'http://localhost').searchParams.has('full');
        const body = full ? { ...(scene.project as object), assets: sceneAssets(scene.project) } : scene.summary;
        send(res, 200, { connected: state.clients.length > 0, at: scene.at, scene: body });
        return true;
      }
      case 'POST /ops': {
        const b = await readJson(req, 80 * MB);
        const label = typeof b.label === 'string' ? b.label.slice(0, 500) : undefined;
        if (b.action === 'snapshot') {
          send(res, 200, await dispatch({ action: 'snapshot', snapshot: snapshotOptions(b.snapshot), label }, SNAPSHOT_TIMEOUT_MS));
          return true;
        }
        if (b.action !== undefined) {
          if (!['undo', 'redo', 'fit'].includes(b.action as string)) throw new BridgeError(400, 'Geçersiz eylem.');
          send(res, 200, await dispatch({ action: b.action as BridgeAction, label }));
          return true;
        }
        if (!Array.isArray(b.ops) || !b.ops.every((o) => o && typeof o === 'object' && typeof o.op === 'string')) {
          throw new BridgeError(400, '"ops" bir işlem dizisi olmalı.');
        }
        keepAssets((b.ops as Op[]).flatMap((o) => (o.op === 'import_mesh' ? [o.asset] : [])));
        send(res, 200, await dispatch({ ops: b.ops as Op[], label }, 30_000));
        return true;
      }
      default:
        throw new BridgeError(404, 'Bulunamadı.');
    }
  } catch (e) {
    if (e instanceof BridgeError) send(res, e.status, { error: e.message });
    else throw e;
    return true;
  }
}
