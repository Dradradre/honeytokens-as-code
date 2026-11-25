#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatAlert } from './core/format.ts';
import { notifiersFromEnv } from './notify/index.ts';
import { createService } from './service.ts';

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
  list                   Show active traps (--all to include retired, --json for raw)
  clean <id...> | --all  Remove planted lines and retire the traps (--dry-run to preview)
  alerts                 Show recent alerts (--limit n, default 20; --json for raw)
  serve                  Run the alert server (--host, --port; default 127.0.0.1:8787)
      --cooldown <sec>       quiet period per trap and address (default 600)
                         Forwards to HONEYTOKEN_SLACK_WEBHOOK / HONEYTOKEN_DISCORD_WEBHOOK if set
  mcp                    Run the MCP server on stdio (for Claude Code, Cursor, ...)
  install-skill          Copy the agent skill to ~/.claude/skills/honeytoken-planting
      --dir <path>           skills directory to install into instead

Global:
  --home <path>          data directory (env HONEYTOKEN_HOME, default ~/.honeytoken)
`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    home: { type: 'string' },
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
    limit: { type: 'string' },
    host: { type: 'string' },
    port: { type: 'string' },
    cooldown: { type: 'string' },
    dir: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...args] = positionals;
const service = createService({
  home: opt.home && path.resolve(opt.home),
  baseUrl: opt['base-url'],
});

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
      const issued = service.issue({
        label: opt.label,
        pathPrefix: opt['path-prefix'],
        tokenPrefix: opt['token-prefix'],
        tokenLength: toInt(opt['token-length'], 'token-length'),
        tokenCharset: opt.charset as 'alnum' | 'hex' | undefined,
      });
      if (issued.warning) console.error(`warning: ${issued.warning}`);
      console.log(JSON.stringify({ id: issued.id, url: issued.url, token: issued.token }, null, 2));
      return;
    }

    case 'register': {
      const [id, file] = args;
      if (!id || !file) throw new Error('usage: honeytoken register <id> <file> [--line n]');
      const placements = service.register(id, file, toInt(opt.line, 'line'));
      console.log(`registered ${id} in ${file} line ${placements.map((p) => p.line).join(', ')}`);
      return;
    }

    case 'list': {
      const traps = service.list({ includeRetired: opt.all });
      if (opt.json) return console.log(JSON.stringify(traps, null, 2));
      if (traps.length === 0) return console.log(`no traps in ${service.home}`);
      for (const t of traps) {
        console.log(`${t.id}  ${t.label || '-'}${t.status === 'retired' ? '  [retired]' : ''}`);
        console.log(`  url:     ${t.url}`);
        console.log(`  planted: ${t.plantedIn.join(', ') || '(not planted yet)'}`);
      }
      return;
    }

    case 'clean': {
      if (!opt.all && args.length === 0) throw new Error('usage: honeytoken clean <id...> | --all [--dry-run]');
      const dryRun = opt['dry-run'] ?? false;
      const results = service.clean(opt.all ? 'all' : args, { dryRun });
      for (const r of results) {
        console.log(`${r.id}  ${r.label || '-'}`);
        for (const f of r.removed) console.log(`  ${dryRun ? 'would remove' : 'removed'} ${f.file} line ${f.lines.join(', ')}`);
        for (const f of r.missing) console.log(`  missing ${f} (skipped)`);
      }
      if (!dryRun) console.log(`retired ${results.length} trap(s); they keep alerting if an old copy is used`);
      return;
    }

    case 'alerts': {
      const alerts = service.alerts(toInt(opt.limit, 'limit') ?? 20);
      if (opt.json) return console.log(JSON.stringify(alerts, null, 2));
      if (alerts.length === 0) return console.log('no alerts yet');
      console.log(alerts.map(formatAlert).join('\n\n'));
      return;
    }

    case 'serve': {
      const host = opt.host ?? '127.0.0.1';
      const port = toInt(opt.port, 'port') ?? 8787;
      const cooldown = toInt(opt.cooldown, 'cooldown');
      const { serve } = await import('./server.ts');
      await serve({ home: service.home, host, port, cooldownMs: cooldown === undefined ? undefined : cooldown * 1000 });
      const webhooks = notifiersFromEnv().length - 1; // minus the console
      console.log(`honeytoken alert server on http://${host}:${port}`);
      console.log(`home: ${service.home}`);
      console.log(`forwarding: ${webhooks ? `console + ${webhooks} webhook(s)` : 'console only'}\n`);
      return;
    }

    case 'mcp': {
      const { startMcpServer } = await import('./mcp.ts'); // keep the SDK off the other commands' path
      await startMcpServer(service);
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
