// Parça saydamlığı (`Part.opacity`) ve parça başına yuvarlak yüzey çözünürlüğü (`Part.resolution`): işlemler, dosya
// gidiş-dönüşü ve onarım, dışa aktarım (GLB/3MF/MTL), sahne özeti, geometri ve önbellek ayrımı.
import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { RESPONSE_SCHEMA, normalizeLlmOp, type Op } from '../shared/ops';
import { checkProject } from '../src/check';
import { initCsg } from '../src/csg';
import { applyOps, partBox, sceneSummary } from '../src/engine';
import { buildGlb } from '../src/gltf';
import { buildObj, parseProject, projectToJson, worldMesh } from '../src/io';
import { build3mf } from '../src/meshio';
import { displayOpacity, exportableParts, geometryKey, solidKey, solidVolume } from '../src/model';
import { MAX_RESOLUTION, MIN_RESOLUTION, partSeg } from '../src/shapes';
import { newProject, type Part, type Project } from '../src/types';

beforeAll(() => initCsg());

function project(ops: Op[], seg = 96): Project {
  const p = newProject('görünüm');
  p.settings.resolution = seg;
  const res = applyOps(p, ops, null);
  expect(res.errors).toEqual([]);
  return p;
}

const byName = (p: Project, name: string): Part => {
  const part = p.parts.find((x) => x.name === name);
  if (!part) throw new Error(`parça yok: ${name}`);
  return part;
};

const at = (x: number, y: number, z: number) => ({ x, y, z });
const box = (name: string, w: number, d: number, h: number, pos = at(0, 0, h / 2), extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'box',
  name,
  params: [
    { name: 'width', value: w },
    { name: 'depth', value: d },
    { name: 'height', value: h },
  ],
  position: pos,
  ...extra,
});
const cyl = (name: string, dia: number, h: number, pos = at(0, 0, h / 2), extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'cylinder',
  name,
  params: [
    { name: 'diameter', value: dia },
    { name: 'height', value: h },
  ],
  position: pos,
  ...extra,
});
const sphere = (name: string, dia: number, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'sphere',
  name,
  params: [{ name: 'diameter', value: dia }],
  ...extra,
});
const torus = (name: string, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({ op: 'create', shape: 'torus', name, ...extra });
/** r = 5, a = 0…10 dikdörtgen profil: eksende iki nokta → üçgen sayısı 4·seg, hacim = seg-gen alanı × 10. */
const revolve = (name: string, extra: Partial<Extract<Op, { op: 'create' }>> = {}): Op => ({
  op: 'create',
  shape: 'revolve',
  name,
  geom: { kind: 'revolve', axis: 'z', profile: [[0, 0], [5, 0], [5, 10], [0, 10]] },
  position: at(0, 0, 0),
  ...extra,
});

/** Kapalı ve tutarlı yönlü ağ: hatalı kenar sayısı ve işaretli hacim. */
function closedMesh(pos: Float32Array, tris: number[]) {
  const directed = new Map<string, number>();
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) directed.set(`${u}>${v}`, (directed.get(`${u}>${v}`) ?? 0) + 1);
  }
  let bad = 0;
  for (const [k, n] of directed) {
    const [u, v] = k.split('>');
    if (n !== 1 || directed.get(`${v}>${u}`) !== 1) bad++;
  }
  let vol = 0;
  for (let i = 0; i < tris.length; i += 3) {
    const [p, q, r] = [tris[i] * 3, tris[i + 1] * 3, tris[i + 2] * 3];
    vol +=
      (pos[p] * (pos[q + 1] * pos[r + 2] - pos[q + 2] * pos[r + 1]) -
        pos[p + 1] * (pos[q] * pos[r + 2] - pos[q + 2] * pos[r]) +
        pos[p + 2] * (pos[q] * pos[r + 1] - pos[q + 1] * pos[r])) /
      6;
  }
  return { bad, vol };
}

const triCount = (p: Project, name: string) => worldMesh(p, byName(p, name)).tris.length / 3;
/** Düzgün n-gen alanı (köşe yarıçapı r). */
const ngonArea = (n: number, r: number) => (n / 2) * r * r * Math.sin((2 * Math.PI) / n);
/** Göreli yakınlık (ağ köşeleri Float32). */
const near = (a: number, b: number, rel = 1e-5) => expect(Math.abs(a / b - 1), `${a} ≈ ${b}`).toBeLessThan(rel);

/** GLB'nin JSON bölümü. */
function glbJson(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
}

// ---------------------------------------------------------------------------
// Saydamlık

