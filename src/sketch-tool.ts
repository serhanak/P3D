// Kalem aracı (DOM): 3B görünümde eskiz yolu çizme ve düzenleme. İşaretçi/klavye olayları, kalem durumu ve yüzen eskiz
// çubuğu burada; matematik sketch-edit.ts'te, çizim sketch-view.ts'te. Proje yalnızca işlemle değişir (`sketch_add`,
// `sketch_update`, `sketch_delete` → store.apply); sürükleme önizlemesi projeye yazılmaz, bırakınca tek işlem olur.
import type { GeomAxis, Op, SketchPath, SketchPlane, SketchPoint, Vec3 } from '../shared/ops';
import { partBox, type ApplyResult } from './engine';
import { fmt } from './shapes';
import { SKETCH_MAX_POINTS, findSketch, pathBox } from './sketch';
import {
  defaultPlane,
  dominantAxis,
  edgeSamples,
  edgeTotal,
  handlesFromDrag,
  hitEdge,
  hitPoint,
  movePoints,
  nearestCandidate,
  onPlane,
  rayAxisCoord,
  rayPlane,
  removePoints,
  roundPoints,
  setAxisCoord,
  snapCandidates,
  snapPoint,
  snapValue,
  splitEdge,
} from './sketch-edit';
import type { SketchViewState } from './sketch-view';
import type { Store } from './store';
import type { Project } from './types';
import type { Viewer } from './viewer';

/** Tık ile sürükleme ayrımı (px). */
const MOVE_PX = 4;
/** Nokta isabeti ve taslağı ilk noktada kapatma (px). */
const HIT_PX = 8;
/** Çizgi isabeti (px). */
const LINE_PX = 6;
/** Yakalama adayı toleransı (px; o derinlikteki mm karşılığı). */
const SNAP_PX = 10;
/** Izgara yakalama adımı (mm). */
const SNAP_STEP = 1;

const AXIS_UP: Record<GeomAxis, string> = { x: 'X', y: 'Y', z: 'Z' };

const HINT_IDLE = 'Tıkla: köşe · Sürükle: eğri · İlk noktaya tıkla: kapat · Enter: bitir · Esc: iptal/çık · X/Y/Z/N: eksen · Shift: yakala';
const HINT_DRAFT = 'Tıkla: köşe · Sürükle: eğri · İlk noktaya tıkla: kapat · Enter / çift tık: bitir · Backspace: son noktayı sil · Esc: iptal · Shift: yakala';
const HINT_EDIT =
  'Sürükle: taşı · Shift+tık: seçime ekle · X/Y/Z/N: eksen kilidi · rakam + Enter: değer (Shift+Enter: göreli) · Del: noktayı sil · Ctrl+tık çizgiye: nokta ekle · Esc: seçimi kaldır';

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export interface SketchToolHooks {
  /** İşlemleri uygular (arayüzdeki `applyFromUi`: hata varsa bildirir). */
  apply: (ops: Op[]) => ApplyResult | void;
  log?: (kind: 'info' | 'warn', text: string) => void;
  /** Kalem açıldı/kapandı (araç çubuğu düğmesi). */
  onActiveChange?: (active: boolean) => void;
}

interface Drag {
  pathId: string;
  pointerId: number;
  /** Başlangıç (client px) ve son işaretçi konumu. */
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  indices: number[];
  /** Sürükleme başındaki noktalar (eksen kilidi değişince o anki önizlemeye yeniden kurulur). */
  start: SketchPoint[];
  heldIndex: number;
  /** Kilit yokken hareket düzlemi: yol düzlemine paralel, tutulan noktadan geçer. */
  plane: SketchPlane;
  axis: GeomAxis | null;
  hit0: Vec3 | null;
  axis0: number | null;
  /** Eksen bakış yönüne neredeyse paralel (axis0 yok): ekrandaki dikey hareket eksen boyunca; referans y (client px). */
  baseY: number;
  moved: boolean;
}

interface Pending {
  x: number;
  y: number;
  /** Noktanın düzlemi (çizim düzlemi taslak sırasında değişebilir). */
  plane: SketchPlane;
  anchor: Vec3;
  release: Vec3 | null;
}

