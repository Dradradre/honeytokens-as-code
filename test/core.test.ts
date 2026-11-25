import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { assertNoTell, formatAlert, generateWebhookTrap, handle, resolveClientIp, trapsIn, type Alert, type Trap, type WebhookTrap } from '../src/core/index.ts';

const trap = (over: Partial<WebhookTrap> = {}): WebhookTrap => ({
  ...generateWebhookTrap({ baseUrl: 'https://hooks.example.com', label: 'billing key' }),
  placements: [{ repo: '/src/acme-payments', file: 'deploy/legacy/billing.env', line: 7, plantedAt: 'x' }],
  ...over,
});

async function hit(traps: Trap[], input: string, init?: RequestInit) {
  const alerts: Alert[] = [];
  const res = await handle(new Request(new URL(input, 'https://hooks.example.com'), init), {
    traps: () => traps,
    onAlert: (a) => void alerts.push(a),
    clientIp: '203.0.113.47',
  });
  return { status: res.status, body: await res.json(), alerts };
}

test('core uses Web-standard APIs only, so it runs outside Node', () => {
  for (const file of fs.readdirSync(new URL('../src/core/', import.meta.url))) {
    const source = fs.readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]node:|require\(|\bBuffer\b|process\./, `src/core/${file}`);
  }
});

test('generateWebhookTrap follows the requested style and rejects bad input', () => {
  const t = generateWebhookTrap({
    baseUrl: 'https://hooks.example.com/',
    pathPrefix: '/api/v2/billing/callback',
    tokenPrefix: 'pgw_live_',
    tokenLength: 24,
    tokenCharset: 'hex',
  });
  assert.match(t.id, /^[a-z0-9]{20}$/);
  assert.equal(t.url, `https://hooks.example.com/api/v2/billing/callback/${t.id}`);
  assert.match(t.token, /^pgw_live_[0-9a-f]{24}$/);
  assert.equal(t.status, 'active');
  assert.deepEqual(t.spec, { pathPrefix: '/api/v2/billing/callback', tokenPrefix: 'pgw_live_', tokenLength: 24, tokenCharset: 'hex' });
  assert.throws(() => generateWebhookTrap({ baseUrl: 'http://x', pathPrefix: '/../etc' }));
  assert.throws(() => generateWebhookTrap({ baseUrl: 'http://x', tokenLength: 8 }));
  assert.throws(() => generateWebhookTrap({ baseUrl: 'http://x', tokenPrefix: 'a b' }));
  assert.throws(() => generateWebhookTrap({ baseUrl: 'javascript:alert(1)' }), /http\(s\)/);
  assert.throws(() => generateWebhookTrap({ baseUrl: 'ftp://hooks.example.com' }), /http\(s\)/);
});

test('known provider key formats are refused unless the operator overrides', () => {
  for (const prefix of ['sk_live_', 'rk_test_', 'ghp_', 'github_pat_', 'glpat-', 'xoxb-', 'AKIA', 'sk-ant-', 'sk-proj-', 'sk-', 'SG.', 'npm_', 'AIza', 'hf_']) {
    assert.throws(() => generateWebhookTrap({ baseUrl: 'http://x', tokenPrefix: prefix }), /imitates/, prefix);
  }
  assert.match(generateWebhookTrap({ baseUrl: 'http://x', tokenPrefix: 'sk_live_', allowProviderPrefix: true }).token, /^sk_live_/);
  for (const prefix of ['pgw_live_', 'acme_int_', 'sk-billing-', 'skl_', '']) {
    assert.doesNotThrow(() => generateWebhookTrap({ baseUrl: 'http://x', tokenPrefix: prefix }), prefix);
  }
});

test('names that give a decoy away are refused, look-alike words are not', () => {
  for (const tell of ['/v1/honeypot', '/canary/hooks', 'decoy_', 'fake-', 'fakeKey', 'svc-trap', 'honeytoken', 'canarytokens', 'TRAP_']) {
    assert.throws(() => assertNoTell(tell, 'x'), /gives the decoy away/, tell);
  }
  for (const fine of ['/api/v2/bootstrap', 'honeycomb_', '/trapezoid', 'svc-billing-export', 'pgw_live_', 'baitulmal']) {
    assert.doesNotThrow(() => assertNoTell(fine, 'x'), fine);
  }
  assert.throws(() => generateWebhookTrap({ baseUrl: 'http://x', pathPrefix: '/internal/honeypot' }), /gives the decoy away/);
});

