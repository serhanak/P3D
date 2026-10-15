import type { NlRequest, NlResponse } from '../../shared/ops';

export interface LlmStatus {
  llm: boolean;
  model: string;
}

export async function fetchLlmStatus(): Promise<LlmStatus> {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) return { llm: false, model: '' };
    return (await r.json()) as LlmStatus;
  } catch {
    return { llm: false, model: '' };
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
