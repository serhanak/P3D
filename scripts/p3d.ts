// P3D komut satırı aracı. Model dosyada yaşar, sekme görüntüleyicidir: `--file model.p3d.json` alan komutlar tarayıcısız
// (Node'da, uygulamanın aynı motoruyla; src/files.ts) çalışır; diğerleri çalışma alanının açık sekmesiyle köprü üzerinden
// konuşur (bkz. server/bridge.ts). Depo içinde `npm run -s p3d -- <komut>`, başka klasörlerde global `p3d <komut>`
// (depoda bir kez `npm link`). Kütüphane olarak: `import { … } from 'p3d'` (src/api.ts; `p3d run` kurulumsuz çözer).
//
// Çalışma alanı (ws): her ws ayrı bir sekmedir (http://localhost:5173/w/<ad>; kök: /). Sıra: --ws <ad> >
// P3D_WS > komutun yazıldığı klasörden yukarı doğru aranan ilk p3d.json'ın "workspace" alanı > kök.
// p3d.json: { "workspace": "ad", "file": "model.p3d.json", "onAmbiguity": "ask-critical" } (file, p3d.json'a göre).
//
// Sekme (geliştirme sunucusu ve ws sekmesi açık olmalı):
//   p3d status                         sunucu, skill güncel mi, ws ve adresi, bağlı sekme, p3d.json, diğer çalışma alanları
//   p3d dev [--port N …] [--detach]    sunucuyu her klasörden P3D deposunda başlatır (npm run dev); çalışıyorsa söyler.
//                                      --detach: terminalden bağımsız (ayrık) başlatır, hazır olunca döner; günlük geçici klasörde
//   p3d stop [--port N]                portta çalışan P3D sunucusunu (nasıl başlatılmış olursa olsun) durdurur
//   p3d view                           ws adresini varsayılan tarayıcıda açar
//   p3d scene [--full] [--stale]       sahne özeti (--full: tüm proje JSON'u; --stale: sekme yoksa son bilinen)
//   p3d ops [--ops ops.json] [--label "metin"]  Op[] JSON'u (ya da {"ops": [...]}) stdin'den ya da --ops dosyasından
//   p3d undo | redo | fit
//   p3d open [dosya.p3d.json] [--force]  dosyayı sekmeye yükler (geri alınabilir); varsayılan: p3d.json → file.
//                                      Sekmede kaydedilmemiş iş varsa ya da dosyadaki parçalar okunamıyorsa --force ister.
//   p3d save [dosya.p3d.json] [--force] [--embed]  sekmenin projesini dosyaya yazar (geçici dosya + yeniden adlandırma);
//                                      varsayılan: p3d.json → file. Sekmenin bağlı olmadığı mevcut bir dosyanın ya da
//                                      dolu bir dosyanın boş sekmeyle üzerine yazmak --force ister; P3D dosyası olmayanın
//                                      üzerine hiç yazılmaz. Kaynağı (src) olan ağlar yolla anılır, --embed ile gömülür.
//   p3d snapshot [--views iso,front,right,top] [--size 1000x750] [--dims] [--out klasör] [--style shaded|wire|xray]
//                [--projection perspective|ortho]   ortho: iso ve camera da dik izdüşüm (eye perspektif kalır)
//                [--eye x,y,z] [--target x,y,z] [--fov 50] [--eye-height 1000]   perspektif (camera / eye görünümü)
//                [--parts a,b | --focus a,b]   yalnızca bu parçalar (kadraj dahil) / kadraj bunlara, diğerleri bağlam
//   p3d import <dosya.stl|obj|3mf|glb> [--name ad] [--role solid|hole|reference] [--color #hex]
//              [--max-tris N] [--keep-position]   (parçaya kaynak yolu src olarak yazılır; sınır GLB'de 1 000 000, diğerlerinde 60 000)
//
// Sekme ya da dosya (--file verilmezse çalışma alanı sekmesinin sahnesi). scene/snapshot/measure/check/section/sketch (listeleme) --file bir ağ dosyası
// (.stl/.obj/.3mf/.glb) da alır: bellekte tek parçalı proje, parça dosyadaki yerinde; ağ dosyasına hiçbir şey yazılmaz.
//   p3d scene --file m.p3d.json [--full]   (--full: dosyadaki gibi; src göreli, gömülü ağlar gömülü)
//   p3d check [--file m.p3d.json] [--profile print|game] [--max-tris N] [--cull-hidden]   z-fighting, boolean, ince parça, tabla /
//                                      oyun: üçgen bütçesi, bozuk üçgen; hata varsa çıkış kodu 1
//   p3d measure [--file m.p3d.json] [--parts a,b]
//   p3d section --axis x|y|z --at v1,v2,… [--parts a,b] [--file m.p3d.json | ağ.stl|obj|3mf|glb] [--tol 0.1]
//   p3d export <çıktı.stl|3mf|obj|glb> [--file m.p3d.json] [--parts a,b] [--merge] [--skeleton] [--cull-hidden] [--units m|mm]
//              [--normals flat|smooth]   --merge STL/3MF için; --skeleton/--units/--normals GLB için
//   p3d snapshot --file m.p3d.json|ağ.glb [--views …] [--size …] [--dims] [--style …] [--projection …] [--out klasör]   makinedeki Chrome/Edge'i
//                                      (P3D_CHROME) görünmez açar, geçici bir ws'de görüntü alır; sunucu yoksa geçici açar
//   p3d sketch [--file m.p3d.json] [--json] [--sample 8]   kullanıcının çizdiği eskiz yollarını listeler (dünya mm;
//                                      --json: sahne özetindeki gibi, --sample eğri kenar başına örnek)
//   p3d sketch --clear [ad] [--file m.p3d.json] [--label "metin"]   adı verilen yolu / tüm eskizi siler (dosyada:
//                                      hata varsa yazılmaz)
//
// Yalnızca dosya:
//   p3d apply --file m.p3d.json [--ops ops.json] [--out başka.p3d.json] [--force] [--dry-run] [--new] [--embed] [--label "metin"]
//                                      işlemleri dosyaya uygular; hata varsa dosya yazılmaz, çıkış kodu 1
//                                      (--new: dosya yoksa boş projeyle başlar; --out mevcut başka bir dosyaysa --force ister)
//
// Okunamayan parça: check hata sayar (çıkış 1), export ve apply hiç yazmaz, scene/measure/section uyarıyı stdout'a basar.
//
// Diğer:
//   p3d run <betik.mts|ts|mjs|js> [arg…]   betiği çağıranın klasöründe çalıştırır; `from 'p3d'` src/api.ts'ye çözülür
//   p3d guide [konu]                   rehber (docs/guide); konu yoksa giriş + konu listesi
//   p3d skill install                  tools/skill/p3d/SKILL.md → ~/.claude/skills/p3d/SKILL.md (P3D_SKILLS_DIR);
//                                      {{P3D_DIR}} bu makinedeki depo yoluyla doldurulur
//
// Adres: P3D_URL (varsayılan http://localhost:5173). Göreli dosya yolları komutun yazıldığı klasöre göre çözülür.
import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SKETCH_KIND_LABELS,
  SNAPSHOT_FOV_MAX,
  SNAPSHOT_FOV_MIN,
  SNAPSHOT_MAX_SIDE,
  SNAPSHOT_MIN_SIDE,
  SNAPSHOT_PROJECTIONS,
  SNAPSHOT_VIEWS,
  VIEW_STYLES,
  contentDigest,
  fitSnapshotSize,
  wsLabel,
  wsPath,
  type BridgeResult,
  type BridgeSceneResponse,
  type BridgeWorkspace,
  type Op,
  type Pt2,
  type SceneSummary,
  type SceneSummaryPart,
  type SceneSummarySketch,
  type SnapshotCamera,
  type SnapshotOptions,
  type SnapshotProjection,
  type SnapshotView,
  type SweepGeom,
  type Vec3,
  type ViewStyle,
} from '../shared/ops.ts';
import type { CheckOptions } from '../src/check.ts';
import type { Project } from '../src/types.ts';
import { fold } from '../src/text.ts';
import { resolveWorkspace, rootGuardError, samePath, type WorkspaceChoice } from './config.ts';

const base = (process.env.P3D_URL || 'http://localhost:5173').replace(/\/$/, '');

// `--ws <ad>` (ya da `--ws=<ad>`) komuttan önce ya da sonra yazılabilir; `run`'da yalnızca önce (sonrası betiğindir).
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
  if (argv[i] === 'run') break;
}
const [cmd, ...rest] = argv;

// `npm run p3d` çalışma klasörünü depo köküne çevirir; komutun yazıldığı klasör INIT_CWD'dedir.
// Global `p3d` komutu (bin/p3d.mjs) zaten çağıranın klasöründe çalışır.
const callerDir = process.env.npm_lifecycle_event === 'p3d' && process.env.INIT_CWD ? process.env.INIT_CWD : process.cwd();
const fromCaller = (file: string) => path.resolve(callerDir, file);

