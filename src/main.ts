import './style.css';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { wsFromPathname, wsLabel, wsPath, type Op } from '../shared/ops';
import { claimAutosave, indexedDbBackend, localStorageBackend, type AutosaveRecord } from './autosave';
import { sceneSummary, type ApplyResult } from './engine';
import { MAX_BED, exportModel, meshPartsWithoutData, parseProject, projectToJson, download, safeFileName, type ExportKind } from './io';
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

/** Geçersiz adres: uygulama yerine açıklama gösterilir, başka hiçbir şey çalışmaz (otomatik kayıt dahil). */
function showFatal(message: string): never {
  const box = document.createElement('div');
  box.className = 'fatal';
  const h = document.createElement('h2');
  h.textContent = 'Geçersiz adres';
  const p = document.createElement('p');
  p.textContent = message;
  const links = document.createElement('p');
  links.innerHTML = 'Kök çalışma alanı: <a href="/">/</a> · Adlandırılmış çalışma alanı: <code>/w/&lt;ad&gt;</code> (harf, rakam, <code>_ - .</code>; en fazla 64 karakter)';
  box.append(h, p, links);
  document.body.replaceChildren(box);
  document.title = 'P3D — geçersiz adres';
  throw new Error(message);
}

// Çalışma alanı adresten gelir: kök `/` (localStorage), `/w/<ad>` (IndexedDB).
let ws = '';
try {
  ws = wsFromPathname(location.pathname);
} catch (e) {
  showFatal((e as Error).message);
}

const autosave = ws ? indexedDbBackend(ws) : localStorageBackend();
// Aynı çalışma alanı başka bir sekmede zaten açıksa bu sekme otomatik kayıt yazmaz (kayıtlar birbirini ezmesin).
const autosaveOwner = await claimAutosave(ws);
let autosaveOn = autosaveOwner;
let restored: AutosaveRecord | null = null;
let restoreWarning = '';
try {
  restored = await autosave.load();
} catch (e) {
  restoreWarning = `Otomatik kayıt açılamadı (${(e as Error).message}); boş projeyle devam ediliyor ve değişiklikler bu tarayıcıda otomatik kaydedilmeyecek. Projeyi dosyaya kaydedin.`;
}
let initial: Project | null = null;
let unreadable = restored?.error ?? '';
/** Kayıt okundu ama bazı parçaları atlandı ("ad: neden"). */
const droppedOnRestore: string[] = [];
if (restored && !unreadable) {
  try {
    initial = parseProject(restored.project, droppedOnRestore);
    const raw = (restored.project as { parts?: unknown } | null)?.parts;
    const lost = (Array.isArray(raw) ? raw.length : 0) - initial.parts.length;
    if (lost > 0 && !droppedOnRestore.length) droppedOnRestore.push(`${lost} parça (neden bilinmiyor)`);
  } catch (e) {
    unreadable = (e as Error).message;
  }
}
if (droppedOnRestore.length && restored) {
  // Sessiz kayıp olmasın: ham kayıt (tüm parçalarıyla) yedeğe taşınır, okunabilen parçalarla devam edilir; sekme
  // dosyayla aynı değildir (kirli). Yedeklenemezse asıl kayıt korunur ve bu sekmede otomatik kayıt kapanır.
  const list = droppedOnRestore.map((d) => `“${d}”`).join(', ');
  restored.dirty = true;
  if (!autosaveOn) {
    restoreWarning = `Otomatik kayıttaki ${droppedOnRestore.length} parça okunamadı ve gösterilmiyor: ${list}. Bu sekme salt okunur olduğundan kayda dokunulmadı.`;
  } else {
    try {
      const where = await autosave.quarantine();
      restoreWarning = `Otomatik kayıttaki ${droppedOnRestore.length} parça okunamadı ve projeden çıkarıldı: ${list}. Ham kayıt (tüm parçalarıyla) yedeğe taşındı: ${where}.`;
    } catch (e) {
      autosaveOn = false;
      restoreWarning =
        `Otomatik kayıttaki ${droppedOnRestore.length} parça okunamadı: ${list}; ham kayıt yedeklenemedi (${(e as Error).message}). ` +
        'Asıl kayıt korunuyor; bu sekmede otomatik kayıt kapalı. Projeyi dosyaya kaydedin.';
    }
  }
}
if (unreadable) {
  // Okunamayan kayıt silinmez: ham hâli yedeğe taşınır, sonra boş projeyle devam edilir. Yedeklenemezse asıl
  // kayıt korunur ve bu sekmede otomatik kayıt kapanır (ilk düzenleme onu ezmesin).
  restored = null;
  if (!autosaveOn) {
    restoreWarning = `Otomatik kayıt okunamadı (${unreadable}); bu sekme salt okunur olduğundan kayda dokunulmadı. Boş projeyle devam ediliyor.`;
  } else {
    try {
      const where = await autosave.quarantine();
      restoreWarning = `Otomatik kayıt okunamadı (${unreadable}); ham kayıt silinmedi, yedeğe taşındı: ${where}. Boş projeyle devam ediliyor.`;
    } catch (e) {
      autosaveOn = false;
      restoreWarning = `Otomatik kayıt okunamadı (${unreadable}) ve yedeklenemedi (${(e as Error).message}). Asıl kayıt korunuyor; bu sekmede otomatik kayıt kapalı. Projeyi dosyaya kaydedin.`;
    }
  }
}
const firstRun = !restored && !ws && !unreadable;
initial ??= ws ? newProject(ws) : demoProject();

