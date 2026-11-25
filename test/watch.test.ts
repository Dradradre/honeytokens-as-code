import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { parseWatchlist, pollOnce, watchlistFromRegistry } from '../src/watch.ts';
import { sandbox } from './helpers.ts';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;

async function plantedAwsTrap() {
  const box = sandbox();
  const t = await box.service.issueAws({ userName: 'svc-export', label: 'export key' });
  box.write('deploy/export.env', `AWS_ACCESS_KEY_ID=${t.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${t.secretAccessKey}\n`);
  box.service.register(t.id, 'deploy/export.env');
  box.service.issue({}); // a webhook trap: never in a watchlist
  return { ...box, trap: t };
}

test('watchlist carries what watching needs and never a secret key', async () => {
  const { home, trap } = await plantedAwsTrap();
  const list = watchlistFromRegistry(home);
  assert.equal(list.length, 1, 'AWS traps only');
  assert.equal(list[0]?.accessKeyId, trap.accessKeyId);
  assert.deepEqual(list[0]?.placements.map((p) => p.line), [1, 2]);
  assert.ok(!JSON.stringify(list).includes(trap.secretAccessKey));

  const withSecret = JSON.stringify([{ ...list[0], secretAccessKey: trap.secretAccessKey }]);
  assert.ok(!JSON.stringify(parseWatchlist(withSecret)).includes(trap.secretAccessKey), 'secrets dropped on read too');
  assert.throws(() => parseWatchlist('{}'), /JSON array/);
  assert.throws(() => parseWatchlist(JSON.stringify([{ kind: 'webhook', id: 'x' }])), /entry 0/);
});

test('pollOnce works from a watchlist alone, in a fresh home, and keeps a cursor', async () => {
  const { home, aws, trap } = await plantedAwsTrap();
  const list = parseWatchlist(JSON.stringify(watchlistFromRegistry(home)));
  aws.use(trap.accessKeyId, { ip: '198.51.100.23' });

  const ciHome = fs.mkdtempSync(path.join(os.tmpdir(), 'honeytoken-ci-'));
  const first = await pollOnce({ home: ciHome, aws: aws.run, traps: list });
  assert.deepEqual(first.errors, []);
  assert.deepEqual(first.regions, ['us-east-1', 'ap-northeast-2']);
  assert.equal(first.alerts[0]?.clientIp, '198.51.100.23');
  assert.deepEqual(first.alerts[0]?.plantedIn, ['acme-payments/deploy/export.env:1,2']);
  assert.ok(fs.existsSync(path.join(ciHome, 'cloudtrail.json')));

  const second = await pollOnce({ home: ciHome, aws: aws.run, traps: list });
  assert.equal(second.alerts.length, 0, 'the cursor stops repeats across runs');
});

test('pollOnce hands alerts over oldest first, whatever order regions and CloudTrail return them in', async () => {
  const { home, aws, trap } = await plantedAwsTrap();
  const now = Date.now();
  aws.use(trap.accessKeyId, { region: 'us-east-1', eventName: 'Third', at: new Date(now - 1_000) });
  aws.use(trap.accessKeyId, { region: 'ap-northeast-2', eventName: 'First', at: new Date(now - 3_000) });
  aws.use(trap.accessKeyId, { region: 'us-east-1', eventName: 'Second', at: new Date(now - 2_000) });
  const { alerts } = await pollOnce({ home, aws: aws.run, traps: watchlistFromRegistry(home) });
  assert.deepEqual(alerts.map((a) => a.path.split(' ')[1]), ['First', 'Second', 'Third']);
});

test('`watch --once` with a watchlist: real process, fake aws on PATH, alert on stdout, exit code', async () => {
  const { home, trap } = await plantedAwsTrap();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honeytoken-watch-'));
  const watchlist = path.join(dir, 'watchlist.json');
  fs.writeFileSync(watchlist, JSON.stringify(watchlistFromRegistry(home)));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'aws'),
    `#!${process.execPath}
const a = process.argv.slice(2);
if (a[0] === 'cloudtrail' && a.join(' ').includes('${trap.accessKeyId}') && process.env.FAKE_FAIL !== '1')
  console.log(JSON.stringify({ Events: [{ EventId: 'e1', EventName: 'GetCallerIdentity', EventTime: Date.now() / 1000 - 60,
    CloudTrailEvent: JSON.stringify({ eventSource: 'sts.amazonaws.com', awsRegion: 'us-east-1', sourceIPAddress: '203.0.113.5', userAgent: 'aws-cli/1.46' }) }] }));
else if (a[0] === 'cloudtrail') { console.error('An error occurred (ThrottlingException)'); process.exit(254); }
else { console.error('unexpected'); process.exit(255); }
`,
    { mode: 0o755 },
  );

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HONEYTOKEN_HOME: path.join(dir, 'ci-home') };
  delete env.HONEYTOKEN_SLACK_WEBHOOK;
  delete env.HONEYTOKEN_DISCORD_WEBHOOK;
  const run = promisify(execFile);
  const args = [CLI, 'watch', '--once', '--watchlist', watchlist, '--aws-regions', 'us-east-1'];

  const ok = await run(process.execPath, args, { env });
  assert.match(ok.stdout, /trap triggered: export key/);
  assert.match(ok.stdout, /from: `203\.0\.113\.5`/);
  assert.match(ok.stderr, /watched 1 AWS trap\(s\) in 1 region\(s\): 1 new alert/);

  const again = await run(process.execPath, args, { env });
  assert.doesNotMatch(again.stdout, /trap triggered/, 'cursor persisted between runs');

  await assert.rejects(run(process.execPath, args, { env: { ...env, FAKE_FAIL: '1' } }), (err: { code: number; stderr: string }) => {
    assert.equal(err.code, 1);
    assert.match(err.stderr, /ThrottlingException/);
    return true;
  });
});
