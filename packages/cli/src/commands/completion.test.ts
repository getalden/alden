import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { completionScript, registerCompletionCommand } from "./completion.js";

function program() {
  const root = new Command().name("alden").version("1.0.0");
  root.command("queue").description("Rank the PRs.").option("--repo <owner/name>", "only this repo").option("--json");
  const memory = root.command("memory").description("What Alden knows.").option("--repo <owner/name>", "the repo");
  memory.command("add").description("Add a note; it's yours.").argument("<text>");
  root.command("feedback").option("--export <file>", "write it to a file");
  registerCompletionCommand(root);
  return root;
}

describe("alden completion", () => {
  it("completes commands, nested commands, flags and the shells, for bash", () => {
    const script = completionScript("bash", program());
    expect(script).toContain("\"\") words='queue memory feedback completion --version -V --help -h'");
    expect(script).toContain("\" memory add\") words='--help -h'");
    expect(script).toContain("\" completion\") words='zsh bash fish --help -h'");
    // After a flag that takes a value, nothing is suggested in its place.
    expect(script).toMatch(/--repo\|--export\) return/);
    expect(script).toContain("complete -o default -F _alden alden");
  });

  it("describes commands and flags for zsh, escaping quotes, and files only where a flag takes one", () => {
    const script = completionScript("zsh", program());
    expect(script.startsWith("#compdef alden\n")).toBe(true);
    expect(script).toContain("'add:Add a note; it'\\''s yours'");
    expect(script).toContain("'--repo:only this repo'");
    expect(script).toContain("files=(--export)");
    // `path` is tied to $PATH in zsh; the script must not clobber it.
    expect(script).not.toMatch(/local path/);
  });

  it("scopes each fish completion to the command it belongs to", () => {
    const script = completionScript("fish", program());
    expect(script).toContain(`complete -c alden -n "__alden_at ' memory'" -a add -d 'Add a note; it'\\''s yours'`);
    expect(script).toContain(`complete -c alden -n "__alden_at ' queue'" -l repo -r -d 'only this repo'`);
    expect(script).toContain(`complete -c alden -n "__alden_at ' feedback'" -l export -r -F`);
    expect(script).toContain(`complete -c alden -n "__alden_at ' completion'" -a 'zsh bash fish'`);
  });
});
