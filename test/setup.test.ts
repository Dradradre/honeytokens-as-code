import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { iamPolicy, init, mcpCommand, workflowTemplate, type CommandRunner } from '../src/setup.ts';
import { PACKAGE_NAME, VERSION } from '../src/version.ts';

/** Records every call; answers from a table keyed by "cmd sub sub". Never runs a real program. */
function fakeRunner(answers: Record<string, { code: number; stdout?: string; stderr?: string; missing?: boolean }>) {
  const calls: string[][] = [];
  const run: CommandRunner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args.slice(0, 2)].join(' ');
    const answer = answers[key] ?? answers[cmd] ?? { code: 0 };
    return { stdout: '', stderr: '', ...answer };
  };
  return { run, calls };
}

const skillsDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'honeytoken-skills-'));

test('init: installs the skill, registers the MCP server at user scope, reports the AWS account', async () => {
  const dir = skillsDir();
  const { run, calls } = fakeRunner({
    'claude mcp get': { code: 1, stderr: 'No MCP server found' },
    'aws sts get-caller-identity': { code: 0, stdout: JSON.stringify({ Account: '123456789012' }) },
  });
  const steps = await init({ cliPath: '/opt/tool/dist/cli.js', run, skillsDir: dir, baseUrl: 'https://hooks.example.com' });

  assert.ok(fs.existsSync(path.join(dir, 'honeytoken-planting', 'SKILL.md')));
  const add = calls.find((c) => c[0] === 'claude' && c[2] === 'add');
  assert.deepEqual(add, [
    'claude', 'mcp', 'add', '--scope', 'user', 'honeytoken', '-e', 'HONEYTOKEN_BASE_URL=https://hooks.example.com',
    '--', 'node', '/opt/tool/dist/cli.js', 'mcp',
  ]);
  assert.deepEqual(steps.map((s) => [s.step, s.status]), [
    ['skill', 'done'], ['mcp', 'done'], ['aws', 'done'], ['alerts', 'info'], ['next', 'info'],
  ]);
  assert.match(steps[2]!.detail, /123456789012/);
});

test('init leaves an existing registration alone and works without Claude Code or the AWS CLI', async () => {
  const already = fakeRunner({ 'claude mcp get': { code: 0 }, aws: { code: 0, missing: true } });
  const a = await init({ cliPath: '/x/cli.js', run: already.run, skillsDir: skillsDir() });
  assert.equal(a.find((s) => s.step === 'mcp')?.status, 'already');
  assert.ok(!already.calls.some((c) => c[2] === 'add'), 'no second registration');
  assert.match(a.find((s) => s.step === 'aws')!.detail, /webhook traps only/);
  assert.match(a.find((s) => s.step === 'alerts')!.detail, /only fire on this machine/);

  const none = fakeRunner({ claude: { code: 0, missing: true }, aws: { code: 255, stderr: 'Unable to locate credentials' } });
  const b = await init({ cliPath: '/x/cli.js', run: none.run, skillsDir: skillsDir() });
  const mcp = b.find((s) => s.step === 'mcp')!;
  assert.equal(mcp.status, 'skipped');
  assert.deepEqual(JSON.parse(mcp.detail.slice(mcp.detail.indexOf('{'))).mcpServers.honeytoken.args, ['/x/cli.js', 'mcp']);
  assert.match(b.find((s) => s.step === 'aws')!.detail, /not signed in: Unable to locate credentials/);
});

test('init --dry-run changes nothing', async () => {
  const dir = skillsDir();
  const { run, calls } = fakeRunner({ 'claude mcp get': { code: 1 } });
  const steps = await init({ cliPath: '/x/cli.js', run, skillsDir: dir, dryRun: true });
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.ok(!calls.some((c) => c[2] === 'add'));
  assert.match(steps.find((s) => s.step === 'mcp')!.detail, /^would run: claude mcp add --scope user honeytoken/);
});

test('mcpCommand pins the version when running from an npx cache', () => {
  assert.deepEqual(mcpCommand(`/home/me/.npm/_npx/abc/node_modules/${PACKAGE_NAME}/dist/cli.js`), ['npx', '-y', `${PACKAGE_NAME}@${VERSION}`, 'mcp']);
  assert.deepEqual(mcpCommand('/src/tool/dist/cli.js'), ['node', '/src/tool/dist/cli.js', 'mcp'], 'node from PATH survives Node upgrades');
});

test('IAM policies grant exactly what each side needs', () => {
  const issuer = JSON.stringify(iamPolicy('issuer'));
  for (const action of ['iam:CreateUser', 'iam:PutUserPolicy', 'iam:CreateAccessKey', 'iam:DeleteUser', 'sts:GetCallerIdentity']) {
    assert.ok(issuer.includes(action), action);
  }
  assert.ok(!issuer.includes('"*"]') && !issuer.includes('"Action":"*"'), 'no wildcard actions');
  assert.deepEqual((iamPolicy('watcher') as any).Statement[0].Action, ['cloudtrail:LookupEvents', 'ec2:DescribeRegions']);
});

test('workflow template: pinned version, OIDC, cached cursor, watch --once, no decoys in the repo', () => {
  const yaml = workflowTemplate();
  assert.match(yaml, new RegExp(`npx -y ${PACKAGE_NAME}@${VERSION.replace(/\./g, '\\.')} watch --once`));
  assert.match(yaml, /id-token: write/);
  assert.match(yaml, /role-to-assume: \$\{\{ secrets\.HONEYTOKEN_AWS_ROLE \}\}/);
  assert.match(yaml, /HONEYTOKEN_WATCHLIST: \$\{\{ secrets\.HONEYTOKEN_WATCHLIST \}\}/);
  assert.match(yaml, /actions\/cache\/restore@v4[\s\S]*actions\/cache\/save@v4/);
  assert.match(yaml, /PRIVATE ops repository/);
});
