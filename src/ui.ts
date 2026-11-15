import * as THREE from 'three';
import { SKETCH_KIND_LABELS, type GeomAxis, type Op, type Role, type SketchPath, type SketchPoint } from '../shared/ops';
import { getAsset } from './assets';
import { partBox, partsBox } from './engine';
import { describeGeom } from './geom';
import { displayOpacity, exportableParts, roleOf, solidVolume } from './model';
import { MAX_RESOLUTION, MIN_RESOLUTION, SHAPE_DEFS, fmt, usesResolution } from './shapes';
import { SKETCH_NOTE_MAX, isCurved, pathBox, pathLength, sketchKind } from './sketch';
import type { Store } from './store';
import type { Part, Project } from './types';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Sayı girişleri için nokta ondalıklı değer. */
const num = (n: number) => String(Number(n.toFixed(3)));

const PLA_DENSITY = 1.24; // g/cm³

const ROLE_LABEL: Record<Role, string> = { solid: 'Katı', hole: 'Delik', reference: 'Referans' };

/** Eskiz türü simgesi (liste ve panel). */
const SKETCH_ICON = { marker: '◆', arrow: '→', line: '∿', polygon: '▱' } as const;
/** Sağ panelde gösterilen en fazla nokta satırı (fazlası kalemle düzenlenir). */
const MAX_POINT_ROWS = 200;

/** Geometri JSON'u: her nokta tek satırda ([u, v], süpürme yolunda [x, y, z] / [x, y, z, r]), okunur ve düzenlenebilir. */
function geomJson(g: Part['geom']): string {
  return JSON.stringify(g, null, 1)
    .replace(/\[\s*(-?[\d.e+-]+(?:,\s*-?[\d.e+-]+){1,3})\s*\]/g, (_, inner: string) => `[${inner.replace(/,\s*/g, ', ')}]`)
    .replace(/\n\s*/g, '\n  ');
}

function statsHtml(box: THREE.Box3, volumeMm3: number): string {
  const s = box.getSize(new THREE.Vector3());
  const cm3 = volumeMm3 / 1000;
  return `
    <div>Boyut (X × Y × Z): <b>${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)}</b> mm</div>
    <div>Hacim: <b>${fmt(cm3)}</b> cm³ <span class="muted">(≈ ${fmt(cm3 * PLA_DENSITY)} g PLA, %100 doluluk)</span></div>`;
}

export interface PanelHooks {
  /** "Kalemle düzenle": kalem aracını açar. */
  onPen?: () => void;
}

/**
 * Sol parça/eskiz listesi ve sağ özellik panelini bağlar; her durum değişikliğinde
 * çağrılacak `render` fonksiyonunu döndürür. Tüm düzenlemeler işlem olarak `apply`'a gider.
 */
