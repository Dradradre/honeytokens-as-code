import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { awsCli, eventTimeMs, pollCloudTrail, type CloudTrailCursor } from '../src/aws.ts';
import type { Alert, AwsTrap } from '../src/core/types.ts';
import { serve } from '../src/server.ts';
import { readRegistry } from '../src/store.ts';
import { fakeAws, sandbox } from './helpers.ts';

const DENY_ALL = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }] };

test('issueAws: powerless user, deny-all policy before any key exists, secrets only returned once', async () => {
  const { service, aws, home } = sandbox();
  const issued = await service.issueAws({ userName: 'svc-billing-export', label: 'export job' });

  const user = aws.users.get('svc-billing-export');
  assert.ok(user);
  assert.deepEqual(JSON.parse(user.policies.get('default')!), DENY_ALL);
  const ops = aws.calls.map((c) => `${c[0]} ${c[1]}`);
  assert.ok(ops.indexOf('iam put-user-policy') < ops.indexOf('iam create-access-key'), 'deny-all lands before the key');

  assert.equal(issued.accountId, aws.account);
  assert.equal(user.keys[0]?.AccessKeyId, issued.accessKeyId);
  const stored = readRegistry(home).traps[0] as AwsTrap;
  assert.deepEqual([stored.kind, stored.userName, stored.status], ['aws', 'svc-billing-export', 'active']);
  assert.ok(!JSON.stringify(service.list()).includes(issued.secretAccessKey));
});

test('issueAws refuses telling or invalid names, and cleans up when AWS fails halfway', async () => {
  const failing = fakeAws({ fail: (args) => (args[1] === 'create-access-key' ? new Error('An error occurred (AccessDenied)') : undefined) });
  const { service } = sandbox(undefined, failing);

  await assert.rejects(service.issueAws({ userName: 'canary-user' }), /gives the decoy away/);
  await assert.rejects(service.issueAws({ userName: 'has spaces' }), /invalid IAM user name/);
  await assert.rejects(service.issueAws({ userName: 'svc-export' }), /AccessDenied/);
  assert.equal(failing.users.size, 0, 'half-created user removed');
  assert.deepEqual(service.list(), []);
});

test('clean: a planted AWS trap is retired and its key kept; an unplanted one is deleted from AWS', async () => {
  const { service, aws, write } = sandbox();
  const planted = await service.issueAws({ userName: 'ci-deploy-legacy' });
  const stray = await service.issueAws({ userName: 'svc-unused' });
  write('ci/legacy.env', `AWS_ACCESS_KEY_ID=${planted.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${planted.secretAccessKey}\n`);
  service.register(planted.id, 'ci/legacy.env');

  const results = await service.clean('all');
  assert.deepEqual(results.map((r) => [r.id, r.forgotten]), [[planted.id, false], [stray.id, true]]);
  assert.ok(aws.users.has('ci-deploy-legacy'), 'retired key stays alive: it is still bait in git history');
  assert.ok(!aws.users.has('svc-unused'), 'never-planted user removed from AWS');
});

test('forgetting an unplanted AWS trap deletes only its key while another trap still uses the IAM user', async () => {
  const { service, aws, write, repo } = sandbox();
  const first = await service.issueAws({ userName: 'svc-export' });
  write('a.env', `K=${first.accessKeyId}\n`);
  service.register(first.id, 'a.env');
  fs.rmSync(path.join(repo, 'a.env')); // the spot is gone, so the rotated key lands nowhere
  const { newId, missing } = await service.rotate(first.id);
  assert.deepEqual(missing, ['acme-payments/a.env']);
  assert.equal(aws.users.get('svc-export')?.keys.length, 2);

  const [result] = await service.clean([newId]);
  assert.equal(result?.forgotten, true);
  assert.deepEqual(aws.users.get('svc-export')?.keys.map((k) => k.AccessKeyId), [first.accessKeyId], 'only the unplanted key is deleted');
  assert.ok(aws.users.has('svc-export'), 'the user still backs the retired first trap');
});

