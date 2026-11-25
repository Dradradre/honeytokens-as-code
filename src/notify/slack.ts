import { formatAlert } from '../core/format.ts';
import type { Notifier } from '../core/types.ts';
import { postJson } from './post.ts';

/** Slack incoming webhook. Escaping &, < and > stops <!channel> and link syntax smuggled in through a request. */
export function slack(webhookUrl: string, fetchImpl?: typeof fetch): Notifier {
  return (alert) => {
    const text = formatAlert(alert).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return postJson(webhookUrl, { text }, fetchImpl);
  };
}
