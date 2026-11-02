// Sahne üzerinde yapılabilecek işlemler. Yerel ayrıştırıcı, Claude ve arayüz
// düzenlemeleri aynı işlem listesini üretir; tümü src/engine.ts'de uygulanır.

export const SHAPES = ['box', 'cylinder', 'tube', 'cone', 'sphere', 'torus', 'prism', 'extrude', 'revolve', 'loft', 'hull', 'mesh'] as const;
export type ShapeType = (typeof SHAPES)[number];

/** Geometrisi `params` yerine `geom` alanındaki nokta dizilerinden üretilen şekiller. */
export const GEOM_SHAPES = ['extrude', 'revolve', 'loft', 'hull', 'mesh'] as const;
export type GeomShape = (typeof GEOM_SHAPES)[number];
export const isGeomShape = (s: string): s is GeomShape => (GEOM_SHAPES as readonly string[]).includes(s);

export const PARAM_KEYS = [
  'width',
  'depth',
  'height',
  'diameter',
  'outerDiameter',
  'innerDiameter',
  'bottomDiameter',
  'topDiameter',
  'thickness',
  'sides',
  'scale',
] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];

/** 2B nokta [a, b]; eksene göre anlamı: axis z → [x, y], axis x → [y, z], axis y → [x, z]. */
export type Pt2 = [number, number];
export type GeomAxis = 'x' | 'y' | 'z';

/** Kapalı çokgen profil `axis` boyunca `height` kadar (merkezli: -h/2 … +h/2) uzatılır; `holes` iç boşluklar. */
export interface ExtrudeGeom {
  kind: 'extrude';
  axis: GeomAxis;
  profile: Pt2[];
  holes?: Pt2[][];
  /** > 0 ise katı, profilin dışında bu genişlikte bir çerçeve halkasıdır (profil = açıklık). */
  frame?: number;
  /** Çerçevede son→ilk kenar açık kalır (ör. kapı pervazının alt kenarı). */
  open?: boolean;
}
/** Kapalı profil [r, a] (r ≥ 0 eksenden uzaklık, a eksen boyunca konum) `axis` etrafında 360° döndürülür. */
export interface RevolveGeom {
  kind: 'revolve';
  axis: GeomAxis;
  profile: Pt2[];
}
export interface LoftSection {
  /** Kesitin eksen boyunca konumu (mm). */
  at: number;
  /** Kapalı çokgen kesit (axis'e dik düzlemde). */
  points: Pt2[];
}
/** Eksen boyunca sıralı kesitler arasında yüzey germe (tekne, gövde, geçiş parçaları). */
export interface LoftGeom {
  kind: 'loft';
  axis: GeomAxis;
  /** İlk/son kesit tek nokta olabilir: loft o uçta sivrilir. */
  sections: LoftSection[];
  /** Catmull-Rom ile çevre ve eksen boyunca yumuşatma (yoğunluk çözünürlük ayarından). */
  smooth?: boolean;
  /** Yumuşatmada keskin kalacak nokta indisleri (tüm kesitlerde nokta sayısı aynıyken). */
  sharp?: number[];
}
/** Endaze istasyonu: x'teki enine kesit. `breadth` omurgadan (ilk) küpeşteye (son) eşit aralıklı yarı genişlikler. */
export interface HullStation {
  x: number;
  keel: number;
  sheer: number;
  breadth: number[];
}
/**
 * Tekne / gövde (endaze tablosu): x boyunca uzanan, y'de simetrik gövde. Yüzey tablodan örtük olarak üretilir;
 * küpeşte (üst), omurga (alt), ayna ve bodoslama yan profilden keskin kesilir.
 */
export interface HullGeom {
  kind: 'hull';
  stations: HullStation[];
}
/** İçe aktarılmış üçgen ağ; veri projenin `assets` deposundadır. */
export interface MeshGeom {
  kind: 'mesh';
  asset: string;
}
export type PartGeom = ExtrudeGeom | RevolveGeom | LoftGeom | HullGeom | MeshGeom;