export function mountPanels(store: Store, apply: (ops: Op[]) => void, hooks: PanelHooks = {}): () => void {
  const list = document.getElementById('part-list')!;
  const count = document.getElementById('part-count')!;
  const props = document.getElementById('props')!;
  const addRow = document.getElementById('add-row')!;
  const sketchSection = document.getElementById('sketch-section')!;
  const sketchList = document.getElementById('sketch-list')!;
  const sketchCount = document.getElementById('sketch-count')!;

  addRow.innerHTML = Object.values(SHAPE_DEFS)
    .filter((d) => d.type !== 'mesh')
    .map((d) => `<button data-add="${d.type}" title="Varsayılan ölçülerle ${d.label.toLocaleLowerCase('tr')} ekle">+ ${d.label}</button>`)
    .join('');
  addRow.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-add]');
    if (b) apply([{ op: 'create', shape: b.dataset.add as Part['shape'] }]);
  });

  const partById = (id: string) => store.project.parts.find((p) => p.id === id);

  list.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const li = t.closest<HTMLElement>('li[data-id]');
    if (!li) return;
    const id = li.dataset.id!;
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    const part = partById(id);
    if (!part) return;
    if (act === 'vis') apply([{ op: 'update', part: id, visible: !part.visible }]);
    else if (act === 'del') apply([{ op: 'delete', part: id }]);
    else if (!t.matches('input')) store.select(id);
  });
  list.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const id = t.closest<HTMLElement>('li[data-id]')?.dataset.id;
    if (id && t.type === 'color') apply([{ op: 'update', part: id, color: t.value }]);
  });

  const sketchById = (id: string | null) => (id ? store.project.sketch?.find((s) => s.id === id) : undefined);

  sketchList.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const id = t.closest<HTMLElement>('li[data-sid]')?.dataset.sid;
    if (!id || !sketchById(id)) return;
    if (t.closest<HTMLElement>('[data-act]')?.dataset.act === 'sk-del') apply([{ op: 'sketch_delete', path: id }]);
    else store.selectSketch(id);
  });

  /** Seçili eskiz yolunun alan değişikliği → `sketch_update` (nokta düzenlemede tam nokta listesi). */
  const changeSketch = (path: SketchPath, field: string, t: HTMLInputElement): void => {
    const [, key, idx, axis] = field.split(':');
    const n = (s: string) => parseFloat(s.replace(',', '.'));
    if (key === 'name') {
      if (t.value.trim()) apply([{ op: 'sketch_update', path: path.id, name: t.value }]);
    } else if (key === 'note') {
      apply([{ op: 'sketch_update', path: path.id, note: t.value }]);
    } else if (key === 'closed') {
      apply([{ op: 'sketch_update', path: path.id, closed: t.checked }]);
    } else if (key === 'plane-axis') {
      apply([{ op: 'sketch_update', path: path.id, plane: { axis: t.value as GeomAxis, at: path.plane.at } }]);
    } else if (key === 'plane-at') {
      const v = n(t.value);
      if (Number.isFinite(v)) apply([{ op: 'sketch_update', path: path.id, plane: { axis: path.plane.axis, at: v } }]);
    } else if (key === 'pt') {
      const i = Number(idx);
      const v = n(t.value);
      if (!Number.isFinite(v) || !path.points[i] || !['x', 'y', 'z'].includes(axis)) return;
      const points: SketchPoint[] = path.points.map((pt, j) => (j === i ? { ...pt, p: { ...pt.p, [axis]: v } } : pt));
      apply([{ op: 'sketch_update', path: path.id, points }]);
    }
  };

  props.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const field = t.dataset.field;
    const path = sketchById(store.selectedSketchId);
    if (field?.startsWith('sk:')) {
      if (path) changeSketch(path, field, t);
      return;
    }
    const part = store.selectedId ? partById(store.selectedId) : undefined;
    if (!field || !part) return;
    if (field === 'name') {
      if (t.value.trim()) apply([{ op: 'update', part: part.id, name: t.value }]);
      return;
    }
    if (field === 'color') return apply([{ op: 'update', part: part.id, color: t.value }]);
    if (field === 'role') return apply([{ op: 'update', part: part.id, role: t.value as Role }]);
    if (field === 'cuts') {
      const names = t.value.split(',').map((x) => x.trim()).filter(Boolean);
      return apply([{ op: 'update', part: part.id, cuts: names.length ? names : ['*'] }]);
    }
    if (field === 'geom') {
      let geom: unknown;
      try {
        geom = JSON.parse(t.value);
      } catch (err) {
        t.setCustomValidity('Geçersiz JSON');
        t.reportValidity();
        return;
      }
      t.setCustomValidity('');
      return apply([{ op: 'update', part: part.id, geom: geom as Part['geom'] }]);
    }
    if (field === 'resolution') {
      // Boş alan = proje ayarı (0 alanı kaldırır).
      const r = t.value.trim() ? parseFloat(t.value.replace(',', '.')) : 0;
      if (Number.isFinite(r)) apply([{ op: 'update', part: part.id, resolution: r }]);
      return;
    }
    const v = parseFloat(t.value.replace(',', '.'));
    if (!Number.isFinite(v)) return;
    if (field === 'opacity') return apply([{ op: 'update', part: part.id, opacity: v }]);
    const [kind, key] = field.split(':');
    if (kind === 'param') apply([{ op: 'update', part: part.id, params: [{ name: key as never, value: v }] }]);
    else if (kind === 'pos') apply([{ op: 'set_position', part: part.id, [key]: v }]);
    else if (kind === 'rot') apply([{ op: 'update', part: part.id, rotation: { ...part.rotation, [key]: v } }]);
  });
  props.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && t instanceof HTMLInputElement) t.blur();
  });
  props.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    const act = btn?.dataset.act;
    const path = sketchById(store.selectedSketchId);
    if (act?.startsWith('sk-')) {
      if (!path) return;
      if (act === 'sk-pen') hooks.onPen?.();
      else if (act === 'sk-del') apply([{ op: 'sketch_delete', path: path.id }]);
      else if (act === 'sk-ptdel') {
        const i = Number(btn!.dataset.i);
        const points = path.points.filter((_, j) => j !== i);
        apply([points.length ? { op: 'sketch_update', path: path.id, points } : { op: 'sketch_delete', path: path.id }]);
      }
      return;
    }
    const part = store.selectedId ? partById(store.selectedId) : undefined;
    if (!act || !part) return;
    if (act === 'drop') apply([{ op: 'drop_to_bed', part: part.id }]);
    else if (act === 'dup') apply([{ op: 'duplicate', part: part.id }]);
    else if (act === 'vis') apply([{ op: 'update', part: part.id, visible: !part.visible }]);
    else if (act === 'del') apply([{ op: 'delete', part: part.id }]);
  });

  let propsSig = '';

  return function render() {
    const { project, selectedId } = store;
    const seg = project.settings.resolution;

    count.textContent = project.parts.length ? `(${project.parts.length})` : '';
    list.innerHTML = project.parts.length
      ? project.parts
          .map(
            (p) => `
        <li data-id="${p.id}" class="${p.id === selectedId ? 'selected' : ''} ${p.visible ? '' : 'hidden-part'}">
          <input type="color" value="${p.color}" title="Renk" />
          <span class="pl-name" title="${esc(p.name)}">${esc(p.name)}</span>
          <span class="pl-shape">${p.group ? `<span class="group-badge" title="Grup: ${esc(p.group)}">${esc(p.group)}</span>` : ''}${p.role ? `<span class="role-badge ${p.role}">${ROLE_LABEL[p.role]}</span>` : ''}${SHAPE_DEFS[p.shape].label}</span>
          <button class="pl-btn" data-act="vis" title="${p.visible ? 'Gizle' : 'Göster'}">${p.visible ? '◉' : '○'}</button>
          <button class="pl-btn" data-act="del" title="Sil">✕</button>
        </li>`,
          )
          .join('')
      : `<div class="empty">Henüz parça yok.<br>Yukarıdan bir şekil ekleyin ya da aşağıya komut yazın:<br><i>“50x30x10 kutu oluştur adı taban olsun”</i></div>`;

    const paths = project.sketch ?? [];
    const sketchId = store.selectedSketchId;
    sketchSection.hidden = !paths.length;
    sketchCount.textContent = paths.length ? `(${paths.length})` : '';
    sketchList.innerHTML = paths
      .map((s) => {
        const kind = sketchKind(s);
        const note = s.note ? `<span class="sketch-note" title="${esc(s.note)}">${esc(s.note.length > 40 ? s.note.slice(0, 39) + '…' : s.note)}</span>` : '';
        return `
        <li data-sid="${esc(s.id)}" class="${s.id === sketchId ? 'selected' : ''}">
          <span class="sk-kind" title="${SKETCH_KIND_LABELS[kind]}">${SKETCH_ICON[kind]}</span>
          <span class="pl-name" title="${esc(s.name)}">${esc(s.name)}${note}</span>
          <span class="pl-shape">${s.points.length} nokta</span>
          <button class="pl-btn" data-act="sk-del" title="Sil">✕</button>
        </li>`;
      })
      .join('');

    const part = selectedId ? project.parts.find((p) => p.id === selectedId) : undefined;
    const path = sketchId ? paths.find((s) => s.id === sketchId) : undefined;
    // Delikler komşu parçaların hacmini değiştirdiği için seçili parçada da tüm parçalar imzaya girer (gruplar: pivot).
    const sig = `${selectedId}|${sketchId}|${JSON.stringify(project.parts)}|${JSON.stringify(project.groups ?? [])}|${JSON.stringify(paths)}|${seg}`;
    if (sig === propsSig) return;
    propsSig = sig;

    // Odaktaki alanı yeniden çizimden sonra geri yükle.
    const active = document.activeElement as HTMLInputElement | null;
    const focusField = active && props.contains(active) ? active.dataset.field : undefined;

    props.innerHTML = path ? sketchProps(path) : part ? partProps(part, project) : projectProps(store);

    if (focusField) {
      const el = props.querySelector<HTMLInputElement>(`[data-field="${focusField}"]`);
      el?.focus();
      el?.select?.();
    }
  };
}

