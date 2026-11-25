@AGENTS.md

## Claude Code notes

- `AGENTS.md` above is the source of truth for every agent. Put shared rules there, not here.
- To try the tool on a sample repo from this checkout:
  ```bash
  npm run build
  export HONEYTOKEN_HOME=/tmp/honeytoken-dev    # keep experiments out of ~/.honeytoken
  claude mcp add honeytoken -e HONEYTOKEN_HOME=$HONEYTOKEN_HOME -e HONEYTOKEN_BASE_URL=http://127.0.0.1:8787 \
    -- node "$PWD/dist/cli.js" mcp
  node dist/cli.js install-skill
  node dist/cli.js serve                         # same HONEYTOKEN_HOME, so it sees the traps
  ```
  `claude mcp add` uses local scope by default, so nothing lands in the target repo. Do not register this server
  through a committed `.mcp.json` in a repo you plant traps in.
- Do not plant traps in this repository itself. Use a scratch repo.
