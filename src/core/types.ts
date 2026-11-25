export type TrapStatus = 'active' | 'retired';

/** What in a request gave a trap away: its id (part of the URL) or its token. */
export type MatchReason = 'url' | 'token';

export interface Placement {
  /** Absolute path of the repository root. */
  repo: string;
  /** Path relative to `repo`. */
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
  /**
   * Retired traps are gone from the working tree but still watched: old clones and
   * git history keep the decoy alive, and a hit on one is the leak you most want to see.
   */
  status: TrapStatus;
  createdAt: string;
  retiredAt?: string;
  placements: Placement[];
}

export interface Alert {
  trapId: string;
  label: string;
  status: TrapStatus;
  matched: MatchReason[];
  /** "repo/file:line,line" for every place the trap was planted. */
  plantedIn: string[];
  /** Fields below come from the request: attacker-controlled, already clipped. */
  method: string;
  path: string;
  clientIp: string;
  /** Spoofable unless you sit behind a proxy you trust. */
  forwardedFor?: string;
  userAgent?: string;
  /** Set when the user agent looks like a link-preview bot rather than a person. */
  botHint?: string;
  /** Hits from the same address swallowed by the cooldown since the previous alert. */
  suppressed?: number;
  at: string;
}

/** An alert channel. Add one by writing a function with this shape. */
export type Notifier = (alert: Alert) => Promise<void>;
