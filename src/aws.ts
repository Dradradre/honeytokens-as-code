import { execFile } from 'node:child_process';
import { clip, describePlacements } from './core/format.ts';
import { assertNoTell, newTrapId } from './core/trap.ts';
import type { Alert, AwsTrap } from './core/types.ts';

/**
 * AWS traps follow the established canary design (Thinkst, GitGuardian, Rapid7): a real access
 * key for an IAM user that can do nothing, in an account you control. It survives an intruder's
 * validity check, and its use shows up in CloudTrail. We drive AWS through the `aws` CLI the user
 * already has, so their profiles and SSO work as is and we add no SDK dependency.
 */

/** Run one AWS CLI command; resolves to its parsed JSON output, or {} when it prints nothing. */
export type AwsRunner = (args: string[]) => Promise<any>;

export function awsCli(command: string[] = ['aws']): AwsRunner {
  const [bin = 'aws', ...prefix] = command;
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, [...prefix, ...args, '--output', 'json'], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        const what = `aws ${args.slice(0, 2).join(' ')}`;
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return reject(new Error('the AWS CLI (`aws`) is not installed or not on PATH'));
          }
          return reject(new Error(`${what} failed: ${String(stderr).trim() || err.message}`));
        }
        const out = String(stdout).trim();
        try {
          resolve(out ? JSON.parse(out) : {});
        } catch {
          reject(new Error(`${what} printed something that is not JSON`));
        }
      });
    });
}

const IAM_USER_RE = /^[\w+=,.@-]{1,64}$/;
/** Inline policy name on the canary user. Plain on purpose. */
export const DENY_POLICY_NAME = 'default';
/** Explicit deny wins over anything attached later by mistake, so the key can never do harm. */
const DENY_ALL = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }] });

export async function issueAwsTrap(aws: AwsRunner, opts: { userName: string; label?: string }): Promise<AwsTrap> {
  const { userName } = opts;
  if (!IAM_USER_RE.test(userName)) throw new Error(`invalid IAM user name "${userName}": 1-64 chars of [A-Za-z0-9+=,.@_-]`);
  assertNoTell(userName, 'userName');

  const { Account: accountId } = await aws(['sts', 'get-caller-identity']);
  await aws(['iam', 'create-user', '--user-name', userName]);
  try {
    // Deny-all goes on before the key exists, so there is never a key without it.
    await aws(['iam', 'put-user-policy', '--user-name', userName, '--policy-name', DENY_POLICY_NAME, '--policy-document', DENY_ALL]);
    const { AccessKey } = await aws(['iam', 'create-access-key', '--user-name', userName]);
    return {
      id: newTrapId(),
      kind: 'aws',
      label: opts.label ?? '',
      userName,
      accountId: String(accountId ?? ''),
      accessKeyId: AccessKey.AccessKeyId,
      secretAccessKey: AccessKey.SecretAccessKey,
      status: 'active',
      createdAt: new Date().toISOString(),
      placements: [],
    };
  } catch (err) {
    await deleteIamUser(aws, userName).catch(() => {});
    throw err;
  }
}

/** A second key on the same user, so the planted spot keeps the same identity. IAM allows two keys per user. */
export async function rotateAwsKey(aws: AwsRunner, old: AwsTrap): Promise<AwsTrap> {
  let created;
  try {
    created = await aws(['iam', 'create-access-key', '--user-name', old.userName]);
  } catch (err) {
    if (/LimitExceeded/.test(String(err))) {
      throw new Error(`IAM user ${old.userName} already has two access keys; issue a new AWS trap instead of rotating`);
    }
    throw err;
  }
  return {
    ...old,
    id: newTrapId(),
    accessKeyId: created.AccessKey.AccessKeyId,
    secretAccessKey: created.AccessKey.SecretAccessKey,
    status: 'active',
    createdAt: new Date().toISOString(),
    retiredAt: undefined,
    placements: [],
  };
}

/** Remove one trap's key, and the user too when no other trap uses it. */
export async function deleteAwsTrap(aws: AwsRunner, trap: AwsTrap, { deleteUser }: { deleteUser: boolean }): Promise<void> {
  if (deleteUser) return deleteIamUser(aws, trap.userName);
  await aws(['iam', 'delete-access-key', '--user-name', trap.userName, '--access-key-id', trap.accessKeyId]);
}

async function deleteIamUser(aws: AwsRunner, userName: string): Promise<void> {
  const { AccessKeyMetadata = [] } = await aws(['iam', 'list-access-keys', '--user-name', userName]);
  for (const key of AccessKeyMetadata) {
    await aws(['iam', 'delete-access-key', '--user-name', userName, '--access-key-id', key.AccessKeyId]);
  }
  await aws(['iam', 'delete-user-policy', '--user-name', userName, '--policy-name', DENY_POLICY_NAME]).catch(ignoreNoSuchEntity);
  await aws(['iam', 'delete-user', '--user-name', userName]);
}

function ignoreNoSuchEntity(err: unknown): void {
  if (!/NoSuchEntity/.test(String(err))) throw err;
}

