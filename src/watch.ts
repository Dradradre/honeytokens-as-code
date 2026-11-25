import { listRegions, pollCloudTrail, type AwsRunner, type CloudTrailCursor, type WatchedAwsTrap } from './aws.ts';
import type { Alert } from './core/types.ts';
import { readRegistry, readState, writeState } from './store.ts';

/**
 * Watching AWS traps needs no server: poll CloudTrail, alert, remember where we stopped.
 * `serve` runs this on a timer next to the webhook listener; `watch --once` runs it once,
 * e.g. from a scheduled GitHub Actions job, with a watchlist instead of the full registry.
 */

export type { WatchedAwsTrap };

export const CURSOR_FILE = 'cloudtrail.json';

/** AWS traps from the registry, secrets dropped. Active and retired: both are still bait. */
export function watchlistFromRegistry(home: string): WatchedAwsTrap[] {
  return readRegistry(home).traps.flatMap((t) => {
    if (t.kind !== 'aws') return [];
    const { secretAccessKey: _secret, ...watched } = t;
    return [watched];
  });
}

/** Read a watchlist exported with `honeytoken watchlist`. Secret keys are dropped if present. */
export function parseWatchlist(json: string): WatchedAwsTrap[] {
  const data = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('watchlist must be a JSON array');
  return data.map((entry, i) => {
    const ok =
      entry?.kind === 'aws' &&
      typeof entry.id === 'string' &&
      /^A[A-Z0-9]{15,127}$/.test(entry.accessKeyId ?? '') &&
      (entry.status === 'active' || entry.status === 'retired') &&
      Array.isArray(entry.placements);
    if (!ok) throw new Error(`watchlist entry ${i} is not an AWS trap from \`honeytoken watchlist\``);
    const { secretAccessKey: _secret, ...watched } = entry;
    return { label: '', userName: '', accountId: '', createdAt: new Date(0).toISOString(), ...watched } as WatchedAwsTrap;
  });
}

export interface PollOnceResult {
  alerts: Alert[];
  errors: string[];
  /** Regions searched; undefined when listing them failed and we fell back to us-east-1. */
  regions?: string[];
}

/** One pass: resolve regions if needed, search CloudTrail, save the cursor. Never throws for AWS errors. */
export async function pollOnce(o: {
  home: string;
  aws: AwsRunner;
  traps: WatchedAwsTrap[];
  regions?: string[];
}): Promise<PollOnceResult> {
  if (o.traps.length === 0) return { alerts: [], errors: [], regions: o.regions };
  const errors: string[] = [];
  let listed = o.regions;
  if (!listed) {
    listed = await listRegions(o.aws).catch((err: Error) => {
      errors.push(`regions: ${err.message}; searched us-east-1 only`);
      return undefined;
    });
  }
  const earliest = o.traps.map((t) => t.createdAt).sort()[0]!;
  const cursor = readState<CloudTrailCursor>(o.home, CURSOR_FILE, { since: earliest, seen: {} });
  const result = await pollCloudTrail(o.aws, listed ?? ['us-east-1'], o.traps, cursor);
  writeState(o.home, CURSOR_FILE, result.cursor);
  // Oldest first: CloudTrail returns newest first and regions answer in any order, and the
  // dispatcher's cooldown and summaries assume hits arrive in the order they happened.
  const alerts = [...result.alerts].sort((a, b) => a.at.localeCompare(b.at));
  return { alerts, errors: [...errors, ...result.errors], regions: listed };
}

/** Poll on a timer until stopped. Traps are re-read every pass, so new ones are picked up. */
export function watchLoop(o: {
  home: string;
  aws: AwsRunner;
  intervalMs: number;
  regions?: string[];
  traps: () => WatchedAwsTrap[];
  onAlert: (alert: Alert) => void;
  /** Keep the process alive for the loop alone (the CLI `watch`), instead of riding along with a server. */
  keepAlive?: boolean;
}): () => void {
  let regions = o.regions;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const tick = async () => {
    try {
      const result = await pollOnce({ home: o.home, aws: o.aws, traps: o.traps(), regions });
      regions ??= result.regions;
      for (const alert of result.alerts) o.onAlert(alert);
      for (const error of result.errors) console.error(`[honeytoken] CloudTrail: ${error}`);
    } catch (err) {
      console.error('[honeytoken] CloudTrail poll failed:', err);
    }
    if (stopped) return;
    timer = setTimeout(tick, o.intervalMs);
    if (!o.keepAlive) timer.unref();
  };

  timer = setTimeout(tick, 0);
  if (!o.keepAlive) timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