describe('saydamlık (opacity): işlemler', () => {
  it('create/update: yalnızca < 1 iken tutulur, 1 alanı kaldırır, null değiştirmez', () => {
    const p = newProject();
    const res = applyOps(p, [box('cam', 20, 2, 10, undefined, { opacity: 0.4 }), box('kutu', 10, 10, 10, at(30, 0, 5), { opacity: 1 })], null);
    expect(res.errors).toEqual([]);
    expect(res.messages[0]).toContain('opaklık 0,4');
    expect(byName(p, 'cam').opacity).toBe(0.4);
    expect('opacity' in byName(p, 'kutu')).toBe(false);

    const u = applyOps(p, [{ op: 'update', part: 'cam', opacity: 0.25 }], null);
    expect(u.messages).toEqual(["'cam': opaklık 0,25."]);
    expect(byName(p, 'cam').opacity).toBe(0.25);
    expect(applyOps(p, [{ op: 'update', part: 'cam', opacity: null }], null).messages).toEqual(["'cam' değişmedi."]);
    expect(byName(p, 'cam').opacity).toBe(0.25);
    expect(applyOps(p, [{ op: 'update', part: 'cam', opacity: 1 }], null).messages).toEqual(["'cam': opak."]);
    expect('opacity' in byName(p, 'cam')).toBe(false);
    // 0 (tamamen saydam) geçerli; 3 ondalığa yuvarlanır
    applyOps(p, [{ op: 'update', part: 'kutu', opacity: 0 }, { op: 'update', part: 'cam', opacity: 0.33333 }], null);
    expect(byName(p, 'kutu').opacity).toBe(0);
    expect(byName(p, 'cam').opacity).toBe(0.333);
  });

  it('aralık dışı ve sayı olmayan değer işlem hatası; parça değişmez, sonraki işlemler sürer', () => {
    const p = project([box('cam', 20, 2, 10, undefined, { opacity: 0.5 })]);
    const res = applyOps(
      p,
      [
        { op: 'update', part: 'cam', opacity: 1.5 },
        { op: 'update', part: 'cam', opacity: -0.1 },
        { op: 'update', part: 'cam', opacity: '0.3' as never },
        { op: 'update', part: 'cam', opacity: Number.NaN },
        box('yeni', 5, 5, 5, at(30, 0, 2.5), { opacity: 2 }),
        { op: 'update', part: 'cam', color: '#00ff00' },
      ],
      null,
    );
    expect(res.errors).toHaveLength(5);
    for (const e of res.errors) expect(e).toMatch(/Geçersiz saydamlık \(opacity\).*0 \(tamamen saydam\) ile 1 \(opak\)/);
    expect(byName(p, 'cam').opacity).toBe(0.5);
    expect(byName(p, 'cam').color).toBe('#00ff00');
    expect(p.parts.some((x) => x.name === 'yeni')).toBe(false);
  });

  it('grupta tüm üyelere uygulanır; grupta çözünürlük > 0 hata, 0 / null verilmemiş sayılır', () => {
    const p = project([
      box('cam1', 10, 2, 10, at(0, 0, 5)),
      box('cam2', 10, 2, 10, at(20, 0, 5), { opacity: 0.8 }),
      { op: 'group', name: 'camlar', parts: ['cam1', 'cam2'] },
    ]);
    const res = applyOps(p, [{ op: 'update', part: 'camlar', opacity: 0.3 }], null);
    expect(res.errors).toEqual([]);
    expect(res.messages[0]).toContain('opaklık 0,3');
    expect([byName(p, 'cam1').opacity, byName(p, 'cam2').opacity]).toEqual([0.3, 0.3]);
    applyOps(p, [{ op: 'update', part: 'camlar', opacity: 1 }], null);
    expect(p.parts.some((x) => 'opacity' in x)).toBe(false);
    const bad = applyOps(p, [{ op: 'update', part: 'camlar', resolution: 12 }], null);
    expect(bad.errors[0]).toMatch(/grupta yalnızca renk, görünürlük ve saydamlık/);
    for (const resolution of [0, null]) {
      const ok = applyOps(p, [{ op: 'update', part: 'camlar', color: '#123456', resolution }], null);
      expect(ok.errors, String(resolution)).toEqual([]);
    }
    expect(byName(p, 'cam1').color).toBe('#123456');
  });

  it('referans ve delik opak yapılabilir: 1 açık değer olarak saklanır; katıya dönünce kalkar', () => {
    const p = project([
      box('ref', 5, 5, 5, at(0, 0, 2.5), { role: 'reference' }),
      box('delik', 5, 5, 5, at(10, 0, 2.5), { role: 'hole' }),
      box('ref2', 5, 5, 5, at(20, 0, 2.5), { role: 'reference', opacity: 1 }),
    ]);
    expect(byName(p, 'ref2').opacity).toBe(1);
    expect(displayOpacity(byName(p, 'ref2'))).toBe(1);
    const res = applyOps(p, [{ op: 'update', part: 'ref', opacity: 1 }, { op: 'update', part: 'delik', opacity: 1 }], null);
    expect(res.messages).toEqual(["'ref': opak.", "'delik': opak."]);
    expect([displayOpacity(byName(p, 'ref')), displayOpacity(byName(p, 'delik'))]).toEqual([1, 1]);
    expect(sceneSummary(p, null).parts[0].opacity).toBe(1);
    // dosyada da kalır
    expect(parseProject(JSON.parse(projectToJson(p)))).toEqual(p);
    // katıya dönünce açık 1 kalkar (katıda opak varsayılan); yeniden referans olunca varsayılan 0,35
    applyOps(p, [{ op: 'update', part: 'ref', role: 'solid' }], null);
    expect('opacity' in byName(p, 'ref')).toBe(false);
    applyOps(p, [{ op: 'update', part: 'ref', role: 'reference' }], null);
    expect(displayOpacity(byName(p, 'ref'))).toBe(0.35);
    // rol ve opaklık aynı işlemde: rolden sonra değerlendirilir
    applyOps(p, [{ op: 'update', part: 'ref2', role: 'solid', opacity: 1 }], null);
    expect('opacity' in byName(p, 'ref2')).toBe(false);
  });

  it('update önce tüm alanları doğrular: hatalı alan varsa parçada hiçbir şey değişmez', () => {
    const p = project([box('cam', 20, 2, 10, undefined, { opacity: 0.5 }), cyl('mil', 10, 20, at(30, 0, 10))]);
    const before = structuredClone(p.parts);
    const res = applyOps(
      p,
      [
        { op: 'update', part: 'cam', name: 'yeni', color: '#00ff00', visible: false, opacity: 2 },
        { op: 'update', part: 'cam', color: '#00ff00', cuts: ['mil'] }, // delik değil
        { op: 'update', part: 'mil', opacity: 0.2, resolution: 500 },
        { op: 'update', part: 'mil', role: 'reference', params: [{ name: 'diameter', value: -3 }] },
        { op: 'update', part: 'mil', opacity: 0.2, rotation: { x: Number.NaN, y: 0, z: 0 } },
        { op: 'update', part: 'mil', opacity: 0.2, geom: { kind: 'revolve', axis: 'z', profile: [[0, 0]] } },
      ],
      null,
    );
    expect(res.errors).toHaveLength(6);
    expect(p.parts).toEqual(before);
    // rol ve cuts aynı işlemde: cuts yeni role göre doğrulanır
    const ok = applyOps(p, [{ op: 'update', part: 'mil', role: 'hole', cuts: ['cam'] }], null);
    expect(ok.errors).toEqual([]);
    expect(byName(p, 'mil').cuts).toEqual([byName(p, 'cam').id]);
  });

  it('Claude şeması: create ve update’te opacity / resolution zorunlu, number | null; normalizeLlmOp null’u atar', () => {
    const items = RESPONSE_SCHEMA.properties.operations.items.anyOf as unknown as { properties: Record<string, unknown>; required: string[] }[];
    for (const op of ['create', 'update']) {
      const s = items.find((x) => (x.properties.op as { const: string }).const === op)!;
      for (const k of ['opacity', 'resolution']) {
        expect(s.required).toContain(k);
        expect(s.properties[k]).toEqual({ anyOf: [{ type: 'number' }, { type: 'null' }] });
      }
    }
    const op = normalizeLlmOp({ op: 'update', part: 'cam', name: '', opacity: null, resolution: null, visible: null });
    expect(op).toEqual({ op: 'update', part: 'cam' });
    expect(normalizeLlmOp({ op: 'update', part: 'cam', opacity: 0.5, resolution: 0 })).toEqual({ op: 'update', part: 'cam', opacity: 0.5, resolution: 0 });
    // Claude yolunda opacity 0 = verilmedi (şemadaki boş sayı parçayı görünmez yapmasın); yerel/köprü 0'ı kabul eder
    expect(normalizeLlmOp({ op: 'update', part: 'cam', opacity: 0 })).toEqual({ op: 'update', part: 'cam' });
    expect(normalizeLlmOp({ op: 'create', shape: 'box', opacity: 0 })).toEqual({ op: 'create', shape: 'box' });
    const p = project([box('cam', 5, 5, 5)]);
    applyOps(p, [normalizeLlmOp({ op: 'update', part: 'cam', opacity: 0, color: '#ff0000' })], null);
    expect('opacity' in byName(p, 'cam')).toBe(false);
    applyOps(p, [{ op: 'update', part: 'cam', opacity: 0 }], null);
    expect(byName(p, 'cam').opacity).toBe(0);
  });

  it('görünen saydamlık: opacity rolün varsayılanının (referans 0,35, delik 0,3) yerine geçer', () => {
    const p = project([
      box('katı', 5, 5, 5, at(0, 0, 2.5)),
      box('ref', 5, 5, 5, at(10, 0, 2.5), { role: 'reference' }),
      box('delik', 5, 5, 5, at(20, 0, 2.5), { role: 'hole' }),
      box('ref2', 5, 5, 5, at(30, 0, 2.5), { role: 'reference', opacity: 0.8 }),
      box('cam', 5, 5, 5, at(40, 0, 2.5), { opacity: 0.2 }),
    ]);
    expect(p.parts.map(displayOpacity)).toEqual([1, 0.35, 0.3, 0.8, 0.2]);
  });

  it('sahne özeti: yalnızca ayarlıyken', () => {
    const p = project([box('cam', 20, 2, 10, undefined, { opacity: 0.5 }), cyl('mil', 10, 20, at(30, 0, 10), { resolution: 12 }), box('kutu', 5, 5, 5, at(-30, 0, 2.5))]);
    const s = sceneSummary(p, null);
    const get = (n: string) => s.parts.find((x) => x.name === n)!;
    expect(get('cam').opacity).toBe(0.5);
    expect('resolution' in get('cam')).toBe(false);
    expect(get('mil').resolution).toBe(12);
    expect('opacity' in get('mil')).toBe(false);
    expect('opacity' in get('kutu') || 'resolution' in get('kutu')).toBe(false);
  });
});

