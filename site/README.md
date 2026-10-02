# getalden.dev

The landing page and the docs, built into `site/dist` and served by Cloudflare Pages.

- `site/src` is the landing page from the "Alden Site v2" Claude Design project: static HTML, CSS and a small script for
  its animations (still under reduced motion). Fonts are the same bundled Geist files as the app.
- The docs are the repo's own `docs/*.md`, rendered by `site/build.ts` in the order `docs/README.md` lists them.
- `site/src/assets/screens` are real screenshots of `alden ui` over the demo data (checks only, no model):
  `pnpm screenshots` retakes them; `site/src/assets/og.png` is the social card made from one.

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

`_headers` sets a strict Content-Security-Policy: everything is served from the site itself.

The "Join the beta" links mail `beta@getalden.dev`; set that address up before the site goes live.