function partProps(part: Part, project: Project): string {
  const seg = project.settings.resolution;
  const def = SHAPE_DEFS[part.shape];
  const box = partBox(part, seg);
  const role = roleOf(part);
  const roleSelect = `
      <div class="field"><label for="f-role">Rol</label>
        <select id="f-role" data-field="role" title="Delik: kesiştiği katılardan çıkarılır. Referans: yalnızca görsel, dışa aktarılmaz.">
          ${(['solid', 'hole', 'reference'] as Role[]).map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
        </select>
      </div>`;
  let geomBlock = '';
  if (part.geom?.kind === 'mesh') {
    const a = getAsset(part.geom.asset);
    geomBlock = `<div class="section">Ağ</div><div class="muted small">${a ? `${esc(a.name)} · ${a.triangles.toLocaleString('tr-TR')} üçgen` : 'Ağ verisi yok (yer tutucu küp)'}</div>`;
  } else if (part.geom) {
    geomBlock = `
      <div class="section">Geometri <span class="muted small">(${esc(describeGeom(part.geom))})</span></div>
      <textarea class="geom-input" data-field="geom" spellcheck="false" rows="8" title="Noktalar mm; değiştirip alanın dışına tıklayın">${esc(geomJson(part.geom))}</textarea>`;
  }
  const group = part.group ? project.groups?.find((g) => g.name === part.group) : undefined;
  const groupInfo = group
    ? `<div class="group-info" title="Grup üyeleri birlikte taşınır, döner ve kopyalanır; pivot dönme merkezidir (salt okunur)">
        <span class="muted">Grup</span> <b>${esc(group.name)}</b><br>
        <span class="muted small">pivot ${fmt(group.pivot.x)}, ${fmt(group.pivot.y)}, ${fmt(group.pivot.z)} mm</span></div>`
    : '';
  const note = role === 'solid' ? '' : `<div class="muted small">${role === 'hole' ? 'Delik: kesiştiği katılardan çıkarılır, dışa aktarılmaz.' : 'Referans: yalnızca görsel, dışa aktarılmaz.'}</div>`;
  const cutNames = (part.cuts ?? []).map((id) => project.parts.find((p) => p.id === id)?.name ?? id).join(', ');
  const cutsField =
    role === 'hole'
      ? `<div class="field"><label for="f-cuts" title="Virgülle ayrılmış parça adları; boş = kesiştiği tüm katılar">Keser</label>
          <input id="f-cuts" data-field="cuts" value="${esc(cutNames)}" placeholder="tümü" /></div>`
      : '';
  const opacityField = `
      <div class="field"><label for="f-opacity" title="1 = opak, 0 = tamamen saydam (referans varsayılanı 0,35, delik 0,3). Yalnızca görünüm ve malzeme (GLB/3MF/MTL): parça yine dışa aktarılır ve hacme girer">Opaklık</label>
        <div class="unit-input">
          <input id="f-opacity" type="number" data-field="opacity" value="${num(displayOpacity(part))}" min="0" max="1" step="0.05" />
          <span></span>
        </div>
      </div>`;
  const resolutionField = usesResolution(part)
    ? `
      <div class="field"><label for="f-res" title="Bu parçanın yuvarlak yüzey segment sayısı (${MIN_RESOLUTION}–${MAX_RESOLUTION}); boş = proje ayarı (${seg})">Çözünürlük</label>
        <div class="unit-input">
          <input id="f-res" type="number" data-field="resolution" value="${part.resolution ?? ''}" placeholder="${seg}" min="${MIN_RESOLUTION}" max="${MAX_RESOLUTION}" step="1" />
          <span>seg</span>
        </div>
      </div>`
    : '';
  const params = def.params
    .map(
      (d) => `
      <div class="field">
        <label for="f-${d.key}">${d.label}</label>
        <div class="unit-input">
          <input id="f-${d.key}" type="number" data-field="param:${d.key}" value="${num(part.params[d.key])}"
            min="${d.min}" ${d.max !== undefined ? `max="${d.max}"` : ''} step="${d.integer ? 1 : 0.1}" />
          <span>${d.unit === 'mm' ? 'mm' : ''}</span>
        </div>
      </div>`,
    )
    .join('');
  const vec = (kind: string, labels: [string, string, string], values: [number, number, number], step: number) => `
    <div class="vec3">
      ${(['x', 'y', 'z'] as const)
        .map((a, i) => `<label>${labels[i]}<input type="number" step="${step}" data-field="${kind}:${a}" value="${num(values[i])}" /></label>`)
        .join('')}
    </div>`;
  return `
    <div class="props">
      <input class="name-input" data-field="name" value="${esc(part.name)}" spellcheck="false" aria-label="Parça adı" />
      <div class="sub">${def.label}</div>
      <div class="field"><label>Renk</label><input type="color" data-field="color" value="${part.color}" /></div>
      ${opacityField}
      ${roleSelect}
      ${groupInfo}
      ${cutsField}
      ${note}
      <div class="section">Ölçüler</div>
      ${params}
      ${resolutionField}
      ${geomBlock}
      <div class="section">Konum (mm)</div>
      ${vec('pos', ['X (merkez)', 'Y (merkez)', 'Z (taban)'], [part.position.x, part.position.y, box.min.z], 1)}
      <div class="section">Döndürme (°)</div>
      ${vec('rot', ['X', 'Y', 'Z'], [part.rotation.x, part.rotation.y, part.rotation.z], 15)}
      <div class="stats">${statsHtml(box, solidVolume(project, part))}</div>
      <div class="actions">
        <button data-act="drop" title="Parçayı tablaya oturt">Tablaya indir</button>
        <button data-act="dup">Kopyala</button>
        <button data-act="vis">${part.visible ? 'Gizle' : 'Göster'}</button>
        <button data-act="del" class="danger">Sil</button>
      </div>
    </div>`;
}