/** solid: katı (varsayılan) · hole: kesiştiği katılardan çıkarılır · reference: yalnızca görsel referans, dışa aktarılmaz. */
export const ROLES = ['solid', 'hole', 'reference'] as const;
export type Role = (typeof ROLES)[number];

/** İçe aktarılmış ağ verisi: kaynaklı köşe konumları (Float32, base64) ve üçgen indisleri (Uint32, base64). */
export interface MeshAsset {
  id: string;
  name: string;
  positions: string;
  indices: string;
  triangles: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Parametre değişikliği. `mode` yalnızca yerel ayrıştırıcı tarafından kullanılır:
 * set = mutlak değer, add = mevcut değere ekle, mul = mevcut değerle çarp.
 * `wall` boru için et kalınlığıdır (iç çap = dış çap - 2 * et).
 */
export interface ParamChange {
  name: ParamKey | 'wall';
  value: number;
  mode?: 'set' | 'add' | 'mul';
}

export type Side = '+x' | '-x' | '+y' | '-y';
export type Axis = 'x' | 'y' | 'z';

export type Op =
  | {
      op: 'create';
      shape: ShapeType;
      name?: string;
      params?: ParamChange[];
      position?: Vec3 | null;
      rotation?: Vec3 | null;
      color?: string;
      place_on?: string;
      geom?: PartGeom | null;
      role?: Role | '';
      /** Delik hedefleri (ad ya da id); boş/yok = kesiştiği tüm katılar. */
      cuts?: string[] | null;
    }
  | {
      op: 'update';
      part: string;
      name?: string;
      params?: ParamChange[];
      position?: Vec3 | null;
      rotation?: Vec3 | null;
      color?: string;
      visible?: boolean | null;
      geom?: PartGeom | null;
      role?: Role | '';
      /** Delik hedefleri; [] / yok = değişmez, ["*"] = kesiştiği tüm katılar. */
      cuts?: string[] | null;
    }
  | { op: 'move'; part: string; dx: number; dy: number; dz: number }
  /** Yalnızca yerel kullanım: x/y merkezi, z ise parçanın tabanı (alt yüzü) için mutlak değer. */
  | { op: 'set_position'; part: string; x?: number; y?: number; z?: number }
  | { op: 'rotate'; part: string; axis: Axis; degrees: number }
  | { op: 'scale'; part: string; factor: number }
  | { op: 'place_on'; part: string; target: string }
  | { op: 'place_beside'; part: string; target: string; side: Side; gap: number }
  | { op: 'drop_to_bed'; part: string }
  /** Parçayı hedefin yüzeyinde `near`'a en yakın noktaya koyar; yerel +Z yüzey normaline döner, `offset` normal boyunca kaydırır. */
  | { op: 'place_on_surface'; part: string; target: string; near: Vec3; offset?: number }
  | { op: 'duplicate'; part: string; new_name?: string; offset?: Vec3 | null }
  | { op: 'delete'; part: string }
  | { op: 'select'; part: string }
  | { op: 'view'; show_names?: boolean | null; show_dimensions?: boolean | null; show_holes?: boolean | null }
  /** Yalnızca yerel kullanım (arayüz/köprü): ağ verisiyle birlikte mesh parçası ekler. `position` yoksa tablaya yerleşir. */
  | { op: 'import_mesh'; asset: MeshAsset; name?: string; role?: Role | ''; color?: string; position?: Vec3 | null };

export type OpName = Op['op'];

// ---------------------------------------------------------------------------
// Claude yapılandırılmış çıktı şeması (JSON Schema). Opsiyonel metin alanları
// boş string ("") ile, opsiyonel nesneler null ile "değişiklik yok" anlamı taşır.

const num = { type: 'number' };
const str = { type: 'string' };
const vec3 = {
  type: 'object',
  properties: { x: num, y: num, z: num },
  required: ['x', 'y', 'z'],
  additionalProperties: false,
};
const nullableVec3 = { anyOf: [vec3, { type: 'null' }] };
const paramList = {
  type: 'array',
  items: {
    type: 'object',
    properties: { name: { type: 'string', enum: [...PARAM_KEYS] }, value: num },
    required: ['name', 'value'],
    additionalProperties: false,
  },
};

const pt2 = { type: 'array', items: num };
const loop = { type: 'array', items: pt2 };
const axisEnum = { type: 'string', enum: ['x', 'y', 'z'] };
const obj = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const nullableGeom = {
  anyOf: [
    { type: 'null' },
    obj({
      kind: { type: 'string', const: 'extrude' },
      axis: axisEnum,
      profile: loop,
      holes: { type: 'array', items: loop },
      frame: num,
      open: { type: 'boolean' },
    }),
    obj({ kind: { type: 'string', const: 'revolve' }, axis: axisEnum, profile: loop }),
    obj({
      kind: { type: 'string', const: 'loft' },
      axis: axisEnum,
      sections: { type: 'array', items: obj({ at: num, points: loop }) },
      smooth: { type: 'boolean' },
      sharp: { type: 'array', items: num },
    }),
    obj({
      kind: { type: 'string', const: 'hull' },
      stations: { type: 'array', items: obj({ x: num, keel: num, sheer: num, breadth: { type: 'array', items: num } }) },
    }),
  ],
};
const roleEnum = { type: 'string', enum: ['', ...ROLES] };
const LLM_SHAPES = SHAPES.filter((s) => s !== 'mesh');

function opSchema(op: OpName, properties: Record<string, unknown>) {
  return {
    type: 'object',
    properties: { op: { type: 'string', const: op }, ...properties },
    required: ['op', ...Object.keys(properties)],
    additionalProperties: false,
  };
}

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reply: str,
    operations: {
      type: 'array',
      items: {
        anyOf: [
          opSchema('create', {
            shape: { type: 'string', enum: LLM_SHAPES },
            name: str,
            params: paramList,
            position: nullableVec3,
            rotation: nullableVec3,
            color: str,
            place_on: str,
            geom: nullableGeom,
            role: roleEnum,
            cuts: { type: 'array', items: str },
          }),
          opSchema('update', {
            part: str,
            name: str,
            params: paramList,
            position: nullableVec3,
            rotation: nullableVec3,
            color: str,
            visible: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
            geom: nullableGeom,
            role: roleEnum,
            cuts: { type: 'array', items: str },
          }),
          opSchema('move', { part: str, dx: num, dy: num, dz: num }),
          opSchema('rotate', { part: str, axis: { type: 'string', enum: ['x', 'y', 'z'] }, degrees: num }),
          opSchema('scale', { part: str, factor: num }),
          opSchema('place_on', { part: str, target: str }),
          opSchema('place_beside', {
            part: str,
            target: str,
            side: { type: 'string', enum: ['+x', '-x', '+y', '-y'] },
            gap: num,
          }),
          opSchema('drop_to_bed', { part: str }),
          opSchema('place_on_surface', { part: str, target: str, near: vec3, offset: num }),
          opSchema('duplicate', { part: str, new_name: str, offset: nullableVec3 }),
          opSchema('delete', { part: str }),
          opSchema('select', { part: str }),
          opSchema('view', {
            show_names: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
            show_dimensions: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
            show_holes: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
          }),
        ],
      },
    },
  },
  required: ['reply', 'operations'],
  additionalProperties: false,
} as const;

