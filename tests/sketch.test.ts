import { describe, expect, it, vi } from 'vitest';
import type { Op, SketchPath, SketchPlane, SketchPoint } from '../shared/ops';
import { applyOps, sceneSummary } from '../src/engine';
import { parseProject, projectToJson } from '../src/io';
import { isCurved, isPlanar, pathBox, pathLength, pathProfile, planeFromPoints, samplePath, sketchKind, toPlane2D } from '../src/sketch';
import { Store } from '../src/store';
import { newProject, type Project } from '../src/types';

// Eskiz: kullanıcının çizdiği niyet yolları (geometri üretmez). Motor işlemleri, özet, örnekleme, dosya ve seçim.

const P = (x: number, y: number, z: number): SketchPoint => ({ p: { x, y, z } });
/** z düzleminde 40 × 20 dikdörtgen (−20…20, −10…10). */
const rect = (z = 0): SketchPoint[] => [P(-20, -10, z), P(20, -10, z), P(20, 10, z), P(-20, 10, z)];
const run = (p: Project, ops: Op[]) => applyOps(p, ops, null);

/** r yarıçaplı, z = 0'da, saat yönünün tersine dört çeyrek Bezier'den çember (k = 0,5523·r tutamaçlar). */
function circle(r: number): SketchPath {
  const k = 0.5523 * r;
  const v = (x: number, y: number) => ({ x: x + 0, y: y + 0, z: 0 }); // + 0: -0 yerine 0 (JSON gidiş-dönüşü eşit kalsın)
  const points = [0, 90, 180, 270].map((deg) => {
    const t = (deg * Math.PI) / 180;
    const [tx, ty] = [-Math.sin(t), Math.cos(t)]; // teğet
    return { p: v(r * Math.cos(t), r * Math.sin(t)), hIn: v(-k * tx, -k * ty), hOut: v(k * tx, k * ty) };
  });
  return { id: 'c', name: 'çember', closed: true, plane: { axis: 'z', at: 0 }, points };
}

