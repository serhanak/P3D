import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { SnapshotOptions, SnapshotView } from '../shared/ops';
import { partBox, partsBox } from './engine';
import { isScanLike } from './geom';
import { roleOf, solidGeometry, solidKey } from './model';
import { SHAPE_DEFS, bboxDims } from './shapes';
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
  private selBox: THREE.Box3Helper;
  private entries = new Map<string, Entry>();
  private raycaster = new THREE.Raycaster();
  private down: { x: number; y: number } | null = null;

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
    this.scene.add(key, fill, this.bed, this.partsRoot, this.labelsRoot);

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
      if (moved < 5) this.pick(e);
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
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
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.entries.values()].filter((en) => en.group.visible).map((en) => en.mesh);
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
      const ghost = role !== 'solid';
      if (mat.transparent !== ghost) {
        mat.transparent = ghost;
        mat.depthWrite = !ghost;
        mat.needsUpdate = true;
      }
      mat.opacity = role === 'hole' ? 0.3 : role === 'reference' ? 0.35 : 1;
      mat.color.set(role === 'hole' ? HOLE_COLOR : part.color);
      (e.edges.material as THREE.LineBasicMaterial).opacity = ghost ? 0.15 : 0.35;
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
  }

  private createEntry(part: Part): Entry {
    const group = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color: part.color,
      roughness: 0.55,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
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

    const minor: number[] = [];
    const major: number[] = [];
    for (let gx = 0; gx <= hx; gx += 10) {
      for (const sx of gx === 0 ? [0] : [gx, -gx]) (gx % 50 === 0 ? major : minor).push(sx, -hy, 0, sx, hy, 0);
    }
    for (let gy = 0; gy <= hy; gy += 10) {
      for (const sy of gy === 0 ? [0] : [gy, -gy]) (gy % 50 === 0 ? major : minor).push(-hx, sy, 0, hx, sy, 0);
    }
    const lines = (pts: number[], color: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
    };
    this.bed.add(lines(minor, 0x2e3441), lines(major, 0x3f4759));
    this.bed.add(lines([-hx, -hy, 0, hx, -hy, 0, hx, -hy, 0, hx, hy, 0, hx, hy, 0, -hx, hy, 0, -hx, hy, 0, -hx, -hy, 0], 0x5b6680));

    // Eksen göstergesi (sol ön köşe)
    const origin = new THREE.Vector3(-hx - 6, -hy - 6, 0);
    const axes: [THREE.Vector3, number, string][] = [
      [new THREE.Vector3(1, 0, 0), 0xe5534b, 'X'],
      [new THREE.Vector3(0, 1, 0), 0x57ab5a, 'Y'],
      [new THREE.Vector3(0, 0, 1), 0x539bf5, 'Z'],
    ];
    for (const [dir, color, name] of axes) {
      this.bed.add(new THREE.ArrowHelper(dir, origin, 22, color, 5, 3));
      const el = document.createElement('div');
      el.className = 'axis-label';
      el.textContent = name;
      el.style.color = '#' + color.toString(16).padStart(6, '0');
      const lbl = new CSS2DObject(el);
      lbl.position.copy(origin).addScaledVector(dir, 27);
      this.bed.add(lbl);
    }
  }

  // -------------------------------------------------------------------------
  // Kamera

  fit(project: Project): void {
    // Delik parçaları kadraja girmez (tabla altı / ayna kesimi gibi yardımcı kutular çerçeveyi büyütmesin).
    const visible = project.parts.filter((p) => p.visible && roleOf(p) !== 'hole');
    const box = visible.length
      ? partsBox(visible, project.settings.resolution)
      : new THREE.Box3(
          new THREE.Vector3(-project.settings.bedX / 2, -project.settings.bedY / 2, 0),
          new THREE.Vector3(project.settings.bedX / 2, project.settings.bedY / 2, 10),
        );
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
   * ölçü yazıları) görüntüye girmez.
   */
  snapshot(project: Project, opts: SnapshotOptions): { view: SnapshotView; png: string }[] {
    const visible = project.parts.filter((p) => p.visible && roleOf(p) !== 'hole');
    const box = visible.length
      ? partsBox(visible, project.settings.resolution)
      : new THREE.Box3(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 10));
    const prevSize = this.renderer.getSize(new THREE.Vector2());
    const prevRatio = this.renderer.getPixelRatio();
    const prevSel = this.selBox.visible;
    const prevDims = [...this.entries.values()].map((e) => e.dims.visible);
    this.selBox.visible = false;
    if (!opts.dims) for (const e of this.entries.values()) e.dims.visible = false;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(opts.width, opts.height, false);
    const out: { view: SnapshotView; png: string }[] = [];
    try {
      for (const view of opts.views) {
        this.renderer.render(this.scene, this.snapshotCamera(view, box, opts.width / opts.height));
        out.push({ view, png: this.renderer.domElement.toDataURL('image/png') });
      }
    } finally {
      this.renderer.setPixelRatio(prevRatio);
      this.renderer.setSize(prevSize.x, prevSize.y, false);
      this.selBox.visible = prevSel;
      [...this.entries.values()].forEach((e, i) => (e.dims.visible = prevDims[i]));
    }
    return out;
  }

  private snapshotCamera(view: SnapshotView, box: THREE.Box3, aspect: number): THREE.Camera {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    // [merkezden kameraya yön, kameranın yukarısı]
    const dirs: Record<SnapshotView, [THREE.Vector3, THREE.Vector3]> = {
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
      const cam = new THREE.PerspectiveCamera(30, aspect, 0.1, radius * 100);
      cam.up.copy(up);
      cam.position.copy(center).addScaledVector(dir, (radius / Math.sin(15 * DEG)) * 1.05);
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
