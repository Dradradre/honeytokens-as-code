import type { Alert, Notifier } from '../core/types.ts';
import { consoleNotifier } from './console.ts';
import { discord } from './discord.ts';
import { slack } from './slack.ts';

export { consoleNotifier, discord, slack };

/** Channels configured through the environment. Console is always on. */
export function notifiersFromEnv(env = process.env): Notifier[] {
  return [
    consoleNotifier,
    ...(env.HONEYTOKEN_SLACK_WEBHOOK ? [slack(env.HONEYTOKEN_SLACK_WEBHOOK)] : []),
    ...(env.HONEYTOKEN_DISCORD_WEBHOOK ? [discord(env.HONEYTOKEN_DISCORD_WEBHOOK)] : []),
  ];
}

export interface DispatchOptions {
  notifiers: Notifier[];
  /** Sees every hit, including the ones the cooldown keeps from the notifiers. */
  log?: (alert: Alert) => void;
  /** Quiet period per trap and client address. Default 10 minutes. */
  cooldownMs?: number;
  /** Most alerts one trap may send per cooldown window, whatever the addresses. Default 5. */
  maxPerTrap?: number;
  now?: () => number;
}

/** Addresses remembered for the cooldown. Past this, the oldest are forgotten; the per-trap cap still holds. */
const MAX_TRACKED_ADDRESSES = 10_000;

/**
 * Fan an alert out to every notifier, with two limits so nobody can flood your channels:
 * one alert per trap and address per cooldown, and at most `maxPerTrap` per trap per window
 * (an intruder rotating through IPv6 addresses hits the second). The next alert that does go
 * out says how many hits on that trap were held back.
 */
export function createDispatcher(opts: DispatchOptions): (alert: Alert) => Promise<void> {
  const cooldown = opts.cooldownMs ?? 10 * 60_000;
  const maxPerTrap = opts.maxPerTrap ?? 5;
  const now = opts.now ?? Date.now;
  const lastByAddress = new Map<string, number>();
  const byTrap = new Map<string, { windowStart: number; sent: number; suppressed: number }>();

  return async (alert) => {
    opts.log?.(alert);
    const t = now();

    // Status is part of the key: the first hit after a trap is retired is news, not a repeat.
    const trapKey = `${alert.trapId}|${alert.status}`;
    const addressKey = `${trapKey}|${alert.clientIp}`;

    let trap = byTrap.get(trapKey);
    if (!trap || t - trap.windowStart >= cooldown) {
      trap = { windowStart: t, sent: 0, suppressed: trap?.suppressed ?? 0 };
      byTrap.set(trapKey, trap);
    }
    const lastSent = lastByAddress.get(addressKey);
    if ((lastSent !== undefined && t - lastSent < cooldown) || trap.sent >= maxPerTrap) {
      trap.suppressed++;
      return;
    }

    trap.sent++;
    lastByAddress.delete(addressKey); // re-insert so Map order tracks recency
    lastByAddress.set(addressKey, t);
    for (const key of lastByAddress.keys()) {
      if (lastByAddress.size <= MAX_TRACKED_ADDRESSES) break;
      lastByAddress.delete(key);
    }

    const out = trap.suppressed ? { ...alert, suppressed: trap.suppressed } : alert;
    trap.suppressed = 0;
    const results = await Promise.allSettled(opts.notifiers.map((notify) => notify(out)));
    for (const r of results) {
      if (r.status === 'rejected') console.error(`[honeytoken] notifier failed: ${r.reason}`);
    }
  };
}
