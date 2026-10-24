import { describe, expect, it } from "vitest";
import { extractSymbols, type FileSymbols } from "./extract.js";
import { CodeGraph } from "./query.js";
import { createResolver } from "./resolve.js";

async function repo(files: Record<string, string>) {
  const index = new Map<string, FileSymbols>();
  for (const [path, source] of Object.entries(files)) {
    const symbols = await extractSymbols(path, source);
    if (symbols) index.set(path, symbols);
  }
  return new CodeGraph(
    index,
    createResolver(Object.keys(files), { aliases: [], packages: new Map(), pythonRoots: [""] }),
  );
}

const sites = (list: { path: string; line: number; confidence: string }[]) =>
  list.map((s) => `${s.path}:${s.line}${s.confidence === "name" ? "?" : ""}`);

describe("Ruby", () => {
  it("reads classes, modules, visibility, scopes and signatures", async () => {
    const symbols = await extractSymbols(
      "app/models/rule.rb",
      `class Rule::Runner < ApplicationRecord
  include Transferable
  scope :active, -> { where(active: true) }

  def initialize(family, rules:, ignore: false)
  end

  def self.kind_for(account, from_account: nil)
  end

  private

  def helper = 1

  public def shown; end
end
`,
    );
    const defs = symbols?.definitions.map((d) => `${d.container ?? ""}.${d.name}:${d.exported ? "pub" : "priv"}`);
    expect(defs).toEqual([
      ".Runner:pub",
      "Runner.active:pub",
      "Runner.initialize:pub",
      "Runner.kind_for:pub",
      "Runner.helper:priv",
      "Runner.shown:pub",
    ]);
    const runner = symbols?.definitions.find((d) => d.name === "Runner");
    expect(runner?.bases).toEqual(["ApplicationRecord", "Transferable"]);
    expect(symbols?.definitions.find((d) => d.name === "kind_for")?.signature).toBe(
      "def self.kind_for(account, from_account: nil)",
    );
  });

  it("finds callers of a method across the app: on the class, like-named receivers, self, jobs, callbacks and send", async () => {
    const graph = await repo({
      "app/models/rule.rb": `class Rule < ApplicationRecord
  before_save :normalize

  def apply(scope: matching_scope)
    matching_scope
  end

  def matching_scope(only_id: nil)
  end

  private

  def normalize
    send(:matching_scope)
  end
end
`,
      "app/jobs/apply_rules_job.rb": `class ApplyRulesJob < ApplicationJob
  def perform(rule)
    rule.apply
    @rule.apply
    Rule.find(1).matching_scope
    something.matching_scope
  end
end
`,
      "app/controllers/rules_controller.rb": `class RulesController < ApplicationController
  def update
    ApplyRulesJob.perform_later(@rule)
    @rule.save
    matching_scope
  end
end
`,
    });
    expect(sites(graph.callersOf({ path: "app/models/rule.rb", name: "matching_scope", container: "Rule" }))).toEqual([
      "app/jobs/apply_rules_job.rb:5",
      "app/jobs/apply_rules_job.rb:6?",
      "app/models/rule.rb:4",
      "app/models/rule.rb:5",
      "app/models/rule.rb:14",
    ]);
    expect(sites(graph.callersOf({ path: "app/models/rule.rb", name: "apply", container: "Rule" }))).toEqual([
      "app/jobs/apply_rules_job.rb:3",
      "app/jobs/apply_rules_job.rb:4",
    ]);
    expect(sites(graph.callersOf({ path: "app/models/rule.rb", name: "normalize", container: "Rule" }))).toEqual([
      "app/models/rule.rb:2",
    ]);
    expect(
      sites(graph.callersOf({ path: "app/jobs/apply_rules_job.rb", name: "perform", container: "ApplyRulesJob" })),
    ).toEqual(["app/controllers/rules_controller.rb:3"]);
  });

  it("reaches a concern's methods through the models that include it, and constructors through .new", async () => {
    const graph = await repo({
      "app/models/concerns/transferable.rb": `module Transferable
  extend ActiveSupport::Concern

  def transfer_kind
  end
end
`,
      "app/models/transaction.rb": `class Transaction < ApplicationRecord
  include Transferable

  def label
    transfer_kind
  end
end
`,
      "app/models/transfer/creator.rb": `class Transfer::Creator
  def initialize(source, destination:)
  end
end
`,
      "app/services/sync.rb": `class Sync
  def run(transaction)
    transaction.transfer_kind
    Transfer::Creator.new(a, destination: b)
  end
end
`,
    });
    expect(
      sites(
        graph.callersOf({
          path: "app/models/concerns/transferable.rb",
          name: "transfer_kind",
          container: "Transferable",
        }),
      ),
    ).toEqual(["app/models/transaction.rb:5", "app/services/sync.rb:3"]);
    expect(
      sites(graph.callersOf({ path: "app/models/transfer/creator.rb", name: "initialize", container: "Creator" })),
    ).toEqual(["app/services/sync.rb:4"]);
    expect(sites(graph.callersOf({ path: "app/models/transfer/creator.rb", name: "Creator" }))).toEqual([
      "app/services/sync.rb:4",
    ]);
  });
});

