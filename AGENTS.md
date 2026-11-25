# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor, ...) working **on this repository**.
For the playbook agents follow when **using** honeytoken-mcp in someone else's repo, see
`skills/honeytoken-planting/SKILL.md`.

## What this project is

honeytoken-mcp lets a coding agent plant realistic decoy credentials and URLs in a repo and alerts the owner
when one is used. The split of work is the whole design:

- **The agent is the brain.** It reads the repo, chooses names and spots, and edits files.
- **This tool is the hands.** It issues traps, verifies placements, keeps `honeytoken.lock`, receives hits and
  forwards alerts. It is deterministic and **never calls an LLM API**. Do not add one.

## Layout

```
src/trap.ts     trap id / URL / token generation (pure, validated input)
src/lock.ts     honeytoken.lock read/write, register, clean, .git/info/exclude
src/notify.ts   alert formatting, Slack/Discord forwarding
src/server.ts   HTTP alert server (matches trap id in URL, token anywhere in the request)
src/mcp.ts      MCP server: create_webhook_trap, register_planted_token, list_traps, clean_traps
src/cli.ts      CLI entry: create, register, list, clean, serve, mcp, install-skill
skills/honeytoken-planting/SKILL.md   agent playbook shipped with the package
test/*.test.ts  node:test suites
assets/         README art (hand-written SVG)
```

## Commands

```bash
npm install          # also builds dist/ through the prepare script
npm test             # node --test, runs the TypeScript sources directly
npm run typecheck    # tsc --noEmit
npm run build        # tsc -> dist/
npm run dev -- list  # run the CLI from source
```

Run `npm run typecheck && npm test` before calling a change done.

## Code conventions

- Node >= 22.18, ESM, TypeScript run directly through Node's type stripping. Import local files with the
  `.ts` extension; `tsc` rewrites them to `.js` on build.
- Erasable syntax only (`erasableSyntaxOnly`): no `enum`, `namespace` or constructor parameter properties.
- Core modules (`trap`, `lock`, `notify`, `server`, `cli`) use `node:` built-ins only. The MCP SDK and zod are
  imported only by `src/mcp.ts`, and the CLI loads it lazily. Keep it that way; add a runtime dependency
  only with a strong reason.
- Plain functions over classes. No abstraction until a second real use exists.
- Comments explain why, not what.

## Security invariants (do not break these)

1. **The lock never reaches git.** It maps every trap to its location. First write adds it to
   `.git/info/exclude`, never to `.gitignore` (a committed ignore entry would reveal that traps exist).
2. **The agent never chooses the alert host.** `baseUrl` comes from `HONEYTOKEN_BASE_URL` or the CLI flag, so a
   model cannot invent a plausible hostname that silently never fires.
3. **Placements are verified, not trusted.** `register` reads the file and finds the lines itself, and refuses
   paths outside the lock's directory.
4. **Request data is hostile.** Anything from an HTTP request is clipped, kept inside code spans with backticks
   removed, escaped for Slack, and sent to Discord with mentions disabled.
5. **Answer like a dull API.** Hits get `401 {"error":"unauthorized"}`, everything else `404`. No banner,
   no version, no health endpoint.
6. **stdout belongs to MCP** while `honeytoken mcp` runs. Log to stderr.
7. **Do not echo tokens without a reason.** `list_traps` returns locations, not tokens.
8. **Trap values live on a single line.** `clean` deletes whole lines that contain a trap id or token.

## Tests

- `node:test` with `node:assert/strict`. Each test makes its own temp dir with `fs.mkdtempSync`; never write a
  `honeytoken.lock` into the repo.
- Servers listen on port 0. MCP tools are tested through `InMemoryTransport`, plus one stdio round trip of the
  real CLI.
- New behaviour gets a test; a bug fix gets a test that failed before the fix.

## When you change...

- **an MCP tool** (name, input, output): update `SKILL.md`, both READMEs and `test/mcp.test.ts`.
- **CLI flags:** update the usage text in `src/cli.ts` and the CLI tables in both READMEs.
- **README.md:** make the same change in `README.ko.md`.
- **the lock format:** bump `version` in `LockFile` and handle the old version on read.

## Git

Do not commit, push or tag unless asked. Commit messages: imperative mood, explain why.
