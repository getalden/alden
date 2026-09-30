import { describe, expect, it } from "vitest";
import { extractSymbols, type FileSymbols } from "./extract.js";
import { CodeGraph } from "./query.js";
import { createResolver } from "./resolve.js";

/** A small repo parsed for real, with a resolver over its paths. */
async function repo(files: Record<string, string>, config: Partial<Parameters<typeof createResolver>[1]> = {}) {
  const index = new Map<string, FileSymbols>();
  for (const [path, source] of Object.entries(files)) {
    const symbols = await extractSymbols(path, source);
    if (symbols) index.set(path, symbols);
  }
  const resolver = createResolver(Object.keys(files), {
    aliases: [],
    packages: new Map(),
    pythonRoots: [""],
    ...config,
  });
  return new CodeGraph(index, resolver);
}

const sites = (list: { path: string; line: number; confidence: string }[]) =>
  list.map((s) => `${s.path}:${s.line}${s.confidence === "name" ? "?" : ""}`);

describe("Go callers", () => {
  const goModules = [{ path: "github.com/acme/app", dir: "" }];

  it("follows package imports by alias, path name or declared name, and sees the whole package without imports", async () => {
    const graph = await repo(
      {
        "internal/config/load.go": "package config\n\nfunc Load() Config { return defaults() }\n",
        "internal/config/types.go":
          "package config\n\ntype Config struct{}\n\nfunc defaults() Config { return Config{} }\n",
        "internal/config/load_test.go": "package config\n\nfunc TestLoad() { Load() }\n",
        "internal/config/ext_test.go":
          'package config_test\n\nimport "github.com/acme/app/internal/config"\n\nfunc TestX() { config.Load() }\n',
        "cmd/serve.go":
          'package main\n\nimport cfg "github.com/acme/app/internal/config"\n\nfunc main() {\n\tc := cfg.Load()\n\t_ = cfg.Config{}\n\t_ = c\n}\n',
        // The directory is "httpx", but the package declares itself "web": importers call web.X.
        "internal/httpx/server.go": "package web\n\nfunc Serve() {}\n",
        "cmd/web.go":
          'package main\n\nimport (\n\t"github.com/acme/app/internal/config"\n\t"github.com/acme/app/internal/httpx"\n)\n\nfunc run() {\n\tconfig.Load()\n\tweb.Serve()\n}\n',
        // Same name, other package, no import: never a caller.
        "other/load.go": "package other\n\nfunc Load() {}\n\nfunc x() { Load() }\n",
      },
      { goModules },
    );
    expect(sites(graph.callersOf({ path: "internal/config/load.go", name: "Load" }))).toEqual([
      "cmd/serve.go:6",
      "cmd/web.go:9",
      "internal/config/ext_test.go:5",
      "internal/config/load_test.go:3",
    ]);
    expect(sites(graph.callersOf({ path: "internal/config/types.go", name: "Config" }))).toEqual([
      "cmd/serve.go:7",
      "internal/config/types.go:5",
    ]);
    expect(sites(graph.callersOf({ path: "internal/httpx/server.go", name: "Serve" }))).toEqual(["cmd/web.go:10"]);
  });

  it("finds method calls in files that use the package, with common names only on the receiver", async () => {
    const graph = await repo(
      {
        "server/server.go": `package server

type Server struct{ name string }

func (s *Server) Handle() error { return nil }
func (s *Server) Close() error { return nil }
func (s *Server) String() string { return s.name }

func (s *Server) Shutdown() {
\ts.Close()
\ts.Handle()
\t_ = s.String()
}
`,
        "server/pool.go":
          "package server\n\nfunc drain(conn io.Closer, srv *Server) {\n\tconn.Close()\n\tsrv.Handle()\n}\n",
        "cmd/main.go": `package main

import "github.com/acme/app/server"

func main() {
\tsrv := &server.Server{}
\tsrv.Handle()
\tdefer srv.Close()
\tfmt.Println(srv.String())
}
`,
        // Doesn't import the server package: its Handle is some other type's.
        "other/other.go": "package other\n\nfunc x(h Handler) { h.Handle() }\n",
      },
      { goModules },
    );
    expect(sites(graph.callersOf({ path: "server/server.go", name: "Handle", container: "Server" }))).toEqual([
      "cmd/main.go:7",
      "server/pool.go:5",
      "server/server.go:11",
    ]);
    // Close is too common to trust on any receiver: only s.Close() inside Server's own methods counts.
    expect(sites(graph.callersOf({ path: "server/server.go", name: "Close", container: "Server" }))).toEqual([
      "server/server.go:10",
    ]);
    expect(sites(graph.callersOf({ path: "server/server.go", name: "String", container: "Server" }))).toEqual([
      "server/server.go:12",
    ]);
  });
});

