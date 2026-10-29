import * as THREE from 'three';
import type { Op, Role } from '../shared/ops';
import { getAsset } from './assets';
import { partBox, partsBox } from './engine';
import { describeGeom } from './geom';
import { exportableParts, roleOf, solidVolume } from './model';
import { SHAPE_DEFS, fmt } from './shapes';
import type { Store } from './store';
import type { Part, Project } from './types';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Sayı girişleri için nokta ondalıklı değer. */
const num = (n: number) => String(Number(n.toFixed(3)));

const PLA_DENSITY = 1.24; // g/cm³

const ROLE_LABEL: Record<Role, string> = { solid: 'Katı', hole: 'Delik', reference: 'Referans' };

/** Geometri JSON'u: her nokta tek satırda, okunur ve düzenlenebilir. */
function geomJson(g: Part['geom']): string {
  return JSON.stringify(g, null, 1)
    .replace(/\[\s*(-?[\d.e+-]+),\s*(-?[\d.e+-]+)\s*\]/g, '[$1, $2]')
    .replace(/\n\s*/g, '\n  ');
}

function statsHtml(box: THREE.Box3, volumeMm3: number): string {
  const s = box.getSize(new THREE.Vector3());
  const cm3 = volumeMm3 / 1000;
  return `
    <div>Boyut (X × Y × Z): <b>${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)}</b> mm</div>
    <div>Hacim: <b>${fmt(cm3)}</b> cm³ <span class="muted">(≈ ${fmt(cm3 * PLA_DENSITY)} g PLA, %100 doluluk)</span></div>`;
}

/**
 * Sol parça listesi ve sağ özellik panelini bağlar; her durum değişikliğinde
 * çağrılacak `render` fonksiyonunu döndürür. Tüm düzenlemeler işlem olarak `apply`'a gider.
 */
export function mountPanels(store: Store, apply: (ops: Op[]) => void): () => void {
  const list = document.getElementById('part-list')!;
  const count = document.getElementById('part-count')!;
  const props = document.getElementById('props')!;
  const addRow = document.getElementById('add-row')!;

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

  props.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const field = t.dataset.field;
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
    const v = parseFloat(t.value.replace(',', '.'));
    if (!Number.isFinite(v)) return;
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
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
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
          <span class="pl-shape">${p.role ? `<span class="role-badge ${p.role}">${ROLE_LABEL[p.role]}</span>` : ''}${SHAPE_DEFS[p.shape].label}</span>
          <button class="pl-btn" data-act="vis" title="${p.visible ? 'Gizle' : 'Göster'}">${p.visible ? '◉' : '○'}</button>
          <button class="pl-btn" data-act="del" title="Sil">✕</button>
        </li>`,
          )
          .join('')
      : `<div class="empty">Henüz parça yok.<br>Yukarıdan bir şekil ekleyin ya da aşağıya komut yazın:<br><i>“50x30x10 kutu oluştur adı taban olsun”</i></div>`;

    const part = selectedId ? project.parts.find((p) => p.id === selectedId) : undefined;
    // Delikler komşu parçaların hacmini değiştirdiği için seçili parçada da tüm parçalar imzaya girer.
    const sig = `${selectedId}|${JSON.stringify(project.parts)}|${seg}`;
    if (sig === propsSig) return;
    propsSig = sig;

    // Odaktaki alanı yeniden çizimden sonra geri yükle.
    const active = document.activeElement as HTMLInputElement | null;
    const focusField = active && props.contains(active) ? active.dataset.field : undefined;

    props.innerHTML = part ? partProps(part, project) : projectProps(store);

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
  const note = role === 'solid' ? '' : `<div class="muted small">${role === 'hole' ? 'Delik: kesiştiği katılardan çıkarılır, dışa aktarılmaz.' : 'Referans: yalnızca görsel, dışa aktarılmaz.'}</div>`;
  const cutNames = (part.cuts ?? []).map((id) => project.parts.find((p) => p.id === id)?.name ?? id).join(', ');
  const cutsField =
    role === 'hole'
      ? `<div class="field"><label for="f-cuts" title="Virgülle ayrılmış parça adları; boş = kesiştiği tüm katılar">Keser</label>
          <input id="f-cuts" data-field="cuts" value="${esc(cutNames)}" placeholder="tümü" /></div>`
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
      ${roleSelect}
      ${cutsField}
      ${note}
      <div class="section">Ölçüler</div>
      ${params}
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
        <b>Ctrl+Z</b> geri al · <b>Ctrl+Y</b> yinele · <b>Ctrl+S</b> kaydet
      </div>
    </div>`;
}