describe('saydamlık: dosya', () => {
  it('kaydet → yükle aynı; alan yoksa eklenmez', () => {
    const p = project([box('cam', 20, 2, 10, undefined, { opacity: 0.35 }), box('kutu', 5, 5, 5, at(30, 0, 2.5))]);
    const raw = JSON.parse(projectToJson(p));
    expect(raw.parts[0].opacity).toBe(0.35);
    expect('opacity' in raw.parts[1]).toBe(false);
    const warnings: string[] = [];
    expect(parseProject(raw, [], warnings)).toEqual(p);
    expect(warnings).toEqual([]);
  });

  it('bozuk değer onarılır ve uyarılır (parça atlanmaz); katıda 1 sessizce kalkar, referans/delikte kalır', () => {
    const raw = {
      format: 'p3d',
      parts: [
        { name: 'a', shape: 'box', opacity: 1.5 },
        { name: 'b', shape: 'box', opacity: -0.2 },
        { name: 'c', shape: 'box', opacity: 'yarım' },
        { name: 'd', shape: 'box', opacity: 1 },
        { name: 'e', shape: 'box', opacity: 0.6 },
        { shape: 'box', opacity: Number.POSITIVE_INFINITY },
        { name: 'g', shape: 'box', role: 'reference', opacity: 1 },
        { name: 'h', shape: 'box', role: 'hole', opacity: 1 },
        { name: 'i', shape: 'box', role: 'reference', opacity: 7 },
        { name: 'j', shape: 'box', role: 'reference', opacity: 'çok' },
      ],
    };
    const warnings: string[] = [];
    const dropped: string[] = [];
    const p = parseProject(raw, dropped, warnings);
    expect(dropped).toEqual([]);
    expect(p.parts.map((x) => x.opacity)).toEqual([undefined, 0, undefined, undefined, 0.6, undefined, 1, 1, 1, undefined]);
    expect(p.parts.filter((x) => 'opacity' in x).map((x) => x.name)).toEqual(['b', 'e', 'g', 'h', 'i']);
    expect(warnings).toEqual([
      "'a': saydamlık (opacity) 1.5 geçersiz (0–1 arası olmalı); opak yapıldı.",
      "'b': saydamlık (opacity) -0.2 geçersiz (0–1 arası olmalı); 0 yapıldı.",
      `'c': saydamlık (opacity) geçersiz ("yarım"); opak yapıldı.`,
      '#6: saydamlık (opacity) geçersiz (null); opak yapıldı.', // JSON'da Infinity yok: stringify null yazar
      "'i': saydamlık (opacity) 7 geçersiz (0–1 arası olmalı); opak yapıldı.",
      `'j': saydamlık (opacity) geçersiz ("çok"); rolün varsayılanı kullanılıyor.`,
    ]);
  });
});