function sketchProps(path: SketchPath): string {
  const kind = sketchKind(path);
  const box = pathBox(path);
  const size = { x: box.max.x - box.min.x, y: box.max.y - box.min.y, z: box.max.z - box.min.z };
  const lengthRow =
    kind === 'marker'
      ? ''
      : `<div>${kind === 'polygon' ? 'Çevre' : 'Uzunluk'}: <b>${fmt(pathLength(path))}</b> mm</div>`;
  const rows = path.points
    .slice(0, MAX_POINT_ROWS)
    .map(
      (pt, i) => `
      <div class="pt-row">
        <span class="pt-i" title="${pt.hIn || pt.hOut ? 'Eğri (tutamaçlı) nokta' : 'Köşe noktası'}">${i + 1}${pt.hIn || pt.hOut ? '<span class="pt-curve">eğri</span>' : ''}</span>
        ${(['x', 'y', 'z'] as const).map((a) => `<input type="number" step="1" data-field="sk:pt:${i}:${a}" value="${num(pt.p[a])}" aria-label="${i + 1}. nokta ${a.toUpperCase()}" />`).join('')}
        <button class="pl-btn" data-act="sk-ptdel" data-i="${i}" title="Noktayı sil">✕</button>
      </div>`,
    )
    .join('');
  const more = path.points.length > MAX_POINT_ROWS ? `<div class="muted small">… ${path.points.length - MAX_POINT_ROWS} nokta daha (kalemle düzenleyin)</div>` : '';
  return `
    <div class="props">
      <input class="name-input" data-field="sk:name" value="${esc(path.name)}" spellcheck="false" aria-label="Eskiz adı" />
      <div class="sub">Eskiz · ${SKETCH_ICON[kind]} ${SKETCH_KIND_LABELS[kind]}${isCurved(path) ? ', eğri' : ''}</div>
      <div class="section">Not</div>
      <textarea class="sketch-note-input" data-field="sk:note" maxlength="${SKETCH_NOTE_MAX}" rows="3" placeholder="ör. kapak, 3 mm kalın" title="Claude ve Claude Code bu notu okur">${esc(path.note ?? '')}</textarea>
      <div class="field"><label for="f-sk-closed">Kapalı</label><input id="f-sk-closed" type="checkbox" data-field="sk:closed" ${path.closed ? 'checked' : ''} /></div>
      <div class="field"><label title="Çizim düzlemi: eksene dik, o eksende konumda">Düzlem</label>
        <div class="plane-input">
          <select data-field="sk:plane-axis" aria-label="Düzlem ekseni">
            ${(['x', 'y', 'z'] as const).map((a) => `<option value="${a}" ${a === path.plane.axis ? 'selected' : ''}>${a.toUpperCase()}</option>`).join('')}
          </select>
          <input type="number" step="1" data-field="sk:plane-at" value="${num(path.plane.at)}" aria-label="Düzlem konumu (mm)" />
        </div>
      </div>
      <div class="stats">
        <div>Tür: <b>${SKETCH_KIND_LABELS[kind]}</b> · ${path.points.length} nokta</div>
        ${lengthRow}
        <div>Kutu (X × Y × Z): <b>${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}</b> mm</div>
      </div>
      <div class="section">Noktalar (mm)</div>
      <div class="pt-table">
        <div class="pt-row pt-head"><span>#</span><span>X</span><span>Y</span><span>Z</span><span></span></div>
        ${rows}
      </div>
      ${more}
      <div class="actions">
        <button data-act="sk-pen" title="Kalem aracını aç: noktaları sürükle, eksende taşı (P)">✎ Kalemle düzenle</button>
        <button data-act="sk-del" class="danger">Sil</button>
      </div>
      <p class="muted small">Eskiz geometri üretmez ve dışa aktarılmaz; Claude / Claude Code ne istediğinizi bundan okur.</p>
    </div>`;
}

