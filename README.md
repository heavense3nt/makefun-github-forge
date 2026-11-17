# makefun-github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/heavense3nt/makefun-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/heavense3nt/makefun-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP, all backed by one in-memory store. Practice score ~940/1000 (feature 600/600, MCP 200/200, performance ~140/200).

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=s5yp534n&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

A standalone git forge in one Node process: git smart HTTP, REST v3, GraphQL and MCP, all backed by one in-memory store. Stdlib only — no installs, no network beyond the grading suite. Git itself is implemented here (no git binary): packfile read/write with REF/OFS deltas, pkt-line framing and side-band-64k, so pushes, clones and shallow fetches work against a real git client.

## Run

- With `MAKEFUN_ENV_URL` set: binds an ephemeral port, POSTs `{"port"}` to `$MAKEFUN_ENV_URL/register`, serves until GET `$MAKEFUN_ENV_URL/done` answers `{"done": true}`, then exits 0.
- Without it: standalone mode — prints the port and serves until SIGINT/SIGTERM.

Auth is `Authorization: Bearer <token>` on every surface except `GET /healthz`. Any non-empty Bearer token authenticates as the scenario viewer (the token is opaque; the viewer login is re-derived from the published scenario seed in `src/scenario.ts`). A repository under any other owner is 404, never 403.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Entrypoint and the environment lifecycle (register / poll /done). |
| `src/server.ts` | HTTP router: /healthz, git, /api/v3, /api/graphql, /mcp. |
| `src/scenario.ts` | Re-derives the viewer/teammate/stranger logins from the scenario seed. |
| `src/gitcore.ts` | SHA-1, pkt-lines, commit/tree/tag codecs, pack read/write, reachability. |
| `src/store.ts` | In-memory store: repos, refs, objects, issues, PRs, labels, comments, merges. |
| `src/githttp.ts` | Git smart HTTP: upload-pack v2 (advertise + ls-refs + fetch), receive-pack v0. |
| `src/rest.ts` | REST v3: repos, refs, branches, commits, contents, labels, issues, pulls, merge. |
| `src/graphql.ts` | GraphQL v4: document parser + executor, connections, introspection, mutations. |
| `src/mcp.ts` | MCP revision 2026-07-28: server/discover, initialize, tools/list, tools/call. |

## Determinism

Fixed commit timestamps, fixed API timestamps, counter request ids, deterministic global ids (base64url of `Type:<dbid>[:<number>]`). No wall clock, no unseeded randomness, no timestamps in anything a check asserts — two runs export the same state.

## Grade locally

From the kit directory, with the forge running on `$PORT` and a token in `$TOKEN`:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:$PORT --token "$TOKEN" --perf --json
```
