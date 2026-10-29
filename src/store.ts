import type { Op } from '../shared/ops';
import { registerAsset, usedAssets } from './assets';
import { applyOps, type ApplyResult } from './engine';
import type { Project } from './types';

const AUTOSAVE_KEY = 'p3d.autosave.v1';
/** Mesh ağ verisi ayrı anahtarda: proje her değiştiğinde yeniden yazılmasın. */
const ASSETS_KEY = 'p3d.autosave.assets.v1';
const HISTORY_LIMIT = 200;

type Listener = () => void;

/** Proje durumu: tüm değişiklikler işlem (Op) olarak uygulanır, her uygulama tek bir geri-al adımıdır. */
export class Store {
  project: Project;
  selectedId: string | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners = new Set<Listener>();
  private saveTimer: number | undefined;
  private savedAssets = '';
  /** Otomatik kayıt sorunları (ör. ağ verisi tarayıcı depolamasına sığmadı). */
  onWarning: (msg: string) => void = () => {};

  constructor(initial: Project) {
    this.project = initial;
  }

  subscribe(fn: Listener): void {
    this.listeners.add(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
    this.scheduleAutosave();
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
    if (JSON.stringify(draft) !== before) {
      this.undoStack.push(before);
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
      this.project = draft;
    }
    if (res.clearSelection) this.selectedId = null;
    if (res.lastPartId && this.project.parts.some((p) => p.id === res.lastPartId)) this.selectedId = res.lastPartId;
    this.emit();
    return res;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(prev);
    this.fixSelection();
    this.emit();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(next);
    this.fixSelection();
    this.emit();
    return true;
  }

  select(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emit();
  }

  /** Ayarlar gibi geri alınabilir ama işlem olmayan değişiklikler için. */
  mutate(fn: (p: Project) => void): void {
    const before = JSON.stringify(this.project);
    const draft: Project = JSON.parse(before);
    fn(draft);
    if (JSON.stringify(draft) === before) return;
    this.undoStack.push(before);
    this.redoStack = [];
    this.project = draft;
    this.emit();
  }

  /** Yeni proje ya da dosyadan yükleme: geçmiş sıfırlanır. */
  load(project: Project): void {
    this.project = project;
    this.selectedId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }

  private fixSelection(): void {
    if (this.selectedId && !this.project.parts.some((p) => p.id === this.selectedId)) this.selectedId = null;
  }

  private scheduleAutosave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.project));
      } catch {
        // Depolama kapalı/dolu olabilir; otomatik kayıt isteğe bağlıdır.
      }
      const assets = usedAssets(this.project);
      const key = Object.keys(assets).sort().join(',');
      if (key === this.savedAssets) return;
      try {
        localStorage.setItem(ASSETS_KEY, JSON.stringify(assets));
        this.savedAssets = key;
      } catch {
        this.savedAssets = key;
        this.onWarning('İçe aktarılan ağ tarayıcının otomatik kaydına sığmadı; sayfa yenilenirse kaybolur. Projeyi Kaydet ile dosyaya kaydedin.');
      }
    }, 400);
  }

  static restore(): Project | null {
    try {
      const assets = JSON.parse(localStorage.getItem(ASSETS_KEY) ?? '{}') as Record<string, unknown>;
      for (const a of Object.values(assets)) registerAsset(a);
    } catch {
      // Bozuk ağ kaydı: mesh parçaları yer tutucu olarak görünür.
    }
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}


