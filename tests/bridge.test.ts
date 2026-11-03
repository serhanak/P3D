import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handleBridge } from '../server/bridge';
import { makeAsset } from '../src/assets';
import { contentDigest, type BridgeCommand, type BridgeHello, type BridgeResult, type BridgeSceneResponse, type BridgeWorkspace, type SceneSummary } from '../shared/ops';

// Köprü sunucusu port 0'da gerçek bir HTTP sunucusuyla çalıştırılır; sekmeler SSE'yi fetch akışıyla okur.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    handleBridge(req, res, url.pathname)
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end('{}');
        }
      })
      .catch((e) => {
        res.statusCode = 500;
        res.end(String(e));
      });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const box = (name: string) => ({
  id: `p_${name}`,
  name,
  shape: 'box' as const,
  params: { width: 10, depth: 10, height: 10 },
  position: { x: 0, y: 0, z: 5 },
  rotation: { x: 0, y: 0, z: 0 },
  color: '#4f8ef7',
  visible: true,
});
const project = (names: string[]) => ({
  format: 'p3d',
  version: 1,
  name: 'test',
  parts: names.map(box),
  view: { showNames: true, showDimensions: true, showHoles: true },
  settings: { resolution: 32, bedX: 220, bedY: 220 },
});
const summary = (names: string[]): SceneSummary => ({
  units: 'mm',
  bed: { x: 220, y: 220 },
  selected: null,
  parts: names.map((n) => ({ ...box(n), bbox: { min: { x: -5, y: -5, z: 0 }, max: { x: 5, y: 5, z: 10 } }, role: 'solid' })),
});

async function api(method: string, p: string, body?: unknown, type = 'application/json'): Promise<{ status: number; data: any }> {
  const r = await fetch(base + p, { method, headers: body === undefined ? undefined : { 'Content-Type': type }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, data: text ? JSON.parse(text) : null };
}

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('zaman aşımı');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const tabsOf = async (ws: string) => ((await api('GET', '/api/bridge/workspaces')).data as BridgeWorkspace[]).find((w) => w.ws === ws)?.tabs ?? 0;

interface Tab {
  client: string;
  ws: string;
  /** Alınan komutlar. */
  commands: BridgeCommand[];
  next(): Promise<BridgeCommand>;
  put(names: string[], extra?: Record<string, unknown>): Promise<number>;
  respond(cmd: BridgeCommand, names?: string[], errors?: string[]): Promise<void>;
  /** Her komuta otomatik yanıt verir. */
  auto(names: string[]): void;
  close(): Promise<void>;
}

const open: Tab[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

async function openTab(ws: string): Promise<Tab> {
  const ac = new AbortController();
  const r = await fetch(`${base}/api/bridge/events?ws=${encodeURIComponent(ws)}`, { signal: ac.signal });
  expect(r.status).toBe(200);
  const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: { event: string; data: string }[] = [];
  const waiters: ((e: { event: string; data: string }) => void)[] = [];
  const listener: { onCommand: ((c: BridgeCommand) => void) | null } = { onCommand: null };
  const commands: BridgeCommand[] = [];
  void (async () => {
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += value;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let event = 'message';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue; // yorum / ping
          const ev = { event, data };
          if (event === 'message') {
            const cmd = JSON.parse(data) as BridgeCommand;
            commands.push(cmd);
            listener.onCommand?.(cmd);
          }
          const w = waiters.shift();
          if (w) w(ev);
          else events.push(ev);
        }
      }
    } catch {
      // bağlantı kapatıldı
    }
  })();
  const nextEvent = () => (events.length ? Promise.resolve(events.shift()!) : new Promise<{ event: string; data: string }>((res) => waiters.push(res)));
  const first = await nextEvent();
  expect(first.event).toBe('hello');
  const hello = JSON.parse(first.data) as BridgeHello;
  expect(hello.ws).toBe(ws);
  let closed = false;
  const tab: Tab = {
    client: hello.client,
    ws,
    commands,
    async next() {
      const e = await nextEvent();
      return JSON.parse(e.data) as BridgeCommand;
    },
    async put(names, extra = {}) {
      return (await api('PUT', '/api/bridge/scene', { ws, client: hello.client, summary: summary(names), project: project(names), assets: {}, ...extra })).status;
    },
    async respond(cmd, names = [], errors = []) {
      const result: BridgeResult = { id: cmd.id, client: hello.client, messages: [`tamam: ${cmd.action ?? 'ops'}`], errors, scene: summary(names) };
      expect((await api('POST', '/api/bridge/result', result)).status).toBe(204);
    },
    auto(names) {
      listener.onCommand = (cmd) => void tab.respond(cmd, names);
      waiters.length = 0;
    },
    async close() {
      if (closed) return;
      closed = true;
      const before = await tabsOf(ws);
      ac.abort();
      await waitFor(async () => (await tabsOf(ws)) < before);
    },
  };
  open.push(tab);
  return tab;
}

