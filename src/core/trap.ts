import type { WebhookSpec, WebhookTrap } from './types.ts';

export interface TrapOptions {
  /** Where the alert server is reachable, e.g. https://hooks.example.com */
  baseUrl: string;
  /** Free-form note for the owner. Never planted. */
  label?: string;
  /** URL path placed before the trap id, chosen to blend in (e.g. /v2/billing/callback). */
  pathPrefix?: string;
  /** Token prefix that matches the repo's own naming, e.g. "pgw_live_". */
  tokenPrefix?: string;
  tokenLength?: number;
  tokenCharset?: 'alnum' | 'hex';
  /** Let a token imitate a known provider's key format. Off for agents; see PROVIDER_PREFIXES. */
  allowProviderPrefix?: boolean;
}

const CHARSETS = {
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  hex: '0123456789abcdef',
  id: 'abcdefghijklmnopqrstuvwxyz0123456789',
} as const;

const PATH_PREFIX_RE = /^(\/[A-Za-z0-9._~-]+)*$/;
const TOKEN_PREFIX_RE = /^[A-Za-z0-9._-]{0,32}$/;

/**
 * Key formats of well-known providers. A fake in one of these formats is the worst of both
 * worlds: GitHub push protection blocks the commit that plants it, secret scanners verify it
 * against the real provider and drop it as invalid, and an intruder who tries it calls the
 * provider's API, never your alert server. Imitate an internal service instead, or use a real
 * AWS trap. Extend this list as providers add formats.
 */
export const PROVIDER_PREFIXES: [RegExp, string][] = [
  [/^(sk|rk|pk)_(live|test)_/, 'Stripe'],
  [/^whsec_/, 'Stripe webhook secret'],
  [/^(ghp|gho|ghu|ghs|ghr)_|^github_pat_/, 'GitHub'],
  [/^(glpat|gldt|glrt|glptt)-/, 'GitLab'],
  [/^xox[abposr]-|^xapp-/, 'Slack'],
  [/^(AKIA|ASIA|ABIA|ACCA)/, 'AWS'],
  [/^sk-ant-/, 'Anthropic'],
  [/^sk-(proj|svcacct|admin)-|^sk-$/, 'OpenAI'],
  [/^SG\./, 'SendGrid'],
  [/^npm_/, 'npm'],
  [/^pypi-/, 'PyPI'],
  [/^AIza/, 'Google API'],
  [/^hf_/, 'Hugging Face'],
  [/^shp(at|ss|ca|pa)_/, 'Shopify'],
  [/^dop_v1_/, 'DigitalOcean'],
  [/^glc_/, 'Grafana'],
];

/**
 * Words that announce a decoy, matched as whole words (camelCase split first) so "fakeKey" and
 * "honeypot" are caught while "bootstrap", "honeycomb" and "trapezoid" pass.
 */
const TELL_RE = /(^|[^a-z])(honey(pots?|tokens?)?|canar(y|ies)(tokens?)?|decoys?|traps?|fakes?|baits?|lures?|tripwires?)([^a-z]|$)/i;

/** Throw if a name the intruder will see gives the decoy away. */
export function assertNoTell(value: string, what: string): void {
  const words = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  if (TELL_RE.test(words)) throw new Error(`${what} "${value}" gives the decoy away; choose a name the repo would really use`);
}

/** Uniform random string from Web Crypto (rejection sampling, so no modulo bias). */
export function randomString(chars: string, length: number): string {
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

export function newTrapId(): string {
  return randomString(CHARSETS.id, 20);
}

export function generateWebhookTrap(opts: TrapOptions): WebhookTrap {
  const spec: WebhookSpec = {
    pathPrefix: (opts.pathPrefix ?? '/v1/hooks').replace(/\/+$/, ''),
    tokenPrefix: opts.tokenPrefix ?? '',
    tokenLength: opts.tokenLength ?? 32,
    tokenCharset: opts.tokenCharset ?? 'alnum',
  };
  if (!PATH_PREFIX_RE.test(spec.pathPrefix) || spec.pathPrefix.split('/').some((s) => /^\.+$/.test(s))) {
    throw new Error(`invalid pathPrefix "${opts.pathPrefix}": use segments like /api/v2/callback`);
  }
  if (!TOKEN_PREFIX_RE.test(spec.tokenPrefix)) {
    throw new Error(`invalid tokenPrefix "${spec.tokenPrefix}": up to 32 chars of [A-Za-z0-9._-]`);
  }
  if (!opts.allowProviderPrefix) {
    const provider = PROVIDER_PREFIXES.find(([re]) => re.test(spec.tokenPrefix))?.[1];
    if (provider) {
      throw new Error(
        `tokenPrefix "${spec.tokenPrefix}" imitates ${provider}. A fake provider key gets blocked by push protection, ` +
          `fails scanners' validity checks, and is tried against ${provider}, not your alert server. ` +
          'Imitate an internal service instead (e.g. "pgw_live_"), or issue an AWS trap.',
      );
    }
  }
  assertNoTell(spec.pathPrefix, 'pathPrefix');
  assertNoTell(spec.tokenPrefix, 'tokenPrefix');
  if (!Number.isInteger(spec.tokenLength) || spec.tokenLength < 16 || spec.tokenLength > 128) {
    throw new Error('tokenLength must be an integer between 16 and 128');
  }

  const base = new URL(opts.baseUrl); // throws on garbage input
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error(`baseUrl must be http(s), got ${base.protocol}`);
  }
  const id = newTrapId();

  return {
    id,
    kind: 'webhook',
    label: opts.label ?? '',
    url: `${base.origin}${base.pathname.replace(/\/+$/, '')}${spec.pathPrefix}/${id}`,
    token: spec.tokenPrefix + randomString(CHARSETS[spec.tokenCharset], spec.tokenLength),
    spec,
    status: 'active',
    createdAt: new Date().toISOString(),
    placements: [],
  };
}
