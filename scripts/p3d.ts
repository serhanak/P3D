// Claude Code köprüsü için komut satırı aracı (bkz. server/bridge.ts). Açık tarayıcı sekmesinin sahnesini
// okur, ona işlem gönderir, görüntüsünü alır; ölçüm ve kesitleri uygulamanın aynı motoruyla Node'da hesaplar.
// Geliştirme sunucusu (npm run dev) ve uygulama sekmesi açık olmalıdır (section --file hariç).
// Depo içinde `npm run -s p3d -- <komut>`, başka klasörlerde global `p3d <komut>` (depoda bir kez `npm link`).
//
// Çalışma alanı (ws): her ws ayrı bir sekmedir (http://localhost:5173/w/<ad>; kök: /). Sıra: --ws <ad> >
// P3D_WS > komutun yazıldığı klasörden yukarı doğru aranan ilk p3d.json'ın "workspace" alanı > kök.
// p3d.json: { "workspace": "ad", "file": "model.p3d.json", "onAmbiguity": "ask-critical" } (file, p3d.json'a göre).
//
//   p3d status                         sunucu, ws ve adresi, bağlı sekme, p3d.json, diğer çalışma alanları
//   p3d view                           ws adresini varsayılan tarayıcıda açar
//   p3d scene [--full] [--stale]       sahne özeti (--full: tüm proje JSON'u; --stale: sekme yoksa son bilinen)
//   p3d ops [--label "metin"]          stdin'den Op[] JSON'u (ya da {"ops": [...]}) uygular
//   p3d undo | redo | fit
//   p3d open [dosya.p3d.json] [--force]  dosyayı sekmeye yükler (geri alınabilir); varsayılan: p3d.json → file.
//                                      Sekmede kaydedilmemiş iş varsa ya da dosyadaki parçalar okunamıyorsa --force ister.
//   p3d save [dosya.p3d.json] [--force]  sekmenin projesini dosyaya yazar (geçici dosya + yeniden adlandırma);
//                                      varsayılan: p3d.json → file. Sekmenin bağlı olmadığı mevcut bir dosyanın ya da
//                                      dolu bir dosyanın boş sekmeyle üzerine yazmak --force ister; P3D dosyası olmayanın
//                                      üzerine hiç yazılmaz.
//   p3d snapshot [--views iso,front,right,top] [--size 1000x750] [--dims] [--out klasör]
//   p3d import <dosya.stl|obj|3mf> [--name ad] [--role solid|hole|reference] [--color #hex]
//              [--max-tris 60000] [--keep-position]
//   p3d measure [--parts a,b]
//   p3d check                         z-fighting, boolean hataları, ince parça, tabla teması
//   p3d section --axis x|y|z --at v1,v2,… [--parts a,b] [--file dosya.stl] [--tol 0.1]
//
// Adres: P3D_URL (varsayılan http://localhost:5173). Göreli dosya yolları komutun yazıldığı klasöre göre çözülür.
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  contentDigest,
  wsLabel,
  wsPath,
  type BridgeResult,
  type BridgeSceneResponse,
  type BridgeWorkspace,
  type Op,
  type Pt2,
  type SceneSummary,
  type SceneSummaryPart,
  type SnapshotView,
} from '../shared/ops.ts';
import { resolveWorkspace, samePath, type WorkspaceChoice } from './config.ts';

const base = (process.env.P3D_URL || 'http://localhost:5173').replace(/\/$/, '');

// `--ws <ad>` (ya da `--ws=<ad>`) komuttan önce ya da sonra yazılabilir.
const argv = process.argv.slice(2);
let wsFlag: string | undefined;
let wsFlagError = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--ws') {
    if (argv[i + 1] === undefined) wsFlagError = '--ws bir çalışma alanı adı ister (kök için: --ws ""; Git Bash dışında --ws / da olur).';
    wsFlag = argv[i + 1] ?? '';
    argv.splice(i, 2);
    break;
  }
  if (argv[i].startsWith('--ws=')) {
    wsFlag = argv[i].slice('--ws='.length);
    argv.splice(i, 1);
    break;
  }
}
const [cmd, ...rest] = argv;

