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
