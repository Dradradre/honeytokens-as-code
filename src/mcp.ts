import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { addTrap, cleanTraps, readLock, registerPlacement } from './lock.ts';
import { createTrap } from './trap.ts';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';

const INSTRUCTIONS = `Plants honeytokens (decoy credentials/URLs that raise an alert when used).
Workflow: study the repo's existing .env / config / route naming -> create_webhook_trap with a matching
pathPrefix and tokenPrefix -> write the url and/or token on a single line in a file production code never
reads -> register_planted_token. Never wire a trap into code that runs, and never edit honeytoken.lock by hand.`;

const trapId = z.string().regex(/^[a-z0-9]{20}$/, 'trap ids are 20 lowercase letters/digits');

/** Run a lock/trap operation and turn its result or error into a tool result the agent can read. */
function run(fn: () => unknown): CallToolResult {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(fn(), null, 2) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: (err as Error).message }] };
  }
}

/**
 * The agent decides what the decoy looks like and where it goes; these tools only do the
 * deterministic parts. The alert base URL comes from the environment, never from the agent,
 * so a "realistic" hostname invented by the model cannot silently produce a trap that never fires.
 */
export function createMcpServer(lockPath: string, baseUrl = process.env.HONEYTOKEN_BASE_URL): McpServer {
  const server = new McpServer({ name: 'honeytoken-mcp', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  server.registerTool(
    'create_webhook_trap',
    {
      title: 'Create webhook trap',
      description:
        'Issue a new trap: a unique URL and a fake secret token. Any request to the URL, or any request ' +
        'carrying the token, raises an alert. Shape it to blend in with the repo, then plant it and call ' +
        'register_planted_token.',
      inputSchema: {
        label: z.string().max(100).optional().describe('Private note for the owner, e.g. "legacy billing key in .env.example". Not planted.'),
        pathPrefix: z.string().optional().describe('URL path before the trap id, modelled on the repo\'s routes, e.g. /api/v2/billing/webhook. Default /v1/hooks.'),
        tokenPrefix: z.string().optional().describe('Prefix that makes the token look like the repo\'s real keys, e.g. sk_live_, ghp_, xoxb-. Up to 32 chars of [A-Za-z0-9._-].'),
        tokenLength: z.number().int().min(16).max(128).optional().describe('Length of the random part. Default 32.'),
        tokenCharset: z.enum(['alnum', 'hex']).optional().describe('Alphabet of the random part. Default alnum.'),
      },
    },
    (args) =>
      run(() => {
        const trap = createTrap({ ...args, baseUrl: baseUrl ?? DEFAULT_BASE_URL });
        addTrap(lockPath, trap);
        return {
          id: trap.id,
          url: trap.url,
          token: trap.token,
          next: 'Plant the url and/or token on one line, then call register_planted_token with this id and the file path.',
          ...(baseUrl ? {} : { warning: `HONEYTOKEN_BASE_URL is not set, so the trap points at ${DEFAULT_BASE_URL} and only fires on this machine.` }),
        };
      }),
  );

  server.registerTool(
    'register_planted_token',
    {
      title: 'Register planted token',
      description:
        'Record where a trap was planted. The tool reads the file and finds the lines holding the trap itself; ' +
        'it fails if the trap is not in the file yet. Call again after moving the trap within a file.',
      inputSchema: {
        id: trapId.describe('Trap id from create_webhook_trap.'),
        file: z.string().min(1).describe('File the trap was written to, relative to the repo root (or absolute inside it).'),
        line: z.number().int().positive().optional().describe('Optional check: fail unless the trap is on this 1-based line.'),
      },
    },
    ({ id, file, line }) => run(() => ({ id, placements: registerPlacement(lockPath, id, file, line) })),
  );

  server.registerTool(
    'list_traps',
    {
      title: 'List traps',
      description: 'List traps in honeytoken.lock with their URL and where each is planted. Tokens are not returned.',
      annotations: { readOnlyHint: true },
    },
    () =>
      run(() =>
        readLock(lockPath).traps.map(({ id, label, url, createdAt, placements }) => ({
          id,
          label,
          url,
          createdAt,
          placements: placements.map((p) => `${p.file}:${p.line}`),
        })),
      ),
  );

  server.registerTool(
    'clean_traps',
    {
      title: 'Clean traps',
      description:
        'Delete every line holding the given traps from their recorded files and drop the traps from the lock. ' +
        'Use dryRun first to show the user what will be removed.',
      inputSchema: {
        ids: z.array(trapId).optional().describe('Traps to remove.'),
        all: z.boolean().optional().describe('Remove every trap in the lock instead of listing ids.'),
        dryRun: z.boolean().optional().describe('Report what would be removed without changing anything.'),
      },
      annotations: { destructiveHint: true },
    },
    ({ ids, all, dryRun }) =>
      run(() => {
        if (all === (ids !== undefined && ids.length > 0)) throw new Error('pass either ids or all: true');
        return { dryRun: dryRun ?? false, results: cleanTraps(lockPath, all ? 'all' : ids!, { dryRun }) };
      }),
  );

  return server;
}

export async function startMcpServer(lockPath: string): Promise<void> {
  // stdout carries the protocol; anything human-readable must go to stderr.
  await createMcpServer(lockPath).connect(new StdioServerTransport());
  console.error(`honeytoken-mcp ready (lock: ${lockPath})`);
}
