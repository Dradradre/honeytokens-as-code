import fs from 'node:fs';
import path from 'node:path';
import { describePlacements, placementFile } from './core/format.ts';
import { lineHasTrap } from './core/match.ts';
import { generateTrap, type TrapOptions } from './core/trap.ts';
import type { Alert, Placement, Trap, TrapStatus } from './core/types.ts';
import { defaultHome, readAlerts, readRegistry, updateRegistry, type Registry } from './store.ts';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';

export interface ServiceOptions {
  /** Data directory. Default HONEYTOKEN_HOME or ~/.honeytoken */
  home?: string;
  /** Alert server URL. Default HONEYTOKEN_BASE_URL. Never taken from an agent. */
  baseUrl?: string;
  /** Where relative file paths resolve from. Default process.cwd() */
  cwd?: string;
}

export interface IssuedTrap {
  id: string;
  url: string;
  token: string;
  warning?: string;
}

/** What callers get back when listing: everything but the token. */
export interface TrapView {
  id: string;
  label: string;
  status: TrapStatus;
  url: string;
  createdAt: string;
  retiredAt?: string;
  plantedIn: string[];
}

export interface CleanResult {
  id: string;
  label: string;
  /** Lines removed (or that would be on a dry run), per file. */
  removed: { file: string; lines: number[] }[];
  /** Recorded files that no longer exist. */
  missing: string[];
  /** Recorded files that now resolve outside their repository (a symlink appeared); left untouched. */
  refused: string[];
  /** The trap was never planted, so it was deleted instead of retired. */
  forgotten: boolean;
}

export type Service = ReturnType<typeof createService>;

/**
 * The one API the CLI and the MCP server call. Every rule (who picks the alert host,
 * what counts as planted, what cleaning means) lives here so the two can't drift apart.
 */
export function createService(opts: ServiceOptions = {}) {
  const home = opts.home ?? defaultHome();
  const baseUrl = opts.baseUrl ?? process.env.HONEYTOKEN_BASE_URL;
  const cwd = () => opts.cwd ?? process.cwd();

  return {
    home,

    issue(trapOpts: Omit<TrapOptions, 'baseUrl'>): IssuedTrap {
      const trap = generateTrap({ ...trapOpts, baseUrl: baseUrl ?? DEFAULT_BASE_URL });
      updateRegistry(home, (registry) => void registry.traps.push(trap));
      return {
        id: trap.id,
        url: trap.url,
        token: trap.token,
        ...(baseUrl
          ? {}
          : { warning: `HONEYTOKEN_BASE_URL is not set, so the trap points at ${DEFAULT_BASE_URL} and only fires on this machine.` }),
      };
    },

    /**
     * Record where a trap was planted. The lines are found by reading the file, not taken
     * from the caller, so the registry never points at a line that does not hold the trap.
     * Registering a file again replaces that file's placements with what is there now.
     *
     * The repo is found from the file itself, not from the working directory, because MCP
     * clients don't all start servers inside the project.
     */
    register(id: string, file: string, line?: number): Placement[] {
      const { repo, rel, real } = resolvePlantedFile(path.resolve(cwd(), file), file);

      return updateRegistry(home, (registry) => {
        const trap = findTrap(registry, id);
        if (trap.status === 'retired') throw new Error(`trap ${id} is retired; issue a new one`);

        const hits = linesWithTrap(real, trap);
        if (hits.length === 0) throw new Error(`trap ${id} not found in ${rel}; plant it before registering`);
        if (line !== undefined && !hits.includes(line)) {
          throw new Error(`line ${line} of ${rel} does not hold trap ${id} (found on line ${hits.join(', ')})`);
        }

        const now = new Date().toISOString();
        const sameFile = (p: Placement) => p.repo === repo && p.file === rel;
        const current = hits.map(
          (n) => trap.placements.find((p) => sameFile(p) && p.line === n) ?? { repo, file: rel, line: n, plantedAt: now },
        );
        trap.placements = [...trap.placements.filter((p) => !sameFile(p)), ...current];
        return current;
      });
    },

    list({ includeRetired = false } = {}): TrapView[] {
      return readRegistry(home)
        .traps.filter((t) => includeRetired || t.status === 'active')
        .map((t) => ({
          id: t.id,
          label: t.label,
          status: t.status,
          url: t.url,
          createdAt: t.createdAt,
          ...(t.retiredAt ? { retiredAt: t.retiredAt } : {}),
          plantedIn: describePlacements(t.placements),
        }));
    },

    /**
     * Delete every line holding the traps from their recorded files and retire the traps.
     * Retired traps stay in the registry and keep alerting: the decoy lives on in git history
     * and in every clone made before the cleanup. A trap that was never planted never left this
     * machine, so it is deleted outright.
     */
    clean(ids: string[] | 'all', { dryRun = false } = {}): CleanResult[] {
      const run = (registry: Registry) => {
        const targets = ids === 'all' ? registry.traps.filter((t) => t.status === 'active') : ids.map((id) => findTrap(registry, id));
        const now = new Date().toISOString();
        const results = targets.map((trap) => {
          const result = removeFromFiles(trap, dryRun);
          if (!dryRun && !result.forgotten && trap.status === 'active') {
            trap.status = 'retired';
            trap.retiredAt = now;
          }
          return result;
        });
        if (!dryRun) {
          const forgotten = new Set(results.filter((r) => r.forgotten).map((r) => r.id));
          registry.traps = registry.traps.filter((t) => !forgotten.has(t.id));
        }
        return results;
      };
      return dryRun ? run(readRegistry(home)) : updateRegistry(home, run);
    },

    alerts(limit = 20): Alert[] {
      return readAlerts(home, limit);
    },
  };
}

