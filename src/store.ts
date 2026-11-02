import { contentDigest, type Op } from '../shared/ops';
import type { AutosaveBackend } from './autosave';
import { applyOps, type ApplyResult } from './engine';
import type { Project } from './types';

const HISTORY_LIMIT = 200;

type Listener = () => void;

/** Proje durumu: tüm değişiklikler işlem (Op) olarak uygulanır, her uygulama tek bir geri-al adımıdır. */
export class Store {
  project: Project;
  selectedId: string | null = null;
  /** Sekmenin bağlı olduğu proje dosyası (yalnızca gösterim; `p3d open`/`p3d save`/Kaydet kurar). */
  file: string | undefined;
  /** Son yükleme/kayıttan sonra proje değişti mi. */
  dirty = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private saveTimer: number | undefined;
  /** Son yüklenen/kaydedilen projenin JSON'u; null = bilinmiyor (kirli sayılır). */
  private savedJson: string | null;
  /** Otomatik kayıt sorunları (ör. ağ verisi tarayıcı depolamasına sığmadı). */
  onWarning: (msg: string) => void = () => {};

  constructor(
    initial: Project,
    private backend: AutosaveBackend | null = null,
    saved: { file?: string; dirty?: boolean } = {},
  ) {
    this.project = initial;
    this.file = saved.file;
    this.savedJson = saved.dirty ? null : JSON.stringify(initial);
    this.dirty = !!saved.dirty;
  }

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }

  /**
   * Abonelere bildirir. `json`: projenin yeni JSON'u (biliniyorsa; kirlilik bununla hesaplanır), `false`: proje
   * değişmedi (ör. yalnızca seçim) — kirlilik yeniden hesaplanmaz, otomatik kayıt da gerekmez.
   */
  private emit(json?: string | false): void {
    if (json !== false) this.dirty = this.savedJson === null || this.savedJson !== (json ?? JSON.stringify(this.project));
    for (const fn of this.listeners) fn();
    if (json !== false) this.scheduleAutosave();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  apply(ops: Op[]): ApplyResult {
    const before = JSON.stringify(this.project);
    const draft: Project = JSON.parse(before);
    const res = applyOps(draft, ops, this.selectedId);
    const after = JSON.stringify(draft);
    const changed = after !== before;
    if (changed) {
      this.undoStack.push(before);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.project = draft;
    }
    if (res.clearSelection) this.selectedId = null;
    if (res.lastPartId && this.project.parts.some((p) => p.id === res.lastPartId)) this.selectedId = res.lastPartId;
    this.emit(changed ? after : false);
    return res;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(prev);
    this.fixSelection();
    this.emit(prev);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(next);
    this.fixSelection();
    this.emit(next);
    return true;
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit(false);
  }

  /** Ayarlar gibi geri alınabilir ama işlem olmayan değişiklikler için. */
  mutate(fn: (p: Project) => void): void {
    const before = JSON.stringify(this.project);
    const draft: Project = JSON.parse(before);
    fn(draft);
    const after = JSON.stringify(draft);
    if (after === before) return;
    this.undoStack.push(before);
    this.redoStack = [];
    this.project = draft;
    this.emit(after);
  }

  /** Yeni proje ya da dosyadan yükleme: geçmiş sıfırlanır, dosya bağı kalkar, proje kaydedilmiş sayılır. */
  load(project: Project): void {
    this.project = project;
    this.selectedId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.file = undefined;
    this.savedJson = JSON.stringify(project);
    this.emit(this.savedJson);
  }

  /**
   * Geri alınabilir yükleme (köprüden `p3d open`): önceki proje geri-al yığınına girer. Dosya bağı `file` olur
   * (verilmezse kalkar). Yeni proje kaydedilmiş sayılır; `dirty` ise (ör. dosyadaki bazı parçalar atlandı)
   * kaydedilene kadar kirli kalır.
   */
  replace(project: Project, file?: string, dirty = false): void {
    this.undoStack.push(JSON.stringify(this.project));
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.project = project;
    this.selectedId = null;
    this.file = file;
    const json = JSON.stringify(project);
    this.savedJson = dirty ? null : json;
    this.emit(json);
  }

  /**
   * Proje dosyaya kaydedildi (`p3d save`, Kaydet): dosya bağını kurar ve mevcut durumu kaydedilmiş sayar.
   * `digest` verilirse (kaydedilen projenin `contentDigest`'i) yalnızca güncel proje aynıysa kaydedilmiş sayılır;
   * değilse (proje kayıt sırasında değişti) dosya bağı yine kurulur ama sekme kirli kalır ve false döner.
   */
  markSaved(file: string, digest?: string): boolean {
    const json = JSON.stringify(this.project);
    const same = digest === undefined || contentDigest(json) === digest;
    this.file = file;
    this.savedJson = same ? json : null;
    this.emit(json);
    return same;
  }

  private fixSelection(): void {
    if (this.selectedId && !this.project.parts.some((p) => p.id === this.selectedId)) this.selectedId = null;
  }

  private scheduleAutosave(): void {
    if (!this.backend) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.backend?.save({ project: this.project, file: this.file, dirty: this.dirty }, (m) => this.onWarning(m));
    }, 400);
  }
}
