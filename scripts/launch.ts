// Açılış parametrelerini ortam değişkenlerine çevirip sunucuyu başlatır (parametre > ortam > .env).
//
//   npm run dev   -- [--llm=auto|api|claude-cli|off] [--bridge|--no-bridge] [--port=5173] [--model=…] [--effort=…]
//   npm start     -- [aynı parametreler]   (üretim: dist/ + /api; köprü varsayılan kapalı)
//
// Örnekler:
//   npm run dev -- --llm=claude-cli        serbest komutlar bu makinedeki Claude Code hesabıyla
//   npm start -- --llm=api                 sunucu kurulumu: yalnızca ANTHROPIC_API_KEY
import { configWarning, describeConfig, LLM_MODES } from '../server/config.ts';

const [target, ...args] = process.argv.slice(2);

const ENV_FOR: Record<string, string> = {
  llm: 'P3D_LLM',
  bridge: 'P3D_BRIDGE',
  port: 'PORT',
  host: 'HOST',
  model: 'P3D_MODEL',
  effort: 'P3D_EFFORT',
  'claude-bin': 'P3D_CLAUDE_BIN',
};

function usage(code: number): never {
  console.log(
    [
      'Kullanım: npm run dev -- [parametreler]   |   npm start -- [parametreler]',
      `  --llm=<${LLM_MODES.join('|')}>   Claude arka ucu (varsayılan auto: API anahtarı varsa api, yoksa kapalı)`,
      '  --bridge / --no-bridge           Claude Code köprüsü (/api/bridge; dev: açık, start: kapalı)',
      '  --port=<n> --host=<adres>        dinlenecek adres',
      '  --model=<id> --effort=<low|medium|high|xhigh|max> --claude-bin=<yol>',
    ].join('\n'),
  );
  process.exit(code);
}

if (target !== 'dev' && target !== 'start') usage(1);
// Üretimde köprü yalnızca açıkça istenirse açılır.
if (target === 'start') process.env.P3D_BRIDGE ??= '0';

for (const arg of args) {
  if (arg === '-h' || arg === '--help') usage(0);
  const m = /^--(no-)?([a-z-]+)(?:=(.*))?$/.exec(arg);
  const env = m && ENV_FOR[m[2]];
  if (!m || !env) {
    console.error(`Bilinmeyen parametre: ${arg}`);
    usage(1);
  }
  if (m[2] === 'bridge') process.env[env] = m[1] ? '0' : (m[3] ?? '1');
  else if (m[3] !== undefined && !m[1]) process.env[env] = m[3];
  else {
    console.error(`Değer gerekli: --${m[2]}=…`);
    usage(1);
  }
}

if (target === 'dev') {
  // vite.config.ts .env'yi okur ve yalnızca henüz ayarlanmamış değişkenleri doldurur; özet ondan sonra yazılır.
  const { createServer } = await import('vite');
  const server = await createServer({ server: { port: process.env.PORT ? Number(process.env.PORT) : undefined } });
  await server.listen();
  server.printUrls();
  const warn = configWarning();
  if (warn) console.warn(`  ⚠ ${warn}`);
  console.log(`  ${describeConfig()}\n`);
  server.bindCLIShortcuts({ print: true });
} else {
  await import('../server/index.ts');
}
