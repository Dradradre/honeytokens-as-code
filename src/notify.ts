export interface Alert {
  trapId: string;
  label: string;
  /** What in the request gave the trap away. */
  matched: ('url' | 'token')[];
  /** Where the trap was planted, as "file:line". Tells you which file leaked. */
  plantedIn: string[];
  method: string;
  path: string;
  remoteAddress: string;
  /** Client-supplied, so spoofable unless you sit behind a proxy you trust. */
  forwardedFor?: string;
  userAgent?: string;
  at: string;
}

export interface NotifyConfig {
  slackWebhook?: string;
  discordWebhook?: string;
}

export function notifyConfigFromEnv(env = process.env): NotifyConfig {
  return {
    slackWebhook: env.HONEYTOKEN_SLACK_WEBHOOK || undefined,
    discordWebhook: env.HONEYTOKEN_DISCORD_WEBHOOK || undefined,
  };
}

/** Attacker-controlled values go inside code spans, with backticks removed so they cannot break out. */
function code(value: string | undefined, max = 200): string {
  const v = (value ?? '-').replace(/`/g, "'").replace(/[\r\n]+/g, ' ');
  return '`' + (v.length > max ? v.slice(0, max) + '...' : v) + '`';
}

export function formatAlert(a: Alert): string {
  return [
    `[honeytoken] trap triggered: ${a.label || a.trapId}`,
    `trap: ${a.trapId} (matched ${a.matched.join(' + ')})`,
    `planted in: ${a.plantedIn.length ? a.plantedIn.join(', ') : 'not registered'}`,
    `request: ${code(`${a.method} ${a.path}`)}`,
    `from: ${code(a.remoteAddress)}` + (a.forwardedFor ? ` x-forwarded-for: ${code(a.forwardedFor)}` : ''),
    `user-agent: ${code(a.userAgent)}`,
    `at: ${a.at}`,
  ].join('\n');
}

function escapeSlack(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function post(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
}

export async function sendAlert(alert: Alert, cfg: NotifyConfig): Promise<void> {
  const text = formatAlert(alert);
  console.log(text + '\n');

  const jobs: Promise<void>[] = [];
  if (cfg.slackWebhook) jobs.push(post(cfg.slackWebhook, { text: escapeSlack(text) }));
  if (cfg.discordWebhook) {
    // parse: [] stops @everyone / role mentions smuggled in through the request.
    jobs.push(post(cfg.discordWebhook, { content: text.slice(0, 1900), allowed_mentions: { parse: [] } }));
  }
  for (const r of await Promise.allSettled(jobs)) {
    if (r.status === 'rejected') console.error(`[honeytoken] forwarding failed: ${r.reason}`);
  }
}
