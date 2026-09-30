import { describe, expect, it } from "vitest";
import type { DiffFile, DiffLine } from "../diff/parse.js";
import { compatibleChange, declarationIn, signatureChanges, splitParameters } from "./signatures.js";

/** A file whose hunk removes `del` lines and adds `add` lines. */
function edit(path: string, del: string[], add: string[], previousPath?: string): DiffFile {
  const lines: DiffLine[] = [
    ...del.map((text, i) => ({ kind: "del" as const, text, oldLine: i + 1 })),
    ...add.map((text, i) => ({ kind: "add" as const, text, newLine: i + 1 })),
  ];
  return {
    path,
    ...(previousPath ? { previousPath } : {}),
    status: previousPath ? "renamed" : "modified",
    additions: add.length,
    deletions: del.length,
    binary: false,
    patchMissing: false,
    hunks: [{ header: "@@", oldStart: 1, oldLines: del.length, newStart: 1, newLines: add.length, lines }],
  };
}

describe("declarationIn", () => {
  it.each([
    ["src/a.ts", "export function createUser(name: string): User {", "createUser"],
    ["src/a.ts", "export default async function handler(req, res) {", "handler"],
    ["src/a.ts", "export const fetchQueue = async (client: Client) => {", "fetchQueue"],
    ["src/a.ts", "export class QueueRanker {", "QueueRanker"],
    ["src/a.ts", "export interface Briefing {", "Briefing"],
    ["src/a.ts", "  public async rank(pr: Pr): Promise<Ranked> {", "rank"],
    ["app/a.py", "        def inner(x):", undefined], // nested two levels deep: not public API
    ["app/a.py", "def build_filter(filter_expr, branch_negated=False):", "build_filter"],
    ["app/a.py", "    def resolve(self, value):", "resolve"],
    ["app/a.py", "class Invoice(models.Model):", "Invoice"],
    ["src/Str.php", "    public static function slug(string $title, string $separator = '-'): string", "slug"],
    ["src/Str.php", "    function legacy($x)", "legacy"],
    ["src/User.php", "    public function __construct(private Mailer $mailer)", "__construct"],
    ["src/User.php", "final class User extends Model", "User"],
    ["hugolib/site.go", "func (s *Site) Build(cfg BuildCfg) error {", "Build"],
    ["hugolib/site.go", "func NewSite(cfg Config) (*Site, error) {", "NewSite"],
    ["hugolib/site.go", "type Site struct {", "Site"],
  ])("%s: %s → %s", (path, line, name) => {
    expect(declarationIn(path, line)?.name).toBe(name);
  });

  it.each([
    ["src/a.ts", "function helper() {}"],
    ["src/a.ts", "  private rank(pr: Pr) {"],
    ["app/a.py", "def _private(x):"],
    ["src/Str.php", "    protected function guard()"],
    ["src/Str.php", "    private static function cache()"],
    ["hugolib/site.go", "func (s *Site) build() error {"],
    ["README.md", "export function notCode()"],
  ])("ignores non-public or non-code %s: %s", (path, line) => {
    expect(declarationIn(path, line)).toBeUndefined();
  });
});

describe("signatureChanges", () => {
  it("reports a changed signature", () => {
    const [change] = signatureChanges([
      edit("app/users.py", ["def create_user(name):"], ["def create_user(name, role):"]),
    ]);
    expect(change).toMatchObject({
      kind: "changed",
      before: { signature: "def create_user(name)" },
      after: { signature: "def create_user(name, role)", line: 1 },
    });
  });

  it("ignores a declaration whose line only moved or changed whitespace", () => {
    expect(
      signatureChanges([edit("a.go", ["func Build(cfg Cfg) error {"], ["func  Build(cfg Cfg)  error {"])]),
    ).toEqual([]);
  });

  it("reports removed and added declarations", () => {
    const changes = signatureChanges([edit("src/a.ts", ["export function old() {"], ["export function fresh() {"])]);
    expect(changes.map((c) => c.kind).sort()).toEqual(["added", "removed"]);
  });

  it("recognises a declaration moved to another file unchanged", () => {
    const changes = signatureChanges([
      edit("src/utils.ts", ["export function slugify(s: string) {"], []),
      edit("src/text.ts", [], ["export function slugify(s: string) {"]),
    ]);
    expect(changes).toEqual([expect.objectContaining({ kind: "moved" })]);
  });

  it("matches edits across a file rename", () => {
    const changes = signatureChanges([
      edit(
        "src/Str.php",
        ["    public function slug($t)"],
        ["    public function slug($t, $sep = '-')"],
        "src/Support/Str.php",
      ),
    ]);
    expect(changes).toEqual([expect.objectContaining({ kind: "changed" })]);
  });

  it("ignores test files", () => {
    expect(signatureChanges([edit("tests/test_users.py", ["def test_a():"], ["def test_b():"])])).toEqual([]);
  });
});

describe("compatibleChange", () => {
  it.each([
    [
      "PHP default",
      "public function findLatest(int $page = 1): Paginator",
      "public function findLatest(int $page = 1, int $perPage = 10): Paginator",
    ],
    ["TS default", "export function rank(queue: Queue)", "export function rank(queue: Queue, now = Date.now())"],
    [
      "TS optional",
      "export function rank(queue: Queue): Ranked",
      "export function rank(queue: Queue, options?: Options): Ranked",
    ],
    ["TS rest", "export function log(msg: string)", "export function log(msg: string, ...args: unknown[])"],
    ["Python default", "def charge(invoice)", "def charge(invoice, retries=3)"],
    ["Python keyword-only", "def charge(invoice)", "def charge(invoice, *, dry_run=False)"],
    ["Python kwargs", "def charge(invoice)", "def charge(invoice, **options)"],
    ["Go variadic", "func New(name string) *Server", "func New(name string, opts ...Option) *Server"],
    [
      "a generic default",
      "export function pick(xs: Map<string, number>)",
      "export function pick(xs: Map<string, number>, n = 3)",
    ],
  ])("%s is compatible", (_label, before, after) => {
    expect(compatibleChange(before, after)).toBe(true);
  });

  it.each([
    ["a required parameter", "def charge(invoice)", "def charge(invoice, card)"],
    ["a parameter inserted before", "function f(int $b = 1)", "function f(string $a, int $b = 1)"],
    ["a changed type", "func New(name string) *Server", "func New(name int, opts ...Option) *Server"],
    ["a changed return type", "func New(name string) *Server", "func New(name string, opts ...Option) Server"],
    ["a removed parameter", "def charge(invoice, retries=3)", "def charge(invoice)"],
    ["a cut-off first line", "def charge(", "def charge(invoice, retries=3)"],
  ])("%s is not", (_label, before, after) => {
    expect(compatibleChange(before, after)).toBe(false);
  });

  it("splits parameters at the top level only", () => {
    expect(splitParameters("f(a: Map<string, number>, b = [1, 2], c = 'x,y'): void")).toEqual({
      head: "f",
      params: ["a: Map<string, number>", "b = [1, 2]", "c = 'x,y'"],
      tail: ": void",
    });
  });
});