// `npm run p3d` çalışma klasörünü depo köküne çevirir; komutun yazıldığı klasör INIT_CWD'dedir.
// Global `p3d` komutu (bin/p3d.mjs) zaten çağıranın klasöründe çalışır.
const callerDir = process.env.npm_lifecycle_event === 'p3d' && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
const fromCaller = (file: string) => path.resolve(callerDir, file);

// Çalışma alanı yalnızca köprü gerektiğinde çözülür (section --file bozuk bir p3d.json'dan etkilenmesin).
let choice: WorkspaceChoice | undefined;
function workspace(): WorkspaceChoice {
  if (wsFlagError) throw new Error(wsFlagError);
  return (choice ??= resolveWorkspace({ flag: wsFlag, env: process.env.P3D_WS, cwd: callerDir }));
}
const ws = () => workspace().ws;

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}
const has = (name: string) => rest.includes(name);
const list = (name: string) => flag(name)?.split(',').map((s) => s.trim()).filter(Boolean);

const VALUE_FLAGS = new Set(['--label', '--views', '--size', '--out', '--name', '--role', '--color', '--max-tris', '--parts', '--axis', '--at', '--file', '--tol']);
/** Bayrak olmayan argümanlar (dosya yolları). */
function positionals(): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (VALUE_FLAGS.has(rest[i])) i++;
    else if (!rest[i].startsWith('--')) out.push(rest[i]);
  }
  return out;
}

class CallError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call(method: string, p: string, body?: unknown): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(base + p, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new CallError(0, `${base} adresine bağlanılamadı. Geliştirme sunucusu çalışıyor mu (P3D klasöründe: npm run dev)?`);
  }
  const data = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new CallError(r.status, data.error ?? `HTTP ${r.status}`);
  return data;
}

/** Çalışma alanının hedef sekmesinin sahnesi (bağlı sekme yoksa sunucu 409 ve açılacak adresi döner). */
async function getScene(opts: { full?: boolean; stale?: boolean } = {}): Promise<BridgeSceneResponse> {
  const q = [`ws=${encodeURIComponent(ws())}`, ...(opts.full ? ['full'] : []), ...(opts.stale ? ['stale'] : [])];
  return (await call('GET', `/api/bridge/scene?${q.join('&')}`)) as BridgeSceneResponse;
}

/** Çalışma alanının hedef sekmesine işlem/eylem gönderir. */
async function post(body: Record<string, unknown>): Promise<BridgeResult> {
  return (await call('POST', '/api/bridge/ops', { ws: ws(), ...body })) as BridgeResult;
}

function ago(iso: string): string {
  const d = new Date(iso);
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  const rel = s < 60 ? `${s} sn önce` : s < 3600 ? `${Math.round(s / 60)} dk önce` : `${Math.round(s / 3600)} sa önce`;
  return `${d.toLocaleTimeString('tr-TR')} (${rel})`;
}

function sceneHeader(r: BridgeSceneResponse): string {
  const bits = [`çalışma alanı: ${wsLabel(r.ws)}`, `rev ${r.rev}`, ago(r.at), `${r.tabs} sekme`];
  if (!r.connected) bits.push('BAĞLI SEKME YOK — son bilinen sahne');
  if (r.file) bits.push(`dosya: ${r.file}${r.dirty ? ' ● kaydedilmemiş' : ''}`);
  return bits.join(' · ');
}

/**
 * open/save dosyası: argüman ya da (aynı çalışma alanındaysa) p3d.json → file. p3d.json'daki yol p3d.json'ın
 * klasörünün dışına çıkamaz (komutta açıkça yazılan yol serbesttir).
 */
