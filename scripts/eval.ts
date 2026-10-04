/**
 * Replays the recorded PRs through the real model review and measures it:
 * `pnpm eval [--model opus] [--effort medium] [--only nextjs] [--clones ~/src] [--yes]`.
 *
 * `--no-llm` measures the checks and code graph alone: free, no key needed, and the baseline the model adds to.
 * `--only reg` runs just the regression cases (PRs a later PR had to fix); `--only reg-cli,hugo` takes several, and
 * `--pr gohugoio/hugo#15231,cli/cli#13009` picks single PRs. `--eyes <n>` sets how many places "Needs your eyes"
 * holds (`review.eyes`).
 *
 * `--replay <results file>` re-scores a saved run without calling the model: the same model answers, re-picked with
 * today's code and `--eyes`, so tuning how places are picked costs nothing. It needs a run saved since replays
 * existed (each row keeps the model's findings).
 *
 * Without --yes it only prints what the run could cost. With --yes it calls the configured provider (spending against
 * your caps and ledger like any review) and writes eval/results/<time>-<model>.json. Measures what needs no labels
 * (usable-output rate, findings dropped for bad locations, cost, time, verdicts) plus eval/expectations.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import {
  addModelReview,
  buildBriefing,
  buildGraphReview,
  checkoutPullRequest,
  type Effort,
  estimateTokens,
  fromRestFile,
  loadConfig,
  MAX_OUTPUT_TOKENS,
  mergeLookHere,
  type RawPullRequest,
  type ReviewContext,
  renderFileDiff,
  SpendLedger,
  selectProvider,
  toFacts,
  worstCaseUsd,
} from "../packages/core/src/index.js";
import type { Briefing, LlmSection } from "../packages/schema/src/index.js";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "packages/core/src/github/__fixtures__");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

interface Expectation {
  /** The PR that had to fix this one, for regression cases. */
  fixedBy?: number;
  mustFlag?: { path: string; line?: number; why: string }[];
  maxSlotsOnGlob?: { glob: string; max: number; why: string };
}
const expectations = JSON.parse(readFileSync(join(ROOT, "eval/expectations.json"), "utf8")) as Record<
  string,
  Expectation
>;

const config = await loadConfig();
const eyesFlag = flag("--eyes");
if (eyesFlag) config.review.eyes = Number(eyesFlag);
const replayFile = flag("--replay");
/** A saved run's model answers, by PR, for --replay. */
const replayed = replayFile
  ? new Map(
      (JSON.parse(readFileSync(replayFile, "utf8")) as { rows: { id: string; llm?: LlmSection }[] }).rows.map((r) => [
        r.id,
        r.llm,
      ]),
    )
  : undefined;
if (replayed && [...replayed.values()].every((llm) => llm === undefined)) {
  console.error(`${replayFile} has no saved model answers to replay: it was saved before replays existed.`);
  process.exit(1);
}
const noLlm = args.includes("--no-llm") || replayed !== undefined;
const choice = noLlm ? undefined : selectProvider(config, flag("--model"));
if (choice && !choice.ok) {
  console.error(choice.reason);
  process.exit(1);
}
const provider = choice?.ok ? choice.provider : undefined;
const effort = (flag("--effort") ?? config.model.effort) as Effort | undefined;

// Every recorded PR as the briefing Alden would build offline, with its description.
const only = flag("--only")?.split(",");
const pick = flag("--pr")?.split(",");
const recordedCases = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json") && (!only || only.some((o) => f.startsWith(o))))
  .flatMap((f) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as {
      name: string;
      language: string;
      pullRequests: (RawPullRequest & { body?: string })[];
    };
    return fixture.pullRequests.map((raw) => {
      const files = (
        JSON.parse(readFileSync(join(FIXTURES, "diffs", `${fixture.name}-${raw.number}.json`), "utf8")) as Parameters<
          typeof fromRestFile
        >[0][]
      ).map(fromRestFile);
      const pr = toFacts(raw, { login: "eval", teams: new Set() });
      const context: ReviewContext = {
        target: {
          kind: "pr",
          repo: pr.repo,
          number: pr.number,
          url: pr.url,
          title: pr.title,
          author: pr.author,
          baseRef: pr.baseRef,
          headRef: pr.headRef,
        },
        files,
        pr,
        config,
        manifests: [],
      };
      const briefing = buildBriefing(context);
      return {
        id: `${pr.repo}#${pr.number}`,
        context,
        name: fixture.name,
        language: fixture.language,
        repo: pr.repo,
        number: pr.number,
        raw,
        pr,
        briefing,
        files,
        description: raw.body ?? "",
      };
    });
  });
const cases = recordedCases.filter((c) => !pick || pick.includes(c.id));

