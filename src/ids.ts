// Parça ve eskiz yolu kimlikleri. Ayrı modül: engine.ts ile sketch.ts arasında döngüsel içe aktarma olmasın.

/** Rastgele kimlik ("p_" + 8 karakter, [a-z0-9]). */
export function newId(): string {
  return 'p_' + Math.random().toString(36).slice(2, 10);
}
