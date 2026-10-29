import './style.css';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { Op } from '../shared/ops';
import { sceneSummary, type ApplyResult } from './engine';
import { exportModel, parseProject, projectToJson, download, safeFileName, type ExportKind } from './io';
import { connectBridge } from './bridge';
import { initCsg } from './csg';
import { meshAssetFromSoup, meshFormatOf, parseMeshFile } from './meshio';
import { askClaude, fetchLlmStatus, type LlmStatus } from './nlp/llm';
import { HELP_TEXT, parseCommand } from './nlp/parser';
import { Store } from './store';
import { newProject, type Project } from './types';
import { mountPanels } from './ui';
import { Viewer, type ViewPreset } from './viewer';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// Başlangıç durumu

function demoProject(): Project {
  return newProject('Örnek proje');
}

const restored = Store.restore();
let initial: Project;
let firstRun = false;
try {
  initial = restored ? parseProject(restored) : demoProject();
  firstRun = !restored;
} catch {
  initial = demoProject();
  firstRun = true;
}

// Delik (boolean) çekirdeği: yüklenemezse uygulama deliksiz çalışır.
let csgError = '';
try {
  await initCsg(wasmUrl);
} catch (e) {
  csgError = (e as Error).message;
}

const store = new Store(initial);
const viewer = new Viewer($('viewport'));
viewer.onSelect = (id) => store.select(id);

if (firstRun) {
  store.apply([
    { op: 'create', shape: 'box', name: 'taban', params: [
      { name: 'width', value: 60 },
      { name: 'depth', value: 40 },
      { name: 'height', value: 5 },
    ], color: '#4f8ef7' },
    { op: 'create', shape: 'cylinder', name: 'mil', params: [
      { name: 'diameter', value: 12 },
      { name: 'height', value: 30 },
    ], color: '#f2994a', place_on: 'taban' },
  ]);
  store.load(store.project); // örnek içerik geri alma geçmişine girmesin
}

// ---------------------------------------------------------------------------
// Günlük ve bildirim

const log = $('log');

type Badge = 'Yerel' | 'Claude' | 'Claude Code';
const BADGE_CLASS: Record<Badge, string> = { Yerel: 'local', Claude: '', 'Claude Code': 'cc' };

function addLog(kind: 'user' | 'ok' | 'warn' | 'err' | 'info' | 'ai', text: string, badge?: Badge): void {
  const div = document.createElement('div');
  div.className = `entry ${kind}`;
  if (badge) {
    const b = document.createElement('span');
    b.className = `badge ${BADGE_CLASS[badge]}`;
    b.textContent = badge;
    div.appendChild(b);
  }
  div.appendChild(document.createTextNode(text));
  log.appendChild(div);
  while (log.children.length > 300) log.firstChild?.remove();
  log.scrollTop = log.scrollHeight;
}

let toastTimer: number | undefined;
function toast(text: string, error = false): void {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', error);
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), error ? 4000 : 2500);
}

function logResult(res: ApplyResult, badge?: Badge): void {
  res.messages.forEach((m, i) => addLog('ok', '✓ ' + m, i === 0 ? badge : undefined));
  res.errors.forEach((m) => addLog('err', '✕ ' + m));
}

// ---------------------------------------------------------------------------
// Paneller ve senkronizasyon

const applyFromUi = (ops: Op[]) => {
  const res = store.apply(ops);
  if (res.errors.length) toast(res.errors[0], true);
};
const renderPanels = mountPanels(store, applyFromUi);

function render(): void {
  viewer.sync(store.project, store.selectedId);
  renderPanels();
  ($('tg-names') as HTMLInputElement).checked = store.project.view.showNames;
  ($('tg-dims') as HTMLInputElement).checked = store.project.view.showDimensions;
  ($('tg-holes') as HTMLInputElement).checked = store.project.view.showHoles;
  const nameInput = $<HTMLInputElement>('project-name');
  if (document.activeElement !== nameInput) nameInput.value = store.project.name;
  $<HTMLButtonElement>('btn-undo').disabled = !store.canUndo;
  $<HTMLButtonElement>('btn-redo').disabled = !store.canRedo;
  $<HTMLButtonElement>('btn-export').disabled = !store.project.parts.length;
  document.title = `${store.project.name} — P3D`;
}
store.subscribe(render);
render();
viewer.fit(store.project);