function projectFile(command: 'open' | 'save'): string {
  const arg = positionals()[0];
  if (arg) return fromCaller(arg);
  const c = workspace();
  if (c.configError) throw c.configError;
  const cfg = c.config;
  if (cfg && (cfg.file || cfg.fileError) && cfg.config.workspace !== c.ws) {
    // Başka bir ws'nin sekmesi bu projenin dosyasının üzerine yazılmasın (ya da tersi).
    throw new Error(
      `Dosya belirtilmedi. ${cfg.path} '${wsLabel(cfg.config.workspace)}' çalışma alanına ait, şu an '${wsLabel(c.ws)}' seçili; ` +
        `dosyayı açıkça yazın: p3d ${command} <dosya.p3d.json>`,
    );
  }
  if (cfg?.fileError) throw new Error(cfg.fileError);
  if (cfg?.file) return cfg.file;
  throw new Error(`Dosya belirtilmedi: p3d ${command} <dosya.p3d.json> yazın ya da p3d.json'a "file" ekleyin.`);
}

/**
 * `save` hedefi zaten varsa içeriği: P3D projesi değilse (format/parts yok, bozuk JSON) Error — üzerine hiç
 * yazılmaz (yanlışlıkla başka bir dosyayı ezmemek için). Yoksa null.
 */
function existingProject(file: string): { parts: number } | null {
  const st = statOf(file);
  if (!st) return null;
  if (st.isDirectory()) throw new Error(`Bu bir klasör: ${file}; dosya adı yazın (ör. model.p3d.json).`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    raw = undefined;
  }
  const o = raw as { format?: unknown; parts?: unknown } | undefined;
  if (!o || typeof o !== 'object' || o.format !== 'p3d' || !Array.isArray(o.parts)) {
    throw new Error(
      `${file} var ama bir P3D proje dosyası değil ("format": "p3d" ve "parts" yok); üzerine yazılmadı. ` +
        'Başka bir dosya adı verin ya da dosyayı kendiniz taşıyın/silin.',
    );
  }
  return { parts: o.parts.length };
}

/** Önce aynı klasörde geçici dosyaya yazar, sonra yeniden adlandırır: yarıda kalan yazma mevcut dosyayı bozmasın. */
function writeFileAtomic(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`${file} yazılamadı: ${(e as Error).message}`);
  }
}

const listed = (items: string[]) => items.map((s) => `\n  - ${s}`).join('');