if (provider) {
  const worst = cases.reduce(
    (sum, c) =>
      sum +
      (worstCaseUsd(
        provider.model,
        estimateTokens(c.files.map(renderFileDiff).join("\n")) + 3_000,
        MAX_OUTPUT_TOKENS,
      ) ?? 0),
    0,
  );
  console.log(
    `${cases.length} recorded PRs with ${provider.model} via ${provider.provider}${effort ? ` at effort ${effort}` : ""}. Worst case about $${worst.toFixed(2)}; typically far less.`,
  );
  if (!args.includes("--yes")) {
    console.log("Nothing sent. Add --yes to run it, or --no-llm to measure the checks alone for free.");
    process.exit(0);
  }
} else if (replayed) {
  console.log(
    `${cases.length} recorded PRs, replaying the model's answers from ${replayFile} with ${config.review.eyes} places to look (no cost).`,
  );
} else {
  console.log(`${cases.length} recorded PRs, checks and code graph only (no model, no cost).`);
}

interface EvalRow {
  id: string;
  language: string;
  regression: boolean;
  /** For regression cases: the files the fix changed, and whether the briefing pointed at each. */
  broke: { path: string; inEyes: boolean; flagged: boolean }[];
  /** The first answer ran out of room while thinking, and a low-effort retry answered. */
  retried?: boolean;
  llm?: LlmSection;
  status: string | undefined;
  note: string | undefined;
  seconds: number;
  usd: number | undefined;
  verdict: string | undefined;
  findings: number;
  dropped: number;
  modelSlots: number;
  mustFlag: { path: string; line?: number; why: string; hit: boolean }[];
  slotsOnGlob: number | undefined;
  slotCapOk: boolean | undefined;
  summary: string | undefined;
  titles: string[];
}

// With --clones <dir>, recorded repos cloned there (dir/django, dir/hugo, …) get the code graph, like a real review.
const clones = flag("--clones");
async function withGraph(c: (typeof cases)[number]) {
  const clone = clones ? join(clones, c.name) : undefined;
  if (!clone || !existsSync(clone)) return { briefing: c.briefing, callerSnippets: undefined };
  const checkout = await checkoutPullRequest(clone, c.repo, c.number);
  if (!checkout.ok) return { briefing: c.briefing, callerSnippets: undefined };
  const graph = await buildGraphReview(checkout.root, c.files);
  const briefing = buildBriefing({ ...c.context, graph: graph.context });
  return { briefing, callerSnippets: graph.callerSnippets };
}

const ledger = new SpendLedger();
const rows: EvalRow[] = [];
for (const c of cases) {
  const started = Date.now();
  const { briefing: base, callerSnippets } = await withGraph(c);
  const saved = replayed?.get(c.id);
  const result: Briefing = saved
    ? {
        ...base,
        llm: saved,
        needsYourEyes:
          saved.status === "ok"
            ? mergeLookHere(base.needsYourEyes, base.checks, saved.findings, config.review.eyes)
            : base.needsYourEyes,
      }
    : provider
      ? await addModelReview(base, {
          provider,
          config,
          ledger,
          files: c.files,
          description: c.description,
          ...(callerSnippets ? { callerSnippets } : {}),
          ...(effort ? { effort } : {}),
        })
      : base;
  const seconds = (Date.now() - started) / 1000;
  const llm = result.llm;
  const places = [
    ...result.needsYourEyes.flatMap((i) => (i.anchor ? [i.anchor] : [])),
    ...(llm?.findings ?? []).flatMap((f) => f.anchors),
  ];
  const exp = expectations[c.id];
  const mustFlag = (exp?.mustFlag ?? []).map((m) => ({
    ...m,
    hit: places.some((p) => p.path === m.path && (m.line === undefined || p.line === m.line)),
  }));
  const slotCap = exp?.maxSlotsOnGlob;
  const slotsOnGlob = slotCap
    ? result.needsYourEyes.filter((i) => i.anchor && picomatch(slotCap.glob, { dot: true })(i.anchor.path)).length
    : undefined;
  // "Did the briefing point at the code that broke": in its few places to look (strict), or in any flagged check's
  // evidence or model finding (loose).
  const eyes = new Set(result.needsYourEyes.flatMap((i) => (i.anchor ? [i.anchor.path] : [])));
  const flagged = new Set([
    ...result.checks
      .filter((k) => k.status === "flagged")
      .flatMap((k) => k.evidence.flatMap((e) => (e.anchor ? [e.anchor.path] : []))),
    ...(llm?.findings ?? []).flatMap((f) => f.anchors.map((a) => a.path)),
    ...eyes,
  ]);
  const regression = exp?.fixedBy !== undefined;
  rows.push({
    id: c.id,
    language: c.language,
    regression,
    broke: regression
      ? (exp?.mustFlag ?? []).map((m) => ({ path: m.path, inEyes: eyes.has(m.path), flagged: flagged.has(m.path) }))
      : [],
    status: llm?.status,
    note: llm?.note,
    seconds,
    usd: llm?.usd,
    verdict: llm?.matchesTitle?.verdict,
    findings: llm?.findings.length ?? 0,
    dropped: llm?.droppedFindings ?? 0,
    modelSlots: result.needsYourEyes.filter((i) => i.source === "llm").length,
    mustFlag,
    slotsOnGlob,
    slotCapOk: slotCap ? (slotsOnGlob ?? 0) <= slotCap.max : undefined,
    summary: llm?.summary,
    titles: llm?.findings.map((f) => `[${f.severity}] ${f.title}`) ?? [],
    // The whole model answer, so --replay can re-pick places from it later without calling the model.
    ...(llm ? { llm } : {}),
    retried: llm?.status === "ok" && llm.effort === "low" && llm.note !== undefined,
  });
  const row = rows.at(-1);
  const broke = row?.broke.length
    ? `  broke: ${row.broke.filter((b) => b.inEyes).length}/${row.broke.length} in eyes, ${row.broke.filter((b) => b.flagged).length}/${row.broke.length} flagged`
    : "";
  console.log(
    provider
      ? `${c.id.padEnd(30)} ${String(llm?.status).padEnd(10)} ${seconds.toFixed(1).padStart(5)}s  $${(llm?.usd ?? 0).toFixed(3)}  ${row?.findings} findings, ${row?.dropped} dropped${llm?.effort === "low" && llm.note ? " (retried at low effort)" : ""}${broke}${llm?.status !== "ok" && llm?.note ? `\n${" ".repeat(31)}${llm.note}` : ""}`
      : `${c.id.padEnd(30)} ${seconds.toFixed(1).padStart(5)}s${broke}`,
  );
}