/** Claude'un "" / null ile doldurduğu alanları opsiyonel alanlara çevirir. */
export function normalizeLlmOp(raw: Record<string, unknown>): Op {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === '' || v === null) continue;
    out[k] = v;
  }
  return out as unknown as Op;
}

// ---------------------------------------------------------------------------
// İstemci <-> sunucu sözleşmesi

export interface SceneSummaryPart {
  id: string;
  name: string;
  shape: ShapeType;
  params: Record<string, number>;
  position: Vec3;
  rotation: Vec3;
  color: string;
  visible: boolean;
  bbox: { min: Vec3; max: Vec3 };
  role: Role;
  /** Delik hedefleri (parça adları); yoksa kesiştiği tüm katılar. */
  cuts?: string[];
  /** extrude/revolve/loft için tam geometri; mesh için yalnızca özet. */
  geom?: PartGeom | { kind: 'mesh'; asset: string; triangles: number };
}

export interface SceneSummary {
  units: 'mm';
  bed: { x: number; y: number };
  selected: string | null;
  parts: SceneSummaryPart[];
}

export interface NlRequest {
  text: string;
  scene: SceneSummary;
  history: string[];
}

export interface NlResponse {
  reply: string;
  operations: Op[];
}

// Çalışma alanları (tarayıcı, köprü sunucusu ve CLI ortak kullanır)

