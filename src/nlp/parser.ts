// Yerel (çevrimdışı) Türkçe komut ayrıştırıcı. Sık kullanılan kalıpları anlar;
// anlayamadığı cümleleri `unrecognized` ile bildirir (otomatik modda Claude'a devredilir).

import type { Axis, Op, ParamChange, ParamKey, ShapeType, Side } from '../../shared/ops';
import { COLOR_NAMES, normalizeHex, resolveColor } from '../colors';
import { partBox } from '../engine';
import { SHAPE_DEFS, type DimWord } from '../shapes';
import { fold } from '../text';
import type { Project } from '../types';

export interface ParseResult {
  ops: Op[];
  errors: string[];
  /** Anlaşılamayan cümleler (orijinal metin). */
  unrecognized: string[];
  special?: 'undo' | 'redo' | 'help';
}

interface Clause {
  orig: string;
  f: string; // fold(orig), aynı uzunlukta
}

interface Target {
  ref: string; // parça id'si ya da '$last'
  shape: ShapeType;
  name: string;
}

interface Ref extends Target {
  start: number;
  end: number;
}

interface State {
  project: Project;
  ctx: Target | null;
  ops: Op[];
  errors: string[];
}

// ---------------------------------------------------------------------------
// Sözlükler

/** İsim/şekil kelimesinin sonuna gelebilecek hâl ekleri (katlanmış). */
const SUFFIXES = new Set([
  'in', 'nin', 'un', 'nun', 'i', 'u', 'yi', 'yu', 'ni', 'nu', 'e', 'a', 'ye', 'ya', 'ne', 'na',
  'de', 'da', 'te', 'ta', 'nde', 'nda', 'den', 'dan', 'ten', 'tan', 'nden', 'ndan',
  'le', 'la', 'yle', 'yla', 'si', 'su', 'sini', 'sunu', 'sinin', 'sunun', 'sine', 'suna',
  'ler', 'lar', 'leri', 'lari', 'lerin', 'larin', 'lere', 'lara',
]);

interface ShapeWord {
  stem: string;
  shape: ShapeType;
  sides?: number;
  cube?: boolean;
}

const SHAPE_WORDS: ShapeWord[] = [
  { stem: 'kutu', shape: 'box' },
  { stem: 'kup', shape: 'box', cube: true },
  { stem: 'blok', shape: 'box' },
  { stem: 'blog', shape: 'box' },
  { stem: 'plaka', shape: 'box' },
  { stem: 'levha', shape: 'box' },
  { stem: 'silindir', shape: 'cylinder' },
  { stem: 'disk', shape: 'cylinder' },
  { stem: 'cubuk', shape: 'cylinder' },
  { stem: 'cubug', shape: 'cylinder' },
  { stem: 'pim', shape: 'cylinder' },
  { stem: 'boru', shape: 'tube' },
  { stem: 'tup', shape: 'tube' },
  { stem: 'halka', shape: 'tube' },
  { stem: 'rondela', shape: 'tube' },
  { stem: 'pul', shape: 'tube' },
  { stem: 'koni', shape: 'cone' },
  { stem: 'kure', shape: 'sphere' },
  { stem: 'top', shape: 'sphere' },
  { stem: 'torus', shape: 'torus' },
  { stem: 'simit', shape: 'torus' },
  { stem: 'prizma', shape: 'prism' },
  { stem: 'ucgen', shape: 'prism', sides: 3 },
  { stem: 'besgen', shape: 'prism', sides: 5 },
  { stem: 'altigen', shape: 'prism', sides: 6 },
  { stem: 'sekizgen', shape: 'prism', sides: 8 },
];

const VERB_RE = new RegExp(
  '\\b(?:olustur|ekle|ciz|yarat|yap|buyut|kucult|artir|arttir|azalt|uzat|kisalt|genislet|daralt|incelt|' +
    'kalinlastir|yukselt|alcalt|dusur|cikar|indir|ayarla|degistir|olsun|getir|tasi|kaydir|gotur|dondur|' +
    'cevir|yatir|kaldir|kopyala|cogalt|gizle|sakla|goster|boya|oturt|yerlestir|adlandir|olcekle)' +
    '|\\b(?:sil|silin|sec|koy|koyun)\\b',
);

const CREATE_RE = /\b(?:olustur|ekle|ciz|yarat|yap|uret|getir)|\b(?:koy|koyun)\b/;
const INC_RE = /\b(?:buyut|artir|arttir|uzat|genislet|kalinlastir|yukselt|fazlalastir|ekle|bollastir)/;
const DEC_RE = /\b(?:kucult|azalt|kisalt|daralt|incelt|alcalt|dusur|cikar|eksilt|indir)/;
/** 'çıkar' hariç azaltma fiilleri: "2 katına çıkar" büyütmedir. */
const SHRINK_RE = /\b(?:kucult|azalt|kisalt|daralt|incelt|alcalt|dusur|eksilt|indir)/;
const ALL_RE = /\b(?:tumunu|tumu|hepsini|hepsi|butun parcalari|tum parcalari|tum parcalar|her seyi|herseyi)\b/;

const NUMBER_WORDS: Record<string, string> = {
  bir: '1', iki: '2', uc: '3', dort: '4', bes: '5', alti: '6', yedi: '7', sekiz: '8', dokuz: '9', on: '10', oniki: '12',
};

