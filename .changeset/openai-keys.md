---
"alden": minor
---

**OpenAI API keys**, first-class: paste an Anthropic or an OpenAI key in `alden setup`, `alden auth model`, **Set up a model** or Settings → API keys and Alden detects which (sk-ant-… is Anthropic's, any other sk-… OpenAI's; Claude.ai sign-in tokens and admin keys are refused). An OpenAI key is checked with one tiny request to `gpt-6-luna`, stored in the keychain under its own name, and makes the new `openai` provider the model (`gpt-6.1-sol` by default; `gpt-6-astra` and `gpt-6-luna` in the picker). `OPENAI_API_KEY` comes before the stored key. Briefings use Structured Outputs in strict mode, `reasoning_effort` on the GPT-6 models, and spend is counted from OpenAI's list prices, cached input apart. `alden doctor` reports both keys, never the key. The local API gains `GET /api/models` and `PUT /api/models` for the model picker: the model in use, and each provider's models, offered only where they're set up here.
