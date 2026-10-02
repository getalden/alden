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

export function Switch(props: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  title?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={props.on}
      disabled={props.disabled}
      title={props.title}
      onClick={() => props.onChange(!props.on)}
    >
      <span className="track" aria-hidden="true">
        <span className="knob" />
      </span>
      {props.label}
    </button>
  );
}

/** The model, effort and callers for the next review, and what it may cost. Sits in the briefing's toolbar. */
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
  const modelOn = choices.llm && available;

  return (
    <>
      <button
        type="button"
        className={`btn${modelOn ? " on neutral" : ""}`}
        aria-pressed={modelOn}
        disabled={!available}
        title={available ? "Ask the model as well as running the checks" : session.model.reason}
        onClick={() => onChange({ ...choices, llm: !choices.llm })}
      >
        {available ? "Ask the model" : "No model set up"}
      </button>
      <span className="divider" aria-hidden="true" />
      <select
        className="input mono"
        aria-label="Model"
        value={choices.model}
        disabled={!modelOn}
        onChange={(e) => onChange({ ...choices, model: e.target.value })}
      >
        {models.map((m) => (
          <option key={m} value={m}>
            {session.aliases[m] ?? m}
            {m === session.model.name ? " (default)" : ""}
          </option>
        ))}
      </select>
      <fieldset
        className="segmented"
        aria-label="Effort"
        title={
          canEffort
            ? "How hard the model thinks: more effort, more time and cost"
            : "This model doesn't take an effort setting"
        }
        style={{ margin: 0 }}
      >
        {session.efforts.map((e) => (
          <button
            key={e}
            type="button"
            aria-pressed={canEffort && choices.effort === e}
            disabled={!modelOn || !canEffort}
            onClick={() => onChange({ ...choices, effort: choices.effort === e ? "" : e })}
          >
            {e.charAt(0).toUpperCase() + e.slice(1)}
          </button>
        ))}
      </fieldset>
      <Switch
        on={choices.graph}
        label="Callers"
        title="Find who calls the changed code. PRs need alden ui started in a clone of their repo."
        onChange={(graph) => onChange({ ...choices, graph })}
      />
      <span className="cap" title={`${formatUsd(left)} left of today's ${formatUsd(session.budget.dailyUsd)}`}>
        {modelOn ? `cap ${formatUsd(session.budget.perReviewUsd)}` : "checks only"}
      </span>
    </>
  );
}
