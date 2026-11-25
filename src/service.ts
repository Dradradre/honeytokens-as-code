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
  /** Where relative file paths resolve from and the repo is looked up. Default process.cwd() */
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
     */
    register(id: string, file: string, line?: number): Placement[] {
      const repo = findRepoRoot(cwd());
      const abs = path.resolve(cwd(), file);
      const rel = path.relative(repo, abs);
      if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        throw new Error(`${file} is outside the repository at ${repo}`);
      }
      if (!fs.existsSync(abs)) throw new Error(`${rel} does not exist`);

      return updateRegistry(home, (registry) => {
        const trap = findTrap(registry, id);
        if (trap.status === 'retired') throw new Error(`trap ${id} is retired; issue a new one`);

        const hits = linesWithTrap(abs, trap);
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
     * and in every clone made before the cleanup.
     */
    clean(ids: string[] | 'all', { dryRun = false } = {}): CleanResult[] {
      const run = (registry: Registry) => {
        const targets = ids === 'all' ? registry.traps.filter((t) => t.status === 'active') : ids.map((id) => findTrap(registry, id));
        const now = new Date().toISOString();
        return targets.map((trap) => {
          const result = removeFromFiles(trap, dryRun);
          if (!dryRun && trap.status === 'active') {
            trap.status = 'retired';
            trap.retiredAt = now;
          }
          return result;
        });
      };
      return dryRun ? run(readRegistry(home)) : updateRegistry(home, run);
    },

    alerts(limit = 20): Alert[] {
      return readAlerts(home, limit);
    },
  };
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
  const result: CleanResult = { id: trap.id, label: trap.label, removed: [], missing: [] };
  const files = new Map(trap.placements.map((p) => [path.join(p.repo, p.file), p]));

  for (const [abs, placement] of files) {
    const shown = placementFile(placement);
    if (!fs.existsSync(abs)) {
      result.missing.push(shown);
      continue;
    }
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const removed = lines.flatMap((text, i) => (lineHasTrap(text, trap) ? [i + 1] : []));
    if (removed.length === 0) continue;
    result.removed.push({ file: shown, lines: removed });
    if (!dryRun) fs.writeFileSync(abs, lines.filter((text) => !lineHasTrap(text, trap)).join('\n'));
  }
  return result;
}

/** Nearest directory with a .git entry (directory, or file for worktrees), else `start` itself. */
export function findRepoRoot(start: string): string {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(start);
  }
}