describe("PHP callers", () => {
  const psr4 = [{ prefix: "App\\", dirs: ["app"] }];

  it("follows use imports, aliases, the file's own namespace and fully qualified names", async () => {
    const graph = await repo(
      {
        "app/Services/Billing.php": `<?php
namespace App\\Services;

class Billing
{
    public function charge(int $cents): void {}
    public static function make(): self { return new self(); }
}
`,
        "app/Http/Controllers/PayController.php": `<?php
namespace App\\Http\\Controllers;

use App\\Services\\Billing;

class PayController
{
    public function store(Billing $billing)
    {
        $billing->charge(100);
        Billing::make();
        return app(Billing::class);
    }
}
`,
        "app/Jobs/Charge.php": `<?php
namespace App\\Jobs;

use App\\Services\\Billing as Payments;

class Charge
{
    public function handle() { (new Payments())->charge(5); }
}
`,
        "app/Services/Refunds.php": `<?php
namespace App\\Services;

class Refunds
{
    public function run() { $b = new Billing(); $b->charge(-5); }
}
`,
        "app/Console/Kernel.php": `<?php
namespace App\\Console;

class Kernel
{
    public function run() { \\App\\Services\\Billing::make(); }
}
`,
        // Same class name, other namespace, not imported: a different Billing.
        "app/Legacy/Billing.php": `<?php
namespace App\\Legacy;

class Billing { public function charge() {} }
class Old { public function x() { (new Billing())->charge(); } }
`,
      },
      { psr4 },
    );
    expect(sites(graph.callersOf({ path: "app/Services/Billing.php", name: "charge", container: "Billing" }))).toEqual([
      "app/Http/Controllers/PayController.php:10",
      "app/Jobs/Charge.php:8",
      "app/Services/Refunds.php:6",
    ]);
    expect(sites(graph.callersOf({ path: "app/Services/Billing.php", name: "Billing" }))).toEqual([
      "app/Console/Kernel.php:6",
      "app/Http/Controllers/PayController.php:8",
      "app/Http/Controllers/PayController.php:11",
      "app/Http/Controllers/PayController.php:12",
      "app/Jobs/Charge.php:8",
      "app/Services/Refunds.php:6",
    ]);
  });
});