function projectProps(store: Store): string {
  const { project } = store;
  const visible = exportableParts(project.parts);
  const stats = visible.length
    ? `<div class="stats">
        <div class="muted">Görünür ${visible.length} katı parça</div>
        ${statsHtml(partsBox(visible, project.settings.resolution), visible.reduce((s, p) => s + solidVolume(project, p), 0))}
      </div>`
    : '';
  return `
    <div class="props">
      <h3>${esc(project.name)}</h3>
      <div class="sub">Tabla ${fmt(project.settings.bedX)} × ${fmt(project.settings.bedY)} mm</div>
      <p class="muted">Düzenlemek için görünümde bir parçaya tıklayın ya da listeden seçin.</p>
      ${stats}
      <div class="section">Kısayollar</div>
      <div class="muted small" style="line-height:1.8">
        Sol tık: seç / döndür · Sağ tık: kaydır · Tekerlek: yakınlaş<br>
        <b>/</b> komut satırı · <b>F</b> sığdır · <b>Del</b> sil · <b>Esc</b> seçimi kaldır<br>
        <b>Ctrl+Z</b> geri al · <b>Ctrl+Y</b> yinele · <b>Ctrl+S</b> kaydet<br>
        <b>P</b> kalem · <b>X/Y/Z/N</b> eksen · <b>Enter</b> bitir · <b>Esc</b> iptal · <b>Shift</b> yakala
      </div>
    </div>`;
}
