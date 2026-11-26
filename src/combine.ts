// Projeleri tek sahnede birleştirme (BoltRush isteği #1): parça ailesini / varyantları yan yana görmek için. Her kaynak kendi
// projesinde kurulur (applyOps), sonra bitmiş projeler birleştirilir: parça ve grup adlarına önek (`önek/ad`), konumlara ve grup
// pivotlarına öteleme, yeni kimlikler. İşlem listelerini yeniden adlandırmaktan sağlamdır ($last, place_on hedefleri, cuts adla
// değil sonuçla taşınır).
//
// Delikler: `cuts`'ı olmayan delik kutusu kesişen tüm katıları keser; birleşik sahnede komşu kaynağın katısına değerse onu da
// keserdi. Bu yüzden böyle deliklere kaynak projede kestikleri katılar `cuts` olarak yazılır (her kaynağın sonucu aynen kalır).
// Proje çözünürlüğü farklı kaynaklarda, çözünürlük kullanan parçaya kaynağınki parça `resolution`'ı olarak yazılır. Eskiz
// yolları alınmaz. Ağ (mesh) parçaları aynı ağ kimliğini kullanır (depo ortak).
import * as THREE from 'three';
import type { Vec3 } from '../shared/ops';
import { partsBox } from './engine';
import { newId } from './ids';
import { holesFor, roleOf } from './model';
import { usesResolution } from './shapes';
import { fold } from './text';
import { newProject, type Part, type Project } from './types';

export interface CombineEntry {
  project: Project;
  /** Ad öneki (`önek/ad`); yoksa sıra numarası (1, 2, …). Boş dize: önek yok (ad çakışırsa hata). */
  prefix?: string;
  /** Kaynağın tüm parçalarına ve grup pivotlarına eklenen öteleme (mm). */
  offset?: Partial<Vec3>;
}

export interface CombineOptions {
  /** Birleşik projenin adı (varsayılan 'birleşik'). */
  name?: string;
  /** Önek ile ad arasındaki ayraç (varsayılan '/'). */
  separator?: string;
}

const MAX_BED = 20000;

/** Kaynakları tek projede birleştirir (kaynaklar değişmez). Ad çakışması (aynı önek) hatadır. */
export function combineProjects(entries: CombineEntry[], opts: CombineOptions = {}): Project {
  if (!entries.length) throw new Error('Birleştirilecek proje yok.');
  const sep = opts.separator ?? '/';
  const out = newProject(opts.name ?? 'birleşik');
  const seg = entries[0].project.settings.resolution;
  out.settings.resolution = seg;
  const names = new Set<string>();
  const take = (name: string, what: string) => {
    const k = fold(name).trim(); // motorun ad kuralı: büyük/küçük harf ve aksan duyarsız
    if (names.has(k)) throw new Error(`Birleşik sahnede '${name}' ${what} adı iki kez geçiyor; kaynaklara farklı önek verin.`);
    names.add(k);
    return name;
  };
  entries.forEach((e, i) => {
    const src = e.project;
    const prefix = e.prefix ?? String(i + 1);
    const named = (n: string) => (prefix ? `${prefix}${sep}${n}` : n);
    const d = { x: e.offset?.x ?? 0, y: e.offset?.y ?? 0, z: e.offset?.z ?? 0 };
    // Kesimi `cuts`'sız deliklerde kaynaktaki sonuca sabitle.
    const solids = src.parts.filter((p) => roleOf(p) === 'solid');
    const pinned = new Map<string, string[]>();
    for (const s of solids) {
      for (const h of holesFor(src, s)) if (!h.cuts) pinned.set(h.id, [...(pinned.get(h.id) ?? []), s.id]);
    }
    const ids = new Map(src.parts.map((p) => [p.id, newId()]));
    for (const p of src.parts) {
      const copy = structuredClone(p) as Part;
      copy.id = ids.get(p.id)!;
      copy.name = take(named(p.name), 'parça');
      copy.position = { x: p.position.x + d.x, y: p.position.y + d.y, z: p.position.z + d.z };
      if (roleOf(p) === 'hole') {
        const cuts = p.cuts ?? pinned.get(p.id) ?? [];
        copy.cuts = cuts.flatMap((id) => (ids.has(id) ? [ids.get(id)!] : []));
      }
      if (p.group) copy.group = named(p.group);
      if (copy.resolution === undefined && src.settings.resolution !== seg && usesResolution(p)) copy.resolution = src.settings.resolution;
      out.parts.push(copy);
    }
    for (const g of src.groups ?? []) {
      (out.groups ??= []).push({ name: take(named(g.name), 'grup'), pivot: { x: g.pivot.x + d.x, y: g.pivot.y + d.y, z: g.pivot.z + d.z } });
    }
  });
  // Tabla birleşik sahneyi alsın (en çok 20 m).
  const box = partsBox(out.parts.filter((p) => p.visible), seg);
  if (!box.isEmpty()) {
    const need = (lo: number, hi: number) => Math.min(MAX_BED, Math.ceil(2 * Math.max(Math.abs(lo), Math.abs(hi)) * 1.05));
    out.settings.bedX = Math.max(out.settings.bedX, need(box.min.x, box.max.x));
    out.settings.bedY = Math.max(out.settings.bedY, need(box.min.y, box.max.y));
  }
  return out;
}

