import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (file: string) => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

test('server.json (MCP Registry) agrees with package.json, or the release workflow would fail after npm publish', () => {
  const pkg = read('package.json');
  const server = read('server.json');
  assert.equal(server.name, pkg.mcpName);
  assert.match(server.name, /^io\.github\.Dradradre\//, 'GitHub OIDC grants io.github.<owner>/* with the owner as GitHub spells it');
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].version, pkg.version);
  assert.ok(server.description.length <= 100, 'the registry rejects descriptions over 100 characters');
});
