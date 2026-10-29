// manifold-3d ile boolean (delik) ve kesit işlemleri. WASM bir kez yüklenir (initCsg); yüklenemezse
// uygulama deliksiz çalışmaya devam eder. Manifold nesneleri elle `delete()` edilmelidir.
import Module from 'manifold-3d';
import { MeshoptSimplifier } from 'meshoptimizer';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Pt2 } from '../shared/ops';

let wasm: ManifoldToplevel | null = null;
let loading: Promise<void> | null = null;

/** Tarayıcıda `wasmUrl` (Vite `?url` importu) verilir; Node'da paket kendi dosyasını bulur. */
export function initCsg(wasmUrl?: string): Promise<void> {
  // meshoptimizer da burada hazırlanır: tekne şekli eşzamanlı üretilirken sadeleştirmeye ihtiyaç duyar.
  loading ??= Promise.all([Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined), MeshoptSimplifier.ready]).then(([m]) => {
    m.setup();
    wasm = m;
  });
  return loading;
}

export const csgReady = () => wasm !== null;

export class CsgError extends Error {}

/** BufferGeometry → Manifold (köşeler kaynaklanır; kapalı değilse CsgError). */
function toManifold(g: THREE.BufferGeometry, matrix?: THREE.Matrix4): Manifold {
  if (!wasm) throw new CsgError('Boolean çekirdeği yüklenmedi.');
  const src = new THREE.BufferGeometry();
  src.setAttribute('position', g.getAttribute('position').clone());
  if (g.getIndex()) src.setIndex(g.getIndex()!.clone());
  if (matrix) src.applyMatrix4(matrix);
  // İndisli ağ (üreticiden ya da önceki boolean'dan) olduğu gibi kullanılır: konuma göre birleştirmek, yüzeylerin bir
  // noktada değdiği yerlerdeki ayrı köşeleri çökertip ağı bozar. İndissiz (three.js ilkel) ağlar kaynaklanır.
  const merged = g.getIndex() ? src : mergeVertices(src, 1e-5);
  if (merged !== src) src.dispose();
  const pos = merged.getAttribute('position').array as Float32Array;
  const index = merged.getIndex()!.array;
  const tris: number[] = [];
  for (let i = 0; i < index.length; i += 3) {
    const [a, b, c] = [index[i], index[i + 1], index[i + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: new Float32Array(pos), triVerts: new Uint32Array(tris) });
  merged.dispose();
  mesh.merge();
  try {
    return new wasm.Manifold(mesh);
  } catch {
    throw new CsgError('Ağ kapalı değil (manifold değil); boolean uygulanamadı.');
  }
}

function toGeometry(m: Manifold): THREE.BufferGeometry {
  const mesh = m.getMesh();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties.slice(0, mesh.numVert * mesh.numProp).filter((_, i) => i % mesh.numProp < 3), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1));
  return g;
}

export interface Cutter {
  geometry: THREE.BufferGeometry;
  /** Kesicinin yerel koordinatlarından katının yerel koordinatlarına. */
  matrix: THREE.Matrix4;
}

/** Katıdan kesicileri çıkarır; sonuç katının yerel koordinatlarında indisli ağdır. */
export function subtract(solid: THREE.BufferGeometry, cutters: Cutter[]): THREE.BufferGeometry {
  const keep: Manifold[] = [];
  try {
    const base = toManifold(solid);
    keep.push(base);
    const tools = cutters.map((c) => {
      const m = toManifold(c.geometry, c.matrix);
      keep.push(m);
      return m;
    });
    const union = tools.length === 1 ? tools[0] : wasm!.Manifold.union(tools);
    if (tools.length > 1) keep.push(union);
    const out = base.subtract(union);
    keep.push(out);
    return toGeometry(out);
  } finally {
    for (const m of keep) m.delete();
  }
}

/** Ağın hacmi (mm³); kapalı değilse null. */
export function manifoldVolume(g: THREE.BufferGeometry): number | null {
  if (!wasm) return null;
  let m: Manifold | null = null;
  try {
    m = toManifold(g);
    return m.volume();
  } catch {
    return null;
  } finally {
    m?.delete();
  }
}

