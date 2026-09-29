/**
 * Replays the recorded PRs through the real model review and measures it:
 * `pnpm eval [--model opus] [--effort medium] [--only nextjs] [--yes]`.
 *
 * Without --yes it only prints what the run could cost. With --yes it calls the configured provider (spending against
 * your caps and ledger like any review) and writes eval/results/<time>-<model>.json. Measures what needs no labels
 * (usable-output rate, findings dropped for bad locations, cost, time, verdicts) plus eval/expectations.json.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import {
  addModelReview,
  buildBriefing,
  type Effort,
  estimateTokens,
  fromRestFile,
  loadConfig,
  MAX_OUTPUT_TOKENS,
  type RawPullRequest,
  renderFileDiff,
  SpendLedger,
  selectProvider,
  toFacts,
  worstCaseUsd,
} from "../packages/core/src/index.js";
import type { Briefing } from "../packages/schema/src/index.js";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "packages/core/src/github/__fixtures__");
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

interface Expectation {
  mustFlag?: { path: string; line?: number; why: string }[];
  maxSlotsOnGlob?: { glob: string; max: number; why: string };
}
const expectations = JSON.parse(readFileSync(join(ROOT, "eval/expectations.json"), "utf8")) as Record<
  string,
  Expectation
>;

const config = await loadConfig();
const choice = selectProvider(config, flag("--model"));
if (!choice.ok) {
  console.error(choice.reason);
  process.exit(1);
}
const { provider } = choice;
const effort = (flag("--effort") ?? config.model.effort) as Effort | undefined;

// Every recorded PR as the briefing Alden would build offline, with its description.
const only = flag("--only");
const cases = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json") && (!only || f.startsWith(only)))
  .flatMap((f) => {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, f), "utf8")) as {
      name: string;
      pullRequests: (RawPullRequest & { body?: string })[];
    };
    return fixture.pullRequests.map((raw) => {
      const files = (
        JSON.parse(readFileSync(join(FIXTURES, "diffs", `${fixture.name}-${raw.number}.json`), "utf8")) as Parameters<
          typeof fromRestFile
        >[0][]
      ).map(fromRestFile);
      const pr = toFacts(raw, { login: "eval", teams: new Set() });
      const briefing = buildBriefing({
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
      });
      return { id: `${pr.repo}#${pr.number}`, briefing, files, description: raw.body ?? "" };
    });
  });

const worst = cases.reduce(
  (sum, c) =>
    sum +
    (worstCaseUsd(provider.model, estimateTokens(c.files.map(renderFileDiff).join("\n")) + 3_000, MAX_OUTPUT_TOKENS) ??
      0),
  0,
);
console.log(
  `${cases.length} recorded PRs with ${provider.model} via ${provider.provider}${effort ? ` at effort ${effort}` : ""}. Worst case about $${worst.toFixed(2)}; typically far less.`,
);
if (!args.includes("--yes")) {
  console.log("Nothing sent. Add --yes to run it.");
  process.exit(0);
}

interface EvalRow {
  id: string;
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

const ledger = new SpendLedger();
const rows: EvalRow[] = [];
for (const c of cases) {
  const started = Date.now();
  const result: Briefing = await addModelReview(c.briefing, {
    provider,
    config,
    ledger,
    files: c.files,
    description: c.description,
    ...(effort ? { effort } : {}),
  });
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
  rows.push({
    id: c.id,
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
  });
  console.log(
    `${c.id.padEnd(26)} ${String(llm?.status).padEnd(10)} ${seconds.toFixed(1).padStart(5)}s  $${(llm?.usd ?? 0).toFixed(3)}  ${rows.at(-1)?.findings} findings, ${rows.at(-1)?.dropped} dropped`,
  );
}

const ok = rows.filter((r) => r.status === "ok");
const totalFindings = rows.reduce((n, r) => n + r.findings + r.dropped, 0);
const checks = rows.flatMap((r) => r.mustFlag);
const summary = {
  model: provider.model,
  provider: provider.provider,
  effort: effort ?? "default",
  at: new Date().toISOString(),
  prs: rows.length,
  usableRate: ok.length / rows.length,
  droppedRate: totalFindings === 0 ? 0 : rows.reduce((n, r) => n + r.dropped, 0) / totalFindings,
  totalUsd: rows.reduce((n, r) => n + (r.usd ?? 0), 0),
  medianSeconds: [...rows.map((r) => r.seconds)].sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  verdicts: Object.fromEntries(
    ["yes", "partly", "no", "unclear"].map((v) => [v, rows.filter((r) => r.verdict === v).length]),
  ),
  mustFlag: `${checks.filter((c) => c.hit).length}/${checks.length}`,
  slotCaps: `${rows.filter((r) => r.slotCapOk === true).length}/${rows.filter((r) => r.slotCapOk !== undefined).length}`,
};
console.log("\n", summary);

mkdirSync(join(ROOT, "eval/results"), { recursive: true });
const file = join(ROOT, "eval/results", `${summary.at.replace(/[:.]/g, "-")}-${provider.model}-${summary.effort}.json`);
writeFileSync(file, `${JSON.stringify({ summary, rows }, null, 2)}\n`);
console.log(`Saved ${file}`);
