import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { Alert } from '../src/core/types.ts';
import { serve } from '../src/server.ts';
import { sandbox } from './helpers.ts';

test('node adapter: live and retired traps alert, noise does not, new traps need no restart', async () => {
  const { home, write, service } = sandbox();
  const first = service.issue({ label: 'billing key' });
  write('.env.legacy', `BILLING_KEY=${first.token}\n`);
  service.register(first.id, '.env.legacy');

  const alerts: Alert[] = [];
  const server = await serve({ home, port: 0, onAlert: (a) => void alerts.push(a) });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const settle = () => new Promise((r) => setImmediate(r));

  try {
    const noise = await fetch(`${base}/wp-login.php`);
    assert.equal(noise.status, 404);
    assert.equal(noise.headers.get('server'), null, 'no server banner');

    assert.equal((await fetch(base + new URL(first.url).pathname)).status, 401);
    await fetch(`${base}/v1/charges`, { method: 'POST', headers: { authorization: `Bearer ${first.token}` }, body: 'amount=1' });

    const second = service.issue({}); // created while the server runs
    await fetch(`${base}/x?key=${second.token}`);

    service.clean([first.id]); // retired, still watched
    await fetch(base + new URL(first.url).pathname);
    await settle();
  } finally {
    server.close();
  }

  assert.deepEqual(
    alerts.map((a) => [a.matched.join('+'), a.status]),
    [['url', 'active'], ['token', 'active'], ['token', 'active'], ['url', 'retired']],
  );
  assert.deepEqual(alerts[0]?.plantedIn, ['acme-payments/.env.legacy:1']);
  assert.equal(alerts[0]?.clientIp.replace('::ffff:', ''), '127.0.0.1');
});

test('default pipeline logs every hit to alerts.jsonl', async () => {
  const { home, service } = sandbox();
  const { url } = service.issue({});
  const original = console.log;
  console.log = () => {};
  // Never let a test reach a real Slack or Discord configured in the developer's shell.
  delete process.env.HONEYTOKEN_SLACK_WEBHOOK;
  delete process.env.HONEYTOKEN_DISCORD_WEBHOOK;
  const server = await serve({ home, port: 0 });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (let i = 0; i < 3; i++) await fetch(base + new URL(url).pathname);
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    server.close();
    console.log = original;
  }
  assert.equal(service.alerts().length, 3);
});