test('rotate AWS: new key on the same user, files rewritten, two-key limit explained', async () => {
  const { service, aws, write, read } = sandbox();
  const t = await service.issueAws({ userName: 'svc-export' });
  write('deploy/export.env', `# export job\nAWS_ACCESS_KEY_ID=${t.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${t.secretAccessKey}\n`);
  service.register(t.id, 'deploy/export.env');

  const r = await service.rotate(t.id);
  const fresh = readRegistry(service.home).traps.find((x) => x.id === r.newId) as AwsTrap;
  assert.equal(read('deploy/export.env'), `# export job\nAWS_ACCESS_KEY_ID=${fresh.accessKeyId}\nAWS_SECRET_ACCESS_KEY=${fresh.secretAccessKey}\n`);
  assert.deepEqual(r.files, [{ file: 'acme-payments/deploy/export.env', lines: [2, 3] }]);
  assert.equal(aws.users.get('svc-export')?.keys.length, 2, 'old key kept: copies from before still alert');

  await assert.rejects(service.rotate(r.newId), /already has two access keys/);
});

test('check flags a deleted key or a stripped deny-all policy', async () => {
  const { service, aws, write } = sandbox();
  const t = await service.issueAws({ userName: 'svc-export' });
  write('a.env', `K=${t.accessKeyId}\n`);
  service.register(t.id, 'a.env');

  assert.deepEqual((await service.check())[0]?.aws, { key: 'Active', denyPolicy: true });
  aws.users.get('svc-export')!.policies.clear();
  let [r] = await service.check();
  assert.deepEqual([r?.aws, r?.needsAttention], [{ key: 'Active', denyPolicy: false }, true]);
  aws.users.get('svc-export')!.keys = [];
  [r] = await service.check();
  assert.equal((r?.aws as { key: string }).key, 'missing');
});

test('pollCloudTrail: every region, mapped fields, no duplicates across polls, failed region holds the cursor', async () => {
  const aws = fakeAws();
  const { service, write } = sandbox(undefined, aws);
  const t = await service.issueAws({ userName: 'svc-export', label: 'export job' });
  write('a.env', `K=${t.accessKeyId}\n`);
  service.register(t.id, 'a.env');
  const trap = readRegistry(service.home).traps[0] as AwsTrap;

  const now = Date.now();
  aws.use(t.accessKeyId, { region: 'us-east-1', at: new Date(now - 60_000) });
  aws.use(t.accessKeyId, { region: 'ap-northeast-2', eventName: 'ListBuckets', errorCode: 'AccessDenied', ip: '198.51.100.7', userAgent: 'Boto3/1.34', at: new Date(now - 30_000) });
  aws.use('AKIAOTHERKEY00000000', { region: 'us-east-1', at: new Date(now - 30_000) });

  const cursor: CloudTrailCursor = { since: new Date(now - 3_600_000).toISOString(), seen: {} };
  const first = await pollCloudTrail(aws.run, ['us-east-1', 'ap-northeast-2'], [trap], cursor, now);
  assert.deepEqual(first.errors, []);
  assert.equal(first.alerts.length, 2);
  const denied = first.alerts.find((a) => a.clientIp === '198.51.100.7')!;
  assert.deepEqual(
    [denied.matched, denied.method, denied.path, denied.userAgent, denied.plantedIn, denied.label],
    [['cloudtrail'], 'AWS', 'sts.amazonaws.com ListBuckets -> AccessDenied (ap-northeast-2)', 'Boto3/1.34', ['acme-payments/a.env:1'], 'export job'],
  );

  const again = await pollCloudTrail(aws.run, ['us-east-1', 'ap-northeast-2'], [trap], first.cursor, now + 1000);
  assert.equal(again.alerts.length, 0, 'the lookback overlap does not alert twice');

  const flaky = fakeAws({ fail: (args) => (args.includes('ap-northeast-2') ? new Error('throttled') : undefined) });
  const partial = await pollCloudTrail(flaky.run, ['us-east-1', 'ap-northeast-2'], [trap], cursor, now);
  assert.equal(partial.cursor.since, cursor.since, 'a failed region keeps the window open');
  assert.match(partial.errors[0]!, /ap-northeast-2: throttled/);
});

