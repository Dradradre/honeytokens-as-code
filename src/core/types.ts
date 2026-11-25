export type TrapStatus = 'active' | 'retired';

/**
 * What gave a trap away: its id (part of a webhook URL), its token sent to the alert
 * server, or its AWS access key showing up in CloudTrail.
 */
export type MatchReason = 'url' | 'token' | 'cloudtrail';

export interface Placement {
  /** Absolute path of the repository root. */
  repo: string;
  /** Path relative to `repo`. */
  file: string;
  line: number;
  plantedAt: string;
}

interface TrapBase {
  id: string;
  label: string;
  /**
   * Retired traps are gone from the working tree but still watched: old clones and
   * git history keep the decoy alive, and a hit on one is the leak you most want to see.
   */
  status: TrapStatus;
  createdAt: string;
  retiredAt?: string;
  placements: Placement[];
}

/** How a webhook trap was shaped, kept so `rotate` can issue a look-alike. */
export interface WebhookSpec {
  pathPrefix: string;
  tokenPrefix: string;
  tokenLength: number;
  tokenCharset: 'alnum' | 'hex';
}

/** A URL on your alert server plus a fake token; fires when either reaches the server. */
export interface WebhookTrap extends TrapBase {
  kind: 'webhook';
  url: string;
  token: string;
  spec?: WebhookSpec;
}

/**
 * A real AWS access key for an IAM user with no permissions (an explicit deny-all policy),
 * in an account you control. It passes an intruder's validity check, and every use lands
 * in CloudTrail, where `honeytoken serve` finds it.
 */
export interface AwsTrap extends TrapBase {
  kind: 'aws';
  userName: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type Trap = WebhookTrap | AwsTrap;

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
  /** Hits on this trap held back by the cooldown since its previous alert. */
  suppressed?: number;
  at: string;
}

/** An alert channel. Add one by writing a function with this shape. */
export type Notifier = (alert: Alert) => Promise<void>;
