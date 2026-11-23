// Sahne üzerinde yapılabilecek işlemler. Yerel ayrıştırıcı, Claude ve arayüz
// düzenlemeleri aynı işlem listesini üretir; tümü src/engine.ts'de uygulanır.

export const SHAPES = ['box', 'cylinder', 'tube', 'cone', 'sphere', 'torus', 'prism', 'extrude', 'revolve', 'loft', 'hull', 'sweep', 'decal', 'mesh'] as const;
export type ShapeType = (typeof SHAPES)[number];

/** Geometrisi `params` yerine `geom` alanındaki nokta dizilerinden üretilen şekiller. */
export const GEOM_SHAPES = ['extrude', 'revolve', 'loft', 'hull', 'sweep', 'decal', 'mesh'] as const;
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
  /**
   * Ayna işleminin ürettiği loft: kesitler ters yönde dolaşıldığından yan dörtgenler öbür köşegenden bölünür ve ağ
   * özgünün birebir aynası olur. Elle verilmez (Claude şemasında yok); aynanın aynasında kalkar.
   */
  mirrored?: boolean;
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
  /**
   * Üçgen bütçesi (20–1 000 000; oyun varlığı): ağ en fazla bu kadar üçgene sadeleştirilir, ızgara da ona göre küçülür.
   * Yoksa ayrıntılı ağ (~30–60 bin üçgen, baskı için).
   */
  maxTris?: number;
}
/**
 * Süpürme yolunun noktası [x, y, z] (yerel mm, |değer| ≤ 1 000 000); 4. değer (isteğe bağlı) > 0 ise o köşenin yay yarıçapıdır ve
 * `bend`'i ezer; 0 ya da yok = `bend` (0 "yarıçap yok" demektir, gönye değil — tek köşede gönye için `bend` 0 kalır, yaylı
 * köşelere r verilir).
 */
export type SweepPoint = [number, number, number] | [number, number, number, number];
/**
 * Süpürme (yol boyunca kesit): kapalı bir kesit 3B çoklu çizgi boyunca süpürülür; köşeler yay (`bend` / noktadaki r) ya da
 * gönyedir. Kesit ya `profile` ([u, v] çokgen, isteğe bağlı `holes`) ya `diameter` (çözünürlük kadar kenarlı çokgen,
 * isteğe bağlı `innerDiameter` = içi boş boru). Kesit düzleminde v, `up`'ın teğete dik bileşenidir (`frame: 'up'`) ya da
 * yol boyunca dönmeyen çerçevedir (`frame: 'rmf'`); u = teğet × v gidiş yönünün sağıdır. Açık yolun uçları yola dik düz
 * kapaktır. Geometri yeniden merkezlenmez (konum yol koordinatlarının orijinidir).
 */
export interface SweepGeom {
  kind: 'sweep';
  /** ≥ 2 nokta (kapalı yolda ≥ 3). */
  path: SweepPoint[];
  /** true: son → ilk nokta da bağlanır, ilk noktada da köşe işlenir, kapak yok (halka). */
  closed?: boolean;
  /** Köşe yay yarıçapı (mm); yok = 0 = keskin gönye (noktadaki r > 0 o köşede ezer). */
  bend?: number;
  /** Kesit çokgeni [u, v]: u gidiş yönünün sağı, v "yukarı"; (0, 0) yolun üstünde. `diameter` ile birlikte verilmez. */
  profile?: Pt2[];
  /** Kesitteki iç boşluklar (yalnızca `profile` ile). */
  holes?: Pt2[][];
  /** Yuvarlak kesit (köşeden köşeye çap; kenar sayısı = etkin çözünürlük, bir düz kenar −v'ye bakar). */
  diameter?: number;
  /** İçi boş boru (yalnızca `diameter` ile; < diameter). */
  innerDiameter?: number;
  /** Kesitin v ekseninin yönü; yok = [0, 0, 1]. */
  up?: [number, number, number];
  /** Çerçeve kuralı; yok = yuvarlak kesitte 'rmf', profilde 'up'. */
  frame?: 'up' | 'rmf';
}
/**
 * Düz kaplama (plaka, far, harf, dama karesi): yerel XY düzleminde kalınlıksız çokgen, yüzü yerel +Z'ye bakar; ağ z = `lift`'te
 * durur (taşıyıcı yüzeyle çakışıp titreşmesin). Katı değildir: hacmi 0, delik kesmez ve kesilmez, baskıya (STL/3MF/birleştir)
 * girmez, GLB ve OBJ'ye girer. Yerleştirme `position` / `rotation` (yerel +Z = bakış yönü) ya da `place_on_surface`. Geometri
 * yeniden merkezlenmez.
 */
