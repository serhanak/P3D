import Anthropic from '@anthropic-ai/sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RESPONSE_SCHEMA, normalizeLlmOp, type LlmStatus, type NlRequest, type NlResponse } from '../shared/ops.ts';
import { handleBridge } from './bridge.ts';
import { ClaudeCliError, runClaudeCli } from './claude-cli.ts';
import { bridgeEnabled, claudeBin, effort, llmBackend, model } from './config.ts';
import { SYSTEM_PROMPT } from './prompt.ts';

let client: Anthropic | null = null;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function userContent(req: NlRequest): string {
  return [
    `Sahne (JSON):\n${JSON.stringify(req.scene)}`,
    req.history.length ? `Önceki komutlar (eskiden yeniye):\n${req.history.map((h) => `- ${h}`).join('\n')}` : '',
    `Komut: ${req.text}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Doğal dil komutunu Claude ile sahne işlemlerine çevirir (etkin arka uca göre API ya da `claude -p`). */
export async function interpret(req: NlRequest): Promise<NlResponse> {
  const backend = llmBackend();
  if (!backend) throw new HttpError(503, 'Claude kapalı: ANTHROPIC_API_KEY yok ya da P3D_LLM=off. Bkz. README → Claude modu.');
  const parsed =
    backend === 'claude-cli'
      ? await runClaudeCli(userContent(req), { bin: claudeBin(), model: model(), effort: effort(), system: SYSTEM_PROMPT, schema: RESPONSE_SCHEMA })
      : await interpretWithApi(req);
  const out = parsed as { reply?: unknown; operations?: unknown } | null;
  if (!out || typeof out.reply !== 'string' || !Array.isArray(out.operations)) {
    throw new HttpError(502, 'Claude yanıtı beklenen biçimde değil.');
  }
  return {
    reply: out.reply,
    operations: out.operations
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
      .map(normalizeLlmOp),
  };
}

async function interpretWithApi(req: NlRequest): Promise<unknown> {
  client ??= new Anthropic();
  const response = await client.beta.messages.create({
    model: model(),
    max_tokens: 16000,
    // Güvenlik sınıflandırıcısı reddederse istek sunucu tarafında önerilen yedek modelle tekrarlanır.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: effort(), format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages: [{ role: 'user', content: userContent(req) }],
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
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, 'Claude yanıtı çözümlenemedi.');
  }
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
    if (bridgeEnabled() && (await handleBridge(req, res, url.pathname))) return;
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const backend = llmBackend();
      const status: LlmStatus = { llm: backend !== null, backend, model: model(), bridge: bridgeEnabled() };
      return send(res, 200, status);
    }
    if (req.method === 'POST' && url.pathname === '/api/nl') {
      const out = await interpret(validate(await readJson(req, 2_000_000)));
      return send(res, 200, out);
    }
    throw new HttpError(404, 'Bulunamadı.');
  } catch (e) {
    if (e instanceof HttpError || e instanceof ClaudeCliError) return send(res, e.status, { error: e.message });
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
