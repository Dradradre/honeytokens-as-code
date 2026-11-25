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

test('cooldown: one alert per trap and address; the next alert on the trap counts what was held back', async () => {
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
    ['198.51.100.9', 'active', 2], // the two repeats from .47, reported on the trap's next alert
    ['203.0.113.47', 'retired', undefined],
    ['203.0.113.47', 'active', undefined],
  ]);
});

test('per-trap cap: an intruder rotating addresses cannot flood the channels', async () => {
  let clock = 0;
  const sent: Alert[] = [];
  const dispatch = createDispatcher({ notifiers: [async (a) => void sent.push(a)], cooldownMs: 1000, maxPerTrap: 3, now: () => clock });

  for (let i = 0; i < 20_000; i++) await dispatch(alert({ clientIp: `2001:db8::${i.toString(16)}` }));
  assert.equal(sent.length, 3);
  await dispatch(alert({ trapId: 'another-trap', clientIp: '2001:db8::1' }));
  assert.equal(sent.length, 4, 'other traps keep their own budget');

  clock = 1000;
  await dispatch(alert({ clientIp: '203.0.113.99' }));
  assert.equal(sent.at(-1)?.suppressed, 19_997, 'the next alert reports everything held back');
});

test('held-back hits come out as one summary when the window closes, not on some later alert', async () => {
  let clock = 0;
  const timers: { run: () => void; at: number }[] = [];
  const sent: Alert[] = [];
  const dispatch = createDispatcher({
    notifiers: [async (a) => void sent.push(a)],
    cooldownMs: 1000,
    now: () => clock,
    schedule: (run, delay) => void timers.push({ run, at: clock + delay }),
  });

  await dispatch(alert({ path: 'sts GetCallerIdentity' }));
  clock = 100;
  await dispatch(alert({ path: 's3 ListBuckets -> AccessDenied' }));
  clock = 200;
  await dispatch(alert({ path: 'iam CreateUser -> AccessDenied' }));
  assert.equal(sent.length, 1, 'repeats held back during the window');
  assert.equal(timers.length, 1, 'one summary scheduled per window');
  assert.equal(timers[0]?.at, 1000, 'at the end of the window');

  timers[0]!.run();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual([sent[1]?.path, sent[1]?.suppressed], ['iam CreateUser -> AccessDenied', 2], 'latest held-back hit plus the count');

  clock = 1500;
  await dispatch(alert({ path: 'later' }));
  assert.equal(sent[2]?.suppressed, undefined, 'the summary already accounted for them');
});

test('flush sends pending summaries now (for one-shot runs) and nothing when there are none', async () => {
  const sent: Alert[] = [];
  const dispatch = createDispatcher({ notifiers: [async (a) => void sent.push(a)], schedule: () => {} });
  await dispatch.flush();
  assert.equal(sent.length, 0);
  await dispatch(alert());
  await dispatch(alert({ path: '/second' }));
  await dispatch(alert({ path: '/third' }));
  await dispatch.flush();
  assert.deepEqual(sent.map((a) => [a.path, a.suppressed]), [[alert().path, undefined], ['/third', 2]]);
  await dispatch.flush();
  assert.equal(sent.length, 2, 'flush is idempotent');
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
