// Üretim sunucusu: `npm run build` çıktısını (dist/) sunar ve /api uç noktalarını sağlar.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.ts';
import { configWarning, describeConfig } from './config.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '127.0.0.1';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(pathname: string): Promise<{ body: Buffer; type: string } | null> {
  let file = path.join(root, decodeURIComponent(pathname));
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = path.join(root, 'index.html');
  }
  try {
    return { body: await readFile(file), type: MIME[path.extname(file)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res);
  const file = await serveStatic(url.pathname);
  if (!file) {
    res.statusCode = 404;
    return res.end('Bulunamadı. Önce `npm run build` çalıştırın.');
  }
  res.setHeader('Content-Type', file.type);
  res.end(file.body);
}).listen(port, host, () => {
  const warn = configWarning();
  if (warn) console.warn(`Uyarı: ${warn}`);
  console.log(`P3D: http://${host}:${port}  (${describeConfig()})`);
});