// Delik (boolean) çekirdeği: yüklenemezse uygulama deliksiz çalışır.
let csgError = '';
try {
  await initCsg(wasmUrl);
} catch (e) {
  csgError = (e as Error).message;
}

const store = new Store(initial, autosaveOn ? autosave : null, { file: restored?.file, dirty: restored?.dirty });
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
  document.title = ws ? `P3D — ${ws}` : `${store.project.name} — P3D`;
  renderWsBadge();
}

/** Araç çubuğu rozeti: `<ws> · <dosya adı> ●` (● = kaydedilmemiş). Kökte yalnızca dosya bağlıyken görünür. */
function renderWsBadge(): void {
  const badge = document.getElementById('ws-badge');
  if (!badge) return;
  const file = store.file;
  badge.hidden = !ws && !file;
  if (badge.hidden) return;
  const name = file ? file.split(/[\\/]/).pop() || file : '';
  badge.textContent = file ? `${wsLabel(ws)} · ${name}` : wsLabel(ws);
  const dot = document.createElement('span');
  dot.className = 'dirty';
  dot.textContent = ' ●';
  if (file && store.dirty) badge.appendChild(dot);
  badge.title = [
    `Çalışma alanı: ${wsLabel(ws)} (${location.origin}${wsPath(ws)})`,
    file ? `Dosya: ${file}` : 'Bağlı dosya yok (terminalde: p3d open / p3d save)',
    file ? (store.dirty ? '● Kaydedilmemiş değişiklik var (p3d save)' : 'Dosyayla aynı') : '',
  ]
    .filter(Boolean)
    .join('\n');
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
const startBridge = () => connectBridge(store, viewer, ws, {
  onConnected: () =>
    addLog(
      'info',
      ws
        ? `Claude Code köprüsü bağlı (çalışma alanı “${ws}”): terminalde “p3d --ws ${ws} …” ya da p3d.json'da "workspace": "${ws}".`
        : 'Claude Code köprüsü bağlı: terminalden gelen komutlar burada uygulanır.',
    ),
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
  onLoad: (cmd) => {
    if (cmd.label) addLog('user', cmd.label, 'Claude Code');
    const dropped: string[] = [];
    const project = parseProject({ ...(cmd.project as object), assets: cmd.assets ?? {} }, dropped);
    // Dosyadaki her şey yüklenemediyse (`p3d open --force`) sekme dosyayla aynı değildir: kirli kalır.
    const partial = cmd.dirty === true || dropped.length > 0;
    store.replace(project, cmd.file, partial);
    viewer.fit(store.project);
    const res: ApplyResult = {
      messages: [
        `${cmd.file ? `“${cmd.file}”` : 'Proje'} yüklendi (${project.parts.length} parça). Önceki içerik geri-al ile geri gelir.` +
          (partial ? ' Dosyadaki bazı parçalar yüklenemedi; sekme “kaydedilmemiş” sayılıyor.' : ''),
      ],
      errors: dropped.map((d) => `Yüklenemedi: ${d}`),
      lastPartId: null,
      clearSelection: true,
    };
    logResult(res, cmd.label ? undefined : 'Claude Code');
    return res;
  },
  onMarkSaved: (file, digest, label) => {
    if (label) addLog('user', label, 'Claude Code');
    // Özet, kaydedilen projenin özetidir: sekme o arada değiştiyse dosya son hâli içermez, sekme kirli kalır.
    const same = store.markSaved(file, digest);
    const res: ApplyResult = same
      ? { messages: [`Kaydedildi: ${file}`], errors: [], lastPartId: null, clearSelection: false }
      : {
          messages: [],
          errors: [`Sekmedeki proje kayıt sırasında değişti; “${file}” son hâli içermiyor. Sekme “kaydedilmemiş” kaldı — yeniden kaydedin (p3d save).`],
          lastPartId: null,
          clearSelection: false,
        };
    logResult(res, label ? undefined : 'Claude Code');
    return res;
  },
});

store.onWarning = (m) => addLog('warn', '⚠ ' + m);
viewer.onWarning = (m) => addLog('warn', '⚠ ' + m);
// Kısmi geri yüklemede asıl kayıt yedeğe taşındı: okunabilen parçalar ilk düzenlemeyi beklemeden yeniden yazılır
// (yenilenen sayfa boş açılmasın).
if (droppedOnRestore.length && autosaveOn) autosave.save({ project: store.project, file: store.file, dirty: true }, store.onWarning);
if (restoreWarning) addLog('warn', '⚠ ' + restoreWarning);
if (unreadable) toast('Otomatik kayıt okunamadı; ayrıntı günlükte.', true);
if (droppedOnRestore.length) toast(`Otomatik kayıttaki ${droppedOnRestore.length} parça okunamadı; ayrıntı günlükte.`, true);
if (csgError) addLog('warn', `⚠ Delik (boolean) çekirdeği yüklenemedi; delik parçaları kesmeyecek. (${csgError})`);

addLog(
  'info',
  firstRun
    ? 'Hoş geldiniz! Örnek iki parça eklendi. Deneyin: “mil parçasının çapını 10mm büyüt”, “tabanı kırmızı yap”, “ölçüleri gizle”. Tüm örnekler için “yardım” yazın.'
    : !restored
      ? `${ws ? `“${ws}” çalışma alanı: yeni` : 'Yeni'} boş proje. Örnek komutlar için “yardım” yazın.`
      : `${ws ? `“${ws}” çalışma alanı: proje` : 'Proje'} geri yüklendi${store.file ? ` (dosya: ${store.file}${store.dirty ? ', kaydedilmemiş değişiklik var' : ''})` : ''}. Örnek komutlar için “yardım” yazın.`,
);

// Aynı çalışma alanı başka bir sekmede açık: bu sekme kayıt yazmaz; kalıcı, görünür uyarı.
if (!autosaveOwner) {
  const text =
    `Bu çalışma alanı (${wsLabel(ws)}) başka bir sekmede de açık: bu sekmede otomatik kayıt kapalı (salt okunur kayıt); ` +
    'yaptığınız değişiklikler sayfa yenilenince kaybolur. Terminal komutları en son açılan sekmeye (bu sekmeye) gider. ' +
    'Diğer sekmeyi kapatıp bu sekmeyi yenileyin ya da projeyi dosyaya kaydedin.';
  const banner = document.createElement('div');
  banner.className = 'ro-banner';
  banner.setAttribute('role', 'alert');
  banner.textContent = '⚠ ' + text;
  $('viewport').appendChild(banner);
  addLog('warn', '⚠ ' + text);
}

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

/** Yeni/Aç… dosya bağını kaldırır: kullanıcı bunu bilsin (terminaldeki `p3d save` artık o dosyaya bağlı değil). */
function noteUnbound(prev: string | undefined): void {
  if (prev) addLog('info', `Dosya bağı kaldırıldı (önceki: ${prev}); bu proje bir dosyaya bağlı değil. Bağlamak için: p3d save <dosya.p3d.json>`);
}

$('btn-new').addEventListener('click', () => {
  if (store.project.parts.length && !confirm('Yeni proje açılsın mı? Kaydedilmemiş değişiklikler kaybolur.')) return;
  const prev = store.file;
  store.load(newProject());
  viewer.fit(store.project);
  addLog('info', 'Yeni proje oluşturuldu.');
  noteUnbound(prev);
});

function saveProject(): void {
  const file = `${safeFileName(store.project.name)}.p3d.json`;
  const noData = meshPartsWithoutData(store.project);
  download(file, projectToJson(store.project), 'application/json');
  if (noData.length) {
    // Dosya eksik: bu ağlar gömülemedi (yalnızca kimlik ve kaynak yolu yazıldı). "Kaydedildi" sayılmaz, sekme kirli kalır.
    const names = noData.map((p) => `'${p.name}'`).join(', ');
    addLog(
      'warn',
      `⚠ “${file}” indirildi ama ${names} ağ verisi bu sekmede yüklü değil (yer tutucu küp görünüyor); ağ dosyaya ` +
        'gömülemedi, yalnızca kaynak yolu yazıldı. Proje “kaydedildi” sayılmadı. Ağı yeniden içe aktarın ya da terminalden ' +
        'kaydedin (kaynak dosyadan okunur): p3d save <dosya.p3d.json>',
    );
    toast(`Kaydedildi sayılmadı: ${noData.length} ağın verisi yüklü değil, dosyaya gömülemedi (ayrıntı günlükte).`, true);
    return;
  }
  // İndirilen dosyanın tam yolu bilinmez; bağ yalnızca dosya adıdır (gösterim ve "kaydedildi" durumu için).
  store.markSaved(file);
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
    const dropped: string[] = [];
    const project = parseProject(JSON.parse(await file.text()), dropped);
    const prev = store.file;
    store.load(project);
    viewer.fit(store.project);
    addLog('info', `“${file.name}” yüklendi (${project.parts.length} parça).`);
    for (const d of dropped) addLog('warn', `⚠ Yüklenemedi: ${d}`);
    // Ağı yolla anılan (src) parçalar tarayıcıda okunamaz: yer tutucu küp sessiz kalmasın.
    const noData = meshPartsWithoutData(project).map((p) => {
      const src = p.geom?.kind === 'mesh' ? p.geom.src : undefined;
      return `'${p.name}' ağı dosyada gömülü değil (kaynak: ${src ?? 'yok'}); p3d open ile açın.`;
    });
    for (const m of noData) addLog('warn', `⚠ ${m} Şimdilik yer tutucu küp gösteriliyor.`);
    noteUnbound(prev);
    if (noData.length) toast(noData.length === 1 ? noData[0] : `${noData.length} ağ dosyada gömülü değil; p3d open ile açın (ayrıntı günlükte).`, true);
    else toast(dropped.length ? `Proje yüklendi; ${dropped.length} parça okunamadı (günlükte).` : 'Proje yüklendi.', dropped.length > 0);
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
    return Number.isFinite(n) ? Math.min(MAX_BED, Math.max(20, n)) : def;
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
