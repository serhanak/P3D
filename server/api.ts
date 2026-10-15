import Anthropic from '@anthropic-ai/sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RESPONSE_SCHEMA, normalizeLlmOp, type NlRequest, type NlResponse } from '../shared/ops.ts';
import { SYSTEM_PROMPT } from './prompt.ts';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const model = () => process.env.P3D_MODEL || 'claude-opus-5-5';
const effort = (): Effort => {
  const e = process.env.P3D_EFFORT as Effort | undefined;
  return e && ['low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? e : 'medium';
};

export function llmConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client: Anthropic | null = null;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Doğal dil komutunu Claude ile sahne işlemlerine çevirir. */
export async function interpret(req: NlRequest): Promise<NlResponse> {
  client ??= new Anthropic();
  const content = [
    `Sahne (JSON):\n${JSON.stringify(req.scene)}`,
    req.history.length ? `Önceki komutlar (eskiden yeniye):\n${req.history.map((h) => `- ${h}`).join('\n')}` : '',
    `Komut: ${req.text}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const response = await client.beta.messages.create({
    model: model(),
    max_tokens: 16000,
    // Güvenlik sınıflandırıcısı reddederse istek sunucu tarafında önerilen yedek modelle tekrarlanır.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: effort(), format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') {
    throw new HttpError(422, 'Claude bu isteği yanıtlamadı. Komutu farklı ifade etmeyi deneyin.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new HttpError(502, 'Claude yanıtı yarıda kesildi; komutu daha küçük adımlara bölün.');
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'Claude yanıtı çözümlenemedi.');
  }
  const out = parsed as { reply?: unknown; operations?: unknown };
  if (typeof out.reply !== 'string' || !Array.isArray(out.operations)) {
    throw new HttpError(502, 'Claude yanıtı beklenen biçimde değil.');
  }
  return {
    reply: out.reply,
    operations: out.operations
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map(normalizeLlmOp),
  };
}

// ---------------------------------------------------------------------------
// HTTP

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'İstek çok büyük.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Geçersiz JSON.');
  }
}

function validate(body: unknown): NlRequest {
  const b = body as Partial<NlRequest> | null;
  if (!b || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000) throw new HttpError(400, 'Komut metni gerekli.');
  if (!b.scene || typeof b.scene !== 'object' || !Array.isArray(b.scene.parts)) throw new HttpError(400, 'Sahne bilgisi eksik.');
  const history = Array.isArray(b.history) ? b.history.filter((h): h is string => typeof h === 'string').slice(-10) : [];
  return { text: b.text.trim(), scene: b.scene, history };
}

/** /api/status ve /api/nl uç noktaları (Vite geliştirme sunucusu ve üretim sunucusu ortak kullanır). */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(res, 200, { llm: llmConfigured(), model: model() });
    }
    if (req.method === 'POST' && url.pathname === '/api/nl') {
      if (!llmConfigured()) {
        throw new HttpError(503, 'Claude kullanılamıyor: .env dosyasında ANTHROPIC_API_KEY ayarlı değil.');
      }
      const out = await interpret(validate(await readJson(req, 2_000_000)));
      return send(res, 200, out);
    }
    throw new HttpError(404, 'Bulunamadı.');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error('[p3d] Claude isteği başarısız:', e);
    if (e instanceof Anthropic.AuthenticationError) return send(res, 401, { error: 'API anahtarı geçersiz.' });
    if (e instanceof Anthropic.PermissionDeniedError) return send(res, 403, { error: 'API anahtarının bu modele erişimi yok.' });
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'Hız sınırına takıldı; biraz sonra tekrar deneyin.' });
    if (e instanceof Anthropic.BadRequestError) return send(res, 400, { error: `Claude isteği kabul etmedi: ${e.message}` });
    if (e instanceof Anthropic.APIConnectionError) return send(res, 502, { error: "Claude API'ye bağlanılamadı." });
    if (e instanceof Anthropic.APIError) return send(res, 502, { error: `Claude API hatası (${e.status}): ${e.message}` });
    return send(res, 500, { error: 'Sunucu hatası.' });
  }
}
