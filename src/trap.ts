import { randomInt } from 'node:crypto';

export interface Placement {
  /** Path relative to the directory that holds honeytoken.lock. */
  file: string;
  line: number;
  plantedAt: string;
}

export interface Trap {
  id: string;
  kind: 'webhook';
  label: string;
  url: string;
  token: string;
  createdAt: string;
  placements: Placement[];
}

export interface TrapOptions {
  /** Where the alert server is reachable, e.g. https://hooks.example.com */
  baseUrl: string;
  /** Free-form note for humans, e.g. "payments .env". Never shown to attackers. */
  label?: string;
  /** URL path placed before the trap id, chosen to blend in (e.g. /v2/billing/callback). */
  pathPrefix?: string;
  /** Token prefix that matches the repo's style, e.g. "sk_live_". */
  tokenPrefix?: string;
  tokenLength?: number;
  tokenCharset?: 'alnum' | 'hex';
}

const CHARSETS = {
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  hex: '0123456789abcdef',
  id: 'abcdefghijklmnopqrstuvwxyz0123456789',
} as const;

const PATH_PREFIX_RE = /^(\/[A-Za-z0-9._~-]+)*$/;
const TOKEN_PREFIX_RE = /^[A-Za-z0-9._-]{0,32}$/;

function randomString(chars: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += chars[randomInt(chars.length)];
  return out;
}

export function createTrap(opts: TrapOptions): Trap {
  const pathPrefix = (opts.pathPrefix ?? '/v1/hooks').replace(/\/+$/, '');
  if (!PATH_PREFIX_RE.test(pathPrefix) || pathPrefix.split('/').some((s) => /^\.+$/.test(s))) {
    throw new Error(`invalid pathPrefix "${opts.pathPrefix}": use segments like /api/v2/callback`);
  }

  const tokenPrefix = opts.tokenPrefix ?? '';
  if (!TOKEN_PREFIX_RE.test(tokenPrefix)) {
    throw new Error(`invalid tokenPrefix "${tokenPrefix}": up to 32 chars of [A-Za-z0-9._-]`);
  }

  const tokenLength = opts.tokenLength ?? 32;
  if (!Number.isInteger(tokenLength) || tokenLength < 16 || tokenLength > 128) {
    throw new Error('tokenLength must be an integer between 16 and 128');
  }

  const base = new URL(opts.baseUrl); // throws on garbage input
  const id = randomString(CHARSETS.id, 20);

  return {
    id,
    kind: 'webhook',
    label: opts.label ?? '',
    url: `${base.origin}${base.pathname.replace(/\/+$/, '')}${pathPrefix}/${id}`,
    token: tokenPrefix + randomString(CHARSETS[opts.tokenCharset ?? 'alnum'], tokenLength),
    createdAt: new Date().toISOString(),
    placements: [],
  };
}
