# Handoff notes

## Phase 0: scaffold

**What exists**

- pnpm monorepo: `apps/web`, `apps/server`, `packages/shared` (all `@hoseidon/*`).
- `apps/server`: Hono on `@hono/node-server`. `src/app.ts` exports `createApp(config)` (testable via
  `app.request`), `src/config.ts` zod-validates env (blank values treated as unset), `src/db/`
  has Drizzle schema + `openDb(path)` (bootstraps a `settings` table with raw SQL; switch to
  drizzle-kit migrations when real tables arrive). Serves `WEB_DIST` with SPA fallback if present.
  Unknown `/api/*` returns JSON 404. Built with tsup (bundles `@hoseidon/shared`, externalizes
  `better-sqlite3`).
- `apps/web`: Vite 8 + React 19 + Tailwind v4 (CSS-first, `@theme` in `src/index.css`) +
  TanStack Query + react-router + vite-plugin-pwa (stub manifest, svg icon only). Dev proxy for
  `/api` and `/hooks` to :8787.
- `packages/shared`: consumed as TypeScript source (`main: src/index.ts`), no build step. zod
  schemas live here (`healthSchema`, `workModeSchema`, `parsePercent`).
- Docker (multi-stage, `pnpm deploy --prod`), compose (`cloudflared` under `tunnel` profile), CI
  (lint, typecheck, test, build, docker build).

**Conventions**

- Strict TS, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. Extensionless relative imports.
- Tests are colocated `*.test.ts`, run by vitest per package. Prettier is enforced by `pnpm lint`.
- Env var additions go in `.env.example`, `config.ts` and the README table.
- TypeScript is pinned to 6.x because typescript-eslint does not support TS 7 yet.
- pnpm 12 build-script allowlist lives in `pnpm-workspace.yaml` (`allowBuilds`).
- pnpm is not on PATH on the dev machine; use `corepack pnpm`.

**Known gaps**

- Docker image was never run locally (no Docker); only CI builds it.
- PWA icons are SVG only (no PNG maskable icons); no push yet.
- No auth, no LinkTap client, no real DB schema yet.
