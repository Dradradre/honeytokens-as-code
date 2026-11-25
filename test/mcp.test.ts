import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function tempRepo(): { root: string; lock: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'honeytoken-mcp-'));
  return { root, lock: path.join(root, 'honeytoken.lock') };
}

async function connect(lock: string, baseUrl?: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(lock, baseUrl).connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[])[0]?.text ?? '';
  return { isError: res.isError === true, text, json: res.isError ? undefined : JSON.parse(text) };
}

test('agent flow: create -> plant -> register -> list -> clean', async () => {
  const { root, lock } = tempRepo();
  const client = await connect(lock, 'https://hooks.example.com');

  const created = await call(client, 'create_webhook_trap', {
    label: 'legacy stripe key',
    pathPrefix: '/api/v2/billing/webhook',
    tokenPrefix: 'sk_live_',
  });
  const { id, url, token, warning } = created.json;
  assert.match(url, /^https:\/\/hooks\.example\.com\/api\/v2\/billing\/webhook\/[a-z0-9]{20}$/);
  assert.match(token, /^sk_live_/);
  assert.equal(warning, undefined);

  // Registering before planting must fail: the tool checks the file, not the agent's word.
  const early = await call(client, 'register_planted_token', { id, file: '.env.example' });
  assert.ok(early.isError);

  fs.writeFileSync(path.join(root, '.env.example'), `STRIPE_SECRET_KEY=${token}\n`);
  const registered = await call(client, 'register_planted_token', { id, file: '.env.example', line: 1 });
  assert.deepEqual(registered.json.placements.map((p: { line: number }) => p.line), [1]);

  const listed = await call(client, 'list_traps');
  assert.deepEqual(listed.json[0].placements, ['.env.example:1']);
  assert.ok(!listed.text.includes(token), 'list_traps must not echo tokens');

  const bad = await call(client, 'clean_traps', {});
  assert.ok(bad.isError);

  const preview = await call(client, 'clean_traps', { ids: [id], dryRun: true });
  assert.deepEqual(preview.json.results[0].removed, [{ file: '.env.example', lines: [1] }]);
  assert.ok(fs.readFileSync(path.join(root, '.env.example'), 'utf8').includes(token));

  await call(client, 'clean_traps', { all: true });
  assert.equal(fs.readFileSync(path.join(root, '.env.example'), 'utf8'), '');
  assert.deepEqual((await call(client, 'list_traps')).json, []);

  await client.close();
});

test('rejects malformed input before touching the lock', async () => {
  const { lock } = tempRepo();
  const client = await connect(lock);

  assert.ok((await call(client, 'create_webhook_trap', { tokenLength: 4 })).isError);
  assert.ok((await call(client, 'create_webhook_trap', { pathPrefix: '/../../etc' })).isError);
  assert.ok((await call(client, 'register_planted_token', { id: 'nope', file: 'x' })).isError);
  assert.equal(fs.existsSync(lock), false);

  const created = await call(client, 'create_webhook_trap');
  assert.match(created.json.warning, /HONEYTOKEN_BASE_URL is not set/);

  await client.close();
});

test('`honeytoken mcp` speaks MCP over stdio', async () => {
  const { root } = tempRepo();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    cwd: root,
    env: { ...process.env, HONEYTOKEN_BASE_URL: 'https://hooks.example.com' } as Record<string, string>,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'clean_traps',
    'create_webhook_trap',
    'list_traps',
    'register_planted_token',
  ]);

  await call(client, 'create_webhook_trap');
  assert.ok(fs.existsSync(path.join(root, 'honeytoken.lock')), 'lock is created in the working directory');

  await client.close();
});
