# LearnSley

LearnSley is the local Linux-native MVP for the Sley learning game described in
`<learnsley-spec>`.

It is a web app UX backed by a localhost Node server. The server runs the real
Sley compiler binary for `Run`, `Seal`, `Format`, `Graph`, and `Seal Digest`
actions. It does not download packages and does not expose a public listener by
default.

## Run

```bash
cd <learnsley-local-repo>
npm start
```

Open:

```text
http://127.0.0.1:4179
```

Optional environment:

```bash
SLEY_BIN=<sley-repo>/target/debug/sley PORT=4179 npm start
```

## Current Slice

- Five starter trials from the spec.
- Real Sley `check`, `run`, `format`, `graph`, and `seal` subprocess calls.
- Local JSON progress in `workspaces/progress.json`.
- Clean Seal Chain, Proof Armor, XP, shards, level, and Daily Pulse.
- Localhost bind only unless `LEARNSLEY_HOST` is deliberately changed.

## Hosting Decision

`learnsley.greyforge.tech` is the right public product target, but the current
compiler-backed grader is intentionally local. A hosted version needs either:

1. a static demo shell with no arbitrary code execution;
2. a WASM Sley compiler path; or
3. a locked server sandbox for submitted programs.

The local repo is the source of truth until one of those hosting paths is
implemented and approved.

