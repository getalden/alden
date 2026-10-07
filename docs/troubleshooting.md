# Troubleshooting

Start with `alden doctor`: it checks your sign-in, model, this clone and the code graph, and says how to fix what's
wrong.

## GitHub

**"Bad credentials" or "GitHub rejected the token".** The token Alden is using was revoked or expired. Run
`alden auth status` to see where it comes from:

- From `ALDEN_GITHUB_TOKEN`: fix or unset the variable.
- Stored by Alden: run `alden auth login --device`.
- From the GitHub CLI: run `gh auth login`.

**Team review requests are missing.** The token needs the `read:org` scope. `alden auth status` lists the token's
scopes. Sign in again with `alden auth login --device`, or run `gh auth refresh -s read:org`.

**A company's PRs are missing.** Organisations can hide their private data from a sign-in, and GitHub then leaves
their PRs out of Alden's queue without an error. `alden doctor` checks each of your organisations and names any that
do, and the queue warns about them. There are two causes:

- **Single sign-on (SAML).** The organisation needs each sign-in authorized for it. For Alden's own sign-in, open
  Alden's page under GitHub → Settings → Applications → Authorized OAuth Apps (doctor prints the link) and click
  **Authorize** next to the organisation. For the GitHub CLI's, run `gh auth refresh -h github.com` and authorize it in
  the browser. For a personal token, choose **Configure SSO** next to it at github.com/settings/tokens.
- **Third-party app restrictions.** The organisation only allows apps an owner has approved. Ask an owner to approve
  Alden (click **Request** next to the organisation on Alden's page in your GitHub settings). Meanwhile, use a sign-in
  it already allows: many companies approve the GitHub CLI, so `alden auth logout` (which switches Alden to the GitHub
  CLI's sign-in) often works at once; otherwise a classic personal access token (`alden auth login --with-token`).

Alden itself never needs installing on an organisation: it reads what your own sign-in can read, and posts only the reviews you send.

**The queue is slow.** Run `ALDEN_DEBUG=queue alden queue --refresh` to see each step's time and requests on stderr.
A huge queue (hundreds of PRs) takes longer; narrow it with `--repo`, `--org` or `queue.ignore`.

**Private repos are missing.** The token needs the `repo` scope. `alden auth status` lists its scopes; sign in again
with `alden auth login --device`, or run `gh auth refresh -s repo`.

## Models

**"No Anthropic API key found, so only the checks ran."** Run `alden setup` to paste a key (checked, then stored) or use
a local model; or `alden auth model`, `ANTHROPIC_API_KEY` or `ant auth login`. `--no-llm` hides the note. The desktop
app doesn't see your shell's `ANTHROPIC_API_KEY`: use **Set up a model** there, or store the key with `alden auth model`
or in Settings.

**`alden setup` says the key has no credit.** The key is valid, but its Anthropic account can't pay for requests. Add
credit at [console.anthropic.com/settings/billing](https://console.anthropic.com/settings/billing) and run it again.

**`alden setup` doesn't find Ollama.** Start it (`ollama serve`, or open the Ollama app). If it listens somewhere other
than `http://localhost:11434`, set `OLLAMA_HOST` in the terminal you run `alden setup` from.

**"Couldn't find Google Cloud credentials for Vertex."** Run `gcloud auth application-default login`, or set
`GOOGLE_APPLICATION_CREDENTIALS` to a service account key file. Also set `model.projectId`.

**"model.name is a Claude model, but the provider is openai-compatible."** Set your local model's name, e.g.
`alden config set model.name qwen3-coder:30b`.

**"Over budget."** The review would exceed `budget.perReviewUsd` or what's left of `budget.dailyUsd`. `alden spend`
shows where you are. Raise a cap, lower effort, or use a cheaper model with `--model haiku`.

**Reviews are slow.** Model reviews at high effort can take a minute. Try `--effort medium` or `--effort low`. The
deterministic checks don't depend on the model.

## Code graph

**"No local clone of owner/repo found, so callers outside the diff weren't checked."** For PR reviews, Alden needs a
clone of the PR's repo. Run Alden once in a clone of it, and Alden remembers it, or tell Alden where your clones live:
`alden config set clones.folders ~/src`. See [Reviewing PRs](code-graph.md#reviewing-prs).

**"This clone has no remote for owner/repo."** None of the clone's remotes point at the PR's repo. Add one, e.g.
`git remote add upstream https://github.com/owner/repo`.

**"The index was cut short, so there may be more."** Indexing hit its 60-second limit. Run the review again: the
parsed files are cached, so the next run gets further.

**"Callers from the PR's branch: it conflicts with main…"** GitHub can't merge the PR onto its base, so there's no
merge to find callers in, and changes merged since aren't included. Once the author resolves the conflict, brief it
again. "GitHub hasn't merged it with main yet" means GitHub hasn't made the merge for the latest push: brief again in
a minute.

**"main has 4 new commits since" right after briefing again.** GitHub remakes a PR's merge a little after its base
moves, and until then Alden gets the old one. Wait a minute and **Re-brief**.

**A stale PR worktree.** Delete `~/.alden/worktrees` and run `git worktree prune` in your clone. Alden recreates the
worktree next time.

## The database

**`alden doctor` says it couldn't open `alden.db`.** Alden's database needs Node 22.13 or later; check `node
--version`, or use the standalone binary. If the file is damaged, move `~/.alden/alden.db` aside: Alden starts a new
one (your feedback and notes stay in the old file).

**A flag you expected is missing.** If your feedback hid it, the briefing says so under the places to look ("Hidden:
…"). `alden memory` lists what Alden learned; `alden memory forget <id>` undoes it.

## macOS

**"EPERM: operation not permitted, uv_cwd".** Your terminal app isn't allowed to read the folder you're in, usually
Desktop, Documents or Downloads. Allow it in System Settings → Privacy & Security → Files and Folders, or run Alden
from another terminal or folder.

## The standalone binary

**macOS asks whether `alden` may use your keychain.** The binary is a different program from the npm version, so
macOS asks once before it reads the sign-in Alden stored. Choose Always Allow.

**"The standalone alden binary doesn't include the bedrock SDK."** The binary bundles the Anthropic API and local
models, but not the AWS, Google Cloud or Azure SDKs. To use Bedrock, Vertex or Foundry, install Alden from npm with
the SDK beside it, e.g. `npm install -g alden@next @anthropic-ai/bedrock-sdk`.

## Get help

If this page doesn't cover it, ask in the [Alden Community on Discord](https://discord.gg/ZtXFX7sxTu). Include what
`alden doctor` says and your version (`alden --version`); leave out tokens, keys and anything private from your repos.
