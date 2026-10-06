import type { RankingState, RankPreview, RankRule, RankRuleThen, RankWeight, RankWeights } from "@alden/schema";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "../api";

/**
 * Settings → Ranking: how much each of the queue's signals counts, rules that pin or move PRs, and how many of the
 * top PRs the desktop app keeps briefed. Saved to your user config as `[queue.rank]` and `background.prepare`; the
 * preview ranks your current queue with what's on screen before you save.
 */

/** The signals, in the order the page lists them, as a person would name them, and what each is worth at 1×. */
export const WEIGHTS: { name: RankWeight; label: string; help: string }[] = [
  { name: "urgentLabel", label: "Urgent labels", help: "hotfix, urgent, critical, blocker, p0, sev1 · 6 points" },
  { name: "stacked", label: "PRs stacked on it", help: "other open PRs built on top of it · 4 points" },
  { name: "sameAuthor", label: "A teammate with several PRs waiting", help: "unblocks one person at once · 2 points" },
  { name: "ownsFiles", label: "Files you own", help: "through CODEOWNERS · 1 point" },
  { name: "waiting", label: "Waiting time", help: "1.5 points after 4 hours, 3 after a day, 4.5 after three days" },
  { name: "size", label: "Size", help: "lines to read, lockfiles aside · up to 3 points" },
  {
    name: "risk",
    label: "Risky changes",
    help: "migrations, auth, payments, infra, CI, lockfiles, major bumps · 2 each",
  },
  { name: "noTests", label: "No test changes", help: "code changes without tests · 1 point" },
  { name: "learned", label: "What Alden learned", help: "from the PRs you open first or mark useful · up to 3 points" },
];

const DEFAULT_WEIGHTS = Object.fromEntries(WEIGHTS.map((w) => [w.name, 1])) as Record<RankWeight, number>;
const DEFAULT_PREPARE = 3;
const SLIDER_MAX = 3;
const PREVIEW_DELAY_MS = 350;

const THEN_LABELS: Record<RankRuleThen, string> = {
  first: "Put first",
  last: "Put last",
  boost: "Boost",
  lower: "Lower",
};

const CONDITIONS = [
  { key: "path", label: "Touches path", placeholder: "payments/ or **/*.sql" },
  { key: "label", label: "Has label", placeholder: "security" },
  { key: "author", label: "Author", placeholder: "sam, bots, agents, people" },
  { key: "repo", label: "Repo or organisation", placeholder: "acme/shop or acme" },
  { key: "base", label: "Merges into", placeholder: "main or release/*" },
  { key: "title", label: "Title contains", placeholder: "hotfix" },
] as const;

type ConditionKey = (typeof CONDITIONS)[number]["key"];

const AUTHOR_KINDS: Record<string, string> = { people: "people", bots: "bots", agents: "AI agents" };

/** What a rule matches, as the queue says it: "payments/", "labelled security and into main". Mirrors the engine. */
export function describeRule(rule: RankRule): string {
  const { when } = rule;
  const parts: string[] = [];
  if (when.path) parts.push(when.path);
  if (when.label) parts.push(`labelled ${when.label}`);
  if (when.author) {
    const author = when.author.trim().replace(/^@/, "");
    parts.push(AUTHOR_KINDS[author.toLowerCase()] ?? `@${author}`);
  }
  if (when.repo) parts.push(when.repo);
  if (when.base) parts.push(`into ${when.base}`);
  if (when.title) parts.push(`"${when.title}" in title`);
  const what = rule.name ?? parts.join(" and ");
  const effect =
    rule.then === "first" || rule.then === "last" ? rule.then : `${rule.then === "boost" ? "+" : "−"}${rule.by ?? 5}`;
  return `${rule.then === "first" || rule.then === "boost" ? "↑" : "↓"} ${what} ${effect}`;
}

const weightsOf = (settings: RankWeights): Record<RankWeight, number> =>
  Object.fromEntries(WEIGHTS.map((w) => [w.name, settings[w.name]])) as Record<RankWeight, number>;

const sameWeights = (a: Record<RankWeight, number>, b: Record<RankWeight, number>) =>
  WEIGHTS.every((w) => a[w.name] === b[w.name]);

const times = (n: number) => `×${Math.round(n * 100) / 100}`;

/** A rule on the page, with a key that follows it when it's moved. */
interface Listed {
  key: number;
  rule: RankRule;
}

let nextKey = 0;
const listed = (rules: RankRule[]): Listed[] => rules.map((rule) => ({ key: nextKey++, rule }));

