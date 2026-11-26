// İç içe gruplar (BoltRush isteği #5): teker = lastik + jant + tel → teker grubu → köşe grubu. Alt ağaç işlemleri, döngü reddi,
// ungroup'ta yeniden bağlama, budama, dosya onarımı, sahne özeti, GLB düğüm/eklem hiyerarşisi, birleştirme öneki, girişim gövdesi.
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GroupDef, Op } from '../shared/ops';
import { combineProjects } from '../src/combine';
import { initCsg } from '../src/csg';
import { applyOps, groupAncestors, groupParts, partBox, partsBox, sceneSummary, subgroups } from '../src/engine';
import { buildGlb, selectParts } from '../src/gltf';
import { interferences } from '../src/interference';
import { parseProject, projectToJson, worldMesh } from '../src/io';
import { newProject, type Part, type Project } from '../src/types';

beforeAll(() => initCsg());

const V = (x: number, y: number, z: number) => ({ x, y, z });

function project(ops: Op[], seg = 16): Project {
  const p = newProject('montaj');
  p.settings.resolution = seg;
  const res = applyOps(p, ops, null);
  expect(res.errors).toEqual([]);
  return p;
}

const run = (p: Project, ops: Op[]) => applyOps(p, ops, null);
const part = (p: Project, name: string): Part => {
  const x = p.parts.find((q) => q.name === name);
  if (!x) throw new Error(`parça yok: ${name}`);
  return x;
};
const group = (p: Project, name: string): GroupDef => {
  const g = p.groups?.find((q) => q.name === name);
  if (!g) throw new Error(`grup yok: ${name}`);
  return g;
};
/** Grupların [ad, üst] listesi (proje sırasıyla). */
const tree = (p: Project) => (p.groups ?? []).map((g) => [g.name, g.parent ?? null]);
const members = (p: Project, g: string) => p.parts.filter((x) => x.group === g).map((x) => x.name);

const box = (name: string, w: number, d: number, h: number, at: { x: number; y: number; z: number }, extra: object = {}): Op =>
  ({ op: 'create', shape: 'box', name, params: [{ name: 'width', value: w }, { name: 'depth', value: d }, { name: 'height', value: h }], position: at, ...extra }) as Op;
const cyl = (name: string, dia: number, h: number, at: { x: number; y: number; z: number }, extra: object = {}): Op =>
  ({ op: 'create', shape: 'cylinder', name, params: [{ name: 'diameter', value: dia }, { name: 'height', value: h }], position: at, ...extra }) as Op;
const r90 = { rotation: V(90, 0, 0) };

/**
 * Sol ön köşe: teker (lastik + jant + tel + jant deliği) köşe grubunda, köşenin kendi parçası amortisör. Gövde gruplanmamış.
 * Adlar kök grup adıyla ('sol') başlar: kopya/ayna adlarında önek kuralı (memberName) görünsün.
 */
const corner = (): Op[] => [
  box('gövde', 400, 200, 100, V(0, 0, 150), { color: '#cc3333' }),
  cyl('sol_lastik', 160, 60, V(150, 130, 80), { ...r90, color: '#222222' }),
  cyl('sol_jant', 100, 62, V(150, 130, 80), { ...r90, color: '#bbbbbb' }),
  box('sol_tel', 90, 10, 8, V(150, 162, 80), { color: '#999999' }),
  cyl('sol_mil', 20, 80, V(150, 130, 80), { ...r90, role: 'hole', cuts: ['sol_jant'] }),
  { op: 'group', name: 'sol_teker', parts: ['sol_lastik', 'sol_jant', 'sol_tel', 'sol_mil'], pivot: V(150, 130, 80) },
  box('sol_amortisör', 20, 20, 120, V(150, 90, 170), { color: '#3366cc' }),
  { op: 'group', name: 'sol', parts: ['sol_teker', 'sol_amortisör'], pivot: V(150, 100, 150) },
];

