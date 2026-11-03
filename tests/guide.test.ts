import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Rehber (docs/guide) koddan sessizce geri kalmasın: her işlem tipi ops.md'de, her CLI komutu cli.md'de geçmeli.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** `shared/ops.ts` → `export type Op = …` birleşimindeki `op: '…'` adları. */
function opNames(): string[] {
  const src = read('../shared/ops.ts');
  const union = src.slice(src.indexOf('export type Op ='), src.indexOf('export type OpName'));
  return [...union.matchAll(/op: '([a-z_]+)'/g)].map((m) => m[1]);
}

/** `scripts/p3d.ts` → ana `switch (cmd)` içindeki komutlar. */
function cliCommands(): string[] {
  const src = read('../scripts/p3d.ts');
  const body = src.slice(src.indexOf('switch (cmd) {'));
  return [...body.matchAll(/^ {4}case '([a-z]+)':/gm)].map((m) => m[1]);
}

describe('rehber kapsamı (docs/guide)', () => {
  it('her işlem tipi ops.md tablosunda', () => {
    const names = opNames();
    expect(names.length).toBeGreaterThan(15);
    const doc = read('../docs/guide/ops.md');
    expect(names.filter((n) => !doc.includes(`| \`${n}\``))).toEqual([]);
  });

  it('her CLI komutu cli.md tablosunda', () => {
    const cmds = cliCommands();
    expect(cmds).toContain('apply');
    const rows = read('../docs/guide/cli.md').split('\n').filter((l) => l.startsWith('| `'));
    expect(cmds.filter((c) => !rows.some((r) => new RegExp(`\`${c}[\` ]`).test(r)))).toEqual([]);
  });

  it('skill ve index yalnızca var olan konulara yönlendirir', () => {
    const topics = ['cli', 'ops', 'modeling', 'verify', 'ambiguity', 'workspaces', 'scripts', 'game'];
    for (const t of topics) expect(() => read(`../docs/guide/${t}.md`)).not.toThrow();
    const index = read('../docs/guide/index.md');
    for (const t of topics) expect(index).toContain(`| \`${t}\``);
    const skill = read('../tools/skill/p3d/SKILL.md');
    for (const m of skill.matchAll(/p3d guide ([a-z]+)/g)) expect(topics).toContain(m[1]);
    // Skill kaynağında makineye özgü yol olmaz: depo yolu kurulurken {{P3D_DIR}} yerine yazılır.
    expect(skill).toContain('{{P3D_DIR}}');
    expect(skill).not.toMatch(/[A-Za-z]:[\\/]Users|\/home\/|\/Users\//);
  });
});