export interface AwsTrapStatus {
  key: 'Active' | 'Inactive' | 'missing';
  denyPolicy: boolean;
}

/** Is the key still there and still locked down? */
export async function awsTrapStatus(aws: AwsRunner, trap: AwsTrap): Promise<AwsTrapStatus> {
  const { AccessKeyMetadata = [] } = await aws(['iam', 'list-access-keys', '--user-name', trap.userName]).catch((err) => {
    ignoreNoSuchEntity(err);
    return {};
  });
  const key = AccessKeyMetadata.find((k: { AccessKeyId: string }) => k.AccessKeyId === trap.accessKeyId);
  const policy = await aws(['iam', 'get-user-policy', '--user-name', trap.userName, '--policy-name', DENY_POLICY_NAME]).catch((err) => {
    ignoreNoSuchEntity(err);
    return undefined;
  });
  const statements = policy?.PolicyDocument?.Statement ?? [];
  const denyPolicy = statements.some((s: any) => s.Effect === 'Deny' && s.Action === '*' && s.Resource === '*');
  return { key: key?.Status ?? 'missing', denyPolicy };
}

/** Regions enabled in the account; global-endpoint STS calls land in us-east-1, the rest wherever the caller pointed. */
export async function listRegions(aws: AwsRunner): Promise<string[]> {
  const regions = await aws(['ec2', 'describe-regions', '--region', 'us-east-1', '--query', 'Regions[].RegionName']);
  if (!Array.isArray(regions) || regions.length === 0) throw new Error('ec2 describe-regions returned no regions');
  return regions;
}

/** CloudTrail can deliver an event minutes after the call, so every poll looks back this far again. */
export const LOOKBACK_MS = 30 * 60_000;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60_000; // event history keeps 90 days

export interface CloudTrailCursor {
  /** End of the last window that every region answered for. */
  since: string;
  /** Event ids already alerted on, with when we saw them; pruned after the lookback. */
  seen: Record<string, number>;
}

export interface PollResult {
  alerts: Alert[];
  cursor: CloudTrailCursor;
  errors: string[];
}

/**
 * One pass over CloudTrail event history: every region, every AWS trap (active and retired).
 * If any lookup fails, `since` stays put so the next pass covers the gap; `seen` keeps the
 * overlap from alerting twice.
 */
export async function pollCloudTrail(
  aws: AwsRunner,
  regions: string[],
  traps: AwsTrap[],
  cursor: CloudTrailCursor,
  now = Date.now(),
): Promise<PollResult> {
  const from = new Date(Math.max(Date.parse(cursor.since) - LOOKBACK_MS, now - MAX_WINDOW_MS)).toISOString();
  const until = new Date(now).toISOString();
  const seen = { ...cursor.seen };
  const alerts: Alert[] = [];
  const errors: string[] = [];

  await Promise.all(
    regions.map(async (region) => {
      // Sequential within a region: LookupEvents allows two calls per second per region.
      for (const trap of traps) {
        try {
          const { Events = [] } = await aws([
            'cloudtrail', 'lookup-events', '--region', region,
            '--lookup-attributes', `AttributeKey=AccessKeyId,AttributeValue=${trap.accessKeyId}`,
            '--start-time', from, '--end-time', until,
          ]);
          for (const event of Events) {
            if (!event?.EventId || seen[event.EventId]) continue;
            seen[event.EventId] = now;
            alerts.push(cloudTrailAlert(trap, event, region));
          }
        } catch (err) {
          errors.push(`${region}: ${(err as Error).message}`);
        }
      }
    }),
  );

  for (const [id, at] of Object.entries(seen)) if (now - at > 2 * LOOKBACK_MS) delete seen[id];
  return { alerts, errors, cursor: { since: errors.length ? cursor.since : until, seen } };
}

/**
 * AWS CLI v1 prints timestamps as epoch seconds by default (`1795576025.21`), v2 and
 * `cli_timestamp_format = iso8601` as ISO strings. Accept both; NaN when neither.
 */
export function eventTimeMs(value: unknown): number {
  if (typeof value === 'number') return value * 1000;
  if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function cloudTrailAlert(trap: AwsTrap, event: any, region: string): Alert {
  let detail: any = {};
  try {
    detail = JSON.parse(event.CloudTrailEvent ?? '{}');
  } catch {
    // keep the summary fields
  }
  const source = detail.eventSource ?? event.EventSource ?? 'unknown';
  const outcome = detail.errorCode ? ` -> ${detail.errorCode}` : '';
  const at = eventTimeMs(event.EventTime ?? detail.eventTime);
  return {
    trapId: trap.id,
    label: trap.label,
    status: trap.status,
    matched: ['cloudtrail'],
    plantedIn: describePlacements(trap.placements),
    method: 'AWS',
    path: clip(`${source} ${event.EventName}${outcome} (${detail.awsRegion ?? region})`) ?? '',
    clientIp: clip(detail.sourceIPAddress) ?? '',
    userAgent: clip(detail.userAgent),
    at: Number.isNaN(at) ? new Date().toISOString() : new Date(at).toISOString(),
  };
}