describe("Swift", () => {
  it("finds methods across the module: own type and extensions, like-named receivers, initializers", async () => {
    const graph = await repo({
      "Sources/App/Store.swift": `final class Store {
  init(cache: [Int: String]) {}
  public func fetch(id: Int) -> String { return "" }
  private func helper() { fetch(id: 1) }
}
`,
      "Sources/App/Store+Extra.swift": `extension Store {
  func extra() { self.fetch(id: 2) }
}
`,
      "Sources/App/Feature.swift": `struct Feature {
  let store = Store(cache: [:])
  func load() {
    store.fetch(id: 3)
    other.fetch(id: 4)
  }
}
`,
    });
    expect(sites(graph.callersOf({ path: "Sources/App/Store.swift", name: "fetch", container: "Store" }))).toEqual([
      "Sources/App/Feature.swift:4",
      "Sources/App/Feature.swift:5?",
      "Sources/App/Store.swift:4",
      "Sources/App/Store+Extra.swift:2",
    ]);
    expect(sites(graph.callersOf({ path: "Sources/App/Store.swift", name: "init", container: "Store" }))).toEqual([
      "Sources/App/Feature.swift:2",
    ]);
    const symbols = await extractSymbols(
      "a.swift",
      'public func go(_ x: Int, y: String = "") async throws -> Bool { true }\n',
    );
    expect(symbols?.definitions[0]?.signature).toBe('public func go(_ x: Int, y: String = "") async throws -> Bool');
  });
});

describe("Java and Kotlin", () => {
  const files = {
    "src/main/java/com/acme/core/Transfer.java": `package com.acme.core;

public class Transfer {
  public Transfer(String kind) {}
  public static String kindFor(Account a) { return ""; }
  public void settle() {}
  private void audit() { settle(); }
}
`,
    "src/main/java/com/acme/billing/Runner.java": `package com.acme.billing;

import com.acme.core.Transfer;

public class Runner {
  void go(Transfer transfer) {
    Transfer.kindFor(null);
    transfer.settle();
    new Transfer("a");
  }
}
`,
    "src/main/java/com/acme/core/Ledger.java": `package com.acme.core;

class Ledger {
  void post(Transfer t) { t.settle(); }
}
`,
    "src/main/java/com/acme/other/Unrelated.java": `package com.acme.other;

class Unrelated {
  void go() { x.settle(); }
}
`,
    "app/src/main/kotlin/com/acme/app/Screen.kt": `package com.acme.app

import com.acme.core.*

class Screen(private val transfer: Transfer) {
    fun show() {
        transfer.settle()
        val t = Transfer("b")
        Transfer.kindFor(null)
    }
}

fun Transfer.describe(): String {
    settle()
    return ""
}
`,
  };

  it("follows imports, wildcard imports and packages, across Java and Kotlin", async () => {
    const graph = await repo(files);
    expect(
      sites(
        graph.callersOf({ path: "src/main/java/com/acme/core/Transfer.java", name: "settle", container: "Transfer" }),
      ),
    ).toEqual([
      "app/src/main/kotlin/com/acme/app/Screen.kt:7",
      "app/src/main/kotlin/com/acme/app/Screen.kt:14",
      "src/main/java/com/acme/billing/Runner.java:8",
      // Same package, so Ledger sees Transfer, but nothing says `t` is one.
      "src/main/java/com/acme/core/Ledger.java:4?",
      "src/main/java/com/acme/core/Transfer.java:7",
    ]);
    expect(
      sites(
        graph.callersOf({ path: "src/main/java/com/acme/core/Transfer.java", name: "Transfer", container: "Transfer" }),
      ),
    ).toEqual(["app/src/main/kotlin/com/acme/app/Screen.kt:8", "src/main/java/com/acme/billing/Runner.java:9"]);
    expect(
      sites(
        graph.callersOf({ path: "src/main/java/com/acme/core/Transfer.java", name: "kindFor", container: "Transfer" }),
      ),
    ).toEqual(["app/src/main/kotlin/com/acme/app/Screen.kt:9", "src/main/java/com/acme/billing/Runner.java:7"]);
  });

  it("reads Kotlin visibility, extension functions, companions and default parameters", async () => {
    const symbols = await extractSymbols(
      "a.kt",
      `package com.acme

class Runner {
    fun run(a: Int, b: String = ""): Int = 1
    private fun helper() {}
    companion object {
        fun make(): Runner = Runner()
    }
}

fun Runner.ext(y: Int) {}
`,
    );
    expect(symbols?.jvmPackage).toBe("com.acme");
    expect(symbols?.definitions.map((d) => `${d.container ?? ""}.${d.name}:${d.exported ? "pub" : "priv"}`)).toEqual([
      "Runner.run:pub",
      "Runner.helper:priv",
      "Runner.make:pub",
      ".Runner:pub",
      "Runner.ext:pub",
    ]);
    expect(symbols?.definitions[0]?.signature).toBe('fun run(a: Int, b: String = ""): Int');
  });
});
