import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Alert } from '../src/core/types.ts';
import { createDispatcher, discord, slack } from '../src/notify/index.ts';

const alert = (over: Partial<Alert> = {}): Alert => ({
  trapId: 'k3v9q2m8x1t7w0p4z6rb',
  label: 'legacy billing key',
  status: 'active',
  matched: ['url'],
  plantedIn: ['acme-payments/deploy/legacy/billing.env:7'],
  method: 'GET',
  path: '/a<!channel>@everyone',
  clientIp: '203.0.113.47',
  at: 'now',
  ...over,
});

function fakeFetch(status = 200) {
  const calls: { url: string; body: any }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls, impl };
}

test('cooldown: one alert per trap and address, then a count of what was held back', async () => {
  let clock = 0;
  const sent: Alert[] = [];
  const logged: Alert[] = [];
  const dispatch = createDispatcher({
    notifiers: [async (a) => void sent.push(a)],
    log: (a) => logged.push(a),
    cooldownMs: 1000,
    now: () => clock,
  });

  await dispatch(alert());
  await dispatch(alert());
  await dispatch(alert());
  await dispatch(alert({ clientIp: '198.51.100.9' })); // another address is not throttled
  await dispatch(alert({ status: 'retired' })); // retirement is news, not a repeat
  clock = 1500;
  await dispatch(alert());

  assert.equal(logged.length, 6, 'every hit is logged');
  assert.deepEqual(sent.map((a) => [a.clientIp, a.status, a.suppressed]), [
    ['203.0.113.47', 'active', undefined],
    ['198.51.100.9', 'active', undefined],
    ['203.0.113.47', 'retired', undefined],
    ['203.0.113.47', 'active', 2],
  ]);
});

test('a failing notifier does not stop the others', async () => {
  const sent: string[] = [];
  const dispatch = createDispatcher({
    notifiers: [async () => { throw new Error('boom'); }, async (a) => void sent.push(a.trapId)],
  });
  const original = console.error;
  console.error = () => {};
  try {
    await dispatch(alert());
  } finally {
    console.error = original;
  }
  assert.equal(sent.length, 1);
});

test('slack escapes mention and link syntax', async () => {
  const { calls, impl } = fakeFetch();
  await slack('https://hooks.slack.com/services/x', impl)(alert());
  assert.match(calls[0]?.body.text, /&lt;!channel&gt;/);
  assert.doesNotMatch(calls[0]?.body.text, /<!channel>/);
});

test('discord disables mentions and stays under the length limit', async () => {
  const { calls, impl } = fakeFetch();
  await discord('https://discord.com/api/webhooks/x', impl)(alert({ path: 'x'.repeat(5000) }));
  assert.deepEqual(calls[0]?.body.allowed_mentions, { parse: [] });
  assert.ok(calls[0]!.body.content.length <= 1900);
});

test('a webhook error surfaces as a rejected notifier', async () => {
  const { impl } = fakeFetch(500);
  await assert.rejects(slack('https://hooks.slack.com/services/x', impl)(alert()), /answered 500/);
});
