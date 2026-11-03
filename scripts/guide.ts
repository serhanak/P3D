// `p3d guide [konu]` ve `p3d skill install` (scripts/p3d.ts kullanır; ayrı modül ki testler içe aktarabilsin).
// Rehber depodadır (docs/guide/*.md) ve kurulu sürümle eşleşir; kullanıcı düzeyindeki skill (tools/skill/p3d/SKILL.md)
// incedir ve rehbere yönlendirir (docs/EXTERNAL-USE.md → İlkeler 4).
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
export const GUIDE_DIR = path.join(REPO, 'docs', 'guide');
export const SKILL_SOURCE = path.join(REPO, 'tools', 'skill', 'p3d', 'SKILL.md');

function readIfFile(file: string): string | null {
  try {
    return statSync(file).isFile() ? readFileSync(file, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Rehber konuları: klasördeki .md dosyalarının adları (index hariç), sıralı. */
export function guideTopics(dir = GUIDE_DIR): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'index.md')
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export interface GuideOutput {
  text: string;
  /** false: bilinmeyen konu (çıkış kodu 1). */
  ok: boolean;
}

/** Konu yoksa index.md + konu listesi; konu varsa `<konu>.md`; bilinmeyen konuda liste ve ok = false. */
export function guideText(topic: string | undefined, dir = GUIDE_DIR): GuideOutput {
  const topics = guideTopics(dir);
  const listing = topics.length ? `Konular: ${topics.join(', ')}  →  p3d guide <konu>` : `Rehberde konu yok (${dir}).`;
  if (!topic) {
    const index = readIfFile(path.join(dir, 'index.md'));
    return { text: `${index ? index.trimEnd() : `(${path.join(dir, 'index.md')} yok)`}\n\n${listing}`, ok: true };
  }
  const want = topic.replace(/\.md$/i, '').toLowerCase();
  const name = want === 'index' ? 'index' : topics.find((t) => t.toLowerCase() === want);
  const text = name ? readIfFile(path.join(dir, `${name}.md`)) : null;
  if (text === null) return { text: `Bilinmeyen konu: '${topic}'.\n${listing}`, ok: false };
  return { text: text.trimEnd(), ok: true };
}

export interface SkillInstall {
  /** Yazılan dosya. */
  dest: string;
  /** kuruldu: yeni · güncellendi: önceki dosyanın üzerine yazıldı · aynı: içerik zaten aynıydı (yazılmadı). */
  status: 'kuruldu' | 'güncellendi' | 'aynı';
  /** güncellendi: önceki içeriğin yedeği (`SKILL.md.bak`; varsa üzerine yazılır). */
  backup?: string;
}

/** Skills klasörü: P3D_SKILLS_DIR (sınama için) > ~/.claude/skills. */
export function skillsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.P3D_SKILLS_DIR ? path.resolve(env.P3D_SKILLS_DIR) : path.join(homedir(), '.claude', 'skills');
}

/** Skill kaynağındaki yer tutucu: kurulurken bu makinedeki P3D deposunun yoluyla değiştirilir (sabit yol yok). */
export const P3D_DIR_TOKEN = '{{P3D_DIR}}';

/** Kaynak metindeki `{{P3D_DIR}}` → depo yolu (sondaki ayraçsız). */
export function renderSkill(text: string, repo: string = REPO): string {
  return text.split(P3D_DIR_TOKEN).join(path.resolve(repo));
}

/** Kurulması gereken skill metni (yer tutucu doldurulmuş). */
function skillText(source: string, repo: string): string {
  const text = readIfFile(source);
  if (text === null) throw new Error(`Skill kaynağı bulunamadı: ${source}`);
  return renderSkill(text, repo);
}

export interface SkillState {
  dest: string;
  /** güncel: kurulu = kaynak · eski: farklı (P3D güncellenmiş ya da elle düzenlenmiş) · yok: kurulu değil. */
  state: 'güncel' | 'eski' | 'yok';
}

/** Kurulu skill'in depodaki kaynakla karşılaştırması (`p3d status` uyarısı için). */
export function skillState(dir = skillsDir(), source = SKILL_SOURCE, repo: string = REPO): SkillState {
  const dest = path.join(dir, 'p3d', 'SKILL.md');
  const installed = readIfFile(dest);
  if (installed === null) return { dest, state: 'yok' };
  return { dest, state: installed === skillText(source, repo) ? 'güncel' : 'eski' };
}

/**
 * SKILL.md'yi `<skills>/p3d/SKILL.md`'ye kurar (klasörü oluşturur; `{{P3D_DIR}}` bu deponun yoluyla doldurulur). Hedef
 * farklı içerikle varsa (kullanıcı elle düzenlemiş olabilir) önce `SKILL.md.bak`'a yedeklenir.
 */
export function installSkill(dir = skillsDir(), source = SKILL_SOURCE, repo: string = REPO): SkillInstall {
  const text = skillText(source, repo);
  const dest = path.join(dir, 'p3d', 'SKILL.md');
  const before = readIfFile(dest);
  if (before === text) return { dest, status: 'aynı' };
  mkdirSync(path.dirname(dest), { recursive: true });
  if (before === null) {
    writeFileSync(dest, text);
    return { dest, status: 'kuruldu' };
  }
  const backup = `${dest}.bak`;
  writeFileSync(backup, before);
  writeFileSync(dest, text);
  return { dest, status: 'güncellendi', backup };
}
