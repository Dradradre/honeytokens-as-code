// Public, runtime-agnostic API: `import { handle } from 'honeytoken-mcp/core'`.
// Only Web-standard globals in here (fetch types, URL, crypto, TextDecoder), no node: modules,
// so the alert path can run on Node, Cloudflare Workers, Deno or Bun.
export { clip, describePlacements, formatAlert, placementFile } from './format.ts';
export { handle, resolveClientIp, type HandleOptions } from './handle.ts';
export { lineHasTrap, trapMarkers, trapsIn } from './match.ts';
export { PROVIDER_PREFIXES, assertNoTell, generateWebhookTrap, type TrapOptions } from './trap.ts';
export type { Alert, AwsTrap, MatchReason, Notifier, Placement, Trap, TrapStatus, WebhookSpec, WebhookTrap } from './types.ts';
