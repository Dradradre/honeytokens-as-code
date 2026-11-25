import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createService } from '../src/service.ts';
import { appendAlert, readRegistry } from '../src/store.ts';
import { sandbox } from './helpers.ts';

test('nothing but the decoy is written into the repo', () => {
  const { repo, home, write, service } = sandbox();
  const { id, token } = service.issue({});
  write('.env.legacy', `KEY=${token}\n`);
  service.register(id, '.env.legacy');

  assert.deepEqual(fs.readdirSync(repo).sort(), ['.env.legacy', '.git']);
  assert.deepEqual(fs.readdirSync(path.join(repo, '.git')), []);
  assert.ok(fs.existsSync(path.join(home, 'registry.json')));
  assert.equal(fs.statSync(path.join(home, 'registry.json')).mode & 0o777, 0o600);
});

test('issue warns when no alert host is configured', () => {
  const { home, repo } = sandbox();
  const saved = process.env.HONEYTOKEN_BASE_URL;
  delete process.env.HONEYTOKEN_BASE_URL;
  try {
    const issued = createService({ home, cwd: repo }).issue({});
    assert.match(issued.url, /^http:\/\/127\.0\.0\.1:8787\/v1\/hooks\//);
    assert.match(issued.warning ?? '', /only fires on this machine/);
  } finally {
    if (saved !== undefined) process.env.HONEYTOKEN_BASE_URL = saved;
  }
});

test('register finds the lines itself and refuses what is not planted or outside the repo', () => {
  const { write, service, root } = sandbox();
  const { id, url, token } = service.issue({ label: 'billing' });

  assert.throws(() => service.register(id, 'deploy/legacy/billing.env'), /does not exist/);
  write('deploy/legacy/billing.env', `# old gateway\nBILLING_URL=${url}\nBILLING_KEY=${token}\n`);
  assert.deepEqual(service.register(id, 'deploy/legacy/billing.env').map((p) => p.line), [2, 3]);
  assert.throws(() => service.register(id, 'deploy/legacy/billing.env', 1), /does not hold/);

  write('README.md', 'nothing here\n');
  assert.throws(() => service.register(id, 'README.md'), /not found/);
  fs.writeFileSync(path.join(root, 'outside.env'), token);
  assert.throws(() => service.register(id, '../outside.env'), /outside the repository/);

  assert.deepEqual(service.list()[0]?.plantedIn, ['acme-payments/deploy/legacy/billing.env:2,3']);
  assert.ok(!JSON.stringify(service.list()).includes(token), 'list never returns tokens');
});

test('register resolves paths from a subdirectory to the repo root', () => {
  const { repo, home, write, service } = sandbox();
  const { id, token } = service.issue({});
  write('infra/old/values.yaml', `apiKey: ${token}\n`);
  const fromSubdir = createService({ home, cwd: path.join(repo, 'infra') });
  assert.deepEqual(fromSubdir.register(id, 'old/values.yaml').map((p) => p.file), ['infra/old/values.yaml']);
});

test('clean removes only trap lines, retires the trap, and keeps it on record', () => {
  const { write, read, service } = sandbox();
  const keep = service.issue({ label: 'keep' });
  const drop = service.issue({ label: 'drop' });
  write('.env.legacy', `A=1\nOLD_HOOK=${drop.url}\nB=2\nOTHER=${keep.token}\n`);
  service.register(drop.id, '.env.legacy');
  service.register(keep.id, '.env.legacy');

  const preview = service.clean([drop.id], { dryRun: true });
  assert.deepEqual(preview[0]?.removed, [{ file: 'acme-payments/.env.legacy', lines: [2] }]);
  assert.equal(service.list().length, 2, 'dry run changes nothing');

  service.clean([drop.id]);
  assert.equal(read('.env.legacy'), `A=1\nB=2\nOTHER=${keep.token}\n`);
  assert.deepEqual(service.list().map((t) => t.label), ['keep']);
  const retired = service.list({ includeRetired: true }).find((t) => t.id === drop.id);
  assert.equal(retired?.status, 'retired');
  assert.ok(retired?.retiredAt);

  assert.throws(() => service.register(drop.id, '.env.legacy'), /retired/);
  assert.throws(() => service.clean(['nope']), /no trap/);
  assert.deepEqual(service.clean('all').map((r) => r.id), [keep.id], '"all" means all active traps');
});

test('clean reports recorded files that are gone', () => {
  const { repo, write, service } = sandbox();
  const { id, token } = service.issue({});
  write('old.env', `K=${token}\n`);
  service.register(id, 'old.env');
  fs.rmSync(path.join(repo, 'old.env'));
  assert.deepEqual(service.clean([id])[0]?.missing, ['acme-payments/old.env']);
});

test('alerts returns the latest entries from alerts.jsonl', () => {
  const { home, service } = sandbox();
  assert.deepEqual(service.alerts(), []);
  for (let i = 0; i < 5; i++) {
    appendAlert(home, { trapId: `t${i}`, label: '', status: 'active', matched: ['url'], plantedIn: [], method: 'GET', path: '/', clientIp: '', at: '' });
  }
  assert.deepEqual(service.alerts(2).map((a) => a.trapId), ['t3', 't4']);
});

test('concurrent writers from separate processes never lose a trap', async () => {
  const { home, repo } = sandbox();
  const serviceUrl = new URL('../src/service.ts', import.meta.url).href;
  const script = `const { createService } = await import(${JSON.stringify(serviceUrl)});
    const s = createService({ home: ${JSON.stringify(home)}, cwd: ${JSON.stringify(repo)}, baseUrl: 'http://x' });
    for (let i = 0; i < 25; i++) s.issue({});`;
  const run = promisify(execFile);
  await Promise.all(Array.from({ length: 4 }, () => run(process.execPath, ['--input-type=module', '-e', script])));
  assert.equal(readRegistry(home).traps.length, 100);
  assert.ok(!fs.existsSync(path.join(home, 'registry.lock')), 'lock released');
});

test('a stale lock left by a crashed process is taken over', () => {
  const { home, service } = sandbox();
  fs.mkdirSync(home, { recursive: true });
  const lock = path.join(home, 'registry.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  service.issue({});
  assert.equal(service.list().length, 1);
});
