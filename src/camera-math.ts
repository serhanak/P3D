// Kamera matematiği (DOM'suz; Node'da test edilir, tests/camera-math.test.ts): perspektif ↔ ortografik geçişte hedefteki
// görünür ölçek, sahne ölçeğinden yakınlaştırma sınırları, ortoda kameranın derinliği (yakın/uzak düzlem) ve görüntü (snapshot)
// için kutuyu çerçeveleyen dik izdüşüm kamerası. viewer.ts bunları kullanır.
import * as THREE from 'three';

const DEG = Math.PI / 180;

/** Perspektif kameranın `d` uzaklıktaki hedef düzleminde görünür yüksekliği (orto yüksekliği): 2 · d · tan(fov/2). */
export function orthoHeightFor(d: number, fovDeg: number): number {
  return 2 * d * Math.tan((fovDeg * DEG) / 2);
}

/** Hedefte `h` görünür yüksekliği veren perspektif uzaklığı (orthoHeightFor'un tersi). */
export function perspDistanceFor(h: number, fovDeg: number): number {
  return h / (2 * Math.tan((fovDeg * DEG) / 2));
}

/** Hedefteki görünür yüksekliğin sınırları (mm). */
export interface ViewLimits {
  minHeight: number;
  maxHeight: number;
}

/**
 * Sahne yarıçapından (tabla + parçalar) yakınlaştırma sınırları: en yakında görünür yükseklik r · 5e-4 (en az 0,5 mm), en uzakta
 * r · 20. Ortoda aşırı yakınlaştırılıp perspektife dönünce kamera hedefe yapışmasın ya da her şey uzak düzlemin ötesine düşmesin.
 */
export function viewLimits(sceneRadius: number): ViewLimits {
  const r = Math.max(sceneRadius, 1);
  return { minHeight: Math.max(0.5, r * 5e-4), maxHeight: r * 20 };
}

const clampTo = (v: number, lim: ViewLimits) => Math.min(lim.maxHeight, Math.max(lim.minHeight, Number.isFinite(v) ? v : lim.maxHeight));

/** Perspektiften ortoya: `d` uzaklığın hedefteki görünür yüksekliği, sınırlara kırpılmış. */
export function toOrthoHeight(d: number, fovDeg: number, lim: ViewLimits): number {
  return clampTo(orthoHeightFor(d, fovDeg), lim);
}

/** Ortodan perspektife: görünür yükseklik (`(top − bottom) / zoom`) sınırlara kırpılıp uzaklığa çevrilir. */
export function toPerspDistance(visibleHeight: number, fovDeg: number, lim: ViewLimits): number {
  return perspDistanceFor(clampTo(visibleHeight, lim), fovDeg);
}

/** Ortoda kameranın yeri ve kırpma düzlemleri. */
export interface OrthoDepth {
  position: THREE.Vector3;
  near: number;
  far: number;
}

/**
 * Ortoda uzaklık görüntüyü değiştirmez: kamera hedeften birim `dir` yönünde, sahne küresinin (tabla + parçalar + eskiz) tamamı
 * yakın düzlemin önünde kalacak kadar geride durur (hedef küreden uzaklaşsa da). Küre noktalarının derinliği
 * [pay, 2 · erişim + pay] aralığındadır; yakın düzlem payın yarısı, uzak düzlem bunun ötesinde. Derinlik doğrusaldır: 20 m
 * tablada bile ~0,002 mm çözünürlük. `out` yeniden kullanılır (her karede yeni nesne üretilmez).
 */
export function orthoDepth(sphere: THREE.Sphere, target: THREE.Vector3, dir: THREE.Vector3, out: OrthoDepth): OrthoDepth {
  const radius = Math.max(sphere.radius, 1);
  const reach = target.distanceTo(sphere.center) + radius;
  const margin = Math.max(10, radius * 0.1);
  const dist = reach + margin;
  out.position.copy(target).addScaledVector(dir, dist);
  out.near = margin / 2;
  out.far = dist + reach + margin;
  return out;
}

/**
 * Görüntü (snapshot) dik izdüşümü: merkezden kameraya birim `dir`, kutunun 8 köşesi kamera düzlemine izdüşürülüp %6 payla
 * çerçevelenir (en-boy oranı korunur). Kamera kutu merkezinden yarıçap × 4 uzakta; yakın 0,1, uzak yarıçap × 10.
 */
export function orthoFrameCamera(dir: THREE.Vector3, up: THREE.Vector3, box: THREE.Box3, aspect: number): THREE.OrthographicCamera {
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 5);
  const cam = new THREE.OrthographicCamera();
  cam.up.copy(up);
  cam.position.copy(center).addScaledVector(dir, radius * 4);
  cam.lookAt(center);
  cam.updateMatrixWorld();
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const cx of [box.min.x, box.max.x])
    for (const cy of [box.min.y, box.max.y])
      for (const cz of [box.min.z, box.max.z]) {
        const p = V(cx, cy, cz).applyMatrix4(cam.matrixWorldInverse);
        [x0, x1, y0, y1] = [Math.min(x0, p.x), Math.max(x1, p.x), Math.min(y0, p.y), Math.max(y1, p.y)];
      }
  let w = (x1 - x0) * 1.06;
  let h = (y1 - y0) * 1.06;
  if (w / h > aspect) h = w / aspect;
  else w = h * aspect;
  const [mx, my] = [(x0 + x1) / 2, (y0 + y1) / 2];
  Object.assign(cam, { left: mx - w / 2, right: mx + w / 2, top: my + h / 2, bottom: my - h / 2, near: 0.1, far: radius * 10 });
  cam.updateProjectionMatrix();
  return cam;
}
