// Claude Code köprüsü: terminaldeki bir ajan (ya da `p3d` komutu) açık tarayıcı sekmesinin sahnesini okur
// ve ona işlem (Op) listesi gönderir. Sunucu durumsuzdur: sahneyi tarayıcı bildirir, işlemleri tarayıcı uygular.
//
// Sekmeler çalışma alanlarına (ws) ayrılır: kök `/` (ws = '') ve `/w/<ad>`. Bir ws'nin hedefi ona en son bağlanan
// sekmedir; `GET /scene` yalnızca hedefin sahnesini döndürür, komutlar yalnızca hedefe gider. Böylece başka bir
// sekmenin (ya da başka bir ws'nin) geç gelen sahnesi okunmaz.
//
//   GET  /events?ws=<ad>       SSE; ilk olay `event: hello` + {"client","ws"}, sonra komutlar (`data:` BridgeCommand)
//   PUT  /scene                {ws, client, seq, summary, project, assets, file?, dirty?} — sekmenin sahnesi (rev artar;
//                              aynı sekmeden eski `seq`'li bildirim yok sayılır)
//   POST /result               BridgeResult — sekmenin komut sonucu (`client` komutun gittiği sekme olmalı)
//   GET  /scene?ws=&full&stale hedef sekmenin sahnesi (BridgeSceneResponse); bağlı sekme yoksa 409
//   POST /ops                  {ws, ops | action: undo|redo|fit|snapshot|load|mark_saved, …} → BridgeResult
//   GET  /workspaces           BridgeWorkspace[]
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SNAPSHOT_VIEWS,
  normalizeWs,
  wsPath,
  type BridgeAction,
  type BridgeCommand,
  type BridgeHello,
  type BridgeResult,
  type BridgeSceneResponse,
  type BridgeWorkspace,
  type MeshAsset,
  type Op,
  type SceneSummary,
  type SnapshotOptions,
  type SnapshotView,
} from '../shared/ops.ts';

interface Client {
  id: string;
  ws: string;
  res: ServerResponse;
}

interface SceneState {
  client: string;
  ws: string;
  summary: SceneSummary;
  project: unknown;
  file?: string;
  dirty: boolean;
  at: string;
  rev: number;
  /** Sekmenin bildirim sıra numarası (sekme başına artar); yoksa sıra denetlenmez. */
  seq?: number;
  /** Sekmenin bağlantısının koptuğu an (yalnızca lastScene kayıtlarında). */
  closedAt?: number;
}

interface Pending {
  client: string;
  resolve(r: BridgeResult): void;
  reject(e: Error): void;
}

const RESULT_TIMEOUT_MS = 10_000;
const OPS_TIMEOUT_MS = 30_000;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 60_000;
/** Yeni bağlanan sekmenin ilk sahnesi için GET /scene'in bekleyeceği süre. */
const SCENE_WAIT_MS = 3_000;
/** Bağlantısı kopmuş sekmelerin son sahneleri: en çok bu kadar ws, en çok bu kadar süre tutulur. */
const LAST_SCENE_MAX = 20;
const LAST_SCENE_TTL_MS = 60 * 60_000;
const MB = 1024 * 1024;
/** Komut sonucu gelmeden bağlantı koptuğunda ya da süre dolduğunda: komut sekmede uygulanmış olabilir. */
const MAYBE_APPLIED = 'komut uygulanmış olabilir. Tekrar göndermeden önce p3d scene ile kontrol edin.';

/**
 * Köprü durumu globalThis'te tutulur: geliştirme sunucusu bu modülü değişiklikte yeniden yüklediğinde
 * (ssrLoadModule) bağlı sekmeler, sahneler ve bekleyen istekler kaybolmasın. Anahtar biçimle birlikte sürümlenir
 * (eski biçimli nesne yeniden kullanılmasın); eski anahtardaki sekmeler 409 alıp yeniden bağlanır.
 */
