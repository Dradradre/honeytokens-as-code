import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Alert, Trap } from './core/types.ts';

/**
 * Everything honeytoken-mcp keeps lives in one directory outside every repo
 * (default ~/.honeytoken): nothing but the decoy ever touches the target repo, `git clean`
 * cannot delete the map, and one alert server watches every repo.
 *
 *   registry.json   every trap and where it is planted
 *   alerts.jsonl    every hit the alert server saw, one JSON object per line
 *   alerts.1.jsonl  the previous log, once alerts.jsonl passed MAX_ALERT_LOG_BYTES
 *   cloudtrail.json where the CloudTrail poller left off (AWS traps only)
 */
export interface Registry {
  version: 1;
  traps: Trap[];
}

export function defaultHome(): string {
  return path.resolve(process.env.HONEYTOKEN_HOME ?? path.join(os.homedir(), '.honeytoken'));
}

const registryFile = (home: string) => path.join(home, 'registry.json');
const lockFile = (home: string) => path.join(home, 'registry.lock');
const alertsFile = (home: string) => path.join(home, 'alerts.jsonl');
const rotatedAlertsFile = (home: string) => path.join(home, 'alerts.1.jsonl');

/** A flood of hits can't fill the disk: the log rotates at this size and one old file is kept. */
export const MAX_ALERT_LOG_BYTES = 10 * 1024 * 1024;

export function readRegistry(home: string): Registry {
  const file = registryFile(home);
  if (!fs.existsSync(file)) return { version: 1, traps: [] };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data?.version !== 1 || !Array.isArray(data.traps)) throw new Error(`${file} is not a honeytoken registry`);
  return data as Registry;
}

/** Read, change and write the registry while holding its lock, so the CLI and MCP servers never drop each other's writes. */
export function updateRegistry<T>(home: string, change: (registry: Registry) => T): T {
  ensureHome(home);
  return withLock(home, () => {
    const registry = readRegistry(home);
    const result = change(registry);
    const tmp = `${registryFile(home)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, registryFile(home));
    return result;
  });
}

/** Small JSON state files next to the registry (e.g. the CloudTrail cursor). Written atomically. */
export function readState<T>(home: string, name: string, fallback: T): T {
  const file = path.join(home, name);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeState(home: string, name: string, value: unknown): void {
  ensureHome(home);
  const file = path.join(home, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function appendAlert(home: string, alert: Alert, maxBytes = MAX_ALERT_LOG_BYTES): void {
  ensureHome(home);
  const file = alertsFile(home);
  if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) fs.renameSync(file, rotatedAlertsFile(home));
  fs.appendFileSync(file, JSON.stringify(alert) + '\n', { mode: 0o600 });
}

/** The latest `limit` alerts across the current and rotated log, oldest first. */
export function readAlerts(home: string, limit: number): Alert[] {
  const lines = [rotatedAlertsFile(home), alertsFile(home)]
    .filter((file) => fs.existsSync(file))
    .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n'));
  return lines.flatMap(parseAlert).slice(-limit);
}

/** A line the server is still writing (or a damaged one) is skipped, not fatal. */
function parseAlert(line: string): Alert[] {
  if (!line) return [];
  try {
    return [JSON.parse(line) as Alert];
  } catch {
    return [];
  }
}

function ensureHome(home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
}

const STALE_LOCK_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

function withLock<T>(home: string, fn: () => T): T {
  const file = lockFile(home);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (isStale(file)) {
        fs.rmSync(file, { force: true }); // left behind by a crashed process
        continue;
      }
      if (Date.now() > deadline) throw new Error(`registry is locked by another process (${file})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); // synchronous 25 ms sleep
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function isStale(file: string): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS;
  } catch {
    return false; // released between our open and stat: just retry
  }
}
