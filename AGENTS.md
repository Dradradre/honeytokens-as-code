# AGENTS.md

Guidance for coding agents (Claude Code, Codex, Cursor, ...) working **on this repository**.
For the playbook agents follow when **using** honeytoken-mcp in someone else's repo, see
`skills/honeytoken-planting/SKILL.md`.

## What this project is

honeytoken-mcp lets a coding agent plant realistic decoy credentials in a repo and alerts the owner when one
is used. Two kinds of trap: **AWS** (a real access key for an IAM user with an explicit deny-all policy, found in
CloudTrail when used; the established canary design) and **webhook** (a URL on the alert server plus a token,
dressed as an internal service). The split of work is the whole design:

- **The agent is the brain.** It reads the repo, chooses names and spots, and edits files.
- **This tool is the hands.** It issues traps, verifies placements, keeps the registry, receives hits and
  forwards alerts. It is deterministic and **never calls an LLM API**. Do not add one.

## Layout and layers

```
src/
  core/            Web-standard APIs only. Runs on Node, Cloudflare Workers, Deno, Bun.
    types.ts       Trap = WebhookTrap | AwsTrap, Placement, Alert, Notifier
    trap.ts        generateWebhookTrap(), PROVIDER_PREFIXES, assertNoTell() (Web Crypto)
    match.ts       trapMarkers(), lineHasTrap(), trapsIn()
    handle.ts      handle(Request) -> Response, emits Alerts
    format.ts      formatAlert(), describePlacements()
    index.ts       public API, exported as `honeytoken-mcp/core`
  notify/          one file per channel + index.ts (dispatcher, cooldown, notifiersFromEnv)
  store.ts         ~/.honeytoken: registry.json (locked, atomic), alerts.jsonl, cloudtrail.json
  aws.ts           AWS through the user's `aws` CLI: issue, rotate, delete, status, CloudTrail polling
  watch.ts         CloudTrail watching without a server: watchlists (no secrets), pollOnce, watchLoop
  service.ts       createService(): issue / issueAws / register / list / check / rotate / clean / alerts.
                   Every rule lives here.
  setup.ts         init (skill + MCP registration + AWS check), IAM policies, GitHub Actions template
  server.ts        node:http adapter around core/handle, plus the CloudTrail watch loop
  mcp.ts, cli.ts   thin shells over the service
skills/honeytoken-planting/SKILL.md   agent playbook shipped with the package
test/              node:test suites, one per layer, plus helpers.ts (sandbox repo + home)
assets/            README art (hand-written SVG)
```

Dependencies point one way: `cli / mcp / server -> service -> aws, store -> core`, and `notify -> core`.
`core` imports nothing outside `core`.

| Seam | Contract | To extend |
|---|---|---|
| Alert channel | `Notifier = (alert) => Promise<void>` | add `src/notify/<name>.ts`, wire it in `notifiersFromEnv` |
| Runtime | `handle(Request, { traps, onAlert, clientIp }) => Response` | write an adapter like `server.ts` (e.g. a Worker) |
| Entry point | `createService()` | call it; never reach into `store.ts` from a shell |
| AWS access | `AwsRunner = (args) => Promise<json>` | `awsCli()` in production, `fakeAws()` in tests |
| Trap kind | `Trap` is a discriminated union on `kind` | add a variant to `types.ts`, a case to `trapMarkers`, `replacements` and `list`; issuing lives in its own module like `aws.ts` |

Not abstracted on purpose: trap kinds stay a union with `switch`es rather than an interface of objects (two
kinds, a handful of behaviours), and storage stays one JSON file (`store.ts` is plain functions).

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
  AWS goes through the user's `aws` CLI, not an SDK. Add a dependency only with a strong reason.
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
11. **Alert volume is bounded, and nothing is dropped silently.** Per trap and address one alert per cooldown,
    per trap at most `maxPerTrap` per window, a capped address map, an alert log that rotates at
    `MAX_ALERT_LOG_BYTES`. Held-back hits go out as one summary when the window closes; one-shot runs call
    `dispatch.flush()` before exiting.
12. **Client addresses come from the socket** unless the operator names a header with `--trust-proxy`.
    `X-Forwarded-For` is read from the right: the hop our proxy appended, not what the client wrote.
13. **No fake provider keys.** `generateWebhookTrap` refuses `PROVIDER_PREFIXES` unless the operator passes
    `allowProviderPrefix` (CLI only; never exposed to agents). Names the intruder sees pass `assertNoTell`.
14. **AWS canaries can never do anything.** The deny-all inline policy is attached before the access key is
    created; a half-finished issue deletes the user. `check` reports a missing policy.
15. **AWS stays untouched without AWS traps.** The CloudTrail watcher only runs the CLI when the registry
    holds an AWS trap. Retired AWS keys stay alive (they are still bait); only never-planted ones are deleted,
    and an IAM user is deleted only when no other trap uses it.
16. **Watchlists never carry secret keys.** `watchlistFromRegistry` and `parseWatchlist` both drop
    `secretAccessKey`; a watchlist goes into CI secrets, the registry never does.
17. **`init` writes nothing into a repo.** It installs the skill under the home directory and registers the MCP
    server at Claude Code's user scope. Tests drive it through an injected `CommandRunner`, never the real CLIs.

## Tests

- `node:test` with `node:assert/strict`. Use `sandbox()` from `test/helpers.ts`: a temp repo with `.git`
  and a temp home. Never touch the real `~/.honeytoken`.
- Core is tested with plain `Request` objects, no sockets. Servers listen on port 0. MCP tools go through
  `InMemoryTransport`, plus one stdio round trip of the real CLI.
- Notifiers take an injectable `fetch`; tests must never reach a real webhook.
- AWS goes through `fakeAws()` from `test/helpers.ts` (the default in `sandbox()`); tests must never reach a
  real AWS account. `awsCli` itself is tested against a fake executable.
- `npm run typecheck` covers `test/` too (`tsconfig.test.json`): Node strips types without checking them.
- New behaviour gets a test; a bug fix gets a test that failed before the fix.

## When you change...

- **an MCP tool** (name, input, output): update `SKILL.md`, both READMEs and `test/mcp.test.ts`.
- **CLI flags:** update the usage text in `src/cli.ts` and the CLI blocks in both READMEs.
- **the alert format:** update the "Anatomy of an alert" blocks in both READMEs and `assets/demo.svg`.
- **README.md:** make the same change in `README.ko.md`.
- **the registry format:** bump `version` in `Registry` and read the old version.

## Git

Do not commit, push or tag unless asked. Commit messages: imperative mood, explain why.