describe('saydamlık: dışa aktarım ve görsel olmayan her şey aynı', () => {
  it('GLB: alfa = opacity + alphaMode BLEND; malzemeler renk + saydamlığa göre ayrışır (iskelette de)', () => {
    const p = project([
      box('a', 5, 5, 5, at(-20, 0, 2.5), { color: '#ff0000' }),
      box('b', 5, 5, 5, at(0, 0, 2.5), { color: '#ff0000', opacity: 0.5 }),
      box('c', 5, 5, 5, at(20, 0, 2.5), { color: '#FF0000', opacity: 0.5 }),
      box('d', 5, 5, 5, at(40, 0, 2.5), { color: '#ff0000', opacity: 0.2 }),
    ]);
    const j = glbJson(buildGlb(p));
    expect(j.materials).toHaveLength(3);
    const mat = (i: number) => j.materials[j.meshes[i].primitives[0].material];
    expect(mat(0).pbrMetallicRoughness.baseColorFactor[3]).toBe(1);
    expect('alphaMode' in mat(0)).toBe(false);
    expect(mat(0).name).toBe('P3D_ff0000');
    expect(mat(1).pbrMetallicRoughness.baseColorFactor).toEqual([1, 0, 0, 0.5]);
    expect(mat(1).alphaMode).toBe('BLEND');
    expect(mat(1).name).toBe('P3D_ff0000_a50');
    expect(j.meshes[1].primitives[0].material).toBe(j.meshes[2].primitives[0].material);
    expect(mat(3).pbrMetallicRoughness.baseColorFactor[3]).toBe(0.2);
    const sk = glbJson(buildGlb(p, { skeleton: true }));
    expect(sk.meshes).toHaveLength(1);
    expect(sk.meshes[0].primitives).toHaveLength(3);
    expect(sk.meshes[0].primitives.map((pr: { material: number }) => sk.materials[pr.material].alphaMode ?? 'OPAQUE')).toEqual(['OPAQUE', 'BLEND', 'BLEND']);
  });

  it('3MF displaycolor #RRGGBBAA; MTL d', () => {
    const p = project([box('cam', 20, 2, 10, undefined, { color: '#336699', opacity: 0.5 }), box('kutu', 5, 5, 5, at(30, 0, 2.5), { color: '#aabbcc' })]);
    const meshes = p.parts.map((x) => worldMesh(p, x));
    expect(meshes[0].opacity).toBe(0.5);
    expect('opacity' in meshes[1]).toBe(false);
    const xml = strFromU8(unzipSync(build3mf('t', meshes))['3D/3dmodel.model']);
    expect(xml).toContain('<base name="cam" displaycolor="#33669980" />');
    expect(xml).toContain('<base name="kutu" displaycolor="#AABBCCFF" />');
    const { mtl } = buildObj(p.parts, p, 'm.mtl');
    const blocks = mtl.split('newmtl ').slice(1);
    expect(blocks[0]).toMatch(/^mat_cam\n[\s\S]*\nd 0\.5\n/);
    expect(blocks[1]).toMatch(/\nd 1\n/);
  });

  it('opacity 0 da dışa aktarılır; hacim, check ve delik kesimi değişmez', () => {
    const plain = project([
      box('gövde', 40, 40, 20, at(0, 0, 10)),
      cyl('delik', 10, 30, at(0, 0, 10), { role: 'hole', cuts: ['gövde'] }),
      box('kapak', 40, 40, 2, at(0, 0, 19)), // üst yüzü gövdeninkiyle çakışık: z-fighting
    ]);
    // Aynı kimlikli kopya (check mesajlarındaki parça sırası kimliğe bağlı), hepsi tamamen saydam
    const ghost = structuredClone(plain);
    expect(applyOps(ghost, ['gövde', 'delik', 'kapak'].map((part) => ({ op: 'update', part, opacity: 0 }) as Op), null).errors).toEqual([]);
    expect(ghost.parts.map((x) => x.opacity)).toEqual([0, 0, 0]);
    expect(exportableParts(ghost.parts).map((x) => x.name)).toEqual(['gövde', 'kapak']);
    expect(solidVolume(ghost, byName(ghost, 'gövde'))).toBeCloseTo(solidVolume(plain, byName(plain, 'gövde')), 6);
    expect(solidVolume(ghost, byName(ghost, 'gövde'))).toBeLessThan(40 * 40 * 20 - 1000); // delik kesiyor
    expect(worldMesh(ghost, byName(ghost, 'gövde')).pos).toEqual(worldMesh(plain, byName(plain, 'gövde')).pos);
    expect(checkProject(ghost)).toEqual(checkProject(plain));
    expect(checkProject(ghost).some((i) => /z-fighting/.test(i.message))).toBe(true);
    // Görünüm anahtarı da değişmez: saydamlık değişince ağ yeniden üretilmez
    expect(solidKey(ghost, byName(ghost, 'gövde'))).toBe(solidKey(plain, byName(plain, 'gövde')));
  });
});

