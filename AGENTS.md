# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor, ...) working **on this repository**.
For the playbook agents follow when **using** honeytoken-mcp in someone else's repo, see
`skills/honeytoken-planting/SKILL.md`.

## What this project is

honeytoken-mcp lets a coding agent plant realistic decoy credentials and URLs in a repo and alerts the owner
when one is used. The split of work is the whole design:

- **The agent is the brain.** It reads the repo, chooses names and spots, and edits files.
- **This tool is the hands.** It issues traps, verifies placements, keeps the registry, receives hits and
  forwards alerts. It is deterministic and **never calls an LLM API**. Do not add one.

## Layout and layers

```
src/
  core/            Web-standard APIs only. Runs on Node, Cloudflare Workers, Deno, Bun.
    types.ts       Trap, Placement, Alert, Notifier
    trap.ts        generateTrap(): ids, URLs, tokens (Web Crypto)
    match.ts       lineHasTrap(), trapsIn()
    handle.ts      handle(Request) -> Response, emits Alerts
    format.ts      formatAlert(), describePlacements()
    index.ts       public API, exported as `honeytoken-mcp/core`
  notify/          one file per channel + index.ts (dispatcher, cooldown, notifiersFromEnv)
  store.ts         ~/.honeytoken: registry.json (locked, atomic) and alerts.jsonl
  service.ts       createService(): issue / register / list / clean / alerts. Every rule lives here.
  server.ts        node:http adapter around core/handle
  mcp.ts, cli.ts   thin shells over the service
skills/honeytoken-planting/SKILL.md   agent playbook shipped with the package
test/              node:test suites, one per layer, plus helpers.ts (sandbox repo + home)
assets/            README art (hand-written SVG)
```

Dependencies point one way: `cli / mcp / server -> service -> store -> core`, and `notify -> core`.
`core` imports nothing outside `core`.

| Seam | Contract | To extend |
|---|---|---|
| Alert channel | `Notifier = (alert) => Promise<void>` | add `src/notify/<name>.ts`, wire it in `notifiersFromEnv` |
| Runtime | `handle(Request, { traps, onAlert, clientIp }) => Response` | write an adapter like `server.ts` (e.g. a Worker) |
| Entry point | `createService()` | call it; never reach into `store.ts` from a shell |

Not abstracted on purpose: trap kinds (only `webhook` exists; extract an interface when the second kind
lands) and storage (one JSON file; `store.ts` is plain functions).

## Commands

```bash
npm install          # also builds dist/ through the prepare script
npm test             # node --test, runs the TypeScript sources directly
npm run typecheck    # tsc --noEmit
npm run build        # tsc -> dist/ with .d.ts
npm run dev -- list  # run the CLI from source
```

Run `npm run typecheck && npm test` before calling a change done.

## Code conventions

- Node >= 22.18, ESM, TypeScript run directly through Node's type stripping. Import local files with the
  `.ts` extension; `tsc` rewrites them to `.js` on build.
- Erasable syntax only (`erasableSyntaxOnly`): no `enum`, `namespace` or constructor parameter properties.
- `src/core` must not use `node:` modules, `Buffer` or `process`. A test enforces it.
- Runtime dependencies are the MCP SDK and zod, imported only by `src/mcp.ts`, which the CLI loads lazily.
  Add another only with a strong reason.
- Plain functions over classes. Add an interface only where a second implementation exists or is the point
  of the seam (see the table above).
- Comments explain why, not what.

## Security invariants (do not break these)

1. **Nothing but the decoy touches the target repo.** Registry and alert log live in `HONEYTOKEN_HOME`
   (default `~/.honeytoken`, mode 0700/0600). No lock file, ignore entry, config or skill in the repo.
2. **The agent never chooses the alert host.** `baseUrl` comes from `HONEYTOKEN_BASE_URL` or the CLI flag;
   the MCP tools have no such input.
3. **Placements are verified, not trusted.** `register` reads the file and finds the lines itself. The repo is
   found from the file, not the working directory. Refused: files outside a git repository, inside `.git`, or
   whose real path (symlinks resolved) leaves the repo. `clean` re-checks the real path before writing.
4. **Cleaning retires, it does not forget.** Retired traps stay in the registry and keep alerting, because
   history and old clones still carry the decoy.
5. **Request data is hostile.** It is clipped in `handle`, kept inside code spans with backticks removed,
   escaped for Slack, sent to Discord with mentions disabled, and labelled untrusted when `list_alerts`
   hands it to an agent.
6. **Answer like a dull API.** Hits get `401 {"error":"unauthorized"}`, everything else `404`. No banner,
   no version, no health endpoint.
7. **stdout belongs to MCP** while `honeytoken mcp` runs. Log to stderr.
8. **Tokens are not echoed** by `list` or `list_traps`.
9. **Trap values live on a single line.** `clean` deletes whole lines that contain a trap id or token.
10. **Registry writes hold the lock.** Go through `updateRegistry`; never write `registry.json` directly.
11. **Alert volume is bounded.** Per trap and address one alert per cooldown, per trap at most `maxPerTrap` per
    window, a capped address map, and an alert log that rotates at `MAX_ALERT_LOG_BYTES`.
12. **Client addresses come from the socket** unless the operator names a header with `--trust-proxy`.
    `X-Forwarded-For` is read from the right: the hop our proxy appended, not what the client wrote.

## Tests

- `node:test` with `node:assert/strict`. Use `sandbox()` from `test/helpers.ts`: a temp repo with `.git`
  and a temp home. Never touch the real `~/.honeytoken`.
- Core is tested with plain `Request` objects, no sockets. Servers listen on port 0. MCP tools go through
  `InMemoryTransport`, plus one stdio round trip of the real CLI.
- Notifiers take an injectable `fetch`; tests must never reach a real webhook.
- New behaviour gets a test; a bug fix gets a test that failed before the fix.

## When you change...

- **an MCP tool** (name, input, output): update `SKILL.md`, both READMEs and `test/mcp.test.ts`.
- **CLI flags:** update the usage text in `src/cli.ts` and the CLI blocks in both READMEs.
- **the alert format:** update the "Anatomy of an alert" blocks in both READMEs and `assets/demo.svg`.
- **README.md:** make the same change in `README.ko.md`.
- **the registry format:** bump `version` in `Registry` and read the old version.

## Git

Do not commit, push or tag unless asked. Commit messages: imperative mood, explain why.
