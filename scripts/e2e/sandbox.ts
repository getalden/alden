/**
 * Writes the e2e sandbox repo, a small shop in four languages built to give every Alden check something to find:
 * `pnpm e2e:sandbox <dir> --owner <your login>`.
 *
 * TypeScript, Python (Django-style migrations), Go and PHP (Laravel-style migrations), each with a function called
 * from other files (for the code graph), an auth folder (a sensitive path), manifests, tests, CODEOWNERS (you own py/)
 * and a CI workflow that passes in seconds unless a PR adds ci/FAIL. It lives at getalden/alden-e2e-sandbox; this
 * script is how it was made, so it can be made again.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const dir = args[0];
const owner = args[args.indexOf("--owner") + 1];
if (!dir || !owner || args.indexOf("--owner") < 0)
  throw new Error("Usage: pnpm e2e:sandbox <dir> --owner <github login>");

const files: Record<string, string> = {
  "README.md": `# Alden e2e sandbox

A small shop in TypeScript, Python, Go and PHP, made for testing [Alden](https://getalden.dev) end to end. Its PRs are
opened by Alden's test kit (\`pnpm e2e:seed\` in the alden repo) and are never merged.

- \`ts/\`: the storefront (pricing, cart, auth)
- \`py/\`: the orders service (Django-style models and migrations)
- \`go/\`: the ledger
- \`php/\`: invoicing (Laravel-style)

CI passes in a few seconds, unless a PR adds \`ci/FAIL\`.
`,
  "docs/architecture.md":
    "# Architecture\n\nThe storefront prices carts; orders are stored by the orders service; the ledger posts payments; invoicing bills them.\n",
  "docs/runbook.md": "# Runbook\n\nRestart a service with `make restart SERVICE=<name>`.\n",
  ".github/CODEOWNERS": `/py/ @${owner}\n`,
  ".github/workflows/ci.yml": `name: CI

on:
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 2
    steps:
      - uses: actions/checkout@v5
      - name: Fail when asked to
        run: test ! -f ci/FAIL
`,
  "ci/README.md": "A PR that adds `ci/FAIL` here makes CI fail, for testing PRs that wait on their author.\n",

  // ─── TypeScript ───
  "ts/package.json": `${JSON.stringify(
    {
      name: "shopfront",
      private: true,
      type: "module",
      scripts: { test: "vitest run" },
      dependencies: { express: "4.21.2", zod: "3.24.1", "date-fns": "4.1.0" },
      devDependencies: { typescript: "5.7.3", vitest: "3.0.5" },
    },
    null,
    2,
  )}\n`,
  "ts/src/pricing.ts": `export interface Line {
  sku: string;
  quantity: number;
  unitCents: number;
}

/** A line's total in cents, before tax. */
export function lineTotal(line: Line): number {
  return line.quantity * line.unitCents;
}

/** Tax on an amount in cents, rounded half up. */
export function priceWithTax(amountCents: number, rate: number): number {
  return Math.round(amountCents * (1 + rate));
}
`,
  "ts/src/cart.ts": `import { type Line, lineTotal, priceWithTax } from "./pricing";

export class Cart {
  private lines: Line[] = [];

  add(line: Line): void {
    this.lines.push(line);
  }

  subtotal(): number {
    return this.lines.reduce((sum, line) => sum + lineTotal(line), 0);
  }

  total(taxRate: number): number {
    return priceWithTax(this.subtotal(), taxRate);
  }
}
`,
  "ts/src/checkout.ts": `import { Cart } from "./cart";
import { priceWithTax } from "./pricing";

export function quote(cart: Cart, taxRate: number, shippingCents: number): number {
  return cart.total(taxRate) + priceWithTax(shippingCents, taxRate);
}
`,
  "ts/src/receipts.ts": `import { lineTotal, type Line } from "./pricing";