const KEYWORDS: [RegExp, DimWord][] = [
  [/\bic\s*cap\w*/g, 'inner'],
  [/\bdis\s*cap\w*/g, 'outer'],
  [/\balt\s*cap\w*/g, 'bottom'],
  [/\bust\s*cap\w*/g, 'top'],
  [/\byari\s*cap\w*/g, 'radius'],
  [/\b(?:et|duvar|cidar)\s*kalinli\w*|\bcidar\w*/g, 'wall'],
  [/\bcap\w*/g, 'diameter'],
  [/\byuksekli\w*|\byuksek\b/g, 'height'],
  [/\bboy(?:u|unu|unda|lu|unun|una)?\b/g, 'height'],
  [/\bgenisli\w*/g, 'width'],
  [/\ben(?:i|ini|inde|ine)?\b(?=\s*[\d%])|\b(?:eni|enini|eninde)\b/g, 'width'],
  [/\bderinli\w*/g, 'depth'],
  [/\buzunlu\w*/g, 'length'],
  [/\bkalinli\w*/g, 'thickness'],
  [/\b(?:kenar|kose)\s*sayi\w*|\bkenarl[iu]\w*/g, 'sides'],
];

const HELP_LINES = [
  'Örnek komutlar:',
  '• 50x30x10 kutu oluştur adı taban olsun',
  '• 20 mm çaplı 40 mm yüksekliğinde kırmızı silindir ekle adı mil',
  '• mil parçasının çapını 10mm büyüt',
  "• tabanın yüksekliğini 5 mm azalt · milin çapını 30'a çıkar · çapını %20 artır",
  '• mili tabanın üstüne koy · kapağı tabanın sağına koy',
  '• mili x yönünde 20 mm taşı · mili 15 mm yukarı taşı · mili x=10 y=20 konumuna taşı',
  '• mili x ekseninde 90 derece döndür · mili yatır · mili yere indir',
  '• tabanı mavi yap · milin adını şaft yap · mili kopyala · mili sil',
  '• tabana 5 mm çaplı delik aç · milin üstüne 3 mm çaplı 8 mm derinliğinde delik aç',
  '• kutuyu delik yap · kutuyu katı yap · modeli referans yap · delikleri gizle',
  '• isimleri gizle · ölçüleri göster · mili gizle · tümünü göster',
  '• geri al · yinele',
];

export const HELP_TEXT = HELP_LINES.join('\n');

// ---------------------------------------------------------------------------
// Giriş noktası

export function parseCommand(text: string, project: Project, selectedId: string | null): ParseResult {
  const trimmed = text.trim();
  const ff = fold(trimmed).replace(/[.!]+$/, '').trim();
  if (/^(?:yardim|help|\?|komutlar|ornekler)$/.test(ff)) return { ops: [], errors: [], unrecognized: [], special: 'help' };
  if (/^(?:geri al|geri|undo)$/.test(ff)) return { ops: [], errors: [], unrecognized: [], special: 'undo' };
  if (/^(?:yinele|ileri al|redo)$/.test(ff)) return { ops: [], errors: [], unrecognized: [], special: 'redo' };

  const sel = project.parts.find((p) => p.id === selectedId) ?? (project.parts.length === 1 ? project.parts[0] : null);
  const st: State = {
    project,
    ctx: sel ? { ref: sel.id, shape: sel.shape, name: sel.name } : null,
    ops: [],
    errors: [],
  };
  const unrecognized: string[] = [];
  for (const c of splitClauses(trimmed)) {
    if (!c.f.trim()) continue;
    if (!parseClause(c, st)) unrecognized.push(c.orig.trim());
  }
  return { ops: st.ops, errors: st.errors, unrecognized };
}

// ---------------------------------------------------------------------------
// Cümlelere bölme

