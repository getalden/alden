import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSymbols, goPackageNameFromPath } from "./extract.js";
import { languageOf } from "./parser.js";

const names = (defs: { name: string; kind: string; exported: boolean; container?: string }[]) =>
  defs.map((d) => `${d.exported ? "+" : "-"}${d.container ? `${d.container}.` : ""}${d.name}:${d.kind}`);

describe("languageOf", () => {
  it("covers TS, JS (via the TSX grammar), Python, Go and PHP, and skips everything else", () => {
    expect(
      [
        "a.ts",
        "a.mts",
        "a.tsx",
        "a.js",
        "a.jsx",
        "a.cjs",
        "a.py",
        "a.d.ts",
        "a.go",
        "a.php",
        "a.blade.php",
        "a.rb",
      ].map(languageOf),
    ).toEqual([
      "typescript",
      "typescript",
      "tsx",
      "tsx",
      "tsx",
      "tsx",
      "python",
      undefined,
      "go",
      "php",
      undefined,
      undefined,
    ]);
  });
});

describe("TypeScript", () => {
  const source = `import { rank as rankOne, config } from "./rank";
import Anthropic from "@anthropic-ai/sdk";
import * as fs from "node:fs";
export { helper } from "./helpers";
export * from "./types";

export function rankQueue(queue: Queue): Ranked {
  return queue.items.map((item) => rankOne(item, config));
}

export const formatAge = (hours: number) => {
  return fs.existsSync("x") ? String(hours) : "";
};

export const DEFAULT_LIMIT = 100;
const internal = () => new Anthropic();

export class Ranker extends Base {
  rank(pr: Pr) {
    return this.#score(pr);
  }
  private cache() {}
  #score(pr: Pr) {}
}

class Hidden {
  run() {}
}

interface Options { limit: number }
export type Lane = "a" | "b";
export { Hidden };
export default function main() {}
`;

  it("finds definitions, with line ranges and what's exported", async () => {
    const symbols = await extractSymbols("src/queue.ts", source);
    expect(names(symbols?.definitions ?? [])).toEqual([
      "+rankQueue:function",
      "+formatAge:function",
      "+DEFAULT_LIMIT:variable",
      "-internal:function",
      "+Ranker:class",
      "+Ranker.rank:method",
      "-Ranker.cache:method",
      "-Ranker.#score:method",
      "+Hidden:class",
      "+Hidden.run:method",
      "-Options:interface",
      "+Lane:type",
      "+main:function",
    ]);
    const rankQueue = symbols?.definitions.find((d) => d.name === "rankQueue");
    expect([rankQueue?.startLine, rankQueue?.endLine]).toEqual([7, 9]);
  });

  it("reads imports, including aliases, defaults, namespaces and re-exports", async () => {
    const symbols = await extractSymbols("src/queue.ts", source);
    expect(
      symbols?.imports.map((i) => `${i.local}<-${i.imported}@${i.from}${i.reexport ? " (re-export)" : ""}`),
    ).toEqual([
      "rankOne<-rank@./rank",
      "config<-config@./rank",
      "Anthropic<-default@@anthropic-ai/sdk",
      "fs<-*@node:fs",
      "helper<-helper@./helpers (re-export)",
      "*<-*@./types (re-export)",
    ]);
  });

  it("finds calls, method calls, constructors and base classes", async () => {
    const symbols = await extractSymbols("src/queue.ts", source);
    const refs = symbols?.references.map((r) => `${r.object ? `${r.object}.` : ""}${r.name}@${r.line}`) ?? [];
    expect(refs).toEqual(
      expect.arrayContaining(["rankOne@8", "fs.existsSync@12", "Anthropic@16", "Base@18", "this.#score@20"]),
    );
  });

  it("finds JSX components used in TSX", async () => {
    const symbols = await extractSymbols(
      "src/App.tsx",
      "export function App() {\n  return <Layout><QueueTable rows={rows} /></Layout>;\n}\n",
    );
    expect(symbols?.references.map((r) => r.name)).toEqual(expect.arrayContaining(["Layout", "QueueTable"]));
  });

  it("reads a real Alden source file", async () => {
    const path = join(import.meta.dirname, "../queue/rank.ts");
    const symbols = await extractSymbols(path, readFileSync(path, "utf8"));
    const exported = symbols?.definitions.filter((d) => d.exported).map((d) => d.name);
    expect(exported).toEqual(expect.arrayContaining(["formatAge", "reviewableSize", "rankPullRequest", "rankQueue"]));
    expect(symbols?.imports.map((i) => i.from)).toEqual(expect.arrayContaining(["./files.js", "@alden/schema"]));
  });
});