describe('köprü: çalışma alanları', () => {
  it('bağlı sekme yokken 409 ve açılacak adres', async () => {
    const r = await api('GET', '/api/bridge/scene?ws=yok-ws');
    expect(r.status).toBe(409);
    expect(r.data.error).toBe(`'yok-ws' çalışma alanında bağlı sekme yok. Tarayıcıda açın: ${base}/w/yok-ws`);
    const ops = await api('POST', '/api/bridge/ops', { ws: 'yok-ws', ops: [] });
    expect(ops.status).toBe(409);
    expect(ops.data.error).toContain('/w/yok-ws');
    // Kökte adres '/' (bu dosyada hiçbir test köke sekme açmaz).
    expect(await tabsOf('')).toBe(0);
    expect((await api('GET', '/api/bridge/scene')).data.error).toBe(`Kök çalışma alanında bağlı sekme yok. Tarayıcıda açın: ${base}/`);
  });

  it('iki çalışma alanı birbirinden yalıtılmış', async () => {
    const a = await openTab('yalitim-a');
    const b = await openTab('yalitim-b');
    expect(await a.put(['a-parca'])).toBe(204);
    expect(await b.put(['b-parca'])).toBe(204);
    const sa = (await api('GET', '/api/bridge/scene?ws=yalitim-a')).data as BridgeSceneResponse;
    expect(sa).toMatchObject({ connected: true, ws: 'yalitim-a', client: a.client, tabs: 1 });
    expect((sa.scene as SceneSummary).parts.map((p) => p.name)).toEqual(['a-parca']);

    // Komut yalnızca b'ye gider.
    const pending = api('POST', '/api/bridge/ops', { ws: 'yalitim-b', ops: [{ op: 'delete', part: 'b-parca' }], label: 'sil' });
    const cmd = await b.next();
    expect(cmd.ops).toEqual([{ op: 'delete', part: 'b-parca' }]);
    expect(cmd.label).toBe('sil');
    await b.respond(cmd, []);
    expect((await pending).data.messages).toEqual(['tamam: ops']);
    expect(a.commands).toEqual([]);
  });

  it('hedef en son bağlanan sekme; öbür sekmenin geç gelen sahnesi dönmez', async () => {
    const t1 = await openTab('hedef');
    const t2 = await openTab('hedef');
    expect(await t2.put(['iki'])).toBe(204);
    expect(await t1.put(['bir'])).toBe(204); // daha geç ama hedef değil
    let s = (await api('GET', '/api/bridge/scene?ws=hedef')).data as BridgeSceneResponse;
    expect(s.client).toBe(t2.client);
    expect(s.tabs).toBe(2);
    expect((s.scene as SceneSummary).parts[0].name).toBe('iki');

    const pending = api('POST', '/api/bridge/ops', { ws: 'hedef', action: 'fit' });
    const cmd = await t2.next();
    expect(cmd.action).toBe('fit');
    await t2.respond(cmd);
    expect((await pending).status).toBe(200);
    expect(t1.commands).toEqual([]);

    // Hedef kapanınca bir önceki sekme hedef olur.
    await t2.close();
    s = (await api('GET', '/api/bridge/scene?ws=hedef')).data as BridgeSceneResponse;
    expect(s.client).toBe(t1.client);
    expect((s.scene as SceneSummary).parts[0].name).toBe('bir');
  });

  it('rev her bildirimde artar; sekme kapanınca 409, ?stale son sahneyi verir', async () => {
    const t = await openTab('rev-ws');
    await t.put(['r1']);
    const s1 = (await api('GET', '/api/bridge/scene?ws=rev-ws')).data as BridgeSceneResponse;
    await t.put(['r2'], { file: 'C:/proje/m.p3d.json', dirty: true });
    const s2 = (await api('GET', '/api/bridge/scene?ws=rev-ws&full')).data as BridgeSceneResponse;
    expect(s2.rev).toBe(s1.rev + 1);
    expect(Date.parse(s2.at)).toBeGreaterThanOrEqual(Date.parse(s1.at));
    expect(s2).toMatchObject({ file: 'C:/proje/m.p3d.json', dirty: true });
    expect((s2.scene as { format: string; parts: { name: string }[] }).parts[0].name).toBe('r2');

    await t.close();
    expect((await api('GET', '/api/bridge/scene?ws=rev-ws')).status).toBe(409);
    const stale = (await api('GET', '/api/bridge/scene?ws=rev-ws&stale')).data as BridgeSceneResponse;
    expect(stale).toMatchObject({ connected: false, rev: s2.rev, tabs: 0 });
  });

  it('load ve mark_saved eylemleri sekmeye iletilir; mark_saved içerik özeti ister', async () => {
    const t = await openTab('dosya-ws');
    await t.put(['eski']);
    const pending = api('POST', '/api/bridge/ops', { ws: 'dosya-ws', action: 'load', project: project(['yeni']), assets: {}, file: 'C:/p/yeni.p3d.json', dirty: true });
    const load = await t.next();
    expect(load).toMatchObject({ action: 'load', file: 'C:/p/yeni.p3d.json', assets: {}, dirty: true });
    expect((load.project as { parts: { name: string }[] }).parts[0].name).toBe('yeni');
    await t.respond(load, ['yeni']);
    expect((await pending).data.messages).toEqual(['tamam: load']);

    await t.put(['yeni']);
    const digest = contentDigest(JSON.stringify(project(['yeni'])));
    const saved = api('POST', '/api/bridge/ops', { ws: 'dosya-ws', action: 'mark_saved', file: 'C:/p/yeni.p3d.json', digest });
    const mark = await t.next();
    expect(mark).toMatchObject({ action: 'mark_saved', file: 'C:/p/yeni.p3d.json', digest });
    // Sekme özeti kendi projesiyle karşılaştırır; uyuşmazlığı sonuçta hata olarak bildirir (sunucu aynen iletir).
    await t.respond(mark, ['yeni'], ['Sekmedeki proje kayıt sırasında değişti']);
    expect((await saved).data.errors).toEqual(['Sekmedeki proje kayıt sırasında değişti']);

    expect((await api('POST', '/api/bridge/ops', { ws: 'dosya-ws', action: 'mark_saved', file: 'C:/p/yeni.p3d.json' })).status).toBe(400);
    expect((await api('POST', '/api/bridge/ops', { ws: 'dosya-ws', action: 'mark_saved', file: 'C:/p/yeni.p3d.json', digest: 'xyz' })).status).toBe(400);
    expect((await api('POST', '/api/bridge/ops', { ws: 'dosya-ws', action: 'mark_saved', digest })).status).toBe(400);
    expect((await api('POST', '/api/bridge/ops', { ws: 'dosya-ws', action: 'load' })).status).toBe(400);
    expect(t.commands.map((c) => c.action)).toEqual(['load', 'mark_saved']);
  });

  it('/workspaces bağlı sekmeleri ve son sahneyi listeler', async () => {
    const a = await openTab('liste-a');
    await openTab('liste-a');
    const b = await openTab('liste-b');
    await a.put(['x']); // hedef değil: ikinci sekme henüz bildirmedi
    await b.put(['y', 'z']);
    const list = (await api('GET', '/api/bridge/workspaces')).data as BridgeWorkspace[];
    const la = list.find((w) => w.ws === 'liste-a')!;
    const lb = list.find((w) => w.ws === 'liste-b')!;
    expect(la).toMatchObject({ tabs: 2, rev: null, parts: null });
    expect(lb).toMatchObject({ tabs: 1, parts: 2 });
    expect(typeof lb.rev).toBe('number');
    expect(list.map((w) => w.ws)).toEqual([...list.map((w) => w.ws)].sort());
  });

  it('girdi doğrulaması: geçersiz ad, bilinmeyen sekme, ws uyuşmazlığı, Content-Type', async () => {
    expect((await api('GET', '/api/bridge/scene?ws=a%2Fb')).status).toBe(400);
    expect((await api('POST', '/api/bridge/ops', { ws: '..', ops: [] })).status).toBe(400);
    expect((await api('PUT', '/api/bridge/scene', { ws: 'x', client: 't-yok', summary: summary([]), project: project([]) })).status).toBe(409);
    const t = await openTab('dogrulama');
    expect((await api('PUT', '/api/bridge/scene', { ws: 'baska', client: t.client, summary: summary([]), project: project([]) })).status).toBe(400);
    expect((await api('POST', '/api/bridge/ops', { ws: 'dogrulama', ops: [] }, 'text/plain')).status).toBe(415);
    expect((await api('PUT', '/api/bridge/scene', { ws: 'dogrulama', client: t.client, summary: summary([]), project: project([]) }, 'text/plain')).status).toBe(415);
    expect((await api('POST', '/api/bridge/result', { id: 'c1', client: t.client, messages: [], errors: [], scene: summary([]) }, 'text/plain')).status).toBe(415);
    expect((await api('POST', '/api/bridge/ops', { ws: 'dogrulama', action: 'sil' })).status).toBe(400);
  });

  it('komut sırasında sekme koparsa bekleyen komut 409 ve "uygulanmış olabilir" uyarısıyla döner', async () => {
    const t = await openTab('kopma');
    await t.put(['k']);
    const pending = api('POST', '/api/bridge/ops', { ws: 'kopma', ops: [{ op: 'delete', part: 'k' }] });
    expect((await t.next()).ops).toEqual([{ op: 'delete', part: 'k' }]);
    await t.close();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(r.data.error).toBe('Sekmeyle bağlantı komut sırasında koptu; komut uygulanmış olabilir. Tekrar göndermeden önce p3d scene ile kontrol edin.');
  });

  it('aynı sekmeden eski sıra numaralı (seq) sahne yok sayılır', async () => {
    const t = await openTab('sira');
    expect(await t.put(['ilk'], { seq: 2 })).toBe(204);
    const s1 = (await api('GET', '/api/bridge/scene?ws=sira')).data as BridgeSceneResponse;
    // Ağda geç kalan eski bildirim ve aynı numaralı tekrar: sahne ve rev değişmez.
    const late = await api('PUT', '/api/bridge/scene', { ws: 'sira', client: t.client, seq: 1, summary: summary(['eski']), project: project(['eski']) });
    expect(late).toEqual({ status: 200, data: { ignored: true } });
    expect(await t.put(['ayni'], { seq: 2 })).toBe(200);
    let s = (await api('GET', '/api/bridge/scene?ws=sira')).data as BridgeSceneResponse;
    expect((s.scene as SceneSummary).parts[0].name).toBe('ilk');
    expect(s.rev).toBe(s1.rev);
    expect(await t.put(['yeni'], { seq: 3 })).toBe(204);
    s = (await api('GET', '/api/bridge/scene?ws=sira')).data as BridgeSceneResponse;
    expect((s.scene as SceneSummary).parts[0].name).toBe('yeni');
    expect(s.rev).toBe(s1.rev + 1);
    // Sıra sekme başınadır: başka bir sekmenin 1 numarası kabul edilir.
    const u = await openTab('sira');
    expect(await u.put(['u'], { seq: 1 })).toBe(204);
  });

  it('sonucu yalnızca komutun gönderildiği sekme verebilir; sonuç alanları doğrulanır', async () => {
    const a = await openTab('sonuc');
    const b = await openTab('sonuc'); // hedef
    const pending = api('POST', '/api/bridge/ops', { ws: 'sonuc', action: 'fit' });
    const cmd = await b.next();
    const res = (client: unknown, extra: Record<string, unknown> = {}) => ({ id: cmd.id, client, messages: ['sahte'], errors: [], scene: summary([]), ...extra });
    const wrong = await api('POST', '/api/bridge/result', res(a.client));
    expect(wrong.status).toBe(409);
    expect(wrong.data.error).toMatch(/başka bir sekmeye/);
    expect((await api('POST', '/api/bridge/result', res(b.client, { id: 5 }))).status).toBe(400);
    expect((await api('POST', '/api/bridge/result', res(undefined))).status).toBe(400);
    expect((await api('POST', '/api/bridge/result', res(b.client, { scene: undefined }))).status).toBe(400);
    expect((await api('POST', '/api/bridge/result', res(b.client, { errors: 'x' }))).status).toBe(400);
    await b.respond(cmd);
    expect((await pending).data.messages).toEqual(['tamam: fit']);
    // Süresi dolmuş/bilinmeyen komutun sonucu sessizce yok sayılır.
    expect((await api('POST', '/api/bridge/result', { ...res(b.client), id: 'c-yok' })).status).toBe(204);
  });

  it('load ile gelen ağlar yalnızca sekme yükledikten sonra tutulur', async () => {
    const asset = (id: string) => ({ id, name: id, positions: 'AAAA', indices: 'AAAA', triangles: 1 });
    const meshProject = (id: string) => ({
      ...project([]),
      parts: [{ ...box('ag'), shape: 'mesh', params: { scale: 1 }, geom: { kind: 'mesh', asset: id } }],
    });
    const fullAssets = async (ws: string) => ((await api('GET', `/api/bridge/scene?ws=${ws}&full`)).data.scene as { assets: Record<string, unknown> }).assets;

    // Bağlı sekme yok: istek reddedilir, ağ sunucuda kalmaz.
    const fail = await api('POST', '/api/bridge/ops', { ws: 'ag-yok', action: 'load', project: meshProject('a_sizinti1'), assets: { a_sizinti1: asset('a_sizinti1') } });
    expect(fail.status).toBe(409);
    const t = await openTab('ag-ws');
    await t.put([], { project: meshProject('a_sizinti1') });
    expect(await fullAssets('ag-ws')).toEqual({});

    const pending = api('POST', '/api/bridge/ops', { ws: 'ag-ws', action: 'load', project: meshProject('a_tutulan1'), assets: { a_tutulan1: asset('a_tutulan1') } });
    await t.respond(await t.next());
    expect((await pending).status).toBe(200);
    await t.put([], { project: meshProject('a_tutulan1') });
    expect(Object.keys(await fullAssets('ag-ws'))).toEqual(['a_tutulan1']);
  });

  it('kopan sekmelerin son sahneleri sınırlı tutulur (en çok 20 çalışma alanı)', async () => {
    for (let i = 0; i < 22; i++) {
      const t = await openTab(`kapanan-${i}`);
      await t.put([`p${i}`]);
      await t.close();
    }
    const list = (await api('GET', '/api/bridge/workspaces')).data as BridgeWorkspace[];
    const names = list.map((w) => w.ws);
    expect(names).not.toContain('kapanan-0');
    expect(names).not.toContain('kapanan-1');
    expect(names).toContain('kapanan-21');
    expect(list.filter((w) => w.tabs === 0).length).toBeLessThanOrEqual(20);
    expect((await api('GET', '/api/bridge/scene?ws=kapanan-0&stale')).status).toBe(409);
    expect((await api('GET', '/api/bridge/scene?ws=kapanan-21&stale')).status).toBe(200);
  });

  it('sekmenin ilk sahnesi kısa bir süre beklenir', async () => {
    const t = await openTab('bekle');
    const pending = api('GET', '/api/bridge/scene?ws=bekle');
    await new Promise((r) => setTimeout(r, 100));
    await t.put(['gec']);
    const r = await pending;
    expect(r.status).toBe(200);
    expect((r.data.scene as SceneSummary).parts[0].name).toBe('gec');
  });
});

