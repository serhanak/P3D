import * as THREE from 'three';
import { ROLES, isGeomShape, type Axis, type Op, type ParamChange, type Role, type SceneSummary, type Side, type Vec3 } from '../shared/ops';
import { getAsset, registerAsset } from './assets';
import { resolveColor } from './colors';
import { GeomError, defaultGeom, describeGeom, geometryVolume, sanitizeGeom } from './geom';
import { PALETTE, SHAPE_DEFS, buildGeometry, defaultParams, fmt, sanitizeParams, type DimWord, type Params } from './shapes';
import { fold } from './text';
import type { Part, Project } from './types';

// ---------------------------------------------------------------------------
// Geometri yardımcıları

const positionCache = new Map<string, Float32Array>();

function geometryKey(part: Part, seg: number): string {
  return `${part.shape}|${JSON.stringify(part.params)}|${part.geom ? JSON.stringify(part.geom) : ''}|${seg}`;
}

function positionsFor(part: Part, seg: number): Float32Array {
  const key = geometryKey(part, seg);
  let arr = positionCache.get(key);
  if (!arr) {
    const g = buildGeometry(part.shape, part.params, seg, part.geom);
    arr = (g.getAttribute('position').array as Float32Array).slice();
    g.dispose();
    if (positionCache.size > 300) positionCache.clear();
    positionCache.set(key, arr);
  }
  return arr;
}

const DEG = Math.PI / 180;

export function partMatrix(part: Part): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(part.rotation.x * DEG, part.rotation.y * DEG, part.rotation.z * DEG, 'XYZ'),
  );
  return new THREE.Matrix4().compose(
    new THREE.Vector3(part.position.x, part.position.y, part.position.z),
    q,
    new THREE.Vector3(1, 1, 1),
  );
}

/** Parçanın dünya koordinatlarındaki sınırlayıcı kutusu (döndürme dahil). */
export function partBox(part: Part, seg: number): THREE.Box3 {
  const pos = positionsFor(part, seg);
  const m = partMatrix(part);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.length; i += 3) box.expandByPoint(v.set(pos[i], pos[i + 1], pos[i + 2]).applyMatrix4(m));
  return box;
}

export function partsBox(parts: Part[], seg: number): THREE.Box3 {
  const box = new THREE.Box3();
  for (const p of parts) box.union(partBox(p, seg));
  return box;
}

const volumeCache = new Map<string, number>();