export class SketchTool {
  active = false;
  private visible = true;
  private plane: SketchPlane = { axis: 'z', at: 0 };
  private draft: SketchPoint[] | null = null;
  private draftPlane: SketchPlane | null = null;
  private pending: Pending | null = null;
  private selectedPoints: number[] = [];
  /** `selectedPoints`'in ait olduğu yol; mağazadaki seçim değişince nokta seçimi sıfırlanır. */
  private selPathId: string | null = null;
  private lock: GeomAxis | null = null;
  private numBuffer = '';
  private relative = false;
  private drag: Drag | null = null;
  private preview: SketchPoint[] | null = null;
  private cursor: Vec3 | null = null;
  private snapOn = false;
  private shift = false;
  private hinted = false;
  private candCache: { project: Project; exclude: string; pts: Vec3[] } | null = null;
  private viewport: HTMLElement;
  private bar: HTMLElement;

  constructor(
    private viewer: Viewer,
    private store: Store,
    private hooks: SketchToolHooks,
  ) {
    this.viewport = viewer.domElement.parentElement!;
    this.bar = this.buildBar();
    this.viewport.appendChild(this.bar);
    const el = viewer.domElement;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', () => {
      this.cancelGesture();
      this.push();
    });
    el.addEventListener('pointerleave', () => {
      if (!this.active || this.drag || this.pending) return;
      this.cursor = null;
      this.push();
    });
    el.addEventListener('dblclick', (e) => this.onDblClick(e));
    // Yakalama aşaması: kalem açıkken tüketilen tuşlar main.ts'teki kısayollara ulaşmaz.
    document.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  // -------------------------------------------------------------------------
  // Açma / kapama / görünürlük

  toggle(): void {
    if (this.active) this.close();
    else this.open();
  }

  /** Çizim ya da sürükleme sürüyor (taslak, bekleyen nokta, sürüklenen nokta): kamera tipi o sırada değişmez. */
  busy(): boolean {
    return this.active && (!!this.drag || !!this.draft || !!this.pending);
  }

  /** Eksen kilidi açık: rakam tuşları (Num 5 dahil) sayı girişine aittir, kamera kısayolu olarak kullanılmaz. */
  wantsNumber(): boolean {
    return this.active && !!this.lock;
  }

  /** Kalemi açar: düzlem = seçili yolun düzlemi; yoksa bakış yönüne göre (seçili parça varsa kameraya bakan yüzü). */
  open(): void {
    if (this.active) return;
    const path = this.selectedPath();
    if (path) {
      this.plane = { ...path.plane };
    } else {
      const part = this.store.selectedId ? this.store.project.parts.find((p) => p.id === this.store.selectedId) : undefined;
      const box = part ? partBox(part, this.store.project.settings.resolution) : null;
      const pl = defaultPlane(dominantAxis(this.viewer.viewDir()), this.viewer.cameraPos(), this.viewer.target(), box);
      this.plane = { axis: pl.axis, at: Number(pl.at.toFixed(3)) + 0 };
    }
    this.active = true;
    this.viewer.penMode = true;
    this.viewer.setLeftButton(false);
    this.viewport.classList.add('pen');
    this.bar.hidden = false;
    this.hooks.onActiveChange?.(true);
    if (!this.hinted) {
      this.hinted = true;
      this.hooks.log?.(
        'info',
        `Kalem açık: düzlem ${AXIS_UP[this.plane.axis]} = ${fmt(this.plane.at)} mm (çubuktan değiştirilebilir). Tıkla: köşe, sürükle: eğri, Enter: bitir, Esc: çık. Kamera: orta tuş döndürür, sağ tuş kaydırır, tekerlek yakınlaştırır.`,
      );
    }
    this.push();
  }

  close(): void {
    if (!this.active) return;
    this.cancelGesture();
    this.draft = null;
    this.draftPlane = null;
    this.lock = null;
    this.numBuffer = '';
    this.cursor = null;
    this.selectedPoints = [];
    this.active = false;
    this.viewer.penMode = false;
    this.viewer.setLeftButton(true);
    this.viewport.classList.remove('pen', 'pen-hover');
    this.bar.hidden = true;
    this.hooks.onActiveChange?.(false);
    this.push();
  }

  /** Eskiz katmanı anahtarı (yalnızca bellekte; kalem açıkken yok sayılır). */
  setVisible(v: boolean): void {
    this.visible = v;
    this.push();
  }

  /**
   * Mağaza değişince (main.ts → render, `viewer.sync`'ten önce): seçili yol değiştiyse nokta seçimi sıfırlanır (kalem
   * açıksa ve taslak yoksa çizim düzlemi o yolunkine geçer), artık olmayan indisler düşer; durum çizilmeden viewer'a
   * verilir (sync çizer).
   */
  refresh(): void {
    const id = this.store.selectedSketchId;
    if (id !== this.selPathId) {
      this.selPathId = id;
      this.selectedPoints = [];
      this.numBuffer = '';
      // Kalem açıkken başka yol seçildi (ör. listeden): çizim düzlemi o yolunkine geçer (taslak çizilirken değil).
      const path = this.selectedPath();
      if (this.active && !this.draft && path) this.plane = { ...path.plane };
    }
    const n = this.selectedPath()?.points.length ?? 0;
    this.selectedPoints = this.selectedPoints.filter((i) => i < n);
    if (this.drag && !findSketch(this.store.project, this.drag.pathId)) {
      this.drag = null;
      this.preview = null;
    }
    this.candCache = null;
    this.push(false);
  }

  // -------------------------------------------------------------------------
  // Durum → görünüm ve çubuk

  private selectedPath(): SketchPath | undefined {
    const id = this.store.selectedSketchId;
    return id ? this.store.project.sketch?.find((s) => s.id === id) : undefined;
  }

  private state(): SketchViewState {
    const path = this.selectedPath();
    let draft: SketchPoint[] | null = null;
    if (this.draft) {
      draft = [...this.draft];
      if (this.pending) draft.push(this.pendingPoint(this.pending));
    }
    let through: Vec3 | null = null;
    const pts = this.preview ?? path?.points;
    if (this.drag && this.preview) through = this.preview[this.drag.heldIndex]?.p ?? null;
    else if (pts && this.selectedPoints.length) {
      const sel = this.selectedPoints.map((i) => pts[i].p);
      through = { x: avg(sel.map((p) => p.x)), y: avg(sel.map((p) => p.y)), z: avg(sel.map((p) => p.z)) };
    }
    return {
      selectedId: this.store.selectedSketchId,
      selectedPoints: this.selectedPoints,
      preview: this.preview,
      draft,
      cursor: this.active && !this.pending && !this.drag ? this.cursor : null,
      plane: this.active ? this.plane : null,
      lock: this.active && this.lock && through ? { axis: this.lock, through } : null,
      visible: this.visible || this.active,
    };
  }

  private push(redraw = true): void {
    this.viewer.setSketchState(this.state(), redraw);
    this.renderBar();
  }

  private pendingPoint(p: Pending): SketchPoint {
    return p.release ? { p: p.anchor, ...handlesFromDrag(p.anchor, p.release) } : { p: p.anchor };
  }

  // -------------------------------------------------------------------------
  // Yakalama

  private snapping(): boolean {
    return this.shift || this.snapOn;
  }

  /** Görünür parçaların kutuları + eskiz noktaları (`exclude`: "yolKimliği:i,j" sürüklenen noktalar hariç). */
  private candidates(exclude: string): Vec3[] {
    const project = this.store.project;
    if (this.candCache?.project === project && this.candCache.exclude === exclude) return this.candCache.pts;
    const [exId, exIdx] = exclude.split(':');
    const skip = new Set((exIdx ?? '').split(',').filter(Boolean).map(Number));
    const boxes = project.parts.filter((p) => p.visible).map((p) => partBox(p, project.settings.resolution));
    const pts: Vec3[] = [];
    for (const s of project.sketch ?? []) {
      for (const [i, pt] of s.points.entries()) if (s.id !== exId || !skip.has(i)) pts.push(pt.p);
    }
    for (const pt of this.draft ?? []) pts.push(pt.p);
    const out = snapCandidates(boxes, pts);
    this.candCache = { project, exclude, pts: out };
    return out;
  }

  /** Düzlem içi yakalama: aday (düzleme izdüşürülmüş) ya da 1 mm ızgara; düzlemin kendi koordinatı korunur. */
  private snapInPlane(p: Vec3, plane: SketchPlane, exclude = ''): Vec3 {
    const tol = SNAP_PX * this.viewer.mmPerPixelAt(p);
    const c = nearestCandidate(p, this.candidates(exclude).map((c) => onPlane(c, plane)), tol);
    return c ?? snapPoint(p, SNAP_STEP, plane.axis);
  }

  /** Eksen boyunca yakalama: adayların eksen koordinatı ya da 1 mm. */
  private snapOnAxis(through: Vec3, axis: GeomAxis, value: number, exclude: string): number {
    const p = { ...through, [axis]: value };
    const tol = SNAP_PX * this.viewer.mmPerPixelAt(p);
    const c = nearestCandidate(p, this.candidates(exclude).map((c) => ({ ...through, [axis]: c[axis] })), tol);
    return c ? c[axis] : snapValue(value, SNAP_STEP);
  }

  private planePoint(clientX: number, clientY: number, plane: SketchPlane): Vec3 | null {
    const ray = this.viewer.rayAt(clientX, clientY);
    const p = rayPlane(ray.origin, ray.direction, plane);
    if (!p) return null;
    return this.snapping() ? this.snapInPlane(p, plane) : p;
  }

  // -------------------------------------------------------------------------
  // İsabet testleri (ekran)

  private paths(): SketchPath[] {
    const all = this.store.project.sketch ?? [];
    const sel = this.store.selectedSketchId;
    // Seçili yol önce: üst üste binen noktalarda o kazanır.
    return [...all.filter((s) => s.id === sel), ...all.filter((s) => s.id !== sel)];
  }

  private hitPoints(x: number, y: number): { path: SketchPath; index: number } | null {
    const proj = this.viewer.screenProjector();
    let best: { path: SketchPath; index: number; d: number } | null = null;
    for (const path of this.paths()) {
      const scr = path.points.map((pt) => proj(pt.p));
      const i = hitPoint(scr, x, y, HIT_PX);
      if (i < 0) continue;
      const d = Math.hypot(scr[i]!.x - x, scr[i]!.y - y);
      if (!best || d < best.d) best = { path, index: i, d };
    }
    return best;
  }

  private hitLines(x: number, y: number): { path: SketchPath; edge: number; t: number } | null {
    const proj = this.viewer.screenProjector();
    let best: { path: SketchPath; edge: number; t: number; dist: number } | null = null;
    for (const path of this.paths()) {
      const edges = [...Array(edgeTotal(path)).keys()].map((i) => edgeSamples(path, i).map(proj));
      const h = hitEdge(edges, x, y, LINE_PX);
      if (h && (!best || h.dist < best.dist)) best = { path, ...h };
    }
    return best;
  }

  private hitsFirstDraftPoint(x: number, y: number): boolean {
    if (!this.draft || this.draft.length < 3) return false;
    const s = this.viewer.toScreen(this.draft[0].p);
    return !!s && Math.hypot(s.x - x, s.y - y) <= HIT_PX;
  }

  // -------------------------------------------------------------------------
  // İşaretçi

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    this.shift = e.shiftKey;
    this.candCache = null;
    if (this.draft) {
      if (this.hitsFirstDraftPoint(e.clientX, e.clientY)) return this.finishDraft(true);
      this.startPending(e);
      return;
    }
    const hit = this.hitPoints(e.clientX, e.clientY);
    if (hit) return this.startDrag(e, hit.path, hit.index);
    const line = this.hitLines(e.clientX, e.clientY);
    if (line) {
      this.selPathId = line.path.id;
      this.numBuffer = '';
      if (e.ctrlKey || e.metaKey) {
        // Kenara nokta ekle (eğri kenar şeklini koruyarak bölünür).
        this.selectedPoints = [line.edge + 1];
        this.hooks.apply([{ op: 'sketch_update', path: line.path.id, points: roundPoints(splitEdge(line.path.points, line.path.closed, line.edge, line.t)) }]);
      } else {
        this.selectedPoints = [];
        this.store.selectSketch(line.path.id);
      }
      this.push();
      return;
    }
    // Boş yer: yeni yol çizimi başlar.
    if (!this.planePoint(e.clientX, e.clientY, this.plane)) return;
    this.draft = [];
    this.draftPlane = { ...this.plane };
    this.selectedPoints = [];
    this.selPathId = null;
    this.store.selectSketch(null);
    this.startPending(e);
  }

  private startPending(e: PointerEvent): void {
    const plane = { ...this.plane };
    const anchor = this.planePoint(e.clientX, e.clientY, plane);
    if (!anchor) return;
    this.pending = { x: e.clientX, y: e.clientY, plane, anchor, release: null };
    this.cursor = null;
    this.viewer.domElement.setPointerCapture(e.pointerId);
    this.push();
  }

  private startDrag(e: PointerEvent, path: SketchPath, index: number): void {
    this.numBuffer = '';
    if (path.id !== this.store.selectedSketchId) {
      this.selPathId = path.id;
      this.selectedPoints = [index];
      if (!this.draft) this.plane = { ...path.plane }; // başka yolun noktası: çizim düzlemi o yola geçer
      this.store.selectSketch(path.id);
    } else if (e.shiftKey) {
      this.selectedPoints = this.selectedPoints.includes(index) ? this.selectedPoints.filter((i) => i !== index) : [...this.selectedPoints, index];
    } else if (!this.selectedPoints.includes(index)) {
      this.selectedPoints = [index];
    }
    if (!this.selectedPoints.includes(index)) return this.push(); // Shift ile seçimden çıkarıldı
    this.drag = {
      pathId: path.id,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      indices: [...this.selectedPoints],
      start: path.points,
      heldIndex: index,
      plane: path.plane,
      axis: null,
      hit0: null,
      axis0: null,
      baseY: e.clientY,
      moved: false,
    };
    this.rebaseDrag();
    this.viewer.domElement.setPointerCapture(e.pointerId);
    this.push();
  }

  /** Sürüklemenin referansını (düzlem/eksen başlangıcı) son işaretçi konumuna göre yeniden kurar (kilit değişince de). */
  private rebaseDrag(): void {
    const d = this.drag;
    if (!d) return;
    const path = findSketch(this.store.project, d.pathId);
    if (!path) return;
    if (this.preview) d.start = this.preview;
    const held = d.start[d.heldIndex].p;
    d.axis = this.lock;
    d.plane = { axis: path.plane.axis, at: held[path.plane.axis] };
    const ray = this.viewer.rayAt(d.lastX, d.lastY);
    d.hit0 = rayPlane(ray.origin, ray.direction, d.plane);
    d.axis0 = d.axis ? rayAxisCoord(ray.origin, ray.direction, held, d.axis, this.viewer.viewDir()) : null;
    d.baseY = d.lastY;
  }

  private dragTo(e: PointerEvent): void {
    const d = this.drag!;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < MOVE_PX) return;
    d.moved = true;
    const ray = this.viewer.rayAt(e.clientX, e.clientY);
    const held = d.start[d.heldIndex].p;
    const exclude = `${d.pathId}:${d.indices.join(',')}`;
    let target: Vec3;
    if (d.axis) {
      const view = this.viewer.viewDir();
      const v = d.axis0 === null ? null : rayAxisCoord(ray.origin, ray.direction, held, d.axis, view);
      // Eksen bakış yönüne neredeyse paralelse (ör. üstten bakarken z) ekranda yukarı = kameraya doğru.
      let nv =
        v !== null && d.axis0 !== null
          ? held[d.axis] + (v - d.axis0)
          : held[d.axis] + (d.baseY - e.clientY) * this.viewer.mmPerPixelAt(held) * (view[d.axis] < 0 ? 1 : -1);
      if (this.snapping()) nv = this.snapOnAxis(held, d.axis, nv, exclude);
      target = { ...held, [d.axis]: nv };
    } else {
      const q = rayPlane(ray.origin, ray.direction, d.plane);
      if (!q || !d.hit0) return;
      target = add(held, sub(q, d.hit0));
      if (this.snapping()) target = this.snapInPlane(target, d.plane, exclude);
    }
    this.preview = movePoints(d.start, d.indices, sub(target, held));
    this.push();
  }

  private onMove(e: PointerEvent): void {
    if (!this.active) return;
    this.shift = e.shiftKey;
    if (this.drag) {
      if (e.pointerId === this.drag.pointerId) this.dragTo(e);
      return;
    }
    if (this.pending) {
      const p = this.pending;
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) >= MOVE_PX) p.release = this.planePoint(e.clientX, e.clientY, p.plane);
      this.push();
      return;
    }
    // Üzerinde gezinme: imleç noktası (taslakta lastik bant; ilk noktanın üstünde kapanışı gösterir) ve nokta imleci.
    if (this.hitsFirstDraftPoint(e.clientX, e.clientY)) this.cursor = { ...this.draft![0].p };
    else this.cursor = this.planePoint(e.clientX, e.clientY, this.plane);
    this.viewport.classList.toggle('pen-hover', !this.draft && !!this.hitPoints(e.clientX, e.clientY));
    this.push();
  }

  private onUp(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    this.shift = e.shiftKey;
    if (this.viewer.domElement.hasPointerCapture(e.pointerId)) this.viewer.domElement.releasePointerCapture(e.pointerId);
    if (this.drag) {
      const d = this.drag;
      const pts = this.preview;
      this.drag = null;
      this.preview = null;
      this.candCache = null;
      if (d.moved && pts) this.hooks.apply([{ op: 'sketch_update', path: d.pathId, points: roundPoints(pts) }]);
      // Çoklu seçimde sürüklemeden tıklanan nokta (Shift'siz) tek başına seçilir.
      else if (!d.moved && !e.shiftKey && this.selectedPoints.length > 1) this.selectedPoints = [d.heldIndex];
      this.push();
      return;
    }
    if (this.pending && this.draft) {
      const p = this.pending;
      this.pending = null;
      p.release = Math.hypot(e.clientX - p.x, e.clientY - p.y) >= MOVE_PX ? this.planePoint(e.clientX, e.clientY, p.plane) : null;
      this.draft = [...this.draft, ...roundPoints([this.pendingPoint(p)])];
      this.cursor = null;
      if (this.draft.length >= SKETCH_MAX_POINTS) return this.finishDraft(false);
      this.push();
    }
  }

  /** Çift tık: taslağı açık bitirir (çift tıkın ikinci tıkının eklediği yinelenen nokta atılır). */
  private onDblClick(e: MouseEvent): void {
    if (!this.active || !this.draft) return;
    const d = this.draft;
    if (d.length >= 2) {
      const proj = this.viewer.screenProjector();
      const [a, b] = [proj(d[d.length - 2].p), proj(d[d.length - 1].p)];
      if (a && b && Math.hypot(a.x - b.x, a.y - b.y) < MOVE_PX) d.pop();
    }
    e.preventDefault();
    this.finishDraft(false);
  }

  private cancelGesture(): void {
    if (this.drag || this.preview) {
      this.drag = null;
      this.preview = null;
    }
    this.pending = null;
    // İlk tık iptal edildiyse boş taslak kalmasın (taslak varken var olan noktalar seçilemez).
    if (this.draft && !this.draft.length) {
      this.draft = null;
      this.draftPlane = null;
    }
    this.candCache = null;
  }

  // -------------------------------------------------------------------------
  // İşlemler

  /** Taslağı yol olarak ekler: kapalı (≥ 3 nokta) ya da açık (1 nokta işaret, 2 ok, ≥ 3 çizgi). */
  private finishDraft(closed: boolean): void {
    const pts = this.draft;
    const plane = this.draftPlane ?? this.plane;
    this.draft = null;
    this.draftPlane = null;
    this.pending = null;
    if (pts?.length) {
      this.selPathId = null;
      this.hooks.apply([{ op: 'sketch_add', closed: closed && pts.length >= 3, plane: { ...plane }, points: pts }]);
    }
    this.push();
  }

  private applyPoints(path: SketchPath, points: SketchPoint[]): void {
    this.hooks.apply([{ op: 'sketch_update', path: path.id, points: roundPoints(points) }]);
  }

  /** Seçili noktaların kilit eksenindeki koordinatı: mutlak ya da göreli (delta). */
  private applyAxisValue(value: number, relative: boolean): void {
    const path = this.selectedPath();
    if (!path || !this.lock || !this.selectedPoints.length || !Number.isFinite(value)) return;
    const a = this.lock;
    const pts = relative
      ? movePoints(path.points, this.selectedPoints, { x: a === 'x' ? value : 0, y: a === 'y' ? value : 0, z: a === 'z' ? value : 0 })
      : setAxisCoord(path.points, this.selectedPoints, a, value);
    this.applyPoints(path, pts);
  }

  /**
   * Seçili noktaları (yoksa seçili yolu) siler; nokta kalmazsa yol silinir. Seçili yol yoksa false (tuş main.ts'e geçer:
   * seçili parça varsa o silinir).
   */
  private deleteSelection(): boolean {
    const path = this.selectedPath();
    if (!path) return false;
    if (this.selectedPoints.length) {
      const rest = removePoints(path.points, this.selectedPoints);
      this.selectedPoints = [];
      if (rest.length) this.applyPoints(path, rest);
      else this.hooks.apply([{ op: 'sketch_delete', path: path.id }]);
    } else {
      this.hooks.apply([{ op: 'sketch_delete', path: path.id }]);
    }
    return true;
  }

  private normalAxis(): GeomAxis {
    return this.selectedPath()?.plane.axis ?? this.plane.axis;
  }

  private setLock(axis: GeomAxis | null): void {
    this.lock = axis;
    this.rebaseDrag();
  }

  // -------------------------------------------------------------------------
  // Klavye

  private numericActive(): boolean {
    return !!this.lock && this.selectedPoints.length > 0 && !this.draft && !!this.selectedPath();
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key;
    const k = key.length === 1 ? key.toLowerCase() : key;
    let used = true;
    if (key === 'Escape') this.escape();
    else if (key === 'Enter') used = this.enter(e.shiftKey);
    else if (key === 'Backspace') used = this.backspace();
    else if (key === 'Delete') used = this.deleteSelection();
    else if (this.numericActive() && /^[0-9.,-]$/.test(key)) this.typeNumber(key);
    else if (k === 'x' || k === 'y' || k === 'z') this.setLock(this.lock === k ? null : k);
    else if (k === 'n') this.setLock(this.lock === this.normalAxis() ? null : this.normalAxis());
    else used = false;
    if (!used) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.push();
  }

  private typeNumber(key: string): void {
    if (key === '-') {
      if (!this.numBuffer) this.numBuffer = '-';
    } else if (key === '.' || key === ',') {
      if (!this.numBuffer.includes('.')) this.numBuffer += '.';
    } else {
      this.numBuffer += key;
    }
  }

  private escape(): void {
    if (this.drag) {
      this.cancelGesture();
    } else if (this.draft || this.pending) {
      this.draft = null;
      this.draftPlane = null;
      this.pending = null;
    } else if (this.numBuffer) {
      this.numBuffer = '';
    } else if (this.lock) {
      this.setLock(null);
    } else if (this.selectedPoints.length) {
      this.selectedPoints = [];
    } else {
      this.close();
    }
  }

  private enter(shift: boolean): boolean {
    if (this.draft) {
      this.finishDraft(false);
      return true;
    }
    if (this.numBuffer) {
      const v = parseFloat(this.numBuffer);
      this.numBuffer = '';
      this.applyAxisValue(v, shift);
      return true;
    }
    return false;
  }

  private backspace(): boolean {
    if (this.numBuffer) {
      this.numBuffer = this.numBuffer.slice(0, -1);
      return true;
    }
    if (this.draft && !this.pending) {
      this.draft = this.draft.slice(0, -1);
      if (!this.draft.length) {
        this.draft = null;
        this.draftPlane = null;
      }
      return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Yüzen eskiz çubuğu

  private buildBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'sketch-bar';
    bar.hidden = true;
    const axisBtns = (attr: string, title: (a: string) => string) =>
      (['x', 'y', 'z'] as const).map((a) => `<button class="axis-btn ax-${a}" ${attr}="${a}" title="${title(AXIS_UP[a])}">${AXIS_UP[a]}</button>`).join('');
    bar.innerHTML = `
      <div class="sb-row">
        <span class="sb-label">Düzlem</span>
        <span class="seg">${axisBtns('data-plane', (a) => `${a} eksenine dik düzlemde çiz`)}</span>
        <label class="sb-label" title="Düzlemin eksendeki konumu">konum <input type="number" step="0.5" data-sb="at" /> mm</label>
        <span class="sb-move">
          <span class="sb-sep"></span>
          <span class="sb-label">Taşı</span>
          <span class="seg">
            <button class="axis-btn" data-lock="" title="Yol düzlemine paralel serbest taşıma">Serbest</button>
            ${axisBtns('data-lock', (a) => `Yalnızca ${a} ekseninde taşı (${a})`)}
            <button class="axis-btn" data-lock="n" title="Yol düzleminin normalinde taşı (N)">N</button>
          </span>
          <input type="number" step="0.5" data-sb="value" title="Seçili noktaların kilit eksenindeki değeri (mm)" />
          <label class="sb-label" title="Değer mevcut konuma eklenir"><input type="checkbox" data-sb="rel" /> göreli</label>
          <button data-sb="apply">Uygula</button>
          <span class="muted sb-count"></span>
        </span>
        <span class="sb-buf"></span>
        <span class="sb-sep"></span>
        <label class="sb-label" title="Shift basılıyken de yakalar: parça köşe/yüz merkezleri, eskiz noktaları, 1 mm ızgara"><input type="checkbox" data-sb="snap" /> Yakala 1 mm</label>
        <button class="sb-close" data-sb="close" title="Kalemi kapat (Esc)">✕</button>
      </div>
      <div class="sb-hint"></div>`;
    bar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!b) return;
      if (b.dataset.plane) this.setPlaneAxis(b.dataset.plane as GeomAxis);
      else if (b.dataset.lock !== undefined) {
        const v = b.dataset.lock;
        this.setLock(v === 'n' ? this.normalAxis() : v ? (v as GeomAxis) : null);
      } else if (b.dataset.sb === 'apply') this.applyValueField();
      else if (b.dataset.sb === 'close') return this.close();
      this.push();
    });
    bar.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const f = t.dataset.sb;
      if (f === 'at') {
        const v = parseFloat(t.value.replace(',', '.'));
        if (Number.isFinite(v)) this.plane = { ...this.plane, at: v };
      } else if (f === 'value') this.applyValueField();
      else if (f === 'snap') this.snapOn = t.checked;
      else if (f === 'rel') this.relative = t.checked;
      this.push();
    });
    return bar;
  }

  /** Düzlem ekseni değişince konum: seçili yolun (yoksa seçili parçanın) kameraya bakan yüzü, ikisi de yoksa 0. */
  private setPlaneAxis(axis: GeomAxis): void {
    if (axis === this.plane.axis) return;
    const path = this.selectedPath();
    const part = !path && this.store.selectedId ? this.store.project.parts.find((p) => p.id === this.store.selectedId) : undefined;
    const box = path ? pathBox(path) : part ? partBox(part, this.store.project.settings.resolution) : null;
    const pl = defaultPlane(axis, this.viewer.cameraPos(), this.viewer.target(), box);
    this.plane = { axis, at: Number(pl.at.toFixed(3)) + 0 };
  }

  private applyValueField(): void {
    const input = this.bar.querySelector<HTMLInputElement>('[data-sb="value"]')!;
    const v = parseFloat(input.value.replace(',', '.'));
    if (Number.isFinite(v)) this.applyAxisValue(v, this.relative);
  }

  private renderBar(): void {
    if (this.bar.hidden) return;
    const q = <T extends HTMLElement>(s: string) => this.bar.querySelector<T>(s)!;
    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-plane]')) b.classList.toggle('active', b.dataset.plane === this.plane.axis);
    const at = q<HTMLInputElement>('[data-sb="at"]');
    if (document.activeElement !== at) at.value = String(Number(this.plane.at.toFixed(3)));
    const path = this.selectedPath();
    const n = path ? this.selectedPoints.length : 0;
    q('.sb-move').hidden = !n;
    const normal = this.normalAxis();
    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-lock]')) {
      const v = b.dataset.lock;
      b.classList.toggle('active', v === 'n' ? this.lock === normal : v ? this.lock === v : !this.lock);
    }
    const value = q<HTMLInputElement>('[data-sb="value"]');
    value.disabled = !this.lock;
    if (document.activeElement !== value) {
      const pts = this.preview ?? path?.points;
      const vals = this.lock && pts ? [...new Set(this.selectedPoints.map((i) => Number(pts[i].p[this.lock!].toFixed(3))))] : [];
      value.value = this.relative ? '' : vals.length === 1 ? String(vals[0]) : '';
      value.placeholder = !this.lock ? 'eksen seçin' : this.relative ? 'Δ mm' : vals.length > 1 ? 'karışık' : '';
    }
    q<HTMLInputElement>('[data-sb="rel"]').checked = this.relative;
    q<HTMLInputElement>('[data-sb="snap"]').checked = this.snapOn;
    q('.sb-count').textContent = n ? `(${n} nokta)` : '';
    const buf = q('.sb-buf');
    buf.textContent = this.numBuffer && this.lock ? `${AXIS_UP[this.lock]} = ${this.numBuffer}  (Enter: mutlak · Shift+Enter: göreli)` : '';
    buf.hidden = !buf.textContent;
    q('.sb-hint').textContent = this.draft ? HINT_DRAFT : n ? HINT_EDIT : HINT_IDLE;
  }
}

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
