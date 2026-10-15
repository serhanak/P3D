// Sahne üzerinde yapılabilecek işlemler. Yerel ayrıştırıcı, Claude ve arayüz
// düzenlemeleri aynı işlem listesini üretir; tümü src/engine.ts'de uygulanır.

export const SHAPES = ['box', 'cylinder', 'tube', 'cone', 'sphere', 'torus', 'prism'] as const;
export type ShapeType = (typeof SHAPES)[number];

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
] as const;
export type ParamKey = (typeof PARAM_KEYS)[number];

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
    }
  | { op: 'move'; part: string; dx: number; dy: number; dz: number }
  /** Yalnızca yerel kullanım: x/y merkezi, z ise parçanın tabanı (alt yüzü) için mutlak değer. */
  | { op: 'set_position'; part: string; x?: number; y?: number; z?: number }
  | { op: 'rotate'; part: string; axis: Axis; degrees: number }
  | { op: 'scale'; part: string; factor: number }
  | { op: 'place_on'; part: string; target: string }
  | { op: 'place_beside'; part: string; target: string; side: Side; gap: number }
  | { op: 'drop_to_bed'; part: string }
  | { op: 'duplicate'; part: string; new_name?: string; offset?: Vec3 | null }
  | { op: 'delete'; part: string }
  | { op: 'select'; part: string }
  | { op: 'view'; show_names?: boolean | null; show_dimensions?: boolean | null };

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
            shape: { type: 'string', enum: [...SHAPES] },
            name: str,
            params: paramList,
            position: nullableVec3,
            rotation: nullableVec3,
            color: str,
            place_on: str,
          }),
          opSchema('update', {
            part: str,
            name: str,
            params: paramList,
            position: nullableVec3,
            rotation: nullableVec3,
            color: str,
            visible: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
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
          opSchema('duplicate', { part: str, new_name: str, offset: nullableVec3 }),
          opSchema('delete', { part: str }),
          opSchema('select', { part: str }),
          opSchema('view', {
            show_names: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
            show_dimensions: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
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
