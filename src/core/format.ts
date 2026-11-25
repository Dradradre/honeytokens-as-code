import type { Alert, Placement } from './types.ts';

/** "acme-payments/deploy/legacy/billing.env": repo directory name plus the path inside it. */
export function placementFile(p: Placement): string {
  const repoName = p.repo.split(/[\\/]/).filter(Boolean).pop() ?? p.repo;
  return `${repoName}/${p.file}`;
}

/** Group placements per file: "acme-payments/deploy/legacy/billing.env:7,8". */
export function describePlacements(placements: Placement[]): string[] {
  const byFile = new Map<string, number[]>();
  for (const p of placements) {
    const key = placementFile(p);
    byFile.set(key, [...(byFile.get(key) ?? []), p.line]);
  }
  return [...byFile].map(([file, lines]) => `${file}:${lines.join(',')}`);
}

/** Attacker-controlled values go inside code spans, with backticks removed so they cannot break out. */
function code(value: string | undefined): string {
  return '`' + (value ?? '-').replace(/`/g, "'") + '`';
}

export function formatAlert(a: Alert): string {
  return [
    `[honeytoken] trap triggered: ${a.label || a.trapId}${a.status === 'retired' ? ' (retired trap)' : ''}`,
    `trap: ${a.trapId} (matched ${a.matched.join(' + ')})`,
    `planted in: ${a.plantedIn.length ? a.plantedIn.join(', ') : 'not registered'}`,
    ...(a.status === 'retired' ? ['note: this trap was cleaned up, so an old copy of the repo is in use'] : []),
    `request: ${code(`${a.method} ${a.path}`)}`,
    `from: ${code(a.clientIp)}` + (a.forwardedFor ? ` x-forwarded-for: ${code(a.forwardedFor)}` : ''),
    `user-agent: ${code(a.userAgent)}`,
    ...(a.botHint ? [`likely: ${a.botHint} (link previews fetch URLs on their own)`] : []),
    ...(a.suppressed ? [`suppressed: ${a.suppressed} more hits from this address since the last alert`] : []),
    `at: ${a.at}`,
  ].join('\n');
}