/**
 * Where a planted file really lives. It must be a regular file inside a git repository,
 * outside `.git/`, and must not reach outside that repository through a symlink: `clean`
 * writes to these files later, so a link to ~/.bashrc must never get on the record.
 */
function resolvePlantedFile(abs: string, shown: string): { repo: string; rel: string; real: string } {
  if (!fs.existsSync(abs)) throw new Error(`${shown} does not exist`);
  const gitRoot = findGitRoot(path.dirname(abs));
  if (!gitRoot) throw new Error(`${shown} is not inside a git repository`);

  const repo = fs.realpathSync(gitRoot);
  const real = fs.realpathSync(abs);
  const rel = relativeInside(repo, real);
  if (rel === undefined) throw new Error(`${shown} resolves outside ${repo} through a symlink`);
  if (rel.split(path.sep)[0] === '.git') throw new Error(`${shown} is inside .git`);
  if (!fs.statSync(real).isFile()) throw new Error(`${shown} is not a regular file`);
  return { repo, rel, real };
}

/** `child` relative to `parent`, or undefined when it is not strictly inside. */
function relativeInside(parent: string, child: string): string | undefined {
  const rel = path.relative(parent, child);
  return rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? undefined : rel;
}

function findTrap(registry: Registry, id: string): Trap {
  const trap = registry.traps.find((t) => t.id === id);
  if (!trap) throw new Error(`no trap with id ${id}`);
  return trap;
}

function linesWithTrap(file: string, trap: Trap): number[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((text, i) => (lineHasTrap(text, trap) ? [i + 1] : []));
}

function removeFromFiles(trap: Trap, dryRun: boolean): CleanResult {
  const result: CleanResult = {
    id: trap.id,
    label: trap.label,
    removed: [],
    missing: [],
    refused: [],
    forgotten: trap.placements.length === 0,
  };
  const files = new Map(trap.placements.map((p) => [path.join(p.repo, p.file), p]));

  for (const [abs, placement] of files) {
    const shown = placementFile(placement);
    if (!fs.existsSync(abs)) {
      result.missing.push(shown);
      continue;
    }
    // Checked again at write time: the file may have been swapped for a symlink since it was registered.
    const real = fs.realpathSync(abs);
    if (relativeInside(fs.realpathSync(placement.repo), real) === undefined) {
      result.refused.push(shown);
      continue;
    }
    const lines = fs.readFileSync(real, 'utf8').split('\n');
    const removed = lines.flatMap((text, i) => (lineHasTrap(text, trap) ? [i + 1] : []));
    if (removed.length === 0) continue;
    result.removed.push({ file: shown, lines: removed });
    if (!dryRun) fs.writeFileSync(real, lines.filter((text) => !lineHasTrap(text, trap)).join('\n'));
  }
  return result;
}

/** Nearest directory at or above `start` with a .git entry (directory, or file for worktrees). */
export function findGitRoot(start: string): string | undefined {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}