function statOf(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** Adresi varsayılan tarayıcıda açar. */
function openInBrowser(url: string): Promise<void> {
  const [bin, args, opts]: [string, string[], SpawnOptions] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', `"${url}"`], { windowsVerbatimArguments: true }]
      : process.platform === 'darwin'
        ? ['open', [url], {}]
        : ['xdg-open', [url], {}];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...opts, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** `p3d status`: sunucu, çalışma alanı, sekme ve p3d.json durumu. Sunucuya ulaşılamazsa çıkış kodu 1. */
async function status(): Promise<void> {
  const row = (k: string, v: string) => console.log(`${k.padEnd(16)}${v}`);
  let c: WorkspaceChoice | null = null;
  try {
    c = workspace();
  } catch (e) {
    row('Çalışma alanı:', `HATA — ${(e as Error).message}`);
    process.exitCode = 1;
  }
  let spaces: BridgeWorkspace[] | null = null;
  try {
    spaces = (await call('GET', '/api/bridge/workspaces')) as BridgeWorkspace[];
    row('Sunucu:', `${base} — erişilebilir, köprü açık`);
  } catch (e) {
    const err = e as CallError;
    row('Sunucu:', err.status === 404 ? `${base} — erişilebilir ama köprü kapalı (sunucu --bridge ile başlatılmalı; npm run dev'de açıktır)` : `${base} — ERİŞİLEMİYOR. P3D klasöründe "npm run dev" ile başlatın.`);
    process.exitCode = 1;
  }
  if (!c) return;
  row('Çalışma alanı:', `${wsLabel(c.ws)} (kaynak: ${c.source})`);
  row('Adres:', base + wsPath(c.ws));
  if (c.configError) row('p3d.json:', `HATA — ${c.configError.message}`);
  else if (c.config) {
    row('p3d.json:', c.config.path);
    row('  workspace:', wsLabel(c.config.config.workspace) + (c.config.config.workspace === c.ws ? '' : ' (kullanılmıyor: ' + c.source + ' önce gelir)'));
    if (c.config.fileError) row('  file:', `HATA — ${c.config.fileError}`);
    else if (c.config.file) row('  file:', `${c.config.file} ${statOf(c.config.file)?.isFile() ? '(var)' : '(yok — p3d save ile oluşturulur)'}`);
    if (c.config.config.onAmbiguity) row('  onAmbiguity:', c.config.config.onAmbiguity);
  } else row('p3d.json:', `yok (${callerDir} ve üst klasörlerde bulunamadı)`);
  if (!spaces) return;
  const mine = spaces.find((s) => s.ws === c.ws);
  if (!mine?.tabs) {
    row('Sekme:', `bağlı sekme yok — açmak için: p3d view${c.source === '--ws' ? ` --ws ${c.ws || '""'}` : ''}`);
  } else {
    let line = `bağlı · ${mine.tabs} sekme`;
    try {
      const r = await getScene();
      line += ` · rev ${r.rev} · ${ago(r.at)} · ${(r.scene as SceneSummary).parts.length} parça`;
      row('Sekme:', line);
      row('  dosya bağı:', r.file ? `${r.file}${r.dirty ? ' ● kaydedilmemiş değişiklik var' : ' (kaydedilmiş)'}` : 'yok');
    } catch (e) {
      row('Sekme:', `${line} · ${(e as Error).message}`);
    }
  }
  const others = spaces.filter((s) => s.ws !== c.ws && s.tabs > 0);
  row('Diğer ws:', others.length ? others.map((s) => `${wsLabel(s.ws)} (${s.tabs} sekme${s.parts !== null ? `, ${s.parts} parça` : ''})`).join(', ') : 'yok');
}

const n = (v: number) => String(Math.round(v * 100) / 100);
const vec = (v: { x: number; y: number; z: number }) => `${n(v.x)},${n(v.y)},${n(v.z)}`;

function partLine(p: SceneSummaryPart, selected: string | null): string {
  const params = Object.entries(p.params)
    .filter(([k, v]) => !(k === 'scale' && v === 1))
    .map(([k, v]) => `${k}=${n(v)}`)
    .join(' ');
  const rot = p.rotation.x || p.rotation.y || p.rotation.z ? ` rot=${vec(p.rotation)}` : '';
  const role = p.role && p.role !== 'solid' ? ` (${p.role}${p.cuts ? ` → ${p.cuts.join(',')}` : ''})` : '';
  const geom = !p.geom
    ? ''
    : p.geom.kind === 'mesh'
      ? ` mesh:${'triangles' in p.geom ? p.geom.triangles : '?'}△`
      : p.geom.kind === 'loft'
        ? ` loft:${p.geom.sections.length}kesit/${p.geom.axis}${p.geom.smooth ? '/yumuşak' : ''}`
        : p.geom.kind === 'hull'
          ? ` tekne:${p.geom.stations.length}istasyon×${p.geom.stations[0].breadth.length}`
          : ` ${p.geom.kind}:${p.geom.profile.length}nokta/${p.geom.axis}`;
  return (
    `${p.name === selected ? '*' : ' '} ${p.name} [${p.shape}${role}]${geom} ${params} | konum=${vec(p.position)}${rot}` +
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

/** Ramer–Douglas–Peucker: kesit çokgenlerini tolerans içinde sadeleştirir. */
function simplify(pts: Pt2[], tol: number): Pt2[] {
  if (pts.length < 4 || tol <= 0) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  const far = pts.reduce((b, p, i) => (Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) > Math.hypot(pts[b][0] - pts[0][0], pts[b][1] - pts[0][1]) ? i : b), 0);
  keep[far] = 1;
  const rdp = (a: number, b: number) => {
    let idx = -1;
    let dmax = tol;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b % pts.length];
    const len = Math.hypot(bx - ax, by - ay) || 1e-12;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
      if (d > dmax) [dmax, idx] = [d, i];
    }
    if (idx >= 0) {
      keep[idx] = 1;
      rdp(a, idx);
      rdp(idx, b);
    }
  };
  rdp(0, far);
  rdp(far, pts.length);
  return pts.filter((_, i) => keep[i]);
}

function area(pts: Pt2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) a += pts[i][0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * pts[i][1];
  return a / 2;
}

const PLANE: Record<string, string> = { x: '[y, z]', y: '[x, z]', z: '[x, y]' };

async function main(): Promise<void> {
  switch (cmd) {
    case 'status':
      return status();
    case 'view': {
      const url = base + wsPath(ws());
      try {
        await openInBrowser(url);
      } catch (e) {
        throw new Error(`Tarayıcı açılamadı (${(e as Error).message}); adresi elle açın: ${url}`);
      }
      console.log(`Tarayıcıda açılıyor: ${url}`);
      return;
    }
    case 'scene': {
      const full = has('--full');
      const r = await getScene({ full, stale: has('--stale') });
      if (full) {
        // stdout yalnızca JSON kalsın (betikler okuyabilsin); başlık stderr'e.
        console.error(sceneHeader(r));
        console.log(JSON.stringify(r.scene, null, 2));
      } else {
        console.log(sceneHeader(r));
        printScene(r.scene as SceneSummary);
      }
      return;
    }
    case 'ops': {
      const raw = JSON.parse(await readStdin()) as unknown;
      const ops = Array.isArray(raw) ? raw : (raw as { ops?: unknown }).ops;
      printResult(await post({ ops, label: flag('--label') }));
      return;
    }
    case 'undo':
    case 'redo':
    case 'fit':
      printResult(await post({ action: cmd, label: flag('--label') }));
      return;
    case 'open': {
      const file = projectFile('open');
      const force = has('--force');
      if (!statOf(file)?.isFile()) throw new Error(`Dosya bulunamadı: ${file}`);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
      } catch (e) {
        throw new Error(`${file} okunamadı: ${(e as Error).message}`);
      }
      const { parseProject } = await import('../src/io.ts');
      const { usedAssets } = await import('../src/assets.ts');
      const dropped: string[] = [];
      const project = parseProject(raw, dropped);
      const rawParts = (raw as { parts?: unknown }).parts;
      const rawCount = Array.isArray(rawParts) ? rawParts.length : 0;
      // Parça sessizce kaybolmasın: okunamayanlar listelenir; --force ile yüklenir ama sekme kirli kalır.
      if (rawCount !== project.parts.length && !dropped.length) dropped.push(`${rawCount - project.parts.length} parça (neden bilinmiyor)`);
      if (dropped.length && !force) {
        throw new Error(
          `${file}: ${dropped.length} parça okunamadı ve yüklenmeyecekti:${listed(dropped)}\n` +
            'Dosyayı düzeltin ya da bu parçalar olmadan yüklemek için --force ekleyin (sekme "kaydedilmemiş" kalır; kaydederseniz bu parçalar dosyadan da çıkar).',
        );
      }
      // Sekmedeki kaydedilmemiş iş üzerine yazılmasın (yükleme geri alınabilir ama geri-al geçmişi sayfa yenilenince gider).
      if (!force) {
        const r = await getScene();
        const parts = (r.scene as SceneSummary).parts.length;
        const undoNote = 'ya da üzerine yüklemek için --force ekleyin (önceki içerik p3d undo ile geri gelir).';
        if (r.dirty) {
          throw new Error(
            `Sekmede kaydedilmemiş değişiklik var (${r.file ? `dosya: ${r.file}` : 'bağlı dosya yok'}, ${parts} parça); yüklenmedi. ` +
              `Önce kaydedin: p3d save${r.file ? '' : ' <dosya.p3d.json>'} — ${undoNote}`,
          );
        }
        if (!r.file && parts > 0) {
          throw new Error(`Sekmedeki proje (${parts} parça) bir dosyaya bağlı değil; yüklenmedi. Önce kaydedin: p3d save <dosya.p3d.json> — ${undoNote}`);
        }
      }
      const r = await post({
        action: 'load',
        project,
        assets: usedAssets(project),
        file,
        ...(dropped.length ? { dirty: true } : {}),
        label: flag('--label') ?? `Aç: ${path.basename(file)}`,
      });
      printResult(r);
      if (dropped.length) console.log(`⚠ ${dropped.length} parça yüklenmedi (--force):${listed(dropped)}\n  Sekme "kaydedilmemiş" sayılıyor.`);
      return;
    }
    case 'save': {
      const file = projectFile('save');
      const force = has('--force');
      if (!statOf(path.dirname(file))?.isDirectory()) throw new Error(`Klasör bulunamadı: ${path.dirname(file)} (dosya: ${file})`);
      const existing = existingProject(file);
      const r = await getScene({ full: true });
      // Sekmenin projesi (sunucunun eklediği `assets` hariç): özeti sekme kendi JSON'uyla karşılaştırır.
      const { assets: _assets, ...tabProject } = r.scene as Record<string, unknown>;
      const { parseProject, projectToJson } = await import('../src/io.ts');
      const { getAsset } = await import('../src/assets.ts');
      const dropped: string[] = [];
      const project = parseProject(r.scene, dropped);
      const rawCount = Array.isArray(tabProject.parts) ? tabProject.parts.length : 0;
      if (rawCount !== project.parts.length && !dropped.length) dropped.push(`${rawCount - project.parts.length} parça (neden bilinmiyor)`);
      if (dropped.length) {
        throw new Error(`Sekmedeki ${dropped.length} parça dosyaya yazılamazdı (okunamadı):${listed(dropped)}\nDosya yazılmadı.`);
      }
      const noMesh = project.parts.filter((p) => p.geom?.kind === 'mesh' && !getAsset(p.geom.asset)).map((p) => `'${p.name}'`);
      if (noMesh.length) {
        throw new Error(
          `Şu ağ (mesh) parçalarının ağ verisi yok: ${noMesh.join(', ')} — sekme ağı sunucuya göndermemiş (ör. otomatik kayda sığmadığı ` +
            'için sekmede yer tutucu küp görünüyor). Dosya yazılmadı; ağı yeniden içe aktarın (p3d import) ya da parçayı silin.',
        );
      }
      if (existing && !force) {
        if (!r.file || !samePath(r.file, file)) {
          throw new Error(
            `${file} zaten var ve sekme bu dosyaya bağlı değil (${r.file ? `bağlı dosya: ${r.file}` : 'dosya bağı yok'}); üzerine yazılmadı. ` +
              'Üzerine yazmak için --force ekleyin ya da başka bir dosya adı verin.',
          );
        }
        if (project.parts.length === 0 && existing.parts > 0) {
          throw new Error(
            `Sekme boş (0 parça) ama ${file} ${existing.parts} parça içeriyor; üzerine yazılmadı. Yanlış çalışma alanı olabilir (p3d status). ` +
              'Dosyayı bilerek boşaltıyorsanız --force ekleyin.',
          );
        }
      }
      writeFileAtomic(file, projectToJson(project));
      console.log(`✓ Kaydedildi: ${file} (${project.parts.length} parça; çalışma alanı ${wsLabel(r.ws)}, rev ${r.rev})`);
      try {
        const m = await post({ action: 'mark_saved', file, digest: contentDigest(JSON.stringify(tabProject)) });
        for (const e of m.errors) console.log(`⚠ ${e}`);
      } catch (e) {
        console.log(`⚠ Sekme "kaydedildi" olarak işaretlenemedi: ${(e as Error).message}`);
      }
      return;
    }
    case 'snapshot': {
      const [w, h] = (flag('--size') ?? '1000x750').split('x').map(Number);
      const views = (list('--views') ?? ['iso', 'front', 'right', 'top']) as SnapshotView[];
      const r = await post({ action: 'snapshot', snapshot: { views, width: w, height: h, dims: has('--dims') } });
      const out = fromCaller(flag('--out') ?? path.join(tmpdir(), 'p3d-snapshots'));
      mkdirSync(out, { recursive: true });
      for (const img of r.images ?? []) {
        const file = path.join(out, `${img.view}.png`);
        writeFileSync(file, Buffer.from(img.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
        console.log(file);
      }
      for (const m of r.errors) console.log(`✕ ${m}`);
      const box = r.scene.parts.filter((p) => p.visible && p.role !== 'hole').reduce(
        (b, p) => ({
          min: { x: Math.min(b.min.x, p.bbox.min.x), y: Math.min(b.min.y, p.bbox.min.y), z: Math.min(b.min.z, p.bbox.min.z) },
          max: { x: Math.max(b.max.x, p.bbox.max.x), y: Math.max(b.max.y, p.bbox.max.y), z: Math.max(b.max.z, p.bbox.max.z) },
        }),
        { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } },
      );
      if (Number.isFinite(box.min.x)) console.log(`görünür kutu: ${vec(box.min)} → ${vec(box.max)} (dik görünümler bu kutuya %6 payla sığdırılır)`);
      return;
    }
    case 'import': {
      if (!rest[0] || rest[0].startsWith('--')) throw new Error('Dosya yolu gerekli: import <dosya.stl|obj|3mf>');
      const file = fromCaller(rest[0]);
      const { meshAssetFromSoup, parseMeshFile } = await import('../src/meshio.ts');
      const buf = readFileSync(file);
      const name = flag('--name') ?? path.basename(file).replace(/\.[^.]+$/, '');
      const imp = await meshAssetFromSoup(name, parseMeshFile(file, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer), Number(flag('--max-tris') ?? 60000));
      console.log(`${path.basename(file)}: ${imp.originalTriangles} üçgen → ${imp.asset.triangles}; boyut ${vec(imp.size)} mm; dosyadaki merkez ${vec(imp.center)}`);
      const op: Op = {
        op: 'import_mesh',
        asset: imp.asset,
        name,
        role: (flag('--role') ?? '') as Extract<Op, { op: 'import_mesh' }>['role'],
        color: flag('--color'),
        position: has('--keep-position') ? imp.center : null,
      };
      printResult(await post({ ops: [op], label: flag('--label') ?? `İçe aktar: ${path.basename(file)}` }));
      return;
    }
    case 'check': {
      const { initCsg } = await import('../src/csg.ts');
      await initCsg();
      const r = await getScene({ full: true });
      const { parseProject } = await import('../src/io.ts');
      const { checkProject } = await import('../src/check.ts');
      const issues = checkProject(parseProject(r.scene));
      for (const i of issues) console.log(`${i.level === 'hata' ? '✕' : '⚠'} ${i.message}`);
      if (!issues.length) console.log('✓ Sorun bulunmadı.');
      if (issues.some((i) => i.level === 'hata')) process.exitCode = 1;
      return;
    }
    case 'measure':
    case 'section': {
      const THREE = await import('three');
      const { initCsg, sliceMany } = await import('../src/csg.ts');
      await initCsg();
      const axis = (flag('--axis') ?? 'z') as 'x' | 'y' | 'z';
      const ats = (list('--at') ?? []).map(Number);
      const tol = Number(flag('--tol') ?? 0.1);
      if (cmd === 'section' && (!['x', 'y', 'z'].includes(axis) || !ats.length || ats.some((v) => !Number.isFinite(v)))) {
        throw new Error('section --axis x|y|z --at v1,v2,… gerekli.');
      }
      const printSection = (label: string, g: import('three').BufferGeometry) => {
        const all = sliceMany(g, axis, ats);
        for (const [k, at] of ats.entries()) {
          const polys = all[k].map((p) => simplify(p, tol));
          console.log(`${label} @ ${axis}=${at}: ${polys.length} çevre ${PLANE[axis]}`);
          for (const p of polys) {
            const xs = p.map((q) => q[0]);
            const ys = p.map((q) => q[1]);
            console.log(
              `  ${p.length} nokta, alan ${n(Math.abs(area(p)))} mm², kutu [${n(Math.min(...xs))}..${n(Math.max(...xs))}] × [${n(Math.min(...ys))}..${n(Math.max(...ys))}]` +
                (area(p) < 0 ? ' (iç boşluk)' : ''),
            );
            console.log('  ' + JSON.stringify(p.map(([u, v]) => [Math.round(u * 100) / 100, Math.round(v * 100) / 100])));
          }
        }
      };
      const fileArg = flag('--file') && fromCaller(flag('--file')!);
      if (cmd === 'section' && fileArg) {
        const { parseMeshFile } = await import('../src/meshio.ts');
        const buf = readFileSync(fileArg);
        const soup = parseMeshFile(fileArg, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
        g.computeBoundingBox();
        console.log(`${path.basename(fileArg)}: kutu ${vec(g.boundingBox!.min)} → ${vec(g.boundingBox!.max)} (dosya koordinatları)`);
        printSection(path.basename(fileArg), g);
        return;
      }
      const r = await getScene({ full: true });
      const { parseProject, worldMesh } = await import('../src/io.ts');
      const { roleOf, solidVolume } = await import('../src/model.ts');
      const { partBox } = await import('../src/engine.ts');
      const project = parseProject(r.scene);
      const names = list('--parts');
      const parts = project.parts.filter((p) => (names ? names.includes(p.name) : p.visible && roleOf(p) !== 'hole'));
      if (names) for (const nm of names) if (!parts.some((p) => p.name === nm)) console.log(`(uyarı: '${nm}' bulunamadı)`);
      if (cmd === 'measure') {
        let total = 0;
        const all = new THREE.Box3();
        for (const p of parts) {
          const b = partBox(p, project.settings.resolution);
          const v = solidVolume(project, p);
          if (roleOf(p) === 'solid') {
            total += v;
            all.union(b);
          }
          const s = b.getSize(new THREE.Vector3());
          console.log(`${p.name} [${roleOf(p)}]: kutu ${vec(b.min)} → ${vec(b.max)} (${vec(s)}), hacim ${n(v / 1000)} cm³`);
        }
        if (!all.isEmpty()) {
          const s = all.getSize(new THREE.Vector3());
          // Örtüşen parçalar toplamda iki kez sayılır; birleşim (union) hacmi baskıdaki gerçek hacimdir.
          const { mergedMesh } = await import('../src/io.ts');
          const solids = parts.filter((p) => roleOf(p) === 'solid');
          const m = mergedMesh(project, solids);
          let u = 0;
          for (let i = 0; i < m.tris.length; i += 3) {
            const [a, b, c] = [m.tris[i] * 3, m.tris[i + 1] * 3, m.tris[i + 2] * 3];
            const P = m.pos;
            u += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6;
          }
          console.log(`TOPLAM katı: kutu ${vec(all.min)} → ${vec(all.max)} (${vec(s)}), parçaların toplamı ${n(total / 1000)} cm³`);
          console.log(`BİRLEŞİK hacim (örtüşmeler bir kez): ${n(u / 1000)} cm³ ≈ ${n((u / 1000) * 1.24)} g PLA`);
        }
        return;
      }
      for (const p of parts) {
        const m = worldMesh(project, p);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
        g.setIndex(m.tris);
        try {
          printSection(p.name, g);
        } catch (e) {
          console.log(`${p.name}: kesit alınamadı (${(e as Error).message})`);
        }
      }
      return;
    }
    default:
      console.log(
        [
          'Kullanım: p3d [--ws <ad>] <komut>   (depo içinde: npm run -s p3d -- <komut>)',
          '  Çalışma alanı: --ws <ad> (kök: --ws "" ya da --ws /) > P3D_WS > üst klasörlerdeki ilk p3d.json ("workspace") > kök',
          '  status · view · scene [--full] [--stale] · ops [--label "metin"] < ops.json · undo · redo · fit',
          '  open [dosya.p3d.json] [--force] · save [dosya.p3d.json] [--force]   (dosya verilmezse p3d.json → "file")',
          '  snapshot [--views iso,front,back,left,right,top,bottom] [--size 1000x750] [--dims] [--out klasör]',
          '  import <dosya.stl|obj|3mf> [--name ad] [--role solid|hole|reference] [--color #hex] [--max-tris N] [--keep-position]',
          '  measure [--parts a,b] · check',
          '  section --axis x|y|z --at v1,v2 [--parts a,b] [--file dosya.stl] [--tol 0.1]',
        ].join('\n'),
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e: Error) => {
  console.error(`Hata: ${e.message}`);
  process.exitCode = 1;
});