// Çalışma alanı yalnızca köprü gerektiğinde çözülür (--file komutları bozuk bir p3d.json'dan etkilenmesin).
let choice: WorkspaceChoice | undefined;
function workspace(): WorkspaceChoice {
  if (wsFlagError) throw new Error(wsFlagError);
  return (choice ??= resolveWorkspace({ flag: wsFlag, env: process.env.P3D_WS, cwd: callerDir }));
}
const ws = () => workspace().ws;

/** Sahneyi (ya da sekmenin dosya bağını) değiştiren sekme komutları: P3D dışından köke yanlışlıkla gitmesin. */
const TAB_MUTATING = new Set(['ops', 'undo', 'redo', 'open', 'save', 'import']);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
function guardRoot(): void {
  const err = rootGuardError(workspace(), callerDir, REPO_ROOT);
  if (err) throw new Error(err);
}

/** Değer alan bayrağın değeri; bayrak yoksa undefined, değeri eksikse Error. */
function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  if (i < 0) return undefined;
  if (rest[i + 1] === undefined) throw new Error(`${name} bir değer ister.`);
  return rest[i + 1];
}
const has = (name: string) => rest.includes(name);
const list = (name: string) => flag(name)?.split(',').map((s) => s.trim()).filter(Boolean);

const VALUE_FLAGS = new Set([
  '--label', '--views', '--size', '--out', '--name', '--role', '--color', '--max-tris', '--parts', '--focus', '--axis', '--at', '--file',
  '--tol', '--ops', '--profile', '--units', '--normals', '--sample', '--eye', '--target', '--fov', '--eye-height', '--style',
  '--projection',
]);
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

