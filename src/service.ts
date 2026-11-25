import fs from 'node:fs';
import path from 'node:path';
import { awsCli, awsTrapStatus, deleteAwsTrap, issueAwsTrap, rotateAwsKey, type AwsRunner, type AwsTrapStatus } from './aws.ts';
import { describePlacements, placementFile } from './core/format.ts';
import { lineHasTrap } from './core/match.ts';
import { generateWebhookTrap, type TrapOptions } from './core/trap.ts';
import type { Alert, Placement, Trap, TrapStatus, WebhookTrap } from './core/types.ts';
import { defaultHome, readAlerts, readRegistry, updateRegistry, type Registry } from './store.ts';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
export const DEFAULT_MAX_AGE_DAYS = 180;

export interface ServiceOptions {
  /** Data directory. Default HONEYTOKEN_HOME or ~/.honeytoken */
  home?: string;
  /** Alert server URL. Default HONEYTOKEN_BASE_URL. Never taken from an agent. */
  baseUrl?: string;
  /** Where relative file paths resolve from. Default process.cwd() */
  cwd?: string;
  /** How AWS is reached. Default: the `aws` CLI with the user's own profile. */
  aws?: AwsRunner;
}

export interface IssuedWebhookTrap {
  id: string;
  url: string;
  token: string;
  warning?: string;
}

export interface IssuedAwsTrap {
  id: string;
  accessKeyId: string;
  secretAccessKey: string;
  userName: string;
  accountId: string;
}

/** What callers get back when listing: everything but secrets. */
export interface TrapView {
  id: string;
  kind: Trap['kind'];
  label: string;
  status: TrapStatus;
  /** Webhook: the trap URL. AWS: the IAM user and account. */
  target: string;
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
  /** The trap was never planted, so it was deleted (with its AWS key) instead of retired. */
  forgotten: boolean;
}

export type PlacementState = 'ok' | 'moved' | 'gone' | 'missing' | 'refused';

export interface CheckResult {
  id: string;
  kind: Trap['kind'];
  label: string;
  ageDays: number;
  rotationDue: boolean;
  /** Per planted file: still there (`ok`), on other lines now (`moved`), deleted from the file (`gone`), file gone (`missing`). */
  files: { file: string; state: PlacementState; lines: number[] }[];
  aws?: AwsTrapStatus | { error: string };
  /** True when anything above needs a human: lost placements, an unplanted trap, a broken AWS key. */
  needsAttention: boolean;
}

export interface RotateResult {
  oldId: string;
  newId: string;
  files: { file: string; lines: number[] }[];
  missing: string[];
  refused: string[];
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
  const aws = opts.aws ?? awsCli();

  return {
    home,

    issue(trapOpts: Omit<TrapOptions, 'baseUrl'>): IssuedWebhookTrap {
      const trap = generateWebhookTrap({ ...trapOpts, baseUrl: baseUrl ?? DEFAULT_BASE_URL });
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

    /** Create a real, powerless IAM user and access key in the account the AWS CLI is signed in to. */
    async issueAws(awsOpts: { userName: string; label?: string }): Promise<IssuedAwsTrap> {
      const trap = await issueAwsTrap(aws, awsOpts);
      updateRegistry(home, (registry) => void registry.traps.push(trap));
      const { id, accessKeyId, secretAccessKey, userName, accountId } = trap;
      return { id, accessKeyId, secretAccessKey, userName, accountId };
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
        return setPlacements(trap, repo, rel, hits);
      });
    },

    list({ includeRetired = false } = {}): TrapView[] {
      return readRegistry(home)
        .traps.filter((t) => includeRetired || t.status === 'active')
        .map((t) => ({
          id: t.id,
          kind: t.kind,
          label: t.label,
          status: t.status,
          target: t.kind === 'webhook' ? t.url : `IAM user ${t.userName} in AWS account ${t.accountId}`,
          createdAt: t.createdAt,
          ...(t.retiredAt ? { retiredAt: t.retiredAt } : {}),
          plantedIn: describePlacements(t.placements),
        }));
    },

