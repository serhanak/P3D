// Claude Code köprüsünün tarayıcı tarafı (bkz. server/bridge.ts): sahneyi sunucuya bildirir,
// terminalden gelen işlemleri store.apply() ile uygular (geri alınabilir) ve sonucu geri gönderir.
import type { BridgeAction, BridgeCommand, BridgeResult, SnapshotOptions } from '../shared/ops';
import { usedAssets } from './assets';
import { sceneSummary, type ApplyResult } from './engine';
import type { Store } from './store';
import type { Viewer } from './viewer';

export interface BridgeHooks {
  /** İşlem uygulandıktan sonra (günlüğe yazmak için). */
  onApplied(res: ApplyResult, label: string | undefined): void;
  onAction(action: Exclude<BridgeAction, 'snapshot'>, label: string | undefined): ApplyResult;
  onConnected(): void;
}

const SNAPSHOT_DEFAULT: SnapshotOptions = { views: ['iso', 'front', 'right', 'top'], width: 1000, height: 750, dims: false };

export function connectBridge(store: Store, viewer: Viewer, hooks: BridgeHooks): void {
  if (typeof EventSource === 'undefined') return;

  // Ağ verisi sunucuya yalnızca bir kez gider (sahne her değişiklikte gönderilir).
  let sentAssets = new Set<string>();
  const pushScene = () => {
    const assets = Object.fromEntries(Object.entries(usedAssets(store.project)).filter(([id]) => !sentAssets.has(id)));
    for (const id of Object.keys(assets)) sentAssets.add(id);
    return fetch('/api/bridge/scene', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: sceneSummary(store.project, store.selectedId), project: store.project, assets }),
    }).catch(() => undefined);
  };

  let timer: number | undefined;
  store.subscribe(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(pushScene, 250);
  });

  let announced = false;
  const es = new EventSource('/api/bridge/events');
  es.onopen = () => {
    sentAssets = new Set(); // sunucu yeniden başlamış olabilir
    void pushScene();
    if (!announced) hooks.onConnected();
    announced = true;
  };
  es.onmessage = (e) => {
    let cmd: BridgeCommand;
    try {
      cmd = JSON.parse(e.data);
    } catch {
      return;
    }
    let res: ApplyResult;
    let images: BridgeResult['images'];
    try {
      if (cmd.action === 'snapshot') {
        images = viewer.snapshot(store.project, { ...SNAPSHOT_DEFAULT, ...cmd.snapshot });
        res = { messages: [`${images.length} görüntü alındı.`], errors: [], lastPartId: null, clearSelection: false };
      } else if (cmd.action) {
        res = hooks.onAction(cmd.action, cmd.label);
      } else {
        res = store.apply(cmd.ops ?? []);
        hooks.onApplied(res, cmd.label);
      }
    } catch (err) {
      res = { messages: [], errors: [`Tarayıcı hatası: ${(err as Error).message}`], lastPartId: null, clearSelection: false };
    }
    const result: BridgeResult = {
      id: cmd.id,
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
}
