import type { LlmStatus, NlRequest, NlResponse } from '../../shared/ops';

export type { LlmStatus };

const OFF: LlmStatus = { llm: false, backend: null, model: '', bridge: false };

/** Sunucu yanıt vermezse (ör. geliştirme sunucusu yeniden başlıyor) null. */
export async function fetchLlmStatus(): Promise<LlmStatus | null> {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) return r.status === 404 ? OFF : null;
    return { ...OFF, ...((await r.json()) as Partial<LlmStatus>) };
  } catch {
    return null;
  }
}

export async function askClaude(req: NlRequest): Promise<NlResponse> {
  const r = await fetch('/api/nl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const data = (await r.json().catch(() => ({}))) as Partial<NlResponse> & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `Sunucu hatası (${r.status})`);
  return { reply: data.reply ?? '', operations: data.operations ?? [] };
}