    /**
     * Delete every line holding the traps from their recorded files and retire the traps.
     * Retired traps stay in the registry and keep alerting: the decoy lives on in git history
     * and in every clone made before the cleanup. A trap that was never planted never left this
     * machine, so it is deleted outright, AWS key included.
     */
    async clean(ids: string[] | 'all', { dryRun = false } = {}): Promise<CleanResult[]> {
      const registry = readRegistry(home);
      const targets = ids === 'all' ? registry.traps.filter((t) => t.status === 'active') : ids.map((id) => findTrap(registry, id));
      if (dryRun) return targets.map((trap) => removeFromFiles(trap, true));

      // Cloud resources go first and outside the lock: if AWS refuses, nothing local has changed.
      for (const trap of targets) {
        if (trap.kind === 'aws' && trap.placements.length === 0) {
          const shared = registry.traps.some((t) => t !== trap && t.kind === 'aws' && t.userName === trap.userName);
          await deleteAwsTrap(aws, trap, { deleteUser: !shared });
        }
      }

      return updateRegistry(home, (current) => {
        const now = new Date().toISOString();
        const results = targets.map((target) => {
          const trap = findTrap(current, target.id);
          const result = removeFromFiles(trap, false);
          if (!result.forgotten && trap.status === 'active') {
            trap.status = 'retired';
            trap.retiredAt = now;
          }
          return result;
        });
        const forgotten = new Set(results.filter((r) => r.forgotten).map((r) => r.id));
        current.traps = current.traps.filter((t) => !forgotten.has(t.id));
        return results;
      });
    },

    /**
     * Review active traps: are they still where the registry says, are they old enough to
     * rotate, and (for AWS) is the key still there and still locked down?
     */
    async check({ maxAgeDays = DEFAULT_MAX_AGE_DAYS, skipAws = false } = {}): Promise<CheckResult[]> {
      const now = Date.now();
      return Promise.all(
        readRegistry(home)
          .traps.filter((t) => t.status === 'active')
          .map(async (trap) => {
            const ageDays = Math.floor((now - Date.parse(trap.createdAt)) / 86_400_000);
            const files = checkFiles(trap);
            const result: CheckResult = {
              id: trap.id,
              kind: trap.kind,
              label: trap.label,
              ageDays,
              rotationDue: ageDays >= maxAgeDays,
              files,
              needsAttention: files.length === 0 || files.some((f) => f.state !== 'ok' && f.state !== 'moved'),
            };
            if (trap.kind === 'aws' && !skipAws) {
              result.aws = await awsTrapStatus(aws, trap).catch((err: Error) => ({ error: err.message }));
              if ('error' in result.aws || result.aws.key !== 'Active' || !result.aws.denyPolicy) result.needsAttention = true;
            }
            return result;
          }),
      );
    },

    /**
     * Swap a trap for a fresh look-alike in the same spots: same shape (webhook) or same IAM
     * user (AWS), new secret. The old trap is retired, not dropped, so copies taken before the
     * rotation still alert.
     */
    async rotate(id: string): Promise<RotateResult> {
      const old = findTrap(readRegistry(home), id);
      if (old.status === 'retired') throw new Error(`trap ${id} is retired; there is nothing planted to rotate`);
      if (old.placements.length === 0) throw new Error(`trap ${id} was never planted; clean it and issue a new one`);
      const fresh = old.kind === 'webhook' ? rotateWebhook(old, baseUrl) : await rotateAwsKey(aws, old);

      return updateRegistry(home, (registry) => {
        const current = findTrap(registry, id);
        const result: RotateResult = { oldId: id, newId: fresh.id, files: [], missing: [], refused: [] };
        const pairs = replacements(current, fresh);

        for (const [abs, placement] of uniqueFiles(current)) {
          const shown = placementFile(placement);
          const real = safeRealPath(abs, placement.repo);
          if (real === 'missing') result.missing.push(shown);
          else if (real === 'refused') result.refused.push(shown);
          else {
            let text = fs.readFileSync(real, 'utf8');
            for (const [from, to] of pairs) text = text.split(from).join(to);
            fs.writeFileSync(real, text);
            const lines = linesWithTrap(real, fresh);
            setPlacements(fresh, placement.repo, placement.file, lines);
            result.files.push({ file: shown, lines });
          }
        }

        current.status = 'retired';
        current.retiredAt = new Date().toISOString();
        registry.traps.push(fresh);
        return result;
      });
    },