test('resolveClientIp trusts a proxy header only when told to', () => {
  const h = new Headers({ 'x-forwarded-for': '6.6.6.6, 203.0.113.47', 'cf-connecting-ip': '198.51.100.9' });
  assert.equal(resolveClientIp(h, '127.0.0.1'), '127.0.0.1', 'untrusted by default: the header is forgeable');
  assert.equal(resolveClientIp(h, '127.0.0.1', 'x-forwarded-for'), '203.0.113.47', 'the hop our proxy appended, not the forged left part');
  assert.equal(resolveClientIp(h, '127.0.0.1', 'CF-Connecting-IP'), '198.51.100.9');
  assert.equal(resolveClientIp(new Headers(), '127.0.0.1', 'x-forwarded-for'), '127.0.0.1', 'request that bypassed the proxy');
});

test('random parts use the whole alphabet', () => {
  const seen = new Set(Array.from({ length: 200 }, () => generateWebhookTrap({ baseUrl: 'http://x' }).token).join(''));
  assert.equal(seen.size, 62);
});

test('trapsIn reports what gave each trap away', () => {
  const a = trap();
  const b = trap();
  assert.deepEqual(
    trapsIn(`GET /x/${a.id}\nAuthorization: Bearer ${a.token}\n${b.token}`, [a, b]).map((h) => [h.trap.id, h.matched]),
    [[a.id, ['url', 'token']], [b.id, ['token']]],
  );
  assert.deepEqual(trapsIn('nothing here', [a, b]), []);
});

test('handle: trap URL, header, Basic auth, query and body all fire; noise does not', async () => {
  const t = trap();
  const basic = btoa(`api:${t.token}`);

  const noise = await hit([t], '/wp-login.php');
  assert.deepEqual([noise.status, noise.body, noise.alerts.length], [404, { error: 'not_found' }, 0]);

  const viaUrl = await hit([t], new URL(t.url).pathname);
  assert.deepEqual([viaUrl.status, viaUrl.body, viaUrl.alerts[0]?.matched], [401, { error: 'unauthorized' }, ['url']]);

  for (const init of [
    { headers: { 'x-api-key': t.token } },
    { headers: { authorization: `Basic ${basic}` } },
    { method: 'POST', body: JSON.stringify({ api_key: t.token }) },
  ] as RequestInit[]) {
    assert.deepEqual((await hit([t], '/v1/charges', init)).alerts[0]?.matched, ['token']);
  }
  assert.equal((await hit([t], `/v1/charges?key=${t.token}`)).alerts.length, 1);
});

test('handle: alert carries placement, status, bot hint, and clipped request fields', async () => {
  const t = trap({ status: 'retired' });
  const { alerts } = await hit([t], `/${t.id}/${'a'.repeat(1000)}`, {
    headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
  });
  const [a] = alerts;
  assert.ok(a);
  assert.deepEqual(a.plantedIn, ['acme-payments/deploy/legacy/billing.env:7']);
  assert.equal(a.status, 'retired');
  assert.equal(a.botHint, 'Slack link preview');
  assert.equal(a.clientIp, '203.0.113.47');
  assert.ok(a.path.length <= 303);
});

test('formatAlert keeps attacker input inside code spans and flags retired traps', () => {
  const text = formatAlert({
    trapId: 'abc',
    label: 'x',
    status: 'retired',
    matched: ['url'],
    plantedIn: [],
    method: 'GET',
    path: '/a`<!channel>` @everyone',
    clientIp: '1.2.3.4',
    suppressed: 3,
    at: 'now',
  });
  assert.match(text, /^\[honeytoken\] trap triggered: x \(retired trap\)/);
  assert.match(text, /\nrequest: `GET \/a'<!channel>' @everyone`\n/);
  assert.match(text, /suppressed: 3 more hits/);
});