function splitClauses(text: string): Clause[] {
  const f = fold(text);
  const ranges: [number, number][] = [];
  const hard = /[;\n]+|\.(?=\s|$)|\s+(?:daha sonra|sonra|ardindan)\s+/g;
  let last = 0;
  for (const m of f.matchAll(hard)) {
    ranges.push([last, m.index!]);
    last = m.index! + m[0].length;
  }
  ranges.push([last, f.length]);

  const out: Clause[] = [];
  for (const [a, b] of ranges) {
    // " ve " / ", " yalnızca iki tarafta da fiil varsa böler.
    let segStart = a;
    const soft = /\s+ve\s+|,\s+/g;
    soft.lastIndex = a;
    let m: RegExpExecArray | null;
    while ((m = soft.exec(f)) && m.index < b) {
      const left = f.slice(segStart, m.index);
      const right = f.slice(m.index + m[0].length, b);
      if (VERB_RE.test(left) && VERB_RE.test(right)) {
        out.push({ orig: text.slice(segStart, m.index), f: left });
        segStart = m.index + m[0].length;
      }
    }
    out.push({ orig: text.slice(segStart, b), f: f.slice(segStart, b) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parça referansları

function findNameMentions(f: string, project: Project): Ref[] {
  const out: Ref[] = [];
  const taken = new Array<boolean>(f.length).fill(false);
  const names = project.parts
    .map((p) => ({ p, n: fold(p.name).trim() }))
    .filter((x) => x.n.length > 0)
    .sort((a, b) => b.n.length - a.n.length);
  for (const { p, n } of names) {
    let idx = f.indexOf(n);
    while (idx !== -1) {
      const before = idx === 0 ? ' ' : f[idx - 1];
      let end = idx + n.length;
      let ok = false;
      if (!/[a-z0-9]/.test(before) && !taken.slice(idx, end).some(Boolean)) {
        const next = f[end] ?? ' ';
        if (next === "'") {
          ok = true;
          end++;
          while (end < f.length && /[a-z]/.test(f[end])) end++;
        } else if (!/[a-z0-9]/.test(next)) {
          ok = true;
        } else if (/[a-z]/.test(next) && /[a-z]$/.test(n)) {
          let e = end;
          while (e < f.length && /[a-z]/.test(f[e])) e++;
          if (SUFFIXES.has(f.slice(end, e))) {
            ok = true;
            end = e;
          }
        }
      }
      if (ok) {
        out.push({ ref: p.id, shape: p.shape, name: p.name, start: idx, end });
        for (let i = idx; i < end; i++) taken[i] = true;
      }
      idx = f.indexOf(n, idx + 1);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

interface ShapeHit {
  word: ShapeWord;
  start: number;
  end: number;
  bare: boolean;
}

function findShapeWords(masked: string): ShapeHit[] {
  const out: ShapeHit[] = [];
  for (const m of masked.matchAll(/[a-z]+/g)) {
    const w = m[0];
    for (const sw of SHAPE_WORDS) {
      if (!w.startsWith(sw.stem)) continue;
      const suf = w.slice(sw.stem.length);
      if (suf === '' || SUFFIXES.has(suf)) {
        out.push({ word: sw, start: m.index!, end: m.index! + w.length, bare: suf === '' });
        break;
      }
    }
  }
  return out;
}

/** "kutunun" gibi şekil kelimesiyle yapılan referansı mevcut bir parçaya bağlar. */
function resolveShapeRef(shape: ShapeType, st: State): Target | null {
  const cands = st.project.parts.filter((p) => p.shape === shape);
  if (st.ctx && st.ctx.shape === shape) return st.ctx;
  if (!cands.length) return null;
  const p = cands[cands.length - 1];
  return { ref: p.id, shape: p.shape, name: p.name };
}

function mask(f: string, spans: { start: number; end: number }[]): string {
  const chars = f.split('');
  for (const s of spans) for (let i = s.start; i < s.end; i++) chars[i] = ' ';
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Sayılar ve ölçü kelimeleri

interface NumTok {
  value: number;
  start: number;
  end: number;
  kind: 'len' | 'deg' | 'pct' | 'factor' | 'plain';
  /** "30'a", "40 mm'ye" gibi yönelme eki: hedef değer. */
  target: boolean;
  used: boolean;
}

function preprocessNumbers(s: string): string {
  return s
    .replace(/\byuzde\s*(\d)/g, '%$1')
    .replace(/(\d)\s*[x×*]\s*(?=\d)/g, '$1 ')
    .replace(/\b(bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|oniki)\s+(kat|kenar|kose|tane|adet|kez|defa)/g, (_, w, k) => `${NUMBER_WORDS[w]} ${k}`)
    .replace(/\byari(?:ya|sina|si)?\b|\byarim\b/g, '0.5 kat');
}

function findNumbers(s: string): NumTok[] {
  const out: NumTok[] = [];
  const re =
    /(%\s*)?([+-]?\d+(?:[.,]\d+)?)(?:\s*(mm|milimetre|cm|santimetre|santim|derece|°|%|kat\w*))?(?:'?(y?[ea])\b|\s+(?:mm\s*)?e kadar)?/g;
  for (const m of s.matchAll(re)) {
    let value = parseFloat(m[2].replace(',', '.'));
    const unit = m[3] ?? '';
    let kind: NumTok['kind'] = 'plain';
    if (m[1] || unit === '%') kind = 'pct';
    else if (unit.startsWith('kat')) kind = 'factor';
    else if (unit === 'derece' || unit === '°') kind = 'deg';
    else if (unit) kind = 'len';
    if (unit === 'cm' || unit.startsWith('santim')) value *= 10;
    const target = !!m[4] || /e kadar$/.test(m[0]);
    out.push({ value, start: m.index!, end: m.index! + m[0].length, kind, target, used: false });
  }
  return out;
}

interface KwTok {
  word: DimWord;
  start: number;
  end: number;
  form: 'poss' | 'adj' | 'neutral';
}

function findKeywords(s: string): KwTok[] {
  let work = s;
  const out: KwTok[] = [];
  for (const [re, word] of KEYWORDS) {
    for (const m of work.matchAll(re)) {
      const w = m[0];
      const form: KwTok['form'] = /(?:li|lu|inde|unda|nda|nde)$/.test(w)
        ? 'adj'
        : /(?:i|u|ini|unu|si|ine|una)$/.test(w) && !/(?:cap|lik|luk|boy|en)$/.test(w)
          ? 'poss'
          : 'neutral';
      out.push({ word, start: m.index!, end: m.index! + w.length, form });
    }
    work = work.replace(re, (x) => ' '.repeat(x.length));
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Ölçü kelimelerini yakındaki sayılarla eşleştirir. */
function associate(kws: KwTok[], nums: NumTok[]): { kw: KwTok; num: NumTok }[] {
  const pairs: { kw: KwTok; num: NumTok }[] = [];
  kws.forEach((kw, i) => {
    const prevKwEnd = i > 0 ? kws[i - 1].end : -1;
    const nextKwStart = i < kws.length - 1 ? kws[i + 1].start : Infinity;
    const usable = nums.filter((n) => !n.used && n.kind !== 'deg');
    const next = usable.find((n) => n.start >= kw.end && n.start < nextKwStart);
    const prev = [...usable].reverse().find((n) => n.end <= kw.start && n.start > prevKwEnd);
    const pick = kw.form === 'adj' ? (prev ?? next) : (next ?? prev);
    if (pick) {
      pick.used = true;
      pairs.push({ kw, num: pick });
    }
  });
  return pairs;
}

/** Genel ölçü kelimesini şekle özgü parametreye çevirir. */
function mapDim(shape: ShapeType, word: DimWord): { key: ParamKey | 'wall'; factor: number } | null {
  const aliases = SHAPE_DEFS[shape].aliases;
  if (word === 'radius') {
    const k = aliases.diameter;
    return k ? { key: k, factor: 2 } : null;
  }
  const k = aliases[word];
  return k ? { key: k, factor: 1 } : null;
}

const DIM_LABEL: Record<DimWord, string> = {
  diameter: 'çap',
  radius: 'yarıçap',
  outer: 'dış çap',
  inner: 'iç çap',
  bottom: 'alt çap',
  top: 'üst çap',
  height: 'yükseklik',
  width: 'genişlik',
  depth: 'derinlik',
  length: 'uzunluk',
  thickness: 'kalınlık',
  wall: 'et kalınlığı',
  sides: 'kenar sayısı',
};

// ---------------------------------------------------------------------------
// Cümle ayrıştırma

function parseClause(c: Clause, st: State): boolean {
  const mentions = findNameMentions(c.f, st.project);
  const masked = mask(c.f, mentions);
  const shapeHits = findShapeWords(masked);
  const bare = shapeHits.filter((h) => h.bare);

  // Şekil kelimesiyle yapılan referanslar ("kutunun", "silindiri")
  const refs: Ref[] = [...mentions];
  for (const h of shapeHits) {
    if (h.bare) continue;
    const t = resolveShapeRef(h.word.shape, st);
    if (t) refs.push({ ...t, start: h.start, end: h.end });
  }
  refs.sort((a, b) => a.start - b.start);
  // Referans ve şekil kelimeleri çıkarılmış metin (renk/sayı ararken karışmasın).
  const plain = mask(masked, shapeHits);
  const all = ALL_RE.test(plain);

  const targets = (allowAll: boolean): Target[] => {
    if (allowAll && all) return st.project.parts.map((p) => ({ ref: p.id, shape: p.shape, name: p.name }));
    if (refs.length) {
      const seen = new Set<string>();
      return refs.filter((r) => !seen.has(r.ref) && seen.add(r.ref));
    }
    return st.ctx ? [st.ctx] : [];
  };
  const needTargets = (allowAll: boolean): Target[] | null => {
    const t = targets(allowAll);
    if (!t.length) {
      st.errors.push(`"${c.orig.trim()}": hangi parça? Parça adını yazın ya da listeden seçin.`);
      return null;
    }
    return t;
  };
  const emit = (op: Op, t?: Target) => {
    st.ops.push(op);
    if (t) st.ctx = t;
  };

  // 1) İsim / ölçü görünürlüğü
  const showRe = /\b(?:goster|ac\b|acik|gorunsun|gorunur)/;
  const hideRe = /\b(?:gizle|sakla|kapat|kapali|gorunmesin|gizli)/;
  const namesKw = /\b(?:isim|isimler|isimleri|isimlerini|etiket|etiketler|etiketleri|etiketlerini|adlar|adlari|adlarini)\b/.test(plain);
  const dimsKw = /\b(?:olcu|olculer|olculeri|olculerini|olcuyu|boyutlar|boyutlari|boyutlarini|olculendirme)\b/.test(plain);
  if ((namesKw || dimsKw) && (showRe.test(plain) || hideRe.test(plain))) {
    const show = !hideRe.test(plain);
    emit({ op: 'view', show_names: namesKw ? show : null, show_dimensions: dimsKw ? show : null });
    return true;
  }

  const words = plain.split(/[^a-z']+/).filter(Boolean);
  const nums = () => findNumbers(preprocessNumbers(plain));

  // 1b) Delik ve roller: "tabana 5 mm çaplı delik aç", "8 mm derinliğinde", "X'i delik yap", "delikleri gizle"
  const roleWord = /\b(?:delik|kati|referans)\b(?!ler)/.exec(plain)?.[0];
  if (/\bdelik(?:ler|leri|lerini)\b/.test(plain) && (showRe.test(plain) || hideRe.test(plain))) {
    emit({ op: 'view', show_holes: !hideRe.test(plain) });
    return true;
  }
  const holeNums = nums().filter((n) => n.kind === 'len' || n.kind === 'plain');
  if (/\bdelik/.test(plain) && (/\b(?:ac|acin|del|delin)\b/.test(plain) || holeNums.length)) {
    const t = needTargets(false)?.[0];
    if (!t) return true;
    const part = st.project.parts.find((p) => p.id === t.ref);
    if (!part) {
      st.errors.push(`"${c.orig.trim()}": delik açılacak parça henüz oluşmadı; deliği ayrı bir komutla açın.`);
      return true;
    }
    if (!holeNums.length) {
      st.errors.push(`"${c.orig.trim()}": delik çapı kaç mm? Örn. "${part.name} parçasına 5 mm çaplı delik aç".`);
      return true;
    }
    const d = holeNums[0].value;
    const depthNum = /\bderin/.test(plain) ? holeNums[1] : undefined;
    const b = partBox(part, st.project.settings.resolution);
    const cx = Math.round(((b.min.x + b.max.x) / 2) * 1000) / 1000;
    const cy = Math.round(((b.min.y + b.max.y) / 2) * 1000) / 1000;
    // Delik varsayılan olarak boydan boya (1 mm taşar); derinlik verilirse üst yüzeyden aşağı.
    const h = depthNum ? depthNum.value + 1 : b.max.z - b.min.z + 2;
    const zc = depthNum ? b.max.z + 1 - h / 2 : (b.min.z + b.max.z) / 2;
    emit({
      op: 'create',
      shape: 'cylinder',
      name: `${part.name} delik`,
      role: 'hole',
      params: [
        { name: 'diameter', value: d },
        { name: 'height', value: Math.round(h * 1000) / 1000 },
      ],
      position: { x: cx, y: cy, z: Math.round(zc * 1000) / 1000 },
    });
    return true;
  }
  if (roleWord && /\b(?:yap|olsun|olarak|cevir|donustur)/.test(plain) && !holeNums.length) {
    const role = roleWord === 'delik' ? 'hole' : roleWord === 'kati' ? 'solid' : 'reference';
    const ts = needTargets(false);
    if (ts) for (const t of ts) emit({ op: 'update', part: t.ref, role }, t);
    return true;
  }

  // 2) Silme
  const hasDirection = /\b(?:yukari|asagi|saga|sola|ileri|geri)\b/.test(plain);
  if (words.some((w) => w === 'sil' || w === 'silin') || (words.includes('kaldir') && !hasDirection)) {
    const ts = needTargets(true);
    if (ts) for (const t of ts) emit({ op: 'delete', part: t.ref });
    if (ts) st.ctx = null;
    return true;
  }

  // 3) Kopyalama
  if (/\b(?:kopyala|cogalt|klonla|kopyasini)/.test(plain)) {
    const ts = needTargets(false);
    if (!ts) return true;
    const countM = preprocessNumbers(plain).match(/(\d+)\s*(?:tane|adet|kez|defa|kopya)/);
    const count = Math.min(50, Math.max(1, countM ? parseInt(countM[1], 10) : 1));
    const newName = extractName(c);
    for (const t of ts) {
      for (let i = 0; i < count; i++) {
        emit(
          { op: 'duplicate', part: i === 0 ? t.ref : '$last', new_name: newName ? (count > 1 ? `${newName} ${i + 1}` : newName) : undefined },
          { ref: '$last', shape: t.shape, name: newName ?? t.name },
        );
      }
    }
    return true;
  }

  // 4) Oluşturma
  const noVerb = !VERB_RE.test(plain);
  if (bare.length && (CREATE_RE.test(plain) || noVerb)) {
    return parseCreate(c, st, refs, bare[0]);
  }

  // Oluşturma değilse yalın şekil kelimeleri de referanstır ("silindir çapı 30 olsun").
  if (!refs.length) {
    for (const h of bare) {
      const t = resolveShapeRef(h.word.shape, st);
      if (t) refs.push({ ...t, start: h.start, end: h.end });
    }
  }

  // 5) Yeniden adlandırma
  if (/\b(?:adini|ismini|adi|ismi)\b/.test(plain) || /\badlandir/.test(plain)) {
    const newName = extractRename(c, refs);
    if (newName) {
      const ts = needTargets(false);
      if (ts) emit({ op: 'update', part: ts[0].ref, name: newName }, { ...ts[0], name: newName });
      return true;
    }
  }

  // 6) Üstüne / yanına koy
  const onM = /\b(?:ustune|uzerine|ustunde|tepesine)\b/.exec(plain);
  const besideM = /\b(?:yanina|sagina|soluna|onune|arkasina)\b/.exec(plain);
  const rel = onM ?? besideM;
  if (rel && refs.length) {
    const before = refs.filter((r) => r.end <= rel.index);
    const target = before[before.length - 1];
    if (!target) {
      st.errors.push(`"${c.orig.trim()}": neyin ${onM ? 'üstüne' : 'yanına'} konacağı anlaşılamadı.`);
      return true;
    }
    const other = refs.find((r) => r.ref !== target.ref);
    const part: Target | null = other ?? (st.ctx && st.ctx.ref !== target.ref ? st.ctx : null);
    if (!part) {
      st.errors.push(`"${c.orig.trim()}": hangi parçanın taşınacağı anlaşılamadı.`);
      return true;
    }
    if (onM) emit({ op: 'place_on', part: part.ref, target: target.ref }, part);
    else {
      const w = besideM![0];
      const side: Side = w === 'soluna' ? '-x' : w === 'arkasina' ? '+y' : w === 'onune' ? '-y' : '+x';
      const n = nums().find((x) => x.kind === 'len' || x.kind === 'plain');
      const gap = /\bbitisik/.test(plain) ? 0 : n ? n.value : 5;
      emit({ op: 'place_beside', part: part.ref, target: target.ref, side, gap }, part);
    }
    return true;
  }

  // 7) Tablaya indir
  if (/\b(?:yere|yataga|tablaya|zemine)\b/.test(plain) && /\b(?:indir|oturt|koy|yerlestir|yasla|dusur|al)/.test(plain)) {
    const ts = needTargets(true);
    if (ts) for (const t of ts) emit({ op: 'drop_to_bed', part: t.ref }, t);
    return true;
  }

  // 8) Döndürme
  if (/\b(?:dondur|cevir|yatir)/.test(plain)) {
    const ts = needTargets(true);
    if (!ts) return true;
    const axM = plain.match(/(?:^|[^a-z0-9])([xyz])(?:'[a-z]*)?(?=[^a-z0-9]|$)/);
    let axis: Axis = axM ? (axM[1] as Axis) : /\byatir/.test(plain) || /\bters\b/.test(plain) ? 'x' : 'z';
    const ns = nums().filter((n) => n.kind === 'deg' || n.kind === 'plain');
    let deg = ns.length ? ns[0].value : /\bters\b/.test(plain) ? 180 : 90;
    if (/saat\s+yonunde/.test(plain) && !/saat\s+yonunun\s+tersine/.test(plain)) {
      axis = axM ? axis : 'z';
      deg = -Math.abs(deg);
    }
    for (const t of ts) emit({ op: 'rotate', part: t.ref, axis, degrees: deg }, t);
    return true;
  }

  // 9) Taşıma / konum
  const moveVerb = /\b(?:tasi|kaydir|gotur|hareket|ilerlet|konum|kaldir)/.test(plain);
  if (moveVerb || (hasDirection && /\d/.test(plain))) {
    const ts = needTargets(true);
    if (!ts) return true;
    const p = preprocessNumbers(plain);
    const absolute = /\bkonum/.test(p) || /(?:^|[^a-z])[xyz]\s*[=:]/.test(p);
    const pairRe = /(?<![a-z0-9])([xyz])\s*(?:eksen\w*|yon\w*|dogrultusunda|boyunca)?\s*[=:]?\s*([+-]?\d+(?:[.,]\d+)?)(?:\s*(mm|cm)\b)?/g;
    const pairs = [...p.matchAll(pairRe)].map((m) => ({
      axis: m[1] as Axis,
      value: parseFloat(m[2].replace(',', '.')) * (m[3] === 'cm' ? 10 : 1),
    }));
    if (absolute) {
      const pos: { x?: number; y?: number; z?: number } = {};
      if (pairs.length) for (const pr of pairs) pos[pr.axis] = pr.value;
      else {
        const ns = findNumbers(p).filter((n) => n.kind === 'len' || n.kind === 'plain');
        (['x', 'y', 'z'] as const).forEach((a, i) => ns[i] && (pos[a] = ns[i].value));
      }
      if (!Object.keys(pos).length) {
        st.errors.push(`"${c.orig.trim()}": konum değerleri anlaşılamadı (ör. x=10 y=20).`);
        return true;
      }
      for (const t of ts) emit({ op: 'set_position', part: t.ref, ...pos }, t);
      return true;
    }
    const d = { x: 0, y: 0, z: 0 };
    for (const pr of pairs) d[pr.axis] += pr.value;
    if (!pairs.length) {
      const dirs: [RegExp, Axis, number][] = [
        [/\bsaga\b/, 'x', 1],
        [/\bsola\b/, 'x', -1],
        [/\b(?:yukari|kaldir)/, 'z', 1],
        [/\basagi/, 'z', -1],
        [/\b(?:ileri|one)\b/, 'y', -1],
        [/\b(?:geri|arkaya)\b/, 'y', 1],
      ];
      const ns = findNumbers(p).filter((n) => n.kind === 'len' || n.kind === 'plain');
      const dir = dirs.find(([re]) => re.test(p));
      if (!dir || !ns.length) {
        st.errors.push(`"${c.orig.trim()}": taşıma yönü/mesafesi anlaşılamadı (ör. "x yönünde 20 mm taşı", "10 mm yukarı taşı").`);
        return true;
      }
      d[dir[1]] += dir[2] * Math.abs(ns[0].value);
    }
    for (const t of ts) emit({ op: 'move', part: t.ref, dx: d.x, dy: d.y, dz: d.z }, t);
    return true;
  }

  // 10) Ölçü değişikliği
  const pp = preprocessNumbers(plain);
  const kws = findKeywords(pp);
  if (kws.length) {
    const ts = needTargets(true);
    if (!ts) return true;
    const ns = findNumbers(pp);
    const pairs = associate(kws, ns);
    if (!pairs.length) {
      st.errors.push(`"${c.orig.trim()}": yeni ölçü değeri bulunamadı (ör. "çapını 10 mm büyüt", "yüksekliğini 30 yap").`);
      return true;
    }
    const inc = INC_RE.test(pp);
    const dec = DEC_RE.test(pp) && !inc;
    const shrink = SHRINK_RE.test(pp) && !inc;
    for (const t of ts) {
      const changes: ParamChange[] = [];
      for (const { kw, num } of pairs) {
        const m = mapDim(t.shape, kw.word);
        if (!m) {
          st.errors.push(`'${t.name}' (${SHAPE_DEFS[t.shape].label}) için '${DIM_LABEL[kw.word]}' ölçüsü yok.`);
          continue;
        }
        changes.push(changeFor(m.key, m.factor, num, inc, dec, shrink));
      }
      if (changes.length) emit({ op: 'update', part: t.ref, params: changes }, t);
    }
    return true;
  }

  // 11) Bütün parçayı ölçekleme
  if (/\b(?:buyut|kucult|olcekle|olceklendir)/.test(pp)) {
    const ts = needTargets(true);
    if (!ts) return true;
    const n = findNumbers(pp)[0];
    const grow = /\b(?:buyut)/.test(pp);
    let factor: number | null = null;
    if (n?.kind === 'pct') factor = grow ? 1 + n.value / 100 : 1 - n.value / 100;
    else if (n?.kind === 'factor') factor = grow || n.value < 1 ? n.value : 1 / n.value;
    if (factor === null) {
      // Tek ölçülü şekillerde (küre) mm ile büyütmeyi çapa uygula.
      if (n && ts.every((t) => t.shape === 'sphere')) {
        for (const t of ts)
          emit({ op: 'update', part: t.ref, params: [{ name: 'diameter', value: grow ? n.value : -n.value, mode: 'add' }] }, t);
        return true;
      }
      st.errors.push(`"${c.orig.trim()}": hangi ölçü? Örn. "çapını 10 mm büyüt" ya da "%20 büyüt", "2 kat büyüt".`);
      return true;
    }
    for (const t of ts) emit({ op: 'scale', part: t.ref, factor }, t);
    return true;
  }

  // 12) Renk
  const color = findColor(c.f, plain);
  if (color) {
    const ts = needTargets(true);
    if (ts) for (const t of ts) emit({ op: 'update', part: t.ref, color }, t);
    return true;
  }

  // 13) Göster / gizle
  if (hideRe.test(plain) || /\bgoster/.test(plain)) {
    const ts = needTargets(true);
    const visible = !hideRe.test(plain);
    if (ts) for (const t of ts) emit({ op: 'update', part: t.ref, visible }, t);
    return true;
  }

  // 14) Seçme
  if (words.includes('sec')) {
    const ts = needTargets(false);
    if (ts) emit({ op: 'select', part: ts[0].ref }, ts[0]);
    return true;
  }

  return false;
}

function changeFor(
  key: ParamKey | 'wall',
  factor: number,
  num: NumTok,
  inc: boolean,
  dec: boolean,
  shrink: boolean,
): ParamChange {
  if (num.kind === 'factor') {
    const k = shrink && num.value >= 1 ? 1 / num.value : num.value;
    return { name: key, value: k, mode: 'mul' };
  }
  if (num.kind === 'pct') {
    if (inc) return { name: key, value: 1 + num.value / 100, mode: 'mul' };
    if (dec) return { name: key, value: 1 - num.value / 100, mode: 'mul' };
    return { name: key, value: num.value / 100, mode: 'mul' };
  }
  const v = num.value * factor;
  if (num.target || (!inc && !dec)) return { name: key, value: v, mode: 'set' };
  return { name: key, value: inc ? v : -v, mode: 'add' };
}

// ---------------------------------------------------------------------------
// Oluşturma

function parseCreate(c: Clause, st: State, refs: Ref[], hit: ShapeHit): boolean {
  const shape = hit.word.shape;
  const def = SHAPE_DEFS[shape];
  const nameSpan = findNameSpan(c);
  const name = nameSpan?.name;
  // İsim ve referanslar sayı/renk aramasına karışmasın.
  const spans = [...refs, { start: hit.start, end: hit.end }];
  if (nameSpan) spans.push(nameSpan);
  const plain = mask(c.f, spans);
  const pp = preprocessNumbers(plain);

  const ns = findNumbers(pp);
  // Adet: "4 tane küp"
  let count = 1;
  const countM = /(\d+)\s*(?:tane|adet)\b/.exec(pp);
  if (countM) {
    count = Math.min(50, Math.max(1, parseInt(countM[1], 10)));
    ns.forEach((n) => n.start === countM.index && (n.used = true));
  }

  const params: ParamChange[] = [];
  const setParam = (key: ParamKey | 'wall', value: number) => {
    const i = params.findIndex((p) => p.name === key);
    if (i >= 0) params.splice(i, 1);
    params.push({ name: key, value, mode: 'set' });
  };
  if (hit.word.sides) setParam('sides', hit.word.sides);

  for (const { kw, num } of associate(findKeywords(pp), ns)) {
    const m = mapDim(shape, kw.word);
    if (!m) {
      st.errors.push(`${def.label} için '${DIM_LABEL[kw.word]}' ölçüsü yok; yok sayıldı.`);
      continue;
    }
    setParam(m.key, num.value * m.factor);
  }

  // Etiketsiz sayılar şeklin ölçü sırasına göre atanır: kutu G×D×Y, silindir Ç×Y...
  const free = ns.filter((n) => !n.used && (n.kind === 'len' || n.kind === 'plain'));
  if (free.length) {
    const order: Partial<Record<ShapeType, ParamKey[]>> = {
      box: ['width', 'depth', 'height'],
      cylinder: ['diameter', 'height'],
      tube: ['outerDiameter', 'innerDiameter', 'height'],
      cone: ['bottomDiameter', 'height'],
      sphere: ['diameter'],
      torus: ['diameter', 'thickness'],
      prism: ['diameter', 'height'],
    };
    const keys = (order[shape] ?? []).filter((k) => !params.some((p) => p.name === k));
    if (shape === 'box' && free.length === 1 && keys.length === 3) {
      for (const k of keys) setParam(k, free[0].value);
    } else {
      free.forEach((n, i) => keys[i] && setParam(keys[i], n.value));
    }
  }
  if (hit.word.cube) {
    const side = params.find((p) => ['width', 'depth', 'height'].includes(p.name))?.value;
    if (side) for (const k of ['width', 'depth', 'height'] as const) setParam(k, side);
  }

  const color = findColor(c.f, plain) ?? undefined;
  const onM = /\b(?:ustune|uzerine|tepesine)\b/.exec(plain);
  const besideM = /\b(?:yanina|sagina|soluna|onune|arkasina)\b/.exec(plain);
  const relTarget = (m: RegExpExecArray | null) => {
    if (!m) return undefined;
    const before = refs.filter((r) => r.end <= m.index);
    return before[before.length - 1];
  };
  const onTarget = relTarget(onM);
  const besideTarget = relTarget(besideM);

  for (let i = 0; i < count; i++) {
    const nm = name ? (count > 1 ? `${name} ${i + 1}` : name) : undefined;
    st.ops.push({ op: 'create', shape, name: nm, params: [...params], color, place_on: onTarget?.ref });
    if (besideTarget && besideM) {
      const w = besideM[0];
      const side: Side = w === 'soluna' ? '-x' : w === 'arkasina' ? '+y' : w === 'onune' ? '-y' : '+x';
      st.ops.push({ op: 'place_beside', part: '$last', target: besideTarget.ref, side, gap: 5 });
    }
  }
  st.ctx = { ref: '$last', shape, name: name ?? def.label };
  return true;
}

// ---------------------------------------------------------------------------
// İsim çıkarma

function cleanName(s: string): string {
  return s
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/[.,;:!?]+$/, '')
    .trim();
}

/** Oluşturma cümlesindeki isim: "adı mil olsun", "adı 'sol ayak'", "mil adında". */
function findNameSpan(c: Clause): { name: string; start: number; end: number } | null {
  const f = c.f;
  const quoted = /\b(?:adi|ismi|isim|ad)\s*[:=]?\s*["“']([^"”']+)["”']/d.exec(f);
  if (quoted) {
    const [s, e] = quoted.indices![1]!;
    return { name: cleanName(c.orig.slice(s, e)), start: quoted.index, end: quoted.index + quoted[0].length };
  }
  const after = /\b(?:adi|ismi)\s*[:=]?\s*([^\s,;]+(?:\s+\d+)?)(\s+(?:olsun|olan)\b)?/d.exec(f);
  if (after && !/^(?:olsun|olan|ile)$/.test(after[1])) {
    const [s, e] = after.indices![1]!;
    return { name: cleanName(c.orig.slice(s, e)), start: after.index, end: after.index + after[0].length };
  }
  const before = /([^\s,;]+)\s+(?:adinda|adli|isimli|isminde)\b/d.exec(f);
  if (before) {
    const [s, e] = before.indices![1]!;
    return { name: cleanName(c.orig.slice(s, e)), start: before.index, end: before.index + before[0].length };
  }
  return null;
}

function extractName(c: Clause): string | undefined {
  return findNameSpan(c)?.name;
}

/** "X'in adını Y yap", "adını Y olarak değiştir", "X'i Y olarak adlandır". */
function extractRename(c: Clause, refs: Ref[]): string | null {
  const f = mask(c.f, refs);
  const kw = /\b(?:adini|ismini|adi|ismi)\b/.exec(f);
  let start: number;
  if (kw) start = kw.index + kw[0].length;
  else if (refs.length) start = refs[refs.length - 1].end;
  else start = 0;
  const rest = f.slice(start);
  const endM = /\s+(?:olarak\s+(?:degistir|adlandir|yap|ayarla)\w*|diye\s+adlandir\w*|olarak|yap\w*|koy\w*|olsun|degistir\w*|ver\w*|adlandir\w*)\s*[.!]?\s*$/.exec(rest);
  if (!endM) return null;
  const raw = c.orig.slice(start, start + endM.index);
  const name = cleanName(raw);
  return name ? name : null;
}

// ---------------------------------------------------------------------------
// Renk

function findColor(f: string, plain: string): string | null {
  const hex = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/.exec(f);
  if (hex) return normalizeHex(hex[0]);
  for (const m of plain.matchAll(/[a-z]+/g)) {
    const w = m[0];
    for (const [name, hexv] of Object.entries(COLOR_NAMES)) {
      const suffix = w.slice(name.length);
      if (w === name || (w.startsWith(name) && SUFFIXES.has(suffix))) {
        // "altına/altında" (aşağısına) altın rengi değildir.
        if (name === 'altin' && suffix) continue;
        const before = plain.slice(Math.max(0, m.index! - 6), m.index!);
        const mod = /acik\s*$/.test(before) ? 'acik ' : /koyu\s*$/.test(before) ? 'koyu ' : '';
        return mod ? (resolveColor(mod + name) ?? hexv) : hexv;
      }
    }
  }
  return null;
}
