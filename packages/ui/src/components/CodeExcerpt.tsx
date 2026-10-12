import type { Excerpt } from "../guided";

const MARK = { add: "+", del: "−", ctx: " " } as const;
const SPOKEN = { add: "added", del: "removed", ctx: "unchanged" } as const;

/**
 * A few lines of a diff around a place: each line's number (the new file's, or the old one's for a removed line), a
 * quiet + or −, and the place's own line picked out. The brief's places show one when open, the walk-through one at
 * each step and beside each related file in the diff.
 */
export function CodeExcerpt({ path, excerpt }: { path: string; excerpt: Excerpt }) {
  const numbers = excerpt.lines.flatMap((l) => l.newLine ?? l.oldLine ?? []);
  const label =
    numbers.length > 0 ? `${path}, lines ${Math.min(...numbers)} to ${Math.max(...numbers)}` : `${path}, excerpt`;
  return (
    <section className="excerpt" aria-label={label}>
      <table>
        <tbody>
          {excerpt.lines.map((line, i) => {
            const focused = excerpt.focus !== undefined && line.newLine === excerpt.focus;
            return (
              <tr
                // Lines repeat their text; their position in the hunk is what's stable.
                // biome-ignore lint/suspicious/noArrayIndexKey: the excerpt is a fixed slice
                key={i}
                className={`ex-${line.kind}${focused ? " ex-focus" : ""}`}
                aria-current={focused ? "location" : undefined}
              >
                <td className="ex-n" aria-hidden="true">
                  {line.newLine ?? line.oldLine ?? ""}
                </td>
                <td className="ex-m" aria-hidden="true">
                  {MARK[line.kind]}
                </td>
                <td className="ex-code">
                  <span className="visually-hidden">
                    {SPOKEN[line.kind]} line {line.newLine ?? line.oldLine}:{" "}
                  </span>
                  {line.text || " "}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
