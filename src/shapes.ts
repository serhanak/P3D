import * as THREE from 'three';
import type { ParamKey, PartGeom, ShapeType } from '../shared/ops';
import { buildGeomDisplay } from './geom';

export type Params = Record<string, number>;

export interface ParamDef {
  key: ParamKey;
  label: string;
  def: number;
  min: number;
  max?: number;
  integer?: boolean;
  unit: string;
}

/** Ölçü çizgisi: parçanın yerel koordinatlarında iki uç nokta + etiket. */
export interface DimLine {
  a: [number, number, number];
  b: [number, number, number];
  text: string;
}

/** Ayrıştırıcının tanıdığı genel ölçü kelimeleri ("çap", "iç çap", "kalınlık"...). */
export type DimWord =
  | 'diameter'
  | 'radius'
  | 'outer'
  | 'inner'
  | 'bottom'
  | 'top'
  | 'height'
  | 'width'
  | 'depth'
  | 'length'
  | 'thickness'
  | 'wall'
  | 'sides';

export interface ShapeDef {
  type: ShapeType;
  label: string;
  params: ParamDef[];
  /** Genel ölçü kelimesi -> bu şekildeki parametre. */
  aliases: Partial<Record<DimWord, ParamKey | 'wall'>>;
  /** Merkezi orijinde, Z ekseni yukarı bakan geometri üretir (geom şekillerinde profil koordinatlarında). */
  build(p: Params, seg: number, geom?: PartGeom): THREE.BufferGeometry;
  /** Yoksa ölçü çizgileri ağın sınırlayıcı kutusundan çizilir. */
  dims?(p: Params): DimLine[];
  /** mm³ cinsinden gerçek (analitik) hacim; yoksa ağdan hesaplanır. */
  volume?(p: Params): number;
  /** Parametreler arası kısıtları uygular (ör. iç çap < dış çap). */
  fix?(p: Params): void;
}

export function fmt(n: number): string {
  return Number(n.toFixed(2)).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
}

const len = (key: ParamKey, label: string, def: number, min = 0.1): ParamDef => ({ key, label, def, min, unit: 'mm' });

function gap(...sizes: number[]): number {
  return Math.min(10, Math.max(2, 0.08 * Math.max(...sizes)));
}

function extrude(shape: THREE.Shape, h: number, curveSegments: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments });
  g.translate(0, 0, -h / 2);
  return g;
}

const box: ShapeDef = {
  type: 'box',
  label: 'Kutu',
  params: [len('width', 'Genişlik (X)', 20), len('depth', 'Derinlik (Y)', 20), len('height', 'Yükseklik (Z)', 20)],
  aliases: { width: 'width', length: 'width', depth: 'depth', height: 'height', thickness: 'height' },
  build: (p) => new THREE.BoxGeometry(p.width, p.depth, p.height),
  dims(p) {
    const [w, d, h] = [p.width, p.depth, p.height];
    const g = gap(w, d, h);
    return [
      { a: [-w / 2, -d / 2 - g, -h / 2], b: [w / 2, -d / 2 - g, -h / 2], text: fmt(w) },
      { a: [w / 2 + g, -d / 2, -h / 2], b: [w / 2 + g, d / 2, -h / 2], text: fmt(d) },
      { a: [w / 2 + g, -d / 2 - g, -h / 2], b: [w / 2 + g, -d / 2 - g, h / 2], text: fmt(h) },
    ];
  },
  volume: (p) => p.width * p.depth * p.height,
};

const cylinder: ShapeDef = {
  type: 'cylinder',
  label: 'Silindir',
  params: [len('diameter', 'Çap', 20), len('height', 'Yükseklik', 20)],
  aliases: { diameter: 'diameter', outer: 'diameter', height: 'height', length: 'height', thickness: 'height' },
  build: (p, seg) => new THREE.CylinderGeometry(p.diameter / 2, p.diameter / 2, p.height, seg, 1).rotateX(Math.PI / 2),
  dims(p) {
    const r = p.diameter / 2;
    const h = p.height;
    const g = gap(p.diameter, h);
    return [
      { a: [-r, 0, h / 2], b: [r, 0, h / 2], text: 'Ø' + fmt(p.diameter) },
      { a: [r + g, 0, -h / 2], b: [r + g, 0, h / 2], text: fmt(h) },
    ];
  },
  volume: (p) => Math.PI * (p.diameter / 2) ** 2 * p.height,
};

