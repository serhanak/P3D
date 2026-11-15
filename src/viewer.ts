import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { SNAPSHOT_EYE_HEIGHT, SNAPSHOT_FOV_DEFAULT, type SnapshotCamera, type SnapshotOptions, type SnapshotView, type Vec3 } from '../shared/ops';
import { partBox, partsBox } from './engine';
import { isScanLike } from './geom';
import { displayOpacity, roleOf, solidGeometry, solidKey } from './model';
import { SHAPE_DEFS, bboxDims } from './shapes';
import { EMPTY_SKETCH_STATE, SketchView, sketchBox, type SketchViewState } from './sketch-view';
import type { Part, Project } from './types';

interface Entry {
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  edges: THREE.LineSegments;
  dims: THREE.Group;
  label: CSS2DObject;
  geomKey: string;
}

const HOLE_COLOR = 0xff4d4d;

export type ViewPreset = 'iso' | 'top' | 'front' | 'right';

const DEG = Math.PI / 180;
const DIM_COLOR = 0xffc94d;

export class Viewer {
  onSelect: (id: string | null) => void = () => {};
  /** Boolean (delik) uygulanamadığında; aynı mesaj tekrar tekrar bildirilmez. */
  onWarning: (msg: string) => void = () => {};
  private lastWarning = '';

  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private partsRoot = new THREE.Group();
  private labelsRoot = new THREE.Group();
  private bed = new THREE.Group();
  private bedKey = '';
  private bedSize = 220;
  private selBox: THREE.Box3Helper;
  private entries = new Map<string, Entry>();
  private raycaster = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;
  /** Eskiz katmanı (WebGL; snapshot'a girer). */
  readonly sketch = new SketchView();
  private sketchState: SketchViewState = EMPTY_SKETCH_STATE;
  /** Son `sync` edilen proje: eskiz durumu değişince yalnızca eskiz yeniden çizilir. */
  private lastProject: Project | null = null;
  /** Kalem aracı açıkken sol tık parça seçmez (eskize aittir). */
  penMode = false;

