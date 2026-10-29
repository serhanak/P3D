// `claude-cli` arka ucu: makinede kurulu Claude Code'u başsız (`claude -p`) çalıştırır; istek, giriş yapmış
// kullanıcının Claude Code hesabından gider. Yalnızca kişisel/yerel kullanım içindir: Claude.ai/Claude Code
// girişi başka kullanıcılara sunulan bir hizmette kullanılamaz (sunucu kurulumunda `api` arka ucunu kullanın).
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const TIMEOUT_MS = 180_000;

export class ClaudeCliError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ClaudeCliOptions {
  bin: string;
  model: string;
  effort: string;
  system: string;
  schema: object;
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  stop_reason?: string;
  structured_output?: unknown;
}

/** Komutu `claude -p`'ye verir, JSON şemasına uyan yapılandırılmış çıktıyı döner. */
export function runClaudeCli(prompt: string, o: ClaudeCliOptions): Promise<unknown> {
  const args = [
    '-p',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(o.schema),
    '--system-prompt', o.system,
    '--tools', '', // araç yok: yalnızca işlem listesi üretir, dosya/komut çalıştırmaz
    '--strict-mcp-config', // kullanıcının MCP sunucularını yükleme
    '--no-session-persistence',
    '--model', o.model,
    '--effort', o.effort,
  ];
  return new Promise((resolve, reject) => {
    // Geçici dizinde çalışır: projenin CLAUDE.md'si ve ayarları isteğe karışmasın.
    const child = spawn(o.bin, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new ClaudeCliError(504, 'Claude Code yanıtı zaman aşımına uğradı.'));
    }, TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === 'ENOENT'
          ? new ClaudeCliError(503, `"${o.bin}" bulunamadı. Claude Code kurulu ve PATH'te olmalı (ya da P3D_CLAUDE_BIN ayarlayın).`)
          : new ClaudeCliError(502, `Claude Code başlatılamadı: ${e.message}`),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let r: CliResult;
      try {
        r = JSON.parse(out);
      } catch {
        const detail = (err || out).trim().split('\n').slice(-3).join(' ').slice(0, 400);
        return reject(new ClaudeCliError(502, `Claude Code çıktısı okunamadı (çıkış kodu ${code}). ${detail}`));
      }
      if (r.is_error || r.subtype !== 'success') {
        const msg = (r.result || r.subtype || 'bilinmeyen hata').slice(0, 400);
        const login = /log ?in|auth|credential|oturum/i.test(msg) ? ' Terminalde `claude` ile giriş yapın.' : '';
        return reject(new ClaudeCliError(502, `Claude Code hatası: ${msg}${login}`));
      }
      if (r.stop_reason === 'refusal') return reject(new ClaudeCliError(422, 'Claude bu isteği yanıtlamadı. Komutu farklı ifade etmeyi deneyin.'));
      if (r.structured_output !== undefined) return resolve(r.structured_output);
      try {
        resolve(JSON.parse(r.result ?? ''));
      } catch {
        reject(new ClaudeCliError(502, 'Claude Code yanıtı çözümlenemedi.'));
      }
    });
    child.stdin.end(prompt, 'utf8');
  });
}
