import type { MatchReason, Trap } from './types.ts';

/** A line belongs to a trap if it carries the trap's token or id (the id is part of the URL). */
export function lineHasTrap(text: string, trap: Trap): boolean {
  return text.includes(trap.token) || text.includes(trap.id);
}

/** Every trap whose id or token appears in `haystack`. Ids and tokens are long and random, so a substring hit is a hit. */
export function trapsIn(haystack: string, traps: Trap[]): { trap: Trap; matched: MatchReason[] }[] {
  return traps.flatMap((trap) => {
    const matched: MatchReason[] = [];
    if (haystack.includes(trap.id)) matched.push('url');
    if (haystack.includes(trap.token)) matched.push('token');
    return matched.length ? [{ trap, matched }] : [];
  });
}
