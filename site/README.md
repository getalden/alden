# getalden.dev

The landing page and the docs, built into `site/dist` and served by Cloudflare Pages.

- `site/src` is the landing page from the "Alden Site v2" Claude Design project: static HTML, CSS and a small script for
  its animations (still under reduced motion). Fonts are the same bundled Geist files as the app.
- The docs are the repo's own `docs/*.md`, rendered by `site/build.ts` in the order `docs/README.md` lists them.
- `site/src/assets/screens` are real screenshots of `alden ui` over the demo data (checks only, no model), for the home
  page, the README and the docs: `pnpm screenshots` retakes them; `site/src/assets/og.png` is the social card made from
  one. Docs pages show them with a relative link, `![alt](../site/src/assets/screens/x.png)`, which works on GitHub and
  which `build.ts` turns into `/assets/screens/x.png` on the site.

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
