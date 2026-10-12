import { describe, expect, it } from "vitest";
import { briefing, draft, queue, queueWithYourTurn } from "./__fixtures__/fake.js";
import { keyFrom } from "./keys.js";
import { type Event, initialState, type State, update } from "./state.js";
import { view } from "./view.js";

function play(from: State, ...steps: (string | Event)[]): State {
  let state = from;
  for (const step of steps) {
    state = update(state, typeof step === "string" ? { type: "key", key: keyFrom(step) } : step, 3_000)[0];
  }
  return state;
}

/** The screen as text, at 80 by 24 unless said, without colour; trailing spaces dropped. */
const screen = (state: State) =>
  view(state, { color: false, now: 3_000 })
    .map((line) => line.trimEnd())
    .join("\n");

const start = (width = 80, height = 24) => initialState(width, height, 0)[0];
const loaded = (width = 80, height = 24) => play(start(width, height), { type: "queue-loaded", queue });
const briefed = (height = 24) =>
  play(loaded(80, height), "enter", { type: "briefing-loaded", id: 1, briefing: briefing() });

describe("the screens at 80 columns", () => {
  it("shows the queue loading with the CLI's progress", () => {
    expect(
      screen(play(start(80, 8), { type: "queue-progress", label: "Checking acme/api (1 of 2)…" })),
    ).toMatchInlineSnapshot(`
        " Alden  Your review queue
          ⠋ Checking acme/api (1 of 2)… 3s





         j/k move  / search  enter brief  o open  r refresh  q quit"
      `);
  });

  it("shows the queue as alden queue prints it, the selected row marked", () => {
    expect(screen(play(loaded(80, 18), "j"))).toMatchInlineSnapshot(`
      " Alden  Your review queue · 4 PRs
        Needs you (3)
        #   PR           Title                 Author            Waiting  Size      CI
        1.  acme/api#12  Charge cards in cen…  @sam              26h      +120/-10  pass
            touches payments
      › 2.  acme/web#7   Fix the login redir…  @lee              26h      +10/-2    pass
            blocks 2 PRs
        3.  acme/api#31  Retry webhooks with…  @sam              26h      +10/-2    fail
            CI failing: ping @sam

        Fast-track (1)
        #   PR           Title                 Author            Waiting  Size      CI
        4.  acme/api#15  Bump lodash           @dependabot[bot]  26h      +2/-2     pass
            dependency patch bump



       j/k move  / search  enter brief  o open  r refresh  q quit"
    `);
  });

  it("shows Your turn first, as alden queue prints it, with its row selectable", () => {
    const state = play(start(80, 14), { type: "queue-loaded", queue: queueWithYourTurn });
    const at = Date.parse("2026-10-12T10:00:00Z");
    expect(
      view(state, { color: false, now: at })
        .map((l) => l.trimEnd())
        .join("\n"),
    ).toMatchInlineSnapshot(`
      " Alden  Your review queue · 5 PRs
        Your turn (1)
      ›   acme/api#3  Cache the price list                                    2h ago
            @sam replied to your comment
            alden open <pr> or alden review <pr> opens one, and it leaves Your turn.

        Needs you (3)
        #   PR           Title                 Author            Waiting  Size      CI
        1.  acme/api#12  Charge cards in cen…  @sam              26h      +120/-10  pass
            touches payments
        2.  acme/web#7   Fix the login redir…  @lee              26h      +10/-2    pass
            blocks 2 PRs

       j/k move  / search  enter brief  o open  r refresh  q quit"
    `);
  });

  it("shows a search as it's typed, and when nothing matches", () => {
    expect(screen(play(loaded(80, 8), "/", "l", "e", "e"))).toMatchInlineSnapshot(`
      " Alden  Your review queue · 4 PRs · matching "lee"
        Needs you (1)
        #   PR          Title                       Author  Waiting  Size    CI
      › 1.  acme/web#7  Fix the login redirect      @lee    26h      +10/-2  pass
            blocks 2 PRs

       / lee█
       type to search title, repo, #number, author  enter keep  esc clear"
    `);
    expect(screen(play(loaded(80, 8), "/", "z", "z", "enter"))).toMatchInlineSnapshot(`
      " Alden  Your review queue · 4 PRs · matching "zz"
        No PRs match "zz". Esc clears the search.





       j/k move  / search  enter brief  o open  r refresh  q quit"
    `);
  });

  it("says why the queue couldn't load", () => {
    expect(
      screen(play(start(80, 8), { type: "queue-failed", error: "Not signed in. Run `alden auth login`." })),
    ).toMatchInlineSnapshot(`
        " Alden  Your review queue
          Not signed in. Run \`alden auth login\`.

          r tries again · q quits



         j/k move  / search  enter brief  o open  r refresh  q quit"
      `);
  });

  it("shows the briefing as alden review prints it, with the cursor and the place under it", () => {
    expect(
      screen(play(briefed(18), "2", { type: "feedback-saved", place: 1, verdict: "agree" }, "j")),
    ).toMatchInlineSnapshot(`
      " Alden  acme/api#12
        acme/api#12  Charge cards in cents
        @sam · main ← sam/cents · 2 files · +120/-10
        https://github.com/acme/api/pull/12

        Needs your eyes
       ✓  1. charge() changed: still called from src/cart.ts:12
             A caller outside the diff passes dollars.
       │  2. Refunds round to the cent:40
      ›│     Rounding moved from the API to the client.

        Checked
          ! Changed public signatures     high      charge() changed and is still
                                                    called from 2 files.
              src/pay.ts:12  changed:
                - charge(amount)

       j/k move  1-9 place  u/n useful/not  c comment  s send  m model  esc back"
    `);
  });

  it("shows a comment being written, where it goes", () => {
    const lines = screen(play(briefed(), "1", "c", "O", "k")).split("\n");
    expect(lines.slice(-2)).toEqual([" Comment on src/pay.ts:12: Ok█", " enter save  esc cancel  ctrl-u clear"]);
  });

  it("asks before running the model, with what it may cost", () => {
    const choice = {
      available: true,
      model: "claude-sonnet",
      perReviewUsd: 0.5,
      dailyUsd: 10,
      spentToday: 1.2,
    } as const;
    const lines = screen(play(briefed(), "m", { type: "model-checked", choice })).split("\n");
    expect(lines.slice(-2)).toEqual([
      " Run claude-sonnet? At most $0.50 a review; $1.20 of $10.00 spent today.",
      " y run the model  any other key cancels",
    ]);
  });

  it("shows exactly what alden send shows, and asks before sending", () => {
    const pending = {
      drafts: [draft()],
      unaddressed: [{ checkId: "money.rounding", title: "Refunds round" }],
      threads: [],
      unkept: 1,
    };
    const state = play(briefed(22), "s", { type: "pending-loaded", pr: "acme/api#12", pending }, "a", "enter");
    expect(screen(state)).toMatchInlineSnapshot(`
      " Alden  acme/api#12 · send your review
        Send as:  ( ) Comment   (•) Approve   ( ) Request changes

        1 draft by Alden not kept won't be sent: keep it (alden comment acme/api#12
        --keep <id> or --keep all), or drop it with --delete <id>.

        Review for acme/api#12: Approve

        Body
          (none)

        Comments (1)
          src/pay.ts:12
            Is this in cents?

        Places Alden flagged that you didn't comment on
          ! Refunds round



       Send this review to GitHub as an approval?
       y send to GitHub  any other key goes back"
    `);
  });

  it("wraps a long message onto the lines above the keys", () => {
    const long =
      "GitHub said your token can't see acme/api. Sign in again with `alden auth login`, or ask an admin of acme to approve Alden.";
    const lines = screen(play(loaded(80, 12), "r", { type: "queue-failed", error: long })).split("\n");
    expect(lines.slice(-3)).toEqual([
      " GitHub said your token can't see acme/api. Sign in again with `alden auth",
      " login`, or ask an admin of acme to approve Alden.",
      " j/k move  / search  enter brief  o open  r refresh  q quit",
    ]);
  });

  it("is exactly as tall as the terminal", () => {
    for (const state of [start(), loaded(), briefed(), loaded(80, 30), briefed(10)]) {
      expect(view(state, { color: false, now: 0 })).toHaveLength(state.height);
    }
  });

  it("says when the terminal is too small to use", () => {
    expect(screen(start(30, 6))).toMatchInlineSnapshot(`
      " Alden needs a bigger
       terminal: at least 80 by 24
       works best. Ctrl-C quits.


      "
    `);
  });

  it("uses colour only when asked (NO_COLOR)", () => {
    const has = (color: boolean) => view(play(loaded(), "j"), { color, now: 0 }).join("\n").includes("\u001b[");
    expect(has(false)).toBe(false);
    expect(has(true)).toBe(true);
  });
});