/** `p3d run` betiğinin kendi hatası: yığın izi olduğu gibi basılır. */
class ScriptError extends Error {
  constructor(public original: unknown) {
    super('betik hatası');
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

/** Çalışma alanının (verilmezse seçili ws'nin) hedef sekmesine işlem/eylem gönderir. */
async function post(body: Record<string, unknown>, target: string = ws()): Promise<BridgeResult> {
  return (await call('POST', '/api/bridge/ops', { ws: target, ...body })) as BridgeResult;
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

const listed = (items: string[]) => items.map((s) => `\n  - ${s}`).join('');

function statOf(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** --file türü uzantıdan: .json proje dosyası (.p3d.json), .stl/.obj/.3mf/.glb ağ dosyası. */
function fileKind(file: string): 'project' | 'mesh' | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') return 'project';
  return ['.stl', '.obj', '.3mf', '.glb'].includes(ext) ? 'mesh' : null;
}

/**
 * `--file` ile ağ dosyası alan, yalnızca okuyan komutlar: bellekte tek parçalı proje kurulur (section ham üçgenleri okur;
 * sketch yalnızca listeler — ağda eskiz yoktur). Yazan komutlar (apply, export, sketch --clear) ağ dosyasını reddeder: ağ
 * dosyasının üzerine hiçbir şey yazılmaz.
 */
const MESH_READERS = new Set(['scene', 'snapshot', 'measure', 'check', 'section', 'sketch']);
const MESH_READERS_TEXT = 'scene, snapshot, measure, check, section ve sketch (yalnızca listeleme)';

/** `--file` ile verilen dosya (mutlak) ve türü. */
interface SourceFile {
  file: string;
  mesh: boolean;
}

/** `--file` kaynağı; verilmemişse undefined. Ağ dosyası yalnızca MESH_READERS'taki komutlarda geçerlidir. */
function fileFlag(command: string): SourceFile | undefined {
  const f = flag('--file');
  if (f === undefined) return undefined;
  const file = fromCaller(f);
  const kind = fileKind(file);
  const readsMesh = MESH_READERS.has(command) && !(command === 'sketch' && has('--clear'));
  if (kind === 'project') return { file, mesh: false };
  if (kind === 'mesh') {
    if (readsMesh) return { file, mesh: true };
    throw new Error(
      `${command} --file bir proje dosyası ister (.p3d.json); ${path.basename(file)} bir ağ dosyası. Ağ dosyaları (STL/OBJ/3MF/GLB) ` +
        `yalnızca okuyan komutlarda açılır: ${MESH_READERS_TEXT}; ağ dosyasına hiçbir şey yazılmaz.`,
    );
  }
  const gltf = path.extname(file).toLowerCase() === '.gltf' ? ' (glTF metin biçimi .gltf desteklenmez; .glb olarak dışa aktarın)' : '';
  throw new Error(`--file uzantısı tanınmadı (${path.basename(file)}): proje için .p3d.json${readsMesh ? ', ağ için .stl / .obj / .3mf / .glb' : ''}${gltf}.`);
}

/** `--file` ile verilen proje dosyası (mutlak); verilmemişse undefined. Ağ dosyası okuyan komutlarda bile burada reddedilir. */
function projectFileFlag(command: string): string | undefined {
  const src = fileFlag(command);
  if (src?.mesh) throw new Error(`${command} --file bir proje dosyası ister (.p3d.json).`);
  return src?.file;
}

/** Çıktıdaki kaynak satırı. */
const sourceLabel = (src: SourceFile) => (src.mesh ? `ağ dosyası: ${src.file} (bellekte tek parçalı proje, dosyadaki yerinde)` : `dosya: ${src.file}`);

/** Okunan proje + atlanan parçalar ("ad: neden") + yükleme uyarıları (ör. kaynak ağ dosyası değişmiş). */
interface LoadedProject {
  project: Project;
  dropped: string[];
  warnings: string[];
}

/**
 * Proje dosyasını okur (ağlar gömülü ya da src'den). `strict`: okunamayan parça varsa hata (yazacak komutlar);
 * değilse atlanır ve `dropped`'a girer. Atlananları ve uyarıları basmak çağıranın işidir (printLoadNotes).
 */
async function readProjectFile(file: string, strict: boolean): Promise<LoadedProject> {
  const { loadProjectFile } = await import('../src/files.ts');
  const dropped: string[] = [];
  const warnings: string[] = [];
  const project = await loadProjectFile(file, strict ? { warnings } : { dropped, warnings });
  return { project, dropped, warnings };
}

/**
 * `--file` kaynağını okur: proje dosyası (readProjectFile) ya da ağ dosyası (tek parçalı bellek projesi; `p3d import
 * --keep-position` ile aynı parça, sınır biçimin varsayılanı). Ağ sadeleştirildiyse uyarı (topoloji dosyadakinden farklı).
 */
async function readSource(src: SourceFile, strict: boolean): Promise<LoadedProject> {
  if (!src.mesh) return readProjectFile(src.file, strict);
  const { loadMeshFileProject } = await import('../src/files.ts');
  const { project, mesh } = await loadMeshFileProject(src.file);
  const tr = (v: number) => v.toLocaleString('tr-TR');
  const warnings =
    mesh.asset.triangles < mesh.originalTriangles
      ? [`'${project.parts[0].name}': ağ ${tr(mesh.originalTriangles)} → ${tr(mesh.asset.triangles)} üçgene sadeleştirildi (varsayılan sınır); üçgen topolojisi dosyadakinden farklı.`]
      : [];
  return { project, dropped: [], warnings };
}

/**
 * Sekmenin tam projesini doğrular; okunamayan parçalar `dropped`'a (sayı tutmazsa nedeni bilinmeyen olarak), onarılan alanlar
 * ve atlanan eskiz yolları `warnings`'e (dosya yolundaki gibi printLoadNotes ile basılır, stderr'e kaybolmaz).
 */
async function parseTabProject(scene: unknown): Promise<LoadedProject> {
  const { parseProject } = await import('../src/io.ts');
  const dropped: string[] = [];
  const warnings: string[] = [];
  const project = parseProject(scene, dropped, warnings);
  const raw = (scene as { parts?: unknown } | null)?.parts;
  const rawCount = Array.isArray(raw) ? raw.length : 0;
  if (rawCount !== project.parts.length && !dropped.length) dropped.push(`${rawCount - project.parts.length} parça (neden bilinmiyor)`);
  return { project, dropped, warnings };
}

/**
 * Atlanan parçaları ve yükleme uyarılarını görünür basar: stdout (sonuçla birlikte okunsun); `toStderr` yalnızca
 * stdout'un JSON kalması gerektiğinde (scene --full).
 */
function printLoadNotes(l: { dropped: string[]; warnings: string[] }, toStderr = false): void {
  const out = toStderr ? console.error : console.log;
  if (l.dropped.length) out(`⚠ ${l.dropped.length} parça okunamadı ve atlandı (sonuçlara dahil değil):${listed(l.dropped)}`);
  for (const w of l.warnings) out(`⚠ ${w}`);
}

/**
 * `--file` verilmişse dosyadaki, yoksa çalışma alanı sekmesindeki proje (boolean çekirdeği hazır). `strict`: okunamayan
 * parça varsa hata (export); değilse `dropped`'da döner.
 */
async function sourceProject(command: string, strict = false): Promise<LoadedProject & { source: string }> {
  const src = fileFlag(command);
  if (src) return { ...(await readSource(src, strict)), source: sourceLabel(src) };
  const { initCsg } = await import('../src/csg.ts');
  await initCsg();
  const r = await getScene({ full: true });
  const { project, dropped, warnings } = await parseTabProject(r.scene);
  const source = `çalışma alanı: ${wsLabel(r.ws)} (rev ${r.rev})`;
  if (strict && dropped.length) {
    throw new Error(`Sekmedeki ${dropped.length} parça okunamadı (${source}):${listed(dropped)}\nHiçbir şey yazılmadı; parçaları düzeltin ya da silin.`);
  }
  return { project, dropped, warnings, source };
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
    try {
      const { detachedInfo, devPort } = await import('./devserver.ts');
      const port = devPort([], base);
      const d = detachedInfo(port);
      if (d) row('', `ayrık başlatıldı (pid ${d.pid}, ${d.started}); günlük: ${d.log}; durdurma: p3d stop${port !== 5173 ? ` --port ${port}` : ''}`);
    } catch {
      // bilgi satırı; durum dosyası okunamazsa geç
    }
  } catch (e) {
    const err = e as CallError;
    row('Sunucu:', err.status === 404 ? `${base} — erişilebilir ama köprü kapalı (sunucu --bridge ile başlatılmalı; npm run dev'de açıktır)` : `${base} — ERİŞİLEMİYOR. Başlatın: p3d dev (arka planda).`);
    process.exitCode = 1;
  }
  try {
    const { skillState } = await import('./guide.ts');
    const sk = skillState();
    row('Skill:', sk.state === 'güncel' ? `güncel (${sk.dest})` : sk.state === 'eski' ? `GÜNCEL DEĞİL — p3d skill install (${sk.dest})` : 'kurulu değil — p3d skill install');
  } catch (e) {
    row('Skill:', `denetlenemedi — ${(e as Error).message}`);
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

/**
 * Süpürme özeti: yol nokta sayısı, orta çizgi uzunluğu (yaylar dahil; CLI three.js yüklemesin diye burada hesaplanır),
 * kapalı/açık, kesit (profil noktaları ya da çap), köşe yarıçapı.
 */
function sweepLine(g: SweepGeom): string {
  const pts = g.path;
  const m = pts.length;
  const seg = (a: number[], b: number[]) => [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const norm = (v: number[]) => Math.hypot(v[0], v[1], v[2]);
  const edges = Array.from({ length: g.closed ? m : m - 1 }, (_, i) => seg(pts[i], pts[(i + 1) % m]));
  let len = edges.reduce((s, e) => s + norm(e), 0);
  edges.forEach((e, i) => {
    const next = edges[(i + 1) % edges.length];
    if (!g.closed && i === edges.length - 1) return;
    const own = (pts[(i + 1) % m] as number[])[3] ?? 0; // yalnızca > 0 bend'i ezer
    const r = own > 0 ? own : (g.bend ?? 0);
    const cos = (e[0] * next[0] + e[1] * next[1] + e[2] * next[2]) / (norm(e) * norm(next));
    const th = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (r > 0 && th > 1e-6) len -= 2 * r * Math.tan(th / 2) - r * th;
  });
  const sec = g.profile ? `profil${g.profile.length}${g.holes?.length ? `+${g.holes.length}boşluk` : ''}` : `Ø${n(g.diameter ?? 0)}${g.innerDiameter ? `/iç${n(g.innerDiameter)}` : ''}`;
  return `${g.path.length}nokta/${n(len)}mm/${g.closed ? 'kapalı' : 'açık'}/${sec}${g.bend ? `/bend${n(g.bend)}` : ''}${g.frame ? `/${g.frame}` : ''}`;
}

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
          : p.geom.kind === 'sweep'
            ? ` süpürme:${sweepLine(p.geom)}`
            : p.geom.kind === 'decal'
              ? ` kaplama:${p.geom.profile.length}nokta${p.geom.holes?.length ? `+${p.geom.holes.length}boşluk` : ''}${p.geom.double ? '/iki-yüz' : ''}/lift${n(p.geom.lift ?? 0.5)}`
              : ` ${p.geom.kind}:${p.geom.profile.length}nokta/${p.geom.axis}`;
  const group = p.group ? ` grup=${p.group}` : '';
  // Yalnızca ayarlıyken: saydamlık (opaklık < 1) ve parça başına çözünürlük (yoksa proje ayarı).
  const look = `${p.opacity !== undefined ? ` opaklık=${n(p.opacity)}` : ''}${p.resolution !== undefined ? ` çözünürlük=${p.resolution}` : ''}`;
  return (
    `${p.name === selected ? '*' : ' '} ${p.name} [${p.shape}${role}]${geom} ${params}${group}${look} | konum=${vec(p.position)}${rot}` +
    ` | bbox=${vec(p.bbox.min)} → ${vec(p.bbox.max)} | ${p.color}${p.visible ? '' : ' (gizli)'}`
  );
}

function printScene(s: SceneSummary): void {
  console.log(`tabla ${s.bed.x}×${s.bed.y} mm · ${s.parts.length} parça · seçili: ${s.selected ?? '-'}`);
  for (const p of s.parts) console.log(partLine(p, s.selected));
  if (s.groups?.length) {
    console.log(`gruplar (${s.groups.length}):`);
    for (const g of s.groups) console.log(`  ${g.name} pivot=${vec(g.pivot)} · ${s.parts.filter((p) => p.group === g.name).length} parça`);
  }
  // Kullanıcının çizdiği eskiz yolları (niyet verisi; ayrıntı: p3d sketch).
  if (s.sketch?.length) {
    console.log(`eskiz (${s.sketch.length}):`);
    for (const k of s.sketch) {
      const note = k.note ? ` · ${JSON.stringify(k.note)}` : '';
      console.log(`  ${k.name} · ${SKETCH_KIND_LABELS[k.kind]} · ${k.points.length} nokta · ${k.plane.axis} = ${n(k.plane.at)}${note}`);
    }
  }
}

/** Eskiz noktası / yönü: (x, y, z). */
const pt = (v: { x: number; y: number; z: number }) => `(${n(v.x)}, ${n(v.y)}, ${n(v.z)})`;
const span = (lo: number, hi: number) => (n(lo) === n(hi) ? n(lo) : `${n(lo)}…${n(hi)}`);
/** Metin listesinde yol başına gösterilen en çok nokta (tümü: --json). */
const SKETCH_POINTS_SHOWN = 40;

/** `p3d sketch` metin çıktısı: yol başına özet satırı, çizgi/çokgende nokta satırı, eğride polyline notu. */
function printSketch(list: SceneSummarySketch[] | undefined): void {
  if (!list?.length) {
    console.log('eskiz yok.');
    return;
  }
  console.log(`eskiz (${list.length} yol):`);
  for (const s of list) {
    const bits = [s.name, SKETCH_KIND_LABELS[s.kind]];
    if (s.kind === 'marker') bits.push(pt(s.points[0].p));
    else if (s.kind === 'arrow') {
      bits.push(`${n(s.length ?? 0)} mm`);
      if (s.direction) bits.push(`yön ${pt(s.direction)}`);
      bits.push(`${pt(s.points[0].p)} → ${pt(s.points[1].p)}`);
    } else {
      const b = s.bbox;
      bits.push(
        `${s.points.length} nokta`,
        `${s.kind === 'polygon' ? 'çevre' : 'uzunluk'} ${n(s.length ?? 0)} mm`,
        `düzlem ${s.plane.axis} = ${n(s.plane.at)}`,
        `kutu x ${span(b.min.x, b.max.x)}, y ${span(b.min.y, b.max.y)}, z ${span(b.min.z, b.max.z)}`,
      );
    }
    if (s.note) bits.push(`not: ${JSON.stringify(s.note)}`);
    console.log(`  ${bits.join(' · ')}`);
    if (s.kind === 'line' || s.kind === 'polygon') {
      const more = s.points.length - SKETCH_POINTS_SHOWN;
      console.log(`    ${s.points.slice(0, SKETCH_POINTS_SHOWN).map((q) => pt(q.p)).join(' ')}${more > 0 ? ` … (+${more} nokta; tümü: --json)` : ''}`);
    }
    if (s.polyline) console.log(`    eğri (tutamaçlı); polyline ${s.polyline.length} nokta — tümü: p3d sketch --json`);
  }
}

/** `p3d sketch [--file] [--json] [--sample N]`: eskiz yollarını listeler (dosya ya da çalışma alanı sekmesi). */
async function listSketch(): Promise<void> {
  const json = has('--json');
  const raw = flag('--sample');
  const seg = raw === undefined ? undefined : Number(raw);
  if (seg !== undefined && (!Number.isInteger(seg) || seg < 1 || seg > 64)) throw new Error(`--sample 1–64 arası bir tam sayı olmalı ('${raw}').`);
  // --json'da stdout yalnızca JSON kalsın (betikler okuyabilsin); başlık ve notlar stderr'e.
  const out = json ? console.error : console.log;
  let list: SceneSummarySketch[] | undefined;
  const src = fileFlag('sketch');
  if (src) {
    const loaded = await readSource(src, false);
    out(sourceLabel(src));
    printLoadNotes(loaded, json);
    const { sketchSummary } = await import('../src/sketch.ts');
    list = sketchSummary(loaded.project, seg);
  } else if (seg === undefined) {
    // Sekmenin bildirdiği sahne özeti (varsayılan örnekleme) yeter.
    const r = await getScene();
    out(sceneHeader(r));
    list = (r.scene as SceneSummary).sketch;
  } else {
    const r = await getScene({ full: true });
    out(sceneHeader(r));
    const loaded = await parseTabProject(r.scene);
    printLoadNotes(loaded, json);
    const { project } = loaded;
    const { sketchSummary } = await import('../src/sketch.ts');
    list = sketchSummary(project, seg);
  }
  if (json) console.log(JSON.stringify(list ?? [], null, 2));
  else printSketch(list);
}

/** `p3d sketch --clear [ad]`: yolu / tüm eskizi siler. Dosyada `apply` kuralları: hata ya da okunamayan parça varsa yazılmaz. */
async function clearSketch(): Promise<void> {
  const ref = positionals()[0] ?? '';
  const ops: Op[] = [{ op: 'sketch_delete', ...(ref ? { path: ref } : {}) }];
  const file = projectFileFlag('sketch');
  if (!file) {
    printResult(await post({ ops, label: flag('--label') ?? (ref ? `Eskiz yolunu sil: ${ref}` : 'Eskizi temizle') }));
    return;
  }
  if (!statOf(file)?.isFile()) throw new Error(`Dosya bulunamadı: ${file}`);
  const loaded = await readProjectFile(file, true);
  printLoadNotes(loaded);
  const label = flag('--label');
  if (label) console.log(`İşlem: ${label}`);
  const { applyOps } = await import('../src/engine.ts');
  const before = JSON.stringify(loaded.project);
  const res = applyOps(loaded.project, ops, null);
  for (const m of res.messages) console.log(`✓ ${m}`);
  for (const m of res.errors) console.log(`✕ ${m}`);
  if (res.errors.length) {
    process.exitCode = 1;
    console.log(`✕ ${file} yazılmadı (dosya değişmedi).`);
    return;
  }
  if (JSON.stringify(loaded.project) === before) {
    console.log(`Değişiklik yok; ${file} yazılmadı.`);
    return;
  }
  const { saveProjectFile } = await import('../src/files.ts');
  const saved = saveProjectFile(loaded.project, file);
  for (const w of saved.warnings) console.log(`⚠ ${w}`);
  console.log(`✓ Kaydedildi: ${saved.file} (${saved.parts} parça${saveNote(saved)})`);
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

/** İşlem listesi: `--ops dosya.json` ya da stdin; JSON dizi ya da {"ops": [...]}. */
async function readOps(): Promise<Op[]> {
  const opsFile = flag('--ops');
  let text: string;
  let where: string;
  if (opsFile) {
    where = fromCaller(opsFile);
    try {
      text = readFileSync(where, 'utf8');
    } catch (e) {
      throw new Error(statOf(where) ? `${where} okunamadı: ${(e as Error).message}` : `İşlem dosyası bulunamadı: ${where}`);
    }
  } else {
    if (process.stdin.isTTY) throw new Error('İşlemleri stdin\'den (… <<\'EOF\' … EOF) ya da --ops dosya.json ile verin.');
    where = 'stdin';
    text = await readStdin();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`İşlemler (${where}) geçerli JSON değil: ${(e as Error).message}`);
  }
  const ops = Array.isArray(raw) ? raw : (raw as { ops?: unknown } | null)?.ops;
  if (!Array.isArray(ops) || !ops.every((o) => o && typeof o === 'object' && typeof (o as { op?: unknown }).op === 'string')) {
    throw new Error(`İşlemler (${where}) bir işlem dizisi olmalı: [{"op": "create", …}] ya da {"ops": [...]}.`);
  }
  return ops as Op[];
}

/** check seçenekleri: --profile print|game, --max-tris N (yalnızca game). */
function checkOptions(): CheckOptions {
  const profile = flag('--profile') ?? 'print';
  if (profile !== 'print' && profile !== 'game') throw new Error(`--profile print ya da game olmalı ('${profile}').`);
  // Bütçe gizli üçgenler atıldıktan sonraki sayıyla (export --cull-hidden çıktısı).
  const cull = has('--cull-hidden');
  if (cull && profile !== 'game') throw new Error('--cull-hidden yalnızca --profile game ile kullanılır (bütçe ayıklanmış üçgenlerle sayılır).');
  const extra = cull ? { cullHidden: true } : {};
  const raw = flag('--max-tris');
  if (raw === undefined) return { profile, ...extra };
  const maxTris = Number(raw);
  if (!Number.isInteger(maxTris) || maxTris < 1) throw new Error(`--max-tris pozitif bir tam sayı olmalı ('${raw}').`);
  if (profile !== 'game') throw new Error('--max-tris yalnızca --profile game ile kullanılır (üçgen bütçesi).');
  return { profile, maxTris, ...extra };
}

/**
 * Görüntüleri `out` klasörüne yazar, yolları ve görünür kutuyu basar. PNG başlığındaki boyut istenenden farklıysa
 * (tarayıcı tuvali küçülttüyse) uyarır; yol satırları değişmez (betikler satırları yol olarak okuyabilir).
 */
function writeSnapshots(r: BridgeResult, req: SnapshotOptions): void {
  const out = fromCaller(flag('--out') ?? path.join(tmpdir(), 'p3d-snapshots'));
  mkdirSync(out, { recursive: true });
  for (const img of r.images ?? []) {
    const file = path.join(out, `${img.view}.png`);
    const png = Buffer.from(img.png.replace(/^data:image\/png;base64,/, ''), 'base64');
    writeFileSync(file, png);
    console.log(file);
    // IHDR: genişlik 16., yükseklik 20. bayttan (big-endian).
    const [w, h] = png.length >= 24 ? [png.readUInt32BE(16), png.readUInt32BE(20)] : [0, 0];
    if (w !== req.width || h !== req.height) console.log(`uyarı: ${img.view}.png ${w}x${h} çıktı (istenen ${req.width}x${req.height}); tarayıcı tuvali küçülttü`);
  }
  for (const m of r.errors) console.log(`✕ ${m}`);
  if (r.errors.length || !r.images?.length) process.exitCode = 1;
  // Kadraj kutusu: seçim (--parts / --focus) varsa yalnızca o parçalar (ad ya da grup adı; sekmedeki kuralla aynı).
  const sel = (req.parts ?? req.focus)?.map((n) => fold(n).trim());
  const picked = (p: SceneSummaryPart) => !sel || sel.includes(fold(p.name).trim()) || (p.group !== undefined && sel.includes(fold(p.group).trim()));
  const box = r.scene.parts.filter((p) => p.visible && p.role !== 'hole' && picked(p)).reduce(
    (b, p) => ({
      min: { x: Math.min(b.min.x, p.bbox.min.x), y: Math.min(b.min.y, p.bbox.min.y), z: Math.min(b.min.z, p.bbox.min.z) },
      max: { x: Math.max(b.max.x, p.bbox.max.x), y: Math.max(b.max.y, p.bbox.max.y), z: Math.max(b.max.z, p.bbox.max.z) },
    }),
    { min: { x: Infinity, y: Infinity, z: Infinity }, max: { x: -Infinity, y: -Infinity, z: -Infinity } },
  );
  if (Number.isFinite(box.min.x)) console.log(`${sel ? 'seçimin kutusu' : 'görünür kutu'}: ${vec(box.min)} → ${vec(box.max)} (dik görünümler bu kutuya %6 payla sığdırılır)`);
}

/**
 * snapshot isteği: `--views` bilinen görünümler olmalı; `--size GENxYÜK` kenarları SNAPSHOT_MIN_SIDE–SNAPSHOT_MAX_SIDE
 * piksel aralığına oturtulur (uzun kenar sınırı aşarsa orantılı küçültme) ve değiştiyse uyarılır — sessiz kırpma yok.
 */
function snapshotRequest(): { action: 'snapshot'; snapshot: SnapshotOptions } {
  const camera = snapshotCameraFlags();
  // --eye `camera`, --eye-height `eye` görünümünü ekler; --views verilmediyse yalnızca onlar çekilir.
  const views = list('--views') ?? [];
  if (camera.eye && !views.includes('camera')) views.push('camera');
  if (camera.eyeHeight !== undefined && !views.includes('eye')) views.push('eye');
  if (!views.length) views.push('iso', 'front', 'right', 'top');
  const unknown = views.filter((v) => !(SNAPSHOT_VIEWS as readonly string[]).includes(v));
  if (unknown.length) {
    const side = unknown.includes('side') ? '; yan görünüm: left ya da right' : '';
    throw new Error(`Bilinmeyen görünüm: ${unknown.join(', ')} (olanlar: ${SNAPSHOT_VIEWS.join(', ')}${side}).`);
  }
  if (views.includes('camera') && !camera.eye) throw new Error('camera görünümü --eye x,y,z ister (kamera konumu, mm).');
  if ((camera.target || camera.fov !== undefined) && !views.some((v) => v === 'eye' || v === 'camera')) {
    throw new Error('--target ve --fov yalnızca perspektif görünümlerde (eye, camera) geçerli.');
  }
  // İzdüşüm: verilmezse gönderilmez (iso perspektif, dik görünümler orto; arayüzdeki kamera tipinden bağımsız).
  const projection = flag('--projection');
  if (projection !== undefined && !(SNAPSHOT_PROJECTIONS as readonly string[]).includes(projection)) {
    throw new Error(`Bilinmeyen --projection: ${projection} (olanlar: ${SNAPSHOT_PROJECTIONS.join(', ')}).`);
  }
  if (projection === 'ortho') {
    if (views.includes('eye')) {
      throw new Error('eye görünümü göz hizasından perspektiftir; --projection ortho ile kullanılamaz (ortografik için iso ya da --eye x,y,z ile camera).');
    }
    if (camera.fov !== undefined) throw new Error('Ortoda --fov anlamsız (dik izdüşümde görüş açısı yok): --fov\'u kaldırın ya da --projection perspective kullanın.');
  }
  const raw = flag('--size') ?? '1000x750';
  const m = /^\s*(\d+)\s*[xX×]\s*(\d+)\s*$/.exec(raw);
  if (!m || Number(m[1]) < 1 || Number(m[2]) < 1) throw new Error(`--size GENİŞLİKxYÜKSEKLİK (piksel) olmalı, ör. 1000x750 ('${raw}').`);
  const [w, h] = [Number(m[1]), Number(m[2])];
  const fit = fitSnapshotSize(w, h);
  if (fit.width !== w || fit.height !== h) {
    const kept = Math.abs(fit.width / fit.height / (w / h) - 1) < 0.01;
    console.log(
      `uyarı: --size ${w}x${h} sınır dışında (kenar ${SNAPSHOT_MIN_SIDE}–${SNAPSHOT_MAX_SIDE} piksel) → ${fit.width}x${fit.height} ` +
        `çekiliyor (${kept ? 'en-boy oranı korundu' : 'en-boy oranı değişti'})`,
    );
  }
  const hasCamera = Object.keys(camera).length > 0;
  // Biçim: verilmezse gönderilmez (sekme gölgeli çeker; arayüzdeki biçimden bağımsız).
  const style = flag('--style');
  if (style !== undefined && !(VIEW_STYLES as readonly string[]).includes(style)) {
    throw new Error(`Bilinmeyen --style: ${style} (olanlar: ${VIEW_STYLES.join(', ')}; tel kafes: wire, arkadakiler dahil: xray).`);
  }
  // Seçim (BoltRush #4): --parts yalnızca bu parçaları çizer ve kadraja alır, --focus kadrajı bunlara daraltır (diğerleri bağlam).
  const parts = list('--parts');
  const focus = list('--focus');
  if (parts?.length && focus?.length) throw new Error('--parts (yalnızca bu parçalar) ile --focus (bu parçalara sığdır) birlikte verilmez.');
  return {
    action: 'snapshot',
    snapshot: {
      views: views as SnapshotView[],
      ...fit,
      dims: has('--dims'),
      ...(hasCamera ? { camera } : {}),
      ...(style ? { style: style as ViewStyle } : {}),
      ...(projection ? { projection: projection as SnapshotProjection } : {}),
      ...(parts?.length ? { parts } : {}),
      ...(focus?.length ? { focus } : {}),
    },
  };
}

/** --eye / --target x,y,z (mm), --fov derece (10–120), --eye-height mm; geçersiz değer hata. */
function snapshotCameraFlags(): SnapshotCamera {
  const vec = (name: string): Vec3 | undefined => {
    const raw = flag(name);
    if (raw === undefined) return undefined;
    const v = raw.split(',').map((t) => (t.trim() === '' ? NaN : Number(t)));
    if (v.length !== 3 || !v.every(Number.isFinite)) throw new Error(`${name} x,y,z (mm) olmalı ('${raw}').`);
    return { x: v[0], y: v[1], z: v[2] };
  };
  const out: SnapshotCamera = {};
  const eye = vec('--eye');
  const target = vec('--target');
  if (eye) out.eye = eye;
  if (target) out.target = target;
  if (eye && target && eye.x === target.x && eye.y === target.y && eye.z === target.z) throw new Error('--eye ile --target aynı nokta olamaz.');
  const fov = flag('--fov');
  if (fov !== undefined) {
    const f = Number(fov);
    if (fov.trim() === '' || !Number.isFinite(f) || f < SNAPSHOT_FOV_MIN || f > SNAPSHOT_FOV_MAX) {
      throw new Error(`--fov ${SNAPSHOT_FOV_MIN}–${SNAPSHOT_FOV_MAX} derece olmalı ('${fov}').`);
    }
    out.fov = f;
  }
  const eh = flag('--eye-height');
  if (eh !== undefined) {
    const h = Number(eh);
    if (eh.trim() === '' || !Number.isFinite(h)) throw new Error(`--eye-height mm cinsinden bir sayı olmalı ('${eh}').`);
    out.eyeHeight = h;
  }
  return out;
}

/**
 * `snapshot --file`: makinedeki Chrome/Edge'i görünmez açar, geçici bir çalışma alanında (`_snap-<rastgele>`) projeyi
 * yükler, görüntü alır (`src/snapshot-node.ts`; P3D sunucusu çalışmıyorsa bu süreçte geçici sunucu). Tarayıcı süreç ağacı,
 * geçici profil ve geçici sunucu her durumda (hata dahil) kapatılır/silinir.
 */
async function snapshotFile(src: SourceFile): Promise<void> {
  const req = snapshotRequest(); // geçersiz --size/--views/--style tarayıcı açılmadan hata versin
  const { file } = src;
  const loaded = await readSource(src, false);
  printLoadNotes(loaded);
  const { project } = loaded;
  // Çalışan P3D sunucusu (P3D_URL) varsa o, yoksa bu süreçte geçici sunucu (BoltRush #2; eskiden "sunucu çalışmıyor" hatası).
  const { openSnapshotTab } = await import('../src/snapshot-node.ts');
  const tab = await openSnapshotTab({ server: 'auto' });
  if (tab.temporary) console.log(`not: P3D sunucusu çalışmıyor (${base}); görüntü için geçici sunucu açıldı`);
  // Ctrl+C da "her durum"dur: görünmez tarayıcı, geçici profil ve geçici sunucu geride kalmasın.
  const interrupted = () => void tab.close().finally(() => process.exit(130));
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const { load, result } = await tab.send({ ...project, name: project.name || path.basename(file) }, req.snapshot);
    for (const m of load.errors) console.log(`✕ ${m}`);
    writeSnapshots(result, req.snapshot);
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
    await tab.close();
  }
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

/** measure / section: --parts verilmezse görünür, delik olmayan parçalar. */
async function measureOrSection(command: 'measure' | 'section'): Promise<void> {
  const THREE = await import('three');
  const { initCsg, sliceMany } = await import('../src/csg.ts');
  await initCsg();
  const axis = (flag('--axis') ?? 'z') as 'x' | 'y' | 'z';
  const ats = (list('--at') ?? []).map(Number);
  const tol = Number(flag('--tol') ?? 0.1);
  if (command === 'section' && (!['x', 'y', 'z'].includes(axis) || !ats.length || ats.some((v) => !Number.isFinite(v)))) {
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
  const fileArg = flag('--file');
  if (command === 'section' && fileArg && fileKind(fileArg) === 'mesh') {
    const file = fromCaller(fileArg);
    const { readMeshFile } = await import('../src/files.ts');
    const soup = readMeshFile(file);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(soup, 3));
    g.computeBoundingBox();
    console.log(`${path.basename(file)}: kutu ${vec(g.boundingBox!.min)} → ${vec(g.boundingBox!.max)} (dosya koordinatları)`);
    printSection(path.basename(file), g);
    return;
  }
  const loaded = await sourceProject(command);
  printLoadNotes(loaded);
  const { project } = loaded;
  const { worldMesh, mergedMesh } = await import('../src/io.ts');
  const { isDecal, roleOf, solidBox, solidVolume } = await import('../src/model.ts');
  const names = list('--parts');
  // Varsayılan küme: görünür, delik olmayan parçalar; kaplamalar (kalınlıksız, hacimsiz, kesitsiz) sessizce atlanır.
  const parts = project.parts.filter((p) => (names ? names.includes(p.name) : p.visible && roleOf(p) !== 'hole' && !isDecal(p)));
  if (names) for (const nm of names) if (!parts.some((p) => p.name === nm)) console.log(`(uyarı: '${nm}' bulunamadı)`);
  if (command === 'measure') {
    let total = 0;
    const all = new THREE.Box3();
    // Kaplama (decal) kalınlıksızdır: katı toplamına ve birleşik hacme girmez.
    const isBody = (p: (typeof parts)[number]) => roleOf(p) === 'solid' && !isDecal(p);
    for (const p of parts) {
      // Katıda delikler çıkarılmış kutu (hacimle aynı geometri); delik/referansta şeklin kutusu.
      const b = solidBox(project, p);
      const v = solidVolume(project, p);
      if (isBody(p)) {
        total += v;
        all.union(b);
      }
      const s = b.getSize(new THREE.Vector3());
      const boxText = b.isEmpty() ? 'kutu yok (delikler tümünü kesiyor)' : `kutu ${vec(b.min)} → ${vec(b.max)} (${vec(s)})`;
      const decal = isDecal(p) && roleOf(p) === 'solid';
      console.log(`${p.name} [${decal ? 'kaplama' : roleOf(p)}]: ${boxText}, hacim ${n(v / 1000)} cm³${decal ? ' (kalınlıksız)' : ''}`);
    }
    if (!all.isEmpty()) {
      const s = all.getSize(new THREE.Vector3());
      // Örtüşen parçalar toplamda iki kez sayılır; birleşim (union) hacmi baskıdaki gerçek hacimdir.
      const solids = parts.filter(isBody);
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
    if (isDecal(p)) {
      console.log(`${p.name}: kaplama: kalınlıksız, kesit yok`);
      continue;
    }
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
}

const kb = (bytes: number) => `${(bytes / 1024).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} kB`;

function saveNote(s: { embedded: number; referenced: number }): string {
  const bits = [s.embedded ? `${s.embedded} ağ gömülü` : '', s.referenced ? `${s.referenced} ağ yolla anılıyor` : ''].filter(Boolean);
  return bits.length ? `; ${bits.join(', ')}` : '';
}

const USAGE = [
  'Kullanım: p3d [--ws <ad>] <komut>   (depo içinde: npm run -s p3d -- <komut>; komut yardımı: p3d <komut> --help)',
  '  Çalışma alanı: --ws <ad> (kök: --ws "" ya da --ws /) > P3D_WS > üst klasörlerdeki ilk p3d.json ("workspace") > kök',
  '',
  'Sekme (sunucu: p3d dev; ws sekmesi açık):',
  '  status · view · scene [--full] [--stale] · undo · redo · fit',
  '  ops [--ops ops.json] [--label "metin"]   (ya da stdin: … < ops.json)',
  '  open [dosya.p3d.json] [--force] · save [dosya.p3d.json] [--force] [--embed]   (dosya verilmezse p3d.json → "file")',
  '  snapshot [--views iso,front,back,left,right,top,bottom,eye,camera] [--size 1000x750] [--dims] [--out klasör]',
  '           [--style shaded|wire|xray]   biçim: gölgeli (varsayılan) / tel kafes / X-ışını',
  '           [--projection perspective|ortho]   ortho: iso ve camera da dik izdüşüm (eye perspektif kalır)',
  '           [--eye x,y,z] [--target x,y,z] [--fov 50] [--eye-height 1000]   perspektif: camera (göz konumu) / eye (göz hizası)',
  '           [--parts a,b | --focus a,b]   odak: yalnızca bu parçalar / kadraj bunlara (diğerleri bağlam); ad ya da grup adı',
  '  import <dosya.stl|obj|3mf|glb> [--name ad] [--role solid|hole|reference] [--color #hex] [--max-tris N] [--keep-position]',
  '         (--max-tris varsayılanı GLB 1 000 000, diğerleri 60 000)',
  '',
  'Sekme ya da dosya (--file m.p3d.json ile tarayıcısız; scene/snapshot/measure/check/section/sketch ağ dosyası da alır: --file ağ.glb|stl|obj|3mf):',
  '  scene --file m.p3d.json|ağ.glb [--full]',
  '  check [--file m.p3d.json|ağ.glb] [--profile print|game] [--max-tris N] [--cull-hidden]',
  '  measure [--file m.p3d.json|ağ.glb] [--parts a,b]',
  '  section --axis x|y|z --at v1,v2 [--parts a,b] [--file m.p3d.json | ağ.stl|obj|3mf|glb] [--tol 0.1]',
  '  export <çıktı.stl|3mf|obj|glb> [--file m.p3d.json] [--parts a,b] [--merge] [--skeleton] [--cull-hidden] [--units m|mm] [--normals flat|smooth]',
  '  snapshot --file m.p3d.json|ağ.glb [--views …] [--size …] [--dims] [--style …] [--projection …] [--out klasör]   (görünmez Chrome/Edge; P3D_CHROME)',
  '  sketch [--file m.p3d.json] [--json] [--sample 8]   (kullanıcının çizdiği eskiz yolları)',
  '  sketch --clear [ad] [--file m.p3d.json] [--label "metin"]   (ad yoksa tüm eskiz silinir)',
  '',
  'Yalnızca dosya:',
  '  apply --file m.p3d.json [--ops ops.json | stdin] [--out başka.p3d.json] [--force] [--dry-run] [--new] [--embed] [--label "metin"]',
  '',
  'Diğer:',
  '  run <betik.mts|ts|mjs|js> [arg…]   (betikte: import { applyOps, THREE } from \'p3d\')',
  '  dev [npm run dev bayrakları] [--detach]   (sunucuyu P3D klasöründe başlatır; çalışıyorsa söyler; --detach: ayrık, hazır olunca döner)',
  '  stop [--port N]   (portta çalışan P3D sunucusunu durdurur; ayrık ya da ön planda başlatılmış)',
  '  guide [konu] · skill install   (status, kurulu skill eskiyse uyarır)',
].join('\n');

const HELP_FLAGS = new Set(['--help', '-h']);
/** Komut yardımı için rehber konusu (yoksa cli). */
const HELP_TOPIC: Record<string, string> = {
  snapshot: 'verify', check: 'verify', measure: 'verify', section: 'verify', export: 'game', ops: 'ops', apply: 'ops',
  run: 'scripts', sketch: 'sketch', status: 'workspaces', view: 'workspaces', open: 'workspaces', save: 'workspaces', dev: 'workspaces',
  stop: 'workspaces',
};
const HELP_NOTES: Record<string, string[]> = {
  snapshot: [
    `Görünümler: ${SNAPSHOT_VIEWS.join(', ')} (yan görünüm left / right; side yok).`,
    'Biçimler (--style): shaded (gölgeli, varsayılan) · wire (tel kafes: her üçgen kenarı, arkadakiler gizli) · xray (X-ışını: arkadakiler dahil tüm kenarlar, parça renginde).',
    'İzdüşüm (--projection): perspective (varsayılan: iso perspektif 30°, dik görünümler orto) · ortho (iso ve camera da dik izdüşüm, kutuyu çerçeveler; eye ve --fov ile kullanılamaz).',
    'Ortoda camera: --eye → --target (yoksa kutu merkezi) yalnızca bakış yönünü verir; çerçeve her zaman görünür kutuya oturur.',
    'Odak: --parts a,b yalnızca bu parçaları çizer ve kadraja alır (diğerleri, delikler, eskiz gizli); --focus a,b kadrajı bunlara daraltır, diğerleri bağlam. Ad: parça ya da grup adı.',
  ],
  dev: [
    'Bayraklar: --llm auto|api|claude-cli|off · --bridge / --no-bridge · --port N · --host adres · --model id · --effort düzey · --claude-bin yol',
    '--detach: sunucu terminalden bağımsız çalışır (çıktı boruya bağlansa da kapanmaz), /api/status yanıt verince döner; günlük ve PID geçici klasörde (p3d-dev-<port>.log/.json). Durdurma: p3d stop.',
  ],
  stop: ["Yalnızca /api/status'ü P3D gibi yanıtlayan sunucu durdurulur (aynı porttaki başka uygulamaya dokunulmaz); süreç ağacıyla (Windows: taskkill /T)."],
};

/**
 * `p3d --help`, `p3d help [komut]`, `p3d <komut> --help|-h`: sunucu, sekme ve çalışma alanı denetiminden önce yanıtlanır
 * (BoltRush isteği #22). Bayrak değeri olarak yazılan `--help` sayılmaz; `run`'da yalnızca betikten önce (sonrası betiğindir).
 * Yardım istenmediyse undefined, istendiyse yardımın konusu ('' = genel).
 */
function helpTarget(): string | undefined {
  if (!cmd || HELP_FLAGS.has(cmd)) return '';
  if (cmd === 'help') return rest[0] === undefined || HELP_FLAGS.has(rest[0]) ? '' : rest[0];
  if (cmd === 'run') return HELP_FLAGS.has(rest[0] ?? '') ? cmd : undefined;
  for (let i = 0; i < rest.length; i++) {
    if (VALUE_FLAGS.has(rest[i])) i++;
    else if (HELP_FLAGS.has(rest[i])) return cmd;
  }
  return undefined;
}

/** USAGE'daki komut satırları (bölüm başlığı ve devam satırlarıyla); komut yoksa boş. */
function usageFor(name: string): string[] {
  const lines = USAGE.split('\n');
  const out: string[] = [];
  let header = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\S.*:$/.test(line)) {
      header = line;
      continue;
    }
    if (!/^ {2}\S/.test(line)) continue;
    const names = line.trim().split(' · ').map((s) => s.split(/\s/)[0]);
    if (!names.includes(name)) continue;
    if (header && !out.includes(header)) out.push(header);
    out.push(line);
    while (/^ {3,}\S/.test(lines[i + 1] ?? '')) out.push(lines[++i]);
  }
  return out;
}

function printHelp(name: string): void {
  const lines = name ? usageFor(name) : [];
  if (!lines.length) {
    if (name) console.log(`Bilinmeyen komut: ${name}\n`);
    console.log(USAGE);
    process.exitCode = name ? 1 : 0;
    return;
  }
  console.log(`p3d ${name} — kullanım:`);
  for (const l of lines) console.log(l);
  for (const n of HELP_NOTES[name] ?? []) console.log(n);
  const topic = HELP_TOPIC[name];
  console.log(`Ayrıntı: p3d guide ${topic ? `${topic} · tüm komutlar: p3d guide cli` : 'cli'}`);
}

async function main(): Promise<void> {
  const help = helpTarget();
  if (help !== undefined) return printHelp(help);
  // `sketch` yalnızca --clear ile ve sekmeye giderken sahneyi değiştirir.
  if (TAB_MUTATING.has(cmd) || (cmd === 'sketch' && has('--clear') && flag('--file') === undefined)) guardRoot();
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
      const src = fileFlag('scene');
      if (src) {
        const { file } = src;
        const loaded = await readSource(src, false);
        if (full) {
          // Dosyadaki gibi (src göreli, dosyada gömülü ağlar gömülü); stdout yalnızca JSON, notlar stderr'e.
          const { projectFileText } = await import('../src/files.ts');
          console.error(sourceLabel(src));
          printLoadNotes(loaded, true);
          // Ağ dosyasında stdout başka bir klasöre kaydedilebilir: kaynak yolu mutlak yazılır (proje dosyasında göreli kalır).
          console.log(projectFileText(loaded.project, file, { absoluteSrc: src.mesh }));
        } else {
          const { sceneSummary } = await import('../src/engine.ts');
          console.log(sourceLabel(src));
          printLoadNotes(loaded);
          printScene(sceneSummary(loaded.project, null));
        }
        return;
      }
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
      const ops = await readOps();
      printResult(await post({ ops, label: flag('--label') }));
      return;
    }
    case 'undo':
    case 'redo':
    case 'fit':
      printResult(await post({ action: cmd, label: flag('--label') }));
      return;
    case 'apply': {
      const fileArg = flag('--file');
      if (!fileArg) throw new Error('apply --file <model.p3d.json> gerekli (açık sekmeye işlem göndermek için: p3d ops).');
      const file = projectFileFlag('apply')!;
      const out = flag('--out') ? fromCaller(flag('--out')!) : file;
      if (fileKind(out) !== 'project') throw new Error(`--out bir proje dosyası olmalı (.p3d.json): ${out}`);
      // --out başka bir mevcut dosyayı gösteriyorsa yanlışlıkla ezilmesin (kaynak dosyanın kendisi serbest).
      const otherOut = !samePath(out, file);
      if (otherOut && !has('--force') && !has('--dry-run') && statOf(out)) {
        throw new Error(`${out} zaten var (--out kaynak dosyadan farklı: ${file}); üzerine yazmak için --force ekleyin ya da başka bir dosya adı verin.`);
      }
      const ops = await readOps();
      const { initCsg } = await import('../src/csg.ts');
      let project: Project;
      if (!statOf(file)) {
        if (!has('--new')) throw new Error(`Dosya bulunamadı: ${file} (yeni proje için --new ekleyin).`);
        const { newProject } = await import('../src/types.ts');
        project = newProject(path.basename(file).replace(/(\.p3d)?\.json$/i, '') || 'Proje');
        await initCsg();
        console.log(`Yeni proje: ${file}`);
      } else {
        const loaded = await readProjectFile(file, true);
        printLoadNotes(loaded);
        project = loaded.project;
      }
      const label = flag('--label');
      if (label) console.log(`İşlem: ${label}`);
      const { applyOps, sceneSummary } = await import('../src/engine.ts');
      const res = applyOps(project, ops, null);
      for (const m of res.messages) console.log(`✓ ${m}`);
      for (const m of res.errors) console.log(`✕ ${m}`);
      if (!res.messages.length && !res.errors.length) console.log('Değişiklik yok.');
      console.log('');
      printScene(sceneSummary(project, null));
      console.log('');
      if (res.errors.length) {
        process.exitCode = 1;
        console.log(`✕ ${res.errors.length} işlem uygulanamadı; ${out} yazılmadı (dosya değişmedi). Hataları düzeltip tüm listeyi yeniden gönderin.`);
        return;
      }
      if (has('--dry-run')) {
        console.log(`(deneme) ${out} yazılmadı.`);
        return;
      }
      const { saveProjectFile } = await import('../src/files.ts');
      const saved = saveProjectFile(project, out, { embed: has('--embed'), overwrite: !otherOut || has('--force') });
      for (const w of saved.warnings) console.log(`⚠ ${w}`);
      console.log(`✓ Kaydedildi: ${saved.file} (${saved.parts} parça${saveNote(saved)})`);
      return;
    }
    case 'open': {
      const file = projectFile('open');
      const force = has('--force');
      if (!statOf(file)?.isFile()) throw new Error(`Dosya bulunamadı: ${file}`);
      const { loadProjectFile } = await import('../src/files.ts');
      const { usedAssets } = await import('../src/assets.ts');
      const dropped: string[] = [];
      const warnings: string[] = [];
      const project = await loadProjectFile(file, { dropped, warnings });
      for (const w of warnings) console.log(`⚠ ${w}`);
      // Parça sessizce kaybolmasın: okunamayanlar listelenir; --force ile yüklenir ama sekme kirli kalır.
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
      const { existingProjectFile, saveProjectFile } = await import('../src/files.ts');
      const existing = existingProjectFile(file);
      const r = await getScene({ full: true });
      // Sekmenin projesi (sunucunun eklediği `assets` hariç): özeti sekme kendi JSON'uyla karşılaştırır.
      const { assets: _assets, ...tabProject } = r.scene as Record<string, unknown>;
      const { project, dropped, warnings } = await parseTabProject(r.scene);
      if (dropped.length) {
        throw new Error(`Sekmedeki ${dropped.length} parça dosyaya yazılamazdı (okunamadı):${listed(dropped)}\nDosya yazılmadı.`);
      }
      for (const w of warnings) console.log(`⚠ ${w}`);
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
      const saved = saveProjectFile(project, file, { embed: has('--embed') });
      for (const w of saved.warnings) console.log(`⚠ ${w}`);
      console.log(`✓ Kaydedildi: ${file} (${project.parts.length} parça; çalışma alanı ${wsLabel(r.ws)}, rev ${r.rev}${saveNote(saved)})`);
      try {
        const m = await post({ action: 'mark_saved', file, digest: contentDigest(JSON.stringify(tabProject)) });
        for (const e of m.errors) console.log(`⚠ ${e}`);
      } catch (e) {
        console.log(`⚠ Sekme "kaydedildi" olarak işaretlenemedi: ${(e as Error).message}`);
      }
      return;
    }
    case 'snapshot': {
      const src = fileFlag('snapshot');
      if (src) return snapshotFile(src);
      const req = snapshotRequest();
      writeSnapshots(await post(req), req.snapshot);
      return;
    }
    case 'import': {
      const arg = positionals()[0];
      if (!arg) throw new Error('Dosya yolu gerekli: import <dosya.stl|obj|3mf|glb>');
      const file = fromCaller(arg);
      if (!statOf(file)?.isFile()) throw new Error(`Dosya bulunamadı: ${file}`);
      const { defaultMaxTris, meshAssetFromSoup, meshFormatOf, parseMeshFile } = await import('../src/meshio.ts');
      // Varsayılan sınır biçime göre: GLB'de pratikte sadeleştirme yok (oyun varlığının üçgen topolojisi), diğerlerinde 60 000.
      const maxTris = Number(flag('--max-tris') ?? defaultMaxTris(meshFormatOf(file)));
      if (!Number.isInteger(maxTris) || maxTris < 1) throw new Error(`--max-tris pozitif bir tam sayı olmalı ('${flag('--max-tris')}').`);
      const { sourceStamp } = await import('../src/files.ts');
      const name = flag('--name') ?? path.basename(file).replace(/\.[^.]+$/, '');
      const data = readFileSync(file);
      const imp = await meshAssetFromSoup(name, parseMeshFile(file, new Uint8Array(data).buffer), maxTris);
      console.log(`${path.basename(file)}: ${imp.originalTriangles} üçgen → ${imp.asset.triangles}; boyut ${vec(imp.size)} mm; dosyadaki merkez ${vec(imp.center)}`);
      const op: Op = {
        op: 'import_mesh',
        asset: imp.asset,
        name,
        role: (flag('--role') ?? '') as Extract<Op, { op: 'import_mesh' }>['role'],
        color: flag('--color'),
        position: has('--keep-position') ? imp.center : null,
        // Kaynak yolla anılır: p3d save ağı gömmez, proje dosyasına göreli yol yazar (--embed ile gömer). Damga
        // (boyut + özet) kaynak sonradan değişirse fark edilsin diye.
        src: file,
        maxTris,
        ...sourceStamp(data),
      };
      printResult(await post({ ops: [op], label: flag('--label') ?? `İçe aktar: ${path.basename(file)}` }));
      return;
    }
    case 'check': {
      const opts = checkOptions();
      const { project, source, dropped, warnings } = await sourceProject('check');
      const { checkProject } = await import('../src/check.ts');
      const notes = [opts.maxTris ? `bütçe ${opts.maxTris} üçgen` : '', opts.cullHidden ? 'gizli üçgenler atılmış' : ''].filter(Boolean);
      console.log(`${source} · profil ${opts.profile}${notes.length ? ` (${notes.join(', ')})` : ''}`);
      for (const w of warnings) console.log(`⚠ ${w}`);
      // Okunamayan parça denetlenemedi: "sorun yok" denmesin.
      for (const d of dropped) console.log(`✕ Parça okunamadı, denetlenmedi: ${d}`);
      const issues = checkProject(project, opts);
      for (const i of issues) console.log(`${i.level === 'hata' ? '✕' : '⚠'} ${i.message}`);
      if (!issues.length && !dropped.length) console.log('✓ Sorun bulunmadı.');
      if (dropped.length || issues.some((i) => i.level === 'hata')) process.exitCode = 1;
      return;
    }
    case 'measure':
    case 'section':
      return measureOrSection(cmd);
    case 'sketch':
      return has('--clear') ? clearSketch() : listSketch();
    case 'export': {
      const outArg = positionals()[0];
      if (!outArg) throw new Error('Çıktı dosyası gerekli: export <çıktı.stl|3mf|obj|glb> [--file m.p3d.json]');
      const units = flag('--units');
      const normals = flag('--normals');
      const { project, source, warnings } = await sourceProject('export', true);
      for (const w of warnings) console.log(`⚠ ${w}`);
      const { exportFile } = await import('../src/files.ts');
      const r = await exportFile(project, fromCaller(outArg), {
        parts: list('--parts'),
        merge: has('--merge') || undefined,
        skeleton: has('--skeleton') || undefined,
        units: units as 'm' | 'mm' | undefined,
        normals: normals as 'flat' | 'smooth' | undefined,
        cullHidden: has('--cull-hidden') || undefined,
      });
      console.log(source);
      for (const w of r.warnings ?? []) console.log(`⚠ ${w}`);
      const tr = (v: number) => v.toLocaleString('tr-TR');
      const repair = r.added ? `, birleşim çizgisi onarımı ${tr(r.added)} ekledi` : '';
      const culled = r.culled !== undefined ? `; ${tr(r.culled)} gizli üçgen atıldı${repair}, ${tr(r.triangles!)} üçgen kaldı` : '';
      console.log(`✓ ${r.parts} parça${has('--merge') ? ' birleştirildi (tek gövde)' : ''} → ${r.file} (${r.format.toUpperCase()}, ${kb(r.bytes)}${culled})`);
      return;
    }
    case 'run': {
      const [script, ...args] = rest;
      if (!script) throw new Error('Betik gerekli: p3d run <betik.mts|ts|mjs|js> [arg…]');
      const abs = fromCaller(script);
      const st = statOf(abs);
      if (!st?.isFile()) throw new Error(`Betik bulunamadı: ${abs}${st?.isDirectory() ? ' (bu bir klasör)' : ''}`);
      // `p3d` paket adı src/api.ts'ye (bin/p3d.mjs zaten kaydettiyse yeniden kaydedilmez; npm run p3d yolunda burada).
      const g = globalThis as { __p3dResolveHook?: boolean };
      if (!g.__p3dResolveHook) {
        const { register } = await import('node:module');
        register(new URL('../bin/p3d-resolve.mjs', import.meta.url));
        g.__p3dResolveHook = true;
      }
      // Betik, komutun yazıldığı klasörde çalışır (npm run p3d depo kökünde başlatır).
      if (!samePath(process.cwd(), callerDir)) process.chdir(callerDir);
      process.argv = [process.argv[0], abs, ...args];
      try {
        await import(pathToFileURL(abs).href);
      } catch (e) {
        throw new ScriptError(e);
      }
      return;
    }
    case 'guide': {
      const { guideText } = await import('./guide.ts');
      const r = guideText(positionals()[0]);
      console.log(r.text);
      if (!r.ok) process.exitCode = 1;
      return;
    }
    case 'dev': {
      // Sunucuyu hangi klasörden çağrılırsa çağrılsın P3D deposunda başlatır (npm run dev; bayraklar aynen geçer).
      const detach = rest.includes('--detach');
      const flags = rest.filter((a) => a !== '--detach');
      if (!flags.some((a) => a.startsWith('--port'))) {
        const up = await fetch(base + '/api/status').then(() => true, () => false);
        if (up) {
          console.log(`P3D sunucusu zaten çalışıyor: ${base}`);
          return;
        }
      }
      // Başlatıcı `--port=5198` biçimini ister; `--port 5198` de kabul edilsin.
      const VALUE_FLAGS = ['--port', '--host', '--llm', '--model', '--effort', '--claude-bin'];
      const args: string[] = [];
      for (let i = 0; i < flags.length; i++) args.push(VALUE_FLAGS.includes(flags[i]) && i + 1 < flags.length ? `${flags[i]}=${flags[++i]}` : flags[i]);
      if (detach) {
        const { devPort, p3dAt, startDetached } = await import('./devserver.ts');
        const port = devPort(flags, base);
        if (await p3dAt(port)) {
          console.log(`P3D sunucusu zaten çalışıyor: http://localhost:${port}`);
          return;
        }
        console.log(`P3D sunucusu ayrık başlatılıyor (${REPO_ROOT}): npm run dev${args.length ? ' -- ' + args.join(' ') : ''}`);
        const st = await startDetached(REPO_ROOT, args, port);
        console.log(`✓ Çalışıyor: ${st.url} (pid ${st.pid}). Günlük: ${st.log}
  Durdurmak için: p3d stop${port !== 5173 ? ` --port ${port}` : ''}`);
        return;
      }
      console.log(`P3D sunucusu başlatılıyor (${REPO_ROOT}): npm run dev${args.length ? ' -- ' + args.join(' ') : ''}`);
      const win = process.platform === 'win32';
      const child = spawn(win ? 'npm.cmd' : 'npm', ['run', 'dev', ...(args.length ? ['--', ...args] : [])], { cwd: REPO_ROOT, stdio: 'inherit', shell: win });
      await new Promise<void>((resolve) => child.on('exit', (code) => {
        process.exitCode = code ?? 0;
        resolve();
      }));
      return;
    }
    case 'stop': {
      const { devPort, stopServer } = await import('./devserver.ts');
      const port = devPort(rest, base);
      const r = await stopServer(port);
      if (r.stopped) console.log(`✓ P3D sunucusu durduruldu (port ${port}; süreç ${r.pids.join(', ')}).`);
      else if (r.reason === 'not-running') console.log(`Portta (${port}) çalışan P3D sunucusu yok.`);
      else {
        process.exitCode = 1;
        console.error(
          r.reason === 'not-p3d-pid'
            ? `Hata: port ${port}'te P3D yanıt veriyor ama dinleyen süreç bulunamadı; elle durdurun.`
            : `Hata: süreç ${r.pids.join(', ')} kapatıldı ama port ${port} hâlâ yanıt veriyor.`,
        );
      }
      return;
    }
    case 'skill': {
      if (rest[0] !== 'install') throw new Error('Kullanım: p3d skill install');
      const { installSkill } = await import('./guide.ts');
      const r = installSkill();
      console.log(
        r.status === 'kuruldu'
          ? `✓ Skill kuruldu: ${r.dest}`
          : r.status === 'güncellendi'
            ? `✓ Skill güncellendi (mevcut dosyanın üzerine yazıldı; önceki içerik yedeklendi: ${r.backup}): ${r.dest}`
            : `✓ Skill zaten güncel (aynı içerik, yazılmadı): ${r.dest}`,
      );
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e: Error) => {
  if (e instanceof ScriptError) console.error(e.original);
  else console.error(`Hata: ${e.message}`);
  process.exitCode = 1;
});
