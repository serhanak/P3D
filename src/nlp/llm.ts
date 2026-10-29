import type { LlmStatus, NlRequest, NlResponse } from '../../shared/ops';

export type { LlmStatus };

const OFF: LlmStatus = { llm: false, backend: null, model: '', bridge: false };

export async function fetchLlmStatus(): Promise<LlmStatus> {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) return OFF;
    return { ...OFF, ...((await r.json()) as Partial<LlmStatus>) };
  } catch {
    return OFF;
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
