# Releasing Alden

During the private beta, releases go to npm under `next` and to the public
[getalden/homebrew-tap](https://github.com/getalden/homebrew-tap) repo (binaries and the Homebrew formula). This repo
stays private.

## Once: set up

1. The public repo `getalden/homebrew-tap` exists (created 2 Oct 2026, with a README and an empty `Formula/`).
2. Add these GitHub Actions secrets to this repo:

   | Secret | What |
   | --- | --- |
   | `NPM_TOKEN` | An npm automation token for the `alden` package. |
   | `TAP_TOKEN` | A fine-grained GitHub token with contents read and write on `getalden/homebrew-tap` only. |
   | `APPLE_CERT_P12_BASE64` | Your Developer ID Application certificate, exported as .p12, then `base64 -i cert.p12`. |
   | `APPLE_CERT_PASSWORD` | The .p12's password. |
   | `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | For notarization; the password is an app-specific password from appleid.apple.com. |

   Without a secret, its step is skipped: with none, a run builds and smoke-tests everything and publishes nothing.
3. The PostHog project (EU cloud) is set up and its public key is in `TELEMETRY_KEY` in
   `packages/core/src/telemetry/telemetry.ts` (it's public by design: it can only send events). In the PostHog project,
   keep "Discard client IP data" on. The "Alden beta" dashboard is defined in `scripts/posthog-dashboard.ts`: create
   or update it with `POSTHOG_PERSONAL_API_KEY=phx_… pnpm posthog:dashboard` (a personal API key with dashboard and
   insight write access; it stays in your shell).

## Each release

1. Add changesets as you go (`pnpm changeset`), then version: `pnpm release:version`. That runs `changeset version`,
   gives the desktop app the same version and updates the lockfile. Review `packages/cli/CHANGELOG.md` and commit.
2. Rehearse on your machine: `pnpm release:dry-run` (a few seconds, no CI minutes, publishes nothing). It builds and
   smoke-tests your platform's binary, packages it as the workflow does, writes checksums and the formula, and installs
   the npm tarball into a throwaway prefix and smoke-tests that too. Add `--desktop` to build the universal Alden.app
   and the cask as well (a couple of minutes). The output is in `build/release/`.
3. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`. This starts the Release workflow, which costs Actions
   minutes (macOS runners bill at 10× on a private repo), so do it once the dry run passes.
4. The Release workflow builds the five binaries on their own runners, smoke-tests each (`pnpm smoke:binary`),
   signs and notarizes the macOS ones, builds the universal desktop app around them (Tauri signs, notarizes and staples
   it with the same Apple secrets), publishes `alden@<version>` to npm under `next`, and creates the release and
   updates the formula (`Formula/alden.rb`) and the cask (`Casks/alden-desktop.rb`) in `getalden/homebrew-tap`.
5. Check: `pnpm release:verify` (see below), then by hand: `brew install getalden/tap/alden` and
   `npm i -g alden@next`, then `alden --version` and `alden doctor`; `brew install --cask getalden/tap/alden-desktop`
   and open Alden from Applications (no Gatekeeper warning, the menu bar shows your queue).

## Locally

```sh
pnpm build && pnpm build:binary      # dist-bin/alden-<your platform>
pnpm smoke:binary dist-bin/alden-darwin-arm64
```

A local binary isn't signed, so macOS asks once before it can read a token Node stored in the keychain.
