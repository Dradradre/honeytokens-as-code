import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_NAME, VERSION } from './version.ts';

/** Run an external command; `missing` when it is not installed. Injectable so tests never touch the real `claude` or `aws`. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string; missing?: boolean }>;

export const runCommand: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr), missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' });
    });
  });

export const SKILL_SOURCE = fileURLToPath(new URL('../skills/honeytoken-planting/SKILL.md', import.meta.url));

export function installSkill(skillsDir = path.join(os.homedir(), '.claude', 'skills')): string {
  const dest = path.join(path.resolve(skillsDir), 'honeytoken-planting');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(SKILL_SOURCE, path.join(dest, 'SKILL.md'));
  return path.join(dest, 'SKILL.md');
}

/**
 * How an MCP client should start this server. From an npx cache the path is temporary, so use a
 * pinned `npx` command; otherwise point at this file. `node` is looked up on PATH rather than
 * using process.execPath, which on Homebrew and similar resolves to a versioned directory that
 * disappears on the next Node upgrade and would leave the server silently unstartable.
 */
export function mcpCommand(cliPath: string): string[] {
  return cliPath.includes(`${path.sep}_npx${path.sep}`)
    ? ['npx', '-y', `${PACKAGE_NAME}@${VERSION}`, 'mcp']
    : ['node', cliPath, 'mcp'];
}

export interface InitStep {
  step: string;
  status: 'done' | 'already' | 'skipped' | 'failed' | 'info';
  detail: string;
}

/**
 * One-command setup: install the skill, register the MCP server with Claude Code (user scope,
 * so nothing lands in any repo), check the AWS CLI, and say what is still missing.
 */
export async function init(o: {
  cliPath: string;
  run?: CommandRunner;
  skillsDir?: string;
  baseUrl?: string;
  dryRun?: boolean;
}): Promise<InitStep[]> {
  const run = o.run ?? runCommand;
  const steps: InitStep[] = [];
  const command = mcpCommand(o.cliPath);

  if (o.dryRun) {
    steps.push({ step: 'skill', status: 'info', detail: `would copy SKILL.md into ${o.skillsDir ?? '~/.claude/skills'}/honeytoken-planting` });
  } else {
    steps.push({ step: 'skill', status: 'done', detail: installSkill(o.skillsDir) });
  }

  const existing = await run('claude', ['mcp', 'get', 'honeytoken']);
  if (existing.missing) {
    steps.push({
      step: 'mcp',
      status: 'skipped',
      detail:
        'Claude Code CLI not found. For other MCP clients add this stdio server to your user-level config:\n' +
        JSON.stringify({ mcpServers: { honeytoken: { command: command[0], args: command.slice(1), ...(o.baseUrl ? { env: { HONEYTOKEN_BASE_URL: o.baseUrl } } : {}) } } }, null, 2),
    });
  } else if (existing.code === 0) {
    steps.push({ step: 'mcp', status: 'already', detail: 'Claude Code already has a "honeytoken" MCP server; left as is' });
  } else {
    const args = ['mcp', 'add', '--scope', 'user', 'honeytoken', ...(o.baseUrl ? ['-e', `HONEYTOKEN_BASE_URL=${o.baseUrl}`] : []), '--', ...command];
    if (o.dryRun) {
      steps.push({ step: 'mcp', status: 'info', detail: `would run: claude ${args.join(' ')}` });
    } else {
      const added = await run('claude', args);
      steps.push(
        added.code === 0
          ? { step: 'mcp', status: 'done', detail: 'registered with Claude Code (user scope: no file in any repo)' }
          : { step: 'mcp', status: 'failed', detail: (added.stderr || added.stdout).trim() || `claude exited ${added.code}` },
      );
    }
  }

  const identity = await run('aws', ['sts', 'get-caller-identity', '--output', 'json']);
  if (identity.missing) {
    steps.push({ step: 'aws', status: 'skipped', detail: 'AWS CLI not found: webhook traps only. Install the AWS CLI to use AWS traps.' });
  } else if (identity.code !== 0) {
    steps.push({ step: 'aws', status: 'skipped', detail: `AWS CLI is installed but not signed in: ${identity.stderr.trim().split('\n').pop()}` });
  } else {
    const account = (() => {
      try {
        return JSON.parse(identity.stdout).Account;
      } catch {
        return 'unknown';
      }
    })();
    steps.push({ step: 'aws', status: 'done', detail: `AWS account ${account} reachable. Permissions needed: \`honeytoken iam-policy issuer\`` });
  }

  steps.push({
    step: 'alerts',
    status: 'info',
    detail: o.baseUrl
      ? `webhook traps will point at ${o.baseUrl}`
      : 'HONEYTOKEN_BASE_URL is not set: webhook traps only fire on this machine. AWS traps need no public URL.',
  });
  steps.push({ step: 'next', status: 'info', detail: 'Open your repo in Claude Code and say: plant honeytokens in this repo' });
  return steps;
}