describe("Python", () => {
  const source = `import os
import app.models as models
from django.db import models as dj_models, transaction
from .utils import slugify
from ..core import *

class Invoice(dj_models.Model):
    def __init__(self, amount):
        self.amount = amount

    @property
    def total(self):
        return round(self.amount)

    def _audit(self):
        pass

class _Internal:
    def run(self):
        pass

@transaction.atomic
def charge(invoice, card):
    token = os.getenv("KEY")
    return models.Payment.create(invoice=invoice, slug=slugify(card))

def _helper():
    pass
`;

  it("finds classes, methods and functions; underscores are private", async () => {
    const symbols = await extractSymbols("billing/charge.py", source);
    expect(names(symbols?.definitions ?? [])).toEqual([
      "+Invoice:class",
      "+Invoice.__init__:method",
      "+Invoice.total:method",
      "-Invoice._audit:method",
      "-_Internal:class",
      "-_Internal.run:method",
      "+charge:function",
      "-_helper:function",
    ]);
    // A decorated function's range starts at its decorator.
    const charge = symbols?.definitions.find((d) => d.name === "charge");
    expect([charge?.startLine, charge?.endLine]).toEqual([22, 25]);
  });

  it("reads import and from-import forms, including relative and wildcard", async () => {
    const symbols = await extractSymbols("billing/charge.py", source);
    expect(symbols?.imports.map((i) => `${i.local}<-${i.imported}@${i.from}`)).toEqual([
      "os<-*@os",
      "models<-*@app.models",
      "dj_models<-models@django.db",
      "transaction<-transaction@django.db",
      "slugify<-slugify@.utils",
      "*<-*@..core",
    ]);
  });

  it("finds calls, method calls and base classes", async () => {
    const symbols = await extractSymbols("billing/charge.py", source);
    const refs = symbols?.references.map((r) => `${r.object ? `${r.object}.` : ""}${r.name}@${r.line}`) ?? [];
    expect(refs).toEqual(
      expect.arrayContaining(["Model@7", "round@13", "os.getenv@24", "models.Payment.create@25", "slugify@25"]),
    );
  });
});

describe("Go", () => {
  const source = `package server

import (
	"fmt"
	cfg "github.com/acme/app/internal/config"
	"gopkg.in/yaml.v3"
	_ "embed"
	. "github.com/acme/app/testutil"
)

const (
	MaxConns = 10
	retries  = 3
)

var ErrClosed = fmt.Errorf("closed")

type (
	Server struct{ Config cfg.Config }
	Handler interface{ Serve() error }
)

type ID string
type Box[T any] struct{ v T }

func New(c cfg.Config) *Server {
	return &Server{Config: c}
}

func (s *Server) Handle(h Handler) error {
	s.log()
	return helper(h, cfg.Load)
}

func (s *Server) log() {}

func (b Box[T]) Get() T { return b.v }

func run() {
	x := cfg.Config{Port: 1}
	New(x).Handle(nil)
	yaml.Unmarshal(nil, nil)
	cfg.Parse[int](nil)
}
`;

  it("finds functions, methods by receiver type, types and exported values; capitalised means exported", async () => {
    const symbols = await extractSymbols("internal/server/server.go", source);
    expect(symbols?.goPackage).toBe("server");
    expect(names(symbols?.definitions ?? [])).toEqual([
      "+MaxConns:variable",
      "+ErrClosed:variable",
      "+Server:class",
      "+Handler:interface",
      "+ID:type",
      "+Box:class",
      "+New:function",
      "+Server.Handle:method",
      "-Server.log:method",
      "+Box.Get:method",
      "-run:function",
    ]);
    const handle = symbols?.definitions.find((d) => d.name === "Handle");
    expect([handle?.startLine, handle?.endLine, handle?.receiver]).toEqual([30, 33, "s"]);
    // Each spec in a grouped declaration has its own lines.
    expect(symbols?.definitions.find((d) => d.name === "Handler")?.startLine).toBe(20);
  });

  it("names imports by alias or by their path, and skips blank and dot imports", async () => {
    const symbols = await extractSymbols("internal/server/server.go", source);
    expect(symbols?.imports.map((i) => `${i.local}${i.implicitName ? "?" : ""}<-${i.from}`)).toEqual([
      "fmt?<-fmt",
      "cfg<-github.com/acme/app/internal/config",
      "yaml?<-gopkg.in/yaml.v3",
    ]);
  });

  it("finds calls, method calls, struct literals, generic calls and functions passed as arguments", async () => {
    const symbols = await extractSymbols("internal/server/server.go", source);
    const refs = symbols?.references.map((r) => `${r.object ? `${r.object}.` : ""}${r.name}@${r.line}`) ?? [];
    expect(refs).toEqual(
      expect.arrayContaining([
        "fmt.Errorf@16",
        "Server@27",
        "s.log@31",
        "helper@32",
        "cfg.Load@32",
        "cfg.Config@40",
        "New@41",
        "New(x).Handle@41",
        "yaml.Unmarshal@42",
        "cfg.Parse@43",
      ]),
    );
  });
});