// ---------------------------------------------------------------------------
// Parça başına çözünürlük

describe('parça çözünürlüğü (resolution): geometri', () => {
  it('üçgen sayısını değiştirir: küre, silindir, torus, döndürme (alanı olmayan kardeş proje ayarında kalır)', () => {
    const p = project([
      sphere('küre8', 20, { resolution: 8 }),
      sphere('küre', 20),
      cyl('silindir8', 20, 10, at(40, 0, 5), { resolution: 8 }),
      torus('torus8', { resolution: 8 }),
      torus('torus16', { resolution: 16 }),
      revolve('döndürme8', { resolution: 8 }),
      revolve('döndürme', { position: at(60, 0, 0) }),
    ]);
    // küre: 2·s·(max(4, s/2) − 1); silindir: 4·s; torus: 2·s·max(4, min(12, s − 4), s/3); döndürme (eksende 2 nokta): 4·s
    expect(triCount(p, 'küre8')).toBe(2 * 8 * 3);
    expect(triCount(p, 'küre')).toBe(2 * 96 * 47);
    expect(triCount(p, 'silindir8')).toBe(4 * 8);
    expect(triCount(p, 'torus8')).toBe(2 * 8 * 4);
    expect(triCount(p, 'torus16')).toBe(2 * 16 * 12); // Boltrush: 16 dilimde 384
    expect(triCount(p, 'döndürme8')).toBe(4 * 8);
    expect(triCount(p, 'döndürme')).toBe(4 * 96);
    expect(partSeg(byName(p, 'küre8'), 96)).toBe(8);
    expect(partSeg(byName(p, 'küre'), 96)).toBe(96);
  });

  it('6 segmentte kapalı ağ ve hacim analitik çokgen değerinde', () => {
    const shapes: Op[] = [
      cyl('silindir', 20, 10, at(0, 0, 5), { resolution: 6 }),
      sphere('küre', 20, { resolution: 6 }),
      torus('torus', { resolution: 6 }),
      { op: 'create', shape: 'cone', name: 'koni', resolution: 6 },
      { op: 'create', shape: 'tube', name: 'boru', resolution: 6 },
      revolve('döndürme', { resolution: 6 }),
    ];
    const p = project(shapes);
    for (const part of p.parts) {
      const m = worldMesh(p, part);
      const { bad, vol } = closedMesh(m.pos, m.tris);
      expect(bad, `${part.name}: açık/ters kenar`).toBe(0);
      expect(vol, `${part.name}: hacim`).toBeGreaterThan(0);
    }
    const vol = (n: string) => closedMesh(worldMesh(p, byName(p, n)).pos, worldMesh(p, byName(p, n)).tris).vol;
    near(vol('silindir'), ngonArea(6, 10) * 10);
    near(vol('döndürme'), ngonArea(6, 5) * 10);
    // küre 6×4: makul (analitiğin %40–100'ü)
    const ratio = vol('küre') / ((4 / 3) * Math.PI * 1000);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(1);
  });

  it('alan yokken ağ aynı: proje çözünürlüğüne eşit parça çözünürlüğü bayt bayt aynı ağı verir', () => {
    const p = project(
      [
        sphere('a', 20, { position: at(0, 0, 10) }),
        sphere('b', 20, { resolution: 24, position: at(0, 0, 10) }),
        torus('c', { position: at(40, 0, 3) }),
        torus('d', { resolution: 24, position: at(40, 0, 3) }),
      ],
      24,
    );
    const [a, b] = [worldMesh(p, byName(p, 'a')), worldMesh(p, byName(p, 'b'))];
    expect(Array.from(b.pos)).toEqual(Array.from(a.pos));
    expect(b.tris).toEqual(a.tris);
    expect(worldMesh(p, byName(p, 'd')).tris).toEqual(worldMesh(p, byName(p, 'c')).tris);
    // Anahtar biçimi alan yokken eskisiyle aynı (…|seg)
    expect(geometryKey(byName(p, 'a'), 24)).toBe(`sphere|${JSON.stringify(byName(p, 'a').params)}||24`);
    expect(geometryKey(byName(p, 'b'), 24)).toBe(geometryKey(byName(p, 'a'), 24));
  });

  it('önbellek ayrımı: yalnızca parça çözünürlüğü değişince ağ/kutu/hacim yeniden üretilir; proje ayarı onu etkilemez', () => {
    const p = project([cyl('mil', 20, 10, at(0, 0, 5), { resolution: 6 }), revolve('topuz', { resolution: 6 }), cyl('diğer', 20, 10, at(40, 0, 5))]);
    const mil = byName(p, 'mil');
    const topuz = byName(p, 'topuz');
    const width = () => {
      const b = partBox(mil, p.settings.resolution);
      return b.max.x - b.min.x;
    };
    expect(width()).toBeCloseTo(20 * Math.sin(Math.PI / 3), 4); // altıgen: köşeler ±y'de
    near(solidVolume(p, topuz), ngonArea(6, 5) * 10);
    const key6 = solidKey(p, mil);

    expect(applyOps(p, [{ op: 'update', part: 'mil', resolution: 96 }, { op: 'update', part: 'topuz', resolution: 96 }], null).errors).toEqual([]);
    expect(width()).toBeCloseTo(20, 4);
    near(solidVolume(p, topuz), ngonArea(96, 5) * 10);
    expect(solidKey(p, mil)).not.toBe(key6);
    expect(mil.position).toEqual(at(0, 0, 5)); // merkez yerinde

    // Proje çözünürlüğü değişince kendi çözünürlüğü olan parçanın anahtarı ve ağı aynı kalır, diğeri değişir.
    const keyMil = solidKey(p, mil);
    const keyOther = solidKey(p, byName(p, 'diğer'));
    const trisOther = triCount(p, 'diğer');
    p.settings.resolution = 12;
    expect(solidKey(p, mil)).toBe(keyMil);
    expect(width()).toBeCloseTo(20, 4);
    expect(triCount(p, 'mil')).toBe(4 * 96);
    expect(solidKey(p, byName(p, 'diğer'))).not.toBe(keyOther);
    expect(triCount(p, 'diğer')).toBe(4 * 12);
    expect(trisOther).toBe(4 * 96);

    // 0 alanı kaldırır: proje ayarına döner
    const r = applyOps(p, [{ op: 'update', part: 'mil', resolution: 0 }], null);
    expect(r.messages).toEqual(["'mil': çözünürlük: proje ayarı (12)."]);
    expect('resolution' in mil).toBe(false);
    expect(triCount(p, 'mil')).toBe(4 * 12);
  });

  it('delikli parçada etkin çözünürlük: delik kendi segmentiyle keser, kesilen parça kendi segmentiyle üretilir', () => {
    const p = project(
      [
        box('blok', 40, 40, 20, at(0, 0, 10)),
        cyl('delik', 10, 30, at(0, 0, 10), { role: 'hole', cuts: ['blok'], resolution: 6 }),
        cyl('mil', 20, 20, at(60, 0, 10), { resolution: 6 }),
        box('kesik', 30, 30, 12, at(60, 0, 16), { role: 'hole', cuts: ['mil'] }), // milin üst yarısı (z 10…22)
      ],
      48,
    );
    near(solidVolume(p, byName(p, 'blok')), 40 * 40 * 20 - ngonArea(6, 5) * 20);
    near(solidVolume(p, byName(p, 'mil')), ngonArea(6, 10) * 10);
    const m = worldMesh(p, byName(p, 'blok'));
    expect(closedMesh(m.pos, m.tris).bad).toBe(0);
    // deliğin çözünürlüğü değişince kesilen parçanın anahtarı da değişir
    const key = solidKey(p, byName(p, 'blok'));
    applyOps(p, [{ op: 'update', part: 'delik', resolution: 8 }], null);
    expect(solidKey(p, byName(p, 'blok'))).not.toBe(key);
    near(solidVolume(p, byName(p, 'blok')), 40 * 40 * 20 - ngonArea(8, 5) * 20);
  });
});