export interface DecalGeom {
  kind: 'decal';
  /** Kapalı çokgen [x, y] (yerel mm). */
  profile: Pt2[];
  /** İç boşluklar (profilin içinde, kenarına değmeyen). */
  holes?: Pt2[][];
  /** İki yüzlü: görünümde ve GLB malzemesinde arka yüz de çizilir (üçgen çoğaltılmaz). */
  double?: boolean;
  /** Yüzeyden uzaklık (mm, 0,01–100); yok = 0,5. Ölçekle (`scale`) büyümez. */
  lift?: number;
}
/**
 * İçe aktarılmış üçgen ağ; veri projenin `assets` deposundadır. `src` verilirse ağ dosyası yolla anılır: Node'da
 * kaydederken (`saveProjectFile`) dosya varsa ağ gömülmez, yol proje dosyasına göreli yazılır; açarken gömülü ağ yoksa
 * dosya okunup `maxTris` ile yeniden sadeleştirilir (aynı kimlikle). Dosyada gömülü gelen ağ gömülü kalır; kaynak
 * dosya değişmişse (`srcSize` / `srcHash` uyuşmaz) uyarı verilir ve gömülü ağ kullanılır. Tarayıcı `src`'yi okumaz,
 * yalnızca taşır.
 */
export interface MeshGeom {
  kind: 'mesh';
  asset: string;
  /** Kaynak ağ dosyası (STL/OBJ/3MF). Bellekte mutlak, dosyada proje dosyasının klasörüne göreli. */
  src?: string;
  /** İçe aktarmadaki üçgen sınırı (yeniden okurken aynı ağ çıksın diye). */
  maxTris?: number;
  /** Ağın okunduğu kaynak dosyanın bayt boyutu (değişiklik denetimi). */
  srcSize?: number;
  /** Kaynak dosyanın kısa içerik özeti (SHA-256'nın ilk 16 onaltılık hanesi). */
  srcHash?: string;
}
export type PartGeom = ExtrudeGeom | RevolveGeom | LoftGeom | HullGeom | SweepGeom | DecalGeom | MeshGeom;

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

/** Parça grubu: üyeler birlikte taşınır/döner/kopyalanır; `pivot` dönme merkezi (dünya, mm). Üyelik `Part.group`'tadır. */
export interface GroupDef {
  name: string;
  pivot: Vec3;
}

// ---------------------------------------------------------------------------
// Eskiz (sketch): kullanıcının 3B görünümde çizdiği yollar. Yalnızca niyet verisidir: geometri üretmez, dışa aktarılmaz,
// `check`'e girmez. Claude (sahne özeti) ve Claude Code (`p3d scene` / `p3d sketch`) parçaları bu yolları okuyarak var
// olan işlemlerle kurar.

export interface SketchPoint {
  /** Dünya koordinatı (mm). */
  p: Vec3;
  /** Bezier tutamaçları: `p`'ye GÖRELİ ofset (mm). İkisi de yoksa köşe noktası. */
  hIn?: Vec3;
  hOut?: Vec3;
}

/** Çizim düzlemi: `axis` eksenine dik, o eksende `at` konumunda (ör. {axis: 'z', at: 0} üstten, tabla). */
export interface SketchPlane {
  axis: GeomAxis;
  at: number;
}

export interface SketchPath {
  id: string;
  /** Varsayılan "Yol N"; eskiz yolları arasında benzersiz (büyük/küçük harf ve aksan duyarsız). Parça adlarıyla çakışabilir. */
  name: string;
  closed: boolean;
  plane: SketchPlane;
  /** 1…1000 nokta. */
  points: SketchPoint[];
  /** Kullanıcının kısa notu (≤ 200 karakter); yoksa alan bulunmaz. */
  note?: string;
}

