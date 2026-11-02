import * as THREE from 'three';
import { ROLES, isGeomShape, type Axis, type GroupDef, type LoftGeom, type Op, type ParamChange, type Pt2, type Role, type SceneSummary, type Side, type Vec3 } from '../shared/ops';
import { decodedAsset, getAsset, makeAsset, newAssetId, registerAsset } from './assets';
import { resolveColor } from './colors';
import { GeomError, defaultGeom, describeGeom, geometryVolume, loftCommonSections, meshSource, sanitizeGeom } from './geom';
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

/** Kesin eşleşme: `$last` / `$selected`, kimlik ya da tam ad (büyük/küçük harf ve aksan duyarsız). */
export function findPartExact(project: Project, ref: string | undefined, ctx: RefContext): Part | undefined {
  if (!ref) return undefined;
  const byId = (id: string | null) => (id ? project.parts.find((p) => p.id === id) : undefined);
  if (ref === '$last') return byId(ctx.lastPartId);
  if (ref === '$selected') return byId(ctx.selectedId);
  const direct = byId(ref);
  if (direct) return direct;
  const f = fold(ref).trim();
  const exact = project.parts.filter((p) => fold(p.name).trim() === f);
  return exact.length ? exact[exact.length - 1] : undefined;
}

export function findPart(project: Project, ref: string | undefined, ctx: RefContext): Part | undefined {
  if (!ref) return undefined;
  const exact = findPartExact(project, ref, ctx);
  if (exact || ref === '$last' || ref === '$selected') return exact;
  const f = fold(ref).trim();
  const prefix = project.parts.filter((p) => fold(p.name).startsWith(f));
  if (prefix.length === 1) return prefix[0];
  const contains = project.parts.filter((p) => fold(p.name).includes(f));
  if (contains.length === 1) return contains[0];
  return undefined;
}

function partNameTaken(project: Project, name: string, exceptId?: string): boolean {
  const f = fold(name).trim();
  return project.parts.some((p) => p.id !== exceptId && fold(p.name).trim() === f);
}

/**
 * Ad bir parça ya da grup tarafından kullanılıyor mu. Parça ve grup adları tek ad alanıdır: işlemler adla çözülür ve
 * aynı adda parça varken grup adla yönetilemez.
 */
function nameTaken(project: Project, name: string, exceptId?: string): boolean {
  return partNameTaken(project, name, exceptId) || !!findGroup(project, name);
}

/** Benzersiz parça adı: başka bir parça ya da grup bu adı kullanıyorsa sonuna sayı eklenir. */
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

/**
 * Kullanıcının açıkça verdiği parça adı: bir grubun adıysa hata (grup artık adla yönetilemezdi); başka bir parçanın
 * adıysa eskisi gibi sonuna sayı eklenir.
 */
function explicitPartName(project: Project, name: string, exceptId?: string): string {
  const g = findGroup(project, name);
  if (g) throw new OpError(`'${g.name}' bir grubun adı; parçaya başka bir ad verin (parça ve grup adları aynı olamaz).`);
  return uniqueName(project, name, exceptId);
}