export function RankingSettings(props: { api: Api; desktop: boolean; onSaved: () => void }) {
  const { api } = props;
  const [loaded, setLoaded] = useState<RankingState>();
  const [loadError, setLoadError] = useState<string>();
  const [weights, setWeights] = useState<Record<RankWeight, number>>(DEFAULT_WEIGHTS);
  const [list, setList] = useState<Listed[]>([]);
  const rules = list.map((l) => l.rule);
  const [prepare, setPrepare] = useState(DEFAULT_PREPARE);
  /** The rule being edited: its index, or "new"; undefined when the form is closed. */
  const [editing, setEditing] = useState<number | "new">();
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string }>();
  const [saving, setSaving] = useState(false);

  const reset = useCallback((state: RankingState) => {
    setLoaded(state);
    setWeights(weightsOf(state.settings));
    setList(listed(state.settings.rules));
    setPrepare(state.prepare);
  }, []);

  useEffect(() => {
    api.rank().then(reset, (e: Error) => setLoadError(e.message));
  }, [api, reset]);

  const dirty =
    loaded !== undefined &&
    (!sameWeights(weights, weightsOf(loaded.settings)) ||
      JSON.stringify(rules) !== JSON.stringify(loaded.settings.rules) ||
      prepare !== loaded.prepare);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setStatus(undefined);
    try {
      const saved = await api.saveRank({
        weights: Object.fromEntries(WEIGHTS.map((w) => [w.name, weights[w.name] === 1 ? null : weights[w.name]])),
        rules,
        ...(props.desktop ? { prepare: prepare === DEFAULT_PREPARE ? null : prepare } : {}),
      });
      reset(saved);
      setStatus({ tone: "ok", text: "Saved. The queue uses it on its next refresh." });
      props.onSaved();
    } catch (error) {
      setStatus({ tone: "error", text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const moveRule = (from: number, to: number) => {
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    const [item] = next.splice(from, 1);
    if (item) next.splice(to, 0, item);
    setList(next);
  };

  if (!loaded) {
    return (
      <div className="card panel" aria-busy={!loadError}>
        <h2 className="label">Ranking</h2>
        {loadError ? (
          <p className="error-text small">Couldn't load your ranking settings: {loadError}</p>
        ) : (
          <p className="muted small">Loading…</p>
        )}
      </div>
    );
  }

  return (
    <form className="card panel rank-settings" onSubmit={save} aria-labelledby="ranking-title">
      <div className="section-head">
        <h2 className="label" id="ranking-title">
          Ranking
        </h2>
        {dirty && <span className="faint small">Unsaved changes</span>}
      </div>
      <p className="muted small">
        How Alden orders Needs you. Each signal counts by its weight: 0 ignores it, ×1 is the default, ×2 doubles it.
        Your rules come after, and what Alden learns never overrides them.
      </p>

      <div className="section-head">
        <h3 className="label">Weights</h3>
        <button
          type="button"
          className="btn xs"
          disabled={sameWeights(weights, DEFAULT_WEIGHTS)}
          onClick={() => setWeights(DEFAULT_WEIGHTS)}
        >
          Reset
        </button>
      </div>
      <ul className="rank-weights">
        {WEIGHTS.map((w) => {
          const value = weights[w.name];
          const id = `weight-${w.name}`;
          return (
            <li key={w.name}>
              <label htmlFor={id} className="rank-weight-name">
                {w.label}
                <span className="help">{w.help}</span>
              </label>
              <input
                id={id}
                type="range"
                min={0}
                max={Math.max(SLIDER_MAX, value)}
                step={0.25}
                value={value}
                aria-valuetext={value === 0 ? "ignored" : times(value)}
                onChange={(e) => setWeights({ ...weights, [w.name]: Number(e.target.value) })}
              />
              <span className={`rank-weight-value mono${value === 1 ? " faint" : ""}`}>
                {value === 0 ? "off" : times(value)}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="section-head sep">
        <h3 className="label">Rules</h3>
        {editing === undefined && (
          <button type="button" className="btn xs" onClick={() => setEditing("new")}>
            Add a rule
          </button>
        )}
      </div>
      {rules.length === 0 && editing === undefined && (
        <p className="muted small">
          None yet. A rule puts PRs first or last in their lane, or boosts or lowers them: "PRs touching payments/
          first", "bots last". Rules apply in order; the first first-or-last rule a PR matches decides.
        </p>
      )}
      {rules.length > 0 && (
        <ol className="rank-rules">
          {list.map(({ key, rule }, i) =>
            editing === i ? (
              <li key={key}>
                <RuleForm
                  initial={rule}
                  onCancel={() => setEditing(undefined)}
                  onDone={(changed) => {
                    setList(list.map((l, j) => (j === i ? { key: l.key, rule: changed } : l)));
                    setEditing(undefined);
                  }}
                />
              </li>
            ) : (
              <li key={key} className="rank-rule">
                <span className="rank-rule-text">{describeRule(rule)}</span>
                <span className="rank-rule-actions">
                  <button
                    type="button"
                    className="btn xs quiet"
                    aria-label={`Move rule ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => moveRule(i, i - 1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn xs quiet"
                    aria-label={`Move rule ${i + 1} down`}
                    disabled={i === rules.length - 1}
                    onClick={() => moveRule(i, i + 1)}
                  >
                    ↓
                  </button>
                  <button type="button" className="btn xs" onClick={() => setEditing(i)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn xs"
                    aria-label={`Delete rule ${i + 1}`}
                    onClick={() => {
                      setList(list.filter((_, j) => j !== i));
                      setEditing(undefined);
                    }}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ),
          )}
        </ol>
      )}
      {editing === "new" && (
        <RuleForm
          onCancel={() => setEditing(undefined)}
          onDone={(rule) => {
            setList([...list, ...listed([rule])]);
            setEditing(undefined);
          }}
        />
      )}

      {props.desktop && (
        <>
          <h3 className="label sep">In the background</h3>
          <div className="field rank-prepare">
            <label htmlFor="rank-prepare">Keep the top PRs briefed in the background</label>
            <span className="rank-stepper">
              <button
                type="button"
                className="btn xs"
                aria-label="Fewer"
                disabled={prepare <= 0}
                onClick={() => setPrepare(prepare - 1)}
              >
                −
              </button>
              <input
                id="rank-prepare"
                className="input mono"
                type="number"
                min={0}
                max={10}
                value={prepare}
                onChange={(e) => setPrepare(Math.max(0, Math.min(10, Math.round(Number(e.target.value) || 0))))}
              />
              <button
                type="button"
                className="btn xs"
                aria-label="More"
                disabled={prepare >= 10}
                onClick={() => setPrepare(prepare + 1)}
              >
                +
              </button>
            </span>
            <span className="help">
              {prepare === 0
                ? "None: Alden won't brief PRs while you're away."
                : `The top ${prepare === 1 ? "PR" : `${prepare} PRs`} in this order, 0 to 10. Default 3.`}
              {!loaded.background && " Background briefings are off under While you're away."}
            </span>
          </div>
        </>
      )}

      <RankPreviewList
        api={api}
        weights={weights}
        rules={rules}
        saved={loaded.settings}
        prepare={props.desktop ? prepare : 0}
      />

      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save ranking"}
        </button>
        {dirty && (
          <button type="button" className="btn" disabled={saving} onClick={() => reset(loaded)}>
            Discard changes
          </button>
        )}
        {status && (
          <span className={status.tone === "error" ? "error-text" : "muted"} role="status">
            {status.text}
          </span>
        )}
      </div>
      <p className="faint small">
        Saved to <code>{loaded.path}</code> as <code>[queue.rank]</code>, only on this machine: a repo's{" "}
        <code>.alden.toml</code> can't change how you rank. <code>alden queue --explain</code> shows each PR's score.
      </p>
    </form>
  );
}

/** The add and edit form for one rule: any of the conditions (all must hold), and what to do. */
function RuleForm(props: { initial?: RankRule; onDone: (rule: RankRule) => void; onCancel: () => void }) {
  const [when, setWhen] = useState<Partial<Record<ConditionKey, string | undefined>>>(props.initial?.when ?? {});
  const [then, setThen] = useState<RankRuleThen>(props.initial?.then ?? "first");
  const [by, setBy] = useState(String(props.initial?.by ?? 5));
  const [name, setName] = useState(props.initial?.name ?? "");
  const [error, setError] = useState<string>();

  const done = () => {
    const conditions = Object.fromEntries(
      Object.entries(when)
        .map(([k, v]) => [k, v?.trim() ?? ""])
        .filter(([, v]) => v !== ""),
    ) as RankRule["when"];
    if (Object.keys(conditions).length === 0) {
      setError("Give the rule at least one condition.");
      return;
    }
    const points = Number(by);
    const moves = then === "boost" || then === "lower";
    if (moves && !(points > 0 && points <= 50)) {
      setError("Points are a number above 0, up to 50.");
      return;
    }
    props.onDone({
      when: conditions,
      then,
      ...(moves && points !== 5 ? { by: points } : {}),
      ...(name.trim() ? { name: name.trim() } : {}),
    });
  };

  return (
    // A group, not a nested form (it sits inside the Ranking form) and not a fieldset (see Segmented): Enter adds the
    // rule rather than saving the page.
    // biome-ignore lint/a11y/useSemanticElements: see above.
    <div className="rank-rule-form" role="group" aria-label={props.initial ? "Edit rule" : "New rule"}>
      <p className="faint small">When a PR… (every condition you fill in must hold)</p>
      <div className="two">
        {CONDITIONS.map((c) => (
          <label key={c.key} className="field">
            {c.label}
            <input
              className="input mono"
              value={when[c.key] ?? ""}
              placeholder={c.placeholder}
              list={c.key === "author" ? "rank-author-kinds" : undefined}
              onChange={(e) => setWhen({ ...when, [c.key]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  done();
                }
              }}
            />
          </label>
        ))}
      </div>
      <datalist id="rank-author-kinds">
        <option value="people" />
        <option value="bots" />
        <option value="agents" />
      </datalist>
      <div className="two">
        <label className="field">
          Then
          <select className="input" value={then} onChange={(e) => setThen(e.target.value as RankRuleThen)}>
            {(Object.keys(THEN_LABELS) as RankRuleThen[]).map((t) => (
              <option key={t} value={t}>
                {THEN_LABELS[t]}
              </option>
            ))}
          </select>
          <span className="help">
            {then === "first" || then === "last"
              ? `Above (or below) every PR no rule pins, in its lane.`
              : "Adds or takes away points; an urgent label is worth 6."}
          </span>
        </label>
        {then === "boost" || then === "lower" ? (
          <label className="field">
            Points
            <input className="input mono" inputMode="decimal" value={by} onChange={(e) => setBy(e.target.value)} />
          </label>
        ) : (
          <label className="field">
            Name on the row (optional)
            <input className="input" value={name} placeholder="payments" onChange={(e) => setName(e.target.value)} />
          </label>
        )}
      </div>
      <div className="form-actions">
        <button type="button" className="btn sm primary" onClick={done}>
          {props.initial ? "Done" : "Add rule"}
        </button>
        <button type="button" className="btn sm" onClick={props.onCancel}>
          Cancel
        </button>
        {error && (
          <span className="error-text small" role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/** "Top 5 with these settings": your current queue, re-ranked as you move the sliders, before anything is saved. */
function RankPreviewList(props: {
  api: Api;
  weights: Record<RankWeight, number>;
  rules: RankRule[];
  /** The saved settings, which the preview compares against: a save asks again. */
  saved: RankingState["settings"];
  /** How many the background keeps briefed, marked on the list; 0 marks none. */
  prepare: number;
}) {
  const [preview, setPreview] = useState<RankPreview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(true);
  const asked = useRef(0);
  const key = JSON.stringify([props.weights, props.rules, props.saved]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the weights, rules and saved settings.
  useEffect(() => {
    const ask = ++asked.current;
    setBusy(true);
    const timer = setTimeout(() => {
      props.api.previewRank({ weights: props.weights, rules: props.rules }).then(
        (result) => {
          if (ask !== asked.current) return;
          setPreview(result);
          setError(undefined);
          setBusy(false);
        },
        (e: Error) => {
          if (ask !== asked.current) return;
          setError(e.message);
          setBusy(false);
        },
      );
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
  }, [props.api, key]);

  return (
    <section className="rank-preview" aria-labelledby="rank-preview-title" aria-busy={busy}>
      <div className="section-head sep">
        <h3 className="label" id="rank-preview-title">
          Top 5 with these settings
        </h3>
        {busy && preview && <span className="faint small">Ranking…</span>}
      </div>
      {error ? (
        <p className="error-text small">{error}</p>
      ) : !preview ? (
        <p className="muted small">Ranking your queue…</p>
      ) : preview.problem ? (
        <p className="muted small">No preview: {preview.problem}</p>
      ) : preview.top.length === 0 ? (
        <p className="muted small">Nothing is waiting on you, so there's nothing to rank.</p>
      ) : (
        <ol className="rank-preview-list">
          {preview.top.map((row, i) => {
            const place = i + 1;
            const moved =
              row.was === null
                ? "new"
                : row.was === place
                  ? "same"
                  : row.was > place
                    ? `up from ${row.was}`
                    : `down from ${row.was}`;
            return (
              <li key={row.pr}>
                <span className="pr-rank">{String(place).padStart(2, "0")}</span>
                <span className="rank-preview-body">
                  <a href={row.url} target="_blank" rel="noreferrer" className="rank-preview-title">
                    {row.title}
                  </a>
                  <span className="faint small mono">
                    {row.pr} · score {Math.round(row.total * 100) / 100}
                    {place <= props.prepare ? " · briefed in the background" : ""}
                  </span>
                  {row.reasons.length > 0 && (
                    <span className="pr-chips">
                      {row.reasons.slice(0, 4).map((reason) => (
                        <span key={reason} className={`chip${/^[↑↓] your rule:/.test(reason) ? " rule" : ""}`}>
                          {reason}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span className={`rank-moved small${moved === "same" ? " faint" : ""}`}>
                  {moved === "same" ? "–" : moved === "new" ? "new" : moved}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {preview && !preview.problem && preview.needsYou > preview.top.length && (
        <p className="faint small">Of {preview.needsYou} in Needs you. Compared with your saved settings.</p>
      )}
    </section>
  );
}