const ok = rows.filter((r) => r.status === "ok");
const totalFindings = rows.reduce((n, r) => n + r.findings + r.dropped, 0);
const checks = rows.flatMap((r) => r.mustFlag);
// By language, over the regression cases: the share of broken files each briefing pointed at.
const regressions = rows.filter((r) => r.regression);
const rate = (list: EvalRow[], key: "inEyes" | "flagged") => {
  const all = list.flatMap((r) => r.broke);
  return all.length === 0 ? "–" : `${all.filter((b) => b[key]).length}/${all.length}`;
};
const byLanguage = Object.fromEntries(
  [...new Set(regressions.map((r) => r.language))].sort().map((language) => {
    const list = regressions.filter((r) => r.language === language);
    return [language, { cases: list.length, inEyes: rate(list, "inEyes"), flagged: rate(list, "flagged") }];
  }),
);
const summary = {
  model: provider?.model ?? (replayed ? `replay of ${replayFile}` : "checks only"),
  eyes: config.review.eyes,
  provider: provider?.provider ?? "none",
  graph: clones ? "with clones" : "diff only",
  regressions: {
    cases: regressions.length,
    inEyes: rate(regressions, "inEyes"),
    flagged: rate(regressions, "flagged"),
    byLanguage,
  },
  effort: effort ?? "default",
  at: new Date().toISOString(),
  prs: rows.length,
  usableRate: ok.length / rows.length,
  retried: rows.filter((r) => r.retried).length,
  droppedRate: totalFindings === 0 ? 0 : rows.reduce((n, r) => n + r.dropped, 0) / totalFindings,
  totalUsd: rows.reduce((n, r) => n + (r.usd ?? 0), 0),
  medianSeconds: [...rows.map((r) => r.seconds)].sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  verdicts: Object.fromEntries(
    ["yes", "partly", "no", "unclear"].map((v) => [v, rows.filter((r) => r.verdict === v).length]),
  ),
  mustFlag: `${checks.filter((c) => c.hit).length}/${checks.length}`,
  slotCaps: `${rows.filter((r) => r.slotCapOk === true).length}/${rows.filter((r) => r.slotCapOk !== undefined).length}`,
};
console.log(`\n${JSON.stringify(summary, null, 2)}`);

mkdirSync(join(ROOT, "eval/results"), { recursive: true });
const file = join(
  ROOT,
  "eval/results",
  `${summary.at.replace(/[:.]/g, "-")}-${provider ? `${provider.model}-${summary.effort}` : replayed ? `replay-eyes${config.review.eyes}` : "checks-only"}.json`,
);
writeFileSync(file, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(`Saved ${file}`);
