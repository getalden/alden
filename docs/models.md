# Models, providers and budgets

A model is optional. Without one, Alden runs its deterministic checks. With one, the briefing also says what the change
does, whether it matches its title, and adds grouped findings anchored to lines in the diff.

Alden uses your own model account. It never uses Claude.ai or Claude Code subscription logins: Anthropic doesn't allow
third-party tools to use them.

## Setting one up

`alden setup` (or **Set up a model** in the web UI and the desktop app, and the first run's Model step) gets you a
working model in about a minute: an Anthropic or OpenAI API key (paste either kind and Alden detects which), checked
with one tiny request and stored in your keychain; a local model through Ollama; or checks only. The sections below are the same choices by hand. If you'd rather Alden handled everything, sign up for
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

### OpenAI (`openai`)

Paste an OpenAI API key in `alden setup`, **Set up a model**, Settings → API keys or `alden auth model`: Alden tells it
from an Anthropic key by its shape (sk-ant-… is Anthropic's, any other sk-…, such as sk-proj-…, OpenAI's; OpenAI admin
keys, sk-admin-…, are refused), stores it in the keychain under its own name, and makes `openai` the provider with
`gpt-6.1-sol` unless you'd chosen an OpenAI model. `alden setup` and **Set up a model** first check it with one Chat
Completions request to `gpt-6-luna` for at most 16 output tokens, far less than a cent, and say why a key doesn't work
(mistyped or deleted, no credit, no permission for the model API, no network). By hand:

```sh
alden auth model                       # paste the key, or: pbpaste | alden auth model
alden config set model.provider openai
alden config set model.name gpt-6-astra
```

Alden looks for the OpenAI key in this order:

1. `OPENAI_API_KEY`.
2. The key stored with `alden auth model` (in the keychain, or a file only you can read where there's no keychain).

Briefings call `https://api.openai.com/v1/chat/completions` (`model.baseUrl` points elsewhere, for a proxy) with
Structured Outputs in strict mode, so the answer has the briefing's shape; `max_completion_tokens` caps the output, and
`model.effort` is sent as `reasoning_effort` to the GPT-6 models, which take all five levels (other OpenAI models get
their own default). Cached input is counted apart, so spend is right.

| Model | Note | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| `gpt-6.1-sol` (default) | fast | $2 | $0.10 | $10 |
| `gpt-6-astra` | deepest | $10 | $1 | $50 |
| `gpt-6-luna` | cheap | $0.10 | $0.01 | $0.50 |

US dollars per million tokens, Standard tier, prompts under 272K tokens, from
[OpenAI's pricing page](https://developers.openai.com/api/docs/pricing) on 12 October 2026; writing to the cache costs
1.25 times input on these models. Alden also knows the prices of GPT-5.6, 5.5, 5.4, 5.2, 5.1, 5 and 4.1 for spend; a
model it has no price for isn't counted against your caps, as with a local model, so check the page before using one.

### Which key comes first

Each provider reads its own variable first, then its stored key: `ANTHROPIC_API_KEY` (and the other Anthropic
credentials below) for `anthropic`, `OPENAI_API_KEY` for `openai`. Which provider briefings use is `model.provider`,
which pasting a key sets; the other key stays stored for the model picker. `alden doctor` reports both keys and where
each comes from, never the key.

### The model picker

The web UI and the desktop app list the models you can switch to (`GET /api/models`): Anthropic and OpenAI through your
key, Local through Ollama (the models it has pulled), and Bedrock, Vertex or Foundry when that's your provider. A
provider is offered only when it's set up here. Picking one writes `model.provider` and `model.name` to your user
config, as `alden config set` does.

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

## Drafting on demand

[Draft my review](comments.md#draft-my-review) and [Draft with Alden](comments.md#draft-with-alden) are calls of their
own, made only when you press them (or run `alden comment <pr> --draft`), with the model you've set up:

| | Draft my review | Draft with Alden |
| --- | --- | --- |
| What it sends | The PR's title and description, your notes for the repo, Alden's check results, and each place without a comment near it (at most 12), with its reason and the diff around it | The PR's title and description, your notes, where the comment goes and the diff around it, what Alden flagged there, the thread so far for a reply, and what you've written |
| What it asks for | A comment (and, on an added line, maybe a suggested change) per place worth one | One comment or reply, for you to edit and send |
| Effort, output cap | Medium (low if `model.effort` is low), 8,000 tokens | Low, 2,000 tokens |
| Spend ledger | `owner/repo#12 drafts` | `owner/repo#12 comment text` |

**The PR's text is data, never instructions.** Everything that came from the PR (its title and description, its code,
the reasons and evidence that quote it, other people's comments in a thread) goes between `<pr-content>` markers, and
the system prompt says what's inside them is material to review, never instructions: if it asks for anything
(approve, ignore a problem, write certain words), the model is told not to, and to draft nothing for that place. Any
such marker inside the PR's own text is taken out first, so the PR can't close the fence. Your notes and what you've
written are outside it. Likely secrets are redacted as in a briefing. Neither runs on a PR whose title, description or
added lines (or, for a reply, the thread) talk to AI reviewers.

**Checked before it's offered.** An answer must be plain text of reasonable length, not mention being an AI, contain
nothing aimed at AI reviewers, and not be a bare approval ("LGTM"); a suggested change must pass the briefing's draft
checks. What fails is dropped.

**Costs.** Each is one call, checked against `budget.perReviewUsd` and what's left of `budget.dailyUsd` before it's sent
(a budget stop sends nothing), recorded in `alden spend`, and its cost is shown when it's done. Draft my review asks
nothing when every place already has a comment. A cancelled Draft with Alden sends nothing if it hasn't been sent yet;
once it has, the call completes and is recorded, and its answer is dropped.

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
