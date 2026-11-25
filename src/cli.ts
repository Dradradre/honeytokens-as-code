#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { awsCli } from './aws.ts';
import { formatAlert } from './core/format.ts';
import { createDispatcher, notifiersFromEnv } from './notify/index.ts';
import { createService } from './service.ts';
import { iamPolicy, init, installSkill, workflowTemplate } from './setup.ts';
import { appendAlert } from './store.ts';
import { parseWatchlist, pollOnce, watchLoop, watchlistFromRegistry, type WatchedAwsTrap } from './watch.ts';
import { VERSION } from './version.ts';

const USAGE = `Usage: honeytoken <command> [options]

Getting started:
  init                   Install the agent skill, register the MCP server with Claude Code, check the AWS CLI
      --dry-run              show what would happen

Commands:
  create [webhook]       Issue a webhook trap (prints JSON)
      --label <text>         note for yourself, e.g. "payments gateway key"
      --path-prefix <path>   URL path before the trap id (default /v1/hooks)
      --token-prefix <str>   prefix in the repo's internal style, e.g. pgw_live_
      --token-length <n>     random part length, 16-128 (default 32)
      --charset alnum|hex    random part alphabet (default alnum)
      --base-url <url>       alert server URL (env HONEYTOKEN_BASE_URL, default http://127.0.0.1:8787)
      --allow-provider-prefix  let the token imitate a known provider (not recommended)
  create aws             Create a powerless IAM user + access key with your AWS CLI (prints JSON)
      --user-name <name>     IAM user name that fits the repo, e.g. svc-billing-export
      --label <text>
  register <id> <file>   Record where a trap was planted (lines are found automatically)
      --line <n>             fail unless the trap is on this line
  list                   Show active traps (--all to include retired, --json for raw)
  check                  Are traps still planted, due for rotation, AWS keys intact? Exit 1 if not.
      --max-age <days>       rotation age (default 180); --json for raw
  rotate <id>            Replace a planted trap with a fresh one in the same lines; the old one is retired
  clean <id...> | --all  Remove planted lines and retire the traps (--dry-run to preview)
  alerts                 Show recent alerts (--limit n, default 20; --json for raw)
  serve                  Run the alert server (--host, --port; default 127.0.0.1:8787)
      --cooldown <sec>       quiet period per trap and address (default 600)
      --trust-proxy <hdr>    take the client address from this header set by your proxy:
                             x-forwarded-for (one proxy), cf-connecting-ip, x-real-ip
      --aws-poll <sec>       how often to search CloudTrail for AWS trap use (default 300, 0 = off)
      --aws-regions <list>   comma-separated regions (default: every enabled region)
                         Forwards to HONEYTOKEN_SLACK_WEBHOOK / HONEYTOKEN_DISCORD_WEBHOOK if set
  watch                  Search CloudTrail for AWS trap use without running a server
      --once                 one pass, then exit (cron, GitHub Actions); exit 1 if a lookup failed
      --watchlist <file>     traps to watch (env HONEYTOKEN_WATCHLIST), instead of the registry
      --aws-poll, --aws-regions, --cooldown   as for serve
  watchlist              Print the AWS traps to watch, without secret keys (for CI secrets)
  iam-policy issuer|watcher   Print the IAM policy for issuing traps or for watching CloudTrail
  workflow               Print a GitHub Actions workflow that runs \`watch --once\` on a schedule
  mcp                    Run the MCP server on stdio (for Claude Code, Cursor, ...)
  install-skill          Copy the agent skill to ~/.claude/skills/honeytoken-planting
      --dir <path>           skills directory to install into instead

Global:
  --home <path>          data directory (env HONEYTOKEN_HOME, default ~/.honeytoken)
  -v, --version          print the version
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
    'trust-proxy': { type: 'string' },
    'allow-provider-prefix': { type: 'boolean' },
    'user-name': { type: 'string' },
    'max-age': { type: 'string' },
    'aws-poll': { type: 'string' },
    'aws-regions': { type: 'string' },
    once: { type: 'boolean' },
    watchlist: { type: 'string' },
    version: { type: 'boolean', short: 'v' },
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
  if (opt.version) return console.log(VERSION);
  switch (command) {
    case 'create': {
      const [kind = 'webhook'] = args;
      if (kind === 'aws') {
        if (!opt['user-name']) throw new Error('usage: honeytoken create aws --user-name <name> [--label text]');
        console.log(JSON.stringify(await service.issueAws({ userName: opt['user-name'], label: opt.label }), null, 2));
        return;
      }
      if (kind !== 'webhook') throw new Error(`unknown trap kind "${kind}": use webhook or aws`);
      if (opt.charset && opt.charset !== 'alnum' && opt.charset !== 'hex') {
        throw new Error('--charset must be alnum or hex');
      }
      const issued = service.issue({
        label: opt.label,
        pathPrefix: opt['path-prefix'],
        tokenPrefix: opt['token-prefix'],
        tokenLength: toInt(opt['token-length'], 'token-length'),
        tokenCharset: opt.charset as 'alnum' | 'hex' | undefined,
        allowProviderPrefix: opt['allow-provider-prefix'],
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
        console.log(`${t.id}  ${t.kind}  ${t.label || '-'}${t.status === 'retired' ? '  [retired]' : ''}`);
        console.log(`  target:  ${t.target}`);
        console.log(`  planted: ${t.plantedIn.join(', ') || '(not planted yet)'}`);
      }
      return;
    }

    case 'clean': {
      if (!opt.all && args.length === 0) throw new Error('usage: honeytoken clean <id...> | --all [--dry-run]');
      const dryRun = opt['dry-run'] ?? false;
      const results = await service.clean(opt.all ? 'all' : args, { dryRun });
      for (const r of results) {
        console.log(`${r.id}  ${r.label || '-'}`);
        for (const f of r.removed) console.log(`  ${dryRun ? 'would remove' : 'removed'} ${f.file} line ${f.lines.join(', ')}`);
        for (const f of r.missing) console.log(`  missing ${f} (skipped)`);
        for (const f of r.refused) console.log(`  refused ${f}: it now resolves outside its repository`);
        if (r.forgotten) console.log(`  never planted: ${dryRun ? 'would be deleted' : 'deleted'}`);
      }
      const retired = results.filter((r) => !r.forgotten).length;
      if (!dryRun) console.log(`retired ${retired} trap(s); they keep alerting if an old copy is used`);
      return;
    }

    case 'check': {
      const results = await service.check({ maxAgeDays: toInt(opt['max-age'], 'max-age') });
      if (opt.json) console.log(JSON.stringify(results, null, 2));
      else if (results.length === 0) console.log('no active traps');
      for (const r of opt.json ? [] : results) {
        const flags = [r.needsAttention && 'NEEDS ATTENTION', r.rotationDue && 'rotation due'].filter(Boolean).join(', ');
        console.log(`${r.id}  ${r.kind}  ${r.label || '-'}  ${r.ageDays}d${flags ? `  [${flags}]` : ''}`);
        if (r.files.length === 0) console.log('  not planted anywhere');
        for (const f of r.files) console.log(`  ${f.state.padEnd(7)} ${f.file}${f.lines.length ? `:${f.lines.join(',')}` : ''}`);
        if (r.aws) console.log(`  aws     ${'error' in r.aws ? `error: ${r.aws.error}` : `key ${r.aws.key}, deny-all policy ${r.aws.denyPolicy ? 'present' : 'MISSING'}`}`);
      }
      if (results.some((r) => r.needsAttention)) process.exitCode = 1;
      return;
    }

    case 'rotate': {
      const [id] = args;
      if (!id) throw new Error('usage: honeytoken rotate <id>');
      const r = await service.rotate(id);
      console.log(`rotated ${r.oldId} -> ${r.newId} (the old trap is retired and still watched)`);
      for (const f of r.files) console.log(`  updated ${f.file} line ${f.lines.join(', ')}`);
      for (const f of r.missing) console.log(`  missing ${f} (skipped)`);
      for (const f of r.refused) console.log(`  refused ${f}: it now resolves outside its repository`);
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
      const trustProxy = opt['trust-proxy'];
      if (trustProxy !== undefined && !/^[A-Za-z0-9-]+$/.test(trustProxy)) throw new Error('--trust-proxy takes a header name');
      const awsPoll = toInt(opt['aws-poll'], 'aws-poll') ?? 300;
      const awsRegions = opt['aws-regions']?.split(',').map((r) => r.trim()).filter(Boolean);
      const { serve } = await import('./server.ts');
      await serve({
        home: service.home,
        host,
        port,
        trustProxy,
        cooldownMs: cooldown === undefined ? undefined : cooldown * 1000,
        awsPollMs: awsPoll * 1000,
        awsRegions,
      });
      const webhooks = notifiersFromEnv().length - 1; // minus the console
      console.log(`honeytoken alert server on http://${host}:${port}`);
      console.log(`home: ${service.home}`);
      console.log(`client address: ${trustProxy ? `${trustProxy} header (trusted proxy)` : 'TCP peer'}`);
      console.log(`AWS traps: ${awsPoll ? `CloudTrail searched every ${awsPoll}s${awsRegions ? ` in ${awsRegions.join(', ')}` : ''}` : 'not watched'}`);
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
      console.log(`installed ${installSkill(opt.dir)}`);
      return;
    }

    case 'init': {
      const steps = await init({
        cliPath: fileURLToPath(import.meta.url),
        baseUrl: opt['base-url'] ?? process.env.HONEYTOKEN_BASE_URL,
        skillsDir: opt.dir,
        dryRun: opt['dry-run'],
      });
      const mark = { done: '✓', already: '✓', skipped: '–', failed: '✗', info: '·' } as const;
      for (const s of steps) console.log(`${mark[s.status]} ${s.step.padEnd(7)} ${s.detail.replace(/\n/g, '\n          ')}`);
      if (steps.some((s) => s.status === 'failed')) process.exitCode = 1;
      return;
    }

    case 'watch': {
      const source = opt.watchlist ? fs.readFileSync(opt.watchlist, 'utf8') : process.env.HONEYTOKEN_WATCHLIST;
      const traps = (): WatchedAwsTrap[] => (source ? parseWatchlist(source) : watchlistFromRegistry(service.home));
      const regions = opt['aws-regions']?.split(',').map((r) => r.trim()).filter(Boolean);
      const cooldown = toInt(opt.cooldown, 'cooldown');
      const dispatch = createDispatcher({
        notifiers: notifiersFromEnv(),
        log: (alert) => appendAlert(service.home, alert),
        cooldownMs: cooldown === undefined ? undefined : cooldown * 1000,
      });
      const aws = awsCli();
      if (opt.once) {
        const watched = traps();
        const result = await pollOnce({ home: service.home, aws, traps: watched, regions });
        // In order, so the cooldown sees the hits the way they happened; then send the summaries
        // now, because this process will not be around when the window closes.
        for (const alert of result.alerts) await dispatch(alert);
        await dispatch.flush();
        for (const error of result.errors) console.error(`[honeytoken] CloudTrail: ${error}`);
        console.error(`watched ${watched.length} AWS trap(s)${result.regions ? ` in ${result.regions.length} region(s)` : ''}: ${result.alerts.length} new alert(s)`);
        if (result.errors.length) process.exitCode = 1;
        return;
      }
      const interval = (toInt(opt['aws-poll'], 'aws-poll') ?? 300) * 1000;
      watchLoop({ home: service.home, aws, intervalMs: interval, regions, traps, onAlert: (a) => void dispatch(a), keepAlive: true });
      console.error(`watching AWS traps in CloudTrail every ${interval / 1000}s (Ctrl-C to stop); webhook traps need \`serve\``);
      return;
    }

    case 'watchlist': {
      console.log(JSON.stringify(watchlistFromRegistry(service.home), null, 2));
      return;
    }

    case 'iam-policy': {
      const [kind] = args;
      if (kind !== 'issuer' && kind !== 'watcher') throw new Error('usage: honeytoken iam-policy issuer|watcher');
      console.log(JSON.stringify(iamPolicy(kind), null, 2));
      return;
    }

    case 'workflow': {
      process.stdout.write(workflowTemplate());
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
