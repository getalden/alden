import type { ReviewRequest, Session } from "../api";
import { formatUsd } from "../format";

/** What the next review will use. Starts from the config; changing it here is for this session only. */
export interface Choices {
  llm: boolean;
  model: string;
  effort: string;
  graph: boolean;
}

export function initialChoices(session: Session | undefined): Choices {
  return {
    llm: session?.model.available ?? false,
    model: session?.model.name ?? "sonnet",
    effort: session?.model.effort ?? "",
    graph: true,
  };
}

/** Effort is Claude's, and Haiku 4.5 doesn't take it. */
export function effortSupported(session: Session, model: string): boolean {
  if (session.model.provider === "openai-compatible") return false;
  const id = session.aliases[model] ?? model;
  return !id.startsWith("claude-haiku");
}

export function toRequest(choices: Choices, session: Session | undefined): ReviewRequest {
  const effort = session && choices.effort && effortSupported(session, choices.model) ? choices.effort : undefined;
  return {
    llm: choices.llm,
    graph: choices.graph,
    ...(choices.llm && choices.model !== session?.model.name ? { model: choices.model } : {}),
    ...(choices.llm && effort ? { effort } : {}),
  };
}

/** The model, effort and code graph for the next review, with what it may cost. */
export function ReviewOptions({
  session,
  choices,
  onChange,
}: {
  session: Session | undefined;
  choices: Choices;
  onChange: (choices: Choices) => void;
}) {
  if (!session) return null;
  const available = session.model.available;
  const models =
    session.model.provider === "openai-compatible"
      ? [session.model.name]
      : [...new Set([session.model.name, ...Object.keys(session.aliases)])];
  const left = Math.max(0, session.budget.dailyUsd - session.budget.spentToday);
  const canEffort = effortSupported(session, choices.model);

  return (
    <fieldset className="options" aria-label="Review options">
      <label className="check-label" title={available ? undefined : session.model.reason}>
        <input
          type="checkbox"
          checked={choices.llm && available}
          disabled={!available}
          onChange={(e) => onChange({ ...choices, llm: e.target.checked })}
        />
        Ask the model
      </label>
      <label>
        <span className="visually-hidden">Model</span>
        <select
          value={choices.model}
          disabled={!available || !choices.llm}
          onChange={(e) => onChange({ ...choices, model: e.target.value })}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
              {m === session.model.name ? " (default)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label
        title={
          canEffort
            ? "How hard the model thinks: more effort, more time and cost"
            : "This model doesn't take an effort setting"
        }
      >
        <span className="visually-hidden">Effort</span>
        <select
          value={canEffort ? choices.effort : ""}
          disabled={!available || !choices.llm || !canEffort}
          onChange={(e) => onChange({ ...choices, effort: e.target.value })}
        >
          <option value="">Default effort</option>
          {session.efforts.map((e) => (
            <option key={e} value={e}>
              {e} effort
            </option>
          ))}
        </select>
      </label>
      <label
        className="check-label"
        title="Find who calls the changed code. PRs need alden ui started in a clone of their repo."
      >
        <input
          type="checkbox"
          checked={choices.graph}
          onChange={(e) => onChange({ ...choices, graph: e.target.checked })}
        />
        Callers
      </label>
      <span className="faint small cap">
        {available && choices.llm
          ? `Capped at ${formatUsd(session.budget.perReviewUsd)} · ${formatUsd(left)} left today`
          : available
            ? "Checks only: no model cost"
            : "No model set up: checks only"}
      </span>
    </fieldset>
  );
}
