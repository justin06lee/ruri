# Contributing

## Tooling

- **bun** is the package manager, script runner and test runner — `bun install`, `bun run <script>`, `bunx <tool>`, `bun test`. Never npm, npx, yarn or pnpm; the only lockfile is `bun.lock`. The bun version the repo is built with is in `.bun-version`.
- `make` is the golden path: build, install `ruri.app` to `/Applications`, tidy, launch. `make build` only builds (into `dist-app/`); `make update` stops the running app, rebuilds, reinstalls and relaunches. `make identity` creates the local code-signing identity once (see `docs/permissions.md`).
- `bun run dev` for browser-mode development (server on :7777, UI on :5173), `bun run desktop` for the unpackaged Electron app.

## Before you push

```sh
bun run typecheck      # server + web
bun run lint           # eslint, flat config in eslint.config.js
bun run format:check   # prettier; `bun run format` to fix
bun test               # unit tests (**/*.test.ts)
bun run test:scripts   # the token-free integration scripts
bun run build          # the packaged app must still build
```

CI runs the same steps on every push to `master` and every pull request (`.github/workflows/ci.yml`). Scripts that spend model tokens or need a display are run by hand — `docs/testing.md` lists them.

## Branches and commits

- The default branch is `master`, not `main`.
- Work on a branch named by type: `feat/<slug>`, `fix/<slug>`, `refactor/<slug>`, `perf/<slug>`, `docs/<slug>`, `chore/<slug>`. Merge with `--no-ff` so the branch stays visible in history.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org): `type(scope): imperative subject` (≤ 72 characters, no trailing period), with a body that says *why*. Types: `feat`, `fix`, `refactor`, `perf`, `docs`, `style`, `test`, `build`, `ci`, `chore`, `revert`.
- One logical change per commit; docs that the change makes stale are updated in the same commit.
- Releases are annotated `vX.Y.Z` tags whose message carries the release notes; `CHANGELOG.md` is generated from them.

## Layout

`server/` is the Node backend (bundled into the Electron main process), `shared/protocol.ts` the wire contract, `web/src/` the React UI, `desktop/` the Electron shell, `scripts/` the integration scripts and build helpers. `docs/architecture.md` walks the files.
