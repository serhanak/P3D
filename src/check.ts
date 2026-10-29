// Model denetimi: ekranda titreşen çakışık yüzeyler (z-fighting), baskıyı zorlaştıran durumlar, boolean hataları.
// Yapay zekâ doğrulama döngüsünde `npm run -s p3d -- check` ile çalışır; Node ve tarayıcıda aynı kod.
import * as THREE from 'three';
import { partBox } from './engine';
import { worldMesh } from './io';
import { exportableParts, holesFor, roleOf, solidGeometry } from './model';
import type { Part, Project } from './types';

export interface CheckIssue {
  level: 'hata' | 'uyarı';
  message: string;
}

/** FDM için alt sınır (0.4 mm nozül ≈ iki çizgi). */
const MIN_WALL = 0.8;

type V2 = [number, number];

/** İki üçgenin 2B kesişimi (ayırıcı eksen testi; kenar teması kesişim sayılmaz). */
function trianglesOverlap(a: V2[], b: V2[]): boolean {
  for (const tri of [a, b]) {
    for (let i = 0; i < 3; i++) {
      const [p, q] = [tri[i], tri[(i + 1) % 3]];
      const n: V2 = [q[1] - p[1], p[0] - q[0]];
      const proj = (t: V2[]) => t.map((v) => v[0] * n[0] + v[1] * n[1]);
      const [pa, pb] = [proj(a), proj(b)];
      const eps = 1e-6 * (Math.abs(n[0]) + Math.abs(n[1]));
      if (Math.max(...pa) <= Math.min(...pb) + eps || Math.max(...pb) <= Math.min(...pa) + eps) return false;
    }
  }
  return true;
}

interface PlaneTri {
  part: string;
  pts: V2[];
  area: number;
}

/** Aynı düzlemde, aynı yöne bakan, üst üste binen yüzeyler: farklı parçalar arasında z-fighting. */
function coplanarOverlaps(project: Project, solids: Part[]): CheckIssue[] {
  const buckets = new Map<string, PlaneTri[]>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const part of solids) {
    const m = worldMesh(project, part);
    for (let i = 0; i < m.tris.length; i += 3) {
      a.fromArray(m.pos, m.tris[i] * 3);
      b.fromArray(m.pos, m.tris[i + 1] * 3);
      c.fromArray(m.pos, m.tris[i + 2] * 3);
      n.subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const area = n.length() / 2;
      if (area < 1e-3) continue;
      n.normalize();
      const d = n.dot(a);
      const key = `${Math.round(n.x * 200)},${Math.round(n.y * 200)},${Math.round(n.z * 200)}|${Math.round(d * 50)}`;
      // Düzleme izdüşüm: normalin en büyük bileşeni atılır.
      const drop = Math.abs(n.x) > Math.abs(n.y) ? (Math.abs(n.x) > Math.abs(n.z) ? 0 : 2) : Math.abs(n.y) > Math.abs(n.z) ? 1 : 2;
      const to2 = (v: THREE.Vector3): V2 => (drop === 0 ? [v.y, v.z] : drop === 1 ? [v.x, v.z] : [v.x, v.y]);
      let list = buckets.get(key);
      if (!list) buckets.set(key, (list = []));
      list.push({ part: part.id, pts: [to2(a), to2(b), to2(c)], area });
    }
  }
  const pairs = new Map<string, { area: number; normal: string; d: string }>();
  for (const [key, list] of buckets) {
    const owners = new Set(list.map((t) => t.part));
    if (owners.size < 2) continue;
    const byPart = new Map<string, PlaneTri[]>();
    for (const t of list) (byPart.get(t.part) ?? byPart.set(t.part, []).get(t.part)!).push(t);
    const ids = [...byPart.keys()];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        let overlap = 0;
        let checks = 0;
        outer: for (const ta of byPart.get(ids[i])!) {
          for (const tb of byPart.get(ids[j])!) {
            if (++checks > 200000) break outer;
            if (trianglesOverlap(ta.pts, tb.pts)) overlap += Math.min(ta.area, tb.area);
          }
        }
        if (overlap < 0.01) continue;
        const pk = [ids[i], ids[j]].sort().join('|');
        const [nx, ny, nz, d] = key.split(/[,|]/).map(Number);
        const prev = pairs.get(pk);
        if (!prev || prev.area < overlap) {
          pairs.set(pk, { area: (prev?.area ?? 0) + overlap, normal: `${(nx / 200).toFixed(2)}, ${(ny / 200).toFixed(2)}, ${(nz / 200).toFixed(2)}`, d: (d / 50).toFixed(2) });
        } else prev.area += overlap;
      }
    }
  }
  const name = (id: string) => project.parts.find((p) => p.id === id)?.name ?? id;
  return [...pairs].map(([pk, v]) => {
    const [x, y] = pk.split('|');
    return {
      level: 'hata' as const,
      message:
        `'${name(x)}' ile '${name(y)}' aynı düzlemde üst üste yüzeylere sahip (normal ${v.normal}, düzlem ${v.d} mm, ≈${v.area.toFixed(2)} mm²): ` +
        'ekranda titreşir (z-fighting). Birini 0,05–0,2 mm kaydırın, gömün ya da delikle o yüzeyi tek parçaya bırakın.',
    };
  });
}

export function checkProject(project: Project): CheckIssue[] {
  const seg = project.settings.resolution;
  const out: CheckIssue[] = [];
  const solids = exportableParts(project.parts);
  if (!solids.length) return [{ level: 'uyarı', message: 'Görünür katı parça yok.' }];

  for (const p of solids) {
    const r = solidGeometry(project, p);
    r.geometry.dispose();
    if (r.error) out.push({ level: 'hata', message: `'${p.name}': ${r.error}` });
  }
  for (const h of project.parts.filter((p) => p.visible && roleOf(p) === 'hole')) {
    if (!solids.some((s) => holesFor(project, s).includes(h))) out.push({ level: 'uyarı', message: `Delik '${h.name}' hiçbir katıyı kesmiyor.` });
  }
  for (const p of solids) {
    const s = partBox(p, seg).getSize(new THREE.Vector3());
    const min = Math.min(s.x, s.y, s.z);
    if (min < MIN_WALL) out.push({ level: 'uyarı', message: `'${p.name}' ${min.toFixed(2)} mm kalınlığında; ${MIN_WALL} mm altı FDM'de basılmayabilir (başka parçaya gömülüyse sorun değil).` });
  }
  // Tabla teması son (delikler uygulanmış) geometriye göre: tabla altı bilerek kesilmiş parçalar yanlış uyarı vermesin.
  const box = new THREE.Box3();
  for (const p of solids) box.union(new THREE.Box3().setFromArray(worldMesh(project, p).pos));
  if (box.min.z < -0.01) out.push({ level: 'uyarı', message: `Model tablanın ${(-box.min.z).toFixed(2)} mm altına taşıyor.` });
  else if (box.min.z > 0.01) out.push({ level: 'uyarı', message: `Model tablaya değmiyor (en alt nokta z = ${box.min.z.toFixed(2)} mm).` });

  out.push(...coplanarOverlaps(project, solids));
  return out;
}
