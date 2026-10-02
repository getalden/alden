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

## First deploy

1. `pnpm dlx wrangler login`, with the Cloudflare account that will host it.
2. `pnpm dlx wrangler pages project create getalden --production-branch main` (once).
3. `pnpm site:deploy`.
4. In the Pages project: Custom domains → add `getalden.dev` (and `www.getalden.dev`, redirected). If the domain's DNS
   is on Cloudflare this is one click; otherwise point it at the `*.pages.dev` name it gives you.

`_headers` sets a strict Content-Security-Policy: everything is served from the site itself.

The "Join the beta" links mail `beta@getalden.dev`; set that address up before the site goes live.
