import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { addTrap, cleanTraps, readLock, registerPlacement } from '../src/lock.ts';
import type { Alert } from '../src/notify.ts';
import { formatAlert } from '../src/notify.ts';
import { startServer } from '../src/server.ts';
import { createTrap } from '../src/trap.ts';

function tempRepo(): { root: string; lock: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honeytoken-'));
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  return { root, lock: path.join(root, 'honeytoken.lock') };
}

test('createTrap follows the requested style', () => {
  const trap = createTrap({
    baseUrl: 'https://hooks.example.com/',
    pathPrefix: '/api/v2/billing/callback',
    tokenPrefix: 'sk_live_',
    tokenLength: 24,
    tokenCharset: 'hex',
  });
  assert.match(trap.id, /^[a-z0-9]{20}$/);
  assert.equal(trap.url, `https://hooks.example.com/api/v2/billing/callback/${trap.id}`);
  assert.match(trap.token, /^sk_live_[0-9a-f]{24}$/);
  assert.throws(() => createTrap({ baseUrl: 'http://x', pathPrefix: '/../etc' }));
  assert.throws(() => createTrap({ baseUrl: 'http://x', tokenLength: 8 }));
});

test('register finds the lines itself and rejects unplanted or outside files', () => {
  const { root, lock } = tempRepo();
  const trap = createTrap({ baseUrl: 'http://127.0.0.1:8787' });
  addTrap(lock, trap);

  fs.writeFileSync(path.join(root, '.env.example'), `DB_HOST=localhost\nBILLING_API_KEY=${trap.token}\n`);
  assert.deepEqual(
    registerPlacement(lock, trap.id, '.env.example').map((p) => p.line),
    [2],
  );
  assert.throws(() => registerPlacement(lock, trap.id, '.env.example', 1), /does not hold/);

  fs.writeFileSync(path.join(root, 'empty.txt'), 'nothing here\n');
  assert.throws(() => registerPlacement(lock, trap.id, 'empty.txt'), /not found/);
  assert.throws(() => registerPlacement(lock, trap.id, '../outside.txt'), /outside/);

  assert.equal(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), '/honeytoken.lock\n');
});

test('clean removes only trap lines and forgets the trap', () => {
  const { root, lock } = tempRepo();
  const keep = createTrap({ baseUrl: 'http://127.0.0.1:8787', label: 'keep' });
  const drop = createTrap({ baseUrl: 'http://127.0.0.1:8787', label: 'drop' });
  addTrap(lock, keep);
  addTrap(lock, drop);

  const file = path.join(root, '.env');
  fs.writeFileSync(file, `A=1\nOLD_WEBHOOK=${drop.url}\nB=2\nOTHER=${keep.token}\n`);
  registerPlacement(lock, drop.id, '.env');
  registerPlacement(lock, keep.id, '.env');

  const preview = cleanTraps(lock, [drop.id], { dryRun: true });
  assert.deepEqual(preview[0]?.removed, [{ file: '.env', lines: [2] }]);
  assert.equal(readLock(lock).traps.length, 2);

  cleanTraps(lock, [drop.id]);
  assert.equal(fs.readFileSync(file, 'utf8'), `A=1\nB=2\nOTHER=${keep.token}\n`);
  assert.deepEqual(readLock(lock).traps.map((t) => t.label), ['keep']);
  assert.throws(() => cleanTraps(lock, ['nope']), /no trap/);
});

test('server alerts on trap url or token and stays quiet otherwise', async () => {
  const { root, lock } = tempRepo();
  const trap = createTrap({ baseUrl: 'http://127.0.0.1', label: 'billing key' });
  addTrap(lock, trap);
  fs.writeFileSync(path.join(root, '.env'), `BILLING_API_KEY=${trap.token}\n`);
  registerPlacement(lock, trap.id, '.env');

  const alerts: Alert[] = [];
  const server = await startServer({ lockPath: lock, port: 0, onAlert: (a) => void alerts.push(a) });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    assert.equal((await fetch(`${base}/random/path`)).status, 404);
    assert.equal((await fetch(base + new URL(trap.url).pathname)).status, 401);
    await fetch(`${base}/v1/charges`, { headers: { authorization: `Bearer ${trap.token}` } });
    const basic = Buffer.from(`api:${trap.token}`).toString('base64');
    await fetch(`${base}/v1/charges`, { method: 'POST', headers: { authorization: `Basic ${basic}` } });
    await new Promise((r) => setImmediate(r));
  } finally {
    server.close();
  }

  assert.equal(alerts.length, 3);
  assert.deepEqual(alerts.map((a) => a.matched), [['url'], ['token'], ['token']]);
  assert.deepEqual(alerts[0]?.plantedIn, ['.env:1']);
});

test('formatAlert keeps attacker input inside code spans', () => {
  const text = formatAlert({
    trapId: 'abc',
    label: 'x',
    matched: ['url'],
    plantedIn: [],
    method: 'GET',
    path: '/a`<!channel>`\n@everyone',
    remoteAddress: '1.2.3.4',
    at: 'now',
  });
  const requestLine = text.split('\n').find((l) => l.startsWith('request:'));
  assert.equal(requestLine, "request: `GET /a'<!channel>' @everyone`");
});
