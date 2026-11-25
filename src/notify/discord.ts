import { formatAlert } from '../core/format.ts';
import type { Notifier } from '../core/types.ts';
import { postJson } from './post.ts';

/** Discord webhook. `parse: []` stops @everyone and role mentions smuggled in through a request. */
export function discord(webhookUrl: string, fetchImpl?: typeof fetch): Notifier {
  return (alert) =>
    postJson(webhookUrl, { content: formatAlert(alert).slice(0, 1900), allowed_mentions: { parse: [] } }, fetchImpl);
}
