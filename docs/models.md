# Models, providers and budgets

A model is optional. Without one, Alden runs its deterministic checks. With one, the briefing also says what the change
does, whether it matches its title, and adds grouped findings anchored to lines in the diff.

Alden uses your own model account. It never uses Claude.ai or Claude Code subscription logins: Anthropic doesn't allow
third-party tools to use them.

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

Set `ANTHROPIC_API_KEY`, or sign in with `ant auth login`. `ANTHROPIC_AUTH_TOKEN` and workload identity federation also
work.

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

`alden spend` shows today's spend and recent days. The ledger is kept in `~/.alden/spend`, one file per day.

## When the model doesn't run

The briefing says why in one line, and the deterministic checks print as usual:

| Status | Meaning |
| --- | --- |
| skipped | No model configured, or `--no-llm`. |
| over budget | The review would exceed a cap. |
| refused | The model declined to review the change. |
| truncated | The model hit its output limit before finishing, so its answer was discarded. |
| failed | A network, rate-limit, credentials or setup error, or an answer in the wrong format. The reason is shown. |
