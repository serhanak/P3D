// Eskizin three.js çizimi: yollar, oklar, işaretler ve adları WebGL'de çizilir (CSS etiketi değil), böylece `p3d snapshot`
// görüntülerine de girer. Kalem aracının yardımcıları (çizim düzlemi ızgarası, eksen kılavuzu, taslak, seçim vurgusu,
// tutamaçlar) snapshot sırasında gizlenir. Görünüm durumu (seçim, önizleme, taslak) projeye yazılmaz.
import * as THREE from 'three';
import type { GeomAxis, SketchPath, SketchPlane, SketchPoint, Vec3 } from '../shared/ops';
import { partsBox } from './engine';
import { roleOf } from './model';
import { pathBox, samplePath, sketchKind } from './sketch';
import type { Project } from './types';

export interface SketchViewState {
  /** Seçili yol (`store.selectedSketchId`). */
  selectedId: string | null;
  /** Seçili yolun seçili nokta indisleri. */
  selectedPoints: number[];
  /** Sürükleme önizlemesi: seçili yolun geçici noktaları (projeye yazılmadan). */
  preview: SketchPoint[] | null;
  /** Çizilmekte olan yol (son nokta yerleştiriliyorsa o da dahil). */
  draft: SketchPoint[] | null;
  /** İmlecin çizim düzlemindeki noktası (taslakta lastik bant ucu). */
  cursor: Vec3 | null;
  /** Kalem açıkken çizim düzlemi (ızgara). */
  plane: SketchPlane | null;
  /** Eksen kilidi kılavuzu: `through`'dan geçen eksen çizgisi. */
  lock: { axis: GeomAxis; through: Vec3 } | null;
  /** Eskiz katmanı görünür mü (kalem açıkken araç zorla true verir). */
  visible: boolean;
}

export const EMPTY_SKETCH_STATE: SketchViewState = {
  selectedId: null,
  selectedPoints: [],
  preview: null,
  draft: null,
  cursor: null,
  plane: null,
  lock: null,
  visible: true,
};

const PATH_COLOR = 0xff7ac8;
const SELECTED_COLOR = 0xffd36b;
const HANDLE_COLOR = 0x9ad0ff;
const CURSOR_COLOR = 0xffffff;
const GRID_COLOR = 0x4f8ef7;
const AXIS_COLOR: Record<GeomAxis, number> = { x: 0xe5534b, y: 0x57ab5a, z: 0x539bf5 };
const LABEL_MAX_NOTE = 24;

type ColorMat = THREE.LineBasicMaterial | THREE.PointsMaterial | THREE.MeshBasicMaterial;

interface PathEntry {
  key: string;
  /** Çizgi, noktalar, ok başı, işaret, ad (snapshot'ta görünür). */
  base: THREE.Group;
  /** Seçili noktalar ve tutamaçlar (snapshot'ta gizli). */
  edit: THREE.Group;
  /** Seçili yolda vurgu rengini taşıyan malzemeler (snapshot'ta yol rengine döner). */
  mats: ColorMat[];
  selected: boolean;
  label: string;
}

interface LabelTex {
  tex: THREE.CanvasTexture;
  /** CSS piksel boyutu. */
  w: number;
  h: number;
}

const v3 = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);

/** Yolun ad etiketi: ad (+ " · not", not 24 karaktere kırpılır). */
export function sketchLabel(path: Pick<SketchPath, 'name' | 'note'>): string {
  const note = (path.note ?? '').replace(/\s+/g, ' ').trim();
  if (!note) return path.name;
  return `${path.name} · ${note.length > LABEL_MAX_NOTE ? note.slice(0, LABEL_MAX_NOTE - 1).trimEnd() + '…' : note}`;
}

/** Eskiz yollarının (eğriler dahil) birleşik kutusu; yol yoksa null. */
export function sketchBox(paths: readonly SketchPath[] | undefined): THREE.Box3 | null {
  if (!paths?.length) return null;
  const box = new THREE.Box3();
  for (const s of paths) {
    const b = pathBox(s);
    box.expandByPoint(v3(b.min)).expandByPoint(v3(b.max));
  }
  return box;
}

/** Nesne ağacını boşaltır: geometri ve malzemeler dispose edilir (Sprite'ın paylaşılan geometrisi ve doku önbelleği hariç). */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (o instanceof THREE.Sprite) {
      o.material.dispose();
    } else if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  for (const c of [...root.children]) root.remove(c);
}