// ---------------------------------------------------------------------------
// Komutlar

let llm: LlmStatus = { llm: false, backend: null, model: '', bridge: false };
const LLM_HINT = 'Serbest anlatımlı komutlar için Claude modunu açın: .env dosyasına ANTHROPIC_API_KEY ekleyin ya da sunucuyu "npm run dev -- --llm=claude-cli" ile başlatın (Claude Code hesabınızla).';
const history: string[] = [];
let historyPos = -1;
const modeSelect = $<HTMLSelectElement>('cmd-mode');
const input = $<HTMLInputElement>('cmd-input');
const form = $<HTMLFormElement>('cmd-form');

function undo(): void {
  if (!store.undo()) toast('Geri alınacak bir şey yok.');
}
function redo(): void {
  if (!store.redo()) toast('Yinelenecek bir şey yok.');
}

async function runCommand(text: string): Promise<void> {
  const mode = modeSelect.value as 'auto' | 'local' | 'claude';
  addLog('user', text);

  if (mode !== 'claude') {
    const parsed = parseCommand(text, store.project, store.selectedId);
    if (parsed.special === 'undo') return undo();
    if (parsed.special === 'redo') return redo();
    if (parsed.special === 'help') return addLog('info', HELP_TEXT);
    const fullyUnderstood = parsed.unrecognized.length === 0;
    if (fullyUnderstood || mode === 'local' || !llm.llm) {
      if (parsed.ops.length) logResult(store.apply(parsed.ops), 'Yerel');
      parsed.errors.forEach((m) => addLog('warn', '⚠ ' + m));
      if (!fullyUnderstood) {
        addLog('warn', `⚠ Anlaşılamadı: “${parsed.unrecognized.join('”, “')}”. Örnekler için “yardım” yazın.`);
        if (!llm.llm) addLog('info', LLM_HINT);
      }
      return;
    }
  }

  if (!llm.llm) {
    addLog('err', '✕ Claude kullanılamıyor. ' + LLM_HINT);
    return;
  }
  form.classList.add('busy');
  const thinking = document.createElement('div');
  thinking.className = 'entry info';
  thinking.textContent = 'Claude düşünüyor…';
  log.appendChild(thinking);
  log.scrollTop = log.scrollHeight;
  try {
    const out = await askClaude({ text, scene: sceneSummary(store.project, store.selectedId), history: history.slice(-7, -1) });
    thinking.remove();
    if (out.reply) addLog('ai', out.reply, 'Claude');
    if (out.operations.length) logResult(store.apply(out.operations));
  } catch (e) {
    thinking.remove();
    addLog('err', '✕ ' + (e as Error).message);
  } finally {
    form.classList.remove('busy');
    input.focus();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  history.push(text);
  historyPos = -1;
  input.value = '';
  void runCommand(text);
});

input.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  if (!history.length) return;
  e.preventDefault();
  if (historyPos === -1) historyPos = history.length;
  historyPos = Math.max(0, Math.min(history.length, historyPos + (e.key === 'ArrowUp' ? -1 : 1)));
  input.value = history[historyPos] ?? '';
});

function updateLlmStatus(): void {
  const el = $('llm-status');
  const claudeOpt = modeSelect.querySelector<HTMLOptionElement>('option[value="claude"]')!;
  claudeOpt.disabled = !llm.llm;
  if (!llm.llm && modeSelect.value === 'claude') modeSelect.value = 'auto';
  const via = llm.backend === 'claude-cli' ? 'Claude Code hesabı' : 'API';
  el.innerHTML = llm.llm
    ? `<span class="dot on"></span>Claude hazır (${via}, ${llm.model}). Otomatik mod: yerel ayrıştırıcının anlamadığı komutlar Claude'a gider.`
    : `<span class="dot"></span>Claude kapalı — yalnızca yerel Türkçe ayrıştırıcı. Etkinleştirmek için README → “Claude modu”.`;
}
updateLlmStatus();
// Sunucu o an yeniden başlıyorsa durum birkaç kez yeniden sorulur (aksi hâlde köprü hiç bağlanmaz).
function loadStatus(attempt = 0): void {
  void fetchLlmStatus().then((s) => {
    if (!s) {
      if (attempt < 30) window.setTimeout(() => loadStatus(attempt + 1), 2000);
      return;
    }
    llm = s;
    updateLlmStatus();
    if (s.bridge) startBridge();
  });
}
loadStatus();

