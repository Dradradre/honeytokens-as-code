import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AwsRunner } from '../src/aws.ts';
import { createService } from '../src/service.ts';

/**
 * A throwaway git repo plus a throwaway honeytoken home, and a service bound to both.
 * AWS goes to an in-memory fake unless a runner is passed, so no test can reach a real account.
 */
export function sandbox(baseUrl = 'https://hooks.example.com', aws: FakeAws = fakeAws()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honeytoken-'));
  const repo = path.join(root, 'acme-payments');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  };
  const read = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8');
  return { root, repo, home, write, read, aws, service: createService({ home, cwd: repo, baseUrl, aws: aws.run }) };
}

interface FakeUser {
  keys: { AccessKeyId: string; SecretAccessKey: string; Status: 'Active' | 'Inactive' }[];
  policies: Map<string, string>;
}

export interface CloudTrailEventFixture {
  region: string;
  accessKeyId: string;
  event: Record<string, unknown>;
}

/** In-memory stand-in for the slice of IAM, STS, EC2 and CloudTrail the AWS CLI calls we make. */
export function fakeAws(opts: { account?: string; regions?: string[]; fail?: (args: string[]) => Error | undefined } = {}) {
  const account = opts.account ?? '123456789012';
  const users = new Map<string, FakeUser>();
  const events: CloudTrailEventFixture[] = [];
  const calls: string[][] = [];
  let serial = 0;

  const awsError = (code: string, op: string) => new Error(`An error occurred (${code}) when calling the ${op} operation`);
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
  const user = (name: string, op: string) => {
    const u = users.get(name);
    if (!u) throw awsError('NoSuchEntity', op);
    return u;
  };

  const run: AwsRunner = async (args) => {
    calls.push(args);
    const failure = opts.fail?.(args);
    if (failure) throw failure;
    const name = args.includes('--user-name') ? flag(args, '--user-name') : '';
    switch (`${args[0]} ${args[1]}`) {
      case 'sts get-caller-identity':
        return { Account: account, Arn: `arn:aws:iam::${account}:user/operator` };
      case 'iam create-user':
        if (users.has(name)) throw awsError('EntityAlreadyExists', 'CreateUser');
        users.set(name, { keys: [], policies: new Map() });
        return { User: { UserName: name } };
      case 'iam put-user-policy':
        user(name, 'PutUserPolicy').policies.set(flag(args, '--policy-name'), flag(args, '--policy-document'));
        return {};
      case 'iam get-user-policy': {
        const doc = user(name, 'GetUserPolicy').policies.get(flag(args, '--policy-name'));
        if (!doc) throw awsError('NoSuchEntity', 'GetUserPolicy');
        return { PolicyDocument: JSON.parse(doc) };
      }
      case 'iam delete-user-policy':
        if (!user(name, 'DeleteUserPolicy').policies.delete(flag(args, '--policy-name'))) throw awsError('NoSuchEntity', 'DeleteUserPolicy');
        return {};
      case 'iam create-access-key': {
        const u = user(name, 'CreateAccessKey');
        if (u.keys.length >= 2) throw awsError('LimitExceeded', 'CreateAccessKey');
        serial++;
        const key = {
          AccessKeyId: `AKIA${String(serial).padStart(16, 'Q')}`,
          SecretAccessKey: `secret${String(serial).padStart(34, 'x')}`,
          Status: 'Active' as const,
        };
        u.keys.push(key);
        return { AccessKey: { ...key, UserName: name } };
      }
      case 'iam list-access-keys':
        return { AccessKeyMetadata: user(name, 'ListAccessKeys').keys.map(({ AccessKeyId, Status }) => ({ AccessKeyId, Status })) };
      case 'iam delete-access-key': {
        const u = user(name, 'DeleteAccessKey');
        u.keys = u.keys.filter((k) => k.AccessKeyId !== flag(args, '--access-key-id'));
        return {};
      }
      case 'iam delete-user': {
        const u = user(name, 'DeleteUser');
        if (u.keys.length || u.policies.size) throw awsError('DeleteConflict', 'DeleteUser');
        users.delete(name);
        return {};
      }
      case 'ec2 describe-regions':
        return opts.regions ?? ['us-east-1', 'ap-northeast-2'];
      case 'cloudtrail lookup-events': {
        const region = flag(args, '--region');
        const key = flag(args, '--lookup-attributes').split('AttributeValue=')[1];
        const [from, until] = [Date.parse(flag(args, '--start-time')), Date.parse(flag(args, '--end-time'))];
        const Events = events
          .filter((e) => e.region === region && e.accessKeyId === key)
          .filter((e) => {
            const raw = e.event.EventTime;
            const t = typeof raw === 'number' ? raw * 1000 : Date.parse(String(raw)); // CLI v1 prints epoch seconds
            return t >= from && t <= until;
          })
          .map((e) => e.event);
        return { Events };
      }
      default:
        throw new Error(`fake aws: unsupported command ${args.slice(0, 2).join(' ')}`);
    }
  };

  /** Record a CloudTrail event as if `accessKeyId` had just called `eventName`. */
  const use = (accessKeyId: string, o: { region?: string; eventName?: string; ip?: string; userAgent?: string; errorCode?: string; at?: Date; id?: string } = {}) => {
    const region = o.region ?? 'us-east-1';
    events.push({
      region,
      accessKeyId,
      event: {
        EventId: o.id ?? `evt-${events.length + 1}`,
        EventName: o.eventName ?? 'GetCallerIdentity',
        EventSource: 'sts.amazonaws.com',
        EventTime: (o.at ?? new Date()).toISOString(),
        CloudTrailEvent: JSON.stringify({
          eventSource: 'sts.amazonaws.com',
          awsRegion: region,
          sourceIPAddress: o.ip ?? '203.0.113.47',
          userAgent: o.userAgent ?? 'aws-cli/2.17.0',
          ...(o.errorCode ? { errorCode: o.errorCode } : {}),
        }),
      },
    });
  };

  return { run, users, events, calls, account, use };
}

export type FakeAws = ReturnType<typeof fakeAws>;
