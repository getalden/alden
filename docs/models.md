# Models, providers and budgets

A model is optional. Without one, Alden runs its deterministic checks. With one, the briefing also says what the change
does, whether it matches its title, and adds grouped findings anchored to lines in the diff.

Alden uses your own model account. It never uses Claude.ai or Claude Code subscription logins: Anthropic doesn't allow
third-party tools to use them.

## Setting one up

`alden setup` (or **Set up a model** in the web UI and the desktop app) gets you a working model in about a minute: an
Anthropic API key, checked with one tiny request and stored in your keychain; a local model through Ollama; or checks
only. The sections below are the same choices by hand. If you'd rather Alden handled everything, sign up for
[Alden Cloud (beta)](https://getalden.dev/cloud).

## Choosing a model

```sh
alden config set model.name opus      # your default
alden review 12 --model haiku         # just this once
```

| Alias | Model |
| --- | --- |
| `sonnet` (default) | Claude Sonnet 5 |
| `opus` | Claude Opus 5 |
| `haiku` | Claude Haiku 4.5 |
| `fable` | Claude Fable 5.1 |

A full model ID works too, e.g. `claude-opus-5-5`.

### Effort

Effort sets how hard the model thinks. More effort takes more time and tokens.

```sh
alden config set model.effort medium
alden review 12 --effort low
```

The levels are `low`, `medium`, `high`, `xhigh` and `max`. When it isn't set, the model's own default applies, which
is `high`. Haiku 4.5 doesn't support effort, so it's ignored there.

## Providers

Set the provider with `alden config set model.provider <name>`.

### Anthropic API (`anthropic`, the default)

Run `alden setup` (or `alden auth model`) and paste your API key (from
[console.anthropic.com](https://console.anthropic.com/settings/keys)): it's stored in the OS keychain, like the GitHub
token, and every surface uses it, including the desktop app, which never sees your shell's variables. `alden setup`
and the UI's **Set up a model** first check the key with one request to Claude Haiku for a single output token, which
costs a fraction of a cent, and say why a key doesn't work (mistyped or deleted, no credit, no network). You can also
set it in the web UI's Settings. Every review looks the key up afresh, so a new key works at once, without
restarting `alden ui` or the desktop app. Alden looks for credentials in this order:

1. The environment: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_PROFILE`, or workload identity federation.
2. The key stored with `alden auth model` (in the keychain, or a file only you can read where there's no keychain).
3. An `ant auth login` profile.

`alden auth status` and `alden doctor` say which one is in use, never the key. `alden auth model --remove` removes the
stored key. Admin API keys and Claude.ai sign-in tokens are refused.

### AWS Bedrock (`bedrock`)

```sh
alden config set model.provider bedrock
alden config set model.region us-east-1
```

Uses your usual AWS credentials (environment, profile or SSO).

### Google Vertex AI (`vertex`)

```sh
alden config set model.provider vertex
alden config set model.projectId my-gcp-project
alden config set model.region global
```

Uses Application Default Credentials: run `gcloud auth application-default login`, or set
`GOOGLE_APPLICATION_CREDENTIALS`.

### Azure AI Foundry (`foundry`)

```sh
alden config set model.provider foundry
alden config set model.resource my-foundry-resource
```

Uses your Azure credentials.

### Local and OpenAI-compatible models (`openai-compatible`)

Any endpoint that speaks the OpenAI chat completions API, such as Ollama or LM Studio.

```sh
alden config set model.provider openai-compatible
alden config set model.name qwen3-coder:30b
alden config set model.baseUrl http://localhost:11434/v1   # Ollama's address, the default
```

If the endpoint needs a key, set `ALDEN_OPENAI_API_KEY` (or `OPENAI_API_KEY`). The model must support structured
(JSON schema) output. Smaller local models make weaker briefings; Alden still drops any finding that doesn't point at a
line in the diff.

`alden setup` does this for Ollama: it finds Ollama (at `OLLAMA_HOST`, or `http://localhost:11434`), recommends a model
for your machine's memory, pulls it if needed, and writes the three settings above (`model.baseUrl` only when Ollama
isn't at its default address, so the desktop app, which never sees `OLLAMA_HOST`, finds it too). It picks:

| Memory | Model | Download |
| --- | --- | --- |
| Under 16 GB | `qwen2.5-coder:7b` | about 4.7 GB |
| 16 to 32 GB | `qwen2.5-coder:14b` | about 9 GB |
| 32 GB or more | `qwen3-coder:30b` | about 19 GB |

If Ollama already has the one for your memory, or a smaller one from the table, it uses that instead of downloading.
Any other model Ollama has can be chosen too. Local models are free and private, but they flag less than Claude: expect
fewer findings, and more missed.

## Drafted comments

With `drafts.auto` on (the default), the briefing's own model call also drafts the comments Alden offers you in the
Comments drawer (see [Alden's drafts](comments.md#aldens-drafts)). There's no second call. For a PR (never your local
changes, and never a PR the injection check flagged), the system prompt gains one paragraph asking, for each medium or
high finding whose first anchor is an added line, for the comment a careful reviewer would leave on that line: to the
author, in one to three plain sentences, with no preamble, praise or sign-off, never mentioning being an AI; and a
suggested replacement for the line only when the fix is small and certain. Each finding in the answer may then carry
a `draft` (`body`, optional `suggestion`).

Alden checks every draft before offering it: it must be on a medium or high finding, on an added line the model was
shown, say something in plain words of reasonable length (nothing aimed at AI reviewers), and any suggestion must
change that line, apply to it, be a few lines at most and contain no redaction placeholder. A draft that fails is
dropped; the finding stays.

**Cost:** a little more output on the same call, usually a few hundred tokens for a PR's handful of drafts, within the
same per-review cap. It works with any model, your own key or a local one. With `drafts.auto = false` the prompt and
the answer's shape are exactly what they were without drafts, so nothing extra is asked or paid for.

## Budgets

Every model call is checked against two caps before it's sent:

| Setting | Default | What it caps |
| --- | --- | --- |
| `budget.perReviewUsd` | 0.50 | One review. |
| `budget.dailyUsd` | 10 | All reviews in your local day. |

Before each call, Alden works out the most it could cost: every input token at full price plus the maximum output.
If that doesn't fit, it first trims the diff (lowest-priority files first, and says which were left out), and if it
still doesn't fit it skips the model and says so. The deterministic briefing always prints.

Costs are at Anthropic's list prices. On Bedrock and Vertex, which bill at their own rates, they're an estimate. Alden
can't price local models, so those calls aren't capped.

`alden spend` shows today's spend and recent days. The ledger is kept in `~/.alden/alden.db`.

## When the model doesn't run

The briefing says why in one line, and the deterministic checks print as usual:

| Status | Meaning |
| --- | --- |
| skipped | No model configured, or `--no-llm`. |
| over budget | The review would exceed a cap. |
| refused | The model declined to review the change. |
| truncated | The model hit its output limit before finishing, so its answer was discarded. |
| failed | A network, rate-limit, credentials or setup error, or an answer in the wrong format. The reason is shown. |
