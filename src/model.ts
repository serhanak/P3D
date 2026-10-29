// Parçanın "son" geometrisi: katılardan kesiştikleri delik parçaları çıkarılmış hâli.
// Görünüm, dışa aktarım ve hacim aynı fonksiyonları kullanır; böylece ekranda görülen = dışa aktarılan.
import * as THREE from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { CsgError, csgReady, manifoldVolume, subtract } from './csg';
import { partBox, partMatrix } from './engine';
import { buildGeomIndexed, creaseFor, geometryVolume } from './geom';
import { SHAPE_DEFS, buildGeometry } from './shapes';
import type { Part, Project } from './types';

export const roleOf = (p: Part) => p.role ?? 'solid';

export function geometryKey(part: Part, seg: number): string {
  return `${part.shape}|${JSON.stringify(part.params)}|${part.geom ? JSON.stringify(part.geom) : ''}|${seg}`;
}

/** Katıyı kesen görünür delik parçaları (sınırlayıcı kutular kesişenler). `view.showHoles` yalnızca görüntüyü etkiler. */
export function holesFor(project: Project, part: Part, boxes?: Map<string, THREE.Box3>): Part[] {
  if (roleOf(part) !== 'solid') return [];
  const seg = project.settings.resolution;
  const box = (p: Part) => boxes?.get(p.id) ?? partBox(p, seg);
  const b = box(part);
  return project.parts.filter(
    (h) => h.visible && roleOf(h) === 'hole' && h.id !== part.id && (!h.cuts || h.cuts.includes(part.id)) && box(h).intersectsBox(b),
  );
}

/** Son geometrinin önbellek anahtarı (parça + onu kesen deliklerin geometri ve konumları). */
export function solidKey(project: Project, part: Part, boxes?: Map<string, THREE.Box3>): string {
  const seg = project.settings.resolution;
  const holes = holesFor(project, part, boxes);
  const own = `${geometryKey(part, seg)}|${roleOf(part)}`;
  if (!holes.length || !csgReady()) return own;
  const rel = holes.map((h) => `${geometryKey(h, seg)}@${relMatrix(part, h).elements.map((v) => v.toFixed(4)).join(',')}`);
  return `${own}#${rel.join(';')}`;
}

/** Deliğin yerel koordinatlarından katının yerel koordinatlarına dönüşüm. */
function relMatrix(solid: Part, hole: Part): THREE.Matrix4 {
  return partMatrix(solid).invert().multiply(partMatrix(hole));
}

/**
 * Kesimsiz, indisli, kapalı ağ (parçanın yerel koordinatlarında): geom şekillerinde üreticinin kendi indisli ağı,
 * three.js ilkellerinde (indissiz) dikiş kopyaları kaynaklanmış görüntü ağı. Boolean girdisi ve dışa aktarım bunu kullanır.
 */
export function baseIndexed(part: Part, seg: number): THREE.BufferGeometry {
  if (part.geom) {
    try {
      return buildGeomIndexed(part.geom, part.params, seg);
    } catch {
      // üretilemeyen geom: görüntüdeki yer tutucuyla aynı küp (aşağıda)
    }
  }
  const g = buildGeometry(part.shape, part.params, seg, part.geom);
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  g.clearGroups();
  const merged = mergeVertices(g, 1e-6);
  g.dispose();
  return merged;
}

interface Cut {
  /** Yerel koordinatlarda indisli ağ (kesildiyse boolean sonucu, değilse kesimsiz ağ). */
  indexed: THREE.BufferGeometry;
  cut: boolean;
  error?: string;
}

function cutIndexed(project: Project, part: Part, boxes?: Map<string, THREE.Box3>): Cut {
  const seg = project.settings.resolution;
  const base = baseIndexed(part, seg);
  const holes = holesFor(project, part, boxes);
  if (!holes.length) return { indexed: base, cut: false };
  if (!csgReady()) return { indexed: base, cut: false, error: 'Boolean çekirdeği yüklenmedi; delikler uygulanmadı.' };
  const cutters = holes.map((h) => ({ geometry: baseIndexed(h, seg), matrix: relMatrix(part, h) }));
  try {
    const out = subtract(base, cutters);
    base.dispose();
    return { indexed: out, cut: true };
  } catch (e) {
    return { indexed: base, cut: false, error: e instanceof CsgError ? e.message : `Boolean hatası: ${(e as Error).message}` };
  } finally {
    for (const c of cutters) c.geometry.dispose();
  }
}

/** Dışa aktarım ve hacim için son geometri: yerel koordinatlarda indisli, kapalı ağ (yeni nesne). */
export function exportGeometry(project: Project, part: Part): THREE.BufferGeometry {
  return cutIndexed(project, part).indexed;
}

export interface SolidGeometry {
  /** Parçanın yerel koordinatlarında, normalleri hesaplanmış ağ. */
  geometry: THREE.BufferGeometry;
  /** Delik uygulandıysa true. */
  cut: boolean;
  error?: string;
}

/** Görünüm için son geometri, normalleriyle (yeni nesne; çağıran dispose eder). */
export function solidGeometry(project: Project, part: Part, boxes?: Map<string, THREE.Box3>): SolidGeometry {
  const seg = project.settings.resolution;
  if (!holesFor(project, part, boxes).length) return { geometry: buildGeometry(part.shape, part.params, seg, part.geom), cut: false };
  const r = cutIndexed(project, part, boxes);
  if (!r.cut) {
    r.indexed.dispose();
    return { geometry: buildGeometry(part.shape, part.params, seg, part.geom), cut: false, error: r.error };
  }
  // Kesimsiz şekillerle aynı gölgeleme: eşik üstü kırılımlar keskin, gerisi yumuşak (düz gölgeleme kumlanma yapar).
  const display = toCreasedNormals(r.indexed, creaseFor(part.shape));
  r.indexed.dispose();
  return { geometry: display, cut: true };
}

const volumeCache = new Map<string, number>();

/** Son geometrinin hacmi (mm³): delik yoksa analitik ya da ağ hacmi, varsa boolean sonucu. */
export function solidVolume(project: Project, part: Part): number {
  const seg = project.settings.resolution;
  const key = solidKey(project, part);
  const hit = volumeCache.get(key);
  if (hit !== undefined) return hit;
  const def = SHAPE_DEFS[part.shape];
  let v: number;
  if (!key.includes('#') && def.volume) v = def.volume(part.params);
  else {
    const geometry = key.includes('#') ? exportGeometry(project, part) : baseIndexed(part, seg);
    v = manifoldVolume(geometry) ?? Math.abs(geometryVolume(geometry));
    geometry.dispose();
  }
  if (volumeCache.size > 500) volumeCache.clear();
  volumeCache.set(key, v);
  return v;
}

/** Dışa aktarılacak parçalar: görünür katılar. */
export function exportableParts(parts: Part[]): Part[] {
  return parts.filter((p) => p.visible && roleOf(p) === 'solid');
}
