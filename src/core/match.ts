import type { MatchReason, Trap, WebhookTrap } from './types.ts';

/** The strings that identify a trap wherever it is written down. All long and random. */
export function trapMarkers(trap: Trap): string[] {
  return trap.kind === 'webhook' ? [trap.token, trap.id] : [trap.accessKeyId, trap.secretAccessKey];
}

/** A line belongs to a trap if it carries any of the trap's markers. */
export function lineHasTrap(text: string, trap: Trap): boolean {
  return trapMarkers(trap).some((marker) => text.includes(marker));
}

/**
 * Webhook traps whose id or token appears in an HTTP request. AWS traps are detected in
 * CloudTrail, not here. Ids and tokens are long and random, so a substring hit is a hit.
 */
export function trapsIn(haystack: string, traps: Trap[]): { trap: WebhookTrap; matched: MatchReason[] }[] {
  return traps.flatMap((trap) => {
    if (trap.kind !== 'webhook') return [];
    const matched: MatchReason[] = [];
    if (haystack.includes(trap.id)) matched.push('url');
    if (haystack.includes(trap.token)) matched.push('token');
    return matched.length ? [{ trap, matched }] : [];
  });
}
