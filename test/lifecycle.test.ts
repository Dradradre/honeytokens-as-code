import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { trapsIn } from '../src/core/match.ts';
import type { WebhookTrap } from '../src/core/types.ts';
import { createService } from '../src/service.ts';
import { readRegistry, updateRegistry } from '../src/store.ts';
import { sandbox } from './helpers.ts';

test('check: ok, moved, gone and missing placements, unplanted traps, rotation age', async () => {
  const { repo, write, service, home } = sandbox();
  const a = service.issue({ label: 'a' });
  const b = service.issue({ label: 'b' });
  const c = service.issue({ label: 'c' });
  const unplanted = service.issue({ label: 'unplanted' });
  write('a.env', `A=${a.token}\n`);
  write('b.env', `B=${b.token}\n`);
  write('c.env', `C=${c.token}\n`);
  for (const [t, f] of [[a, 'a.env'], [b, 'b.env'], [c, 'c.env']] as const) service.register(t.id, f);

  write('a.env', `# moved down\nA=${a.token}\n`); // still there, other line
  write('b.env', 'B=rotated-by-someone\n'); // gone from the file
  fs.rmSync(path.join(repo, 'c.env')); // file deleted
  updateRegistry(home, (r) => {
    r.traps.find((t) => t.id === a.id)!.createdAt = new Date(Date.now() - 200 * 86_400_000).toISOString();
  });

  const byLabel = Object.fromEntries((await service.check()).map((r) => [r.label, r]));
  assert.deepEqual(byLabel.a?.files, [{ file: 'acme-payments/a.env', state: 'moved', lines: [2] }]);
  assert.deepEqual([byLabel.a?.rotationDue, byLabel.a?.needsAttention, byLabel.a?.ageDays], [true, false, 200]);
  assert.equal(byLabel.b?.files[0]?.state, 'gone');
  assert.equal(byLabel.c?.files[0]?.state, 'missing');
  assert.ok(byLabel.b?.needsAttention && byLabel.c?.needsAttention && byLabel.unplanted?.needsAttention);
  assert.equal((await service.check({ maxAgeDays: 365 })).find((r) => r.label === 'a')?.rotationDue, false);
});

test('rotate webhook: same shape and host, new values in the same lines, old trap retired and still watched', async () => {
  const { write, read, service, home } = sandbox();
  const old = service.issue({ label: 'gateway', pathPrefix: '/api/v2/billing/webhook', tokenPrefix: 'pgw_live_', tokenLength: 24 });
  write('deploy/legacy/billing.env', `# Legacy gateway\nBILLING_GATEWAY_URL=${old.url}\nBILLING_GATEWAY_KEY=${old.token}\nKEEP=1\n`);
  service.register(old.id, 'deploy/legacy/billing.env');

  const r = await service.rotate(old.id);
  const traps = readRegistry(home).traps as WebhookTrap[];
  const fresh = traps.find((t) => t.id === r.newId)!;

  assert.equal(read('deploy/legacy/billing.env'), `# Legacy gateway\nBILLING_GATEWAY_URL=${fresh.url}\nBILLING_GATEWAY_KEY=${fresh.token}\nKEEP=1\n`);
  assert.match(fresh.url, /^https:\/\/hooks\.example\.com\/api\/v2\/billing\/webhook\/[a-z0-9]{20}$/);
  assert.match(fresh.token, /^pgw_live_[A-Za-z0-9]{24}$/);
  assert.equal(fresh.label, 'gateway');
  assert.deepEqual(fresh.placements.map((p) => p.line), [2, 3]);
  assert.deepEqual(r.files, [{ file: 'acme-payments/deploy/legacy/billing.env', lines: [2, 3] }]);

  const before = traps.find((t) => t.id === old.id)!;
  assert.equal(before.status, 'retired');
  assert.equal(trapsIn(`GET /x?key=${old.token}`, traps)[0]?.trap.status, 'retired', 'a pre-rotation copy still alerts');
});

test('rotate keeps the original alert host unless a new one is configured', async () => {
  const { write, service, home, repo } = sandbox('https://old-hooks.example.com');
  const old = service.issue({});
  write('a.env', `URL=${old.url}\n`);
  service.register(old.id, 'a.env');

  const unchanged = await createService({ home, cwd: repo }).rotate(old.id);
  const kept = readRegistry(home).traps.find((t) => t.id === unchanged.newId) as WebhookTrap;
  assert.match(kept.url, /^https:\/\/old-hooks\.example\.com\/v1\/hooks\//);

  const moved = await createService({ home, cwd: repo, baseUrl: 'https://new-hooks.example.com' }).rotate(unchanged.newId);
  const next = readRegistry(home).traps.find((t) => t.id === moved.newId) as WebhookTrap;
  assert.match(next.url, /^https:\/\/new-hooks\.example\.com\/v1\/hooks\//);
});

test('rotate refuses retired, unplanted and pre-spec traps', async () => {
  const { write, service, home } = sandbox();
  const unplanted = service.issue({});
  await assert.rejects(service.rotate(unplanted.id), /never planted/);

  const t = service.issue({});
  write('a.env', `K=${t.token}\n`);
  service.register(t.id, 'a.env');
  updateRegistry(home, (r) => {
    delete (r.traps.find((x) => x.id === t.id) as WebhookTrap).spec;
  });
  await assert.rejects(service.rotate(t.id), /predates rotation support/);

  await service.clean([t.id]);
  await assert.rejects(service.rotate(t.id), /retired/);
});

test('rotate leaves a file that became an outside symlink alone', async () => {
  const { repo, root, write, service } = sandbox();
  const t = service.issue({});
  write('a.env', `K=${t.token}\n`);
  service.register(t.id, 'a.env');
  const outside = path.join(root, 'outside.conf');
  fs.writeFileSync(outside, `K=${t.token}\n`);
  fs.rmSync(path.join(repo, 'a.env'));
  fs.symlinkSync(outside, path.join(repo, 'a.env'));

  const r = await service.rotate(t.id);
  assert.deepEqual(r.refused, ['acme-payments/a.env']);
  assert.equal(fs.readFileSync(outside, 'utf8'), `K=${t.token}\n`);
});
