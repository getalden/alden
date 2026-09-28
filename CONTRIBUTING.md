# Contributing to Alden

Thanks for helping. Alden is early, so open an issue before starting anything large.

## Setup

1. Install Node 22+ and pnpm 10.
2. `pnpm install`
3. `pnpm test && pnpm typecheck && pnpm lint` should all pass before you open a PR.

## Conventions

- TypeScript, strict mode, ES modules.
- Formatting and lint rules come from Biome. Run `pnpm format` to fix them.
- Tests sit next to the code as `*.test.ts`.
- New data that crosses a boundary (CLI, UI, desktop app, plugin) gets a zod schema in `packages/schema` first.
- Alden never collects or stores Claude.ai logins. Model access is always the user's own API key, cloud provider account, local model, or their own Claude Code session via the plugin.

## Releases

Add a changeset for any user-facing change:

```sh
pnpm changeset
```

Only the `alden` package is published. The `@alden/*` packages are private and bundled into it.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
