// Public, runtime-agnostic API: `import { handle } from 'honeytoken-mcp/core'`.
// Only Web-standard globals in here (fetch types, URL, crypto, TextDecoder), no node: modules,
// so the alert path can run on Node, Cloudflare Workers, Deno or Bun.
export { describePlacements, formatAlert, placementFile } from './format.ts';
export { handle, resolveClientIp, type HandleOptions } from './handle.ts';
export { lineHasTrap, trapsIn } from './match.ts';
export { generateTrap, type TrapOptions } from './trap.ts';
export type { Alert, MatchReason, Notifier, Placement, Trap, TrapStatus } from './types.ts';