describe("TypeScript callers", () => {
  it("follows named, aliased and namespace imports, ESM .js specifiers, and same-file calls", async () => {
    const graph = await repo({
      "src/rank.ts": "export function rankQueue() {}\nexport function again() { return rankQueue(); }\n",
      "src/cli.ts": 'import { rankQueue } from "./rank.js";\nrankQueue();\n',
      "src/alias.ts": 'import { rankQueue as rq } from "./rank";\nrq();\n',
      "src/ns.ts": 'import * as ranking from "./rank";\nranking.rankQueue();\nranking.other();\n',
      "src/unrelated.ts": 'import { other } from "./rank";\nother();\n',
    });
    expect(sites(graph.callersOf({ path: "src/rank.ts", name: "rankQueue" }))).toEqual([
      "src/alias.ts:2",
      "src/cli.ts:2",
      "src/ns.ts:2",
      "src/rank.ts:2",
    ]);
  });

  it("follows re-exports through barrel files, including export *", async () => {
    const graph = await repo({
      "src/queue/rank.ts": "export function rankQueue() {}\n",
      "src/queue/index.ts": 'export { rankQueue as rank } from "./rank";\n',
      "src/index.ts": 'export * from "./queue/index";\n',
      "src/app.ts": 'import { rank } from "./index";\nrank();\n',
      "src/direct.ts": 'import { rank } from "./queue";\nrank();\n',
    });
    expect(sites(graph.callersOf({ path: "src/queue/rank.ts", name: "rankQueue" }))).toEqual([
      "src/app.ts:2",
      "src/direct.ts:2",
    ]);
  });

  it("resolves tsconfig path aliases and workspace packages", async () => {
    const graph = await repo(
      {
        "packages/core/src/index.ts": "export function loadConfig() {}\n",
        "packages/cli/src/a.ts": 'import { loadConfig } from "@alden/core";\nloadConfig();\n',
        "web/src/lib/api.ts": "export function fetchQueue() {}\n",
        "web/src/pages/home.tsx": 'import { fetchQueue } from "@/lib/api";\nfetchQueue();\n',
      },
      {
        aliases: [{ prefix: "@/", suffix: "", targets: ["web/src/*"] }],
        packages: new Map([["@alden/core", "packages/core"]]),
      },
    );
    expect(sites(graph.callersOf({ path: "packages/core/src/index.ts", name: "loadConfig" }))).toEqual([
      "packages/cli/src/a.ts:2",
    ]);
    expect(sites(graph.callersOf({ path: "web/src/lib/api.ts", name: "fetchQueue" }))).toEqual([
      "web/src/pages/home.tsx:2",
    ]);
  });

  it("finds JSX usage and constructor calls of classes", async () => {
    const graph = await repo({
      "src/Table.tsx": "export function QueueTable() { return null; }\nexport class Ranker {}\n",
      "src/App.tsx":
        'import { QueueTable, Ranker } from "./Table";\nexport const App = () => <QueueTable />;\nnew Ranker();\n',
    });
    expect(sites(graph.callersOf({ path: "src/Table.tsx", name: "QueueTable" }))).toEqual(["src/App.tsx:2"]);
    expect(sites(graph.callersOf({ path: "src/Table.tsx", name: "Ranker" }))).toEqual(["src/App.tsx:3"]);
  });

  it("counts the symbol used as the object of a call, or passed as an argument", async () => {
    const graph = await repo({
      "src/schema.ts":
        "export const ConfigSchema = z.object({});\nexport class Store {}\nexport function onRank() {}\n",
      "src/load.ts":
        'import { ConfigSchema, Store, onRank } from "./schema";\nConfigSchema.parse({});\nStore.create();\nqueue.on("rank", onRank);\n',
    });
    expect(sites(graph.callersOf({ path: "src/schema.ts", name: "ConfigSchema" }))).toEqual(["src/load.ts:2"]);
    expect(sites(graph.callersOf({ path: "src/schema.ts", name: "Store" }))).toEqual(["src/load.ts:3"]);
    expect(sites(graph.callersOf({ path: "src/schema.ts", name: "onRank" }))).toEqual(["src/load.ts:4"]);
  });

  it("doesn't mistake other objects' common methods for the class's", async () => {
    const graph = await repo({
      "src/views.ts":
        "export class VoicesView {\n  get() { return this.data.get(1); }\n  post() { return this.get(); }\n}\n",
      "src/use.ts": 'import { VoicesView } from "./views";\nconst m = new Map();\nm.get(1);\nVoicesView.get();\n',
    });
    expect(sites(graph.callersOf({ path: "src/views.ts", name: "get", container: "VoicesView" }))).toEqual([
      "src/use.ts:4",
      "src/views.ts:3",
    ]);
  });

  it("finds method calls in files that import the class, and in its own file", async () => {
    const graph = await repo({
      "src/ranker.ts": "export class Ranker {\n  rank() {}\n  both() { return this.rank(); }\n}\n",
      "src/use.ts": 'import { Ranker } from "./ranker";\nconst r = new Ranker();\nr.rank();\n',
      "src/other.ts": "export function f(x) { return x.rank(); }\n",
    });
    expect(sites(graph.callersOf({ path: "src/ranker.ts", name: "rank", container: "Ranker" }))).toEqual([
      "src/ranker.ts:3",
      "src/use.ts:3",
    ]);
  });

  it("skips call sites the diff itself changed", async () => {
    const graph = await repo({
      "src/rank.ts": "export function rankQueue() {}\n",
      "src/a.ts": 'import { rankQueue } from "./rank";\nrankQueue();\nrankQueue();\n',
    });
    const callers = graph.callersOf({ path: "src/rank.ts", name: "rankQueue" }, new Map([["src/a.ts", new Set([2])]]));
    expect(sites(callers)).toEqual(["src/a.ts:3"]);
  });

  it("marks bare same-name calls without a resolvable import as uncertain, but not external imports", async () => {
    const graph = await repo({
      "src/util.ts": "export function debounce() {}\n",
      "src/dynamic.js": "debounce();\n",
      "src/lodash-user.ts": 'import { debounce } from "lodash";\ndebounce();\n',
      "src/own.ts": "function debounce() {}\ndebounce();\n",
    });
    expect(sites(graph.callersOf({ path: "src/util.ts", name: "debounce" }))).toEqual(["src/dynamic.js:1?"]);
  });
});

