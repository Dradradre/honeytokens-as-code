import fs from 'node:fs';
import path from 'node:path';
import type { Placement, Trap } from './trap.ts';

export interface LockFile {
  version: 1;
  traps: Trap[];
}

export interface CleanResult {
  id: string;
  label: string;
  /** Lines removed (or that would be removed on a dry run), per file. */
  removed: { file: string; lines: number[] }[];
  /** Recorded files that no longer exist. */
  missing: string[];
}

export const LOCK_NAME = 'honeytoken.lock';

export function resolveLockPath(explicit?: string): string {
  return path.resolve(explicit ?? process.env.HONEYTOKEN_LOCK ?? LOCK_NAME);
}

export function readLock(lockPath: string): LockFile {
  if (!fs.existsSync(lockPath)) return { version: 1, traps: [] };
  const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (data?.version !== 1 || !Array.isArray(data.traps)) {
    throw new Error(`${lockPath} is not a valid ${LOCK_NAME}`);
  }
  return data as LockFile;
}

export function writeLock(lockPath: string, lock: LockFile): void {
  const isNew = !fs.existsSync(lockPath);
  const tmp = `${lockPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, lockPath);
  if (isNew) excludeFromGit(lockPath);
}

/** A line belongs to a trap if it carries the trap's token or id (the id is part of the URL). */
export function containsTrap(text: string, trap: Trap): boolean {
  return text.includes(trap.token) || text.includes(trap.id);
}

export function addTrap(lockPath: string, trap: Trap): void {
  const lock = readLock(lockPath);
  lock.traps.push(trap);
  writeLock(lockPath, lock);
}

/**
 * Record where a trap was planted. The tool finds the lines itself instead of trusting
 * the caller, so the lock never points at a line that does not hold the trap.
 * Re-registering a file replaces that file's placements with what is there now.
 */
export function registerPlacement(lockPath: string, id: string, file: string, line?: number): Placement[] {
  const root = path.dirname(lockPath);
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${file} is outside ${root}`);
  }
  if (abs === lockPath) throw new Error(`cannot plant a trap in ${LOCK_NAME} itself`);

  const lock = readLock(lockPath);
  const trap = findTrap(lock, id);
  if (!fs.existsSync(abs)) throw new Error(`${rel} does not exist`);

  const hits = fs
    .readFileSync(abs, 'utf8')
    .split('\n')
    .flatMap((text, i) => (containsTrap(text, trap) ? [i + 1] : []));
  if (hits.length === 0) throw new Error(`trap ${id} not found in ${rel}; plant it before registering`);
  if (line !== undefined && !hits.includes(line)) {
    throw new Error(`line ${line} of ${rel} does not hold trap ${id} (found on line ${hits.join(', ')})`);
  }

  const now = new Date().toISOString();
  const previous = trap.placements.filter((p) => p.file === rel);
  const current = hits.map(
    (n) => previous.find((p) => p.line === n) ?? { file: rel, line: n, plantedAt: now },
  );
  trap.placements = [...trap.placements.filter((p) => p.file !== rel), ...current];
  writeLock(lockPath, lock);
  return current;
}

/** Remove every line holding the given traps from their recorded files, then drop the traps from the lock. */
export function cleanTraps(lockPath: string, ids: string[] | 'all', opts: { dryRun?: boolean } = {}): CleanResult[] {
  const root = path.dirname(lockPath);
  const lock = readLock(lockPath);
  const targets = ids === 'all' ? lock.traps : ids.map((id) => findTrap(lock, id));

  const results = targets.map((trap): CleanResult => {
    const result: CleanResult = { id: trap.id, label: trap.label, removed: [], missing: [] };
    for (const file of new Set(trap.placements.map((p) => p.file))) {
      const abs = path.resolve(root, file);
      if (!fs.existsSync(abs)) {
        result.missing.push(file);
        continue;
      }
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const removed = lines.flatMap((text, i) => (containsTrap(text, trap) ? [i + 1] : []));
      if (removed.length === 0) continue;
      result.removed.push({ file, lines: removed });
      if (!opts.dryRun) {
        fs.writeFileSync(abs, lines.filter((text) => !containsTrap(text, trap)).join('\n'));
      }
    }
    return result;
  });

  if (!opts.dryRun) {
    const cleaned = new Set(targets.map((t) => t.id));
    lock.traps = lock.traps.filter((t) => !cleaned.has(t.id));
    writeLock(lockPath, lock);
  }
  return results;
}

function findTrap(lock: LockFile, id: string): Trap {
  const trap = lock.traps.find((t) => t.id === id);
  if (!trap) throw new Error(`no trap with id ${id}`);
  return trap;
}

/**
 * Keep the lock out of git without touching .gitignore: a committed ignore entry would
 * tell anyone reading the repo that honeytokens exist. .git/info/exclude stays local.
 */
function excludeFromGit(lockPath: string): void {
  for (let dir = path.dirname(lockPath); ; dir = path.dirname(dir)) {
    const gitDir = path.join(dir, '.git');
    if (fs.existsSync(gitDir)) {
      if (!fs.statSync(gitDir).isDirectory()) return; // worktree or submodule: leave it to the user
      const exclude = path.join(gitDir, 'info', 'exclude');
      const entry = '/' + path.relative(dir, lockPath).split(path.sep).join('/');
      const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (current.split(/\r?\n/).includes(entry)) return;
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.appendFileSync(exclude, (current && !current.endsWith('\n') ? '\n' : '') + entry + '\n');
      return;
    }
    if (path.dirname(dir) === dir) return;
  }
}
