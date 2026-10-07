import type { LookHere, RelatedFile } from "@alden/schema";
import type { CallSite } from "../graph/query.js";
import { fileKind } from "../queue/files.js";
import { type GraphContext, symbolKey } from "./types.js";

/** How many of each kind a place suggests: callers first, then tests, then importers. */
export const RELATED_CALLERS = 4;
export const RELATED_TESTS = 2;
export const RELATED_IMPORTERS = 2;

const isTest = (path: string) => fileKind(path) === "test";

/**
 * Files to look at beside one place, from what the code graph already worked out for the briefing (no new parsing):
 * code calling the changed symbols at the place, tests that call them or import their file, and files importing the
 * changed file. A place that is itself a caller (the callers check) gets the symbol's other callers and its tests; a
 * file still importing a moved or deleted module gets the module's other importers. One entry per file, never the
 * place's own file, at most `RELATED_CALLERS` + `RELATED_TESTS` + `RELATED_IMPORTERS`.
 */
export function relatedFiles(item: LookHere, graph: GraphContext): RelatedFile[] {
  const anchor = item.anchor;
  if (!anchor || item.source === "llm") return [];

  const callers: CallSite[] = [];
  const importers: CallSite[] = [];
  const inPlace = graph.changes.filter((c) => c.path === anchor.path);
  if (inPlace.length > 0) {
    // A changed file: the symbols around the line (all of the file's, when the line is outside every one).
    const line = anchor.line;
    const around = line ? inPlace.filter((c) => c.startLine <= line && line <= c.endLine) : inPlace;
    for (const change of around.length > 0 ? around : inPlace)
      callers.push(...(graph.callers.get(symbolKey(change)) ?? []));
  } else {
    // A caller outside the diff: the symbols it calls, and their other callers.
    const isSite = (s: CallSite) => s.path === anchor.path && (anchor.line === undefined || s.line === anchor.line);
    for (const change of graph.changes) {
      const sites = graph.callers.get(symbolKey(change)) ?? [];
      if (sites.some(isSite)) {
        callers.push(...sites);
        importers.push(...(graph.importers?.get(change.path) ?? []));
      }
    }
    for (const module of graph.modules ?? []) if (module.importers.some(isSite)) importers.push(...module.importers);
  }
  importers.push(...(graph.importers?.get(anchor.path) ?? []));

  const out: RelatedFile[] = [];
  const seen = new Set([anchor.path]);
  const take = (sites: CallSite[], why: RelatedFile["why"], max: number) => {
    let taken = 0;
    for (const site of sites) {
      if (taken >= max) break;
      if (seen.has(site.path)) continue;
      seen.add(site.path);
      out.push({ path: site.path, line: site.line, why });
      taken++;
    }
  };
  // Sure matches before name-only ones, then by path, so the same graph always suggests the same files.
  const order = (sites: CallSite[]) =>
    [...sites].sort(
      (a, b) =>
        Number(a.confidence === "name") - Number(b.confidence === "name") ||
        a.path.localeCompare(b.path) ||
        a.line - b.line,
    );
  take(order(callers.filter((s) => !isTest(s.path))), "caller", RELATED_CALLERS);
  // A test's call to the symbol says more than its import line.
  take(
    [...order(callers), ...order(importers)].filter((s) => isTest(s.path)),
    "test",
    RELATED_TESTS,
  );
  take(order(importers.filter((s) => !isTest(s.path))), "importer", RELATED_IMPORTERS);
  return out;
}

/** Adds `related` to each place that has any. */
export function withRelated(eyes: LookHere[], graph: GraphContext | undefined): LookHere[] {
  if (!graph) return eyes;
  return eyes.map((item) => {
    const related = relatedFiles(item, graph);
    return related.length > 0 ? { ...item, related } : item;
  });
}
