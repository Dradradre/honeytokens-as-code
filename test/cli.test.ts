import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { test } from 'node:test';
import { promisify } from 'node:util';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const run = promisify(execFile);

test('--version prints the package version', async () => {
  for (const flag of ['--version', '-v']) {
    assert.equal((await run(process.execPath, [CLI, flag])).stdout.trim(), pkg.version);
  }
});

test('serve rejects a malformed --trust-proxy before listening', async () => {
  await assert.rejects(run(process.execPath, [CLI, 'serve', '--port', '0', '--trust-proxy', 'x: y']), /takes a header name/);
});