  constructor(private container: HTMLElement) {
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(220, -260, 200);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;

    this.scene.background = new THREE.Color(0x1b1e25);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4b, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(200, -300, 400);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-300, 200, 150);
    this.scene.add(key, fill, this.bed, this.partsRoot, this.labelsRoot, this.sketch.root);

    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0x7cc4ff);
    (this.selBox.material as THREE.LineBasicMaterial).depthTest = false;
    this.selBox.renderOrder = 5;
    this.selBox.visible = false;
    this.scene.add(this.selBox);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 0) this.down = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this.down) return;
      const moved = Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y);
      this.down = null;
      if (moved < 5 && !this.penMode) this.pick(e);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.fitClipPlanes();
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.fitClipPlanes();
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
    });
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private pick(e: PointerEvent): void {
    this.rayAt(e.clientX, e.clientY); // this.raycaster'ı kurar
    // Tamamen saydam (görünen saydamlığı 0) parça tıklamayı yutmasın: arkasındaki parça seçilebilsin.
    const meshes = [...this.entries.values()].filter((en) => en.group.visible && en.mesh.material.opacity > 0).map((en) => en.mesh);
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    this.onSelect(hit ? (hit.object.userData.partId as string) : null);
  }

  // -------------------------------------------------------------------------
  // Sahne senkronizasyonu

  sync(project: Project, selectedId: string | null): void {
    const seg = project.settings.resolution;
    this.syncBed(project.settings.bedX, project.settings.bedY);

    const seen = new Set<string>();
    const boxes = new Map(project.parts.map((p) => [p.id, partBox(p, seg)]));
    for (const part of project.parts) {
      seen.add(part.id);
      let e = this.entries.get(part.id);
      if (!e) {
        e = this.createEntry(part);
        this.entries.set(part.id, e);
      }
      const key = solidKey(project, part, boxes);
      if (e.geomKey !== key) this.rebuildGeometry(e, part, project, boxes, key);

      e.group.position.set(part.position.x, part.position.y, part.position.z);
      e.group.rotation.set(part.rotation.x * DEG, part.rotation.y * DEG, part.rotation.z * DEG, 'XYZ');
      const role = roleOf(part);
      e.group.visible = part.visible && (role !== 'hole' || project.view.showHoles);
      const mat = e.mesh.material;
      // Görünen saydamlık (displayOpacity): parçanın `opacity`'si rolün varsayılan yarı saydamlığının yerine geçer
      // (referans ağı daha belirgin ya da daha silik yapılabilir).
      const ghost = role !== 'solid';
      const opacity = displayOpacity(part);
      const see = opacity < 1;
      if (mat.transparent !== see) {
        mat.transparent = see;
        mat.depthWrite = !see;
        mat.needsUpdate = true;
      }
      mat.opacity = opacity;
      mat.color.set(role === 'hole' ? HOLE_COLOR : part.color);
      // İki yüzlü kaplama arkadan da çizilir (geom düzenlenince değişebilir).
      const side = part.geom?.kind === 'decal' && part.geom.double ? THREE.DoubleSide : THREE.FrontSide;
      if (mat.side !== side) {
        mat.side = side;
        mat.needsUpdate = true;
      }
      // Kenar çizgileri de soluklaşır (opak katıda 0,35).
      (e.edges.material as THREE.LineBasicMaterial).opacity = part.opacity !== undefined ? 0.35 * opacity : ghost ? 0.15 : 0.35;
      const selected = part.id === selectedId;
      mat.emissive.set(selected ? mat.color : 0x000000);
      mat.emissiveIntensity = selected ? 0.18 : 0;
      e.dims.visible = project.view.showDimensions;

      const box = boxes.get(part.id)!;
      // Ön-üst kenar: üst üste dizilen parçaların etiketleri birbirini örtmesin.
      e.label.position.set((box.min.x + box.max.x) / 2, box.min.y, box.max.z + 2);
      e.label.visible = e.group.visible;
      e.label.element.textContent = part.name;
      e.label.element.style.setProperty('--part-color', part.color);
      e.label.element.classList.toggle('selected', selected);
      if (selected) {
        this.selBox.box.copy(box);
        this.selBox.visible = part.visible;
      }
    }
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.disposeEntry(e);
        this.entries.delete(id);
      }
    }
    if (!selectedId || !project.parts.some((p) => p.id === selectedId)) this.selBox.visible = false;
    this.labelsRoot.visible = project.view.showNames;
    this.lastProject = project;
    this.sketch.sync(project, this.sketchState);
  }

  /** Eskiz görünüm durumu (kalem aracı); `redraw` false ise yalnızca saklanır (sonraki `sync` çizer). */
  setSketchState(state: SketchViewState, redraw = true): void {
    this.sketchState = state;
    if (redraw && this.lastProject) this.sketch.sync(this.lastProject, state);
  }

  // -------------------------------------------------------------------------
  // Kalem aracı için ekran ↔ dünya yardımcıları

  get domElement(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** İstemci (client) koordinatından dünya ışını. */
  rayAt(clientX: number, clientY: number): THREE.Ray {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.clone();
  }

  /**
   * Dünya noktasını istemci koordinatına çeviren fonksiyon (kamera arkasındaki nokta null). Tuval kutusu ve kamera bir kez
   * okunur; çok noktalı isabet testleri için.
   */
  screenProjector(): (v: Vec3) => { x: number; y: number } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    const view = this.camera.matrixWorldInverse.clone();
    const proj = this.camera.projectionMatrix.clone();
    const near = this.camera.near;
    const p = new THREE.Vector3();
    return (v) => {
      p.set(v.x, v.y, v.z).applyMatrix4(view);
      if (p.z > -near) return null;
      p.applyMatrix4(proj);
      return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
    };
  }

  toScreen(v: Vec3): { x: number; y: number } | null {
    return this.screenProjector()(v);
  }

  /** Kameranın bakış yönü (birim). */
  viewDir(): Vec3 {
    const d = this.controls.target.clone().sub(this.camera.position).normalize();
    return { x: d.x, y: d.y, z: d.z };
  }

  cameraPos(): Vec3 {
    const p = this.camera.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  target(): Vec3 {
    const t = this.controls.target;
    return { x: t.x, y: t.y, z: t.z };
  }

  /** `p` derinliğinde bir ekran pikselinin mm karşılığı (yakalama toleransı). */
  mmPerPixelAt(p: Vec3): number {
    const cam = this.camera.position;
    const dir = this.controls.target.clone().sub(cam).normalize();
    const d = Math.max(new THREE.Vector3(p.x - cam.x, p.y - cam.y, p.z - cam.z).dot(dir), this.camera.near);
    return (2 * d * Math.tan((this.camera.fov * DEG) / 2)) / Math.max(1, this.renderer.domElement.clientHeight);
  }

  /**
   * Sol tuşla kamera döndürme açık/kapalı. Kalem aracı sol tuşu kullanır; o sırada orta tuş döndürür (yakınlaştırma
   * tekerlekte kalır), sağ tuş kaydırır.
   */
  setLeftButton(enabled: boolean): void {
    // OrbitControls null eylemde hiçbir şey yapmaz (state NONE; Shift/Ctrl ile kaydırma da olmaz).
    this.controls.mouseButtons.LEFT = enabled ? THREE.MOUSE.ROTATE : null;
    this.controls.mouseButtons.MIDDLE = enabled ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
  }

  private createEntry(part: Part): Entry {
    const group = new THREE.Group();
    // Katılar kenar çizgilerinin arkasına itilir (+1); kaplama ise öne çekilir (−1): taşıyıcı yüzeyden lift kadar ayrık olsa da
    // uzaktan derinlik çözünürlüğü yetmez, titremesin. Parçanın şekli değişmez (update şekil değiştirmez).
    const decal = part.shape === 'decal';
    const material = new THREE.MeshStandardMaterial({
      color: part.color,
      roughness: 0.55,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: decal ? -1 : 1,
      polygonOffsetUnits: decal ? -2 : 1,
    });
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    mesh.userData.partId = part.id;
    const edges = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
    );
    const dims = new THREE.Group();
    group.add(mesh, edges, dims);
    this.partsRoot.add(group);

    const el = document.createElement('div');
    el.className = 'name-label';
    const label = new CSS2DObject(el);
    this.labelsRoot.add(label);
    return { group, mesh, edges, dims, label, geomKey: '' };
  }

  private rebuildGeometry(e: Entry, part: Part, project: Project, boxes: Map<string, THREE.Box3>, key: string): void {
    const solid = solidGeometry(project, part, boxes);
    if (solid.error && solid.error !== this.lastWarning) {
      this.lastWarning = solid.error;
      this.onWarning(`'${part.name}': ${solid.error}`);
    }
    e.mesh.geometry.dispose();
    e.mesh.geometry = solid.geometry;
    e.edges.geometry.dispose();
    // Kenar çizgileri yalnızca gerçek kırılımlarda; mesh parçalarında üçgen gürültüsü çizgi olmasın.
    e.edges.geometry = new THREE.EdgesGeometry(e.mesh.geometry, isScanLike(part.shape) ? 50 : 25);
    this.clearDims(e.dims);
    this.buildDims(e.dims, part, e.mesh.geometry);
    e.geomKey = key;
  }

  private buildDims(group: THREE.Group, part: Part, geometry: THREE.BufferGeometry): void {
    const def = SHAPE_DEFS[part.shape];
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const lines = def.dims ? def.dims(part.params) : bboxDims(geometry.boundingBox!);
    const size = Math.max(...lines.map((d) => Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1], d.b[2] - d.a[2])));
    const tick = Math.min(3, Math.max(0.8, size * 0.04));
    const pts: number[] = [];
    for (const d of lines) {
      const a = new THREE.Vector3(...d.a);
      const b = new THREE.Vector3(...d.b);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      const dir = b.clone().sub(a).normalize();
      const ref = Math.abs(dir.z) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
      const perp = new THREE.Vector3().crossVectors(dir, ref).normalize().multiplyScalar(tick);
      for (const p of [a, b]) pts.push(p.x - perp.x, p.y - perp.y, p.z - perp.z, p.x + perp.x, p.y + perp.y, p.z + perp.z);

      const el = document.createElement('div');
      el.className = 'dim-label';
      el.textContent = d.text;
      const obj = new CSS2DObject(el);
      obj.position.copy(a).add(b).multiplyScalar(0.5);
      group.add(obj);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const ls = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: DIM_COLOR, depthTest: false, transparent: true }));
    ls.renderOrder = 10;
    group.add(ls);
  }

  private clearDims(group: THREE.Group): void {
    for (const child of [...group.children]) {
      if (child instanceof CSS2DObject) child.element.remove();
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
      group.remove(child);
    }
  }

  private disposeEntry(e: Entry): void {
    this.clearDims(e.dims);
    e.mesh.geometry.dispose();
    e.mesh.material.dispose();
    e.edges.geometry.dispose();
    (e.edges.material as THREE.Material).dispose();
    this.partsRoot.remove(e.group);
    e.label.element.remove();
    this.labelsRoot.remove(e.label);
  }

  // -------------------------------------------------------------------------
  // Tabla

  /**
   * Kırpma düzlemleri kamera–hedef mesafesine göre. Sabit 0,5 mm yakın düzlem, oyun ölçeğinde (10 m) derinlik
   * çözünürlüğünü ~12 mm'ye düşürüyor ve ince bir panelin arkasındaki parçayı öne çiziyordu; d × 0,002 ile ~0,3 mm.
   */
  private fitClipPlanes(): void {
    const d = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.05, d * 0.002);
    const far = Math.max(d * 50, this.bedSize * 8, 2000);
    if (Math.abs(near - this.camera.near) > near * 0.05 || Math.abs(far - this.camera.far) > far * 0.05) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  private syncBed(x: number, y: number): void {
    const key = `${x}x${y}`;
    if (key === this.bedKey) return;
    this.bedKey = key;
    for (const child of [...this.bed.children]) {
      child.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Line) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      this.bed.remove(child);
    }
    const hx = x / 2;
    const hy = y / 2;
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(x, y),
      new THREE.MeshBasicMaterial({ color: 0x232833, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 }),
    );
    plate.position.z = -0.02;
    this.bed.add(plate);

    // Izgara aralığı tabla boyutuyla büyür (2 m'ye kadar 10/50 mm): eksen başına en fazla ~400 ince çizgi.
    let step = 10;
    while (Math.max(x, y) / step > 400) step *= 10;
    const majorStep = step * 5;
    const minor: number[] = [];
    const major: number[] = [];
    for (let gx = 0; gx <= hx; gx += step) {
      for (const sx of gx === 0 ? [0] : [gx, -gx]) (gx % majorStep === 0 ? major : minor).push(sx, -hy, 0, sx, hy, 0);
    }
    for (let gy = 0; gy <= hy; gy += step) {
      for (const sy of gy === 0 ? [0] : [gy, -gy]) (gy % majorStep === 0 ? major : minor).push(-hx, sy, 0, hx, sy, 0);
    }
    const lines = (pts: number[], color: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
    };
    this.bed.add(lines(minor, 0x2e3441), lines(major, 0x3f4759));
    this.bed.add(lines([-hx, -hy, 0, hx, -hy, 0, hx, -hy, 0, hx, hy, 0, hx, hy, 0, -hx, hy, 0, -hx, hy, 0, -hx, -hy, 0], 0x5b6680));

    // Büyük tablada (oyun ölçeği) eksen göstergesi büyür; kırpma düzlemleri fitClipPlanes()'te.
    this.bedSize = Math.max(x, y);
    const k = Math.max(1, Math.max(x, y) / 2000);

    // Eksen göstergesi (sol ön köşe)
    const origin = new THREE.Vector3(-hx - 6 * k, -hy - 6 * k, 0);
    const axes: [THREE.Vector3, number, string][] = [
      [new THREE.Vector3(1, 0, 0), 0xe5534b, 'X'],
      [new THREE.Vector3(0, 1, 0), 0x57ab5a, 'Y'],
      [new THREE.Vector3(0, 0, 1), 0x539bf5, 'Z'],
    ];
    for (const [dir, color, name] of axes) {
      this.bed.add(new THREE.ArrowHelper(dir, origin, 22 * k, color, 5 * k, 3 * k));
      const el = document.createElement('div');
      el.className = 'axis-label';
      el.textContent = name;
      el.style.color = '#' + color.toString(16).padStart(6, '0');
      const lbl = new CSS2DObject(el);
      lbl.position.copy(origin).addScaledVector(dir, 27 * k);
      this.bed.add(lbl);
    }
  }

  // -------------------------------------------------------------------------
  // Kamera

  fit(project: Project): void {
    // Delik parçaları kadraja girmez (tabla altı / ayna kesimi gibi yardımcı kutular çerçeveyi büyütmesin).
    // Parça yoksa eskiz kadraja alınır.
    const visible = project.parts.filter((p) => p.visible && roleOf(p) !== 'hole');
    const box = visible.length
      ? partsBox(visible, project.settings.resolution)
      : (sketchBox(project.sketch) ??
        new THREE.Box3(
          new THREE.Vector3(-project.settings.bedX / 2, -project.settings.bedY / 2, 0),
          new THREE.Vector3(project.settings.bedX / 2, project.settings.bedY / 2, 10),
        ));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 15);
    const dist = (radius / Math.sin((this.camera.fov * DEG) / 2)) * 1.15;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
  }

  setPreset(preset: ViewPreset, project: Project): void {
    const dirs: Record<ViewPreset, THREE.Vector3> = {
      iso: new THREE.Vector3(1, -1.2, 0.95),
      top: new THREE.Vector3(0, -0.001, 1),
      front: new THREE.Vector3(0, -1, 0.0001),
      right: new THREE.Vector3(1, 0, 0.0001),
    };
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.camera.position.copy(this.controls.target).addScaledVector(dirs[preset].normalize(), dist);
    this.fit(project);
  }

  // -------------------------------------------------------------------------
  // Görüntü alma (yapay zekâ doğrulama döngüsü için)

  /**
   * Görünür parçaların dik izdüşüm (ön/arka/sol/sağ/üst/alt) ve izometrik görüntüleri, PNG data URL.
   * Kullanıcının kamerası değişmez; yalnızca tuval boyutu bir anlığına değişir. CSS etiketleri (isimler,
   * ölçü yazıları) görüntüye girmez. Görünür eskiz (yollar, oklar, işaretler, WebGL adları) görüntüye girer ve kadraja
   * katılır; kalem yardımcıları (ızgara, kılavuz, taslak, seçim vurgusu, tutamaçlar) gizlenir.
   */
  snapshot(project: Project, opts: SnapshotOptions): { view: SnapshotView; png: string }[] {
    const visible = project.parts.filter((p) => p.visible && roleOf(p) !== 'hole');
    // Tek nokta / düz çizgi kutusu sıfır boyutlu olmasın (dik izdüşüm kadrajı).
    const sk = this.sketch.visibleBox()?.expandByScalar(1) ?? null;
    const box = visible.length
      ? partsBox(visible, project.settings.resolution)
      : (sk?.clone() ?? new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 10)));
    if (visible.length && sk) box.union(sk);
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevRatio = this.renderer.getPixelRatio();
    const prevSel = this.selBox.visible;
    const prevDims = [...this.entries.values()].map((e) => e.dims.visible);
    this.selBox.visible = false;
    if (!opts.dims) for (const e of this.entries.values()) e.dims.visible = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(opts.width, opts.height, false);
    const out: { view: SnapshotView; png: string }[] = [];
    this.sketch.setSnapshotMode(true);
    try {
      for (const view of opts.views) {
        this.renderer.render(this.scene, this.snapshotCamera(view, box, opts.width / opts.height, opts.camera));
        out.push({ view, png: this.renderer.domElement.toDataURL('image/png') });
      }
    } finally {
      this.renderer.setPixelRatio(prevRatio);
      this.renderer.setSize(prevSize.x, prevSize.y, false);
      this.selBox.visible = prevSel;
      [...this.entries.values()].forEach((e, i) => (e.dims.visible = prevDims[i]));
      this.sketch.setSnapshotMode(false);
    }
    return out;
  }

  /**
   * Perspektif görüntü kamerası. `camera`: verilen göz konumundan hedefe (yoksa kutu merkezine). `eye`: göz hizası —
   * görünür kutunun tabanından `eyeHeight` (varsayılan 1 m) yukarıda, izometrikle aynı yandan (ön sağ), kutunun tamamı
   * görüş açısına sığacak uzaklıkta; hedef kutu merkezi. Yakın/uzak düzlem uzaklıkla orantılı (derinlik çözünürlüğü).
   */
  private perspectiveCamera(view: 'eye' | 'camera', box: THREE.Box3, aspect: number, opt: SnapshotCamera): THREE.PerspectiveCamera {
    const v3 = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);
    const fov = opt.fov ?? SNAPSHOT_FOV_DEFAULT;
    const target = opt.target ? v3(opt.target) : box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 5);
    let eye: THREE.Vector3;
    if (view === 'camera' && opt.eye) eye = v3(opt.eye);
    else {
      // Kutunun tamamı dar görüş açısına sığsın (yatay açı en-boy oranından).
      const vHalf = (fov / 2) * DEG;
      const half = Math.min(vHalf, Math.atan(Math.tan(vHalf) * aspect));
      const dist = (radius / Math.sin(half)) * 1.05;
      // Varsayılan göz yüksekliği küçük sahnede sahne boyuyla sınırlanır (20 mm'lik parçaya 1 m'den tepeden bakılmasın).
      const z = box.min.z + (opt.eyeHeight ?? Math.min(SNAPSHOT_EYE_HEIGHT, 2 * radius));
      const flat = Math.sqrt(Math.max(dist * dist - (z - target.z) ** 2, (dist * 0.3) ** 2));
      const dir = new THREE.Vector3(1, -1.2, 0).normalize();
      eye = new THREE.Vector3(target.x + dir.x * flat, target.y + dir.y * flat, z);
    }
    const dist = Math.max(eye.distanceTo(target), 1e-3);
    const far = dist + radius * 4 + this.bedSize * 1.5;
    // Yakın düzlem: göz sahnenin dışındaysa en yakın kutu noktasına göre, içindeyse (kart gözü, pist içi) sahne ölçeğinin
    // küçük bir payı; göz–hedef uzaklığından türetmek, 150 m'lik pistte gözün önündeki nesneleri kesiyordu.
    const toBox = box.isEmpty() ? dist : box.distanceToPoint(eye);
    const near = Math.max(0.1, radius * 1e-4, Math.min(toBox * 0.5, dist * 0.005));
    const cam = new THREE.PerspectiveCamera(fov, aspect, near, far);
    // Dik bakışta Z yukarı tanımsız: Y yukarı.
    const look = target.clone().sub(eye).normalize();
    cam.up.set(0, 0, 1);
    if (Math.abs(look.z) > 0.999) cam.up.set(0, 1, 0);
    cam.position.copy(eye);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    return cam;
  }

  private snapshotCamera(view: SnapshotView, box: THREE.Box3, aspect: number, opt: SnapshotCamera = {}): THREE.Camera {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    if (view === 'eye' || view === 'camera') return this.perspectiveCamera(view, box, aspect, opt);
    // [merkezden kameraya yön, kameranın yukarısı]
    const dirs: Record<Exclude<SnapshotView, 'eye' | 'camera'>, [THREE.Vector3, THREE.Vector3]> = {
      iso: [V(1, -1.2, 0.95), V(0, 0, 1)],
      front: [V(0, -1, 0), V(0, 0, 1)],
      back: [V(0, 1, 0), V(0, 0, 1)],
      left: [V(-1, 0, 0), V(0, 0, 1)],
      right: [V(1, 0, 0), V(0, 0, 1)],
      top: [V(0, 0, 1), V(0, 1, 0)],
      bottom: [V(0, 0, -1), V(0, 1, 0)],
    };
    const [dir, up] = dirs[view];
    dir.normalize();
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 5);
    if (view === 'iso') {
      // Yakın düzlem mesafeyle orantılı: sabit 0,1 mm, 4 m'lik araçta derinlik çözünürlüğünü ~50 mm'ye düşürüyordu.
      const dist = (radius / Math.sin(15 * DEG)) * 1.05;
      const cam = new THREE.PerspectiveCamera(30, aspect, Math.max(0.1, dist * 0.05), dist * 2 + this.bedSize * 1.5);
      cam.up.copy(up);
      cam.position.copy(center).addScaledVector(dir, dist);
      cam.lookAt(center);
      cam.updateMatrixWorld();
      return cam;
    }
    // Dik izdüşüm: kutunun köşelerini kamera düzlemine izdüşürüp çerçevele (%6 pay).
    const cam = new THREE.OrthographicCamera();
    cam.up.copy(up);
    cam.position.copy(center).addScaledVector(dir, radius * 4);
    cam.lookAt(center);
    cam.updateMatrixWorld();
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const cx of [box.min.x, box.max.x])
      for (const cy of [box.min.y, box.max.y])
        for (const cz of [box.min.z, box.max.z]) {
          const p = V(cx, cy, cz).applyMatrix4(cam.matrixWorldInverse);
          [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
        }
    let w = (x1 - x0) * 1.06;
    let h = (y1 - y0) * 1.06;
    if (w / h > aspect) h = w / aspect;
    else w = h * aspect;
    const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
    Object.assign(cam, { left: mx - w / 2, right: mx + w / 2, top: my + h / 2, bottom: my - h / 2, near: 0.1, far: radius * 10 });
    cam.updateProjectionMatrix();
    return cam;
  }
}