// ---------------------------------------------------------------------------
// p3d komutu bu sunucuya karşı (P3D_URL), p3d.json'lu bir klasörden

const BIN = fileURLToPath(new URL('../bin/p3d.mjs', import.meta.url));

function p3d(args: string[], cwd: string, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['init_cwd', 'npm_lifecycle_event', 'p3d_ws', 'p3d_url'].includes(k.toLowerCase())));
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [BIN, ...args], { cwd, env: { ...env, P3D_URL: base }, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin!.end(stdin);
  });
}

describe('p3d komutu ve çalışma alanları', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'p3d-wscli-'));
    writeFileSync(path.join(dir, 'p3d.json'), JSON.stringify({ workspace: 'cli-ws', file: 'model.p3d.json' }));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('scene / status p3d.json’daki çalışma alanını kullanır; bağlı sekme yoksa 409 mesajı ve çıkış 1', async () => {
    const t = await openTab('cli-ws');
    await t.put(['govde', 'kapak']);
    const scene = await p3d(['scene'], dir);
    expect(scene.code).toBe(0);
    expect(scene.stdout).toMatch(/^çalışma alanı: cli-ws · rev \d+ · .* · 1 sekme/);
    expect(scene.stdout).toContain(' govde [box]');

    const status = await p3d(['status'], dir);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('cli-ws (kaynak: p3d.json)');
    expect(status.stdout).toContain(`${base}/w/cli-ws`);
    expect(status.stdout).toContain(path.join(dir, 'p3d.json'));
    expect(status.stdout).toMatch(/bağlı · 1 sekme · rev \d+ .* 2 parça/);

    const none = await p3d(['scene', '--ws', 'cli-bos'], dir);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain(`'cli-bos' çalışma alanında bağlı sekme yok. Tarayıcıda açın: ${base}/w/cli-bos`);
  }, 60_000);

  it('save sekmenin projesini p3d.json → file’a yazar ve mark_saved gönderir; open dosyayı load ile yükler', async () => {
    const t = await openTab('cli-ws');
    await t.put(['kaydedilen']);
    t.auto(['kaydedilen']);
    const save = await p3d(['save'], dir);
    expect(save.stderr).toBe('');
    expect(save.code).toBe(0);
    const file = path.join(dir, 'model.p3d.json');
    expect(save.stdout).toContain(`Kaydedildi: ${file} (1 parça; çalışma alanı cli-ws`);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written.parts.map((p: { name: string }) => p.name)).toEqual(['kaydedilen']);
    // Özet, sekmenin bildirdiği projenin JSON'undan (sunucunun eklediği assets hariç) hesaplanır.
    expect(t.commands.at(-1)).toMatchObject({ action: 'mark_saved', file, digest: contentDigest(JSON.stringify(project(['kaydedilen']))) });

    // Sekme (mark_saved sonrası) dosyaya bağlı ve temiz: open kabul edilir.
    await t.put(['kaydedilen'], { file, dirty: false });
    writeFileSync(path.join(dir, 'diger.p3d.json'), JSON.stringify(project(['acilan'])));
    const openRes = await p3d(['open', 'diger.p3d.json'], dir);
    expect(openRes.code).toBe(0);
    const load = t.commands.at(-1)!;
    expect(load).toMatchObject({ action: 'load', file: path.join(dir, 'diger.p3d.json'), label: 'Aç: diger.p3d.json' });
    expect((load.project as { parts: { name: string }[] }).parts.map((p) => p.name)).toEqual(['acilan']);

    // Başka bir çalışma alanı seçiliyken p3d.json'daki dosya kullanılmaz.
    const other = await p3d(['save', '--ws', 'baska'], dir);
    expect(other.code).toBe(1);
    expect(other.stderr).toMatch(/'cli-ws' çalışma alanına ait/);
  }, 60_000);

  it('sunucu kapalıyken status açıklayıcı mesaj verir', async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['init_cwd', 'npm_lifecycle_event', 'p3d_ws'].includes(k.toLowerCase())));
    const out = await new Promise<{ code: number; stdout: string }>((resolve) =>
      execFile(process.execPath, [BIN, 'status'], { cwd: dir, env: { ...env, P3D_URL: 'http://127.0.0.1:9' }, encoding: 'utf8' }, (err, stdout) =>
        resolve({ code: err ? 1 : 0, stdout }),
      ),
    );
    expect(out.code).toBe(1);
    expect(out.stdout).toContain('ERİŞİLEMİYOR');
    expect(out.stdout).toContain('cli-ws (kaynak: p3d.json)');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// save / open veri korumaları (CLI bu sunucuya karşı)

