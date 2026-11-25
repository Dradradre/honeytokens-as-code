import { describePlacements } from './format.ts';
import { trapsIn } from './match.ts';
import type { Alert, Trap } from './types.ts';

export interface HandleOptions {
  /** Current traps, active and retired. Called once per request so new traps are live at once. */
  traps: () => Trap[] | Promise<Trap[]>;
  /** Called once per trap hit. Must not throw; the response does not wait for delivery. */
  onAlert: (alert: Alert) => void;
  /** The runtime knows the peer address; a Request does not carry it. */
  clientIp: string;
}

const MAX_BODY = 64 * 1024;
const MAX_FIELD = 300;

const BOTS: [RegExp, string][] = [
  [/Slackbot/i, 'Slack link preview'],
  [/Discordbot/i, 'Discord link preview'],
  [/TelegramBot/i, 'Telegram link preview'],
  [/Twitterbot/i, 'X/Twitter link preview'],
  [/facebookexternalhit|meta-externalagent/i, 'Meta link preview'],
  [/LinkedInBot/i, 'LinkedIn link preview'],
  [/WhatsApp/i, 'WhatsApp link preview'],
  [/SkypeUriPreview|Teams/i, 'Microsoft Teams link preview'],
  [/github-camo/i, 'GitHub image proxy'],
  [/Googlebot|bingbot|Applebot|DuckDuckBot|YandexBot/i, 'search engine crawler'],
];

/**
 * Web-standard request handler, so the same code runs under node:http (see server.ts),
 * Cloudflare Workers, Deno or Bun. A hit gets a dull 401 like any API rejecting a key;
 * everything else gets 404 and no alert.
 */
export async function handle(req: Request, opts: HandleOptions): Promise<Response> {
  const url = new URL(req.url);
  const target = url.pathname + url.search;
  const haystack = [
    target,
    await readLimited(req),
    ...[...req.headers].map(([, value]) => value),
    decodeBasicAuth(req.headers.get('authorization')),
  ].join('\n');

  const hits = trapsIn(haystack, await opts.traps());
  const userAgent = clip(req.headers.get('user-agent'));
  const at = new Date().toISOString();

  for (const { trap, matched } of hits) {
    opts.onAlert({
      trapId: trap.id,
      label: trap.label,
      status: trap.status,
      matched,
      plantedIn: describePlacements(trap.placements),
      method: clip(req.method) ?? '?',
      path: clip(target) ?? '/',
      clientIp: clip(opts.clientIp) ?? '',
      forwardedFor: clip(req.headers.get('x-forwarded-for')),
      userAgent,
      botHint: userAgent ? BOTS.find(([re]) => re.test(userAgent))?.[1] : undefined,
      at,
    });
  }

  return hits.length
    ? Response.json({ error: 'unauthorized' }, { status: 401 })
    : Response.json({ error: 'not_found' }, { status: 404 });
}

function clip(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const flat = value.replace(/[\r\n]+/g, ' ');
  return flat.length > MAX_FIELD ? flat.slice(0, MAX_FIELD) + '...' : flat;
}

async function readLimited(req: Request): Promise<string> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text.slice(0, MAX_BODY);
}

function decodeBasicAuth(header: string | null): string {
  const match = header?.match(/^Basic\s+(\S+)/i);
  if (!match?.[1]) return '';
  try {
    return atob(match[1]);
  } catch {
    return '';
  }
}
