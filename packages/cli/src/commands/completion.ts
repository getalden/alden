import { Argument, type Command } from "commander";

export const SHELLS = ["zsh", "bash", "fish"] as const;
export type Shell = (typeof SHELLS)[number];

/** A command as completion needs it: its path from `alden`, subcommands and flags. */
interface Node {
  path: string[];
  description: string;
  subcommands: Node[];
  /** Values an argument can only be, e.g. the shells for `alden completion`. */
  choices: string[];
  options: { flags: string[]; description: string; value: "none" | "text" | "file" }[];
}

/** Reads the commands and flags off the program, so completions never drift from what Alden accepts. */
function tree(command: Command, path: string[] = []): Node {
  const options = command.options
    .filter((o) => !o.hidden)
    .map((o) => ({
      flags: [o.long, o.short].filter((f): f is string => Boolean(f)),
      description: o.description,
      // `--export <file>` and `--dir <path>` take files; other values are names or numbers.
      value: !(o.required || o.optional)
        ? ("none" as const)
        : /<(file|path)>/.test(o.flags)
          ? ("file" as const)
          : ("text" as const),
    }));
  options.push({ flags: ["--help", "-h"], description: "show help", value: "none" });
  return {
    path,
    description: command.description(),
    subcommands: command.commands.map((c) => tree(c, [...path, c.name()])),
    choices: command.registeredArguments.flatMap((a) => a.argChoices ?? []),
    options,
  };
}

function all(node: Node): Node[] {
  return [node, ...node.subcommands.flatMap(all)];
}

/** Single-quoted for a shell: 'it'\''s'. */
const quote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`;
/** The first sentence, without its full stop, as completion menus show it. */
const brief = (text: string) => text.replace(/\s+/g, " ").replace(/\.( .*)?$/, "");

/**
 * Bash and zsh share this: walk the words typed so far and keep those that name a deeper command, so a flag's value
 * (`--repo acme/shop`) or a PR (`review 12`) never counts as a command. Leaves the path in `at`, e.g. " memory add". (Not `path`: zsh ties that to $PATH.)
 */
function pathWalker(nodes: Node[], words: string, first: string, current: string): string {
  const known = nodes
    .filter((n) => n.path.length > 0)
    .map((n) => `" ${n.path.join(" ")}"`)
    .join("|");
  return `  local at="" i w
  for ((i = ${first}; i < ${current}; i++)); do
    w="${words}[i]}"
    case "$at $w" in
      ${known}) at="$at $w" ;;
    esac
  done`;
}

function bash(root: Node): string {
  const nodes = all(root);
  const valued = nodes.flatMap((n) => n.options.filter((o) => o.value !== "none").flatMap((o) => o.flags));
  const cases = nodes
    .map((n) => {
      const words = [...n.subcommands.map((s) => s.path.at(-1)), ...n.choices, ...n.options.flatMap((o) => o.flags)];
      return `    "${n.path.length ? ` ${n.path.join(" ")}` : ""}") words=${quote(words.join(" "))} ;;`;
    })
    .join("\n");
  return `# alden completion for bash. Install it with one of:
#   alden completion bash > ~/.local/share/bash-completion/completions/alden
#   echo 'eval "$(alden completion bash)"' >> ~/.bashrc
_alden() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" prev="\${COMP_WORDS[COMP_CWORD-1]}" words
  # A flag that takes a value: leave it to the default (files).
  case "$prev" in
    ${[...new Set(valued)].join("|")}) return ;;
  esac
${pathWalker(nodes, "${COMP_WORDS", "1", "COMP_CWORD")}
  case "$at" in
${cases}
  esac
  COMPREPLY=($(compgen -W "$words" -- "$cur"))
}
complete -o default -F _alden alden
`;
}

function zsh(root: Node): string {
  const nodes = all(root);
  // zsh's _describe splits "name:description" at the first unescaped colon.
  const entry = (name: string, description: string) => quote(`${name.replace(/:/g, "\\:")}:${brief(description)}`);
  const cases = nodes
    .map((n) => {
      const subs = [
        ...n.subcommands.map((s) => entry(s.path.at(-1) ?? "", s.description)),
        ...n.choices.map((c) => entry(c, c)),
      ].join(" ");
      const opts = n.options.flatMap((o) => o.flags.map((f) => entry(f, o.description))).join(" ");
      const valued = n.options.filter((o) => o.value !== "none").flatMap((o) => o.flags);
      const files = n.options.filter((o) => o.value === "file").flatMap((o) => o.flags);
      return `    ("${n.path.length ? ` ${n.path.join(" ")}` : ""}")
      subs=(${subs})
      opts=(${opts})
      valued=(${valued.join(" ")})
      files=(${files.join(" ")}) ;;`;
    })
    .join("\n");
  return `#compdef alden
