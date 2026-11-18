// Kamera matematiği (src/camera-math.ts): perspektif ↔ ortografik geçişte ölçek, sahne ölçeğinden sınırlar, ortoda kameranın
// derinliği (hedef uzağa kaydırılıp dönülse de sahne küresi [near, far] içinde, kamera kürenin dışında) ve snapshot'ın dik
// izdüşüm çerçevesi (%6 pay).
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { orthoDepth, orthoFrameCamera, orthoHeightFor, perspDistanceFor, toOrthoHeight, toPerspDistance, viewLimits, type OrthoDepth } from '../src/camera-math';

/** Tekrarlanabilir sözde rastgele sayılar. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('perspektif ↔ ortografik ölçek', () => {
  it('gidiş-dönüşte uzaklık ve hedefteki görünür yükseklik korunur', () => {
    for (const fov of [30, 40, 60]) {
      for (const d of [5, 120, 4000, 25000]) {
        const h = orthoHeightFor(d, fov);
        expect(h).toBeCloseTo(2 * d * Math.tan((fov * Math.PI) / 360), 9);
        expect(perspDistanceFor(h, fov)).toBeCloseTo(d, 6);
        // Sınırların içindeyse kırpma yok: orto → perspektif → orto aynı.
        const lim = { minHeight: 1e-3, maxHeight: 1e9 };
        expect(toPerspDistance(toOrthoHeight(d, fov, lim), fov, lim)).toBeCloseTo(d, 6);
      }
    }
  });

  it('sınırlar sahne ölçeğinden; aşırı yakınlaştırma/uzaklaştırma geçişte kırpılır', () => {
    const small = viewLimits(155); // 220 mm tabla
    expect(small.minHeight).toBe(0.5);
    expect(small.maxHeight).toBe(3100);
    const big = viewLimits(14142); // 20 m tabla
    expect(big.minHeight).toBeCloseTo(7.071, 3);
    expect(big.maxHeight).toBeCloseTo(282840, 0);
    expect(viewLimits(0).minHeight).toBe(0.5); // boş sahne
    const fov = 40;
    // Ortoda zoom 1e6: görünür yükseklik ≈ 0 → perspektif uzaklığı alt sınırda (hedefe yapışmaz).
    expect(toPerspDistance(1e-6, fov, small)).toBeCloseTo(perspDistanceFor(small.minHeight, fov), 9);
    // Ortoda aşırı uzaklaştırma: perspektif uzaklığı üst sınırda (sahne uzak düzlemin ötesine düşmez).
    expect(toPerspDistance(1e9, fov, small)).toBeCloseTo(perspDistanceFor(small.maxHeight, fov), 6);
    expect(toPerspDistance(Infinity, fov, small)).toBeCloseTo(perspDistanceFor(small.maxHeight, fov), 6);
    // Perspektifte d → 0: orto yüksekliği alt sınırda, 0 değil.
    expect(toOrthoHeight(0, fov, small)).toBe(small.minHeight);
    expect(toOrthoHeight(1e9, fov, big)).toBe(big.maxHeight);
  });
});

describe('ortoda derinlik (orthoDepth)', () => {
  it('sahne küresinin tüm noktaları [near, far] içinde, kamera kürenin dışında: hedef uzağa kaydırılmış ve dönülmüş', () => {
    const r = rng(7);
    const out: OrthoDepth = { position: new THREE.Vector3(), near: 0, far: 0 };
    const unit = () => new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1).normalize();
    for (const radius of [0, 3, 155, 14142]) {
      const sphere = new THREE.Sphere(new THREE.Vector3(r() * 100 - 50, r() * 100 - 50, r() * 20), radius);
      for (let k = 0; k < 200; k++) {
        // Hedef: kürenin içinde ya da çok uzağa kaydırılmış (yarıçapın 0–50 katı).
        const target = sphere.center.clone().addScaledVector(unit(), (r() < 0.3 ? r() : r() * 50) * Math.max(radius, 1));
        const dir = unit();
        const d = orthoDepth(sphere, target, dir, out);
        expect(d).toBe(out); // aynı nesne yeniden kullanılır
        // Kamera hedeften dir yönünde.
        expect(d.position.clone().sub(target).normalize().dot(dir)).toBeCloseTo(1, 9);
        // Kamera kürenin dışında.
        expect(d.position.distanceTo(sphere.center)).toBeGreaterThan(Math.max(radius, 1));
        expect(d.near).toBeGreaterThan(0);
        // Kürenin bakış yönündeki en yakın ve en uzak noktaları ile rastgele yüzey noktaları.
        const forward = dir.clone().negate();
        const pts = [sphere.center.clone().addScaledVector(dir, Math.max(radius, 1)), sphere.center.clone().addScaledVector(forward, Math.max(radius, 1))];
        for (let j = 0; j < 10; j++) pts.push(sphere.center.clone().addScaledVector(unit(), radius));
        for (const p of pts) {
          const depth = p.clone().sub(d.position).dot(forward);
          expect(depth).toBeGreaterThanOrEqual(d.near);
          expect(depth).toBeLessThanOrEqual(d.far);
        }
      }
    }
  });
});

describe('snapshot dik izdüşüm çerçevesi (orthoFrameCamera)', () => {
  it('kutu %6 payla çerçevelenir (sınırlayan eksende tam 1/1,06), köşeler [near, far] içinde', () => {
    const box = new THREE.Box3(new THREE.Vector3(-40, -25, 0), new THREE.Vector3(60, 25, 30));
    const corners = [box.min.x, box.max.x].flatMap((x) => [box.min.y, box.max.y].flatMap((y) => [box.min.z, box.max.z].map((z) => new THREE.Vector3(x, y, z))));
    const cases: [THREE.Vector3, THREE.Vector3][] = [
      [new THREE.Vector3(1, -1.2, 0.95), new THREE.Vector3(0, 0, 1)], // iso
      [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 1)], // front
      [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0)], // top
      [new THREE.Vector3(-0.3, 0.8, 0.4), new THREE.Vector3(0, 0, 1)], // serbest (camera)
    ];
    for (const aspect of [4 / 3, 0.5, 3]) {
      for (const [d, up] of cases) {
        const cam = orthoFrameCamera(d.clone().normalize(), up, box, aspect);
        expect((cam.right - cam.left) / (cam.top - cam.bottom)).toBeCloseTo(aspect, 9);
        const ndc = corners.map((c) => c.clone().project(cam));
        const mx = Math.max(...ndc.map((p) => Math.abs(p.x)));
        const my = Math.max(...ndc.map((p) => Math.abs(p.y)));
        expect(Math.max(mx, my)).toBeCloseTo(1 / 1.06, 6); // sınırlayan eksen tam pay
        expect(Math.min(mx, my)).toBeLessThanOrEqual(1 / 1.06 + 1e-9);
        for (const p of ndc) expect(Math.abs(p.z)).toBeLessThan(1); // yakın/uzak düzlem içinde
      }
    }
  });
});
