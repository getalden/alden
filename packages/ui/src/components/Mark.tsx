/**
 * Alden's mark: the gable of an old friend's house, drawn as three connected points around a lit core. `outline` is
 * the quiet version for empty states.
 */
export function Mark({ size = 20, outline = false }: { size?: number; outline?: boolean }) {
  const c = outline ? "var(--line2)" : "var(--acc)";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        d="M8 24 L16 8 L24 24"
        fill="none"
        stroke={c}
        strokeWidth={outline ? 2.4 : 3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {outline && (
        <path
          d="M8 24 L16 19 L24 24 M16 8 L16 19"
          fill="none"
          stroke={c}
          strokeWidth="1"
          strokeDasharray="1.5 2"
          opacity=".7"
        />
      )}
      <circle cx="8" cy="24" r={outline ? 2.2 : 2.6} fill={c} />
      <circle cx="16" cy="8" r={outline ? 2.2 : 2.6} fill={c} />
      <circle cx="24" cy="24" r={outline ? 2.2 : 2.6} fill={c} />
      <circle
        cx="16"
        cy="19"
        r={outline ? 2.6 : 3}
        fill={outline ? "none" : c}
        stroke={c}
        strokeWidth={outline ? 1.6 : 0}
      />
    </svg>
  );
}