/** Kök çalışma alanı: adres `/`, otomatik kayıt localStorage'da. Diğerleri `/w/<ad>`, kayıt IndexedDB'de. */
export const ROOT_WS = '';
export const WS_NAME_MAX = 64;
const WS_NAME_RE = /^[\p{L}\p{N}_.-]+$/u;

/** Çalışma alanı adı geçersizse Türkçe açıklama, geçerliyse null. Kök ('') geçerlidir. */
export function wsNameError(name: string): string | null {
  if (name === ROOT_WS) return null;
  if ([...name].length > WS_NAME_MAX) return `Çalışma alanı adı en fazla ${WS_NAME_MAX} karakter olabilir.`;
  if (name === '.' || name === '..') return `Çalışma alanı adı '${name}' olamaz.`;
  if (!WS_NAME_RE.test(name)) {
    return `Geçersiz çalışma alanı adı '${name}': yalnızca harf, rakam, '_', '-' ve '.' kullanılabilir (boşluk ve eğik çizgi olmaz).`;
  }
  return null;
}

/** Adı Unicode NFC biçimine getirip doğrular; geçersizse Error fırlatır. Boş/eksik ad kök demektir. */
export function normalizeWs(raw: unknown): string {
  if (raw === undefined || raw === null) return ROOT_WS;
  if (typeof raw !== 'string') throw new Error('Çalışma alanı adı metin olmalı.');
  const name = raw.normalize('NFC');
  const err = wsNameError(name);
  if (err) throw new Error(err);
  return name;
}

/** Sayfa yolundan çalışma alanı: `/` → kök, `/w/<ad>` → ad. Başka yollar ve geçersiz adlar Error fırlatır. */
export function wsFromPathname(pathname: string): string {
  if (pathname === '/' || pathname === '/index.html') return ROOT_WS;
  const m = /^\/w\/([^/]*)\/?$/.exec(pathname);
  if (!m) throw new Error(`Bu adreste P3D yok: '${pathname}'. Kök için '/', bir çalışma alanı için '/w/<ad>' kullanın.`);
  let name: string;
  try {
    name = decodeURIComponent(m[1]);
  } catch {
    throw new Error(`Çalışma alanı adı çözülemedi: '${m[1]}'.`);
  }
  if (!name) throw new Error("Çalışma alanı adı boş: adres '/w/<ad>' biçiminde olmalı.");
  return normalizeWs(name);
}

/** Çalışma alanının sayfa yolu: kök `/`, diğerleri `/w/<ad>` (yüzde kodlu). */
export function wsPath(ws: string): string {
  return ws ? `/w/${encodeURIComponent(ws)}` : '/';
}

/** Mesajlarda gösterilecek ad. */
export const wsLabel = (ws: string): string => (ws ? ws : 'kök');

/**
 * Metnin kısa içerik özeti (16 onaltılık karakter; cyrb53 benzeri, iki 32 bit kanal). Kriptografik değildir:
 * tarayıcı ve Node'da aynı sonucu verir, eşzamanlıdır; `p3d save` ile sekmenin aynı projeyi gördüğünü doğrular.
 */
