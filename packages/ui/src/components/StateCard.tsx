import type { ReactNode } from "react";

export type Tone = "solid" | "dashed" | "spin" | "warn" | "bad" | "ok";

/**
 * Setup, loading and error states: a glyph, what happened, what to do, the exact command when there is one, and one
 * action (plus at most one alternative).
 */
export function StateCard(props: {
  tone: Tone;
  glyph?: string;
  title: string;
  body?: ReactNode;
  command?: string | undefined;
  action?: ReactNode;
  alternative?: ReactNode;
  center?: boolean;
  live?: boolean;
}) {
  return (
    <div className={`state${props.center ? " center" : ""}`} role={props.live ? "status" : undefined}>
      <span className={`glyph ${props.tone === "solid" ? "" : props.tone}`} aria-hidden="true">
        {props.tone === "spin" ? "" : props.glyph}
      </span>
      <h2 className="title">{props.title}</h2>
      {props.body && <div className="body">{props.body}</div>}
      {props.command && <code className="cmd">{props.command}</code>}
      {(props.action || props.alternative) && (
        <div className="actions">
          {props.action}
          {props.alternative}
        </div>
      )}
    </div>
  );
}
