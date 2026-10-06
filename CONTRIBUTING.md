# Contributing to Alden

Thanks for helping. Alden is early, so open an issue before starting anything large.

## Setup

1. Install Node 22.13+ and pnpm 10.
2. `pnpm install`
3. `pnpm test && pnpm typecheck && pnpm lint` should all pass before you open a PR.

## Conventions

- TypeScript, strict mode, ES modules.
- Formatting and lint rules come from Biome. Run `pnpm format` to fix them.
- Tests sit next to the code as `*.test.ts`.
- New data that crosses a boundary (CLI, UI, desktop app, plugin) gets a zod schema in `packages/schema` first. After
  changing a schema there, run `pnpm schema:generate` to regenerate the JSON Schemas in `packages/schema/json`; a test
  fails while they're stale.
- Alden never collects or stores Claude.ai logins. Model access is always the user's own API key, cloud provider account, local model, or their own Claude Code session via the plugin.

## Sign off your commits

Alden uses the [Developer Certificate of Origin](https://developercertificate.org) instead of a contributor
agreement: by signing off a commit you certify you wrote it, or have the right to submit it, under the project's
Apache-2.0 license. Add the sign-off with `-s`:

```sh
git commit -s -m "Explain what changed"
```

That adds a `Signed-off-by: Your Name <you@example.com>` line matching your commit's author. A check on every pull
request looks for it. To sign off commits you already made: `git rebase --signoff main`, then push again.

## Releases

Add a changeset for any user-facing change:

```sh
pnpm changeset
```

Only the `alden` package is published. The `@alden/*` packages are private and bundled into it.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