export function newId(): string {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Gruplar

/** Grubu adıyla bulur (büyük/küçük harf ve aksan duyarsız, tam ad). */
export function findGroup(project: Project, ref: string | undefined): GroupDef | undefined {
  if (!ref || !project.groups) return undefined;
  const f = fold(ref).trim();
  return project.groups.find((g) => fold(g.name).trim() === f);
}

export function groupMembers(project: Project, name: string): Part[] {
  return project.parts.filter((p) => p.group === name);
}

/** Ne bir grubun ne de bir parçanın kullandığı ad. */
function uniqueGroupName(project: Project, base: string): string {
  const clean = base.trim();
  if (!nameTaken(project, clean)) return clean;
  for (let n = 2; ; n++) if (!nameTaken(project, `${clean} ${n}`)) return `${clean} ${n}`;
}

/** Üyesi kalmayan grupları ve var olmayan gruba işaret eden üyelikleri temizler; grup kalmazsa alan silinir. */
function pruneGroups(project: Project): void {
  if (project.groups) {
    project.groups = project.groups.filter((g) => project.parts.some((p) => p.group === g.name));
    if (!project.groups.length) delete project.groups;
  }
  const names = new Set(project.groups?.map((g) => g.name));
  for (const p of project.parts) if (p.group !== undefined && !names.has(p.group)) delete p.group;
}

/** Kopya/ayna grubunda üye adı: yeni grup adı açıkça verildiyse ve üye adı eski grup adıyla başlıyorsa önek değişir. */
function memberName(name: string, oldGroup: string, newGroup: string, explicit: boolean, suffix: string): string {
  if (explicit && name.startsWith(oldGroup) && newGroup !== oldGroup) return newGroup + name.slice(oldGroup.length);
  return `${name} ${suffix}`;
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
  return Number(n.toFixed(3)) + 0; // + 0: -0 yerine 0
}

const roundVec = (v: Vec3 | THREE.Vector3): Vec3 => ({ x: round(v.x), y: round(v.y), z: round(v.z) });

const AXIS_VEC: Record<Axis, THREE.Vector3> = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

const eulerQuat = (r: Vec3) => new THREE.Quaternion().setFromEuler(new THREE.Euler(r.x * DEG, r.y * DEG, r.z * DEG, 'XYZ'));

function setRotationFrom(part: Part, e: THREE.Euler): void {
  part.rotation = { x: normAngle(e.x / DEG), y: normAngle(e.y / DEG), z: normAngle(e.z / DEG) };
}

/** Parçayı `pivot` etrafında `q` kadar döndürür: konum ve döndürme birlikte (grup döndürme). */
function rotateAbout(part: Part, q: THREE.Quaternion, pivot: Vec3): void {
  const pv = new THREE.Vector3(pivot.x, pivot.y, pivot.z);
  const pos = new THREE.Vector3(part.position.x, part.position.y, part.position.z).sub(pv).applyQuaternion(q).add(pv);
  setRotationFrom(part, new THREE.Euler().setFromQuaternion(q.clone().multiply(eulerQuat(part.rotation)), 'XYZ'));
  part.position = roundVec(pos);
}

// ---------------------------------------------------------------------------
// Ayna: dünya yansıması M, parça döndürmesi R, yerel yansıma L (det −1) → R' = M·R·L (öz döndürme), p' = M(p), G' = L·G.

const neg = (v: number) => (v === 0 ? 0 : -v);
const reflectMatrix = (a: Axis) => new THREE.Matrix4().makeScale(a === 'x' ? -1 : 1, a === 'y' ? -1 : 1, a === 'z' ? -1 : 1);

export function mirrorVec(v: Vec3, plane: Axis, at: number): Vec3 {
  return roundVec({ ...v, [plane]: 2 * at - v[plane] });
}

/** extrude/loft/revolve kanonik eksenlerinin yereldeki karşılığı: profil [u, v], eksen w (bkz. geom.ts → mapAxis). */
const U_AXIS = (axis: Axis): Axis => (axis === 'x' ? 'y' : 'x');
const V_AXIS = (axis: Axis): Axis => (axis === 'z' ? 'y' : 'z');

/** Kapalı çokgeni u'da (k = 0) ya da v'de (k = 1) aynalar; sıra ters çevrilir ki yön (ve son→ilk kenar) korunsun. */
const mirrorLoop = (pts: Pt2[], k: 0 | 1): Pt2[] => pts.map(([u, v]) => (k === 0 ? [neg(u), v] : [u, neg(v)]) as Pt2).reverse();

/** Aynalanmış ağ varlığı (bir koordinat negatif, sarım ters). Aynanın aynası asıl ağdır; aynı ayna bir kez üretilir. */
function mirroredAsset(id: string, axis: Axis): string {
  const suffix = `_m${axis}`;
  const back = id.endsWith(suffix) ? id.slice(0, -suffix.length) : '';
  if (back && getAsset(back)) return back;
  const mid = id.length + suffix.length <= 40 ? id + suffix : newAssetId();
  if (getAsset(mid)) return mid;
  const src = decodedAsset(id);
  const meta = getAsset(id);
  if (!src || !meta) throw new OpError('ağ verisi yüklü değil (yer tutucu küp); aynalanamaz.');
  const k = { x: 0, y: 1, z: 2 }[axis];
  const pos = src.positions.slice();
  for (let i = k; i < pos.length; i += 3) pos[i] = -pos[i];
  const idx = src.indices.slice();
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
  registerAsset(makeAsset(`${meta.name} ayna`, pos, idx, mid));
  return mid;
}

/**
 * Yerel yansıma (L) adayları, tercih sırasıyla: geometrinin bu eksende simetrik olduğu (G' = G) ya da geometrisi
 * aynalanabilen (extrude/loft profili, mesh ağı) eksenler. Yalnızca her çözünürlükte (tek segment sayısı dahil) geçerli
 * simetriler: silindir/koni/prizma köşeleri x → −x'e göre simetrik (prizmada ilk kenar −Y'de düz), küre (kutuplar yerel
 * y'de) ve torus y → −y ile z → −z'ye göre; x yansıması onlarda yalnızca çift segmentte geçerli olduğundan aday değil.
 */
function mirrorAxes(part: Part): Axis[] {
  const g = part.geom;
  switch (part.shape) {
    case 'box':
    case 'tube': // yay noktası sayısı her zaman çift
      return ['x', 'y', 'z'];
    case 'cylinder':
    case 'prism':
      return ['x', 'z'];
    case 'cone':
      return ['x'];
    case 'sphere':
    case 'torus':
      return ['y', 'z'];
    case 'hull':
      return ['y'];
    case 'mesh':
      return ['x', 'y', 'z'];
    case 'revolve': // döndürme ekseninin içinden geçen düzlem
      return g?.kind === 'revolve' ? [V_AXIS(g.axis)] : [];
    case 'extrude': // eksen boyunca merkezli (w simetrik) ya da profil aynalanır
      return g?.kind === 'extrude' ? [g.axis, U_AXIS(g.axis), V_AXIS(g.axis)] : [];
    case 'loft': // kesitler u'da aynalanır (alttan başlama düzeni v'ye bağlı olduğundan v değil)
      return g?.kind === 'loft' ? [U_AXIS(g.axis)] : [];
  }
}

/** Geometriyi yerel `axis` yansımasıyla değiştirir (G' = L·G); simetrik eksende değişiklik yok. */
function mirrorGeom(part: Part, axis: Axis): void {
  const g = part.geom;
  if (g?.kind === 'extrude' && axis !== g.axis) {
    const k = axis === U_AXIS(g.axis) ? 0 : 1;
    g.profile = mirrorLoop(g.profile, k);
    if (g.holes) g.holes = g.holes.map((h) => mirrorLoop(h, k));
  } else if (g?.kind === 'loft') {
    // Farklı nokta sayılı kesitler önce ağ üretiminin kullandığı ortak sayıya örneklenir (ağ değişmez): örneklemenin
    // başlangıcı (alttaki nokta, eşitlikte ortaya en yakın) aynalanan kesitte simetrik seçilmeyebilir.
    const src = loftCommonSections(g);
    // Başlangıç noktası korunur (kesitler arası eşleşme ve "alttan başla" düzeni): [p0, p(n−1), …, p1]. Dolaşım yönü
    // ters döndüğü için yan dörtgenler öbür köşegenden bölünmeli (mirrored); aynanın aynasında işaret kalkar.
    const out: LoftGeom = {
      ...src,
      sections: src.sections.map((s) => {
        const m = s.points.map(([u, v]) => [neg(u), v] as Pt2);
        return { ...s, points: m.length === 1 ? m : [m[0], ...m.slice(1).reverse()] };
      }),
    };
    if (src.sharp) {
      const n = out.sections.find((s) => s.points.length > 1)!.points.length;
      out.sharp = src.sharp.map((k) => (n - k) % n).sort((a, b) => a - b);
    }
    if (src.mirrored) delete out.mirrored;
    else out.mirrored = true;
    try {
      part.geom = sanitizeGeom('loft', out);
    } catch (e) {
      if (!(e instanceof GeomError)) throw e;
      const hint = src === g ? '' : ' (farklı nokta sayılı kesitler ortak sayıya örneklenirken bozuldu; kesitleri aynı nokta sayısıyla verin)';
      throw new OpError(`'${part.name}' loft'u aynalanamadı${hint}: ${e.message}`);
    }
  } else if (g?.kind === 'mesh') {
    part.geom = { kind: 'mesh', asset: mirroredAsset(g.asset, axis) };
  }
}

/**
 * Parçayı (yerinde) dünya düzlemine göre aynalar: `plane` eksenine dik, `at` konumundaki düzlem. L, aday eksenlerden
 * düzlem normaline (yerelde) en yakın olanıdır: döndürülmemiş parçada L = M ve döndürme değişmez.
 */
function mirrorPart(part: Part, plane: Axis, at: number): void {
  const axes = mirrorAxes(part);
  if (!axes.length) throw new OpError(`${SHAPE_DEFS[part.shape].label} '${part.name}' aynalanamaz (geometri eksik).`);
  const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(part.rotation.x * DEG, part.rotation.y * DEG, part.rotation.z * DEG, 'XYZ'));
  const nl = AXIS_VEC[plane].clone().transformDirection(R.clone().transpose());
  const L = axes.reduce((best, a) => (Math.abs(nl[a]) > Math.abs(nl[best]) + 1e-9 ? a : best), axes[0]);
  mirrorGeom(part, L);
  const Rn = reflectMatrix(plane).multiply(R).multiply(reflectMatrix(L));
  setRotationFrom(part, new THREE.Euler().setFromRotationMatrix(Rn, 'XYZ'));
  part.position = mirrorVec(part.position, plane, at);
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
    // Tam ad önce parçada, sonra grupta aranır; ancak ikisi de yoksa kısmi ad eşleşmesine bakılır.
    const p = findPartExact(project, ref, ctx) ?? (findGroup(project, ref) ? undefined : findPart(project, ref, ctx));
    if (!p) {
      if (!ref || ref === '$selected') throw new OpError('Hangi parça? Bir parça adı yazın ya da listeden seçin.');
      const g = findGroup(project, ref);
      if (g) {
        throw new OpError(
          `'${g.name}' bir grup; bu işlem gruplara uygulanmaz (gruplarda: move, rotate, duplicate, mirror, delete, update ile renk/görünürlük).`,
        );
      }
      throw new OpError(`'${ref}' adında parça bulunamadı.`);
    }
    return p;
  };
  /** Parça ya da (o adda parça yoksa) grup. */
  const target = (ref: string | undefined): { part: Part; group?: undefined; members?: undefined } | { part?: undefined; group: GroupDef; members: Part[] } => {
    const exact = findPartExact(project, ref, ctx);
    if (exact) return { part: exact };
    const g = findGroup(project, ref);
    if (g) return { group: g, members: groupMembers(project, g.name) };
    return { part: must(ref) };
  };
  const touch = (p: Part | undefined) => {
    if (!p) return;
    ctx.lastPartId = p.id;
    res.lastPartId = p.id;
  };
  const names = (parts: Part[]) => parts.map((p) => `'${p.name}'`).join(', ');
  /**
   * Grubu yeni adla kopyalar: üyeler klonlanır, `xform` her kopyaya uygulanır (hata verirse proje değişmez), delik
   * hedefleri (cuts) grup içindeyse kopyalara yönlenir. Dönen: yeni grup.
   */
  const cloneGroup = (src: GroupDef, members: Part[], base: string, explicit: boolean, suffix: string, pivot: Vec3, xform: (c: Part) => void): GroupDef => {
    const idMap = new Map<string, string>();
    const copies = members.map((m) => {
      const c: Part = structuredClone(m);
      c.id = newId();
      idMap.set(m.id, c.id);
      xform(c);
      return c;
    });
    const name = uniqueGroupName(project, base);
    // Grup önce kaydedilir: üye adları yeni grup adıyla da çakışmasın (uniqueName grup adlarını sayar).
    const g: GroupDef = { name, pivot: roundVec(pivot) };
    (project.groups ??= []).push(g);
    copies.forEach((c, i) => {
      c.name = uniqueName(project, memberName(members[i].name, src.name, name, explicit, suffix));
      c.group = name;
      if (c.cuts) c.cuts = c.cuts.map((id) => idMap.get(id) ?? id);
      project.parts.push(c);
    });
    touch(copies[copies.length - 1]);
    return g;
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
            name: op.name?.trim() ? explicitPartName(project, op.name) : defaultName(project, def.label),
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
            name: op.name?.trim() ? explicitPartName(project, op.name) : uniqueName(project, asset.name || 'Mesh'),
            shape: 'mesh',
            params: defaultParams('mesh'),
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            color: colorOf(op.color) ?? PALETTE[project.parts.length % PALETTE.length],
            visible: true,
            geom: { kind: 'mesh', asset: asset.id, ...meshSource(op) },
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
          const t = target(op.part);
          if (t.group) {
            if (op.name?.trim() || op.params?.length || op.position || op.rotation || op.geom || op.role || op.cuts?.length) {
              throw new OpError(
                `'${t.group.name}' bir grup: grupta yalnızca renk ve görünürlük değiştirilebilir (taşımak/döndürmek için move/rotate; ölçü ve ad için üyeleri tek tek düzenleyin).`,
              );
            }
            const color = colorOf(op.color);
            const notes: string[] = [];
            for (const m of t.members) {
              if (color) m.color = color;
              if (typeof op.visible === 'boolean') m.visible = op.visible;
            }
            if (color) notes.push(`renk ${color}`);
            if (typeof op.visible === 'boolean') notes.push(op.visible ? 'gösterildi' : 'gizlendi');
            touch(t.members[t.members.length - 1]);
            res.messages.push(notes.length ? `'${t.group.name}' grubu (${t.members.length} parça): ${notes.join('; ')}.` : `'${t.group.name}' grubu değişmedi.`);
            break;
          }
          const part = t.part;
          const notes: string[] = [];
          if (op.name?.trim()) {
            const nn = explicitPartName(project, op.name, part.id);
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
          const t = target(op.part);
          const [dx, dy, dz] = [Number(op.dx) || 0, Number(op.dy) || 0, Number(op.dz) || 0];
          if (t.group) {
            for (const m of t.members) translate(m, dx, dy, dz);
            const pv = t.group.pivot;
            t.group.pivot = roundVec({ x: pv.x + dx, y: pv.y + dy, z: pv.z + dz });
            touch(t.members[t.members.length - 1]);
            res.messages.push(`'${t.group.name}' grubu taşındı (${t.members.length} parça; Δx ${fmt(dx)}, Δy ${fmt(dy)}, Δz ${fmt(dz)} mm).`);
            break;
          }
          const part = t.part;
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
          const t = target(op.part);
          const axis: Axis = op.axis;
          if (!['x', 'y', 'z'].includes(axis)) throw new OpError(`Geçersiz eksen: ${String(axis)}`);
          const deg = Number(op.degrees);
          if (!Number.isFinite(deg)) throw new OpError('Geçersiz açı.');
          if (t.group) {
            // Grup pivotu etrafında döner (taban sabitlenmez): teker göbeği gibi.
            const q = new THREE.Quaternion().setFromAxisAngle(AXIS_VEC[axis], deg * DEG);
            for (const m of t.members) rotateAbout(m, q, t.group.pivot);
            touch(t.members[t.members.length - 1]);
            const pv = t.group.pivot;
            res.messages.push(`'${t.group.name}' grubu pivot (${fmt(pv.x)}, ${fmt(pv.y)}, ${fmt(pv.z)}) etrafında ${axis.toUpperCase()} ekseninde ${fmt(deg)}° döndürüldü.`);
            break;
          }
          const part = t.part;
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
          const t = target(op.part);
          const count = countOf(op.count);
          const off = checkVec(op.offset, 'kaydırma');
          if (count > 1 && !off) throw new OpError(`${count} kopya için kaydırma (offset) gerekli: her kopya bir öncekinden bu kadar kayar.`);
          const given = op.new_name?.trim() ?? '';
          const nameFor = (base: string, i: number) => (given ? (count > 1 ? `${given} ${i}` : given) : base);
          if (t.group) {
            const box = partsBox(t.members, seg);
            const step = off ?? { x: round(box.max.x - box.min.x + 5), y: 0, z: 0 };
            const made: string[] = [];
            for (let i = 1; i <= count; i++) {
              const [dx, dy, dz] = [step.x * i, step.y * i, step.z * i];
              const pv = t.group.pivot;
              const g = cloneGroup(t.group, t.members, nameFor(`${t.group.name} kopya`, i), !!given, 'kopya', { x: pv.x + dx, y: pv.y + dy, z: pv.z + dz }, (c) =>
                translate(c, dx, dy, dz),
              );
              made.push(`'${g.name}'`);
            }
            res.messages.push(`'${t.group.name}' grubu (${t.members.length} parça) kopyalandı → ${made.join(', ')}.`);
            break;
          }
          const part = t.part;
          const step = off ?? (() => {
            const b = partBox(part, seg);
            return { x: round(b.max.x - b.min.x + 5), y: 0, z: 0 };
          })();
          // Verilen ad bir grubun adıysa hiç kopya eklenmeden hata (yarım işlem kalmasın).
          if (given) for (let i = 1; i <= count; i++) explicitPartName(project, nameFor('', i));
          const copies: Part[] = [];
          for (let i = 1; i <= count; i++) {
            const copy: Part = structuredClone(part); // grup üyeliği korunur (kopya aynı grupta)
            copy.id = newId();
            copy.name = given ? explicitPartName(project, nameFor('', i)) : uniqueName(project, `${part.name} kopya`);
            translate(copy, step.x * i, step.y * i, step.z * i);
            project.parts.push(copy);
            copies.push(copy);
            touch(copy);
          }
          res.messages.push(count > 1 ? `'${part.name}' ${count} kez kopyalandı → ${names(copies)}.` : `'${part.name}' kopyalandı → '${copies[0].name}'.`);
          break;
        }
        case 'group': {
          const name = (op.name ?? '').trim();
          if (!name) throw new OpError('Grup adı (name) gerekli.');
          if (partNameTaken(project, name)) throw new OpError(`'${name}' adında bir parça var; gruba başka bir ad verin.`);
          let g = findGroup(project, name);
          const refs = (op.parts ?? []).filter((r) => typeof r === 'string' && r.trim());
          if (!g && !refs.length) throw new OpError(`Yeni grup '${name}' için üye parçalar (parts) gerekli.`);
          const gname = g?.name ?? name;
          let members = g ? groupMembers(project, gname) : [];
          const notes: string[] = [];
          if (refs.length) {
            const list: Part[] = [];
            for (const r of refs) {
              const p = must(r);
              if (!list.includes(p)) list.push(p);
            }
            for (const p of members) if (!list.includes(p)) delete p.group;
            for (const p of list) {
              if (p.group && p.group !== gname) notes.push(`'${p.name}' '${p.group}' grubundan alındı`);
              p.group = gname;
            }
            members = list;
          }
          const pivot = checkVec(op.pivot, 'pivot');
          if (!g) {
            g = { name, pivot: roundVec(pivot ?? partsBox(members, seg).getCenter(new THREE.Vector3())) };
            (project.groups ??= []).push(g);
          } else if (pivot) g.pivot = roundVec(pivot);
          touch(members[members.length - 1]);
          const pv = g.pivot;
          res.messages.push(
            `'${g.name}' grubu: ${names(members)}; pivot ${fmt(pv.x)}, ${fmt(pv.y)}, ${fmt(pv.z)}${notes.length ? ` (${notes.join(', ')})` : ''}.`,
          );
          break;
        }
        case 'ungroup': {
          const g = findGroup(project, op.name);
          if (!g) throw new OpError(`'${op.name ?? ''}' adında grup bulunamadı.`);
          const members = groupMembers(project, g.name);
          for (const p of members) delete p.group;
          project.groups = project.groups!.filter((x) => x !== g);
          touch(members[members.length - 1]);
          res.messages.push(`'${g.name}' grubu çözüldü (${members.length} parça serbest).`);
          break;
        }
        case 'set_pivot': {
          const g = findGroup(project, op.group);
          if (!g) throw new OpError(`'${op.group ?? ''}' adında grup bulunamadı.`);
          const pv = checkVec(op.pivot, 'pivot');
          if (!pv) throw new OpError('Pivot (x, y, z) gerekli.');
          g.pivot = roundVec(pv);
          touch(groupMembers(project, g.name).pop());
          res.messages.push(`'${g.name}' grubunun pivotu: ${fmt(g.pivot.x)}, ${fmt(g.pivot.y)}, ${fmt(g.pivot.z)}.`);
          break;
        }
        case 'mirror': {
          const t = target(op.part);
          const plane: Axis = op.plane;
          if (!['x', 'y', 'z'].includes(plane)) throw new OpError(`Geçersiz ayna düzlemi: ${String(plane)} (x, y ya da z: düzlem bu eksene diktir).`);
          const at = op.at === undefined || op.at === null ? 0 : Number(op.at);
          if (!Number.isFinite(at)) throw new OpError('Geçersiz ayna düzlemi konumu (at).');
          const where = `${plane.toUpperCase()} = ${fmt(at)} düzlemine göre`;
          const given = op.name?.trim() ?? '';
          if (t.group) {
            const g = cloneGroup(t.group, t.members, given || `${t.group.name} ayna`, !!given, 'ayna', mirrorVec(t.group.pivot, plane, at), (c) => {
              try {
                mirrorPart(c, plane, at);
              } catch (e) {
                throw e instanceof OpError ? new OpError(`'${c.name}': ${e.message}`) : e;
              }
            });
            res.messages.push(`'${t.group.name}' grubu ${where} aynalandı → '${g.name}' (${t.members.length} parça).`);
            break;
          }
          const part = t.part;
          const copyName = given ? explicitPartName(project, given) : uniqueName(project, `${part.name} ayna`);
          const copy: Part = structuredClone(part);
          copy.id = newId();
          delete copy.group; // aynalanan kopya (ör. sağ taraf) özgün grubun parçası değildir
          mirrorPart(copy, plane, at);
          copy.name = copyName;
          project.parts.push(copy);
          touch(copy);
          res.messages.push(`'${part.name}' ${where} aynalandı → '${copy.name}'.`);
          break;
        }
        case 'delete': {
          const t = target(op.part);
          if (t.group) {
            const ids = new Set(t.members.map((m) => m.id));
            project.parts = project.parts.filter((p) => !ids.has(p.id));
            project.groups = project.groups!.filter((x) => x !== t.group);
            if (ctx.selectedId && ids.has(ctx.selectedId)) {
              ctx.selectedId = null;
              res.clearSelection = true;
            }
            if (res.lastPartId && ids.has(res.lastPartId)) res.lastPartId = null;
            res.messages.push(`'${t.group.name}' grubu ve ${t.members.length} parçası silindi.`);
            break;
          }
          const part = t.part;
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
  // Silinen/başka gruba alınan üyeler: boş grup kalmaz, olmayan gruba üyelik kalmaz.
  pruneGroups(project);
  return res;
}

/** Kopya sayısı: yok / 0 / 1 = tek kopya. */
function countOf(v: unknown): number {
  if (v === undefined || v === null) return 1;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new OpError(`Geçersiz kopya sayısı (count): ${String(v)}; 1 ya da daha büyük bir tam sayı olmalı.`);
  if (n > 100) throw new OpError('En fazla 100 kopya (count).');
  return Math.max(1, n);
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
        ...(p.group ? { group: p.group } : {}),
        ...(p.geom ? { geom: p.geom.kind === 'mesh' ? { ...p.geom, triangles: getAsset(p.geom.asset)?.triangles ?? 0 } : p.geom } : {}),
      };
    }),
    ...(project.groups?.length ? { groups: project.groups.map((g) => ({ name: g.name, pivot: v2(g.pivot) })) } : {}),
  };
}

