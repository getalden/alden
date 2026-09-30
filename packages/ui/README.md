# @alden/ui

The local web UI that `alden ui` serves. It renders the same formats as the CLI (`@alden/schema`) and talks only to
the local API in `packages/cli/src/ui`, so the desktop app can wrap it unchanged.

```sh
alden ui --no-open --port 4318      # in the repo you want to review from; note the #t=… in the link
pnpm --filter @alden/ui dev         # then open http://localhost:5173/#t=…
```

`pnpm build` builds it into `dist/`, and the CLI's build copies that into `packages/cli/dist/ui`.
