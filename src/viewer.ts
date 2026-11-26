import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import {
  SNAPSHOT_EYE_HEIGHT,
  SNAPSHOT_FOV_DEFAULT,
  type Role,
  type SnapshotCamera,
  type SnapshotOptions,
  type SnapshotProjection,
  type SnapshotView,
  type Vec3,
  type ViewStyle,
} from '../shared/ops';
import { orthoDepth, orthoFrameCamera, perspDistanceFor, toOrthoHeight, toPerspDistance, viewLimits, type OrthoDepth } from './camera-math';
import { partBox, partsBox } from './engine';
import { isScanLike } from './geom';
import { displayOpacity, roleOf, solidGeometry, solidKey } from './model';
import { SHAPE_DEFS, bboxDims } from './shapes';
import { EMPTY_SKETCH_STATE, SketchView, sketchBox, type SketchViewState } from './sketch-view';
import type { Part, Project } from './types';

/** Parçanın görünüşü (son `sync`'ten): görünüm biçimi değişince malzemeler projeye dokunmadan yeniden ayarlanır. */
interface Look {
  role: Role;
  color: string;
  /** Görünen saydamlık (`displayOpacity`). */
  opacity: number;
  /** Parçada `opacity` alanı var (kenar çizgisi kuralı). */
  explicit: boolean;
  /** İki yüzlü kaplama. */
  double: boolean;
  selected: boolean;
}

interface Entry {
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  edges: THREE.LineSegments;
  dims: THREE.Group;
  label: CSS2DObject;
  geomKey: string;
  /** Kaplama (decal): dolgusu öne çekilir; tel kafeste çizim sırası farklıdır (applyLook). Parçanın şekli değişmez. */
  decal: boolean;
  /**
   * Tel kafes (her üçgen kenarı): tembel — yalnızca tel kafes / X-ışını biçiminde üretilir; `wireKey` üretildiği geometrinin
   * anahtarı (`geomKey`). Geometri değişince ve girdi silinince atılır.
   */
  wire: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> | null;
  wireKey: string;
  look: Look;
}

const HOLE_COLOR = 0xff4d4d;
/** Tel kafeste (gizli çizgi) üçgen kenarlarının rengi ve opak katıdaki opaklığı. */
const WIRE_COLOR = 0x05070a;
const WIRE_OPACITY = 0.6;
/** X-ışınında dolgu görünen saydamlığın bu oranıyla çizilir (çok soluk; tıklama yine dolguya isabet eder). */
const XRAY_FILL = 0.07;
/** X-ışınında çizgi opaklığı (seçili parçada 1). */
const XRAY_OPACITY = 0.8;
/** Tel kafes / X-ışını açılırken görünür üçgen sayısı bunu aşarsa bir kez "yavaş olabilir" uyarısı (engellemez). */
const WIRE_WARN_TRIS = 500_000;

