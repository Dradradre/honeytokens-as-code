import type { Trap } from './types.ts';

export interface TrapOptions {
  /** Where the alert server is reachable, e.g. https://hooks.example.com */
  baseUrl: string;
  /** Free-form note for the owner. Never planted. */
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

/** Uniform random string from Web Crypto (rejection sampling, so no modulo bias). */
function randomString(chars: string, length: number): string {
  const limit = 256 - (256 % chars.length);
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit) out += chars[byte % chars.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generateTrap(opts: TrapOptions): Trap {
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
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`baseUrl must be http(s), got ${base.protocol}`);
  }
  const id = randomString(CHARSETS.id, 20);

  return {
    id,
    kind: 'webhook',
    label: opts.label ?? '',
    url: `${base.origin}${base.pathname.replace(/\/+$/, '')}${pathPrefix}/${id}`,
    token: tokenPrefix + randomString(CHARSETS[opts.tokenCharset ?? 'alnum'], tokenLength),
    status: 'active',
    createdAt: new Date().toISOString(),
    placements: [],
  };
}