describe('parça çözünürlüğü: işlemler ve dosya', () => {
  it('yuvarlak şekilde sınır dışı ve sayı olmayan değer hata; kesir yuvarlanır', () => {
    const p = project([cyl('mil', 10, 20)]);
    const res = applyOps(
      p,
      [
        { op: 'update', part: 'mil', resolution: MIN_RESOLUTION - 1 },
        { op: 'update', part: 'mil', resolution: MAX_RESOLUTION + 1 },
        { op: 'update', part: 'mil', resolution: '12' as never },
        sphere('top', 10, { resolution: 500 }),
      ],
      null,
    );
    expect(res.errors).toHaveLength(4);
    expect(res.errors[0]).toBe("'mil': çözünürlük 5 olamaz; 6–192 arası segment olmalı (0 = proje ayarı).");
    expect(res.errors[1]).toContain('çözünürlük 193 olamaz');
    expect(res.errors[2]).toMatch(/^Geçersiz çözünürlük \(resolution\): "12"/);
    expect(res.errors[3]).toContain("'top': çözünürlük 500 olamaz");
    expect('resolution' in byName(p, 'mil')).toBe(false);
    expect(p.parts.map((x) => x.name)).toEqual(['mil']);

    const ok = applyOps(p, [{ op: 'update', part: 'mil', resolution: 12.4 }], null);
    expect(ok.errors).toEqual([]);
    expect(ok.messages[0]).toBe("'mil': çözünürlük 12.");
    expect(byName(p, 'mil').resolution).toBe(12);
    expect(applyOps(p, [{ op: 'update', part: 'mil', resolution: null }], null).messages).toEqual(["'mil' değişmedi."]);
  });

  it('segment kullanmayan şekilde (ve yumuşak olmayan loft’ta) hata değil: alan yok sayılır, mesaja uyarı', () => {
    const p = project([]);
    const hull = { kind: 'hull' as const, stations: [{ x: 0, keel: 0, sheer: 5, breadth: [2, 3] }, { x: 20, keel: 0, sheer: 5, breadth: [2, 3] }] };
    const loft = (smooth: boolean) => ({
      kind: 'loft' as const,
      axis: 'z' as const,
      smooth,
      sections: [
        { at: 0, points: [[-5, -5], [5, -5], [5, 5], [-5, 5]] as [number, number][] },
        { at: 10, points: [[-3, -3], [3, -3], [3, 3], [-3, 3]] as [number, number][] },
      ],
    });
    const res = applyOps(
      p,
      [
        box('kutu', 10, 10, 10, at(30, 0, 5), { resolution: 8 }),
        box('kutu2', 10, 10, 10, at(50, 0, 5), { resolution: 500 }), // aralık da sorun değil: yok sayılır
        { op: 'create', shape: 'prism', name: 'prizma', resolution: 8 },
        { op: 'create', shape: 'hull', name: 'tekne', resolution: 12, geom: hull, position: at(0, 40, 0) },
        { op: 'create', shape: 'loft', name: 'köşeli', resolution: 8, geom: loft(false), position: at(-40, 0, 0) },
        { op: 'create', shape: 'loft', name: 'yumuşak', resolution: 8, geom: loft(true), position: at(-70, 0, 0) },
      ],
      null,
    );
    expect(res.errors).toEqual([]);
    expect(p.parts.map((x) => x.name)).toEqual(['kutu', 'kutu2', 'prizma', 'tekne', 'köşeli', 'yumuşak']);
    expect(p.parts.map((x) => x.resolution)).toEqual([undefined, undefined, undefined, undefined, undefined, 8]);
    const warnings = res.messages.filter((m) => m.includes('yok sayıldı'));
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toBe(
      "'kutu': çözünürlük (resolution) yalnızca yuvarlak şekillerde geçerli (silindir, boru, koni, küre, torus, döndürme, yumuşak loft); kutu için yok sayıldı.",
    );
    expect(warnings[3]).toContain('geom.maxTris');
    expect(warnings[4]).toContain('smooth: true');

    // update: aynı davranış, parçanın diğer alanları uygulanır
    const u = applyOps(p, [{ op: 'update', part: 'kutu', resolution: 12, color: '#00ff00' }, { op: 'update', part: 'köşeli', resolution: 12 }], null);
    expect(u.errors).toEqual([]);
    expect(u.messages).toEqual([
      "'kutu': renk #00ff00.",
      expect.stringContaining("'kutu': çözünürlük (resolution) yalnızca yuvarlak şekillerde"),
      "'köşeli' değişmedi.",
      expect.stringContaining("'köşeli': çözünürlük (resolution) yalnızca yuvarlak şekillerde"),
    ]);
    expect('resolution' in byName(p, 'kutu') || 'resolution' in byName(p, 'köşeli')).toBe(false);

    // yumuşak loft yumuşak olmayana dönerse alan kalkar; aynı işlemde yumuşak olan geometriyle çözünürlük verilebilir
    const g = applyOps(p, [{ op: 'update', part: 'yumuşak', geom: loft(false) }, { op: 'update', part: 'köşeli', geom: loft(true), resolution: 10 }], null);
    expect(g.errors).toEqual([]);
    expect(g.messages[0]).toContain('çözünürlük kaldırıldı (yumuşak olmayan loft segment kullanmaz)');
    expect('resolution' in byName(p, 'yumuşak')).toBe(false);
    expect(byName(p, 'köşeli').resolution).toBe(10);
  });

  it('yumuşak olmayan loft: alan ağı ve önbellek anahtarını etkilemez, check ipucuna girmez, dosyada kaldırılır', () => {
    const sections = [
      { at: 0, points: [[-5, -5], [5, -5], [5, 5], [-5, 5]] as [number, number][] },
      { at: 10, points: [[-3, -3], [3, -3], [3, 3], [-3, 3]] as [number, number][] },
    ];
    const p = project(
      [
        { op: 'create', shape: 'loft', name: 'a', geom: { kind: 'loft', axis: 'z', sections }, position: at(0, 0, 0) },
        { op: 'create', shape: 'loft', name: 'b', geom: { kind: 'loft', axis: 'z', sections, smooth: true }, position: at(30, 0, 0), resolution: 96 },
      ],
      24,
    );
    const a = byName(p, 'a');
    const withField: Part = { ...a, resolution: 8 }; // elle kurulmuş (betik): yok sayılır
    expect(partSeg(withField, 24)).toBe(24);
    expect(geometryKey(withField, 24)).toBe(geometryKey(a, 24));
    expect(partSeg(byName(p, 'b'), 24)).toBe(96);
    const msg = checkProject(p, { profile: 'game', maxTris: 50 })[0].message;
    expect(msg).toContain("Çok üçgenli yuvarlak parçalar (segment): b (96)");
    expect(msg).not.toMatch(/segment\): .*\ba \(/);

    const warnings: string[] = [];
    const back = parseProject({ ...JSON.parse(projectToJson(p)), parts: [{ ...JSON.parse(projectToJson(p)).parts[0], resolution: 8 }] }, [], warnings);
    expect('resolution' in back.parts[0]).toBe(false);
    expect(warnings).toEqual(["'a': çözünürlük (resolution) 'loft' (yumuşak olmayan) şeklinde kullanılmaz; kaldırıldı."]);
  });

  it('kopya ve ayna saydamlık ile çözünürlüğü taşır; oluşturma mesajında görünür', () => {
    const p = newProject();
    const res = applyOps(p, [cyl('mil', 20, 10, at(0, 0, 5), { resolution: 6, opacity: 0.5 })], null);
    expect(res.messages[0]).toMatch(/oluşturuldu \(.*, opaklık 0,5, çözünürlük 6\)\.$/);
    applyOps(p, [{ op: 'duplicate', part: 'mil' }, { op: 'mirror', part: 'mil', plane: 'x', at: 50 }], null);
    expect(p.parts).toHaveLength(3);
    for (const part of p.parts) expect([part.resolution, part.opacity]).toEqual([6, 0.5]);
  });

  it('dosya gidiş-dönüşü ve onarım', () => {
    const p = project([cyl('mil', 10, 20, undefined, { resolution: 12 }), sphere('top', 10, { resolution: 8, opacity: 0.5 })]);
    const raw = JSON.parse(projectToJson(p));
    expect(raw.parts.map((x: Part) => x.resolution)).toEqual([12, 8]);
    const warnings: string[] = [];
    expect(parseProject(raw, [], warnings)).toEqual(p);
    expect(warnings).toEqual([]);

    const bad = parseProject(
      {
        format: 'p3d',
        parts: [
          { name: 'a', shape: 'cylinder', resolution: 3 },
          { name: 'b', shape: 'sphere', resolution: 500 },
          { name: 'c', shape: 'torus', resolution: 12.4 },
          { name: 'd', shape: 'cone', resolution: 'yüksek' },
          { name: 'e', shape: 'box', resolution: 8 },
          { name: 'f', shape: 'cylinder', resolution: 0 },
          { name: 'g', shape: 'tube', resolution: 16 },
        ],
      },
      [],
      warnings,
    );
    expect(bad.parts.map((x) => x.resolution)).toEqual([6, 192, 12, undefined, undefined, undefined, 16]);
    expect(warnings).toEqual([
      "'a': çözünürlük (resolution) 3 geçersiz (6–192 arası tamsayı olmalı); 6 yapıldı.",
      "'b': çözünürlük (resolution) 500 geçersiz (6–192 arası tamsayı olmalı); 192 yapıldı.",
      "'c': çözünürlük (resolution) 12.4 geçersiz (6–192 arası tamsayı olmalı); 12 yapıldı.",
      `'d': çözünürlük (resolution) geçersiz ("yüksek"); kaldırıldı, proje ayarı kullanılıyor.`,
      "'e': çözünürlük (resolution) 'box' şeklinde kullanılmaz; kaldırıldı.",
    ]);
  });

  it('check --profile game: bütçe aşılınca çok üçgenli yuvarlak parçalara parça çözünürlüğü önerir', () => {
    const p = project([sphere('top', 20), box('kutu', 10, 10, 10, at(30, 0, 5))], 48);
    const msg = checkProject(p, { profile: 'game', maxTris: 1000 })[0].message;
    expect(msg).toContain('parça başına `resolution`');
    expect(msg).toContain('Çok üçgenli yuvarlak parçalar (segment): top (48)');
    applyOps(p, [{ op: 'update', part: 'top', resolution: 8 }], null);
    expect(checkProject(p, { profile: 'game', maxTris: 1000 })).toEqual([]);
  });
});