const tube: ShapeDef = {
  type: 'tube',
  label: 'Boru',
  params: [len('outerDiameter', 'Dış çap', 20), len('innerDiameter', 'İç çap', 14), len('height', 'Yükseklik', 20)],
  aliases: {
    diameter: 'outerDiameter',
    outer: 'outerDiameter',
    inner: 'innerDiameter',
    height: 'height',
    length: 'height',
    wall: 'wall',
    thickness: 'wall',
  },
  build(p, seg) {
    const s = new THREE.Shape();
    s.absarc(0, 0, p.outerDiameter / 2, 0, Math.PI * 2, false);
    const hole = new THREE.Path();
    hole.absarc(0, 0, p.innerDiameter / 2, 0, Math.PI * 2, true);
    s.holes.push(hole);
    return extrude(s, p.height, Math.max(8, Math.round(seg / 2)));
  },
  dims(p) {
    const ro = p.outerDiameter / 2;
    const ri = p.innerDiameter / 2;
    const h = p.height;
    const g = gap(p.outerDiameter, h);
    return [
      { a: [-ro, 0, h / 2], b: [ro, 0, h / 2], text: 'Ø' + fmt(p.outerDiameter) },
      { a: [0, -ri, h / 2], b: [0, ri, h / 2], text: 'iç Ø' + fmt(p.innerDiameter) },
      { a: [ro + g, 0, -h / 2], b: [ro + g, 0, h / 2], text: fmt(h) },
    ];
  },
  volume: (p) => Math.PI * ((p.outerDiameter / 2) ** 2 - (p.innerDiameter / 2) ** 2) * p.height,
  fix(p) {
    if (p.innerDiameter > p.outerDiameter - 0.4) p.innerDiameter = Math.max(0.1, p.outerDiameter - 0.4);
  },
};

const cone: ShapeDef = {
  type: 'cone',
  label: 'Koni',
  params: [len('bottomDiameter', 'Alt çap', 20), len('topDiameter', 'Üst çap', 0, 0), len('height', 'Yükseklik', 20)],
  aliases: {
    diameter: 'bottomDiameter',
    outer: 'bottomDiameter',
    bottom: 'bottomDiameter',
    top: 'topDiameter',
    height: 'height',
    length: 'height',
  },
  build: (p, seg) =>
    new THREE.CylinderGeometry(p.topDiameter / 2, p.bottomDiameter / 2, p.height, seg, 1).rotateX(Math.PI / 2),
  dims(p) {
    const rb = p.bottomDiameter / 2;
    const rt = p.topDiameter / 2;
    const h = p.height;
    const g = gap(p.bottomDiameter, h);
    const out: DimLine[] = [
      { a: [-rb, 0, -h / 2], b: [rb, 0, -h / 2], text: 'Ø' + fmt(p.bottomDiameter) },
      { a: [Math.max(rb, rt) + g, 0, -h / 2], b: [Math.max(rb, rt) + g, 0, h / 2], text: fmt(h) },
    ];
    if (rt > 0) out.push({ a: [-rt, 0, h / 2], b: [rt, 0, h / 2], text: 'Ø' + fmt(p.topDiameter) });
    return out;
  },
  volume: (p) => {
    const [R, r] = [p.bottomDiameter / 2, p.topDiameter / 2];
    return (Math.PI * p.height * (R * R + R * r + r * r)) / 3;
  },
};

const sphere: ShapeDef = {
  type: 'sphere',
  label: 'Küre',
  params: [len('diameter', 'Çap', 20)],
  aliases: { diameter: 'diameter', outer: 'diameter' },
  build: (p, seg) => new THREE.SphereGeometry(p.diameter / 2, seg, Math.max(8, Math.round(seg / 2))),
  dims: (p) => [{ a: [-p.diameter / 2, 0, 0], b: [p.diameter / 2, 0, 0], text: 'Ø' + fmt(p.diameter) }],
  volume: (p) => (4 / 3) * Math.PI * (p.diameter / 2) ** 3,
};

const torus: ShapeDef = {
  type: 'torus',
  label: 'Torus',
  params: [len('diameter', 'Dış çap', 30), len('thickness', 'Kalınlık', 6)],
  aliases: { diameter: 'diameter', outer: 'diameter', thickness: 'thickness', wall: 'thickness' },
  build(p, seg) {
    const R = (p.diameter - p.thickness) / 2;
    return new THREE.TorusGeometry(R, p.thickness / 2, Math.max(12, Math.round(seg / 3)), seg);
  },
  dims(p) {
    const R = (p.diameter - p.thickness) / 2;
    const t = p.thickness;
    return [
      { a: [-p.diameter / 2, 0, 0], b: [p.diameter / 2, 0, 0], text: 'Ø' + fmt(p.diameter) },
      { a: [0, -R - t / 2, 0], b: [0, -R + t / 2, 0], text: fmt(t) },
    ];
  },
  volume: (p) => {
    const R = (p.diameter - p.thickness) / 2;
    return 2 * Math.PI * Math.PI * R * (p.thickness / 2) ** 2;
  },
  fix(p) {
    if (p.thickness > p.diameter / 2) p.thickness = p.diameter / 2;
  },
};