describe('p3d save / open korumaları', () => {
  let root: string;
  let dir: string;
  let model: string;
  const names = (file: string) => (JSON.parse(readFileSync(file, 'utf8')).parts as { name: string }[]).map((p) => p.name);
  const strange = (valid: string[]) => ({ ...project(valid), parts: [...project(valid).parts, { ...box('garip'), shape: 'yildiz' }] });

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'p3d-koru-'));
    dir = path.join(root, 'proje');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'p3d.json'), JSON.stringify({ workspace: 'koru', file: 'model.p3d.json' }));
    model = path.join(dir, 'model.p3d.json');
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('save: bağlı olunmayan mevcut dosya, boş sekme, P3D olmayan dosya; geçici dosya + yeniden adlandırma', async () => {
    const t = await openTab('koru');
    t.auto([]);
    writeFileSync(model, JSON.stringify(project(['eski1', 'eski2'])));

    // Sekme bu dosyaya bağlı değil → yazılmaz.
    await t.put(['yeni'], { file: path.join(root, 'baska.p3d.json') });
    let r = await p3d(['save'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${model} zaten var ve sekme bu dosyaya bağlı değil (bağlı dosya: ${path.join(root, 'baska.p3d.json')})`);
    expect(r.stderr).toContain('--force');
    expect(names(model)).toEqual(['eski1', 'eski2']);
    r = await p3d(['save', '--force'], dir);
    expect(r.code).toBe(0);
    expect(names(model)).toEqual(['yeni']);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // Bağ normalleştirilmiş yolla karşılaştırılır (`alt/..`); boş sekme dolu dosyanın üzerine yazmaz.
    await t.put([], { file: `${dir}${path.sep}alt${path.sep}..${path.sep}model.p3d.json` });
    r = await p3d(['save'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Sekme boş (0 parça) ama ${model} 1 parça içeriyor`);
    expect(names(model)).toEqual(['yeni']);
    r = await p3d(['save', '--force'], dir);
    expect(r.code).toBe(0);
    expect(names(model)).toEqual([]);

    // P3D projesi olmayan dosyanın üzerine --force ile de yazılmaz.
    writeFileSync(path.join(dir, 'notlar.json'), '{"x":1}');
    r = await p3d(['save', 'notlar.json', '--force'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('bir P3D proje dosyası değil');
    expect(readFileSync(path.join(dir, 'notlar.json'), 'utf8')).toBe('{"x":1}');
  }, 60_000);

  it('save: okunamayan parça ya da ağ verisi eksik mesh parçası varsa dosya yazılmaz', async () => {
    const t = await openTab('koru');
    t.auto([]);
    await t.put(['iyi'], { project: strange(['iyi']) });
    let r = await p3d(['save', 'eksik.p3d.json'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Sekmedeki 1 parça dosyaya yazılamazdı (okunamadı):\n  - 'garip': bilinmeyen şekil 'yildiz'");
    expect(r.stderr).toContain('Dosya yazılmadı.');

    const mesh = { ...project([]), parts: [{ ...box('tarama'), shape: 'mesh', params: { scale: 1 }, geom: { kind: 'mesh', asset: 'a_yok12345' } }] };
    await t.put([], { project: mesh });
    r = await p3d(['save', 'eksik.p3d.json'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ağ verisi yok: 'tarama'");
    expect(readdirSync(dir)).not.toContain('eksik.p3d.json');
    expect(t.commands).toEqual([]); // mark_saved gönderilmedi
  }, 60_000);

  it('save: sekme kayıt sırasında değiştiyse uyarı yazar (dosya yazılır, çıkış 0)', async () => {
    const t = await openTab('koru');
    await t.put(['a'], { file: path.join(dir, 'yaris.p3d.json') });
    const pending = p3d(['save', 'yaris.p3d.json'], dir);
    const cmd = await t.next();
    expect(cmd.action).toBe('mark_saved');
    await t.respond(cmd, ['a', 'b'], ['Sekmedeki proje kayıt sırasında değişti; sekme “kaydedilmemiş” kaldı.']);
    const r = await pending;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('⚠ Sekmedeki proje kayıt sırasında değişti');
    expect(names(path.join(dir, 'yaris.p3d.json'))).toEqual(['a']);
  }, 60_000);

  it('p3d.json → file klasör dışına çıkamaz; komutta açıkça yazılan yol serbest', async () => {
    const kacis = path.join(root, 'kacis');
    mkdirSync(kacis);
    writeFileSync(path.join(kacis, 'p3d.json'), JSON.stringify({ workspace: 'kacis', file: '../disari.p3d.json' }));
    for (const cmd of ['save', 'open']) {
      const r = await p3d([cmd], kacis);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`"file" (../disari.p3d.json) p3d.json'ın klasörünün dışını gösteriyor`);
    }
    const t = await openTab('kacis');
    t.auto([]);
    await t.put(['acik']);
    const r = await p3d(['save', '../disari2.p3d.json'], kacis);
    expect(r.code).toBe(0);
    expect(names(path.join(root, 'disari2.p3d.json'))).toEqual(['acik']);
  }, 60_000);

  it('open: kaydedilmemiş değişiklik ya da bağsız dolu sekme varsa --force ister', async () => {
    const t = await openTab('koru');
    t.auto([]);
    const src = path.join(dir, 'kaynak.p3d.json');
    writeFileSync(src, JSON.stringify(project(['kaynak'])));

    await t.put(['is']);
    let r = await p3d(['open', 'kaynak.p3d.json'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Sekmedeki proje (1 parça) bir dosyaya bağlı değil; yüklenmedi. Önce kaydedin: p3d save <dosya.p3d.json>');
    expect(r.stderr).toContain('--force');

    await t.put(['is'], { file: src, dirty: true });
    r = await p3d(['open', 'kaynak.p3d.json'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Sekmede kaydedilmemiş değişiklik var (dosya: ${src}, 1 parça); yüklenmedi. Önce kaydedin: p3d save —`);
    expect(t.commands).toEqual([]);

    r = await p3d(['open', 'kaynak.p3d.json', '--force'], dir);
    expect(r.code).toBe(0);
    expect(t.commands.at(-1)).toMatchObject({ action: 'load', file: src });
    expect(t.commands.at(-1)!.dirty).toBeUndefined();

    // Temiz ve bağlı sekme: --force gerekmez. Boş, bağsız sekme de serbest.
    await t.put(['kaynak'], { file: src, dirty: false });
    expect((await p3d(['open', 'kaynak.p3d.json'], dir)).code).toBe(0);
    await t.put([]);
    expect((await p3d(['open', 'kaynak.p3d.json'], dir)).code).toBe(0);
    expect(t.commands.map((c) => c.action)).toEqual(['load', 'load', 'load']);
  }, 60_000);

  it('open: okunamayan parçaları listeler; --force ile yükler ama sekmeyi kirli bırakır', async () => {
    const t = await openTab('koru');
    t.auto([]);
    writeFileSync(path.join(dir, 'garip.p3d.json'), JSON.stringify(strange(['saglam'])));
    await t.put([]);
    let r = await p3d(['open', 'garip.p3d.json'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("1 parça okunamadı ve yüklenmeyecekti:\n  - 'garip': bilinmeyen şekil 'yildiz'");
    expect(t.commands).toEqual([]);

    r = await p3d(['open', 'garip.p3d.json', '--force'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("⚠ 1 parça yüklenmedi (--force):\n  - 'garip': bilinmeyen şekil 'yildiz'");
    const load = t.commands.at(-1)!;
    expect(load).toMatchObject({ action: 'load', dirty: true });
    expect((load.project as { parts: { name: string }[] }).parts.map((p) => p.name)).toEqual(['saglam']);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Tarayıcısız çekirdekle gelen sekme yolu: --ops dosyası, import src, sekmeden export/check, save src kuralı

describe('p3d: --ops dosyası, import kaynağı, sekmeden export/check, save ve referans ağ', () => {
  let dir: string;
  const CUBE_OBJ = [
    ...[[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]].map((v) => `v ${v.join(' ')}`),
    'f 1 3 2', 'f 1 4 3', 'f 5 6 7', 'f 5 7 8', 'f 1 2 6', 'f 1 6 5',
    'f 2 3 7', 'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8',
  ].join('\n');

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'p3d-cekirdek-'));
    writeFileSync(path.join(dir, 'p3d.json'), JSON.stringify({ workspace: 'cekirdek' }));
    writeFileSync(path.join(dir, 'kup.obj'), CUBE_OBJ);
    mkdirSync(path.join(dir, 'model'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('ops --ops dosyası stdin yerine okunur ({"ops": …} biçimi de)', async () => {
    const t = await openTab('cekirdek');
    t.auto(['a']);
    writeFileSync(path.join(dir, 'ops.json'), JSON.stringify({ ops: [{ op: 'create', shape: 'box', name: 'a' }] }));
    const r = await p3d(['ops', '--ops', 'ops.json', '--label', 'dosyadan'], dir);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(t.commands.at(-1)).toMatchObject({ ops: [{ op: 'create', shape: 'box', name: 'a' }], label: 'dosyadan' });
  }, 60_000);

  it('import: işleme ağ, mutlak kaynak yolu (src) ve maxTris yazılır', async () => {
    const t = await openTab('cekirdek');
    t.auto(['kup']);
    const r = await p3d(['import', 'kup.obj', '--max-tris', '500', '--role', 'reference', '--keep-position'], dir);
    expect(r.code).toBe(0);
    const op = t.commands.at(-1)!.ops![0];
    expect(op).toMatchObject({ op: 'import_mesh', name: 'kup', role: 'reference', src: path.join(dir, 'kup.obj'), maxTris: 500, position: { x: 5, y: 5, z: 5 } });
    // Kaynak damgası: dosya sonradan değişirse fark edilsin.
    expect(op).toMatchObject({ srcSize: Buffer.byteLength(CUBE_OBJ), srcHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect((op as { asset: { triangles: number } }).asset.triangles).toBe(12);
  }, 60_000);

  it('export ve check --file olmadan sekmenin sahnesinden', async () => {
    const t = await openTab('cekirdek');
    await t.put(['a', 'b']);
    const r = await p3d(['export', 'sekme.stl', '--parts', 'b'], dir);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/çalışma alanı: cekirdek \(rev \d+\)/);
    expect(readFileSync(path.join(dir, 'sekme.stl')).length).toBe(84 + 50 * 12);
    const c = await p3d(['check', '--profile', 'game', '--max-tris', '10'], dir);
    expect(c.stdout).toContain('profil game (bütçe 10 üçgen)');
    expect(c.stdout).toContain('Toplam 24 üçgen; bütçe 10 aşıldı');
  }, 60_000);

  it('save: kaynağı olan ağ gömülmez (yol dosyaya göreli), --embed ile gömülür', async () => {
    const t = await openTab('cekirdek');
    t.auto([]);
    const asset = makeAsset('kup', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]), 'a_kup12345');
    const src = path.join(dir, 'kup.obj');
    const mesh = { ...project([]), parts: [{ ...box('tarama'), shape: 'mesh', params: { scale: 1 }, geom: { kind: 'mesh', asset: asset.id, src, maxTris: 500 } }] };
    await t.put([], { project: mesh, assets: { [asset.id]: asset } });
    let r = await p3d(['save', 'model/yol.p3d.json'], dir);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('1 ağ yolla anılıyor');
    let raw = JSON.parse(readFileSync(path.join(dir, 'model', 'yol.p3d.json'), 'utf8'));
    // Damga (boyut + özet) kaydederken eklenir.
    expect(raw.parts[0].geom).toEqual({ kind: 'mesh', asset: asset.id, src: '../kup.obj', maxTris: 500, srcSize: Buffer.byteLength(CUBE_OBJ), srcHash: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(raw.assets).toBeUndefined();
    const gomulu = path.join(dir, 'model', 'gomulu.p3d.json');
    r = await p3d(['save', 'model/gomulu.p3d.json', '--embed'], dir);
    expect(r.stdout).toContain('1 ağ gömülü');
    raw = JSON.parse(readFileSync(gomulu, 'utf8'));
    expect(raw.parts[0].geom.src).toBe('../kup.obj');
    expect(raw.assets[asset.id]).toEqual(asset);

    // Aynı dosyaya sonradan --embed olmadan kaydetmek ağı atmaz: hedefte gömülü olan gömülü kalır.
    await t.put([], { project: mesh, assets: { [asset.id]: asset }, file: gomulu, dirty: true });
    r = await p3d(['save', 'model/gomulu.p3d.json'], dir);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('1 ağ gömülü');
    expect(JSON.parse(readFileSync(gomulu, 'utf8')).assets[asset.id]).toEqual(asset);
  }, 60_000);

  it('sekmeden export / check: okunamayan parça varsa export yazmaz, check hata sayar; kaynak ağ dosyası ezilmez', async () => {
    const t = await openTab('cekirdek');
    const strange = { ...project(['a']), parts: [...project(['a']).parts, { ...box('garip'), shape: 'yildiz' }] };
    await t.put(['a'], { project: strange });
    const why = "'garip': bilinmeyen şekil 'yildiz'";
    const e = await p3d(['export', 'garip.stl'], dir);
    expect(e.code).toBe(1);
    expect(e.stderr).toContain(`Sekmedeki 1 parça okunamadı (çalışma alanı: cekirdek`);
    expect(e.stderr).toContain(why);
    expect(readdirSync(dir)).not.toContain('garip.stl');
    const c = await p3d(['check'], dir);
    expect(c.code).toBe(1);
    expect(c.stdout).toContain(`✕ Parça okunamadı, denetlenmedi: ${why}`);
    expect(c.stdout).not.toContain('Sorun bulunmadı');

    const src = path.join(dir, 'kup.obj');
    const ref = { ...project(['a']), parts: [...project(['a']).parts, { ...box('ref'), shape: 'mesh', role: 'reference', params: { scale: 1 }, geom: { kind: 'mesh', asset: 'a_yokref02', src } }] };
    await t.put(['a', 'ref'], { project: ref });
    const k = await p3d(['export', 'kup.obj'], dir);
    expect(k.code).toBe(1);
    expect(k.stderr).toContain(`${src} 'ref' parçasının kaynak ağ dosyası (src); üzerine yazılmadı`);
    expect(readFileSync(src, 'utf8')).toBe(CUBE_OBJ);
  }, 60_000);
});

describe('kök koruması (CLI)', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'p3d-rootguard-')); // p3d.json yok, P3D deposu dışında
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('P3D dışından p3d.json/--ws olmadan sahneyi değiştiren komut köke gitmez; --ws "" ile gider; okuma serbest', async () => {
    const t = await openTab('');
    await t.put(['kok']);
    t.auto(['kok']);
    const ops = JSON.stringify([{ op: 'create', shape: 'box', name: 'yanlis' }]);
    const before = t.commands.length;
    for (const args of [['ops'], ['undo'], ['open', 'yok.p3d.json'], ['save', 'x.p3d.json']]) {
      const r = await p3d(args, dir, args[0] === 'ops' ? ops : undefined);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain('kök çalışma alanına (kullanıcının kişisel sahnesi) gidecekti');
    }
    expect(t.commands.length).toBe(before);
    expect(existsSync(path.join(dir, 'x.p3d.json'))).toBe(false);

    const scene = await p3d(['scene'], dir);
    expect(scene.code).toBe(0);
    const ok = await p3d(['ops', '--ws', ''], dir, ops);
    expect(ok.code).toBe(0);
    expect(t.commands.at(-1)).toMatchObject({ ops: [{ op: 'create', name: 'yanlis' }] });
  }, 60_000);
});

describe('p3d dev', () => {
  it('sunucu zaten çalışıyorsa yenisini başlatmaz, adresi söyler', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'p3d-dev-'));
    try {
      const r = await p3d(['dev'], dir);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`P3D sunucusu zaten çalışıyor: ${base}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