export function receiptLines(lines: Line[]): string[] {
  return lines.map((line) => \`\${line.sku} x\${line.quantity}: \${(lineTotal(line) / 100).toFixed(2)}\`);
}
`,
  "ts/src/auth/session.ts": `const SESSION_MINUTES = 30;

export function expiresAt(now: Date): Date {
  return new Date(now.getTime() + SESSION_MINUTES * 60_000);
}

export function isExpired(expires: Date, now: Date): boolean {
  return now.getTime() >= expires.getTime();
}
`,
  "ts/src/payments/charge.ts": `import { priceWithTax } from "../pricing";

export function chargeAmount(subtotalCents: number, taxRate: number): number {
  return priceWithTax(subtotalCents, taxRate);
}
`,
  "ts/test/pricing.test.ts": `import { describe, expect, it } from "vitest";
import { priceWithTax } from "../src/pricing";

describe("priceWithTax", () => {
  it("adds tax", () => {
    expect(priceWithTax(1000, 0.2)).toBe(1200);
  });
});
`,

  // ─── Python ───
  "py/requirements.txt": "Django==5.1.4\nrequests==2.32.3\ncelery==5.4.0\n",
  "py/orders/__init__.py": "",
  "py/orders/models.py": `from django.db import models


class Order(models.Model):
    reference = models.CharField(max_length=32, unique=True)
    total_cents = models.IntegerField()
    legacy_code = models.CharField(max_length=16, blank=True)
`,
  "py/orders/pricing.py": `def order_total(lines):
    """The total of (quantity, unit_cents) pairs, in cents."""
    return sum(quantity * unit_cents for quantity, unit_cents in lines)


def apply_discount(total_cents, percent):
    return total_cents - (total_cents * percent) // 100
`,
  "py/orders/views.py": `from .pricing import apply_discount, order_total


def checkout(lines, discount_percent=0):
    total = order_total(lines)
    return apply_discount(total, discount_percent)
`,
  "py/orders/tasks.py": `from .pricing import order_total


def nightly_report(orders):
    return sum(order_total(order) for order in orders)
`,
  "py/orders/auth/permissions.py": `def can_refund(user):
    return user.get("role") in {"admin", "support"}
`,
  "py/orders/migrations/__init__.py": "",
  "py/orders/migrations/0001_initial.py": `from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Order",
            fields=[
                ("id", models.AutoField(primary_key=True)),
                ("reference", models.CharField(max_length=32, unique=True)),
                ("total_cents", models.IntegerField()),
                ("legacy_code", models.CharField(max_length=16, blank=True)),
            ],
        ),
    ]
`,
  "py/orders/settings.py": `DEBUG = False\nALLOWED_HOSTS = ["shop.example.com"]\n`,
  "py/tests/test_pricing.py": `from orders.pricing import order_total


def test_order_total():
    assert order_total([(2, 150)]) == 300
`,

  // ─── Go ───
  "go/go.mod":
    "module example.com/ledger\n\ngo 1.23\n\nrequire (\n\tgithub.com/google/uuid v1.6.0\n\tgolang.org/x/sync v0.10.0\n)\n",
  "go/ledger/ledger.go": `package ledger

// Entry is one posting to an account, in cents.
type Entry struct {
	Account string
	Cents   int64
}

// Post records an entry and returns the account's new balance.
func Post(balances map[string]int64, entry Entry) int64 {
	balances[entry.Account] += entry.Cents
	return balances[entry.Account]
}

// Balance is an account's balance.
func Balance(balances map[string]int64, account string) int64 {
	return balances[account]
}
`,
  "go/ledger/refunds.go": `package ledger

// Refund posts a negative entry.
func Refund(balances map[string]int64, account string, cents int64) int64 {
	return Post(balances, Entry{Account: account, Cents: -cents})
}
`,
  "go/cmd/server/main.go": `package main

import (
	"fmt"

	"example.com/ledger/ledger"
)

func main() {
	balances := map[string]int64{}
	ledger.Post(balances, ledger.Entry{Account: "sales", Cents: 1200})
	fmt.Println(ledger.Balance(balances, "sales"))
}
`,
  "go/auth/tokens.go": `package auth

import "time"

// TokenLifetime is how long an API token lasts.
const TokenLifetime = 24 * time.Hour
`,
  "go/ledger/ledger_test.go": `package ledger

import "testing"

func TestPost(t *testing.T) {
	balances := map[string]int64{}
	if got := Post(balances, Entry{Account: "a", Cents: 5}); got != 5 {
		t.Fatalf("got %d", got)
	}
}
`,

  // ─── PHP ───
  "php/composer.json": `${JSON.stringify(
    {
      name: "shop/invoicing",
      require: { php: "^8.3", "laravel/framework": "11.36.1", "guzzlehttp/guzzle": "7.9.2" },
      "require-dev": { "phpunit/phpunit": "11.5.2" },
      autoload: { "psr-4": { "App\\\\": "app/" } },
    },
    null,
    2,
  )}\n`,
  "php/artisan": "#!/usr/bin/env php\n<?php\n// The Laravel console entry point (a stand-in).\n",
  "php/app/Services/InvoiceService.php": `<?php

namespace App\\Services;

class InvoiceService
{
    public function totalFor(array $lines): int
    {
        return array_sum(array_map(fn ($l) => $l['quantity'] * $l['unit_cents'], $lines));
    }

    public function numberFor(int $id): string
    {
        return sprintf('INV-%06d', $id);
    }
}
`,
  "php/app/Http/Controllers/InvoiceController.php": `<?php

namespace App\\Http\\Controllers;

use App\\Services\\InvoiceService;

class InvoiceController
{
    public function __construct(private InvoiceService $invoices) {}

    public function show(int $id, array $lines): array
    {
        return ['number' => $this->invoices->numberFor($id), 'total' => $this->invoices->totalFor($lines)];
    }
}
`,
  "php/app/Jobs/SendInvoice.php": `<?php

namespace App\\Jobs;

use App\\Services\\InvoiceService;

class SendInvoice
{
    public function handle(InvoiceService $invoices, array $lines): int
    {
        return $invoices->totalFor($lines);
    }
}
`,
  "php/app/Auth/Gate.php": `<?php

namespace App\\Auth;

class Gate
{
    public function canIssueCredit(array $user): bool
    {
        return in_array($user['role'] ?? '', ['finance', 'admin'], true);
    }
}
`,
  "php/database/migrations/2024_01_01_000000_create_invoices_table.php": `<?php

use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('invoices', function (Blueprint $table) {
            $table->id();
            $table->integer('total_cents');
            $table->string('legacy_code')->nullable();
        });
    }
};
`,
  "php/tests/Unit/InvoiceServiceTest.php": `<?php

use App\\Services\\InvoiceService;
use PHPUnit\\Framework\\TestCase;

final class InvoiceServiceTest extends TestCase
{
    public function testTotal(): void
    {
        $this->assertSame(300, (new InvoiceService())->totalFor([['quantity' => 2, 'unit_cents' => 150]]));
    }
}
`,
};

for (const [path, content] of Object.entries(files)) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}
console.log(`Wrote the e2e sandbox (${Object.keys(files).length} files) into ${dir}.`);
