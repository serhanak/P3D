// Claude Code köprüsü için komut satırı aracı (bkz. server/bridge.ts). Açık tarayıcı sayfasının sahnesini
// okur, ona işlem gönderir, görüntüsünü alır; ölçüm ve kesitleri uygulamanın aynı motoruyla Node'da hesaplar.
// Geliştirme sunucusu (npm run dev) ve uygulama sekmesi açık olmalıdır (section --file hariç).
//
//   npm run -s p3d -- scene [--full]                 sahne özeti (--full: tüm proje JSON'u)
//   npm run -s p3d -- ops [--label "metin"]          stdin'den Op[] JSON'u (ya da {"ops": [...]}) uygular
//   npm run -s p3d -- undo | redo | fit
//   npm run -s p3d -- snapshot [--views iso,front,right,top] [--size 1000x750] [--dims] [--out klasör]
//   npm run -s p3d -- import <dosya.stl|obj|3mf> [--name ad] [--role solid|hole|reference] [--color #hex]
//                           [--max-tris 60000] [--keep-position]
//   npm run -s p3d -- measure [--parts a,b]
//   npm run -s p3d -- check                         z-fighting, boolean hataları, ince parça, tabla teması
//   npm run -s p3d -- section --axis x|y|z --at v1,v2,… [--parts a,b] [--file dosya.stl] [--tol 0.1]
//
// Adres: P3D_URL (varsayılan http://localhost:5173).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BridgeResult, Op, Pt2, SceneSummary, SceneSummaryPart, SnapshotView } from '../shared/ops.ts';

const base = (process.env.P3D_URL || 'http://localhost:5173').replace(/\/$/, '');
const [cmd, ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}
const has = (name: string) => rest.includes(name);
const list = (name: string) => flag(name)?.split(',').map((s) => s.trim()).filter(Boolean);

async function call(method: string, p: string, body?: unknown): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(base + p, {
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
    case 'scene': {
      const full = has('--full');
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
    case 'snapshot': {
      const [w, h] = (flag('--size') ?? '1000x750').split('x').map(Number);
      const views = (list('--views') ?? ['iso', 'front', 'right', 'top']) as SnapshotView[];
      const r = (await call('POST', '/api/bridge/ops', { action: 'snapshot', snapshot: { views, width: w, height: h, dims: has('--dims') } })) as BridgeResult;
      const out = path.resolve(flag('--out') ?? path.join(tmpdir(), 'p3d-snapshots'));
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
      const file = rest[0];
      if (!file || file.startsWith('--')) throw new Error('Dosya yolu gerekli: import <dosya.stl|obj|3mf>');
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
      printResult((await call('POST', '/api/bridge/ops', { ops: [op], label: flag('--label') ?? `İçe aktar: ${path.basename(file)}` })) as BridgeResult);
      return;
    }
    case 'check': {
      const { initCsg } = await import('../src/csg.ts');
      await initCsg();
      const r = (await call('GET', '/api/bridge/scene?full')) as { scene: unknown };
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
      const fileArg = flag('--file');
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
      const r = (await call('GET', '/api/bridge/scene?full')) as { scene: unknown };
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
          'Kullanım: npm run -s p3d -- <komut>',
          '  scene [--full] · ops [--label "metin"] < ops.json · undo · redo · fit',
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
