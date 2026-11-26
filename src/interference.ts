// Girişim denetimi (BoltRush isteği #10): farklı parçaların (ya da grupların) katıları arasındaki hacim örtüşmesi. Dokunma
// (ortak yüz, kenar, köşe) sayılmaz: kesişim hacmi eşiğin altındaysa çift listelenmez. Eskiden çift çift `measure --parts` ile
// U(A) + U(B) − U(A ∪ B) hesaplanıyordu.
//
// Gövdeler son (delikler çıkarılmış) dünya ağlarıdır (`worldMesh`); kaplamalar (kalınlıksız) ve görünmeyen/delik/referans parçalar
// girmez. Yalnızca kutuları gerçekten kesişen çiftlerin kesişimi hesaplanır (manifold). `byGroup`: aynı gruptaki parçalar tek
// gövdedir (grubun içindeki bilinçli gömmeler sayılmaz; gruplanmamış parça kendi başına). Kapalı olmayan ağlı gövde atlanır
// (`skipped`).
import * as THREE from 'three';
import { findGroup, findPartExact } from './engine';
import { pairIntersections } from './csg';
import { worldMesh } from './io';
import { exportableParts, isDecal, solidBox } from './model';
import type { Part, Project } from './types';
import type { Vec3 } from '../shared/ops';

export interface InterferenceOptions {
  /** Aynı gruptaki parçalar tek gövde (grup adıyla); gruplanmamış parça kendi adıyla. */
  byGroup?: boolean;
  /** Yalnızca bu parçaları ya da grupları (ad) içeren çiftler. */
  parts?: string[];
  /** Mutlak hacim eşiği (mm³; varsayılan 0,001). Ayrıca küçük gövdenin hacminin 1e-6'sı (float gürültüsü). */
  minVolume?: number;
}

export interface Interference {
  /** Gövde adları (parça ya da grup). */
  a: string;
  b: string;
  /** Kesişim hacmi (mm³). */
  volume: number;
  /** Kesişimin gövde hacmine oranı (0–1). */
  fractionA: number;
  fractionB: number;
  /** Kesişimin kutusu (dünya mm). */
  box: { min: Vec3; max: Vec3 };
}

export interface InterferenceResult {
  /** Hacmi büyükten küçüğe. */
  pairs: Interference[];
  /** Kapalı olmayan ağı yüzünden denetlenemeyen gövdeler. */
  skipped: string[];
}

interface Body {
  name: string;
  parts: Part[];
  box: THREE.Box3;
}

/** Projedeki girişimler (boolean çekirdeği hazır olmalı: `initCsg`). */
export function interferences(project: Project, opts: InterferenceOptions = {}): InterferenceResult {
  const solids = exportableParts(project.parts).filter((p) => !isDecal(p));
  const groups = new Map<string, Body>();
  const bodies: Body[] = [];
  for (const p of solids) {
    const key = opts.byGroup && p.group ? p.group : null;
    let b = key ? groups.get(key) : undefined;
    if (!b) {
      b = { name: key ?? p.name, parts: [], box: new THREE.Box3() };
      bodies.push(b);
      if (key) groups.set(key, b);
    }
    b.parts.push(p);
    b.box.union(solidBox(project, p));
  }
  // Seçim: parça adı (tam) ya da grup adı → o parçaların gövdeleri.
  let picked: Set<Body> | null = null;
  if (opts.parts?.length) {
    picked = new Set();
    const ctx = { selectedId: null, lastPartId: null };
    for (const ref of opts.parts) {
      const p = findPartExact(project, ref, ctx);
      const g = p ? undefined : findGroup(project, ref);
      if (!p && !g) throw new Error(`'${ref}' adında parça ya da grup bulunamadı.`);
      const hit = bodies.filter((b) => b.parts.some((q) => (p ? q === p : q.group === g!.name)));
      if (!hit.length) throw new Error(`'${p?.name ?? g!.name}' görünür bir katı değil; girişim denetimine girmez.`);
      for (const b of hit) picked.add(b);
    }
  }
  // Kutuları gerçekten kesişen çiftler (dokunan kutular dışarıda).
  const pairs: [number, number][] = [];
  const overlap = (a: THREE.Box3, b: THREE.Box3) =>
    a.min.x < b.max.x && b.min.x < a.max.x && a.min.y < b.max.y && b.min.y < a.max.y && a.min.z < b.max.z && b.min.z < a.max.z;
  const order = bodies.map((_, i) => i).filter((i) => !bodies[i].box.isEmpty()).sort((i, j) => bodies[i].box.min.x - bodies[j].box.min.x);
  for (let s = 0; s < order.length; s++) {
    const A = bodies[order[s]];
    for (let r = s + 1; r < order.length; r++) {
      const B = bodies[order[r]];
      if (B.box.min.x >= A.box.max.x) break;
      if (picked && !picked.has(A) && !picked.has(B)) continue;
      if (overlap(A.box, B.box)) pairs.push([order[s], order[r]]);
    }
  }
  if (!pairs.length) return { pairs: [], skipped: [] };
  const used = new Set(pairs.flat());
  const geoms = bodies.map((b, i) => {
    if (!used.has(i)) return [];
    return b.parts.map((p) => {
      const m = worldMesh(project, p);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(m.pos), 3));
      g.setIndex(Array.from(m.tris));
      return g;
    });
  });
  try {
    const { results, bodyVolumes } = pairIntersections(geoms, pairs);
    const min = opts.minVolume ?? 0.001;
    const out: Interference[] = [];
    results.forEach((r, k) => {
      const [i, j] = pairs[k];
      const [va, vb] = [bodyVolumes[i], bodyVolumes[j]];
      if (!r || va === null || vb === null) return;
      if (!(r.volume > Math.max(min, 1e-6 * Math.min(va, vb)))) return;
      out.push({
        a: bodies[i].name,
        b: bodies[j].name,
        volume: r.volume,
        fractionA: va > 0 ? r.volume / va : 0,
        fractionB: vb > 0 ? r.volume / vb : 0,
        box: { min: { x: r.min[0], y: r.min[1], z: r.min[2] }, max: { x: r.max[0], y: r.max[1], z: r.max[2] } },
      });
    });
    out.sort((x, y) => y.volume - x.volume);
    const skipped = [...used].filter((i) => bodyVolumes[i] === null).map((i) => bodies[i].name);
    return { pairs: out, skipped };
  } finally {
    for (const gs of geoms) for (const g of gs) g.dispose();
  }
}
