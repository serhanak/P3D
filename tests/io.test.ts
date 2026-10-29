import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { SHAPES } from '../shared/ops';
import { getAsset } from '../src/assets';
import { initCsg } from '../src/csg';
import { applyOps, partVolume } from '../src/engine';
import { buildObj, parseProject, projectToJson } from '../src/io';
import { newProject } from '../src/types';

beforeAll(() => initCsg()); // örnekler çerçeve ve delik kullanır

/** OBJ metnini nesnelere ayırır: her nesnenin köşe ve üçgen listesi. */
function parseObj(text: string) {
  const verts: number[][] = [];
  const objects: { name: string; faces: number[][] }[] = [];
  for (const line of text.split('\n')) {
    const [tag, ...rest] = line.trim().split(/\s+/);
    if (tag === 'v') verts.push(rest.map(Number));
    else if (tag === 'o') objects.push({ name: rest.join(' '), faces: [] });
    else if (tag === 'f') objects[objects.length - 1].faces.push(rest.map((s) => parseInt(s, 10) - 1));
  }
  return { verts, objects };
}

function checkSolid(verts: number[][], faces: number[][]) {
  // Kapalı ve tutarlı yönlü ağ: her yönlü kenar tam bir kez, tersi de tam bir kez bulunmalı.
  const directed = new Map<string, number>();
  for (const [a, b, c] of faces) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) directed.set(`${u}>${v}`, (directed.get(`${u}>${v}`) ?? 0) + 1);
  }
  let bad = 0;
  for (const [k, n] of directed) {
    const [u, v] = k.split('>');
    if (n !== 1 || directed.get(`${v}>${u}`) !== 1) bad++;
  }
  // İşaretli hacim (dışa bakan normallerle pozitif olmalı)
  let vol = 0;
  for (const [a, b, c] of faces) {
    const [p, q, r] = [verts[a], verts[b], verts[c]];
    vol += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
  }
  return { bad, vol };
}

describe('OBJ dışa aktarımı', () => {
  it('her şekil kapalı, doğru yönlü ve hacmi analitik değere yakın', () => {
    const p = newProject();
    p.settings.resolution = 128;
    const shapes = SHAPES.filter((x) => x !== 'mesh'); // mesh yalnızca içe aktarmayla eklenir
    applyOps(p, shapes.map((shape) => ({ op: 'create' as const, shape })), null);
    applyOps(p, [{ op: 'rotate', part: 'Silindir 1', axis: 'x', degrees: 37 }], null);
    const { obj, mtl } = buildObj(p.parts, p, 'model.mtl');
    const { verts, objects } = parseObj(obj);
    expect(objects).toHaveLength(shapes.length);
    for (const [i, o] of objects.entries()) {
      const part = p.parts[i];
      const { bad, vol } = checkSolid(verts, o.faces);
      expect(bad, `${part.shape}: açık/ters kenar`).toBe(0);
      expect(vol / partVolume(part), `${part.shape}: hacim`).toBeGreaterThan(0.98);
      expect(vol / partVolume(part), `${part.shape}: hacim`).toBeLessThan(1.001);
    }
    expect(obj).toContain('mtllib model.mtl');
    expect(mtl.match(/newmtl/g)).toHaveLength(shapes.length);
  });

  it('Türkçe isimler ASCII nesne adına çevrilir, MTL olmadan renk satırı yazılmaz', () => {
    const p = newProject();
    applyOps(p, [{ op: 'create', shape: 'box', name: 'Şaft Gövdesi' }], null);
    const { obj } = buildObj(p.parts, p, null);
    expect(obj).toContain('o Saft_Govdesi');
    expect(obj).not.toContain('usemtl');
    expect(obj).not.toContain('mtllib');
  });
});

describe('proje dosyası', () => {
  it('kaydet → yükle aynı projeyi verir', () => {
    const p = newProject('Deneme');
    applyOps(
      p,
      [
        { op: 'create', shape: 'tube', name: 'burç', color: '#ff8800' },
        { op: 'create', shape: 'prism', params: [{ name: 'sides', value: 8 }] },
        { op: 'update', part: 'burç', visible: false },
        { op: 'view', show_names: false },
      ],
      null,
    );
    const back = parseProject(JSON.parse(projectToJson(p)));
    expect(back).toEqual(p);
  });

  it('bozuk/eksik alanlar onarılır, yabancı dosya reddedilir', () => {
    const fixed = parseProject({
      format: 'p3d',
      parts: [
        { shape: 'cylinder', params: { diameter: -5 }, color: 'mavi' },
        { shape: 'pyramid' },
        { shape: 'box', id: 'a' },
        { shape: 'box', id: 'a' },
      ],
    });
    expect(fixed.parts).toHaveLength(3);
    expect(fixed.parts[0].params.diameter).toBeGreaterThan(0);
    expect(fixed.parts[0].color).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(fixed.parts.map((x) => x.id)).size).toBe(3);
    expect(() => parseProject({ hello: 1 })).toThrow();
  });
});

describe('örnek projeler (examples/)', () => {
  const dir = new URL('../examples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.p3d.json'));

  it('en az bir örnek var', () => expect(files.length).toBeGreaterThan(0));

  it.each(files)('%s onarım gerekmeden yüklenir ve her parçası kapalı ağ olarak dışa aktarılır', (file) => {
    const { assets, ...raw } = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const p = parseProject({ ...raw, assets });
    expect(p).toEqual(raw); // ağ verisi (assets) projeye değil depoya alınır
    for (const id of Object.keys(assets ?? {})) expect(getAsset(id)?.triangles).toBeGreaterThan(0);
    const { verts, objects } = parseObj(buildObj(p.parts, p, null).obj);
    expect(objects).toHaveLength(p.parts.filter((x) => x.visible).length);
    for (const o of objects) expect(checkSolid(verts, o.faces).bad, o.name).toBe(0);
  });
});