describe("Go types, values and function variables", () => {
  const source = `package shared

type GitConfigClient interface {
	io.Closer
	PushDefault() (string, error)
}

type Number interface{ ~int | ~float64 }

type Server struct {
	*store.Base
	Mirror[int]
	name  string
	inner struct{ Hidden }
}

var now = func() int64 { return 0 }

var defaultTimeout, retries = 10, 3

func NewCmd(p *Prompter) *Options {
	opts := &Options{Fetch: FetchOptions, Survey: p.Survey}
	opts.Run = runEdit
	handler := p.Handle
	_ = []Option{WithRetry, cfg.WithTimeout}
	if err != nil {
		return nil, err
	}
	return opts, ok
}
`;

  it("records what structs and interfaces embed, interfaces' own methods, and function variables", async () => {
    const symbols = await extractSymbols("shared/shared.go", source);
    const defs = symbols?.definitions ?? [];
    expect(defs.find((d) => d.name === "GitConfigClient")).toMatchObject({
      bases: ["io.Closer"],
      methods: ["PushDefault"],
    });
    // A constraint isn't an embedding, and an anonymous struct's fields aren't the outer struct's.
    expect(defs.find((d) => d.name === "Number")?.bases).toBeUndefined();
    expect(defs.find((d) => d.name === "Server")?.bases).toEqual(["store.Base", "Mirror"]);
    // `now` is called like a function; plain unexported values still aren't definitions.
    expect(names(defs)).toEqual([
      "+GitConfigClient:interface",
      "+Number:interface",
      "+Server:class",
      "-now:variable",
      "+NewCmd:function",
    ]);
  });

  it("records functions and methods named without a call as values, skipping locals like err and ok", async () => {
    const symbols = await extractSymbols("shared/shared.go", source);
    const values = (symbols?.references ?? [])
      .filter((r) => r.kind === "value")
      .map((r) => `${r.object ? `${r.object}.` : ""}${r.name}@${r.line}`);
    expect(values).toEqual([
      "FetchOptions@22",
      "p.Survey@22",
      "runEdit@23",
      "p.Handle@24",
      "WithRetry@25",
      "cfg.WithTimeout@25",
      "opts@29",
    ]);
  });
});

describe("goPackageNameFromPath", () => {
  it.each([
    ["fmt", "fmt"],
    ["net/http", "http"],
    ["github.com/acme/app/internal/config", "config"],
    ["gopkg.in/yaml.v3", "yaml"],
    ["github.com/jackc/pgx/v5", "pgx"],
    ["github.com/mattn/go-sqlite3", "sqlite3"],
  ])("%s → %s", (path, name) => {
    expect(goPackageNameFromPath(path)).toBe(name);
  });
});

