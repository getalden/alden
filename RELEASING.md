# Releasing Alden

During the private beta, releases go to npm under `next` and to the public
[getalden/homebrew-tap](https://github.com/getalden/homebrew-tap) repo (binaries and the Homebrew formula). This repo
stays private.

## Once: set up

1. Create the public repo `getalden/homebrew-tap` with a README (it holds only `Formula/alden.rb` and releases).
2. Add these GitHub Actions secrets to this repo:

   | Secret | What |
   | --- | --- |
   | `NPM_TOKEN` | An npm automation token for the `alden` package. |
   | `TAP_TOKEN` | A fine-grained GitHub token with contents read and write on `getalden/homebrew-tap` only. |
   | `APPLE_CERT_P12_BASE64` | Your Developer ID Application certificate, exported as .p12, then `base64 -i cert.p12`. |
   | `APPLE_CERT_PASSWORD` | The .p12's password. |
   | `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | For notarization; the password is an app-specific password from appleid.apple.com. |

   Without a secret, its step is skipped: with none, a run builds and smoke-tests everything and publishes nothing.

## Each release

1. Add changesets as you go (`pnpm changeset`), then version: `pnpm changeset version`. Review the changelog and the
   new version in `packages/cli/package.json`, and commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The Release workflow builds the five binaries on their own runners, smoke-tests each (`pnpm smoke:binary`),
   signs and notarizes the macOS ones, publishes `alden@<version>` to npm under `next`, and creates the release and
   updates the formula in `getalden/homebrew-tap`.
4. Check: `brew upgrade alden` (or `brew install getalden/tap/alden`) and `npm i -g alden@next`, then
   `alden --version` and `alden doctor`.

## Locally

```sh
pnpm build && pnpm build:binary      # dist-bin/alden-<your platform>
pnpm smoke:binary dist-bin/alden-darwin-arm64
```

A local binary isn't signed, so macOS asks once before it can read a token Node stored in the keychain.
