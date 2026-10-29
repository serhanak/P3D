// Claude Code köprüsü için komut satırı aracı (bkz. server/bridge.ts). Açık tarayıcı sayfasının sahnesini
// okur ve ona işlem gönderir. Geliştirme sunucusu (npm run dev) ve uygulama sekmesi açık olmalıdır.
//
//   npm run -s p3d -- scene [--full]         sahne özeti (--full: tüm proje JSON'u)
//   npm run -s p3d -- ops [--label "metin"]  stdin'den Op[] JSON'u (ya da {"ops": [...]}) uygular
//   npm run -s p3d -- undo | redo | fit
//
// Adres: P3D_URL (varsayılan http://localhost:5173).
import type { BridgeResult, SceneSummary, SceneSummaryPart } from '../shared/ops.ts';

const base = (process.env.P3D_URL || 'http://localhost:5173').replace(/\/$/, '');
const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`${base} adresine bağlanılamadı. Geliştirme sunucusu çalışıyor mu (npm run dev)?`);
  }
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}

const n = (v: number) => String(Math.round(v * 100) / 100);
const vec = (v: { x: number; y: number; z: number }) => `${n(v.x)},${n(v.y)},${n(v.z)}`;

function partLine(p: SceneSummaryPart, selected: string | null): string {
  const params = Object.entries(p.params)
    .map(([k, v]) => `${k}=${n(v)}`)
    .join(' ');
  const rot = p.rotation.x || p.rotation.y || p.rotation.z ? ` rot=${vec(p.rotation)}` : '';
  return (
    `${p.name === selected ? '*' : ' '} ${p.name} [${p.shape}] ${params} | merkez=${vec(p.position)}${rot}` +
    ` | bbox=${vec(p.bbox.min)} → ${vec(p.bbox.max)} | ${p.color}${p.visible ? '' : ' (gizli)'}`
  );
}

function printScene(s: SceneSummary): void {
  console.log(`tabla ${s.bed.x}×${s.bed.y} mm · ${s.parts.length} parça · seçili: ${s.selected ?? '-'}`);
  for (const p of s.parts) console.log(partLine(p, s.selected));
}

function printResult(r: BridgeResult): void {
  for (const m of r.messages) console.log(`✓ ${m}`);
  for (const m of r.errors) console.log(`✕ ${m}`);
  console.log('');
  printScene(r.scene);
  if (r.errors.length) process.exitCode = 1;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'scene': {
      const full = rest.includes('--full');
      const r = (await call('GET', `/api/bridge/scene${full ? '?full' : ''}`)) as { connected: boolean; scene: unknown };
      if (!r.connected) console.log('(uyarı: bağlı tarayıcı sayfası yok; son bilinen sahne)');
      if (full) console.log(JSON.stringify(r.scene, null, 2));
      else printScene(r.scene as SceneSummary);
      return;
    }
    case 'ops': {
      const raw = JSON.parse(await readStdin()) as unknown;
      const ops = Array.isArray(raw) ? raw : (raw as { ops?: unknown }).ops;
      printResult((await call('POST', '/api/bridge/ops', { ops, label: flag('--label') })) as BridgeResult);
      return;
    }
    case 'undo':
    case 'redo':
    case 'fit':
      printResult((await call('POST', '/api/bridge/ops', { action: cmd, label: flag('--label') })) as BridgeResult);
      return;
    default:
      console.log('Kullanım: npm run -s p3d -- scene [--full] | ops [--label "metin"] < ops.json | undo | redo | fit');
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e: Error) => {
  console.error(`Hata: ${e.message}`);
  process.exitCode = 1;
});