describe("PHP", () => {
  const source = `<?php

namespace App\\Services;

use App\\Models\\{User, Post as Article};
use App\\Contracts\\PaymentGateway;
use function App\\Support\\helper;
use Illuminate\\Support\\Facades\\Cache;

function top(int $x): int { return $x; }

final class Billing extends Base implements PaymentGateway, \\Countable
{
    public function __construct(private PaymentGateway $gateway) {}

    public function charge(
        User $user,
        int $cents,
    ): Receipt {
        $this->gateway->charge($cents);
        $user?->notify();
        $r = new Receipt($cents);
        User::where('a', 1)->first();
        \\App\\Support\\Log::info('x');
        helper(User::class);
        new \\App\\Mail\\Invoice();
        return self::make(static::class, parent::boot());
    }

    protected function audit() {}
    private static function make() {}
    function implicitPublic() {}
}

interface Chargeable { public function charge(int $c): void; }
trait HasBilling { public function bill() {} }
enum Status: string { case Active = 'a'; public function label(): string { return 'x'; } }
`;

  it("finds classes, interfaces, traits, enums, functions and methods; no modifier means public", async () => {
    const symbols = await extractSymbols("app/Services/Billing.php", source);
    expect(symbols?.phpNamespace).toBe("App\\Services");
    expect(names(symbols?.definitions ?? [])).toEqual([
      "+top:function",
      "+Billing:class",
      "+Billing.__construct:method",
      "+Billing.charge:method",
      "-Billing.audit:method",
      "-Billing.make:method",
      "+Billing.implicitPublic:method",
      "+Chargeable:interface",
      "+Chargeable.charge:method",
      "+HasBilling:class",
      "+HasBilling.bill:method",
      "+Status:class",
      "+Status.label:method",
    ]);
    const billing = symbols?.definitions.find((d) => d.name === "Billing");
    expect(billing?.bases).toEqual(["Base", "PaymentGateway", "\\Countable"]);
    const charge = symbols?.definitions.find((d) => d.name === "charge" && d.container === "Billing");
    expect(charge?.signature).toBe("public function charge(User $user, int $cents): Receipt");
    expect(symbols?.definitions.find((d) => d.container === "Chargeable")?.signature).toBe(
      "public function charge(int $c): void",
    );
  });

  it("reads plain, aliased and grouped use imports, skips use function, and imports fully qualified names", async () => {
    const symbols = await extractSymbols("app/Services/Billing.php", source);
    expect(symbols?.imports.map((i) => `${i.local}<-${i.imported}@${i.from}`)).toEqual(
      expect.arrayContaining([
        "User<-User@App\\Models\\User",
        "Article<-Post@App\\Models\\Post",
        "PaymentGateway<-PaymentGateway@App\\Contracts\\PaymentGateway",
        "Cache<-Cache@Illuminate\\Support\\Facades\\Cache",
        "Log<-Log@App\\Support\\Log",
        "Invoice<-Invoice@App\\Mail\\Invoice",
        "Countable<-Countable@Countable",
      ]),
    );
    expect(symbols?.imports.some((i) => i.imported === "helper")).toBe(false);
  });

  it("finds calls, static calls, new, ::class and base classes", async () => {
    const symbols = await extractSymbols("app/Services/Billing.php", source);
    const refs = symbols?.references.map((r) => `${r.object ? `${r.object}::` : ""}${r.name}@${r.line}`) ?? [];
    expect(refs).toEqual(
      expect.arrayContaining([
        "Base@12",
        "PaymentGateway@12",
        "Countable@12",
        "$this->gateway::charge@20",
        "$user::notify@21",
        "Receipt@22",
        "User::where@23",
        "Log::info@24",
        "helper@25",
        "User::class@25",
        "Invoice@26",
        "self::make@27",
        "parent::boot@27",
        // Type hints: injected and returned classes.
        "PaymentGateway@14",
        "User@17",
        "Receipt@19",
      ]),
    );
  });
});

it("skips languages the graph doesn't cover", async () => {
  expect(await extractSymbols("app.rb", "puts 1")).toBeUndefined();
});
