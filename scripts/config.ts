// `p3d` komutunun çalışma alanı seçimi ve p3d.json keşfi (scripts/p3d.ts kullanır; ayrı modül ki testler
// içe aktarabilsin — p3d.ts içe aktarılınca komut çalışır).
//
// p3d.json (tüketici projesinin klasöründe; komutun yazıldığı klasörden yukarı doğru aranır):
//   { "workspace": "canta-v2", "file": "model/canta.p3d.json", "onAmbiguity": "ask-critical" }
// `file` p3d.json'ın klasörüne göredir. Çalışma alanı sırası: --ws > P3D_WS > p3d.json > kök.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT_WS, normalizeWs } from '../shared/ops.ts';

export const CONFIG_NAME = 'p3d.json';
export const AMBIGUITY_MODES = ['ask-critical', 'assume', 'ask-all'] as const;
export type AmbiguityMode = (typeof AMBIGUITY_MODES)[number];

export interface P3dConfig {
  workspace: string;
  /** Proje dosyası, p3d.json'ın klasörüne göre. */
  file?: string;
  onAmbiguity?: AmbiguityMode;
}

export interface FoundConfig {
  /** p3d.json'ın mutlak yolu. */
  path: string;
  config: P3dConfig;
  /** `file`'ın mutlak yolu (yalnızca p3d.json'ın klasörünün içindeyse). */
  file?: string;
  /** `file` p3d.json'ın klasörünün dışını gösteriyorsa açıklama; `file` o zaman yoktur. */
  fileError?: string;
}

/** `file`, `dir`'in içinde mi (`..` ile ya da başka bir sürücüye çıkmıyor). */
export function insideDir(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== '' && rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel);
}

/** İki dosya yolu aynı dosyayı mı gösteriyor (normalleştirilmiş; Windows'ta büyük/küçük harf duyarsız). */
export function samePath(a: string, b: string, platform: string = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const [x, y] = [p.resolve(a), p.resolve(b)];
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** p3d.json içeriğini doğrular; sorun varsa dosya yolunu içeren Türkçe Error fırlatır. */
export function parseConfig(text: string, where: string): P3dConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`${where} geçerli JSON değil: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${where} bir JSON nesnesi olmalı: { "workspace": "ad", "file": "model.p3d.json" }`);
  const o = raw as Record<string, unknown>;
  if (typeof o.workspace !== 'string') throw new Error(`${where}: "workspace" alanı gerekli (metin; kök için "").`);
  let workspace: string;
  try {
    workspace = normalizeWs(o.workspace);
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
  const out: P3dConfig = { workspace };
  if (o.file !== undefined) {
    if (typeof o.file !== 'string' || !o.file.trim()) throw new Error(`${where}: "file" boş olmayan bir metin (dosya yolu) olmalı.`);
    out.file = o.file;
  }
  if (o.onAmbiguity !== undefined) {
    if (!(AMBIGUITY_MODES as readonly unknown[]).includes(o.onAmbiguity)) {
      throw new Error(`${where}: "onAmbiguity" şunlardan biri olmalı: ${AMBIGUITY_MODES.join(', ')}.`);
    }
    out.onAmbiguity = o.onAmbiguity as AmbiguityMode;
  }
  return out;
}

/**
 * `startDir`'den köke doğru ilk p3d.json'u bulur; yoksa null, bozuksa Error. `stopAt` verilirse arama o klasörde
 * biter (üstüne çıkılmaz).
 */
export function findConfig(startDir: string, stopAt?: string): FoundConfig | null {
  let dir = path.resolve(startDir);
  const stop = stopAt === undefined ? undefined : path.resolve(stopAt);
  for (;;) {
    const file = path.join(dir, CONFIG_NAME);
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      // yok
    }
    if (isFile) {
      const config = parseConfig(readFileSync(file, 'utf8'), file);
      if (!config.file) return { path: file, config };
      const abs = path.resolve(dir, config.file);
      // p3d.json yalnızca kendi klasöründeki bir dosyayı gösterebilir: open/save başka bir projenin dosyasına dokunmasın.
      if (!insideDir(dir, abs)) {
        return {
          path: file,
          config,
          fileError: `${file}: "file" (${config.file}) p3d.json'ın klasörünün dışını gösteriyor; yalnızca ${dir} içindeki bir yol kullanılabilir. Başka bir dosya için yolu komutta açıkça yazın.`,
        };
      }
      return { path: file, config, file: abs };
    }
    const parent = path.dirname(dir);
    if (parent === dir || (stop !== undefined && samePath(dir, stop))) return null;
    dir = parent;
  }
}

export type WsSource = '--ws' | 'P3D_WS' | 'p3d.json' | 'varsayılan';

export interface WorkspaceChoice {
  ws: string;
  source: WsSource;
  /** Bulunan p3d.json (ws başka kaynaktan gelse de `file` için kullanılır). */
  config: FoundConfig | null;
  /** ws --ws/P3D_WS'den geldiyse p3d.json hatası burada bekler; dosya gerektiğinde fırlatılır. */
  configError?: Error;
}

function wsArg(raw: string, where: string): string {
  if (raw === '/') return ROOT_WS; // `--ws /` = kök
  try {
    return normalizeWs(raw);
  } catch (e) {
    throw new Error(`${where}: ${(e as Error).message}`);
  }
}

/** Çalışma alanı sırası: --ws > P3D_WS > (cwd'den yukarı; `stopAt`'te durarak) p3d.json > kök. */
export function resolveWorkspace(o: { flag?: string; env?: string; cwd: string; stopAt?: string }): WorkspaceChoice {
  let config: FoundConfig | null = null;
  let configError: Error | undefined;
  try {
    config = findConfig(o.cwd, o.stopAt);
  } catch (e) {
    configError = e as Error;
  }
  const pick = (ws: string, source: WsSource): WorkspaceChoice => ({ ws, source, config, ...(configError ? { configError } : {}) });
  if (o.flag !== undefined) return pick(wsArg(o.flag, '--ws'), '--ws');
  if (o.env) return pick(wsArg(o.env, 'P3D_WS'), 'P3D_WS');
  if (configError) throw configError;
  if (config) return pick(config.config.workspace, 'p3d.json');
  return pick(ROOT_WS, 'varsayılan');
}

/**
 * Sahneyi değiştiren komut, kullanıcının kök alanına (kişisel sahnesi) yanlışlıkla mı gidiyor? P3D deposu dışından,
 * --ws / P3D_WS / p3d.json olmadan çalışan komut köke gitmez; köke bilerek göndermek için `--ws ""` gerekir.
 * Engel yoksa null, varsa Türkçe hata metni döner.
 */
export function rootGuardError(choice: WorkspaceChoice, callerDir: string, repoRoot: string, platform: string = process.platform): string | null {
  if (choice.ws !== ROOT_WS || choice.source !== 'varsayılan') return null;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const rel = p.relative(p.resolve(repoRoot), p.resolve(callerDir));
  if (samePath(callerDir, repoRoot, platform) || (rel.split(/[\\/]/)[0] !== '..' && !p.isAbsolute(rel))) return null;
  return [
    `Bu komut kök çalışma alanına (kullanıcının kişisel sahnesi) gidecekti: ${callerDir} ve üst klasörlerinde p3d.json yok, --ws de verilmedi.`,
    'Kendi alanınızı seçin: proje kökünde p3d.json → {"workspace": "<ad>"} ya da --ws <ad> (tarayıcıda http://localhost:5173/w/<ad>).',
    'Köke bilerek göndermek için --ws "" verin.',
  ].join('\n');
}
