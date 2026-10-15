import { fold } from './text';

/** Katlanmış (aksansız, küçük harf) renk adı -> hex. Uzun adlar önce eşleşsin diye sıralı tutulur. */
export const COLOR_NAMES: Record<string, string> = {
  kahverengi: '#795548',
  kirmizi: '#e53935',
  turuncu: '#fb8c00',
  lacivert: '#1a237e',
  turkuaz: '#00acc1',
  eflatun: '#ba68c8',
  gumus: '#b0bec5',
  altin: '#ffc107',
  yesil: '#43a047',
  pembe: '#ec407a',
  siyah: '#212121',
  beyaz: '#f5f5f5',
  bordo: '#8e1b3a',
  kahve: '#795548',
  mavi: '#1e88e5',
  sari: '#fdd835',
  krem: '#fff3e0',
  haki: '#827717',
  lila: '#c5a3e0',
  mor: '#8e24aa',
  gri: '#9e9e9e',
  bej: '#d7ccc8',
  // İngilizce
  orange: '#fb8c00',
  purple: '#8e24aa',
  yellow: '#fdd835',
  green: '#43a047',
  black: '#212121',
  white: '#f5f5f5',
  brown: '#795548',
  pink: '#ec407a',
  gray: '#9e9e9e',
  grey: '#9e9e9e',
  blue: '#1e88e5',
  red: '#e53935',
};

export function isHexColor(s: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s.trim());
}

export function normalizeHex(s: string): string {
  let h = s.trim().toLowerCase();
  if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
  return h;
}

function mix(hex: string, target: number, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (target - c) * t));
  return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('');
}

/** "kırmızı", "açık mavi", "#ff8800" gibi ifadeleri hex'e çevirir; tanınmazsa null. */
export function resolveColor(input: string): string | null {
  const s = fold(input).trim();
  if (isHexColor(s)) return normalizeHex(s);
  const words = s.split(/\s+/);
  let base: string | null = null;
  for (const w of words) {
    for (const [name, hex] of Object.entries(COLOR_NAMES)) {
      if (w === name || (w.startsWith(name) && w.length - name.length <= 3)) {
        base = hex;
        break;
      }
    }
    if (base) break;
  }
  if (!base) return null;
  if (/\b(acik|light)\b/.test(s)) return mix(base, 255, 0.45);
  if (/\b(koyu|dark)\b/.test(s)) return mix(base, 0, 0.4);
  return base;
}
