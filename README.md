# github-core-clone-entry-v5

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ferdizi/github-core-clone-entry-v5/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ferdizi/github-core-clone-entry-v5/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process: git smart HTTP (protocol v0/v2, push/clone/shallow clone), REST v3 (repos, issues, pull requests, contents, labels), GraphQL v4 (the documents gh and github-mcp-server send), and MCP (2026-07-28 `server/discover` plus six tools) over a single in-memory store. Standard library only — no dependencies, no git binary, no outside service. Deterministic: a logical clock stamps every commit, never the wall clock. Passes the kit's 120-check conformance suite locally (120/120).

## Run it

```sh
node --experimental-strip-types main.ts
```

The trial environment provides `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`. The server binds an ephemeral port, registers it with the env, serves until the env says done, then exits 0. Locally, without `MAKEFUN_ENV_URL`, it serves on an ephemeral port until stopped (set `MAKEFUN_SHOP_TOKEN` to a token of your choice for local runs).

---

<sub>Entered on [make.fun](https://make.fun/?ref=qgr0hfw9&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