/**
 * Dünya koordinatlarındaki ağı `axis = at` düzleminde keser. Dönen çokgenler düzlem koordinatlarındadır:
 * x → [y, z], y → [x, z], z → [x, y].
 */
export function sliceGeometry(g: THREE.BufferGeometry, axis: 'x' | 'y' | 'z', at: number): Pt2[][] {
  return sliceMany(g, axis, [at])[0];
}

/** Aynı ağda birçok kesit: ağ bir kez manifold'a çevrilir (büyük referans ağlarda çok daha hızlı). */
export function sliceMany(g: THREE.BufferGeometry, axis: 'x' | 'y' | 'z', ats: number[]): Pt2[][][] {
  // Kesme ekseni Z'ye gelecek şekilde döndür (det +1): x: (x,y,z)→(y,z,x), y: (x,y,z)→(z,x,y).
  const m = new THREE.Matrix4();
  if (axis === 'x') m.set(0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1);
  else if (axis === 'y') m.set(0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  const man = toManifold(g, m);
  try {
    return ats.map((at) => {
      const cs = man.slice(at);
      try {
        // y'de [z, x] → [x, z] takası aynalama yapar; dış çevre saat yönünün tersi kalsın diye sıra da ters çevrilir.
        return cs.toPolygons().map((poly) => (axis === 'y' ? poly.map(([u, v]) => [v, u] as Pt2).reverse() : poly.map(([u, v]) => [u, v] as Pt2)));
      } finally {
        cs.delete();
      }
    });
  } finally {
    man.delete();
  }
}

/**
 * Örtük yüzeyden kapalı ağ (marching tetrahedra): `sdf` içeride pozitif, dışarıda negatif (yaklaşık mm).
 * `edge` üçgen kenar boyu (çözünürlük), `tolerance` > 0 köşeleri gerçek yüzeye yaklaştırır.
 */
export function levelSetGeometry(
  sdf: (p: [number, number, number]) => number,
  bounds: { min: [number, number, number]; max: [number, number, number] },
  edge: number,
  tolerance = -1,
  simplify = 0,
): THREE.BufferGeometry {
  if (!wasm) throw new CsgError('Boolean çekirdeği yüklenmedi.');
  const man = wasm.Manifold.levelSet((p) => sdf([p[0], p[1], p[2]]), bounds, edge, 0, tolerance);
  // simplify > 0: manifold'un kendi sadeleştirmesi (yüzey < simplify mm oynar, iğne üçgenler temizlenir, kapalı kalır)
  const out = simplify > 0 ? man.simplify(simplify) : man;
  try {
    return toGeometry(out);
  } finally {
    if (out !== man) out.delete();
    man.delete();
  }
}

/**
 * Profilin dışına `width` genişliğinde çerçeve halkası (köşeler gönye). `open` ise son→ilk kenar boyunca çerçeve
 * kesilir (ör. kapı pervazının alt kenarı açık kalır). Dönen çokgenler: dış çevreler saat yönünün tersi, delikler tersi.
 */
export function frameRing(profile: Pt2[], width: number, open: boolean): Pt2[][] {
  if (!wasm) throw new CsgError('Çerçeve için boolean çekirdeği yüklenmedi.');
  const { CrossSection } = wasm;
  const keep: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(x: T) => (keep.push(x), x);
  try {
    const base = track(new CrossSection([profile], 'NonZero'));
    let ring = track(track(base.offset(width, 'Miter', 2)).subtract(base));
    if (open) {
      const a = profile[profile.length - 1];
      const b = profile[0];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const d: Pt2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      let area = 0;
      for (let i = 0; i < profile.length; i++) {
        const [p, q] = [profile[i], profile[(i + 1) % profile.length]];
        area += p[0] * q[1] - q[0] * p[1];
      }
      const n: Pt2 = area > 0 ? [d[1], -d[0]] : [-d[1], d[0]]; // kenarın dış normali
      // Bant tam kenar çizgisinden dışa doğru: pervaz bacakları açıklığın tabanında biter.
      const e = width * 0.01;
      const band: Pt2[] = [
        [a[0] - d[0] * width, a[1] - d[1] * width],
        [b[0] + d[0] * width, b[1] + d[1] * width],
        [b[0] + d[0] * width + n[0] * (width + e), b[1] + d[1] * width + n[1] * (width + e)],
        [a[0] - d[0] * width + n[0] * (width + e), a[1] - d[1] * width + n[1] * (width + e)],
      ];
      ring = track(ring.subtract(track(new CrossSection([band], 'NonZero'))));
    }
    return ring.toPolygons().map((poly) => poly.map(([u, v]) => [u, v] as Pt2));
  } finally {
    for (const x of keep) x.delete();
  }
}

/** Dünya koordinatlarındaki ağların birleşimi (union); tek, kapalı ağ. */
export function unionGeometries(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = geoms.map((g) => toManifold(g));
  try {
    const u = parts.length === 1 ? parts[0] : wasm!.Manifold.union(parts);
    try {
      return toGeometry(u);
    } finally {
      if (parts.length > 1) u.delete();
    }
  } finally {
    for (const m of parts) m.delete();
  }
}

/** Kapalı ağı meshoptimizer (Regularize) ile ~`target` üçgene sadeleştirir; sapma ağ boyutunun %0,2'si ile sınırlı. */
function regularized(m: Manifold, target: number): Manifold {
  const mesh = m.getMesh();
  const pos = mesh.vertProperties.slice(0, mesh.numVert * mesh.numProp).filter((_, i) => i % mesh.numProp < 3);
  if (mesh.numTri <= target) return new wasm!.Manifold(mesh);
  const [idx] = MeshoptSimplifier.simplify(new Uint32Array(mesh.triVerts), pos, 3, target * 3, 0.002, ['Regularize']);
  const out = new wasm!.Mesh({ numProp: 3, vertProperties: pos, triVerts: idx });
  out.merge();
  return new wasm!.Manifold(out);
}

/**
 * Tekne (endaze) gövdesi: örtük yüzey (`sdf`, gövdeyi her yöne biraz taşırır) ile yan profilin (x, z) y boyunca
 * ekstrüzyonunun kesişimi. Küpeşte, taban, ayna ve bodoslama bu kesişimden keskin çıkar (marching tetrahedra keskin
 * kenarı dişli bırakır). `simplify` > 0 ise yüzey en fazla o kadar (mm) oynayarak sadeleştirilir.
 */
export function hullSolid(
  sdf: (p: [number, number, number]) => number,
  bounds: { min: [number, number, number]; max: [number, number, number] },
  edge: number,
  profile: Pt2[],
  halfWidth: number,
  targetTris = 60000,
): THREE.BufferGeometry {
  if (!wasm) throw new CsgError('Tekne şekli için boolean çekirdeği yüklenmedi.');
  const keep: { delete(): void }[] = [];
  const track = <T extends { delete(): void }>(x: T) => (keep.push(x), x);
  try {
    const raw = track(wasm.Manifold.levelSet((p) => sdf([p[0], p[1], p[2]]), bounds, edge, 0, 0.02));
    // Önce örtük gövdeyi düzgün üçgenlerle sadeleştir (iğne üçgen bırakmaz), sonra keskin profille kes: kesişim
    // kenarları tam kalır, yüzeyde gölge/kenar gürültüsü olmaz.
    const body = track(regularized(raw, targetTris));
    const cs = track(new wasm.CrossSection([profile], 'NonZero'));
    // XY'deki (x, z) profili z boyunca uzat, ortala (w ∈ [−hw, hw]), X etrafında 90° çevir: (u, v, w) → (u, −w, v)
    const ext = track(wasm.Manifold.extrude(cs, 2 * halfWidth));
    const env = track(track(ext.translate([0, 0, -halfWidth])).rotate([90, 0, 0]));
    return toGeometry(track(body.intersect(env)));
  } finally {
    for (const x of keep) x.delete();
  }
}