/** IAM policies to paste: one for whoever issues traps, one for whatever watches CloudTrail. */
export function iamPolicy(kind: 'issuer' | 'watcher'): object {
  return kind === 'issuer'
    ? {
        Version: '2012-10-17',
        Statement: [
          { Sid: 'Identify', Effect: 'Allow', Action: 'sts:GetCallerIdentity', Resource: '*' },
          {
            Sid: 'ManageServiceUsers',
            Effect: 'Allow',
            Action: [
              'iam:CreateUser', 'iam:DeleteUser', 'iam:PutUserPolicy', 'iam:GetUserPolicy', 'iam:DeleteUserPolicy',
              'iam:CreateAccessKey', 'iam:ListAccessKeys', 'iam:DeleteAccessKey',
            ],
            Resource: 'arn:aws:iam::*:user/*',
          },
        ],
      }
    : {
        Version: '2012-10-17',
        Statement: [{ Sid: 'ReadActivity', Effect: 'Allow', Action: ['cloudtrail:LookupEvents', 'ec2:DescribeRegions'], Resource: '*' }],
      };
}

/**
 * A scheduled GitHub Actions job that watches AWS traps with no server: OIDC into a read-only
 * role, poll CloudTrail, alert, and keep the cursor in the Actions cache. Belongs in a private
 * ops repo, never in a repo that holds decoys.
 */
export function workflowTemplate(): string {
  return `# Watches honeytoken AWS traps without a server. Put this in a PRIVATE ops repository,
# never in a repository that holds decoys.
#
# Secrets:
#   HONEYTOKEN_AWS_ROLE        ARN of a role this repo may assume via OIDC, with \`honeytoken iam-policy watcher\`
#   HONEYTOKEN_WATCHLIST       output of \`honeytoken watchlist\` (no secret keys, but it maps your decoys)
#   HONEYTOKEN_SLACK_WEBHOOK   and/or HONEYTOKEN_DISCORD_WEBHOOK
name: honeytoken-watch

on:
  schedule:
    - cron: '*/10 * * * *'   # GitHub may run scheduled jobs late; each run re-reads the last 2 hours
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  group: honeytoken-watch
  cancel-in-progress: false

jobs:
  watch:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: \${{ secrets.HONEYTOKEN_AWS_ROLE }}
          aws-region: us-east-1
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - uses: actions/cache/restore@v6
        with:
          path: .honeytoken
          key: honeytoken-state-\${{ github.run_id }}
          restore-keys: honeytoken-state-
      - name: Search CloudTrail for trap use
        run: npx -y ${PACKAGE_NAME}@${VERSION} watch --once
        env:
          HONEYTOKEN_HOME: .honeytoken
          HONEYTOKEN_WATCHLIST: \${{ secrets.HONEYTOKEN_WATCHLIST }}
          HONEYTOKEN_SLACK_WEBHOOK: \${{ secrets.HONEYTOKEN_SLACK_WEBHOOK }}
          HONEYTOKEN_DISCORD_WEBHOOK: \${{ secrets.HONEYTOKEN_DISCORD_WEBHOOK }}
      - uses: actions/cache/save@v6
        if: always()
        with:
          path: .honeytoken
          key: honeytoken-state-\${{ github.run_id }}
`;
}
