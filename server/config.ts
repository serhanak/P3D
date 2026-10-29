// Sunucu yapılandırması: ortam değişkenlerinden okunur (.env ya da scripts/launch.ts'in açılış parametreleri).
// Değerler her çağrıda okunur; böylece Vite ara katmanı ve üretim sunucusu aynı kodu kullanır.

/**
 * Doğal dil arka ucu (P3D_LLM / --llm):
 * - `api`: Anthropic API, ANTHROPIC_API_KEY ile (sunucu kurulumu).
 * - `claude-cli`: makinedeki `claude -p`; o kullanıcının Claude Code hesabıyla (yalnızca kişisel/yerel kullanım).
 * - `off`: yalnızca yerel ayrıştırıcı.
 * - `auto` (varsayılan): anahtar varsa `api`, yoksa `off`. `claude-cli` asla kendiliğinden seçilmez.
 */
export type LlmMode = 'auto' | 'api' | 'claude-cli' | 'off';
export type LlmBackend = 'api' | 'claude-cli';

export const LLM_MODES: readonly LlmMode[] = ['auto', 'api', 'claude-cli', 'off'];
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export function llmMode(): LlmMode {
  const v = process.env.P3D_LLM?.trim().toLowerCase() as LlmMode | undefined;
  return v && LLM_MODES.includes(v) ? v : 'auto';
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Etkin arka uç; Claude kapalıysa null. `api` seçili ama anahtar yoksa da null. */
export function llmBackend(): LlmBackend | null {
  const mode = llmMode();
  if (mode === 'claude-cli') return 'claude-cli';
  if (mode === 'off') return null;
  return hasApiKey() ? 'api' : null;
}

export const model = () => process.env.P3D_MODEL || 'claude-opus-5-5';

export function effort(): Effort {
  const e = process.env.P3D_EFFORT as Effort | undefined;
  return e && ['low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? e : 'medium';
}

/** `claude-cli` arka ucunun çalıştıracağı program (P3D_CLAUDE_BIN, varsayılan PATH'teki `claude`). */
export const claudeBin = () => process.env.P3D_CLAUDE_BIN || 'claude';

/** Claude Code köprüsü (P3D_BRIDGE / --bridge, --no-bridge). Varsayılan açık; üretim sunucusu kapalı başlatır. */
export function bridgeEnabled(): boolean {
  const v = process.env.P3D_BRIDGE?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/** Hatalı yapılandırma için açılışta gösterilecek uyarı. */
export function configWarning(): string | null {
  const raw = process.env.P3D_LLM?.trim().toLowerCase();
  if (raw && !LLM_MODES.includes(raw as LlmMode)) return `P3D_LLM="${raw}" tanınmadı (${LLM_MODES.join(' | ')}); "auto" kullanılıyor.`;
  if (llmMode() === 'api' && !hasApiKey()) return 'P3D_LLM=api seçili ama ANTHROPIC_API_KEY yok; Claude kapalı.';
  return null;
}

/** Açılış satırı için kısa özet. */
export function describeConfig(): string {
  const b = llmBackend();
  const llm = b === 'api' ? `API (${model()})` : b === 'claude-cli' ? `Claude Code hesabı - ${claudeBin()} -p (${model()})` : 'kapalı';
  return `Claude: ${llm} · Köprü: ${bridgeEnabled() ? 'açık' : 'kapalı'}`;
}