describe('sketch_add', () => {
  it('otomatik ad "Yol N" (boşalan en küçük numara), tür ve düzlemli mesaj; parça seçimine dokunmaz', () => {
    const p = newProject();
    const r = run(p, [
      { op: 'sketch_add', closed: true, points: [...rect(), P(-25, 0, 0)] },
      { op: 'sketch_add', points: [P(0, 0, 5), P(0, 0, 17)] },
      { op: 'sketch_add', name: '', points: [P(1, 2, 3)] },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.messages).toEqual([
      "'Yol 1' eskizi eklendi: kapalı çokgen, 5 nokta, düzlem z = 0.",
      "'Yol 2' eskizi eklendi: ok, 2 nokta, düzlem y = 0.",
      "'Yol 3' eskizi eklendi: işaret, 1 nokta, düzlem z = 3.",
    ]);
    expect(r.lastSketchId).toBe(p.sketch![2].id);
    expect(r.lastPartId).toBeNull();
    expect(p.sketch![0]).toEqual({ id: p.sketch![0].id, name: 'Yol 1', closed: true, plane: { axis: 'z', at: 0 }, points: [...rect(), P(-25, 0, 0)] });
    run(p, [{ op: 'sketch_delete', path: 'Yol 2' }]);
    run(p, [{ op: 'sketch_add', points: [P(0, 0, 0)] }, { op: 'sketch_add', points: [P(0, 0, 0)] }]);
    expect(p.sketch!.map((s) => s.name)).toEqual(['Yol 1', 'Yol 3', 'Yol 2', 'Yol 4']);
  });

  it('ad çakışması benzersizleştirilir (büyük/küçük harf ve aksan duyarsız); parça adlarıyla çakışabilir', () => {
    const p = newProject();
    run(p, [{ op: 'create', shape: 'box', name: 'kapak' }]);
    const r = run(p, [
      { op: 'sketch_add', name: 'kapak', points: [P(0, 0, 0)] },
      { op: 'sketch_add', name: ' kapak ', points: [P(0, 0, 0)] },
      { op: 'sketch_add', name: 'KAPAK', points: [P(0, 0, 0)] },
      { op: 'sketch_add', name: 'Çizgi', points: [P(0, 0, 0)] },
      { op: 'sketch_add', name: 'cizgi', points: [P(0, 0, 0)] },
    ]);
    expect(r.errors).toEqual([]);
    expect(p.sketch!.map((s) => s.name)).toEqual(['kapak', 'kapak 2', 'KAPAK 3', 'Çizgi', 'cizgi 2']);
    expect(p.parts.map((x) => x.name)).toEqual(['kapak']);
  });

  it('düzlem: verilmezse noktalardan (z → y → x eşitliği, yoksa en küçük z), verilirse aynen', () => {
    expect(planeFromPoints(rect(4))).toEqual({ axis: 'z', at: 4 });
    expect(planeFromPoints([P(0, 3, 0), P(10, 3, 5), P(4, 3, 9)])).toEqual({ axis: 'y', at: 3 });
    expect(planeFromPoints([P(5, 0, 0), P(5, 10, 0), P(5, 10, 10)])).toEqual({ axis: 'x', at: 5 });
    expect(planeFromPoints([P(0, 0, 3), P(10, 5, 1), P(4, 8, 7)])).toEqual({ axis: 'z', at: 1 });
    const p = newProject();
    run(p, [
      { op: 'sketch_add', points: [P(0, 0, 3), P(10, 5, 1), P(4, 8, 7)] },
      { op: 'sketch_add', points: rect(2), plane: { axis: 'x', at: -7 } },
      { op: 'sketch_add', points: rect(2), plane: null },
    ]);
    expect(p.sketch!.map((s) => s.plane)).toEqual([
      { axis: 'z', at: 1 },
      { axis: 'x', at: -7 },
      { axis: 'z', at: 2 },
    ]);
  });
});

describe('sketch_update', () => {
  it('nokta / not / ad / kapalı değişir; "" notu siler; null alan değişmez; başka yolun adı hata ve yol değişmez', () => {
    const p = newProject();
    run(p, [
      { op: 'sketch_add', closed: true, note: 'kapak', points: rect() },
      { op: 'sketch_add', name: 'ok', points: [P(0, 0, 0), P(10, 0, 0)] },
    ]);
    const [id1, id2] = p.sketch!.map((s) => s.id);
    let r = run(p, [{ op: 'sketch_update', path: 'yol 1', points: rect(2), note: '  kapak, 3 mm ' }]);
    expect(r.messages).toEqual(["'Yol 1' eskizi güncellendi (düzlem z = 2, nokta, not)."]);
    expect(r.lastSketchId).toBe(id1);
    expect(p.sketch![0].points).toEqual(rect(2));
    expect(p.sketch![0].note).toBe('kapak, 3 mm');
    // Yeni noktaların hepsi düzlem ekseninde aynı konumda: yol normal yönünde taşındı, düzlem onunla gider.
    expect(p.sketch![0].plane).toEqual({ axis: 'z', at: 2 });
    // Düzlem ekseninde farklı konumlar: düzlem yerinde kalır.
    const tilted = [P(-20, -10, 2), P(20, -10, 7), P(20, 10, 7), P(-20, 10, 2)];
    r = run(p, [{ op: 'sketch_update', path: 'Yol 1', points: tilted }]);
    expect(r.messages).toEqual(["'Yol 1' eskizi güncellendi (nokta)."]);
    expect(p.sketch![0].plane).toEqual({ axis: 'z', at: 2 });
    // 1e-6 içindeki fark aynı konum sayılır (ilk noktanınki); açıkça verilen düzlem noktalardan önce gelir.
    r = run(p, [{ op: 'sketch_update', path: 'Yol 1', points: [P(-20, -10, 5), P(20, -10, 5 + 5e-7), P(20, 10, 5), P(-20, 10, 5)] }]);
    expect(r.messages).toEqual(["'Yol 1' eskizi güncellendi (düzlem z = 5, nokta)."]);
    expect(p.sketch![0].plane).toEqual({ axis: 'z', at: 5 });
    r = run(p, [{ op: 'sketch_update', path: 'Yol 1', points: rect(9), plane: { axis: 'z', at: 5 } }]);
    expect(p.sketch![0].plane).toEqual({ axis: 'z', at: 5 });

    r = run(p, [{ op: 'sketch_update', path: 'Yol 1', note: '' }]);
    expect(r.messages).toEqual(["'Yol 1' eskizi güncellendi (not silindi)."]);
    expect('note' in p.sketch![0]).toBe(false);

    r = run(p, [{ op: 'sketch_update', path: id1, name: 'Kapak', closed: false, plane: { axis: 'z', at: 2 } }]);
    expect(r.messages).toEqual(["'Yol 1' eskizi güncellendi (ad → 'Kapak', açık, düzlem z = 2)."]);
    expect(p.sketch![0]).toMatchObject({ name: 'Kapak', closed: false, plane: { axis: 'z', at: 2 } });

    const before = JSON.stringify(p.sketch);
    r = run(p, [{ op: 'sketch_update', path: 'Kapak', name: 'OK', closed: true, note: 'x' }]);
    expect(r.errors).toEqual(["'OK' adında başka bir eskiz yolu var; başka bir ad verin."]);
    expect(JSON.stringify(p.sketch)).toBe(before); // doğrulama değişiklikten önce: yarım güncelleme yok

    r = run(p, [{ op: 'sketch_update', path: 'Kapak', name: 'kapak', closed: null, plane: null, points: null, note: null }]);
    expect(r.errors).toEqual([]);
    expect(p.sketch![0].name).toBe('kapak'); // kendi adının büyük/küçük harf değişimi serbest
    r = run(p, [{ op: 'sketch_update', path: id2 }]);
    expect(r.messages).toEqual(["'ok' eskizi değişmedi."]);
  });

  it('kapalı yol 3 noktanın altına inince açık olur; az noktalı yol kapatılamaz (sketch_add dahil)', () => {
    const p = newProject();
    run(p, [{ op: 'sketch_add', closed: true, points: [P(0, 0, 0), P(10, 0, 0), P(10, 10, 0)] }]);
    expect(sketchKind(p.sketch![0])).toBe('polygon');
    let r = run(p, [{ op: 'sketch_update', path: 'Yol 1', points: [P(0, 0, 0), P(10, 0, 0)] }]); // bir nokta silindi
    expect(r.messages).toEqual(["'Yol 1' eskizi güncellendi (açık, nokta). Kapalı yol en az 3 nokta ister; yol açık."]);
    expect(p.sketch![0].closed).toBe(false);
    expect(sketchKind(p.sketch![0])).toBe('arrow');
    r = run(p, [{ op: 'sketch_update', path: 'Yol 1', closed: true }]);
    expect(r.messages).toEqual(["'Yol 1' eskizi değişmedi. Kapalı yol en az 3 nokta ister; yol açık."]);
    expect(p.sketch![0].closed).toBe(false);
    // Nokta 3'e çıkınca kendiliğinden kapanmaz; açıkça kapatılır.
    r = run(p, [{ op: 'sketch_update', path: 'Yol 1', points: [P(0, 0, 0), P(10, 0, 0), P(10, 10, 0)] }]);
    expect(r.messages).toEqual(["'Yol 1' eskizi güncellendi (nokta)."]);
    r = run(p, [{ op: 'sketch_update', path: 'Yol 1', closed: true }]);
    expect(r.messages).toEqual(["'Yol 1' eskizi güncellendi (kapalı)."]);
    expect(sketchKind(p.sketch![0])).toBe('polygon');

    r = run(p, [{ op: 'sketch_add', closed: true, points: [P(0, 0, 0), P(5, 0, 0)] }]);
    expect(r.messages).toEqual(["'Yol 2' eskizi eklendi: ok, 2 nokta, düzlem z = 0. Kapalı yol en az 3 nokta ister; yol açık."]);
    expect(p.sketch![1].closed).toBe(false);
  });
});

describe('sketch_move', () => {
  it('indisli noktalar taşınır, tutamaçlar göreli kalır; tümü taşınınca düzlem de kayar; aralık dışı indis hata', () => {
    const p = newProject();
    run(p, [
      {
        op: 'sketch_add',
        name: 'eğri',
        points: [{ p: { x: 0, y: 0, z: 0 }, hOut: { x: 5, y: 0, z: 0 } }, { p: { x: 10, y: 0, z: 0 }, hIn: { x: -5, y: 5, z: 0 } }, P(10, 10, 0)],
      },
    ]);
    let r = run(p, [{ op: 'sketch_move', path: 'egri', indices: [1, 2, 2], dx: 0, dy: 0, dz: 15 }]);
    expect(r.messages).toEqual(["'eğri' eskizinde 2 nokta taşındı (dz = 15)."]);
    const s = p.sketch![0];
    expect(s.points.map((q) => q.p)).toEqual([{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 15 }, { x: 10, y: 10, z: 15 }]);
    expect(s.points[1].hIn).toEqual({ x: -5, y: 5, z: 0 });
    expect(s.points[0].hOut).toEqual({ x: 5, y: 0, z: 0 });
    expect(s.plane).toEqual({ axis: 'z', at: 0 }); // yalnızca bazı noktalar: düzlem yerinde

    r = run(p, [{ op: 'sketch_move', path: 'eğri', indices: [], dx: 1.5, dy: -2, dz: 5 }]);
    expect(r.messages).toEqual(["'eğri' eskizinde 3 nokta taşındı (dx = 1,5, dy = -2, dz = 5)."]);
    expect(p.sketch![0].points.map((q) => q.p)).toEqual([{ x: 1.5, y: -2, z: 5 }, { x: 11.5, y: -2, z: 20 }, { x: 11.5, y: 8, z: 20 }]);
    expect(p.sketch![0].plane).toEqual({ axis: 'z', at: 5 });

    r = run(p, [
      { op: 'sketch_move', path: 'eğri', indices: [3], dx: 1, dy: 0, dz: 0 },
      { op: 'sketch_move', path: 'eğri', indices: [-1], dx: 1, dy: 0, dz: 0 },
      { op: 'sketch_move', path: 'eğri', indices: [0.5], dx: 1, dy: 0, dz: 0 },
    ]);
    expect(r.errors).toEqual([
      "'eğri' eskizinde nokta indisi 3 geçersiz (0–2 arası olmalı).",
      "'eğri' eskizinde nokta indisi -1 geçersiz (0–2 arası olmalı).",
      "'eğri' eskizinde nokta indisi 0.5 geçersiz (0–2 arası olmalı).",
    ]);
    expect(p.sketch![0].points[0].p).toEqual({ x: 1.5, y: -2, z: 5 });
  });
});

describe('sketch_delete', () => {
  it('tek yol / tümü silinir; boş kalan dizi alanı kalkar; eskiz yokken tümünü silmek hata değil', () => {
    const p = newProject();
    run(p, [{ op: 'sketch_add', points: [P(0, 0, 0)] }, { op: 'sketch_add', points: [P(1, 0, 0)] }, { op: 'sketch_add', points: [P(2, 0, 0)] }]);
    let r = run(p, [{ op: 'sketch_delete', path: 'YOL 2' }]);
    expect(r.messages).toEqual(["'Yol 2' eskizi silindi."]);
    expect(r.lastSketchId).toBeNull();
    expect(p.sketch!.map((s) => s.name)).toEqual(['Yol 1', 'Yol 3']);
    r = run(p, [{ op: 'sketch_delete' }]);
    expect(r.messages).toEqual(['2 eskiz yolu silindi.']);
    expect('sketch' in p).toBe(false);
    r = run(p, [{ op: 'sketch_delete', path: '' }]);
    expect(r).toMatchObject({ messages: ['Silinecek eskiz yok.'], errors: [] });

    run(p, [{ op: 'sketch_add', points: [P(0, 0, 0)] }]);
    r = run(p, [{ op: 'sketch_delete', path: p.sketch![0].id }]);
    expect(r.messages).toEqual(["'Yol 1' eskizi silindi."]);
    expect('sketch' in p).toBe(false);
    // Ekleyip aynı listede silmek: son dokunulan yol kalmadı.
    r = run(p, [{ op: 'sketch_add', points: [P(0, 0, 0)] }, { op: 'sketch_delete' }]);
    expect(r.messages[1]).toBe("'Yol 1' eskizi silindi.");
    expect(r.lastSketchId).toBeNull();
  });
});

describe('geçersiz eskiz girdisi', () => {
  it('her hata errors\'a düşer, diğer işlemler (parça işlemleri dahil) sürer', () => {
    const p = newProject();
    const r = run(p, [
      { op: 'sketch_add', points: [] },
      { op: 'sketch_add', points: [{ p: { x: NaN, y: 0, z: 0 } }] },
      { op: 'sketch_add', points: Array.from({ length: 1001 }, (_, i) => P(i, 0, 0)) },
      { op: 'sketch_add', points: [{ p: { x: 0, y: 0, z: 0 }, hOut: { x: Infinity, y: 0, z: 0 } }] },
      { op: 'sketch_update', path: 'yok', note: 'x' },
      { op: 'create', shape: 'box', name: 'k' },
      { op: 'sketch_add', name: 'iyi', points: Array.from({ length: 1000 }, (_, i) => P(i, 0, 0)) },
      { op: 'sketch_move', path: 'iyi', dx: Infinity, dy: 0, dz: 0 },
      { op: 'sketch_add', name: 'x'.repeat(61), points: [P(0, 0, 0)] },
      { op: 'sketch_add', points: [P(0, 0, 0)], plane: { axis: 'w', at: 0 } as unknown as SketchPlane },
      { op: 'sketch_add', points: [P(0, 0, 0)], note: 'n'.repeat(201) },
      { op: 'sketch_delete', path: 'olmayan' },
    ]);
    expect(r.errors).toEqual([
      'Eskiz noktaları geçersiz: en az 1 nokta gerekli.',
      'Eskiz noktaları geçersiz: 1. nokta geçersiz ({"p": {"x", "y", "z"}} sonlu sayılar olmalı).',
      'Eskiz noktaları geçersiz: en fazla 1000 nokta olabilir (1001 verildi).',
      'Eskiz noktaları geçersiz: 1. noktanın hOut tutamacı geçersiz ({"x", "y", "z"} sonlu sayılar olmalı).',
      "'yok' adında eskiz yolu bulunamadı (eskiz yok).",
      'Geçersiz kaydırma: dx, dy, dz sonlu sayı olmalı.',
      'Eskiz adı en fazla 60 karakter olabilir (61).',
      'Geçersiz eskiz düzlemi: {"axis": "x" | "y" | "z", "at": sayı} olmalı.',
      'Eskiz notu en fazla 200 karakter olabilir (201).',
      "'olmayan' adında eskiz yolu bulunamadı (var olanlar: 'iyi').",
    ]);
    expect(p.parts.map((x) => x.name)).toEqual(['k']);
    expect(p.sketch!.map((s) => [s.name, s.points.length])).toEqual([['iyi', 1000]]);
    expect(p.sketch![0].points[0].p).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('sahne özeti (sceneSummary.sketch)', () => {
  it('eskiz yokken alan yok; türler, uzunluk/çevre, ok yönü, kutu, not; eğride polyline', () => {
    const p = newProject();
    expect('sketch' in sceneSummary(p, null)).toBe(false);
    run(p, [
      { op: 'sketch_add', points: [P(1.234, 5.678, 0)], note: 'vida' },
      { op: 'sketch_add', points: [P(0, 0, 5), P(0, 0, 17)] },
      { op: 'sketch_add', points: [P(0, 0, 0), P(3, 4, 0), P(3, 10, 0)] },
      { op: 'sketch_add', closed: true, points: rect() },
      { op: 'sketch_add', closed: true, points: [P(0, 0, 0), P(1, 0, 0)] },
      { op: 'sketch_add', points: [P(0, 0, 0), P(3, 4, 0)], plane: { axis: 'z', at: 0 } },
    ]);
    p.sketch!.push({ ...circle(10), id: 'c1', name: 'Yol 7' });
    const s = sceneSummary(p, null).sketch!;
    expect(s.map((k) => k.kind)).toEqual(['marker', 'arrow', 'line', 'polygon', 'arrow', 'arrow', 'polygon']);
    expect(s[0]).toEqual({
      id: p.sketch![0].id,
      name: 'Yol 1',
      kind: 'marker',
      closed: false,
      plane: { axis: 'z', at: 0 },
      points: [{ p: { x: 1.23, y: 5.68, z: 0 } }],
      bbox: { min: { x: 1.23, y: 5.68, z: 0 }, max: { x: 1.23, y: 5.68, z: 0 } },
      note: 'vida',
    });
    expect(s[1]).toMatchObject({ kind: 'arrow', length: 12, direction: { x: 0, y: 0, z: 1 } });
    expect(s[2]).toMatchObject({ kind: 'line', length: 11 });
    expect(s[3]).toMatchObject({ kind: 'polygon', length: 120, bbox: { min: { x: -20, y: -10, z: 0 }, max: { x: 20, y: 10, z: 0 } } });
    // Kapalı istenen iki nokta: kapalı yol en az 3 nokta ister, ok olur.
    expect(s[4]).toMatchObject({ kind: 'arrow', closed: false, length: 1, direction: { x: 1, y: 0, z: 0 } });
    expect(s[5].direction).toEqual({ x: 0.6, y: 0.8, z: 0 });
    for (const k of s.slice(0, 6)) expect(k.polyline).toBeUndefined();
    for (const k of s.filter((x) => x.kind !== 'arrow')) expect(k.direction).toBeUndefined();
    const c = s[6];
    expect(c.polyline).toHaveLength(32); // 4 eğri kenar × 8, kapalı: ilk nokta tekrarlanmaz
    expect(c.points[0]).toEqual({ p: { x: 10, y: 0, z: 0 }, hIn: { x: 0, y: -5.52, z: 0 }, hOut: { x: 0, y: 5.52, z: 0 } });
    expect(c.length! / (2 * Math.PI * 10)).toBeCloseTo(1, 2);
    expect(c.bbox.max.y).toBeCloseTo(10, 1);
  });
});

describe('örnekleme ve düzlem yardımcıları', () => {
  it('çeyrek Bezier çember (k = 0,5523): uzunluk ≈ 2πr (%0,2), noktalar çember üstünde; düz kenar örneklenmez', () => {
    const c = circle(10);
    expect(isCurved(c)).toBe(true);
    expect(Math.abs(pathLength(c) / (2 * Math.PI * 10) - 1)).toBeLessThan(0.002);
    const pts = samplePath(c);
    expect(pts).toHaveLength(32);
    expect(pts[0]).toEqual({ x: 10, y: 0, z: 0 });
    for (const v of pts) expect(Math.abs(Math.hypot(v.x, v.y) - 10)).toBeLessThan(0.03);
    expect(samplePath(c, 16)).toHaveLength(64);
    const b = pathBox(c);
    expect(b.max.x).toBeCloseTo(10, 6);
    expect(b.min.y).toBeCloseTo(-10, 6);

    const poly: SketchPath = { id: 'r', name: 'r', closed: true, plane: { axis: 'z', at: 0 }, points: rect() };
    expect(isCurved(poly)).toBe(false);
    expect(samplePath(poly)).toEqual(rect().map((q) => q.p));
    expect(pathLength(poly)).toBe(120);
    const open: SketchPath = { ...poly, closed: false };
    expect(pathLength(open)).toBe(100);
    // Yalnızca bir kenar eğri: o kenar 8 parçaya bölünür, diğerleri düz kalır.
    const mixed: SketchPath = { ...open, points: [{ ...rect()[0], hOut: { x: 5, y: -5, z: 0 } }, ...rect().slice(1)] };
    expect(samplePath(mixed)).toHaveLength(4 + 7);
    // Sıfır tutamaç köşe sayılır; açık yolun ilk hIn'i ve son hOut'u kullanılmaz.
    expect(isCurved({ ...open, points: [{ ...rect()[0], hIn: { x: 9, y: 9, z: 9 }, hOut: { x: 0, y: 0, z: 0 } }, ...rect().slice(1)] })).toBe(false);
    expect(sketchKind(open)).toBe('line');
    expect(sketchKind({ ...open, points: rect().slice(0, 2) })).toBe('arrow');
    expect(sketchKind({ ...poly, points: rect().slice(0, 2) })).toBe('line');
    expect(sketchKind({ ...poly, points: rect().slice(0, 1) })).toBe('marker');
  });

  it('pathProfile / toPlane2D geom eksen kuralı: z → [x, y], x → [y, z], y → [x, z]', () => {
    const v = { x: 1, y: 2, z: 3 };
    expect([toPlane2D(v, 'z'), toPlane2D(v, 'x'), toPlane2D(v, 'y')]).toEqual([[1, 2], [2, 3], [1, 3]]);
    const pts = [P(5, 1, 2), P(5, 3, 4), P(5, 0, 6)];
    expect(pathProfile({ id: 'a', name: 'a', closed: true, plane: { axis: 'x', at: 5 }, points: pts })).toEqual([[1, 2], [3, 4], [0, 6]]);
    expect(pathProfile({ id: 'a', name: 'a', closed: true, plane: { axis: 'y', at: 0 }, points: pts })).toEqual([[5, 2], [5, 4], [5, 6]]);
    expect(pathProfile({ id: 'a', name: 'a', closed: true, plane: { axis: 'z', at: 0 }, points: rect() })).toEqual([[-20, -10], [20, -10], [20, 10], [-20, 10]]);
  });

  it('isPlanar: eğriler dahil; toleransla; önce yolun kendi düzlemi', () => {
    const base: SketchPath = { id: 'a', name: 'a', closed: true, plane: { axis: 'z', at: 0 }, points: rect(2) };
    expect(isPlanar(base)).toEqual({ axis: 'z', at: 2 });
    expect(isPlanar({ ...base, points: [P(0, 0, 0), P(10, 1, 0.004), P(0, 5, 0.008)] })).toEqual({ axis: 'z', at: 0.004 });
    expect(isPlanar({ ...base, points: [P(0, 0, 0), P(10, 1, 1), P(0, 5, 3)] })).toBeNull();
    // Noktalar z = 0'da ama tutamaç düzlemden çıkıyor: eğri z düzleminde değil, y = 0 düzleminde.
    const bent: SketchPath = { ...base, closed: false, points: [{ p: { x: 0, y: 0, z: 0 }, hOut: { x: 0, y: 0, z: 5 } }, P(10, 0, 0)] };
    expect(isPlanar(bent)).toEqual({ axis: 'y', at: 0 });
    // Tek nokta her eksende düzlemsel: yolun kendi ekseni önce gelir.
    expect(isPlanar({ ...base, plane: { axis: 'x', at: 7 }, points: [P(7, 1, 2)] })).toEqual({ axis: 'x', at: 7 });
  });
});

describe('proje dosyası', () => {
  it('kaydet → yükle eskizi korur; eskiz yoksa alan yazılmaz/okunmaz', () => {
    const p = newProject('e');
    run(p, [
      { op: 'create', shape: 'box', name: 'k' },
      { op: 'sketch_add', closed: true, note: 'kapak, 3 mm', points: rect() },
      { op: 'sketch_add', name: 'eğri', points: circle(5).points, closed: true },
    ]);
    const back = parseProject(JSON.parse(projectToJson(p)));
    expect(back).toEqual(p);
    expect(back.sketch).toHaveLength(2);

    const q = newProject();
    run(q, [{ op: 'create', shape: 'box' }, { op: 'sketch_add', points: [P(0, 0, 0)] }, { op: 'sketch_delete' }]);
    expect('sketch' in q).toBe(false);
    const json = JSON.parse(projectToJson(q));
    expect('sketch' in json).toBe(false);
    expect('sketch' in parseProject(json)).toBe(false);
    expect('sketch' in parseProject({ ...json, sketch: [] })).toBe(false);
  });

  it('bozuk yol atlanır ve warnings\'e yazılır (parça kaybı sayılmaz, dropped boş); ad/kimlik/düzlem/not onarılır', () => {
    const dropped: string[] = [];
    const warnings: string[] = [];
    const back = parseProject(
      {
        format: 'p3d',
        parts: [],
        sketch: [
          { name: 'iyi', points: [{ p: { x: 0, y: 0, z: 4 } }], closed: 'evet', plane: { axis: 'q', at: 1 }, note: 5 },
          { name: 'bozuk', points: [{ p: { x: 'a', y: 0, z: 0 } }] },
          { points: [] },
          42,
          { name: 'İYİ', id: 'dup', points: [P(1, 1, 1)], note: 'n'.repeat(250), plane: { axis: 'x', at: 1 } },
          { id: 'dup', points: [P(2, 2, 2)], closed: true },
          { id: '"><img src=x>', points: [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0)], closed: true },
          { id: 'a'.repeat(65), points: [P(0, 0, 0)] },
        ],
      },
      dropped,
      warnings,
    );
    expect(dropped).toEqual([]);
    expect(warnings).toEqual([
      'eskiz \'bozuk\' atlandı: 1. nokta geçersiz ({"p": {"x", "y", "z"}} sonlu sayılar olmalı)',
      'eskiz #3 atlandı: en az 1 nokta gerekli',
      'eskiz #4 atlandı: yol bir nesne değil',
    ]);
    const s = back.sketch!;
    expect(s.map((x) => x.name)).toEqual(['iyi', 'İYİ 2', 'Yol 1', 'Yol 2', 'Yol 3']);
    expect(s[0]).toEqual({ id: s[0].id, name: 'iyi', closed: false, plane: { axis: 'z', at: 4 }, points: [P(0, 0, 4)] });
    expect(s[1].note).toHaveLength(200);
    expect(s[1].plane).toEqual({ axis: 'x', at: 1 });
    expect(s[1].id).toBe('dup');
    expect(s[2].id).not.toBe('dup');
    expect(new Set(s.map((x) => x.id)).size).toBe(5);
    expect(s[2].closed).toBe(false); // kapalı yol en az 3 nokta ister
    expect(s[3].closed).toBe(true);
    // Biçimi bozuk kimlik (HTML, 64 karakterden uzun) yeniden üretilir.
    expect(s[3].id).toMatch(/^p_[a-z0-9]+$/);
    expect(s[4].id).toMatch(/^p_[a-z0-9]+$/);
    // Dizi olmayan alan yok sayılır (bildirilir).
    const d2: string[] = [];
    const w2: string[] = [];
    expect('sketch' in parseProject({ format: 'p3d', parts: [], sketch: { a: 1 } }, d2, w2)).toBe(false);
    expect([d2, w2]).toEqual([[], ['eskiz: alan bir dizi değil, okunmadı']]);
    // `warnings` verilmezse konsola yazılır.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      parseProject({ format: 'p3d', parts: [], sketch: [42] }, d2);
      expect(spy).toHaveBeenCalledWith('[p3d] eskiz #1 atlandı: yol bir nesne değil');
      expect(d2).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Store: eskiz seçimi', () => {
  it('eskiz ve parça seçimi birbirini temizler; silinen/geri alınan yol seçimden düşer; load sıfırlar', () => {
    const s = new Store(newProject('t'));
    s.apply([{ op: 'create', shape: 'box', name: 'k' }]);
    const pid = s.project.parts[0].id;
    expect(s.selectedId).toBe(pid);

    s.apply([{ op: 'sketch_add', points: rect() }]);
    const sid = s.project.sketch![0].id;
    expect([s.selectedId, s.selectedSketchId]).toEqual([null, sid]);

    s.select(pid);
    expect([s.selectedId, s.selectedSketchId]).toEqual([pid, null]);
    s.selectSketch(sid);
    expect([s.selectedId, s.selectedSketchId]).toEqual([null, sid]);
    s.select(null);
    expect([s.selectedId, s.selectedSketchId]).toEqual([null, null]);

    // Parça işlemi parçayı seçer, eskiz seçimini kaldırır; eskiz işlemi yolu seçer.
    s.selectSketch(sid);
    s.apply([{ op: 'move', part: 'k', dx: 1, dy: 0, dz: 0 }]);
    expect([s.selectedId, s.selectedSketchId]).toEqual([pid, null]);
    s.apply([{ op: 'sketch_update', path: 'Yol 1', note: 'not' }]);
    expect([s.selectedId, s.selectedSketchId]).toEqual([null, sid]);

    // Seçimi değiştirmeyen çağrı bildirim yapmaz.
    let calls = 0;
    s.subscribe(() => calls++);
    s.selectSketch(sid);
    expect(calls).toBe(0);
    s.select(pid);
    s.select(pid);
    expect(calls).toBe(1);

    s.selectSketch(sid);
    s.apply([{ op: 'sketch_delete', path: sid }]);
    expect(s.selectedSketchId).toBeNull();
    expect('sketch' in s.project).toBe(false);
    expect(s.undo()).toBe(true); // silme geri alındı: yol geri gelir, seçim kendiliğinden geri gelmez
    expect(s.project.sketch![0].id).toBe(sid);
    s.selectSketch(sid);
    expect(s.undo()).toBe(true); // not güncellemesi geri alındı: yol hâlâ var
    expect(s.selectedSketchId).toBe(sid);
    s.undo(); // move
    s.undo(); // sketch_add: yol yok → seçim düşer
    expect(s.project.sketch).toBeUndefined();
    expect(s.selectedSketchId).toBeNull();

    s.redo();
    s.selectSketch(s.project.sketch![0].id);
    s.load(newProject('yeni'));
    expect(s.selectedSketchId).toBeNull();
    s.replace(newProject('x'));
    expect(s.selectedSketchId).toBeNull();
  });
});
