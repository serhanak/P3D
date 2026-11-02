const FOLD: Record<string, string> = {
  ç: 'c',
  ğ: 'g',
  ı: 'i',
  ö: 'o',
  ş: 's',
  ü: 'u',
  â: 'a',
  î: 'i',
  û: 'u',
  '’': "'",
  '‘': "'",
  '`': "'",
  '´': "'",
};

/**
 * Türkçe küçük harfe çevirip aksanları kaldırır ("Çapını" -> "capini").
 * Karakter karakter eşleşir; çıktı uzunluğu girdiyle aynıdır, böylece katlanmış
 * metinde bulunan indeksler orijinal metinde de geçerlidir.
 */
export function fold(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    let c = s[i].toLocaleLowerCase('tr');
    if (c.length !== 1) c = c[0];
    out += FOLD[c] ?? c;
  }
  return out;
}

const ASCII: Record<string, string> = { ç: 'c', Ç: 'C', ğ: 'g', Ğ: 'G', ı: 'i', İ: 'I', ö: 'o', Ö: 'O', ş: 's', Ş: 'S', ü: 'u', Ü: 'U' };

/** Türkçe harfleri ASCII karşılığına çevirir, diğer aksanları atar ("Sağ Tekerlek" → "Sag Tekerlek"); büyük/küçük harf korunur. */
export function toAscii(s: string): string {
  return s
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => ASCII[c])
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}
