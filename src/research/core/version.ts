import fs from 'node:fs';
import path from 'node:path';

/**
 * The code version that research records carry: `RESEARCH_CODE_VERSION` if set (CI, containers), else the git commit
 * read straight from `.git` (no git binary needed), else 'unknown'. Uncommitted changes are not detected: run
 * experiments that matter from a committed tree.
 */
export function codeVersion(repoDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.RESEARCH_CODE_VERSION?.trim()) return env.RESEARCH_CODE_VERSION.trim();
  try {
    let gitDir = path.join(repoDir, '.git');
    if (fs.statSync(gitDir).isFile()) gitDir = path.resolve(repoDir, fs.readFileSync(gitDir, 'utf8').replace(/^gitdir:\s*/, '').trim());
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref:')) return head.slice(0, 12);
    const ref = head.slice(4).trim();
    const loose = path.join(gitDir, ref);
    if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim().slice(0, 12);
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8').split('\n').find(l => l.endsWith(` ${ref}`));
    return packed ? packed.slice(0, 12) : 'unknown';
  } catch { return 'unknown'; }
}