// Terminaldeki Claude Code oturumu sahneyi okuyup işlem gönderebilir (server/bridge.ts).
const startBridge = () => connectBridge(store, viewer, {
  onConnected: () => addLog('info', 'Claude Code köprüsü bağlı: terminalden gelen komutlar burada uygulanır.'),
  onApplied: (res, label) => {
    if (label) addLog('user', label, 'Claude Code');
    logResult(res, label ? undefined : 'Claude Code');
    if (!res.messages.length && !res.errors.length) addLog('info', 'Değişiklik yok.');
  },
  onAction: (action, label) => {
    if (label) addLog('user', label, 'Claude Code');
    const res: ApplyResult = { messages: [], errors: [], lastPartId: null, clearSelection: false };
    if (action === 'fit') {
      viewer.fit(store.project);
      res.messages.push('Görünüm sığdırıldı.');
    } else if (action === 'undo' ? store.undo() : store.redo()) {
      res.messages.push(action === 'undo' ? 'Geri alındı.' : 'Yinelendi.');
    } else {
      res.errors.push(action === 'undo' ? 'Geri alınacak bir şey yok.' : 'Yinelenecek bir şey yok.');
    }
    logResult(res);
    return res;
  },
});

store.onWarning = (m) => addLog('warn', '⚠ ' + m);
viewer.onWarning = (m) => addLog('warn', '⚠ ' + m);
if (csgError) addLog('warn', `⚠ Delik (boolean) çekirdeği yüklenemedi; delik parçaları kesmeyecek. (${csgError})`);

addLog(
  'info',
  firstRun
    ? 'Hoş geldiniz! Örnek iki parça eklendi. Deneyin: “mil parçasının çapını 10mm büyüt”, “tabanı kırmızı yap”, “ölçüleri gizle”. Tüm örnekler için “yardım” yazın.'
    : 'Proje geri yüklendi. Örnek komutlar için “yardım” yazın.',
);

// ---------------------------------------------------------------------------
// Araç çubuğu

$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);
$('tg-names').addEventListener('change', (e) =>
  store.apply([{ op: 'view', show_names: (e.target as HTMLInputElement).checked }]),
);
$('tg-dims').addEventListener('change', (e) =>
  store.apply([{ op: 'view', show_dimensions: (e.target as HTMLInputElement).checked }]),
);
$('tg-holes').addEventListener('change', (e) =>
  store.apply([{ op: 'view', show_holes: (e.target as HTMLInputElement).checked }]),
);
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => viewer.setPreset(b.dataset.view as ViewPreset, store.project)),
);
$('btn-fit').addEventListener('click', () => viewer.fit(store.project));

$<HTMLInputElement>('project-name').addEventListener('change', (e) => {
  const v = (e.target as HTMLInputElement).value.trim();
  if (v) store.mutate((p) => (p.name = v));
  else render();
});

$('btn-new').addEventListener('click', () => {
  if (store.project.parts.length && !confirm('Yeni proje açılsın mı? Kaydedilmemiş değişiklikler kaybolur.')) return;
  store.load(newProject());
  viewer.fit(store.project);
  addLog('info', 'Yeni proje oluşturuldu.');
});

function saveProject(): void {
  const file = `${safeFileName(store.project.name)}.p3d.json`;
  download(file, projectToJson(store.project), 'application/json');
  toast(`Kaydedildi: ${file}`);
}
$('btn-save').addEventListener('click', saveProject);