const prism: ShapeDef = {
  type: 'prism',
  label: 'Prizma',
  params: [
    { key: 'sides', label: 'Kenar sayısı', def: 6, min: 3, max: 128, integer: true, unit: 'adet' },
    len('diameter', 'Köşeden köşeye çap', 20),
    len('height', 'Yükseklik', 10),
  ],
  aliases: { sides: 'sides', diameter: 'diameter', outer: 'diameter', height: 'height', length: 'height', thickness: 'height' },
  build(p) {
    const n = Math.round(p.sides);
    const R = p.diameter / 2;
    const s = new THREE.Shape();
    for (let i = 0; i < n; i++) {
      // İlk kenar -Y tarafında düz dursun.
      const a = -Math.PI / 2 + Math.PI / n + (2 * Math.PI * i) / n;
      if (i === 0) s.moveTo(R * Math.cos(a), R * Math.sin(a));
      else s.lineTo(R * Math.cos(a), R * Math.sin(a));
    }
    s.closePath();
    return extrude(s, p.height, 1);
  },
  dims(p) {
    const R = p.diameter / 2;
    const h = p.height;
    const g = gap(p.diameter, h);
    return [
      { a: [-R, 0, h / 2], b: [R, 0, h / 2], text: 'Ø' + fmt(p.diameter) },
      { a: [R + g, 0, -h / 2], b: [R + g, 0, h / 2], text: fmt(h) },
    ];
  },
  volume: (p) => {
    const n = Math.round(p.sides);
    return (n / 2) * (p.diameter / 2) ** 2 * Math.sin((2 * Math.PI) / n) * p.height;
  },
};

const scaleParam: ParamDef = { key: 'scale', label: 'Ölçek', def: 1, min: 0.001, max: 1000, unit: 'kat' };

function geomShape(type: ShapeType, label: string, params: ParamDef[], aliases: ShapeDef['aliases']): ShapeDef {
  return {
    type,
    label,
    params,
    aliases,
    build(p, seg, geom) {
      if (!geom || geom.kind !== type) throw new Error(`${label} için geom eksik.`);
      return buildGeomDisplay(geom, p, seg);
    },
  };
}

const extrudeShape = geomShape('extrude', 'Ekstrüzyon', [len('height', 'Uzunluk (eksen boyunca)', 10), scaleParam], {
  height: 'height',
  length: 'height',
  thickness: 'height',
});
const revolveShape = geomShape('revolve', 'Döndürme', [scaleParam], {});
const loftShape = geomShape('loft', 'Loft', [scaleParam], {});
const hullShape = geomShape('hull', 'Tekne', [scaleParam], {});
const meshShape = geomShape('mesh', 'Mesh', [scaleParam], {});

export const SHAPE_DEFS: Record<ShapeType, ShapeDef> = {
  box,
  cylinder,
  tube,
  cone,
  sphere,
  torus,
  prism,
  extrude: extrudeShape,
  revolve: revolveShape,
  loft: loftShape,
  hull: hullShape,
  mesh: meshShape,
};

export function defaultParams(shape: ShapeType): Params {
  const p: Params = {};
  for (const d of SHAPE_DEFS[shape].params) p[d.key] = d.def;
  return p;
}

/** Değerleri sınırlar içine çeker ve şekil kısıtlarını uygular. */
export function sanitizeParams(shape: ShapeType, p: Params): void {
  const def = SHAPE_DEFS[shape];
  for (const d of def.params) {
    let v = Number(p[d.key]);
    if (!Number.isFinite(v)) v = d.def;
    if (d.integer) v = Math.round(v);
    v = Math.max(d.min, v);
    if (d.max !== undefined) v = Math.min(d.max, v);
    p[d.key] = Number(v.toFixed(4));
  }
  for (const k of Object.keys(p)) if (!def.params.some((d) => d.key === k)) delete p[k];
  def.fix?.(p);
}

/** Geometri üretilemezse (ör. çerçeve için boolean çekirdeği yüklenmedi) bunun yerine çizilen küçük küp. */
export const PLACEHOLDER_SIZE = 5;

export function buildGeometry(shape: ShapeType, p: Params, seg: number, geom?: PartGeom): THREE.BufferGeometry {
  try {
    return SHAPE_DEFS[shape].build(p, seg, geom);
  } catch (e) {
    console.warn(`[p3d] ${SHAPE_DEFS[shape].label} geometrisi üretilemedi:`, (e as Error).message);
    return new THREE.BoxGeometry(PLACEHOLDER_SIZE, PLACEHOLDER_SIZE, PLACEHOLDER_SIZE);
  }
}

/** Sınırlayıcı kutudan genişlik / derinlik / yükseklik ölçü çizgileri (geom şekilleri için). */
export function bboxDims(b: THREE.Box3): DimLine[] {
  const { min, max } = b;
  const g = gap(max.x - min.x, max.y - min.y, max.z - min.z);
  return [
    { a: [min.x, min.y - g, min.z], b: [max.x, min.y - g, min.z], text: fmt(max.x - min.x) },
    { a: [max.x + g, min.y, min.z], b: [max.x + g, max.y, min.z], text: fmt(max.y - min.y) },
    { a: [max.x + g, min.y - g, min.z], b: [max.x + g, min.y - g, max.z], text: fmt(max.z - min.z) },
  ];
}

export const PALETTE = ['#4f8ef7', '#f2994a', '#27ae60', '#eb5757', '#9b51e0', '#f2c94c', '#2d9cdb', '#e0609a', '#6fcf97', '#bb6bd9'];