    alerts(limit = 20): Alert[] {
      return readAlerts(home, limit);
    },
  };
}

function rotateWebhook(old: WebhookTrap, baseUrl: string | undefined): WebhookTrap {
  if (!old.spec) throw new Error(`trap ${old.id} predates rotation support; clean it and issue a new one`);
  // Keep the alert host the trap already points at unless a new one is configured.
  const oldBase = old.url.slice(0, old.url.length - `${old.spec.pathPrefix}/${old.id}`.length);
  return generateWebhookTrap({ ...old.spec, label: old.label, baseUrl: baseUrl ?? oldBase, allowProviderPrefix: true });
}

/** Old value -> new value, longest first so a URL is replaced before the id inside it. */
function replacements(old: Trap, fresh: Trap): [string, string][] {
  if (old.kind === 'webhook' && fresh.kind === 'webhook') {
    return [[old.url, fresh.url], [old.token, fresh.token], [old.id, fresh.id]];
  }
  if (old.kind === 'aws' && fresh.kind === 'aws') {
    return [[old.secretAccessKey, fresh.secretAccessKey], [old.accessKeyId, fresh.accessKeyId]];
  }
  throw new Error('cannot rotate across trap kinds');
}

function setPlacements(trap: Trap, repo: string, rel: string, lines: number[]): Placement[] {
  const now = new Date().toISOString();
  const sameFile = (p: Placement) => p.repo === repo && p.file === rel;
  const current = lines.map(
    (n) => trap.placements.find((p) => sameFile(p) && p.line === n) ?? { repo, file: rel, line: n, plantedAt: now },
  );
  trap.placements = [...trap.placements.filter((p) => !sameFile(p)), ...current];
  return current;
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

/** The real path of a recorded file, re-checked at write time: it may have been swapped for a symlink since. */
function safeRealPath(abs: string, repo: string): string | 'missing' | 'refused' {
  if (!fs.existsSync(abs)) return 'missing';
  const real = fs.realpathSync(abs);
  return relativeInside(fs.realpathSync(repo), real) === undefined ? 'refused' : real;
}

function uniqueFiles(trap: Trap): Map<string, Placement> {
  return new Map(trap.placements.map((p) => [path.join(p.repo, p.file), p]));
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

function checkFiles(trap: Trap): CheckResult['files'] {
  return [...uniqueFiles(trap)].map(([abs, placement]) => {
    const file = placementFile(placement);
    const real = safeRealPath(abs, placement.repo);
    if (real === 'missing' || real === 'refused') return { file, state: real, lines: [] };
    const lines = linesWithTrap(real, trap);
    const recorded = trap.placements.filter((p) => p.repo === placement.repo && p.file === placement.file).map((p) => p.line);
    const state: PlacementState =
      lines.length === 0 ? 'gone' : lines.join() === recorded.sort((a, b) => a - b).join() ? 'ok' : 'moved';
    return { file, state, lines };
  });
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

  for (const [abs, placement] of uniqueFiles(trap)) {
    const shown = placementFile(placement);
    const real = safeRealPath(abs, placement.repo);
    if (real === 'missing') result.missing.push(shown);
    else if (real === 'refused') result.refused.push(shown);
    else {
      const lines = fs.readFileSync(real, 'utf8').split('\n');
      const removed = lines.flatMap((text, i) => (lineHasTrap(text, trap) ? [i + 1] : []));
      if (removed.length === 0) continue;
      result.removed.push({ file: shown, lines: removed });
      if (!dryRun) fs.writeFileSync(real, lines.filter((text) => !lineHasTrap(text, trap)).join('\n'));
    }
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

