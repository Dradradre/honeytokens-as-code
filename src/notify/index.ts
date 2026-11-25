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
  now?: () => number;
}

/**
 * Fan an alert out to every notifier, at most once per cooldown for the same trap and
 * address. The next alert that does go out says how many hits were held back.
 */
export function createDispatcher(opts: DispatchOptions): (alert: Alert) => Promise<void> {
  const cooldown = opts.cooldownMs ?? 10 * 60_000;
  const now = opts.now ?? Date.now;
  const last = new Map<string, { at: number; suppressed: number }>();

  return async (alert) => {
    opts.log?.(alert);

    // Status is part of the key: the first hit after a trap is retired is news, not a repeat.
    const key = `${alert.trapId}|${alert.status}|${alert.clientIp}`;
    const t = now();
    const prev = last.get(key);
    if (prev && t - prev.at < cooldown) {
      prev.suppressed++;
      return;
    }
    last.set(key, { at: t, suppressed: 0 });
    if (last.size > 10_000) {
      for (const [k, v] of last) if (t - v.at >= cooldown) last.delete(k);
    }

    const out = prev?.suppressed ? { ...alert, suppressed: prev.suppressed } : alert;
    const results = await Promise.allSettled(opts.notifiers.map((notify) => notify(out)));
    for (const r of results) {
      if (r.status === 'rejected') console.error(`[honeytoken] notifier failed: ${r.reason}`);
    }
  };
}