/** X-ışını çizgi rengi: parça rengi, koyu tabla/arka planda okunsun diye açıklığı en az 0,6 (seçiliyse 0,78). */
function xrayColor(color: string | number, selected: boolean): THREE.Color {
  const c = new THREE.Color(color);
  const hsl = c.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
  return c.setHSL(hsl.h, hsl.s, Math.max(hsl.l, selected ? 0.78 : 0.6), THREE.SRGBColorSpace);
}

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
  /**
   * Etkin kamera: perspektif ya da ortografik (yalnızca bellekte; projeye girmez). `this.camera` kullanan her kod iki tipi de
   * desteklemeli (ışın, ekran izdüşümü, piksel ölçeği, sığdırma, kırpma düzlemleri).
   */
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private persp: THREE.PerspectiveCamera;
  private ortho: THREE.OrthographicCamera;
  /** Tabla + görünür parçalar + eskiz kutusu: ortoda kamera bunun tamamı yakın düzlemin önünde kalacak kadar geride durur. */
  private sceneBox = new THREE.Box3(new THREE.Vector3(-110, -110, 0), new THREE.Vector3(110, 110, 0));
  /** Kalem aracının yardımcıları (taslak, imleç, kilit kılavuzu, düzlem ızgarası): ortoda derinlik hesabına katılır. */
  private sketchHelperBox: THREE.Box3 | null = null;
  // Ortoda her karede kullanılan geçici nesneler (yeniden kullanılır).
  private readonly depthBox = new THREE.Box3();
  private readonly depthSphere = new THREE.Sphere();
  private readonly depthDir = new THREE.Vector3();
  private readonly depthOut: OrthoDepth = { position: new THREE.Vector3(), near: 1, far: 2 };
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
  /** Görünüm biçimi: yalnızca bellekte (projeye ve otomatik kayda girmez; eskiz görünürlüğü gibi). */
  private viewStyle: ViewStyle = 'shaded';
  /** Büyük sahne uyarısı verildi mi (oturum başına bir kez). */
  private wireWarned = false;

  constructor(private container: HTMLElement) {
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    container.appendChild(this.labelRenderer.domElement);

    this.persp = new THREE.PerspectiveCamera(40, 1, 0.5, 20000);
    this.persp.up.set(0, 0, 1);
    this.persp.position.set(220, -260, 200);
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.ortho.up.set(0, 0, 1);
    this.camera = this.persp;

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
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    // Orto: yükseklik (ve zoom) korunur, genişlik en-boy oranından.
    this.setOrthoFrustum(this.ortho.top - this.ortho.bottom);
  }

  /** Orto frustum'u: zoom 1'deki görünür yükseklik `h` (mm), genişlik en-boy oranından. */
  private setOrthoFrustum(h: number): void {
    const w = h * this.persp.aspect;
    Object.assign(this.ortho, { top: h / 2, bottom: -h / 2, left: -w / 2, right: w / 2 });
    this.ortho.updateProjectionMatrix();
  }

  /** Tabla + görünür parçalar + eskiz küresinin yarıçapı (yakınlaştırma sınırlarının ölçeği). */
  private sceneRadius(): number {
    return this.sceneBox.getBoundingSphere(this.depthSphere).radius;
  }

  /**
   * Yakınlaştırma sınırları (sahne ölçeğinden): perspektifte OrbitControls uzaklığı, ortoda zoom. Ortoda uzaklık sınırı yoktur
   * (kamera derinliği fitOrthoDepth'te; OrbitControls uzaklığı kırpmasın).
   */
  private applyLimits(): void {
    const lim = viewLimits(this.sceneRadius());
    const c = this.controls;
    if (this.camera === this.ortho) {
      const h0 = this.ortho.top - this.ortho.bottom;
      c.minZoom = h0 / lim.maxHeight;
      c.maxZoom = h0 / lim.minHeight;
      c.minDistance = 0;
      c.maxDistance = Infinity;
    } else {
      c.minDistance = perspDistanceFor(lim.minHeight, this.persp.fov);
      c.maxDistance = perspDistanceFor(lim.maxHeight, this.persp.fov);
      c.minZoom = 0;
      c.maxZoom = Infinity;
    }
  }

  /** Kamera tipi (yalnızca bellekte). */
  get projection(): 'perspective' | 'ortho' {
    return this.camera === this.ortho ? 'ortho' : 'perspective';
  }

  /**
   * Perspektif ↔ ortografik. Hedef ve bakış yönü korunur; hedefteki görünür ölçek de: orto yüksekliği = 2 · d · tan(fov/2)
   * (d = kamera–hedef uzaklığı), geri dönüşte uzaklık orto yüksekliğinden (zoom dahil) hesaplanır. İkisi de sahne ölçeğinden
   * sınırlara kırpılır (camera-math.ts → viewLimits): aşırı yakınlaştırma/uzaklaştırma sonrası geçişte sahne kaybolmasın.
   */
  setProjection(projection: 'perspective' | 'ortho'): void {
    if (projection === this.projection) return;
    const target = this.controls.target;
    const fov = this.persp.fov;
    const lim = viewLimits(this.sceneRadius());
    if (projection === 'ortho') {
      this.ortho.zoom = 1;
      this.setOrthoFrustum(toOrthoHeight(this.persp.position.distanceTo(target), fov, lim));
      this.ortho.position.copy(this.persp.position);
      this.ortho.quaternion.copy(this.persp.quaternion);
      this.camera = this.ortho;
    } else {
      const d = toPerspDistance((this.ortho.top - this.ortho.bottom) / this.ortho.zoom, fov, lim);
      const dir = this.ortho.position.clone().sub(target).normalize();
      this.persp.position.copy(target).addScaledVector(dir, d);
      this.persp.quaternion.copy(this.ortho.quaternion);
      this.camera = this.persp;
    }
    this.controls.object = this.camera;
    this.applyLimits();
    this.fitClipPlanes();
    this.controls.update();
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
      const selected = part.id === selectedId;
      // Görünen saydamlık (displayOpacity): parçanın `opacity`'si rolün varsayılan yarı saydamlığının yerine geçer
      // (referans ağı daha belirgin ya da daha silik yapılabilir). İki yüzlü kaplama arkadan da çizilir.
      e.look = {
        role,
        color: part.color,
        opacity: displayOpacity(part),
        explicit: part.opacity !== undefined,
        double: part.geom?.kind === 'decal' && part.geom.double === true,
        selected,
      };
      this.applyLook(e, this.viewStyle);
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
    // Ortoda kameranın ne kadar geride duracağı: tabla + görünür parçalar + eskiz.
    const { bedX, bedY } = project.settings;
    const sceneBox = new THREE.Box3(new THREE.Vector3(-bedX / 2, -bedY / 2, 0), new THREE.Vector3(bedX / 2, bedY / 2, 0));
    for (const part of project.parts) if (this.entries.get(part.id)?.group.visible) sceneBox.union(boxes.get(part.id)!);
    const sk = sketchBox(project.sketch);
    if (sk) sceneBox.union(sk);
    this.sceneBox.copy(sceneBox);
    this.applyLimits();
    this.labelsRoot.visible = project.view.showNames;
    this.lastProject = project;
    this.sketch.sync(project, this.sketchState);
    this.sketchHelperBox = this.sketch.helperBox();
  }

  /** Görünüm biçimi (gölgeli / tel kafes / X-ışını). */
  get style(): ViewStyle {
    return this.viewStyle;
  }

  /**
   * Görünüm biçimini değiştirir; projeye dokunmaz (geri-al geçmişine ve otomatik kayda girmez). Gölgeliye dönüşte tel
   * geometriler atılır. Büyük sahnede (görünür üçgen ≥ WIRE_WARN_TRIS) tel kafes / X-ışını açılırken bir kez uyarır.
   */
  setStyle(style: ViewStyle): void {
    if (style === this.viewStyle) return;
    this.viewStyle = style;
    if (style !== 'shaded' && !this.wireWarned) {
      const tris = this.visibleTriangles();
      if (tris >= WIRE_WARN_TRIS) {
        this.wireWarned = true;
        this.onWarning(`Sahnede ${tris.toLocaleString('tr-TR')} görünür üçgen var: tel kafes / X-ışını çizimi yavaş olabilir (Gölgeli'ye dönmek için W).`);
      }
    }
    for (const e of this.entries.values()) this.applyLook(e, style);
  }

  /** Görünür parçaların üçgen sayısı (ekrandaki geometri). */
  private visibleTriangles(): number {
    let n = 0;
    for (const e of this.entries.values()) {
      if (!e.group.visible) continue;
      const g = e.mesh.geometry;
      n += (g.index ? g.index.count : (g.getAttribute('position')?.count ?? 0)) / 3;
    }
    return Math.round(n);
  }

  /**
   * Girdinin malzemelerini görünüşüne (`look`) ve biçime göre ayarlar. Gölgeli: dolgu + kırılım çizgileri. Tel kafes: dolgu
   * ve ışık aynı, kırılım çizgileri yerine her üçgen kenarı koyu çizgiyle (katı dolgusu polygonOffset +1 ile arkaya itildiğinden
   * arkadaki kenarlar derinlikle gizlenir). X-ışını: dolgu çok soluk ve derinlik yazmaz, tüm kenarlar (arkadakiler dahil)
   * parça renginde, derinlik testi olmadan. Çizgi opaklığı kenar çizgisi kuralıyla soluklaşır (referans, delik, saydam parça).
   * Gölgelide tel geometri atılır; `keepWire` (snapshot'ın geçici gölgelisi: arayüz tel kafeste kalacak) atmaz, yalnızca gizler.
   */
  private applyLook(e: Entry, style: ViewStyle, keepWire = false): void {
    const L = e.look;
    const mat = e.mesh.material;
    const xray = style === 'xray';
    const fill = xray ? L.opacity * XRAY_FILL : L.opacity;
    // Tel kafeste kaplama dolgusu derinlik yazmaz ve saydam sırada (uzaktan yakına) katılardan ve diğer çizgilerden sonra
    // çizilir, kendi tel çizgileri de ondan sonra: dolgu polygonOffset −2 birimle öne çekilir, polygonOffset çizgilere
    // uygulanmaz; derinlik yazsaydı kendi çizgilerini örterdi. Taşıyıcının çizgilerini yine örter, üst üste kaplamalar sıralı kalır.
    const decalWire = e.decal && style === 'wire';
    const see = fill < 1 || decalWire;
    if (mat.transparent !== see) {
      mat.transparent = see;
      mat.needsUpdate = true;
    }
    mat.depthWrite = !see;
    mat.opacity = fill;
    e.mesh.renderOrder = decalWire ? 1 : 0;
    mat.color.set(L.role === 'hole' ? HOLE_COLOR : L.color);
    const side = L.double ? THREE.DoubleSide : THREE.FrontSide;
    if (mat.side !== side) {
      mat.side = side;
      mat.needsUpdate = true;
    }
    mat.emissive.set(L.selected ? mat.color : 0x000000);
    mat.emissiveIntensity = L.selected ? 0.18 : 0;
    const ghost = L.role !== 'solid';
    // Kenar çizgileri de soluklaşır (opak katıda 0,35).
    (e.edges.material as THREE.LineBasicMaterial).opacity = L.explicit ? 0.35 * L.opacity : ghost ? 0.15 : 0.35;
    e.edges.visible = style === 'shaded';
    if (style === 'shaded' && !keepWire) {
      this.dropWire(e);
      return;
    }
    // Gizli parçanın tel kafesi üretilmez (görünür olunca sync yeniden çağırır).
    if (style === 'shaded' || !e.group.visible) {
      if (e.wire) e.wire.visible = false;
      return;
    }
    const wire = this.ensureWire(e);
    wire.visible = true;
    const wm = wire.material;
    const fade = L.explicit ? L.opacity : ghost ? 0.45 : 1;
    if (xray) {
      wm.color.copy(xrayColor(L.role === 'hole' ? HOLE_COLOR : L.color, L.selected));
      wm.opacity = L.selected ? 1 : XRAY_OPACITY * fade;
      wm.depthTest = false;
      wire.renderOrder = 3;
    } else {
      wm.color.set(WIRE_COLOR);
      wm.opacity = WIRE_OPACITY * fade;
      wm.depthTest = true;
      wire.renderOrder = e.decal ? 2 : 0;
    }
  }

  /** Tel kafes nesnesi (ilk istekte kurulur) ve güncel geometrisi (`WireframeGeometry`, `geomKey` ile önbellekli). */
  private ensureWire(e: Entry): THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> {
    if (!e.wire) {
      // Çizgiler derinlik yazmaz: birbirini ve saydam dolguları kesmez (opak dolgular onları yine gizler).
      const material = new THREE.LineBasicMaterial({ color: WIRE_COLOR, transparent: true, opacity: WIRE_OPACITY, depthWrite: false });
      e.wire = new THREE.LineSegments(new THREE.BufferGeometry(), material);
      e.group.add(e.wire);
    }
    if (e.wireKey !== e.geomKey) {
      e.wire.geometry.dispose();
      e.wire.geometry = new THREE.WireframeGeometry(e.mesh.geometry);
      e.wireKey = e.geomKey;
    }
    return e.wire;
  }

  /** Tel kafesi (geometri + malzeme) atar; yeniden gerekirse ensureWire kurar. */
  private dropWire(e: Entry): void {
    if (!e.wire) return;
    e.wire.geometry.dispose();
    e.wire.material.dispose();
    e.group.remove(e.wire);
    e.wire = null;
    e.wireKey = '';
  }

  /** Eskiz görünüm durumu (kalem aracı); `redraw` false ise yalnızca saklanır (sonraki `sync` çizer). */
  setSketchState(state: SketchViewState, redraw = true): void {
    this.sketchState = state;
    if (redraw && this.lastProject) {
      this.sketch.sync(this.lastProject, state);
      this.sketchHelperBox = this.sketch.helperBox();
    }
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

  /** `p` derinliğinde bir ekran pikselinin mm karşılığı (yakalama toleransı; ortoda derinlikten bağımsız). */
  mmPerPixelAt(p: Vec3): number {
    const H = Math.max(1, this.renderer.domElement.clientHeight);
    if (this.camera instanceof THREE.OrthographicCamera) return (this.camera.top - this.camera.bottom) / this.camera.zoom / H;
    const cam = this.camera.position;
    const dir = this.controls.target.clone().sub(cam).normalize();
    const d = Math.max(new THREE.Vector3(p.x - cam.x, p.y - cam.y, p.z - cam.z).dot(dir), this.camera.near);
    return (2 * d * Math.tan((this.camera.fov * DEG) / 2)) / H;
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
    // Katılar kenar çizgilerinin arkasına itilir (eğimle +1, +1 birim); kaplama yalnızca sabit birimle öne çekilir (−2): taşıyıcı
    // yüzeyden lift kadar ayrık olsa da uzaktan derinlik çözünürlüğü yetmez, titremesin — taşıyıcı kendi eğimi kadar geride kalır.
    // Kaplamaya eğim katsayısı verilmez: neredeyse yandan görülen kaplamada eğim × piksel onlarca mm eder ve opak katının içindeki
    // kaplama önündeki yüzün üstüne çizgi olarak çıkıyordu (BoltRush #29). Parçanın şekli değişmez (update şekil değiştirmez).
    const decal = part.shape === 'decal';
    const material = new THREE.MeshStandardMaterial({
      color: part.color,
      roughness: 0.55,
      metalness: 0.05,
      polygonOffset: true,
      polygonOffsetFactor: decal ? 0 : 1,
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
    const look: Look = { role: 'solid', color: part.color, opacity: 1, explicit: false, double: false, selected: false };
    return { group, mesh, edges, dims, label, geomKey: '', decal, wire: null, wireKey: '', look };
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
    // Tel kafes eskidi: hemen atılır, gerekirse (tel kafes / X-ışını) applyLook yeniden üretir.
    if (e.wire) {
      e.wire.geometry.dispose();
      e.wire.geometry = new THREE.BufferGeometry();
      e.wireKey = '';
    }
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
    this.dropWire(e);
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
    if (this.camera === this.ortho) return this.fitOrthoDepth();
    const d = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.05, d * 0.002);
    const far = Math.max(d * 50, this.bedSize * 8, 2000);
    if (Math.abs(near - this.camera.near) > near * 0.05 || Math.abs(far - this.camera.far) > far * 0.05) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Ortoda kamera her karede ideal uzaklığa konur (aynı bakış yönü): sahne (tabla + parçalar + eskiz + kalem yardımcıları)
   * küresinin tamamı yakın düzlemin önünde kalır, hedef uzağa kaydırılıp dönülse de (camera-math.ts → orthoDepth).
   */
  private fitOrthoDepth(): void {
    const cam = this.ortho;
    const target = this.controls.target;
    const box = this.depthBox.copy(this.sceneBox);
    if (this.sketchHelperBox) box.union(this.sketchHelperBox);
    const dir = this.depthDir.copy(cam.position).sub(target);
    if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
    dir.normalize();
    const d = orthoDepth(box.getBoundingSphere(this.depthSphere), target, dir, this.depthOut);
    cam.position.copy(d.position);
    if (Math.abs(d.near - cam.near) > d.near * 0.05 || Math.abs(d.far - cam.far) > d.far * 0.05) {
      cam.near = d.near;
      cam.far = d.far;
      cam.updateProjectionMatrix();
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
    const fov = this.persp.fov * DEG;
    const dist = (radius / Math.sin(fov / 2)) * 1.15;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    if (this.camera === this.ortho) {
      // Perspektif sığdırmanın hedefteki görünür yüksekliği: 2 · dist · tan(fov/2).
      this.ortho.zoom = 1;
      this.setOrthoFrustum(2 * dist * Math.tan(fov / 2));
      this.applyLimits();
      this.fitOrthoDepth();
    }
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
    // Biçim arayüzdekinden bağımsızdır (verilmezse gölgeli); görüntüden sonra arayüzünki her yolda (finally) geri gelir.
    const style = opts.style ?? 'shaded';
    const restyle = style !== this.viewStyle;
    const out: { view: SnapshotView; png: string }[] = [];
    try {
      // Geçici gölgelide tel geometri atılmaz (arayüz biçimi geri gelince yeniden üretilmesin).
      if (restyle) for (const e of this.entries.values()) this.applyLook(e, style, true);
      this.selBox.visible = false;
      if (!opts.dims) for (const e of this.entries.values()) e.dims.visible = false;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(opts.width, opts.height, false);
      this.sketch.setSnapshotMode(true);
      for (const view of opts.views) {
        this.renderer.render(this.scene, this.snapshotCamera(view, box, opts.width / opts.height, opts.camera, opts.projection));
        out.push({ view, png: this.renderer.domElement.toDataURL('image/png') });
      }
    } finally {
      this.renderer.setPixelRatio(prevRatio);
      this.renderer.setSize(prevSize.x, prevSize.y, false);
      this.selBox.visible = prevSel;
      [...this.entries.values()].forEach((e, i) => (e.dims.visible = prevDims[i]));
      this.sketch.setSnapshotMode(false);
      if (restyle) for (const e of this.entries.values()) this.applyLook(e, this.viewStyle);
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

  /**
   * Görüntü kamerası. `projection: 'ortho'`: `iso` ve `camera` (göz → hedef yönünde) de dik izdüşümle, kutuyu çerçeveleyerek
   * çekilir; `eye` (göz hizası) her zaman perspektiftir. Verilmezse `iso` perspektif (30°), dik görünümler orto.
   */
  private snapshotCamera(view: SnapshotView, box: THREE.Box3, aspect: number, opt: SnapshotCamera = {}, projection?: SnapshotProjection): THREE.Camera {
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const ortho = projection === 'ortho';
    if (view === 'camera' && ortho && opt.eye) {
      const target = opt.target ? V(opt.target.x, opt.target.y, opt.target.z) : box.getCenter(new THREE.Vector3());
      const dir = V(opt.eye.x, opt.eye.y, opt.eye.z).sub(target);
      if (dir.lengthSq() < 1e-12) dir.set(1, -1.2, 0.95);
      dir.normalize();
      // Dik bakışta Z yukarı tanımsız: Y yukarı.
      return orthoFrameCamera(dir, Math.abs(dir.z) > 0.999 ? V(0, 1, 0) : V(0, 0, 1), box, aspect);
    }
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
    if (view === 'iso' && !ortho) {
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 5);
      // Yakın düzlem mesafeyle orantılı: sabit 0,1 mm, 4 m'lik araçta derinlik çözünürlüğünü ~50 mm'ye düşürüyordu.
      const dist = (radius / Math.sin(15 * DEG)) * 1.05;
      const cam = new THREE.PerspectiveCamera(30, aspect, Math.max(0.1, dist * 0.05), dist * 2 + this.bedSize * 1.5);
      cam.up.copy(up);
      cam.position.copy(center).addScaledVector(dir, dist);
      cam.lookAt(center);
      cam.updateMatrixWorld();
      return cam;
    }
    return orthoFrameCamera(dir, up, box, aspect);
  }
}