interface BridgeState {
  /** Bağlı sekmeler, bağlanma sırasıyla. */
  clients: Client[];
  /** Bağlı sekme kimliği → son bildirdiği sahne. */
  scenes: Map<string, SceneState>;
  /** ws → bağlantısı kopmuş sekmelerin en yeni sahnesi (yalnızca `?stale` ve /workspaces için). */
  lastScene: Map<string, SceneState>;
  /** ws → son rev. */
  revs: Map<string, number>;
  assets: Map<string, MeshAsset>;
  pending: Map<string, Pending>;
  seq: number;
  clientSeq: number;
}
const G = globalThis as typeof globalThis & { __p3dBridge2?: BridgeState };
const state: BridgeState = (G.__p3dBridge2 ??= {
  clients: [],
  scenes: new Map(),
  lastScene: new Map(),
  revs: new Map(),
  assets: new Map(),
  pending: new Map(),
  seq: 0,
  clientSeq: 0,
});

/** Kopan sekmenin sahnesini `?stale` için saklar; eski ve fazla kayıtları atar (bellek sınırlı kalsın). */
function rememberClosed(s: SceneState, now = Date.now()): void {
  const prev = state.lastScene.get(s.ws);
  if (!prev || prev.rev < s.rev) {
    state.lastScene.delete(s.ws); // Map sırası = kopma sırası (en eski başta)
    state.lastScene.set(s.ws, { ...s, closedAt: now });
  }
  for (const [ws, x] of state.lastScene) {
    if (state.lastScene.size > LAST_SCENE_MAX || now - (x.closedAt ?? now) > LAST_SCENE_TTL_MS) state.lastScene.delete(ws);
  }
}

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

function wsParam(raw: unknown): string {
  try {
    return normalizeWs(raw ?? '');
  } catch (e) {
    throw new BridgeError(400, (e as Error).message);
  }
}

function fileParam(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.slice(0, 4096) : undefined;
}

/** Çalışma alanının hedefi: ona en son bağlanan sekme. */
function target(ws: string): Client | undefined {
  for (let i = state.clients.length - 1; i >= 0; i--) if (state.clients[i].ws === ws) return state.clients[i];
  return undefined;
}

const tabsIn = (ws: string) => state.clients.filter((c) => c.ws === ws).length;
const where = (ws: string) => (ws ? `'${ws}' çalışma alanında` : 'Kök çalışma alanında');

function noTab(req: IncomingMessage, ws: string): BridgeError {
  const url = `http://${req.headers.host ?? 'localhost:5173'}${wsPath(ws)}`;
  return new BridgeError(409, `${where(ws)} bağlı sekme yok. Tarayıcıda açın: ${url}`);
}

