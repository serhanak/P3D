// Claude Code köprüsü: terminaldeki bir ajan (ya da `npm run cli`) açık tarayıcı sayfasının sahnesini okur
// ve ona işlem (Op) listesi gönderir. Sunucu durumsuzdur: sahneyi tarayıcı bildirir, işlemleri tarayıcı uygular.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BridgeAction, BridgeCommand, BridgeResult, Op, SceneSummary } from '../shared/ops.ts';

interface SceneState {
  summary: SceneSummary;
  project: unknown;
  at: string;
}

const RESULT_TIMEOUT_MS = 10_000;

let scene: SceneState | null = null;
/** Bağlı sayfalar; komut yalnızca en son bağlanana gider (birden çok sekme aynı işlemi iki kez uygulamasın). */
const clients: ServerResponse[] = [];
const pending = new Map<string, (r: BridgeResult) => void>();
let seq = 0;

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
  clients.push(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    const i = clients.indexOf(res);
    if (i >= 0) clients.splice(i, 1);
  });
}

function dispatch(cmd: Omit<BridgeCommand, 'id'>): Promise<BridgeResult> {
  const target = clients.at(-1);
  if (!target) throw new BridgeError(409, 'Bağlı tarayıcı sayfası yok. Uygulamayı tarayıcıda açın.');
  const id = `c${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new BridgeError(504, 'Tarayıcı yanıt vermedi.'));
    }, RESULT_TIMEOUT_MS);
    pending.set(id, (r) => {
      clearTimeout(timer);
      pending.delete(id);
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
        const b = await readJson(req, 5_000_000);
        if (!b.summary || !b.project) throw new BridgeError(400, 'Sahne eksik.');
        scene = { summary: b.summary as SceneSummary, project: b.project, at: new Date().toISOString() };
        send(res, 204, null);
        return true;
      }
      case 'POST /result': {
        const b = (await readJson(req, 5_000_000)) as unknown as BridgeResult;
        pending.get(b.id)?.(b);
        send(res, 204, null);
        return true;
      }
      // Ajan / CLI tarafı
      case 'GET /scene': {
        if (!scene) throw new BridgeError(409, 'Henüz sahne bildirilmedi. Uygulamayı tarayıcıda açın.');
        const full = new URL(req.url ?? '/', 'http://localhost').searchParams.has('full');
        send(res, 200, { connected: clients.length > 0, at: scene.at, scene: full ? scene.project : scene.summary });
        return true;
      }
      case 'POST /ops': {
        const b = await readJson(req, 2_000_000);
        const label = typeof b.label === 'string' ? b.label.slice(0, 500) : undefined;
        if (b.action !== undefined) {
          if (!['undo', 'redo', 'fit'].includes(b.action as string)) throw new BridgeError(400, 'Geçersiz eylem.');
          send(res, 200, await dispatch({ action: b.action as BridgeAction, label }));
          return true;
        }
        if (!Array.isArray(b.ops) || !b.ops.every((o) => o && typeof o === 'object' && typeof o.op === 'string')) {
          throw new BridgeError(400, '"ops" bir işlem dizisi olmalı.');
        }
        send(res, 200, await dispatch({ ops: b.ops as Op[], label }));
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