/** marker: tek nokta · arrow: açık, iki nokta (p0 → p1) · polygon: kapalı, ≥ 3 nokta · line: diğerleri. */
export type SketchKind = 'marker' | 'arrow' | 'line' | 'polygon';

export const SKETCH_KIND_LABELS: Record<SketchKind, string> = {
  marker: 'işaret',
  arrow: 'ok',
  line: 'çizgi',
  polygon: 'kapalı çokgen',
};

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
      /** Görsel saydamlık 0–1 (1 = opak, 0 = tamamen saydam); yok/null = opak. */
      opacity?: number | null;
      /** Parça başına yuvarlak yüzey çözünürlüğü (6–192 segment); yok/null/0 = proje ayarı. */
      resolution?: number | null;
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
      /** Görsel saydamlık 0–1; 1 = opak (alan kalkar); yok/null = değişmez. Grupta tüm üyelere uygulanır. */
      opacity?: number | null;
      /** Parça başına çözünürlük (6–192); 0 = alan kalkar (proje ayarı); yok/null = değişmez. */
      resolution?: number | null;
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
  /** `count` > 1: `offset` her kopyada birikerek uygulanır (1×, 2×, … count×); `part` bir grup adı olabilir. */
  | { op: 'duplicate'; part: string; new_name?: string; offset?: Vec3 | null; count?: number }
  | { op: 'delete'; part: string }
  /** Grup oluşturur ya da günceller; `parts` boş/yok = üyeler değişmez; `pivot` yok = yeni grupta üyelerin kutu merkezi. */
  | { op: 'group'; name: string; parts?: string[] | null; pivot?: Vec3 | null }
  | { op: 'ungroup'; name: string }
  | { op: 'set_pivot'; group: string; pivot: Vec3 }
  /** Parçanın (ya da grubun) `plane` eksenine dik, `at` konumundaki düzleme göre aynalanmış kopyasını oluşturur. */
  | { op: 'mirror'; part: string; plane: Axis; at?: number | null; name?: string }
  | { op: 'select'; part: string }
  | { op: 'view'; show_names?: boolean | null; show_dimensions?: boolean | null; show_holes?: boolean | null }
  /**
   * Yalnızca yerel kullanım (arayüz/köprü): ağ verisiyle birlikte mesh parçası ekler. `position` yoksa tablaya yerleşir.
   * `src` / `maxTris` / `srcSize` / `srcHash` parçanın geom'una yazılır (bkz. MeshGeom; `p3d import` doldurur).
   */
  | {
      op: 'import_mesh';
      asset: MeshAsset;
      name?: string;
      role?: Role | '';
      color?: string;
      position?: Vec3 | null;
      src?: string;
      maxTris?: number;
      srcSize?: number;
      srcHash?: string;
    }
  // Eskiz işlemleri yalnızca yerel/köprü kullanım içindir (Claude şemasında yok). `path`: yolun kimliği ya da tam adı.
  /**
   * Eskiz yolu ekler. `name` ""/yok = "Yol N". `plane` yoksa noktalardan türetilir (tüm z eşit → z; tüm y eşit → y;
   * tüm x eşit → x; değilse {axis: 'z', at: en küçük z}).
   */
  | { op: 'sketch_add'; name?: string; closed?: boolean; plane?: SketchPlane | null; points: SketchPoint[]; note?: string }
  /** Alanları değiştirir; verilmeyen (undefined/null) alan değişmez. `note: ""` notu siler. `points` verilirse tamamı değişir. */
  | {
      op: 'sketch_update';
      path: string;
      name?: string;
      closed?: boolean | null;
      plane?: SketchPlane | null;
      points?: SketchPoint[] | null;
      note?: string | null;
    }
  /** Seçili noktaları (`indices`; yok/boş = tümü) dx, dy, dz kadar taşır; tutamaçlar göreli olduğundan birlikte gider. */
  | { op: 'sketch_move'; path: string; indices?: number[] | null; dx: number; dy: number; dz: number }
  /** `path` yok/"" = tüm eskiz yolları silinir. */
  | { op: 'sketch_delete'; path?: string };

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
const nullableNum = { anyOf: [num, { type: 'null' }] };
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
      maxTris: num,
    }),
    // Süpürme: boş alanlar null (profil ya da çap; ikisi birden değil).
    obj({
      kind: { type: 'string', const: 'sweep' },
      path: { type: 'array', items: { type: 'array', items: num } },
      closed: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
      bend: nullableNum,
      profile: { anyOf: [loop, { type: 'null' }] },
      holes: { anyOf: [{ type: 'array', items: loop }, { type: 'null' }] },
      diameter: nullableNum,
      innerDiameter: nullableNum,
      up: { anyOf: [{ type: 'array', items: num }, { type: 'null' }] },
      frame: { anyOf: [{ type: 'string', enum: ['up', 'rmf'] }, { type: 'null' }] },
    }),
    // Düz kaplama: boş alanlar null (lift null/0 = 0,5 mm).
    obj({
      kind: { type: 'string', const: 'decal' },
      profile: loop,
      holes: { anyOf: [{ type: 'array', items: loop }, { type: 'null' }] },
      double: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
      lift: nullableNum,
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
            opacity: nullableNum,
            resolution: nullableNum,
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
            opacity: nullableNum,
            resolution: nullableNum,
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
          opSchema('duplicate', { part: str, new_name: str, offset: nullableVec3, count: num }),
          opSchema('delete', { part: str }),
          opSchema('group', { name: str, parts: { type: 'array', items: str }, pivot: nullableVec3 }),
          opSchema('ungroup', { name: str }),
          opSchema('set_pivot', { group: str, pivot: vec3 }),
          opSchema('mirror', { part: str, plane: axisEnum, at: { anyOf: [num, { type: 'null' }] }, name: str }),
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
  // duplicate.count şemada zorunlu: 0 ya da 1 = tek kopya (alan yokmuş gibi).
  if (out.op === 'duplicate' && (out.count === 0 || out.count === 1)) delete out.count;
  // opacity şemada zorunlu: Claude boş sayıyı 0 ile doldurabilir, bu da parçayı görünmez yapardı. 0 = verilmedi (gizlemek
  // için visible: false); yerel/köprü işlemleri 0'ı kabul etmeye devam eder.
  if ((out.op === 'create' || out.op === 'update') && out.opacity === 0) delete out.opacity;
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
  /** Üyesi olduğu grubun adı. */
  group?: string;
  /** Görsel saydamlık (yalnızca < 1 iken). */
  opacity?: number;
  /** Parça başına yuvarlak yüzey çözünürlüğü (yalnızca ayarlıysa; yoksa proje ayarı). */
  resolution?: number;
  /**
   * extrude/revolve/loft/hull/sweep/decal için tam geometri; mesh için yalnızca özet: kaynak dosyanın yalnızca adı (`src`, klasör yolu
   * yok — özet Claude'a ve köprüye gider), `maxTris` / `srcSize` / `srcHash` yok.
   */
  geom?: PartGeom | { kind: 'mesh'; asset: string; triangles: number; src?: string };
}

/** Eskiz yolunun sahne özeti (dünya mm, 2 ondalık). */
export interface SceneSummarySketch {
  id: string;
  name: string;
  kind: SketchKind;
  closed: boolean;
  plane: SketchPlane;
  /** Noktalar (tutamaçlar varsa onlar da, `p`'ye göreli). */
  points: SketchPoint[];
  /** Yalnızca eğri (tutamaçlı) yollarda: örneklenmiş noktalar (kapalı yolda ilk nokta tekrarlanmaz). */
  polyline?: Vec3[];
  /** arrow/line: uzunluk (mm); polygon: çevre. */
  length?: number;
  /** Yalnızca arrow: birim yön (p0 → p1). */
  direction?: Vec3;
  bbox: { min: Vec3; max: Vec3 };
  note?: string;
}

export interface SceneSummary {
  units: 'mm';
  bed: { x: number; y: number };
  selected: string | null;
  parts: SceneSummaryPart[];
  /** Gruplar ve pivotları (varsa). */
  groups?: GroupDef[];
  /** Kullanıcının çizdiği eskiz yolları (varsa): niyet verisi, parça değil. */
  sketch?: SceneSummarySketch[];
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

/** `eye`: göz hizasından perspektif (hazır); `camera`: serbest perspektif kamera (`SnapshotOptions.camera.eye` ister). */
export const SNAPSHOT_VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom', 'eye', 'camera'] as const;
export type SnapshotView = (typeof SNAPSHOT_VIEWS)[number];

/** snapshot görüntü kenarının sınırları (piksel). */
export const SNAPSHOT_MIN_SIDE = 200;
export const SNAPSHOT_MAX_SIDE = 4096;

/**
 * İstenen görüntü boyutunu sınırlara oturtur. Uzun kenar `SNAPSHOT_MAX_SIDE`'ı aşarsa iki kenar birlikte (en-boy oranı
 * korunarak) küçültülür; kısa kenar `SNAPSHOT_MIN_SIDE`'ın altında kalırsa yalnızca o yükseltilir (çok uzun şeritlerde oran
 * o zaman değişir). Sunucu (köprü) ve CLI aynı kuralı kullanır; CLI sonuç istenenden farklıysa uyarır.
 */
export function fitSnapshotSize(width: number, height: number): { width: number; height: number } {
  const k = Math.min(1, SNAPSHOT_MAX_SIDE / Math.max(width, height));
  const side = (v: number) => Math.min(SNAPSHOT_MAX_SIDE, Math.max(SNAPSHOT_MIN_SIDE, Math.round(v * k)));
  return { width: side(width), height: side(height) };
}

/** Perspektif görünümlerin (`eye`, `camera`) kamerası. Birim mm, dünya koordinatı. */
export interface SnapshotCamera {
  /** Kamera konumu; `camera` görünümü için zorunlu. */
  eye?: Vec3;
  /** Bakılan nokta; yoksa görünür parçaların kutu merkezi. */
  target?: Vec3;
  /** Dikey görüş açısı (derece, `SNAPSHOT_FOV_MIN`–`SNAPSHOT_FOV_MAX`); yoksa `SNAPSHOT_FOV_DEFAULT`. */
  fov?: number;
  /** `eye` görünümünde gözün görünür kutunun tabanından yüksekliği; yoksa `SNAPSHOT_EYE_HEIGHT`. */
  eyeHeight?: number;
}
export const SNAPSHOT_FOV_DEFAULT = 50;
export const SNAPSHOT_FOV_MIN = 10;
export const SNAPSHOT_FOV_MAX = 120;
/** `eye` görünümünün varsayılan göz yüksekliği (mm): yerden ~1 m (araç/kart sürücüsü gözü). */
export const SNAPSHOT_EYE_HEIGHT = 1000;

/**
 * Görünüm biçimi: `shaded` gölgeli (dolgu + kırılım çizgileri), `wire` tel kafes (dolgu aynı, her üçgen kenarı; arkadakiler
 * derinlikle gizli), `xray` X-ışını (dolgu çok soluk, arkadakiler dahil tüm üçgen kenarları parça renginde). Arayüzde yalnızca
 * bellekte tutulur (projeye girmez).
 */
export const VIEW_STYLES = ['shaded', 'wire', 'xray'] as const;
export type ViewStyle = (typeof VIEW_STYLES)[number];

/**
 * Görüntü izdüşümü: `perspective` (varsayılan; `iso` perspektif 30°, dik görünümler orto) ya da `ortho` (`iso` ve `camera` da
 * dik izdüşüm, kutuyu çerçeveler; `eye` göz hizası her zaman perspektif).
 */
export const SNAPSHOT_PROJECTIONS = ['perspective', 'ortho'] as const;
export type SnapshotProjection = (typeof SNAPSHOT_PROJECTIONS)[number];

export interface SnapshotOptions {
  views: SnapshotView[];
  width: number;
  height: number;
  /** Ölçü çizgileri görüntüye girsin mi. */
  dims: boolean;
  /** `eye` / `camera` görünümlerinin kamerası. */
  camera?: SnapshotCamera;
  /** Görüntünün biçimi; yoksa `shaded`. Arayüzdeki biçimden bağımsızdır (görüntüden sonra arayüzünki geri gelir). */
  style?: ViewStyle;
  /** İzdüşüm; yoksa `perspective`. Arayüzdeki kamera tipinden bağımsızdır. */
  projection?: SnapshotProjection;
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