export function contentDigest(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h2) + hex(h1);
}

// Claude Code köprüsü (server/bridge.ts ↔ src/bridge.ts)

export type BridgeAction = 'undo' | 'redo' | 'fit' | 'snapshot' | 'load' | 'mark_saved';

export const SNAPSHOT_VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'] as const;
export type SnapshotView = (typeof SNAPSHOT_VIEWS)[number];

export interface SnapshotOptions {
  views: SnapshotView[];
  width: number;
  height: number;
  /** Ölçü çizgileri görüntüye girsin mi. */
  dims: boolean;
}

/** Sunucudan tarayıcıya giden komut. */
export interface BridgeCommand {
  id: string;
  ops?: Op[];
  action?: BridgeAction;
  snapshot?: SnapshotOptions;
  /** load: proje dosyasının içeriği (parseProject girdisi) ve gömülü ağları. */
  project?: unknown;
  assets?: Record<string, MeshAsset>;
  /** load / mark_saved: sekmenin bağlanacağı dosya yolu (yalnızca gösterim). */
  file?: string;
  /** load: yüklenen proje dosyayla aynı değil (ör. `--force` ile bazı parçalar atlandı); sekme kirli kalır. */
  dirty?: boolean;
  /**
   * mark_saved: kaydedilen projenin içerik özeti (`contentDigest(JSON.stringify(proje))`). Sekme yalnızca kendi
   * güncel projesinin özeti eşleşirse "kaydedildi" sayar; okunduktan sonra değiştiyse kirli kalır.
   */
  digest?: string;
  /** Günlükte gösterilecek açıklama (ör. kullanıcının komutu). */
  label?: string;
}

/** SSE bağlantısının ilk olayı (`event: hello`): sunucunun bu sekmeye verdiği kimlik. */
export interface BridgeHello {
  client: string;
  ws: string;
}

/** GET /api/bridge/scene?ws=… yanıtı: yalnızca o çalışma alanının hedef sekmesinin (en son bağlanan) sahnesi. */
export interface BridgeSceneResponse {
  /** false yalnızca `?stale` ile: bağlı sekme yok, son bilinen sahne. */
  connected: boolean;
  ws: string;
  /** Sahneyi bildiren sekmenin kimliği. */
  client: string;
  /** Çalışma alanı başına her sahne bildiriminde artan sayaç. */
  rev: number;
  /** Bildirim zamanı (ISO). */
  at: string;
  /** Çalışma alanındaki bağlı sekme sayısı. */
  tabs: number;
  /** Sekmenin bağlı olduğu dosya ve kaydedilmemiş değişiklik durumu. */
  file: string | null;
  dirty: boolean;
  /** Sahne özeti; `?full` ile tam proje (+ assets). */
  scene: unknown;
}

/** GET /api/bridge/workspaces öğesi. */
export interface BridgeWorkspace {
  ws: string;
  tabs: number;
  rev: number | null;
  at: string | null;
  parts: number | null;
}

/** Tarayıcının uygulama sonucu. */
export interface BridgeResult {
  id: string;
  /** Sonucu gönderen sekme (sunucu, komutun gönderildiği sekmeyle eşleştirir). */
  client: string;
  messages: string[];
  errors: string[];
  scene: SceneSummary;
  /** snapshot: görünüm adı + PNG data URL. */
  images?: { view: SnapshotView; png: string }[];
}

/** GET /api/status yanıtı. */
export interface LlmStatus {
  /** Claude kullanılabilir mi. */
  llm: boolean;
  /** `api`: Anthropic API anahtarı; `claude-cli`: makinedeki Claude Code hesabı (`claude -p`). */
  backend: 'api' | 'claude-cli' | null;
  model: string;
  /** Claude Code köprüsü (/api/bridge) açık mı. */
  bridge: boolean;
}