describe('araya alt montaj sokmak: group.parent', () => {
  it('parent ile yeni grup var olan grubun içine girer; yoksa eski düz anlam (taşıma) korunur; döngü hata', () => {
    const p = project([...corner(), box('far', 20, 10, 10, V(-180, -100, 160)), { op: 'group', name: 'araba', parts: ['gövde', 'far', 'sol'] } as Op]);
    // gövde ve far araba'nın doğrudan parçaları: aralarına "ön" grubu sokulur, araba'yı yeniden listelemek gerekmez.
    const r = run(p, [{ op: 'group', name: 'ön', parts: ['gövde', 'far'], parent: 'Araba' } as Op]);
    expect(r.errors).toEqual([]);
    expect(group(p, 'ön').parent).toBe('araba');
    expect(r.messages.join(' ')).toContain("'araba' grubunun içinde");
    expect(r.messages.join(' ')).not.toContain('grubundan alındı');
    expect(members(p, 'ön')).toEqual(['gövde', 'far']);
    expect(groupParts(p, 'araba').length).toBe(groupParts(p, 'ön').length + groupParts(p, 'sol').length);
    // parent'sız: eski düz anlam — parça eski grubundan alınır, yeni grup en üst düzeyde (Op sözleşmesi).
    const t = project([...corner()]);
    const m = run(t, [{ op: 'group', name: 'tek', parts: ['sol_amortisör'] } as Op]);
    expect(group(t, 'tek').parent).toBeUndefined();
    expect(m.messages.join(' ')).toContain("'sol_amortisör' 'sol' grubundan alındı");
    // Var olan grubun listesinden çıkanlar iletide (sessiz kalmaz).
    const u = project([...corner()]);
    const out = run(u, [{ op: 'group', name: 'sol', parts: ['sol_amortisör'] } as Op]);
    expect(out.messages.join(' ')).toContain("alt grup 'sol_teker' en üst düzeye çıktı");
    expect(group(u, 'sol_teker').parent).toBeUndefined();
    // Var olan grubu başka bir grubun içine taşımak (üyeleri değiştirmeden); döngüler hata ve proje değişmez.
    expect(run(t, [{ op: 'group', name: 'tek', parent: 'sol' } as Op]).errors).toEqual([]);
    expect(group(t, 'tek').parent).toBe('sol');
    const before = JSON.stringify(t);
    expect(run(t, [{ op: 'group', name: 'sol', parent: 'sol_teker' } as Op]).errors.join(' ')).toMatch(/kendi alt grubu 'sol_teker' içine konamaz/);
    expect(run(t, [{ op: 'group', name: 'sol', parent: 'sol' } as Op]).errors.join(' ')).toMatch(/kendi içine konamaz/);
    expect(run(t, [{ op: 'group', name: 'yeni', parts: ['sol'], parent: 'sol_teker' } as Op]).errors.join(' ')).toMatch(/döngü/);
    expect(run(t, [{ op: 'group', name: 'yeni', parts: ['gövde'], parent: 'yok' } as Op]).errors.join(' ')).toMatch(/'yok' adında üst grup bulunamadı/);
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('iç içe gruplar: group / ungroup', () => {
  it('grup içinde grup: listelenen grup alt grup olur; varsayılan pivot alt ağacın kutu merkezi; sahne özetinde parent', () => {
    const p = project([...corner().slice(0, 7), { op: 'group', name: 'sol', parts: ['sol_teker', 'sol_amortisör'], pivot: null }]);
    expect(tree(p)).toEqual([
      ['sol_teker', 'sol'],
      ['sol', null],
    ]);
    expect(members(p, 'sol')).toEqual(['sol_amortisör']);
    expect(members(p, 'sol_teker')).toEqual(['sol_lastik', 'sol_jant', 'sol_tel', 'sol_mil']);
    // Alt ağaç: kendi parçaları + alt grubun parçaları (proje sırasıyla)
    expect(groupParts(p, 'sol').map((x) => x.name)).toEqual(['sol_lastik', 'sol_jant', 'sol_tel', 'sol_mil', 'sol_amortisör']);
    expect(subgroups(p, 'sol').map((g) => g.name)).toEqual(['sol_teker']);
    expect(groupAncestors(p, 'sol_teker').map((g) => g.name)).toEqual(['sol']);
    const c = partsBox(groupParts(p, 'sol'), 16).getCenter(new THREE.Vector3());
    expect(group(p, 'sol').pivot).toEqual({ x: Number(c.x.toFixed(3)), y: Number(c.y.toFixed(3)), z: Number(c.z.toFixed(3)) });
    const s = sceneSummary(p, null);
    expect(s.groups!.map((g) => [g.name, g.parent])).toEqual([
      ['sol_teker', 'sol'],
      ['sol', undefined],
    ]);
    expect('parent' in s.groups![1]).toBe(false);
    expect(s.parts.find((x) => x.name === 'sol_lastik')!.group).toBe('sol_teker'); // doğrudan grup
    // Dosya gidiş-dönüşü onarımsız
    const raw = JSON.parse(projectToJson(p));
    expect(raw.groups[0]).toEqual({ name: 'sol_teker', pivot: { x: 150, y: 130, z: 80 }, parent: 'sol' });
    const warnings: string[] = [];
    expect(parseProject(raw, [], warnings)).toEqual(p);
    expect(warnings).toEqual([]);
  });

  it('ileti alt grubu söyler; başka üst gruptaki grup ve başka gruptaki parça "… grubundan alındı" notuyla taşınır', () => {
    const p = project(corner());
    const r = run(p, [{ op: 'group', name: 'araba', parts: ['sol', 'gövde'], pivot: V(0, 0, 0) }]);
    expect(r.errors).toEqual([]);
    expect(r.messages[0]).toBe("'araba' grubu: 'gövde'; alt grup 'sol'; pivot 0, 0, 0.");
    expect(tree(p)).toEqual([
      ['sol_teker', 'sol'],
      ['sol', 'araba'],
      ['araba', null],
    ]);
    // sol_teker doğrudan arabaya alınır (sol'dan çıkar); sol_amortisör parçası da
    const r2 = run(p, [{ op: 'group', name: 'araba', parts: ['gövde', 'sol', 'sol_teker', 'sol_amortisör'], pivot: null }]);
    expect(r2.errors).toEqual([]);
    expect(r2.messages[0]).toMatch(/'sol_amortisör' 'sol' grubundan alındı, 'sol_teker' grubu 'sol' grubundan alındı/);
    expect(tree(p)).toEqual([
      ['sol_teker', 'araba'],
      ['araba', null],
    ]); // 'sol' alt ağacında parça kalmadı: silindi
    expect(group(p, 'araba').pivot).toEqual({ x: 0, y: 0, z: 0 }); // var olan grupta null pivot değişmez
  });

  it('var olan gruba yeni liste: listede olmayan doğrudan parçalar ve alt gruplar çıkar (en üst düzeye)', () => {
    const p = project([...corner(), { op: 'group', name: 'araba', parts: ['gövde', 'sol'], pivot: null }]);
    const r = run(p, [{ op: 'group', name: 'sol', parts: ['sol_amortisör'], pivot: null }]);
    expect(r.errors).toEqual([]);
    expect(tree(p)).toEqual([
      ['sol_teker', null],
      ['sol', 'araba'],
      ['araba', null],
    ]);
    const q = project([...corner(), { op: 'group', name: 'araba', parts: ['gövde', 'sol'], pivot: null }]);
    run(q, [{ op: 'group', name: 'araba', parts: ['sol'], pivot: null }]);
    expect(part(q, 'gövde').group).toBeUndefined();
    expect(tree(q)).toEqual([
      ['sol_teker', 'sol'],
      ['sol', 'araba'],
      ['araba', null],
    ]);
  });

  it('döngü reddi: grup kendi içine ya da kendi alt ağacındaki bir grubun içine konamaz; proje değişmez', () => {
    const p = project([...corner(), { op: 'group', name: 'araba', parts: ['gövde', 'sol'], pivot: null }]);
    const before = structuredClone(p);
    const err = (ops: Op[]) => run(p, ops).errors.join(' ');
    expect(err([{ op: 'group', name: 'sol', parts: ['sol'], pivot: null }])).toMatch(/'sol' grubu kendi içine konamaz/);
    expect(err([{ op: 'group', name: 'sol_teker', parts: ['sol_lastik', 'sol'], pivot: null }])).toMatch(/'sol' grubu kendi alt grubu 'sol_teker' içine konamaz \(döngü\)/);
    expect(err([{ op: 'group', name: 'sol_teker', parts: ['ARABA'], pivot: null }])).toMatch(/'araba' grubu kendi alt grubu 'sol_teker' içine konamaz/);
    expect(err([{ op: 'group', name: 'sol', parts: ['araba'], pivot: V(1, 2, 3) }])).toMatch(/döngü/);
    expect(p).toEqual(before);
  });

  it('ungroup: doğrudan parçalar ve alt gruplar üst gruba geçer; en üstte serbest kalır', () => {
    const p = project([...corner(), { op: 'group', name: 'araba', parts: ['gövde', 'sol'], pivot: null }]);
    const r = run(p, [{ op: 'ungroup', name: 'sol' }]);
    expect(r.errors).toEqual([]);
    expect(r.messages[0]).toBe("'sol' grubu çözüldü (1 parça, 1 alt grup 'araba' grubuna geçti).");
    expect(tree(p)).toEqual([
      ['sol_teker', 'araba'],
      ['araba', null],
    ]);
    expect(members(p, 'araba')).toEqual(['gövde', 'sol_amortisör']);
    const r2 = run(p, [{ op: 'ungroup', name: 'araba' }]);
    expect(r2.messages[0]).toBe("'araba' grubu çözüldü (2 parça, 1 alt grup serbest).");
    expect(tree(p)).toEqual([['sol_teker', null]]);
    expect(part(p, 'gövde').group).toBeUndefined();
    expect(part(p, 'sol_lastik').group).toBe('sol_teker');
    // İç içe olmayan grupta ileti eskisi gibi
    const r3 = run(p, [{ op: 'ungroup', name: 'sol_teker' }]);
    expect(r3.messages[0]).toBe("'sol_teker' grubu çözüldü (4 parça serbest).");
    expect(p.groups).toBeUndefined();
  });
});

describe('iç içe gruplar: alt ağaç işlemleri', () => {
  it('move: alt ağacın tüm parçaları, grubun ve alt grupların pivotları ötelenir', () => {
    const p = project(corner());
    const before = new Map(p.parts.map((x) => [x.name, { ...x.position }]));
    const r = run(p, [{ op: 'move', part: 'sol', dx: 10, dy: -5, dz: 2 }]);
    expect(r.errors).toEqual([]);
    expect(r.messages[0]).toBe("'sol' grubu taşındı (5 parça, 1 alt grup; Δx 10, Δy -5, Δz 2 mm).");
    for (const x of p.parts) {
      const b = before.get(x.name)!;
      expect(x.position).toEqual(x.name === 'gövde' ? b : { x: b.x + 10, y: b.y - 5, z: b.z + 2 });
    }
    expect(group(p, 'sol').pivot).toEqual({ x: 160, y: 95, z: 152 });
    expect(group(p, 'sol_teker').pivot).toEqual({ x: 160, y: 125, z: 82 });
    // İç grubu taşımak üst grubun pivotunu ve kendi dışındaki parçaları değiştirmez
    run(p, [{ op: 'move', part: 'sol_teker', dx: 0, dy: 0, dz: 10 }]);
    expect(group(p, 'sol').pivot).toEqual({ x: 160, y: 95, z: 152 });
    expect(group(p, 'sol_teker').pivot).toEqual({ x: 160, y: 125, z: 92 });
    expect(part(p, 'sol_amortisör').position).toEqual({ x: 160, y: 85, z: 172 });
    expect(part(p, 'sol_lastik').position).toEqual({ x: 160, y: 125, z: 92 });
  });

  it('rotate: alt ağaç grubun pivotu çevresinde döner; alt grup pivotları da döner, grubun pivotu yerinde kalır', () => {
    const p = project(corner());
    const before = new Map(p.parts.map((x) => [x.name, worldMesh(p, x).pos.slice()]));
    const r = run(p, [{ op: 'rotate', part: 'sol', axis: 'z', degrees: 90 }]);
    expect(r.errors).toEqual([]);
    // (150, 130, 80) − (150, 100, 150) = (0, 30, −70) → Z'de 90°: (−30, 0, −70) → (120, 100, 80)
    expect(group(p, 'sol_teker').pivot).toEqual({ x: 120, y: 100, z: 80 });
    expect(group(p, 'sol').pivot).toEqual({ x: 150, y: 100, z: 150 });
    expect(part(p, 'sol_lastik').position).toEqual({ x: 120, y: 100, z: 80 });
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
    const pv = new THREE.Vector3(150, 100, 150);
    for (const name of ['sol_lastik', 'sol_tel', 'sol_amortisör']) {
      const a = before.get(name)!;
      const b = worldMesh(p, part(p, name)).pos;
      for (let i = 0; i < a.length; i += 3) {
        const v = new THREE.Vector3(a[i], a[i + 1], a[i + 2]).sub(pv).applyQuaternion(q).add(pv);
        expect(Math.hypot(v.x - b[i], v.y - b[i + 1], v.z - b[i + 2])).toBeLessThan(1e-3);
      }
    }
    expect(part(p, 'gövde').rotation).toEqual({ x: 0, y: 0, z: 0 });
    // İç grubu döndürmek yalnızca onun alt ağacını etkiler
    const amort = { ...part(p, 'sol_amortisör').position };
    run(p, [{ op: 'rotate', part: 'sol_teker', axis: 'x', degrees: 30 }]);
    expect(part(p, 'sol_amortisör').position).toEqual(amort);
    expect(group(p, 'sol_teker').pivot).toEqual({ x: 120, y: 100, z: 80 });
  });

  it('update: renk / görünürlük / saydamlık alt ağacın tüm parçalarına', () => {
    const p = project(corner());
    const r = run(p, [{ op: 'update', part: 'sol', color: '#112233', opacity: 0.5 }]);
    expect(r.messages[0]).toBe("'sol' grubu (5 parça, 1 alt grup): renk #112233; opaklık 0,5.");
    expect(groupParts(p, 'sol').every((x) => x.color === '#112233')).toBe(true);
    expect(part(p, 'gövde').color).toBe('#cc3333');
  });

  it('duplicate count=2: alt ağaç kopyalanır; adlar, parent, pivot, cuts kopyaya; kopya kaynağın üst grubunda', () => {
    const p = project([...corner(), { op: 'group', name: 'araba', parts: ['gövde', 'sol'], pivot: V(0, 0, 100) }]);
    const r = run(p, [{ op: 'duplicate', part: 'sol', new_name: 'sol', offset: V(-300, 0, 0), count: 2 }]);
    expect(r.errors).toEqual([]);
    expect(r.messages[0]).toBe("'sol' grubu (5 parça, 1 alt grup) kopyalandı → 'sol 1', 'sol 2' ('araba' grubunda).");
    expect(tree(p)).toEqual([
      ['sol_teker', 'sol'],
      ['sol', 'araba'],
      ['araba', null],
      ['sol 1', 'araba'],
      ['sol 1_teker', 'sol 1'],
      ['sol 2', 'araba'],
      ['sol 2_teker', 'sol 2'],
    ]);
    expect(group(p, 'sol 2').pivot).toEqual({ x: -450, y: 100, z: 150 });
    expect(group(p, 'sol 2_teker').pivot).toEqual({ x: -450, y: 130, z: 80 });
    expect(members(p, 'sol 1_teker')).toEqual(['sol 1_lastik', 'sol 1_jant', 'sol 1_tel', 'sol 1_mil']);
    expect(members(p, 'sol 2')).toEqual(['sol 2_amortisör']);
    expect(part(p, 'sol 2_lastik').position).toEqual({ x: -450, y: 130, z: 80 });
    expect(part(p, 'sol 2_mil').cuts).toEqual([part(p, 'sol 2_jant').id]);
    // kopyanın deliği kopyanın jantını keser (üçgen sayısı özgünle aynı; kesilmeseydi daha az olurdu)
    const tris = (x: Part) => worldMesh(p, x).tris.length;
    expect(tris(part(p, 'sol 2_jant'))).toBe(tris(part(p, 'sol_jant')));
    expect(tris(part(p, 'sol 2_jant'))).toBeGreaterThan(4 * 16);
    const all = [...p.parts.map((x) => x.name), ...p.groups!.map((g) => g.name)].map((s) => s.toLocaleLowerCase('tr'));
    expect(new Set(all).size).toBe(all.length);
    // Varsayılan ad: alt gruplar ve parçalar " kopya" soneki alır, kök kopya aynı üst grupta
    const q = project([...corner(), { op: 'group', name: 'araba', parts: ['gövde', 'sol'], pivot: null }]);
    run(q, [{ op: 'duplicate', part: 'sol_teker', offset: V(0, 0, 200) }]);
    expect(tree(q).slice(-1)).toEqual([['sol_teker kopya', 'sol']]);
    expect(members(q, 'sol_teker kopya')).toEqual(['sol_lastik kopya', 'sol_jant kopya', 'sol_tel kopya', 'sol_mil kopya']);
  });

  it('mirror: alt ağaç aynalanır; alt grup adları önekle, parent kopyada, pivotlar yansır, cuts kopyaya; kardeş', () => {
    const p = project([...corner(), { op: 'group', name: 'araba', parts: ['gövde', 'sol'], pivot: V(0, 0, 100) }]);
    const r = run(p, [{ op: 'mirror', part: 'sol', plane: 'y', at: 0, name: 'sag' }]);
    expect(r.errors).toEqual([]);
    expect(r.messages[0]).toBe("'sol' grubu Y = 0 düzlemine göre aynalandı → 'sag' (5 parça, 1 alt grup; 'araba' grubunda).");
    expect(tree(p).slice(-2)).toEqual([
      ['sag', 'araba'],
      ['sag_teker', 'sag'],
    ]);
    expect(group(p, 'sag').pivot).toEqual({ x: 150, y: -100, z: 150 });
    expect(group(p, 'sag_teker').pivot).toEqual({ x: 150, y: -130, z: 80 });
    expect(members(p, 'sag_teker')).toEqual(['sag_lastik', 'sag_jant', 'sag_tel', 'sag_mil']);
    expect(members(p, 'sag')).toEqual(['sag_amortisör']);
    expect(part(p, 'sag_tel').position).toEqual({ x: 150, y: -162, z: 80 });
    expect(part(p, 'sag_mil').cuts).toEqual([part(p, 'sag_jant').id]);
    // kutular aynalı
    const a = partBox(part(p, 'sol_lastik'), 16);
    const b = partBox(part(p, 'sag_lastik'), 16);
    expect(b.min.y).toBeCloseTo(-a.max.y, 6);
    expect(b.max.y).toBeCloseTo(-a.min.y, 6);
    // Aynayı silmek kaynağı etkilemez
    run(p, [{ op: 'delete', part: 'sag' }]);
    expect(tree(p)).toEqual([
      ['sol_teker', 'sol'],
      ['sol', 'araba'],
      ['araba', null],
    ]);
  });

  it('delete grup adıyla: alt ağacın tüm parçaları ve alt grupları silinir; iç grup silinince üst grup kalır', () => {
    const p = project(corner());
    const sel = part(p, 'sol_tel').id;
    const r = applyOps(p, [{ op: 'delete', part: 'sol' }], sel);
    expect(r.errors).toEqual([]);
    expect(r.messages[0]).toBe("'sol' grubu, 1 alt grubu ve 5 parçası silindi.");
    expect(r.clearSelection).toBe(true);
    expect(p.parts.map((x) => x.name)).toEqual(['gövde']);
    expect(p.groups).toBeUndefined();
    const q = project(corner());
    run(q, [{ op: 'delete', part: 'sol_teker' }]);
    expect(tree(q)).toEqual([['sol', null]]);
    expect(members(q, 'sol')).toEqual(['sol_amortisör']);
  });

  it('budama: alt ağacında parça kalmayan grup silinir; yalnız alt grubu olan grup kalır', () => {
    const p = project(corner());
    run(p, [{ op: 'delete', part: 'sol_amortisör' }]);
    expect(tree(p)).toEqual([
      ['sol_teker', 'sol'],
      ['sol', null],
    ]); // 'sol'un doğrudan parçası yok ama alt grubu dolu
    run(p, [{ op: 'delete', part: 'sol_lastik' }, { op: 'delete', part: 'sol_jant' }, { op: 'delete', part: 'sol_tel' }]);
    expect(tree(p)).toEqual([
      ['sol_teker', 'sol'],
      ['sol', null],
    ]);
    run(p, [{ op: 'delete', part: 'sol_mil' }]);
    expect(p.groups).toBeUndefined();
    // Bellekte bozulmuş veri: var olmayan üst grup kaldırılır, döngü kırılır (sıradaki ilk grubun parent'ı)
    const q = project([box('a', 1, 1, 1, V(0, 0, 0)), box('b', 1, 1, 1, V(5, 0, 0)), { op: 'group', name: 'GA', parts: ['a'] }, { op: 'group', name: 'GB', parts: ['b'] }]);
    q.groups![0].parent = 'yok';
    run(q, [{ op: 'view', show_names: true }]);
    expect(tree(q)).toEqual([
      ['GA', null],
      ['GB', null],
    ]);
    q.groups![0].parent = 'GB';
    q.groups![1].parent = 'GA';
    run(q, [{ op: 'view', show_names: true }]);
    expect(tree(q)).toEqual([
      ['GA', null],
      ['GB', 'GA'],
    ]);
  });
});

describe('iç içe gruplar: proje dosyası', () => {
  const raw = () => ({
    format: 'p3d',
    version: 1,
    name: 'iç içe',
    parts: [
      { id: 'p1', name: 'lastik', shape: 'box', params: { width: 10, depth: 10, height: 10 }, position: V(0, 0, 5), rotation: V(0, 0, 0), color: '#222222', visible: true, group: 'teker' },
      { id: 'p2', name: 'amortisör', shape: 'box', params: { width: 10, depth: 10, height: 10 }, position: V(20, 0, 5), rotation: V(0, 0, 0), color: '#3366cc', visible: true, group: 'köşe' },
    ],
    groups: [
      { name: 'teker', pivot: V(0, 0, 5), parent: 'köşe' },
      { name: 'köşe', pivot: V(10, 0, 5), parent: 'araba' },
      { name: 'araba', pivot: V(0, 0, 0) },
    ],
    view: { showNames: true, showDimensions: true, showHoles: true },
    settings: { resolution: 96, bedX: 256, bedY: 256 },
  });

  it('iç içe dosya onarımsız yüklenir; yalnız alt grubu olan grup (araba) kalır', () => {
    const r = raw();
    const warnings: string[] = [];
    const p = parseProject(r, [], warnings);
    expect(warnings).toEqual([]);
    expect(p).toEqual(r);
    expect(JSON.parse(projectToJson(p))).toEqual(r);
    // İç içe olmayan eski dosya da aynen (parent alanı eklenmez)
    const flat = { ...raw(), groups: [{ name: 'teker', pivot: V(0, 0, 5) }, { name: 'köşe', pivot: V(10, 0, 5) }] };
    expect(parseProject(flat)).toEqual(flat);
    // Elle yazılmış dosyada parent yazımı farklı (büyük harf / aksansız): motorun kuralıyla eşlenir, grubun kendi adı yazılır.
    const typed = { ...raw(), groups: [{ name: 'teker', pivot: V(0, 0, 5), parent: 'KOSE' }, { name: 'köşe', pivot: V(10, 0, 5) }] };
    const w: string[] = [];
    expect(tree(parseProject(typed, [], w))).toEqual([['teker', 'köşe'], ['köşe', null]]);
    expect(w).toEqual([]);
  });

  it('onarım: bilinmeyen, geçersiz, kendine ve döngü kuran parent uyarıyla kaldırılır; alt ağacı boş grup atılır', () => {
    const r = raw();
    r.groups = [
      { name: 'teker', pivot: V(0, 0, 5), parent: 'yok' }, // bilinmeyen → en üst
      { name: 'köşe', pivot: V(10, 0, 5), parent: 'araba' }, // araba ↔ köşe döngüsü: köşe sırada önce → köşenin parent'ı kalkar
      { name: 'araba', pivot: V(0, 0, 0), parent: 'köşe' },
      { name: 'kendi', pivot: V(0, 0, 0), parent: 'kendi' } as never, // üyesi yok → atılır (uyarısı yine verilir)
      { name: 'sayı', pivot: V(0, 0, 0), parent: 5 } as never,
      { name: 'boş üst', pivot: V(0, 0, 0) }, // tek çocuğu da boş → atılır
      { name: 'boş alt', pivot: V(0, 0, 0), parent: 'boş üst' } as never,
    ];
    r.parts.push({ ...r.parts[0], id: 'p3', name: 'sayılı', group: 'sayı' }, { ...r.parts[0], id: 'p4', name: 'şasi', group: 'araba' });
    const warnings: string[] = [];
    const p = parseProject(r, [], warnings);
    expect(warnings).toEqual([
      "grup 'teker': üst grup (parent) 'yok' bulunamadı; kaldırıldı.",
      "grup 'sayı': üst grup (parent) geçersiz (5); kaldırıldı.",
      "grup 'köşe': üst grup (parent) 'araba' döngü kuruyor; kaldırıldı.",
      "grup 'kendi': üst grup (parent) 'kendi' döngü kuruyor; kaldırıldı.",
    ]);
    expect(tree(p)).toEqual([
      ['teker', null],
      ['köşe', null],
      ['araba', 'köşe'],
      ['sayı', null],
    ]);
    expect(p.parts.map((x) => [x.name, x.group])).toEqual([
      ['lastik', 'teker'],
      ['amortisör', 'köşe'],
      ['sayılı', 'sayı'],
      ['şasi', 'araba'],
    ]);
    // Onarılmış dosya kararlı
    expect(parseProject(JSON.parse(projectToJson(p)))).toEqual(p);
  });
});

describe('iç içe gruplar: GLB hiyerarşisi', () => {
  type Node = { name: string; translation?: number[]; children?: number[]; mesh?: number; skin?: number; extras?: { name: string } };
  const glbJson = (bytes: Uint8Array) => {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = dv.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
  };
  const close = (a: number[] | undefined, b: number[]) => b.forEach((v, i) => expect(a![i]).toBeCloseTo(v, 6));
  /** P3D (mm) → glTF (mm birimi): (x, y, z) → (x, z, −y). */
  const gl = (v: { x: number; y: number; z: number }) => [v.x, v.z, -v.y];
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);

  it('düğümler iç içe: alt grup üst grubun çocuğu, çevirisi pivot − üstün pivotu; parça çevirisi merkez − kendi grubunun pivotu', () => {
    const p = project(corner());
    const json = glbJson(buildGlb(p, { units: 'mm' }));
    const nodes = json.nodes as Node[];
    expect(nodes.map((n) => n.name)).toEqual(['gövde', 'sol', 'sol_teker', 'sol_lastik', 'sol_jant', 'sol_tel', 'sol_amortisör']);
    expect(json.scenes[0].nodes).toEqual([0, 1]);
    expect(nodes[1].children).toEqual([2, 6]);
    expect(nodes[2].children).toEqual([3, 4, 5]);
    close(nodes[1].translation, gl(group(p, 'sol').pivot));
    close(nodes[2].translation, sub(gl(group(p, 'sol_teker').pivot), gl(group(p, 'sol').pivot)));
    const center = (name: string) => gl(partBox(part(p, name), 16).getCenter(new THREE.Vector3()));
    close(nodes[5].translation, sub(center('sol_tel'), gl(group(p, 'sol_teker').pivot)));
    close(nodes[6].translation, sub(center('sol_amortisör'), gl(group(p, 'sol').pivot)));
  });

  it("three GLTFLoader: her parçanın dünya kutusu P3D kutusuyla aynı (iç içe çeviriler doğru birikir)", async () => {
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const p = project([...corner(), { op: 'rotate', part: 'sol', axis: 'z', degrees: 30 }]);
    const bytes = buildGlb(p, { units: 'mm' });
    const gltf = await new Promise<{ scene: THREE.Group }>((ok, fail) => new GLTFLoader().parse(bytes.slice().buffer, '', ok as never, fail));
    gltf.scene.updateMatrixWorld(true);
    for (const name of ['gövde', 'sol_lastik', 'sol_tel', 'sol_amortisör']) {
      const got = new THREE.Box3().setFromObject(gltf.scene.getObjectByName(name)!);
      const m = worldMesh(p, part(p, name)).pos;
      const want = new THREE.Box3();
      for (let i = 0; i < m.length; i += 3) want.expandByPoint(new THREE.Vector3(m[i], m[i + 2], -m[i + 1]));
      expect(got.min.distanceTo(want.min)).toBeLessThan(1e-3);
      expect(got.max.distanceTo(want.max)).toBeLessThan(1e-3);
    }
  });

  it('iskelet: eklem hiyerarşisi iç içe, çeviriler göreli, inverseBind dünya pivotunun tersi, köşeler doğrudan grubun eklemine', async () => {
    const p = project([...corner(), { op: 'group', name: 'araba', parts: ['gövde', 'sol'], pivot: V(0, 0, 100) }]);
    const bytes = buildGlb(p, { skeleton: true, units: 'mm' });
    const json = glbJson(bytes);
    const nodes = json.nodes as Node[];
    const skin = json.skins[0];
    const joints = skin.joints.map((j: number) => nodes[j]);
    expect(joints.map((n: Node) => n.name)).toEqual(['root', 'araba', 'sol', 'sol_teker']);
    expect(joints.slice(1).map((n: Node) => n.extras!.name)).toEqual(['araba', 'sol', 'sol_teker']);
    expect(nodes[skin.joints[0]].children).toEqual([skin.joints[1]]);
    expect(nodes[skin.joints[1]].children).toEqual([skin.joints[2]]);
    expect(nodes[skin.joints[2]].children).toEqual([skin.joints[3]]);
    close(joints[1].translation, gl(group(p, 'araba').pivot));
    close(joints[2].translation, sub(gl(group(p, 'sol').pivot), gl(group(p, 'araba').pivot)));
    close(joints[3].translation, sub(gl(group(p, 'sol_teker').pivot), gl(group(p, 'sol').pivot)));
    // three: kemik dünya konumları pivotlar; inverseBind × kemik dünyası = birim (bağlama pozu tutarlı)
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new Promise<{ scene: THREE.Group }>((ok, fail) => new GLTFLoader().parse(bytes.slice().buffer, '', ok as never, fail));
    gltf.scene.updateMatrixWorld(true);
    const meshes: THREE.SkinnedMesh[] = [];
    gltf.scene.traverse((o) => (o as THREE.SkinnedMesh).isSkinnedMesh && meshes.push(o as THREE.SkinnedMesh));
    expect(meshes.length).toBeGreaterThan(0);
    const sk = meshes[0].skeleton;
    expect(sk.bones.map((b) => b.name)).toEqual(['root', 'araba', 'sol', 'sol_teker']);
    expect(sk.bones[3].parent).toBe(sk.bones[2]);
    expect(sk.bones[2].parent).toBe(sk.bones[1]);
    const pivots = [V(0, 0, 0), group(p, 'araba').pivot, group(p, 'sol').pivot, group(p, 'sol_teker').pivot];
    sk.bones.forEach((b, i) => {
      const w = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
      close(w.toArray(), gl(pivots[i]));
      const id = sk.boneInverses[i].clone().multiply(b.matrixWorld);
      id.elements.forEach((v, k) => expect(v).toBeCloseTo(new THREE.Matrix4().elements[k], 5));
    });
    // Köşe eklemleri: renk → parça → doğrudan grubun eklemi (gövde → araba, amortisör → sol, lastik/jant/tel → sol_teker)
    const jointOfColor: Record<string, number> = { cc3333: 1, '3366cc': 2, '222222': 3, bbbbbb: 3, '999999': 3 };
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const binStart = 20 + dv.getUint32(12, true) + 8;
    for (const pr of json.meshes[0].primitives) {
      const color = json.materials[pr.material].name.replace('P3D_', '');
      const acc = json.accessors[pr.attributes.JOINTS_0];
      const view = json.bufferViews[acc.bufferView];
      const j = bytes.subarray(binStart + view.byteOffset, binStart + view.byteOffset + acc.count * 4);
      for (let i = 0; i < j.length; i += 4) expect(j[i]).toBe(jointOfColor[color]);
    }
  });

  it('parts süzgeci: grup adı alt ağacın tamamı; iç grup seçilince üst grupları da düğüm olarak yazılır (hiyerarşi korunur)', () => {
    const p = project(corner());
    expect(selectParts(p, ['sol']).map((x) => x.name)).toEqual(['sol_lastik', 'sol_jant', 'sol_tel', 'sol_amortisör']);
    expect(selectParts(p, ['sol_teker']).map((x) => x.name)).toEqual(['sol_lastik', 'sol_jant', 'sol_tel']);
    const json = glbJson(buildGlb(p, { parts: ['sol_teker'] }));
    expect((json.nodes as Node[]).map((n) => n.name)).toEqual(['sol', 'sol_teker', 'sol_lastik', 'sol_jant', 'sol_tel']);
    expect(json.scenes[0].nodes).toEqual([0]);
    const rig = glbJson(buildGlb(p, { parts: ['sol_teker'], skeleton: true }));
    expect(rig.skins[0].joints.map((j: number) => rig.nodes[j].name)).toEqual(['root', 'sol', 'sol_teker']);
  });
});

describe('iç içe gruplar: birleştirme ve girişim', () => {
  it('combineProjects parent adlarını da önekler', () => {
    const p = project(corner());
    const out = combineProjects([{ project: p, prefix: 'a' }, { project: p, prefix: 'b', offset: V(1000, 0, 0) }]);
    expect(tree(out)).toEqual([
      ['a/sol_teker', 'a/sol'],
      ['a/sol', null],
      ['b/sol_teker', 'b/sol'],
      ['b/sol', null],
    ]);
    expect(out.groups![2].pivot).toEqual({ x: 1150, y: 130, z: 80 });
    expect(parseProject(JSON.parse(projectToJson(out)))).toEqual(out);
    expect(selectParts(out, ['b/sol']).map((x) => x.name)).toEqual(['b/sol_lastik', 'b/sol_jant', 'b/sol_tel', 'b/sol_amortisör']);
  });

  it('girişim byGroup: gövde parçanın doğrudan grubu; parts seçiminde grup alt ağacı', () => {
    // amortisör tekerin lastiğine ~10 mm gömülü; tel ve jant lastikle örtüşür (aynı alt grup)
    const p = project([
      ...corner().slice(1, 6),
      box('sol_amortisör', 20, 20, 120, V(150, 130, 210), { color: '#3366cc' }),
      { op: 'group', name: 'sol', parts: ['sol_teker', 'sol_amortisör'], pivot: null },
    ]);
    const g = interferences(p, { byGroup: true });
    expect(g.pairs.map((i) => [i.a, i.b].sort().join('+'))).toEqual(['sol+sol_teker']);
    expect(interferences(p, { byGroup: true, parts: ['sol_teker'] }).pairs).toHaveLength(1);
    // Parça modunda 'sol' seçimi alt grubun parçalarını da içerir (lastik + tel çifti yalnızca alt ağaçla seçilir)
    const pairs = interferences(p, { parts: ['sol'] }).pairs.map((i) => [i.a, i.b].sort().join('+'));
    expect(pairs).toContain('sol_lastik+sol_tel');
    expect(pairs).toContain('sol_amortisör+sol_lastik');
  });
});
