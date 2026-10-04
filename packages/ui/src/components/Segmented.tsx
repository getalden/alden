import type { CSSProperties, ReactNode } from "react";

/**
 * A row of toggle buttons for one choice (effort, theme, …): a group named by `label`. A div rather than a fieldset:
 * browsers lay a fieldset's children out in an anonymous box that doesn't take the fieldset's height, so the buttons
 * sat at its top with empty space below. Here they stretch to fill it.
 */
export function Segmented(props: { label: string; title?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset can't stretch its buttons to its height (see above).
    <div role="group" className="segmented" aria-label={props.label} title={props.title} style={props.style}>
      {props.children}
    </div>
  );
}
