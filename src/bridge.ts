// Claude Code köprüsünün tarayıcı tarafı (bkz. server/bridge.ts): sahneyi sunucuya bildirir,
// terminalden gelen işlemleri store.apply() ile uygular (geri alınabilir) ve sonucu geri gönderir.
import type { BridgeAction, BridgeCommand, BridgeResult } from '../shared/ops';
import { sceneSummary, type ApplyResult } from './engine';
import type { Store } from './store';

export interface BridgeHooks {
  /** İşlem uygulandıktan sonra (günlüğe yazmak için). */
  onApplied(res: ApplyResult, label: string | undefined): void;
  onAction(action: BridgeAction, label: string | undefined): ApplyResult;
  onConnected(): void;
}

export function connectBridge(store: Store, hooks: BridgeHooks): void {
  if (typeof EventSource === 'undefined') return;

  const pushScene = () =>
    fetch('/api/bridge/scene', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: sceneSummary(store.project, store.selectedId), project: store.project }),
    }).catch(() => undefined);

  let timer: number | undefined;
  store.subscribe(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(pushScene, 250);
  });

  let announced = false;
  const es = new EventSource('/api/bridge/events');
  es.onopen = () => {
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
    if (cmd.action) {
      res = hooks.onAction(cmd.action, cmd.label);
    } else {
      res = store.apply(cmd.ops ?? []);
      hooks.onApplied(res, cmd.label);
    }
    const result: BridgeResult = {
      id: cmd.id,
      messages: res.messages,
      errors: res.errors,
      scene: sceneSummary(store.project, store.selectedId),
    };
    void fetch('/api/bridge/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    }).catch(() => undefined);
  };
}