export class SketchView {
  readonly root = new THREE.Group();
  private pathsRoot = new THREE.Group();
  private overlay = new THREE.Group();
  private grid: THREE.LineSegments | null = null;
  private gridKey = '';
  private entries = new Map<string, PathEntry>();
  private labels = new Map<string, LabelTex>();
  private dot: THREE.CanvasTexture | null = null;
  private project: Project | null = null;
  private boxProject: Project | null = null;
  /** Tabla ∪ görünür parçalar (ızgara boyutu ve kılavuz uzunluğu). */
  private sceneBox = new THREE.Box3();
  /** Büyük tablada (oyun ölçeği) ok başı ve işaret büyür (viewer'daki eksen göstergesiyle aynı kural). */
  private k = 1;
  private snapshotMode = false;

  constructor() {
    this.root.name = 'sketch';
    this.root.add(this.pathsRoot, this.overlay);
  }

  /** Eskizi projeyle ve görünüm durumuyla eşitler; değişmeyen yollar yeniden üretilmez. */
  sync(project: Project, state: SketchViewState): void {
    this.project = project;
    this.root.visible = state.visible;
    if (project !== this.boxProject) {
      this.boxProject = project;
      const { bedX, bedY } = project.settings;
      this.k = Math.max(1, Math.max(bedX, bedY) / 2000);
      const visible = project.parts.filter((p) => p.visible && roleOf(p) !== 'hole');
      this.sceneBox = visible.length ? partsBox(visible, project.settings.resolution) : new THREE.Box3();
      this.sceneBox.expandByPoint(new THREE.Vector3(-bedX / 2, -bedY / 2, 0)).expandByPoint(new THREE.Vector3(bedX / 2, bedY / 2, 0));
    }

    const seen = new Set<string>();
    for (const path of project.sketch ?? []) {
      seen.add(path.id);
      const selected = path.id === state.selectedId;
      const points = selected && state.preview ? state.preview : path.points;
      const label = sketchLabel(path);
      const key = JSON.stringify([label, path.closed, points, selected, selected ? state.selectedPoints : 0, this.k]);
      const old = this.entries.get(path.id);
      if (old?.key === key) continue;
      if (old) this.removeEntry(old);
      const entry = this.buildEntry({ ...path, points }, selected, selected ? state.selectedPoints : [], label, key);
      this.entries.set(path.id, entry);
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.removeEntry(e);
        this.entries.delete(id);
      }
    }
    // Artık kullanılmayan ad dokuları atılır.
    const used = new Set([...this.entries.values()].map((e) => e.label));
    for (const [text, l] of this.labels) {
      if (!used.has(text)) {
        l.tex.dispose();
        this.labels.delete(text);
      }
    }
    this.buildOverlay(state);
    this.applySnapshotMode();
  }

  /** Görünür eskizin kutusu (snapshot kadrajı için); katman gizliyse ya da eskiz yoksa null. */
  visibleBox(): THREE.Box3 | null {
    if (!this.root.visible || !this.project) return null;
    return sketchBox(this.project.sketch);
  }

  /**
   * Kalem yardımcılarının kutusu (taslak, imleç, tutamaçlar, eksen kilidi kılavuzu, düzlem ızgarası); yoksa null. Ortografik
   * kameranın derinlik hesabına katılır (sahne kutusunun dışına taşan yardımcı kırpılmasın).
   */
  helperBox(): THREE.Box3 | null {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.overlay);
    if (this.grid) box.expandByObject(this.grid);
    return box.isEmpty() ? null : box;
  }

  /** Snapshot sırasında yalnızca yollar, oklar, işaretler ve adlar görünür; seçim vurgusu yol rengine döner. */
  setSnapshotMode(on: boolean): void {
    this.snapshotMode = on;
    this.applySnapshotMode();
  }

  dispose(): void {
    for (const e of this.entries.values()) this.removeEntry(e);
    this.entries.clear();
    for (const l of this.labels.values()) l.tex.dispose();
    this.labels.clear();
    disposeTree(this.overlay);
    this.setGrid(null, '');
    this.dot?.dispose();
    this.dot = null;
  }

  private applySnapshotMode(): void {
    const on = this.snapshotMode;
    this.overlay.visible = !on;
    if (this.grid) this.grid.visible = !on;
    for (const e of this.entries.values()) {
      e.edit.visible = !on;
      if (e.selected) for (const m of e.mats) m.color.set(on ? PATH_COLOR : SELECTED_COLOR);
    }
  }

  private removeEntry(e: PathEntry): void {
    disposeTree(e.base);
    disposeTree(e.edit);
    this.pathsRoot.remove(e.base, e.edit);
  }

  // -------------------------------------------------------------------------
  // Yapı taşları

  /** Yuvarlak nokta dokusu (PointsMaterial kare yerine daire çizsin); tek ve paylaşılan. */
  private dotTexture(): THREE.CanvasTexture {
    if (this.dot) return this.dot;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(16, 16, 14, 0, Math.PI * 2);
    ctx.fill();
    this.dot = new THREE.CanvasTexture(c);
    return this.dot;
  }

  private line(pts: Vec3[], color: number, closed: boolean, opacity = 1): THREE.Line {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(v3));
    const m = new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity });
    const l = closed ? new THREE.LineLoop(g, m) : new THREE.Line(g, m);
    l.renderOrder = 20;
    return l;
  }

  private dots(pts: Vec3[], color: number, size: number, order = 21): THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> {
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(v3));
    const m = new THREE.PointsMaterial({
      color,
      size,
      sizeAttenuation: false,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      map: this.dotTexture(),
      alphaTest: 0.5,
    });
    const p = new THREE.Points(g, m);
    p.renderOrder = order;
    return p;
  }

  private buildEntry(path: SketchPath, selected: boolean, selPoints: number[], label: string, key: string): PathEntry {
    const color = selected ? SELECTED_COLOR : PATH_COLOR;
    const base = new THREE.Group();
    const edit = new THREE.Group();
    const mats: ColorMat[] = [];
    const samples = samplePath(path);
    const kind = sketchKind(path);

    if (samples.length >= 2) {
      const l = this.line(samples, color, path.closed && path.points.length >= 3);
      mats.push(l.material as THREE.LineBasicMaterial);
      base.add(l);
    }
    const pts = this.dots(path.points.map((pt) => pt.p), color, 7);
    mats.push(pts.material);
    base.add(pts);

    if (kind === 'arrow' && samples.length >= 2) {
      // Ok başı: son örnek kenarının yönünde (eğri okta uçtaki teğet), ucu son noktada.
      const tip = v3(samples[samples.length - 1]);
      const dir = tip.clone().sub(v3(samples[samples.length - 2]));
      const total = new THREE.Vector3().subVectors(v3(path.points[1].p), v3(path.points[0].p)).length();
      if (dir.lengthSq() > 1e-12 && total > 0) {
        dir.normalize();
        const h = Math.min(8 * this.k, Math.max(1.5 * this.k, total * 0.15));
        const m = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
        const cone = new THREE.Mesh(new THREE.ConeGeometry(h * 0.35, h, 16), m);
        cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
        cone.position.copy(tip).addScaledVector(dir, -h / 2);
        cone.renderOrder = 20;
        mats.push(m);
        base.add(cone);
      }
    } else if (kind === 'marker') {
      const m = new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.85 });
      const gem = new THREE.Mesh(new THREE.OctahedronGeometry(1.5 * this.k), m);
      gem.position.copy(v3(path.points[0].p));
      gem.renderOrder = 20;
      mats.push(m);
      base.add(gem);
    }

    base.add(this.labelSprite(label, path.points[0].p));

    // Seçili noktalar ve tutamaçları.
    const sel = selPoints.filter((i) => i >= 0 && i < path.points.length);
    if (sel.length) {
      edit.add(this.dots(sel.map((i) => path.points[i].p), SELECTED_COLOR, 10, 23));
      const segs: Vec3[] = [];
      const ends: Vec3[] = [];
      for (const i of sel) {
        const pt = path.points[i];
        for (const h of [pt.hIn, pt.hOut]) {
          if (!h) continue;
          const e = { x: pt.p.x + h.x, y: pt.p.y + h.y, z: pt.p.z + h.z };
          segs.push(pt.p, e);
          ends.push(e);
        }
      }
      if (segs.length) {
        const g = new THREE.BufferGeometry().setFromPoints(segs.map(v3));
        const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: HANDLE_COLOR, depthTest: false, transparent: true, opacity: 0.8 }));
        ls.renderOrder = 22;
        edit.add(ls, this.dots(ends, HANDLE_COLOR, 6, 23));
      }
    }

    this.pathsRoot.add(base, edit);
    return { key, base, edit, mats, selected, label };
  }

  /** Ad etiketi: tuval dokulu Sprite; ekranda sabit piksel boyutu, noktanın sağ üstünde. */
  private labelSprite(text: string, at: Vec3): THREE.Sprite {
    const l = this.labelTexture(text);
    const mat = new THREE.SpriteMaterial({ map: l.tex, sizeAttenuation: false, depthTest: false, depthWrite: false, transparent: true });
    const sp = new THREE.Sprite(mat);
    sp.position.copy(v3(at));
    sp.center.set(-6 / l.w, -0.45); // çapa noktanın 6 px solunda ve biraz altında: etiket noktanın sağ üstünde
    sp.renderOrder = 24;
    sp.frustumCulled = false;
    const size = new THREE.Vector2();
    const ndc = new THREE.Vector3();
    // Ölçek her çizimde kameradan hesaplanır: ana görünüm, yeniden boyutlanma ve snapshot (dik/perspektif) kameraları için
    // aynı piksel boyutu. sizeAttenuation: false + perspektifte ölçek × (−z) uygulanır; dik izdüşümde ölçek dünya birimidir.
    sp.onBeforeRender = (renderer, _scene, camera) => {
      const H = Math.max(1, renderer.getSize(size).y);
      const W = Math.max(1, size.x);
      // Görüntü kenarına taşacak etiket noktanın öbür yanına geçer (snapshot kadrajı eskizin kutusuna sığar, yazıya değil).
      ndc.setFromMatrixPosition(sp.matrixWorld).project(camera);
      const right = ndc.x + ((l.w + 8) * 2) / W > 1;
      const above = ndc.y + (l.h * 1.5 * 2) / H > 1;
      sp.center.set(right ? 1 + 6 / l.w : -6 / l.w, above ? 1.45 : -0.45);
      let f = 1 / H;
      if (camera instanceof THREE.PerspectiveCamera) f = (2 * Math.tan((camera.fov * Math.PI) / 360)) / camera.zoom / H;
      else if (camera instanceof THREE.OrthographicCamera) f = (camera.top - camera.bottom) / camera.zoom / H;
      sp.scale.set(l.w * f, l.h * f, 1);
      sp.updateMatrixWorld();
    };
    return sp;
  }

  private labelTexture(text: string): LabelTex {
    const cached = this.labels.get(text);
    if (cached) return cached;
    const dpr = 2;
    const font = `600 ${12 * dpr}px "Segoe UI", system-ui, sans-serif`;
    const c = document.createElement('canvas');
    let ctx = c.getContext('2d')!;
    ctx.font = font;
    const padX = 7 * dpr;
    const h = 20 * dpr;
    const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
    c.width = w;
    c.height = h;
    ctx = c.getContext('2d')!;
    const r = h / 2 - 1;
    ctx.beginPath();
    ctx.moveTo(r + 1, 1);
    ctx.arcTo(w - 1, 1, w - 1, h - 1, r);
    ctx.arcTo(w - 1, h - 1, 1, h - 1, r);
    ctx.arcTo(1, h - 1, 1, 1, r);
    ctx.arcTo(1, 1, w - 1, 1, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(18, 20, 26, 0.85)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff7ac8';
    ctx.stroke();
    ctx.font = font;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, padX, h / 2 + 1);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    const l = { tex, w: w / dpr, h: h / dpr };
    this.labels.set(text, l);
    return l;
  }

  // -------------------------------------------------------------------------
  // Kalem yardımcıları: taslak, imleç, eksen kılavuzu, düzlem ızgarası

  private buildOverlay(state: SketchViewState): void {
    disposeTree(this.overlay);
    const draft = state.draft;
    if (draft?.length) {
      const samples = samplePath({ id: '', name: '', closed: false, plane: state.plane ?? { axis: 'z', at: 0 }, points: draft });
      if (samples.length >= 2) this.overlay.add(this.line(samples, PATH_COLOR, false, 0.7));
      if (state.cursor) this.overlay.add(this.line([draft[draft.length - 1].p, state.cursor], PATH_COLOR, false, 0.45));
      this.overlay.add(this.dots(draft.map((pt) => pt.p), PATH_COLOR, 7));
      // İlk nokta büyük: ≥ 3 noktada ona tıklamak yolu kapatır.
      this.overlay.add(this.dots([draft[0].p], SELECTED_COLOR, 10, 22));
      const last = draft[draft.length - 1];
      const hs = [last.hIn, last.hOut].filter((h): h is Vec3 => !!h).map((h) => ({ x: last.p.x + h.x, y: last.p.y + h.y, z: last.p.z + h.z }));
      if (hs.length) {
        const g = new THREE.BufferGeometry().setFromPoints(hs.flatMap((e) => [v3(last.p), v3(e)]));
        const ls = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: HANDLE_COLOR, depthTest: false, transparent: true, opacity: 0.8 }));
        ls.renderOrder = 22;
        this.overlay.add(ls, this.dots(hs, HANDLE_COLOR, 6, 23));
      }
    }
    if (state.cursor) this.overlay.add(this.dots([state.cursor], CURSOR_COLOR, 5, 25));
    if (state.lock) {
      const e = new THREE.Vector3(state.lock.axis === 'x' ? 1 : 0, state.lock.axis === 'y' ? 1 : 0, state.lock.axis === 'z' ? 1 : 0);
      const L = Math.max(this.sceneBox.getSize(new THREE.Vector3()).length(), 100) * 2;
      const t = v3(state.lock.through);
      const g = new THREE.BufferGeometry().setFromPoints([t.clone().addScaledVector(e, -L), t.clone().addScaledVector(e, L)]);
      const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: AXIS_COLOR[state.lock.axis], depthTest: false, transparent: true, opacity: 0.85 }));
      l.renderOrder = 19;
      this.overlay.add(l);
    }
    this.syncGrid(state.plane);
  }

  /** Çizim düzlemi ızgarası: `at`'ta, hücre 10 mm (tabla > 2 m ise 100), boyut = max(tabla, parçalar) × 1,2. */
  private syncGrid(plane: SketchPlane | null): void {
    if (!plane || !this.project) return this.setGrid(null, '');
    const box = this.sceneBox;
    const size = box.getSize(new THREE.Vector3());
    const span = Math.max(size.x, size.y, size.z) * 1.2;
    const { bedX, bedY } = this.project.settings;
    let step = Math.max(bedX, bedY) > 2000 ? 100 : 10;
    while (span / step > 240) step *= 10;
    const [u, v] = plane.axis === 'z' ? (['x', 'y'] as const) : plane.axis === 'x' ? (['y', 'z'] as const) : (['x', 'z'] as const);
    const center = box.getCenter(new THREE.Vector3());
    const range = (a: GeomAxis): [number, number] => {
      // Dikey eksende ızgara tabladan (ya da en alttaki parçadan) yukarı uzanır; yatayda sahne merkezinde.
      const lo = a === 'z' ? Math.min(0, box.min.z) : center[a] - span / 2;
      return [Math.floor(lo / step) * step, Math.ceil((lo + span) / step) * step];
    };
    const [u0, u1] = range(u);
    const [v0, v1] = range(v);
    const key = `${plane.axis}|${plane.at}|${u0}|${u1}|${v0}|${v1}|${step}`;
    if (key === this.gridKey) return;
    const pts: number[] = [];
    const push = (a: number, b: number) => {
      const p = { x: 0, y: 0, z: 0 };
      p[plane.axis] = plane.at;
      p[u] = a;
      p[v] = b;
      pts.push(p.x, p.y, p.z);
    };
    for (let a = u0; a <= u1 + 1e-9; a += step) {
      push(a, v0);
      push(a, v1);
    }
    for (let b = v0; b <= v1 + 1e-9; b += step) {
      push(u0, b);
      push(u1, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.15, depthWrite: false }));
    grid.renderOrder = 1;
    this.setGrid(grid, key);
  }

  private setGrid(grid: THREE.LineSegments | null, key: string): void {
    if (this.grid) {
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
      this.root.remove(this.grid);
    }
    this.grid = grid;
    this.gridKey = key;
    if (grid) {
      grid.visible = !this.snapshotMode;
      this.root.add(grid);
    }
  }
}