# alden completion for zsh. Install it with one of:
#   alden completion zsh > "\${fpath[1]}/_alden"   (then start a new shell)
#   echo 'eval "$(alden completion zsh)"' >> ~/.zshrc   (after compinit)
_alden() {
  local -a subs opts valued files
${pathWalker(nodes, "${words", "2", "CURRENT")}
  case "$at" in
${cases}
  esac
  local prev="\${words[CURRENT-1]}"
  if (( \${files[(Ie)$prev]} )); then _files; return; fi
  if (( \${valued[(Ie)$prev]} )); then _message 'value'; return; fi
  if [[ "\${words[CURRENT]}" == -* ]]; then _describe 'option' opts; return; fi
  if (( \${#subs} )); then _describe 'command' subs; else _describe 'option' opts; fi
}
if [ "$funcstack[1]" = "_alden" ]; then _alden "$@"; else compdef _alden alden; fi
`;
}

function fish(root: Node): string {
  const nodes = all(root);
  const at = (n: Node) => (n.path.length ? ` ${n.path.join(" ")}` : "");
  const lines = [
    "# alden completion for fish. Install it with:",
    "#   alden completion fish > ~/.config/fish/completions/alden.fish",
    "",
    "# Whether the commands typed so far are $argv[1], e.g. ' memory add', skipping flags, their values and arguments.",
    "function __alden_at",
    "    set -l path ''",
    "    for word in (commandline -opc)[2..]",
    '        switch "$path $word"',
    `            case ${nodes
      .filter((n) => n.path.length > 0)
      .map((n) => quote(at(n)))
      .join(" ")}`,
    '                set path "$path $word"',
    "        end",
    "    end",
    '    test "$path" = "$argv[1]"',
    "end",
    "",
    "complete -c alden -f",
  ];
  for (const n of nodes) {
    const when = `-n "__alden_at '${at(n)}'"`;
    for (const s of n.subcommands) {
      lines.push(`complete -c alden ${when} -a ${s.path.at(-1)} -d ${quote(brief(s.description))}`);
    }
    if (n.choices.length > 0) lines.push(`complete -c alden ${when} -a ${quote(n.choices.join(" "))}`);
    for (const o of n.options) {
      const flags = o.flags.map((f) => (f.startsWith("--") ? `-l ${f.slice(2)}` : `-s ${f.slice(1)}`)).join(" ");
      const value = o.value === "file" ? " -r -F" : o.value === "text" ? " -r" : "";
      lines.push(`complete -c alden ${when} ${flags}${value} -d ${quote(brief(o.description))}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The completion script for a shell, generated from the program's commands and flags. */
export function completionScript(shell: Shell, program: Command): string {
  const root = tree(program);
  return shell === "zsh" ? zsh(root) : shell === "bash" ? bash(root) : fish(root);
}

const INSTALL = `
Install:
  zsh   alden completion zsh > "\${fpath[1]}/_alden"   then start a new shell
        (or add  eval "$(alden completion zsh)"  to ~/.zshrc, after compinit)
  bash  alden completion bash > ~/.local/share/bash-completion/completions/alden
        (or add  eval "$(alden completion bash)"  to ~/.bashrc)
  fish  alden completion fish > ~/.config/fish/completions/alden.fish

Run it again after upgrading Alden, so new commands and flags complete too.`;

export function registerCompletionCommand(program: Command): void {
  program
    .command("completion")
    .description("Print a shell completion script for zsh, bash or fish.")
    .addArgument(new Argument("<shell>", "zsh, bash or fish").choices(SHELLS))
    .addHelpText("after", INSTALL)
    .action((shell: Shell) => {
      process.stdout.write(completionScript(shell, program));
    });
}