describe("Python callers", () => {
  it("follows from-imports, module imports, aliases, relative imports and packages", async () => {
    const graph = await repo({
      "billing/charge.py": "def charge(invoice):\n    pass\n",
      "billing/__init__.py": "from .charge import charge\n",
      "api/views.py": "from billing.charge import charge\n\ncharge(1)\n",
      "api/tasks.py": "import billing.charge\n\nbilling.charge.charge(1)\n",
      "api/alias.py": "import billing.charge as bc\n\nbc.charge(1)\n",
      "billing/retry.py": "from .charge import charge as do\n\ndo(1)\n",
      "api/pkg.py": "from billing import charge\n\ncharge(2)\n",
    });
    expect(sites(graph.callersOf({ path: "billing/charge.py", name: "charge" }))).toEqual([
      "api/alias.py:3",
      "api/pkg.py:3",
      "api/tasks.py:3",
      "api/views.py:3",
      "billing/retry.py:3",
    ]);
  });

  it("reads imports inside functions, and views passed to Django's path()", async () => {
    const graph = await repo({
      "media/voices.py": "def chosen_voice_key(user):\n    pass\n",
      "media/views.py":
        "def get(request):\n    from media.voices import chosen_voice_key\n    return chosen_voice_key(request.user)\n",
      "billing/webhooks.py": "def apple_webhook(request):\n    pass\n",
      "billing/urls.py":
        'from billing import webhooks\nfrom billing.webhooks import apple_webhook\n\nurlpatterns = [path("a", webhooks.apple_webhook), path("b", apple_webhook)]\n',
    });
    expect(sites(graph.callersOf({ path: "media/voices.py", name: "chosen_voice_key" }))).toEqual(["media/views.py:3"]);
    expect(sites(graph.callersOf({ path: "billing/webhooks.py", name: "apple_webhook" }))).toEqual([
      "billing/urls.py:4",
    ]);
  });

  it("finds method calls, including self calls in the class's module", async () => {
    const graph = await repo({
      "billing/models.py":
        "class Invoice:\n    def total(self):\n        pass\n    def pay(self):\n        return self.total()\n",
      "api/views.py": "from billing.models import Invoice\n\ninv = Invoice()\ninv.total()\n",
    });
    expect(sites(graph.callersOf({ path: "billing/models.py", name: "total", container: "Invoice" }))).toEqual([
      "api/views.py:4",
      "billing/models.py:5",
    ]);
  });
});