function openEvents(res: ServerResponse, ws: string): void {
  const c: Client = { id: `t${++state.clientSeq}`, ws, res };
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify({ client: c.id, ws } satisfies BridgeHello)}\n\n`);
  state.clients.push(c);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(ping);
    const i = state.clients.indexOf(c);
    if (i >= 0) state.clients.splice(i, 1);
    const s = state.scenes.get(c.id);
    if (s) {
      rememberClosed(s);
      state.scenes.delete(c.id);
    }
    for (const p of [...state.pending.values()]) {
      if (p.client === c.id) p.reject(new BridgeError(409, `Sekmeyle bağlantı komut sırasında koptu; ${MAYBE_APPLIED}`));
    }
  });
}

/** Hedef sekmenin sahnesi; sekme yeni bağlandıysa ilk bildirimi kısa bir süre bekler. */
async function sceneOf(c: Client): Promise<SceneState | undefined> {
  const end = Date.now() + SCENE_WAIT_MS;
  while (!state.scenes.has(c.id) && state.clients.includes(c) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return state.scenes.get(c.id);
}

function dispatch(req: IncomingMessage, ws: string, cmd: Omit<BridgeCommand, 'id'>, timeoutMs = RESULT_TIMEOUT_MS): Promise<BridgeResult> {
  // Komut yalnızca çalışma alanının hedef sekmesine gider (birden çok sekme aynı işlemi iki kez uygulamasın).
  const t = target(ws);
  if (!t) throw noTab(req, ws);
  const id = `c${++state.seq}`;
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      state.pending.delete(id);
    };
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new BridgeError(504, `Tarayıcı ${Math.round(timeoutMs / 1000)} sn içinde yanıt vermedi; ${MAYBE_APPLIED}`));
    }, timeoutMs);
    state.pending.set(id, {
      client: t.id,
      resolve: (r) => (done(), resolve(r)),
      reject: (e) => (done(), reject(e)),
    });
    t.res.write(`data: ${JSON.stringify({ ...cmd, id } satisfies BridgeCommand)}\n\n`);
  });
}

/** /api/bridge/* uçlarını işler; başka bir yol ise false döner. */
export async function handleBridge(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith('/api/bridge/')) return false;
  const route = `${req.method} ${pathname.slice('/api/bridge'.length)}`;
  const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
  try {
    switch (route) {
      // Tarayıcı tarafı
      case 'GET /events':
        openEvents(res, wsParam(query.get('ws')));
        return true;
      case 'PUT /scene': {
        const b = await readJson(req, 80 * MB);
        if (!b.summary || !b.project) throw new BridgeError(400, 'Sahne eksik.');
        const ws = wsParam(b.ws);
        const c = state.clients.find((x) => x.id === b.client);
        if (!c) throw new BridgeError(409, 'Bilinmeyen sekme; köprüye yeniden bağlanın.');
        if (c.ws !== ws) throw new BridgeError(400, 'Sekmenin çalışma alanı uyuşmuyor.');
        if (b.assets && typeof b.assets === 'object') keepAssets(Object.values(b.assets));
        // Bildirimler ağda sıra değiştirebilir: aynı sekmenin daha yeni bir sahnesi alındıysa eskisi yok sayılır.
        const seq = typeof b.seq === 'number' && Number.isFinite(b.seq) ? b.seq : undefined;
        const prev = state.scenes.get(c.id);
        if (seq !== undefined && prev?.seq !== undefined && seq <= prev.seq) {
          send(res, 200, { ignored: true });
          return true;
        }
        const rev = (state.revs.get(ws) ?? 0) + 1;
        state.revs.set(ws, rev);
        state.scenes.set(c.id, {
          client: c.id,
          ws,
          summary: b.summary as SceneSummary,
          project: b.project,
          file: fileParam(b.file),
          dirty: b.dirty === true,
          at: new Date().toISOString(),
          rev,
          ...(seq !== undefined ? { seq } : {}),
        });
        send(res, 204, null);
        return true;
      }
      case 'POST /result': {
        const b = await readJson(req, 60 * MB);
        if (typeof b.id !== 'string' || typeof b.client !== 'string') throw new BridgeError(400, '"id" ve "client" metin olmalı.');
        if (!Array.isArray(b.messages) || !Array.isArray(b.errors) || !b.scene || typeof b.scene !== 'object') {
          throw new BridgeError(400, 'Sonuçta "messages", "errors" ya da "scene" eksik.');
        }
        const p = state.pending.get(b.id);
        // Süresi dolmuş/bilinmeyen komutun sonucu yok sayılır; komutu yalnızca gönderildiği sekme yanıtlayabilir.
        if (p && p.client !== b.client) throw new BridgeError(409, 'Bu komut başka bir sekmeye gönderildi.');
        p?.resolve(b as unknown as BridgeResult);
        send(res, 204, null);
        return true;
      }
      // Ajan / CLI tarafı
      case 'GET /scene': {
        const ws = wsParam(query.get('ws'));
        const t = target(ws);
        let scene: SceneState | undefined;
        if (t) {
          scene = await sceneOf(t);
          if (!scene) throw new BridgeError(409, `${where(ws)} bağlı sekme (${t.id}) henüz sahne bildirmedi; birkaç saniye sonra tekrar deneyin.`);
        } else {
          scene = query.has('stale') ? state.lastScene.get(ws) : undefined;
          if (!scene) throw noTab(req, ws);
        }
        const body: BridgeSceneResponse = {
          connected: !!t,
          ws,
          client: scene.client,
          rev: scene.rev,
          at: scene.at,
          tabs: tabsIn(ws),
          file: scene.file ?? null,
          dirty: scene.dirty,
          scene: query.has('full') ? { ...(scene.project as object), assets: sceneAssets(scene.project) } : scene.summary,
        };
        send(res, 200, body);
        return true;
      }
      case 'GET /workspaces': {
        const names = new Set([...state.clients.map((c) => c.ws), ...state.lastScene.keys()]);
        const list: BridgeWorkspace[] = [...names].sort().map((ws) => {
          const t = target(ws);
          const s = t ? state.scenes.get(t.id) : state.lastScene.get(ws);
          return { ws, tabs: tabsIn(ws), rev: s?.rev ?? null, at: s?.at ?? null, parts: s ? s.summary.parts.length : null };
        });
        send(res, 200, list);
        return true;
      }
      case 'POST /ops': {
        const b = await readJson(req, 80 * MB);
        const ws = wsParam(b.ws);
        const label = typeof b.label === 'string' ? b.label.slice(0, 500) : undefined;
        switch (b.action) {
          case undefined:
            break;
          case 'snapshot':
            send(res, 200, await dispatch(req, ws, { action: 'snapshot', snapshot: snapshotOptions(b.snapshot), label }, SNAPSHOT_TIMEOUT_MS));
            return true;
          case 'undo':
          case 'redo':
          case 'fit':
            send(res, 200, await dispatch(req, ws, { action: b.action as BridgeAction, label }));
            return true;
          case 'load': {
            if (!b.project || typeof b.project !== 'object' || Array.isArray(b.project)) throw new BridgeError(400, '"project" bir proje nesnesi olmalı.');
            const assets = b.assets && typeof b.assets === 'object' && !Array.isArray(b.assets) ? (b.assets as Record<string, MeshAsset>) : {};
            const r = await dispatch(
              req,
              ws,
              { action: 'load', project: b.project, assets, file: fileParam(b.file), ...(b.dirty === true ? { dirty: true } : {}), label },
              LOAD_TIMEOUT_MS,
            );
            // Ağlar yalnızca sekme yükledikten sonra tutulur (bağlı sekme yokken gelen istek belleği şişirmesin).
            keepAssets(Object.values(assets));
            send(res, 200, r);
            return true;
          }
          case 'mark_saved': {
            const file = fileParam(b.file);
            if (!file) throw new BridgeError(400, '"file" gerekli.');
            // Sekme yalnızca kaydedilen içerik kendi güncel projesiyse "kaydedildi" sayar (özeti sekme karşılaştırır).
            if (typeof b.digest !== 'string' || !/^[0-9a-f]{16}$/.test(b.digest)) throw new BridgeError(400, '"digest" (16 onaltılık karakter) gerekli.');
            send(res, 200, await dispatch(req, ws, { action: 'mark_saved', file, digest: b.digest, label }));
            return true;
          }
          default:
            throw new BridgeError(400, 'Geçersiz eylem.');
        }
        if (!Array.isArray(b.ops) || !b.ops.every((o) => o && typeof o === 'object' && typeof o.op === 'string')) {
          throw new BridgeError(400, '"ops" bir işlem dizisi olmalı.');
        }
        const r = await dispatch(req, ws, { ops: b.ops as Op[], label }, OPS_TIMEOUT_MS);
        keepAssets((b.ops as Op[]).flatMap((o) => (o.op === 'import_mesh' ? [o.asset] : [])));
        send(res, 200, r);
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
