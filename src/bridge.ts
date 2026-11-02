// Claude Code köprüsünün tarayıcı tarafı (bkz. server/bridge.ts): sahneyi sunucuya bildirir,
// terminalden gelen işlemleri store.apply() ile uygular (geri alınabilir) ve sonucu geri gönderir.
// Sekme bir çalışma alanına (ws) bağlanır; sunucu bağlantıda sekmeye bir kimlik verir (`event: hello`) ve
// sahne bildirimleri bu kimlikle yapılır.
import type { BridgeCommand, BridgeHello, BridgeResult, SnapshotOptions } from '../shared/ops';
import { usedAssets } from './assets';
import { sceneSummary, type ApplyResult } from './engine';
import type { Store } from './store';
import type { Viewer } from './viewer';

export interface BridgeHooks {
  /** İşlem uygulandıktan sonra (günlüğe yazmak için). */
  onApplied(res: ApplyResult, label: string | undefined): void;
  onAction(action: 'undo' | 'redo' | 'fit', label: string | undefined): ApplyResult;
  /** `p3d open`: proje dosyasını geri alınabilir biçimde yükler. */
  onLoad(cmd: BridgeCommand): ApplyResult;
  /** `p3d save`: proje dosyaya yazıldı; `digest` kaydedilen projenin özeti (sekme değiştiyse kirli kalır). */
  onMarkSaved(file: string, digest: string | undefined, label: string | undefined): ApplyResult;
  onConnected(): void;
}

const SNAPSHOT_DEFAULT: SnapshotOptions = { views: ['iso', 'front', 'right', 'top'], width: 1000, height: 750, dims: false };
/** Bağlantı açıldıktan sonra kimlik (hello) bu sürede gelmezse yeniden bağlanılır (ör. sunucu modülü yenilendi). */
const HELLO_TIMEOUT_MS = 5000;
const RECONNECT_MIN_MS = 3000;
/** Sahne bildirimi bu sürede bitmezse bırakılır: takılan bir istek komut kuyruğunu kilitlemesin. */
const PUT_TIMEOUT_MS = 8000;

const noResult = (errors: string[] = []): ApplyResult => ({ messages: [], errors, lastPartId: null, clearSelection: false });

export function connectBridge(store: Store, viewer: Viewer, ws: string, hooks: BridgeHooks): void {
  if (typeof EventSource === 'undefined') return;

  let client = '';
  // Ağ verisi sunucuya yalnızca bir kez gider (sahne her değişiklikte gönderilir).
  let sentAssets = new Set<string>();
  // Bildirim sıra numarası: aynı anda uçuşan iki bildirim ters sırada varırsa sunucu eskisini yok sayar.
  let seq = 0;
  const pushScene = async (): Promise<void> => {
    if (!client) return;
    const assets = Object.fromEntries(Object.entries(usedAssets(store.project)).filter(([id]) => !sentAssets.has(id)));
    try {
      const r = await fetch('/api/bridge/scene', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ws,
          client,
          seq: ++seq,
          summary: sceneSummary(store.project, store.selectedId),
          project: store.project,
          assets,
          file: store.file,
          dirty: store.dirty,
        }),
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(PUT_TIMEOUT_MS) : undefined,
      });
      if (r.ok) for (const id of Object.keys(assets)) sentAssets.add(id);
      // Sunucu bu sekmeyi tanımıyor (ör. köprü modülü yenilendi): yeniden bağlanıp yeni kimlik alınır.
      else if (r.status === 409) reconnect();
    } catch {
      // Sunucu kapalı olabilir ya da istek zaman aşımına uğradı; sonraki değişiklikte/yeniden bağlanınca sahne yeniden gönderilir.
    }
  };

  let timer: number | undefined;
  store.subscribe(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void pushScene(), 250);
  });

  /** `from`: komutun geldiği bağlantının kimliği (sonuç bu kimlikle gönderilir). */
  const handle = async (cmd: BridgeCommand, from: string): Promise<void> => {
    let res: ApplyResult;
    let images: BridgeResult['images'];
    try {
      if (cmd.action === 'snapshot') {
        images = viewer.snapshot(store.project, { ...SNAPSHOT_DEFAULT, ...cmd.snapshot });
        res = { messages: [`${images.length} görüntü alındı.`], errors: [], lastPartId: null, clearSelection: false };
      } else if (cmd.action === 'load') {
        res = hooks.onLoad(cmd);
      } else if (cmd.action === 'mark_saved') {
        res = cmd.file ? hooks.onMarkSaved(cmd.file, cmd.digest, cmd.label) : noResult(['Dosya yolu eksik.']);
      } else if (cmd.action) {
        res = hooks.onAction(cmd.action, cmd.label);
      } else {
        res = store.apply(cmd.ops ?? []);
        hooks.onApplied(res, cmd.label);
      }
    } catch (err) {
      res = noResult([`Tarayıcı hatası: ${(err as Error).message}`]);
    }
    // Sonuçtan önce sahne bildirilir: komut biter bitmez okunan sahne (`p3d scene`/`save`) güncel olsun.
    // Bildirim en çok PUT_TIMEOUT_MS bekletir; sonra sonuç yine gönderilir.
    if (cmd.action !== 'snapshot') {
      window.clearTimeout(timer);
      await pushScene();
    }
    const result: BridgeResult = {
      id: cmd.id,
      client: from,
      messages: res.messages,
      errors: res.errors,
      scene: sceneSummary(store.project, store.selectedId),
      ...(images ? { images } : {}),
    };
    void fetch('/api/bridge/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    }).catch(() => undefined);
  };

  let queue: Promise<void> = Promise.resolve();
  let announced = false;
  let es: EventSource | null = null;
  let helloTimer: number | undefined;
  let reconnectTimer: number | undefined;
  let openedAt = 0;

  function reconnect(): void {
    if (reconnectTimer !== undefined) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      open();
    }, Math.max(0, openedAt + RECONNECT_MIN_MS - Date.now()));
  }

  function open(): void {
    es?.close();
    client = '';
    openedAt = Date.now();
    const source = new EventSource(`/api/bridge/events?ws=${encodeURIComponent(ws)}`);
    es = source;
    // Bağlantı (ya da EventSource'un kendi yeniden bağlanması) açıldı: kimlik beklenir.
    source.onopen = () => {
      client = '';
      window.clearTimeout(helloTimer);
      helloTimer = window.setTimeout(reconnect, HELLO_TIMEOUT_MS);
    };
    source.addEventListener('hello', (e) => {
      let hello: BridgeHello;
      try {
        hello = JSON.parse((e as MessageEvent<string>).data);
      } catch {
        return;
      }
      window.clearTimeout(helloTimer);
      client = hello.client;
      sentAssets = new Set(); // sunucu yeniden başlamış olabilir
      void pushScene();
      if (!announced) hooks.onConnected();
      announced = true;
    });
    source.onmessage = (e) => {
      let cmd: BridgeCommand;
      try {
        cmd = JSON.parse(e.data);
      } catch {
        return;
      }
      // Komutlar sırayla işlenir (sonuçtaki sahne yalnızca o komutun etkisini içersin).
      const from = client;
      queue = queue.then(() => handle(cmd, from)).catch((err) => console.warn('[p3d] köprü komutu işlenemedi:', err));
    };
  }

  open();
}