/** Parçanın kendi hacmi (mm³, delikler hariç): analitik ya da ağdan. Delikli son hacim için model.ts → solidVolume. */
export function partVolume(part: Part, seg = 96): number {
  const def = SHAPE_DEFS[part.shape];
  if (def.volume) return def.volume(part.params);
  const key = geometryKey(part, seg);
  let v = volumeCache.get(key);
  if (v === undefined) {
    const g = buildGeometry(part.shape, part.params, seg, part.geom);
    v = Math.abs(geometryVolume(g));
    g.dispose();
    if (volumeCache.size > 300) volumeCache.clear();
    volumeCache.set(key, v);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Parça bulma ve adlandırma

export interface RefContext {
  selectedId: string | null;
  lastPartId: string | null;
}

export function findPart(project: Project, ref: string | undefined, ctx: RefContext): Part | undefined {
  if (!ref) return undefined;
  const byId = (id: string | null) => (id ? project.parts.find((p) => p.id === id) : undefined);
  if (ref === '$last') return byId(ctx.lastPartId);
  if (ref === '$selected') return byId(ctx.selectedId);
  const direct = byId(ref);
  if (direct) return direct;
  const f = fold(ref).trim();
  const exact = project.parts.filter((p) => fold(p.name).trim() === f);
  if (exact.length) return exact[exact.length - 1];
  const prefix = project.parts.filter((p) => fold(p.name).startsWith(f));
  if (prefix.length === 1) return prefix[0];
  const contains = project.parts.filter((p) => fold(p.name).includes(f));
  if (contains.length === 1) return contains[0];
  return undefined;
}

function nameTaken(project: Project, name: string, exceptId?: string): boolean {
  const f = fold(name).trim();
  return project.parts.some((p) => p.id !== exceptId && fold(p.name).trim() === f);
}

export function uniqueName(project: Project, base: string, exceptId?: string): string {
  const clean = base.trim();
  if (!nameTaken(project, clean, exceptId)) return clean;
  for (let n = 2; ; n++) {
    const cand = `${clean} ${n}`;
    if (!nameTaken(project, cand, exceptId)) return cand;
  }
}

function defaultName(project: Project, label: string): string {
  for (let n = 1; ; n++) {
    const cand = `${label} ${n}`;
    if (!nameTaken(project, cand)) return cand;
  }
}

export function newId(): string {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// İşlem uygulama

export class OpError extends Error {}

export interface ApplyResult {
  messages: string[];
  errors: string[];
  /** İşlemlerin en son dokunduğu parça (seçim için). */
  lastPartId: string | null;
  /** Seçimin temizlenmesi gerekiyorsa true (ör. seçili parça silindi). */
  clearSelection: boolean;
}

const PARAM_LABELS: Record<string, string> = {
  width: 'genişlik',
  depth: 'derinlik',
  height: 'yükseklik',
  diameter: 'çap',
  outerDiameter: 'dış çap',
  innerDiameter: 'iç çap',
  bottomDiameter: 'alt çap',
  topDiameter: 'üst çap',
  thickness: 'kalınlık',
  sides: 'kenar sayısı',
  wall: 'et kalınlığı',
};

export function paramLabel(key: string): string {
  return PARAM_LABELS[key] ?? key;
}

/** Claude başka bir şeklin parametre adını gönderirse (ör. boru için `diameter`) eşleştirmek için. */
const KEY_TO_WORD: Record<string, DimWord> = {
  outerDiameter: 'outer',
  innerDiameter: 'inner',
  bottomDiameter: 'bottom',
  topDiameter: 'top',
};

function unitOf(key: string): string {
  return key === 'sides' ? '' : ' mm';
}

/** Parametre değişikliklerini uygular; değişiklik açıklamalarını döndürür. */
function applyParamChanges(part: Part, changes: ParamChange[]): string[] {
  const def = SHAPE_DEFS[part.shape];
  const p: Params = { ...part.params };
  const notes: string[] = [];
  for (const ch of changes) {
    const mode = ch.mode ?? 'set';
    if (!Number.isFinite(ch.value)) throw new OpError(`'${paramLabel(ch.name)}' için geçersiz değer.`);
    const calc = (cur: number) => (mode === 'add' ? cur + ch.value : mode === 'mul' ? cur * ch.value : ch.value);

    if (ch.name === 'wall') {
      if (part.shape !== 'tube') throw new OpError(`${def.label} için et kalınlığı yok.`);
      const cur = (p.outerDiameter - p.innerDiameter) / 2;
      const next = calc(cur);
      if (!(next > 0) || next * 2 >= p.outerDiameter)
        throw new OpError(`Et kalınlığı ${fmt(next)} mm olamaz (dış çap ${fmt(p.outerDiameter)} mm).`);
      p.innerDiameter = p.outerDiameter - 2 * next;
      notes.push(`et kalınlığı ${fmt(cur)} → ${fmt(next)} mm`);
      continue;
    }

    let key: string = ch.name;
    if (!def.params.some((d) => d.key === key)) {
      const alias = def.aliases[(KEY_TO_WORD[key] ?? key) as DimWord];
      if (!alias) throw new OpError(`${def.label} şeklinde '${paramLabel(key)}' ölçüsü yok.`);
      key = alias;
    }
    const pd = def.params.find((d) => d.key === key)!;
    const cur = p[key];
    let next = calc(cur);
    if (pd.integer) next = Math.round(next);
    if (next < pd.min || (pd.max !== undefined && next > pd.max) || !Number.isFinite(next)) {
      throw new OpError(
        `${def.label} '${part.name}': ${paramLabel(key)} ${fmt(next)}${unitOf(key)} olamaz (en az ${fmt(pd.min)}${unitOf(key)}).`,
      );
    }
    p[key] = next;
    notes.push(`${paramLabel(key)} ${fmt(cur)} → ${fmt(next)}${unitOf(key)}`);
  }
  sanitizeParams(part.shape, p);
  part.params = p;
  return notes;
}

/** Ölçü/döndürme değişince parçanın tabanı (min Z) ve XY merkezi yerinde kalsın. */
function anchored(part: Part, seg: number, mutate: () => void): void {
  const before = partBox(part, seg);
  mutate();
  const after = partBox(part, seg);
  const cb = before.getCenter(new THREE.Vector3());
  const ca = after.getCenter(new THREE.Vector3());
  part.position.x = round(part.position.x + cb.x - ca.x);
  part.position.y = round(part.position.y + cb.y - ca.y);
  part.position.z = round(part.position.z + before.min.z - after.min.z);
}

function round(n: number): number {
  return Number(n.toFixed(3));
}

function translate(part: Part, dx: number, dy: number, dz: number): void {
  part.position.x = round(part.position.x + dx);
  part.position.y = round(part.position.y + dy);
  part.position.z = round(part.position.z + dz);
}

function normAngle(a: number): number {
  let r = ((a % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return round(r);
}

function checkVec(v: Vec3 | null | undefined, what: string): Vec3 | null {
  if (!v) return null;
  const out = { x: Number(v.x), y: Number(v.y), z: Number(v.z) };
  if (![out.x, out.y, out.z].every(Number.isFinite)) throw new OpError(`Geçersiz ${what}.`);
  return out;
}

function colorOf(c: string | undefined): string | null {
  if (!c) return null;
  const hex = resolveColor(c);
  if (!hex) throw new OpError(`Renk anlaşılamadı: '${c}'.`);
  return hex;
}

/** Yeni parçayı tablada, mevcut parçalarla çakışmayan, merkeze en yakın yere koyar. */
function autoPlace(project: Project, part: Part): void {
  const seg = project.settings.resolution;
  part.position = { x: 0, y: 0, z: 0 };
  const b = partBox(part, seg);
  const others = project.parts.filter((p) => p.visible && p.id !== part.id).map((p) => partBox(p, seg));
  const margin = 5;
  const hx = project.settings.bedX / 2;
  const hy = project.settings.bedY / 2;
  const cands: [number, number][] = [];
  for (let x = -hx; x <= hx; x += 5) for (let y = -hy; y <= hy; y += 5) cands.push([x, y]);
  cands.sort((a, c) => a[0] * a[0] + a[1] * a[1] - (c[0] * c[0] + c[1] * c[1]));
  const free = (x: number, y: number) =>
    x + b.min.x >= -hx &&
    x + b.max.x <= hx &&
    y + b.min.y >= -hy &&
    y + b.max.y <= hy &&
    others.every(
      (o) =>
        x + b.max.x + margin <= o.min.x ||
        x + b.min.x - margin >= o.max.x ||
        y + b.max.y + margin <= o.min.y ||
        y + b.min.y - margin >= o.max.y,
    );
  let spot = cands.find(([x, y]) => free(x, y));
  if (!spot) {
    // Tabla dolu: tüm parçaların sağına koy.
    const maxX = others.reduce((m, o) => Math.max(m, o.max.x), 0);
    spot = [maxX + 10 - b.min.x, 0];
  }
  part.position = { x: round(spot[0]), y: round(spot[1]), z: round(-b.min.z) };
}

function describeParams(part: Part): string {
  const params = SHAPE_DEFS[part.shape].params
    .filter((d) => !(d.key === 'scale' && part.params.scale === 1))
    .map((d) => `${paramLabel(d.key)} ${fmt(part.params[d.key])}${unitOf(d.key)}`);
  if (part.geom) params.unshift(describeGeom(part.geom));
  return params.join(', ');
}

const ROLE_LABEL: Record<Role, string> = { solid: 'katı', hole: 'delik', reference: 'referans' };

function roleValue(r: string | undefined): Role | null {
  if (!r) return null;
  if (!(ROLES as readonly string[]).includes(r)) throw new OpError(`Geçersiz rol: '${r}' (solid, hole, reference).`);
  return r as Role;
}

function setRole(part: Part, role: Role): void {
  if (role === 'solid') delete part.role;
  else part.role = role;
}

/** Delik hedeflerini (ad ya da id) parça kimliklerine çevirir. */
function cutsFor(part: Part, refs: string[], find: (ref: string) => Part): string[] | undefined {
  if (part.role !== 'hole') throw new OpError(`'${part.name}' delik değil; hedef (cuts) yalnızca delik parçalarına verilir.`);
  if (refs.includes('*')) return undefined;
  return [...new Set(refs.map((r) => find(r).id))];
}

/** geom doğrulama hatalarını işlem hatasına çevirir. */
function geomFor(part: Part, raw: unknown): void {
  if (!isGeomShape(part.shape)) throw new OpError(`${SHAPE_DEFS[part.shape].label} şekli geom almaz; ölçüleri params ile verin.`);
  try {
    part.geom = sanitizeGeom(part.shape, raw);
  } catch (e) {
    if (e instanceof GeomError) throw new OpError(`'${part.name}': ${e.message}`);
    throw e;
  }
}

export function applyOps(project: Project, ops: Op[], selectedId: string | null): ApplyResult {
  const res: ApplyResult = { messages: [], errors: [], lastPartId: null, clearSelection: false };
  const seg = project.settings.resolution;
  const ctx: RefContext = { selectedId, lastPartId: null };

  const must = (ref: string | undefined): Part => {
    const p = findPart(project, ref, ctx);
    if (!p) {
      if (!ref || ref === '$selected') throw new OpError('Hangi parça? Bir parça adı yazın ya da listeden seçin.');
      throw new OpError(`'${ref}' adında parça bulunamadı.`);
    }
    return p;
  };
  const touch = (p: Part) => {
    ctx.lastPartId = p.id;
    res.lastPartId = p.id;
  };

  for (const op of ops) {
    try {
      switch (op.op) {
        case 'create': {
          const def = SHAPE_DEFS[op.shape];
          if (!def) throw new OpError(`Bilinmeyen şekil: ${String(op.shape)}`);
          if (op.shape === 'mesh') throw new OpError('Mesh parçası dosyadan içe aktarılarak eklenir (İçe aktar… ya da npm run p3d -- import).');
          const role = roleValue(op.role);
          const part: Part = {
            id: newId(),
            name: op.name?.trim() ? uniqueName(project, op.name) : defaultName(project, def.label),
            shape: op.shape,
            params: defaultParams(op.shape),
            position: { x: 0, y: 0, z: 0 },
            rotation: checkVec(op.rotation, 'döndürme') ?? { x: 0, y: 0, z: 0 },
            color: colorOf(op.color) ?? PALETTE[project.parts.length % PALETTE.length],
            visible: true,
          };
          if (isGeomShape(op.shape)) {
            if (op.geom) geomFor(part, op.geom);
            else part.geom = defaultGeom(op.shape);
          } else if (op.geom) geomFor(part, op.geom);
          if (role) setRole(part, role);
          if (op.cuts?.length) {
            const cuts = cutsFor(part, op.cuts, must);
            if (cuts) part.cuts = cuts;
          }
          if (op.params?.length) applyParamChanges(part, op.params);
          const pos = checkVec(op.position, 'konum');
          if (pos) part.position = pos;
          else autoPlace(project, part);
          if (op.place_on) {
            const target = must(op.place_on);
            project.parts.push(part);
            placeOn(part, target, seg);
          } else {
            project.parts.push(part);
          }
          touch(part);
          const roleNote = part.role ? `, ${ROLE_LABEL[part.role]}` : '';
          res.messages.push(`'${part.name}' ${def.label.toLocaleLowerCase('tr')} oluşturuldu (${describeParams(part)}${roleNote}).`);
          break;
        }
        case 'import_mesh': {
          let asset;
          try {
            asset = registerAsset(op.asset);
          } catch (e) {
            throw new OpError(`Ağ verisi geçersiz: ${(e as Error).message}`);
          }
          const role = roleValue(op.role);
          const part: Part = {
            id: newId(),
            name: uniqueName(project, op.name?.trim() || asset.name || 'Mesh'),
            shape: 'mesh',
            params: defaultParams('mesh'),
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            color: colorOf(op.color) ?? PALETTE[project.parts.length % PALETTE.length],
            visible: true,
            geom: { kind: 'mesh', asset: asset.id },
          };
          if (role) setRole(part, role);
          const pos = checkVec(op.position, 'konum');
          if (pos) part.position = pos;
          else autoPlace(project, part);
          project.parts.push(part);
          touch(part);
          res.messages.push(`'${part.name}' içe aktarıldı (${asset.triangles.toLocaleString('tr-TR')} üçgen${part.role ? `, ${ROLE_LABEL[part.role]}` : ''}).`);
          break;
        }
        case 'update': {
          const part = must(op.part);
          const notes: string[] = [];
          if (op.name?.trim()) {
            const nn = uniqueName(project, op.name, part.id);
            if (nn !== part.name) notes.push(`ad '${part.name}' → '${nn}'`);
            part.name = nn;
          }
          const color = colorOf(op.color);
          if (color && color !== part.color) {
            part.color = color;
            notes.push(`renk ${color}`);
          }
          if (typeof op.visible === 'boolean' && op.visible !== part.visible) {
            part.visible = op.visible;
            notes.push(op.visible ? 'gösterildi' : 'gizlendi');
          }
          const role = roleValue(op.role);
          if (role && role !== (part.role ?? 'solid')) {
            setRole(part, role);
            notes.push(`rol: ${ROLE_LABEL[role]}`);
            if (role !== 'hole') delete part.cuts;
          }
          if (op.cuts?.length) {
            const cuts = cutsFor(part, op.cuts, must);
            if (cuts) part.cuts = cuts;
            else delete part.cuts;
            notes.push(`keser: ${cuts ? cuts.map((id) => project.parts.find((p) => p.id === id)?.name ?? id).join(', ') : 'kesiştiği tüm katılar'}`);
          }
          const pos = checkVec(op.position, 'konum');
          const rot = checkVec(op.rotation, 'döndürme');
          if (op.geom) {
            // Geometri mutlak koordinatlarla verilir; konum korunur (taban sabitleme yok).
            geomFor(part, op.geom);
            notes.push(`geometri: ${describeGeom(part.geom)}`);
          }
          if (op.params?.length || rot) {
            const mutate = () => {
              if (op.params?.length) notes.push(...applyParamChanges(part, op.params));
              if (rot) {
                part.rotation = { x: normAngle(rot.x), y: normAngle(rot.y), z: normAngle(rot.z) };
                notes.push(`döndürme ${fmt(part.rotation.x)}°, ${fmt(part.rotation.y)}°, ${fmt(part.rotation.z)}°`);
              }
            };
            if (pos) mutate();
            else anchored(part, seg, mutate);
          }
          if (pos) {
            part.position = { x: round(pos.x), y: round(pos.y), z: round(pos.z) };
            notes.push(`konum ${fmt(pos.x)}, ${fmt(pos.y)}, ${fmt(pos.z)}`);
          }
          touch(part);
          res.messages.push(notes.length ? `'${part.name}': ${notes.join('; ')}.` : `'${part.name}' değişmedi.`);
          break;
        }
        case 'move': {
          const part = must(op.part);
          const [dx, dy, dz] = [Number(op.dx) || 0, Number(op.dy) || 0, Number(op.dz) || 0];
          translate(part, dx, dy, dz);
          touch(part);
          res.messages.push(`'${part.name}' taşındı (Δx ${fmt(dx)}, Δy ${fmt(dy)}, Δz ${fmt(dz)} mm).`);
          break;
        }
        case 'set_position': {
          const part = must(op.part);
          const b = partBox(part, seg);
          const nx = op.x ?? part.position.x;
          const ny = op.y ?? part.position.y;
          const nz = op.z === undefined ? part.position.z : part.position.z + op.z - b.min.z;
          if (![nx, ny, nz].every(Number.isFinite)) throw new OpError('Geçersiz konum.');
          const bottom = b.min.z + nz - part.position.z;
          part.position = { x: round(nx), y: round(ny), z: round(nz) };
          touch(part);
          res.messages.push(`'${part.name}' konumu: X ${fmt(nx)}, Y ${fmt(ny)}, taban Z ${fmt(bottom)} mm.`);
          break;
        }
        case 'rotate': {
          const part = must(op.part);
          const axis: Axis = op.axis;
          if (!['x', 'y', 'z'].includes(axis)) throw new OpError(`Geçersiz eksen: ${String(axis)}`);
          const deg = Number(op.degrees);
          if (!Number.isFinite(deg)) throw new OpError('Geçersiz açı.');
          anchored(part, seg, () => {
            part.rotation = { ...part.rotation, [axis]: normAngle(part.rotation[axis] + deg) };
          });
          touch(part);
          res.messages.push(`'${part.name}' ${axis.toUpperCase()} ekseninde ${fmt(deg)}° döndürüldü.`);
          break;
        }
        case 'scale': {
          const part = must(op.part);
          const f = Number(op.factor);
          if (!(f > 0)) throw new OpError('Ölçek katsayısı pozitif olmalı.');
          const defs = SHAPE_DEFS[part.shape].params;
          // Ölçek parametresi olan şekillerde (extrude/revolve/loft/mesh) tüm geometri onunla büyür.
          const changes: ParamChange[] = defs.some((d) => d.key === 'scale')
            ? [{ name: 'scale', value: f, mode: 'mul' }]
            : defs.filter((d) => d.key !== 'sides').map((d) => ({ name: d.key, value: f, mode: 'mul' }));
          anchored(part, seg, () => applyParamChanges(part, changes));
          touch(part);
          res.messages.push(`'${part.name}' ${fmt(f)} kat ölçeklendi (${describeParams(part)}).`);
          break;
        }
        case 'place_on': {
          const part = must(op.part);
          const target = must(op.target);
          if (part.id === target.id) throw new OpError('Parça kendi üstüne konamaz.');
          placeOn(part, target, seg);
          touch(part);
          res.messages.push(`'${part.name}', '${target.name}' üstüne yerleştirildi.`);
          break;
        }
        case 'place_beside': {
          const part = must(op.part);
          const target = must(op.target);
          if (part.id === target.id) throw new OpError('Parça kendi yanına konamaz.');
          placeBeside(part, target, op.side, Number(op.gap) || 0, seg);
          touch(part);
          res.messages.push(`'${part.name}', '${target.name}' yanına (${op.side}) yerleştirildi.`);
          break;
        }
        case 'place_on_surface': {
          const part = must(op.part);
          const target = must(op.target);
          if (part.id === target.id) throw new OpError('Parça kendi yüzeyine yerleştirilemez.');
          const near = checkVec(op.near, 'yakın nokta (near)');
          if (!near) throw new OpError('Yüzeye yerleştirme için hedefe yakın bir nokta (near) gerekli.');
          const hit = closestOnSurface(target, seg, new THREE.Vector3(near.x, near.y, near.z));
          const off = Number(op.offset) || 0;
          const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
          const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
          part.rotation = { x: normAngle(e.x / DEG), y: normAngle(e.y / DEG), z: normAngle(e.z / DEG) };
          const at = hit.point.clone().addScaledVector(hit.normal, off);
          part.position = { x: round(at.x), y: round(at.y), z: round(at.z) };
          touch(part);
          const nv = hit.normal;
          res.messages.push(
            `'${part.name}', '${target.name}' yüzeyine yerleştirildi (nokta ${fmt(hit.point.x)}, ${fmt(hit.point.y)}, ${fmt(hit.point.z)}; ` +
              `normal ${fmt(nv.x)}, ${fmt(nv.y)}, ${fmt(nv.z)}).`,
          );
          break;
        }
        case 'drop_to_bed': {
          const part = must(op.part);
          const b = partBox(part, seg);
          translate(part, 0, 0, -b.min.z);
          touch(part);
          res.messages.push(`'${part.name}' tablaya indirildi.`);
          break;
        }
        case 'duplicate': {
          const part = must(op.part);
          const copy: Part = structuredClone(part);
          copy.id = newId();
          copy.name = uniqueName(project, op.new_name?.trim() || `${part.name} kopya`);
          const off = checkVec(op.offset, 'kaydırma');
          if (off) translate(copy, off.x, off.y, off.z);
          else {
            const b = partBox(part, seg);
            translate(copy, round(b.max.x - b.min.x + 5), 0, 0);
          }
          project.parts.push(copy);
          touch(copy);
          res.messages.push(`'${part.name}' kopyalandı → '${copy.name}'.`);
          break;
        }
        case 'delete': {
          const part = must(op.part);
          project.parts = project.parts.filter((p) => p.id !== part.id);
          if (ctx.selectedId === part.id) {
            ctx.selectedId = null;
            res.clearSelection = true;
          }
          if (res.lastPartId === part.id) res.lastPartId = null;
          res.messages.push(`'${part.name}' silindi.`);
          break;
        }
        case 'select': {
          const part = must(op.part);
          touch(part);
          res.messages.push(`'${part.name}' seçildi.`);
          break;
        }
        case 'view': {
          if (typeof op.show_names === 'boolean') {
            project.view.showNames = op.show_names;
            res.messages.push(op.show_names ? 'İsimler gösteriliyor.' : 'İsimler gizlendi.');
          }
          if (typeof op.show_dimensions === 'boolean') {
            project.view.showDimensions = op.show_dimensions;
            res.messages.push(op.show_dimensions ? 'Ölçüler gösteriliyor.' : 'Ölçüler gizlendi.');
          }
          if (typeof op.show_holes === 'boolean') {
            project.view.showHoles = op.show_holes;
            res.messages.push(op.show_holes ? 'Delikler gösteriliyor.' : 'Delikler gizlendi (kesmeye devam ederler).');
          }
          break;
        }
        default:
          throw new OpError(`Bilinmeyen işlem: ${String((op as { op: unknown }).op)}`);
      }
    } catch (e) {
      res.errors.push(e instanceof OpError ? e.message : `Hata: ${(e as Error).message}`);
    }
  }
  return res;
}

/** Hedefin (deliksiz) yüzeyinde noktaya en yakın nokta ve oradaki dışa bakan, yumuşak ara değerli normal (dünya). */
export function closestOnSurface(target: Part, seg: number, near: THREE.Vector3): { point: THREE.Vector3; normal: THREE.Vector3 } {
  const g = buildGeometry(target.shape, target.params, seg, target.geom);
  const m = partMatrix(target);
  const nm = new THREE.Matrix3().getNormalMatrix(m);
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const index = g.getIndex();
  const count = index ? index.count : pos.count;
  const vi = (i: number) => (index ? index.getX(i) : i);
  const tri = new THREE.Triangle();
  const p = new THREE.Vector3();
  let best = Infinity;
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3(0, 0, 1);
  const n = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let i = 0; i < count; i += 3) {
    const [a, b, c] = [vi(i), vi(i + 1), vi(i + 2)];
    tri.a.fromBufferAttribute(pos, a).applyMatrix4(m);
    tri.b.fromBufferAttribute(pos, b).applyMatrix4(m);
    tri.c.fromBufferAttribute(pos, c).applyMatrix4(m);
    tri.closestPointToPoint(near, p);
    const d = p.distanceToSquared(near);
    if (d >= best) continue;
    best = d;
    point.copy(p);
    if (nor) {
      [a, b, c].forEach((v, k) => n[k].fromBufferAttribute(nor, v).applyMatrix3(nm).normalize());
      THREE.Triangle.getInterpolation(p, tri.a, tri.b, tri.c, n[0], n[1], n[2], normal);
    } else tri.getNormal(normal);
  }
  g.dispose();
  if (!Number.isFinite(best)) throw new OpError(`'${target.name}' yüzeyi bulunamadı.`);
  return { point, normal: normal.normalize() };
}

function placeOn(part: Part, target: Part, seg: number): void {
  const b = partBox(part, seg);
  const t = partBox(target, seg);
  const bc = b.getCenter(new THREE.Vector3());
  const tc = t.getCenter(new THREE.Vector3());
  translate(part, tc.x - bc.x, tc.y - bc.y, t.max.z - b.min.z);
}

function placeBeside(part: Part, target: Part, side: Side, gapMm: number, seg: number): void {
  const b = partBox(part, seg);
  const t = partBox(target, seg);
  const bc = b.getCenter(new THREE.Vector3());
  const tc = t.getCenter(new THREE.Vector3());
  let dx = tc.x - bc.x;
  let dy = tc.y - bc.y;
  if (side === '+x') dx = t.max.x + gapMm - b.min.x;
  else if (side === '-x') dx = t.min.x - gapMm - b.max.x;
  else if (side === '+y') dy = t.max.y + gapMm - b.min.y;
  else if (side === '-y') dy = t.min.y - gapMm - b.max.y;
  else throw new OpError(`Geçersiz yön: ${String(side)}`);
  translate(part, dx, dy, t.min.z - b.min.z);
}

// ---------------------------------------------------------------------------
// Claude'a gönderilen sahne özeti

const r2 = (n: number) => Number(n.toFixed(2));
const v2 = (v: THREE.Vector3 | Vec3): Vec3 => ({ x: r2(v.x), y: r2(v.y), z: r2(v.z) });

export function sceneSummary(project: Project, selectedId: string | null): SceneSummary {
  const seg = project.settings.resolution;
  return {
    units: 'mm',
    bed: { x: project.settings.bedX, y: project.settings.bedY },
    selected: project.parts.find((p) => p.id === selectedId)?.name ?? null,
    parts: project.parts.map((p) => {
      const b = partBox(p, seg);
      return {
        id: p.id,
        name: p.name,
        shape: p.shape,
        params: Object.fromEntries(Object.entries(p.params).map(([k, v]) => [k, r2(v)])),
        position: v2(p.position),
        rotation: v2(p.rotation),
        color: p.color,
        visible: p.visible,
        bbox: { min: v2(b.min), max: v2(b.max) },
        role: p.role ?? 'solid',
        ...(p.cuts ? { cuts: p.cuts.map((id) => project.parts.find((q) => q.id === id)?.name ?? id) } : {}),
        ...(p.geom ? { geom: p.geom.kind === 'mesh' ? { ...p.geom, triangles: getAsset(p.geom.asset)?.triangles ?? 0 } : p.geom } : {}),
      };
    }),
  };
}

