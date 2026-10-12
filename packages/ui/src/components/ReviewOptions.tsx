import type { ReviewRequest, Session } from "../api";

/**
 * What the next review will use. Starts from the config; changing it in the Tune popover is for this window only
 * (except the model, when the server can save it).
 */
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

/** A toggle; `labelledBy` names it by another element when its own label is empty. */
export function Switch(props: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  title?: string | undefined;
  labelledBy?: string | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={props.on}
      aria-labelledby={props.labelledBy}
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