test('event time is read in both AWS CLI formats (v1 epoch seconds, v2 ISO), never replaced by the poll time', async () => {
  assert.equal(eventTimeMs(1795576025.219), 1795576025219);
  assert.equal(eventTimeMs('1795576025.219'), 1795576025219);
  assert.equal(eventTimeMs('2026-11-25T12:07:05.219+09:00'), Date.parse('2026-11-25T03:07:05.219Z'));
  assert.ok(Number.isNaN(eventTimeMs(undefined)));

  const aws = fakeAws();
  const { service, write } = sandbox(undefined, aws);
  const t = await service.issueAws({ userName: 'svc-export' });
  write('a.env', `K=${t.accessKeyId}\n`);
  service.register(t.id, 'a.env');
  const happened = new Date(Date.now() - 20 * 60_000); // twenty minutes before the poll
  aws.use(t.accessKeyId, { at: happened });
  aws.events[0]!.event.EventTime = happened.getTime() / 1000; // as AWS CLI v1 prints it

  const trap = readRegistry(service.home).traps[0] as AwsTrap;
  const { alerts } = await pollCloudTrail(aws.run, ['us-east-1'], [trap], { since: new Date(Date.now() - 3_600_000).toISOString(), seen: {} });
  assert.equal(alerts[0]?.at, happened.toISOString());
});

test('serve finds AWS trap use in CloudTrail and alerts like any other hit', async () => {
  const aws = fakeAws();
  const { service, home, write } = sandbox(undefined, aws);
  const t = await service.issueAws({ userName: 'svc-export' });
  write('a.env', `K=${t.accessKeyId}\n`);
  service.register(t.id, 'a.env');
  aws.use(t.accessKeyId, { ip: '203.0.113.9' });

  const alerts: Alert[] = [];
  const server = await serve({ home, port: 0, aws: aws.run, awsPollMs: 20, awsRegions: ['us-east-1'], onAlert: (a) => void alerts.push(a) });
  try {
    for (let i = 0; i < 100 && alerts.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    server.close();
  }
  assert.equal(alerts[0]?.clientIp, '203.0.113.9');
  assert.ok(fs.existsSync(path.join(home, 'cloudtrail.json')), 'cursor persisted');
  assert.ok((server.address() as AddressInfo | null) === null);
});

test('serve never calls AWS when there are no AWS traps', async () => {
  const aws = fakeAws();
  const { service, home } = sandbox(undefined, aws);
  service.issue({});
  const server = await serve({ home, port: 0, aws: aws.run, awsPollMs: 10, onAlert: () => {} });
  await new Promise((r) => setTimeout(r, 60));
  server.close();
  assert.deepEqual(aws.calls, []);
});

test('awsCli runs the real binary contract: JSON out, empty output, stderr on failure, missing CLI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-aws-'));
  const script = path.join(dir, 'aws.mjs');
  fs.writeFileSync(
    script,
    `const args = process.argv.slice(2);
     if (args.at(-2) !== '--output' || args.at(-1) !== 'json') { console.error('no --output json'); process.exit(2); }
     if (args[0] === 'sts') console.log(JSON.stringify({ Account: '123456789012' }));
     else if (args[0] === 'fail') { console.error('An error occurred (AccessDenied) when calling X'); process.exit(255); }
     else if (args[0] === 'garbage') console.log('not json');`,
  );
  const run = awsCli([process.execPath, script]);
  assert.deepEqual(await run(['sts', 'get-caller-identity']), { Account: '123456789012' });
  assert.deepEqual(await run(['iam', 'put-user-policy']), {});
  await assert.rejects(run(['fail', 'now']), /aws fail now failed: An error occurred \(AccessDenied\)/);
  await assert.rejects(run(['garbage', 'x']), /not JSON/);
  await assert.rejects(awsCli(['/nonexistent/aws-cli-binary'])(['sts']), /not installed or not on PATH/);
});
