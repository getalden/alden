# getalden.dev

The landing page and the docs, built into `site/dist` and served by Cloudflare Pages.

- `site/src` is the landing page from the "Alden Site v2" Claude Design project: static HTML, CSS and a small script for
  its animations (still under reduced motion). Fonts are the same bundled Geist files as the app.
- The docs are the repo's own `docs/*.md`, rendered by `site/build.ts` into the frame from the "Alden Docs v3" Claude
  Design project (`src/docs.css`, `src/docs.js`, `src/theme.js`): the sidebar is the groups under "All pages" in
  `docs/README.md`, in that order, and the build stops if a doc isn't in one. The rest of `docs/README.md` is the docs
  home, where its "Start here" list becomes the pathway cards. Search is `/docs/search.json`, built with the site and
  searched in the browser; "Copy page" copies each page's Markdown from `/docs/<page>/index.md`. The docs, benchmarks
  and Alden Cloud pages have light and dark themes (the system's, unless the footer's switch picks one); the home
  page is still dark only.
- `site/src/assets/screens` are real screenshots of `alden ui` over the demo data (checks only, no model), for the home
  page, the README and the docs: `pnpm screenshots` retakes them all (`scripts/screenshots.ts` lists each one and how
  it's set up; the first run's three steps come from a demo that starts signed out with no model,
  `ALDEN_DEMO_FIRST_RUN=1 ALDEN_DEMO_NO_MODEL=1 pnpm ui:demo`). Docs pages show them with a relative link,
  `![alt](../site/src/assets/screens/x.png)`, which works on GitHub and which `build.ts` turns into
  `/assets/screens/x.png` on the site. After retaking them, check the alt text where each is used still says what it
  shows (`git grep screens/`).
- `site/src/assets/og.png` is the social card (1200x630), for the site's `og:image` and GitHub's social preview:
  `pnpm og` renders `scripts/og.html` in headless Chrome with the site's font and `screens/briefing-dark.png`, so
  retake it after the screenshots. GitHub's copy is uploaded by hand: the repo's Settings → General → Social preview.
- `site/src/assets/demo.gif` is the README's demo (960x600, about 14 s, under 1 MB): `pnpm demo:gif` plays one review
  over the demo data in headless Chrome (queue, a PR's brief, Walk through, the Comments drawer, the send dialog and
  Back), samples screenshots at 11 fps and encodes them with gifenc, in pure JS. The README links it at
  `https://getalden.dev/assets/demo.gif` (the npm package carries the README, so its images need full URLs): it shows
  once the site is deployed.

```sh
pnpm site:build                       # site/dist
python3 -m http.server -d site/dist   # look at it
pnpm site:deploy                      # build and upload to the Cloudflare Pages project "getalden"
```

## Deploying

The Cloudflare Pages project `getalden` exists (created 2 Oct 2026; https://getalden.pages.dev). After
`pnpm dlx wrangler login`, `pnpm site:deploy` builds and uploads. Wrangler runs from `site/` because it refuses to run at
the root of a pnpm workspace.

The custom domain: in Cloudflare, Workers & Pages → getalden → Custom domains → add `getalden.dev` (and
`www.getalden.dev`). With the domain's DNS on Cloudflare that's one click; elsewhere, add the CNAME it shows.

If the project ever has to be recreated: `cd site && pnpm dlx wrangler@4 pages project create getalden
--production-branch main --force` (`--force` once, so wrangler makes a Pages project instead of a Worker).

`_headers` sets a strict Content-Security-Policy: everything is served from the site itself, and the only other host
a page may talk to is PostHog's EU ingest (`connect-src https://eu.i.posthog.com`), for the page view counts.

## Open source, on launch day

Until launch the site says Alden is "open source after the beta". One switch changes that, at build time:

```sh
pnpm site:build                       # today: "open source after the beta", no GitHub links
ALDEN_OPEN_SOURCE=1 pnpm site:build   # launch day: "open source, Apache-2.0" and links to github.com/getalden/alden
ALDEN_OPEN_SOURCE=1 pnpm site:deploy  # what RELEASING.md's "Launch day" runs, once the repo is public
```

`HOME_SWAPS` in `build.ts` lists each change to `src/index.html` as exact text, today's and launch day's: the hero's
kicker, the "source" line under 03 / yours, and a GitHub link in the header and the footer. The docs, benchmarks and
Alden Cloud pages get the same header and footer link. Without the flag the built home page is `src/index.html` as is,
and the build stops if any of today's texts can't be found, with or without the flag, so editing that copy means
updating `HOME_SWAPS` too. The README's own "Open source" section waits on the branch `launch/open-source`.

After launch, make the open-source wording the page's own text and remove the switch, so a deploy without the flag
can't bring the old wording back.

## Page view counts

`site.js` counts page views and clicks on install, copy and Discord links (`data-track` on a link or button names it;
Discord links count by their address) in the PostHog project Alden's usage stats use, with the same public key as
`TELEMETRY_KEY` in `packages/core/src/telemetry/telemetry.ts`. No cookies, no storage, no third-party script: a fresh
random id per page load and `$process_person_profile: false`. Events are `$pageview` and `site_click` (with `cta` and
`label`), with `$lib: "getalden.dev"`. It only runs on getalden.dev (not on localhost or pages.dev previews), and never
with Do Not Track or Global Privacy Control. What it sends is disclosed in `docs/privacy.md` ("This website"); change
both together.

## Benchmarks

`/benchmarks/` is `src/benchmarks.html`, wrapped in the docs' header and footer by `build.ts`. Every number on it comes
from a result file named on the page (`eval/results/`, `eval/e2e/`) or a measured session it describes; update the
date and version with the numbers.

## Alden Cloud

`/cloud/` is `src/cloud.html`, in the same frame. Alden Cloud isn't built: the page describes what's planned (marked as
planned, prices included) and the waitlist is an email to beta@getalden.dev or the Discord, with no form. Change it
when the plan changes.