export interface GridEntry {
  project: Project;
  /** Ad öneki; yoksa projenin adı (boşsa sıra numarası). */
  prefix?: string;
}

export interface GridOptions extends CombineOptions {
  /** Sütun sayısı (varsayılan ⌈√n⌉). */
  columns?: number;
  /** Hücreler arası boşluk (mm; varsayılan en büyük kaynağın yatay boyunun %15'i, en az 10). */
  gap?: number;
}

export interface GridCell {
  prefix: string;
  /** Kaynağa eklenen öteleme. */
  offset: Vec3;
  /** Kaynağın görünür parçalarının birleşik sahnedeki kutusu. */
  box: { min: Vec3; max: Vec3 };
}

/**
 * Kaynakları eşit hücreli bir ızgaraya dizerek birleştirir: soldan sağa (+X), satırlar arkadan öne (üstten görünümde
 * yukarıdan aşağı); her kaynağın görünür parçalarının kutusu hücresinde XY'de ortalanır, z değişmez. Izgara orijinde ortalı.
 */
export function gridProjects(entries: GridEntry[], opts: GridOptions = {}): { project: Project; cells: GridCell[] } {
  if (!entries.length) throw new Error('Birleştirilecek proje yok.');
  const boxes = entries.map((e) => {
    const vis = e.project.parts.filter((p) => p.visible && roleOf(p) !== 'hole');
    const b = partsBox(vis.length ? vis : e.project.parts, e.project.settings.resolution);
    return b.isEmpty() ? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()) : b;
  });
  const n = entries.length;
  const cols = Math.max(1, Math.min(n, Math.floor(opts.columns ?? Math.ceil(Math.sqrt(n)))));
  const rows = Math.ceil(n / cols);
  const w = Math.max(...boxes.map((b) => b.max.x - b.min.x));
  const dp = Math.max(...boxes.map((b) => b.max.y - b.min.y));
  const gap = opts.gap ?? Math.max(10, 0.15 * Math.max(w, dp));
  if (!(gap >= 0)) throw new Error(`gap negatif olamaz (${gap}).`);
  const [cw, cd] = [w + gap, dp + gap];
  const prefixes = entries.map((e, i) => e.prefix ?? (e.project.name?.trim() || String(i + 1)));
  // Aynı adlı projeler (ör. hepsi "birleşik"): öneklere sıra numarası.
  const seen = new Map<string, number>();
  for (const p of prefixes) seen.set(p, (seen.get(p) ?? 0) + 1);
  const uniq = prefixes.map((p, i) => (entries[i].prefix === undefined && (seen.get(p) ?? 0) > 1 ? `${p} ${i + 1}` : p));
  const cells: GridCell[] = boxes.map((b, i) => {
    const [c, r] = [i % cols, Math.floor(i / cols)];
    const cx = (c - (cols - 1) / 2) * cw;
    const cy = ((rows - 1) / 2 - r) * cd;
    const offset = { x: cx - (b.min.x + b.max.x) / 2, y: cy - (b.min.y + b.max.y) / 2, z: 0 };
    const v = (q: THREE.Vector3) => ({ x: q.x + offset.x, y: q.y + offset.y, z: q.z });
    return { prefix: uniq[i], offset, box: { min: v(b.min), max: v(b.max) } };
  });
  const project = combineProjects(
    entries.map((e, i) => ({ project: e.project, prefix: cells[i].prefix, offset: cells[i].offset })),
    opts,
  );
  return { project, cells };
}