const fileInput = $<HTMLInputElement>('file-input');
$('btn-open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const project = parseProject(JSON.parse(await file.text()));
    store.load(project);
    viewer.fit(store.project);
    addLog('info', `“${file.name}” yüklendi (${project.parts.length} parça).`);
    toast('Proje yüklendi.');
  } catch (e) {
    toast(`Yüklenemedi: ${(e as Error).message}`, true);
  }
});

const meshInput = $<HTMLInputElement>('mesh-input');
$('btn-import').addEventListener('click', () => meshInput.click());
meshInput.addEventListener('change', async () => {
  const file = meshInput.files?.[0];
  meshInput.value = '';
  if (!file) return;
  if (!meshFormatOf(file.name)) return toast('Desteklenen biçimler: STL, OBJ, 3MF.', true);
  try {
    addLog('info', `“${file.name}” okunuyor…`);
    const imp = await meshAssetFromSoup(file.name.replace(/\.[^.]+$/, ''), parseMeshFile(file.name, await file.arrayBuffer()));
    logResult(store.apply([{ op: 'import_mesh', asset: imp.asset }]));
    if (imp.asset.triangles < imp.originalTriangles) {
      addLog('info', `Ağ ${imp.originalTriangles.toLocaleString('tr-TR')} → ${imp.asset.triangles.toLocaleString('tr-TR')} üçgene sadeleştirildi.`);
    }
    addLog('info', `Boyut ${imp.size.x} × ${imp.size.y} × ${imp.size.z} mm. Panelden rolünü Referans ya da Delik yapabilirsiniz.`);
    viewer.fit(store.project);
  } catch (e) {
    toast(`İçe aktarılamadı: ${(e as Error).message}`, true);
  }
});

const exportMenu = $('export-menu');
$('btn-export').addEventListener('click', (e) => {
  e.stopPropagation();
  exportMenu.hidden = !exportMenu.hidden;
  for (const k of ['selected-obj', 'selected-stl']) exportMenu.querySelector<HTMLButtonElement>(`[data-export="${k}"]`)!.disabled = !store.selectedId;
});
document.addEventListener('click', () => (exportMenu.hidden = true));
exportMenu.addEventListener('click', (e) => {
  const kind = (e.target as HTMLElement).closest<HTMLElement>('[data-export]')?.dataset.export as ExportKind | undefined;
  if (!kind) return;
  try {
    const msg = exportModel(kind, store.project, store.selectedId);
    toast(`Dışa aktarıldı: ${msg}`);
    addLog('info', `Dışa aktarıldı: ${msg}`);
  } catch (err) {
    toast((err as Error).message, true);
  }
});

const dlg = $<HTMLDialogElement>('settings-dialog');
$('btn-settings').addEventListener('click', () => {
  $<HTMLInputElement>('set-bedx').value = String(store.project.settings.bedX);
  $<HTMLInputElement>('set-bedy').value = String(store.project.settings.bedY);
  const res = $<HTMLSelectElement>('set-res');
  res.value = String(store.project.settings.resolution);
  if (!res.value) res.value = '96';
  dlg.showModal();
});
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'ok') return;
  const clamp = (v: string, def: number) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.min(2000, Math.max(20, n)) : def;
  };
  store.mutate((p) => {
    p.settings.bedX = clamp($<HTMLInputElement>('set-bedx').value, p.settings.bedX);
    p.settings.bedY = clamp($<HTMLInputElement>('set-bedy').value, p.settings.bedY);
    p.settings.resolution = parseInt($<HTMLSelectElement>('set-res').value, 10) || p.settings.resolution;
  });
});

// ---------------------------------------------------------------------------
// Klavye kısayolları

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's') {
    e.preventDefault();
    return saveProject();
  }
  if (typing) {
    if (e.key === 'Escape') t.blur();
    return;
  }
  if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    redo();
  } else if (e.key === 'Delete' && store.selectedId) {
    store.apply([{ op: 'delete', part: store.selectedId }]);
  } else if (e.key === 'Escape') {
    store.select(null);
  } else if (e.key === 'f' || e.key === 'F') {
    viewer.fit(store.project);
  } else if (e.key === '/') {
    e.preventDefault();
    input.focus();
  }
});
