#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addTrap, cleanTraps, readLock, registerPlacement, resolveLockPath } from './lock.ts';
import { notifyConfigFromEnv } from './notify.ts';
import { startServer } from './server.ts';
import { createTrap } from './trap.ts';

const USAGE = `Usage: honeytoken <command> [options]

Commands:
  create                 Issue a new webhook trap (prints JSON)
      --label <text>         note for yourself, e.g. "billing .env"
      --path-prefix <path>   URL path before the trap id (default /v1/hooks)
      --token-prefix <str>   token prefix matching the repo, e.g. sk_live_
      --token-length <n>     random part length, 16-128 (default 32)
      --charset alnum|hex    random part alphabet (default alnum)
      --base-url <url>       alert server URL (env HONEYTOKEN_BASE_URL, default http://127.0.0.1:8787)
  register <id> <file>   Record where a trap was planted (lines are found automatically)
      --line <n>             fail unless the trap is on this line
  list                   Show traps and where they are planted (--json for raw)
  clean <id...> | --all  Remove planted lines and forget the traps (--dry-run to preview)
  serve                  Run the alert server (--host, --port; default 127.0.0.1:8787)
                         Forwards to HONEYTOKEN_SLACK_WEBHOOK / HONEYTOKEN_DISCORD_WEBHOOK if set
  mcp                    Run the MCP server on stdio (for Claude Code, Cursor, ...)
  install-skill          Copy the agent skill to ~/.claude/skills/honeytoken-planting
      --dir <path>           skills directory to install into instead

Global:
  --lock <path>          lock file (env HONEYTOKEN_LOCK, default ./honeytoken.lock)
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lock: { type: 'string' },
    label: { type: 'string' },
    'path-prefix': { type: 'string' },
    'token-prefix': { type: 'string' },
    'token-length': { type: 'string' },
    charset: { type: 'string' },
    'base-url': { type: 'string' },
    line: { type: 'string' },
    all: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    json: { type: 'boolean' },
    host: { type: 'string' },
    port: { type: 'string' },
    dir: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...args] = positionals;
const lockPath = resolveLockPath(opt.lock);

function toInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
}

async function main(): Promise<void> {
  switch (command) {
    case 'create': {
      if (opt.charset && opt.charset !== 'alnum' && opt.charset !== 'hex') {
        throw new Error('--charset must be alnum or hex');
      }
      const trap = createTrap({
        baseUrl: opt['base-url'] ?? process.env.HONEYTOKEN_BASE_URL ?? 'http://127.0.0.1:8787',
        label: opt.label,
        pathPrefix: opt['path-prefix'],
        tokenPrefix: opt['token-prefix'],
        tokenLength: toInt(opt['token-length'], 'token-length'),
        tokenCharset: opt.charset as 'alnum' | 'hex' | undefined,
      });
      addTrap(lockPath, trap);
      console.log(JSON.stringify({ id: trap.id, url: trap.url, token: trap.token }, null, 2));
      return;
    }

    case 'register': {
      const [id, file] = args;
      if (!id || !file) throw new Error('usage: honeytoken register <id> <file> [--line n]');
      const placements = registerPlacement(lockPath, id, file, toInt(opt.line, 'line'));
      console.log(`registered ${id} in ${placements.map((p) => `${p.file}:${p.line}`).join(', ')}`);
      return;
    }

    case 'list': {
      const { traps } = readLock(lockPath);
      if (opt.json) return console.log(JSON.stringify(traps, null, 2));
      if (traps.length === 0) return console.log(`no traps in ${lockPath}`);
      for (const t of traps) {
        const where = t.placements.map((p) => `${p.file}:${p.line}`).join(', ') || '(not planted yet)';
        console.log(`${t.id}  ${t.label || '-'}\n  url:    ${t.url}\n  planted: ${where}`);
      }
      return;
    }

    case 'clean': {
      if (!opt.all && args.length === 0) throw new Error('usage: honeytoken clean <id...> | --all [--dry-run]');
      const results = cleanTraps(lockPath, opt.all ? 'all' : args, { dryRun: opt['dry-run'] });
      const verb = opt['dry-run'] ? 'would remove' : 'removed';
      for (const r of results) {
        console.log(`${r.id}  ${r.label || '-'}`);
        for (const f of r.removed) console.log(`  ${verb} ${f.file} line ${f.lines.join(', ')}`);
        for (const f of r.missing) console.log(`  missing ${f} (skipped)`);
      }
      if (!opt['dry-run']) console.log(`cleaned ${results.length} trap(s)`);
      return;
    }

    case 'serve': {
      const host = opt.host ?? '127.0.0.1';
      const port = toInt(opt.port, 'port') ?? 8787;
      await startServer({ lockPath, host, port });
      const cfg = notifyConfigFromEnv();
      const targets = [cfg.slackWebhook && 'slack', cfg.discordWebhook && 'discord'].filter(Boolean);
      console.log(`honeytoken alert server on http://${host}:${port}`);
      console.log(`lock: ${lockPath}`);
      console.log(`forwarding: ${targets.join(', ') || 'console only'}\n`);
      return;
    }

    case 'mcp': {
      const { startMcpServer } = await import('./mcp.ts'); // keep the SDK off the other commands' path
      await startMcpServer(lockPath);
      return;
    }

    case 'install-skill': {
      // Home directory by default: a skill committed into the target repo would announce the traps.
      const dest = path.resolve(opt.dir ?? path.join(os.homedir(), '.claude', 'skills'), 'honeytoken-planting');
      const source = fileURLToPath(new URL('../skills/honeytoken-planting/SKILL.md', import.meta.url));
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(source, path.join(dest, 'SKILL.md'));
      console.log(`installed ${path.join(dest, 'SKILL.md')}`);
      return;
    }

    default:
      console.log(USAGE);
      if (command && !opt.help) process.exitCode = 1;
  }
}

main().catch((err: Error) => {
  console.error(`honeytoken: ${err.message}`);
  process.exitCode = 1;
});
