# Briefings and checks

`alden review` produces a briefing. Every claim in it says how it was checked, so you can decide what to trust.

## What a briefing contains

- **Summary**: the PR's title, author, size and files. With a model, also what the change does and whether it matches
  its title.
- **Needs your eyes**: a few places (3 unless you set `review.eyes`, up to 10), each with a file, a line and the reason. See
  [How Alden picks where to look](#how-alden-picks-where-to-look).
- **Checked**: every check, with its result (passed, flagged or skipped), a summary and evidence. Evidence is what
  the check looked at and found, usually anchored to a file and line.
- **Also noted by the model**: model findings that didn't make the top 3.
- **Not checked**: what Alden couldn't check, such as callers in languages the code graph doesn't read yet.
- **Footer**: the model, effort and cost, when a model ran.

Checks marked `~` are heuristic: they infer from the diff (and the code graph) rather than proving something. Treat
them as leads.

## The checks

| Check | Flags | Severity |
| --- | --- | --- |
| **Likely secrets** (`secrets.likely`) | Added lines that look like credentials: known key formats and high-entropy strings. Values are masked in the output. | Critical |
| **CI status** (`ci.status`) | CI failing on the latest commit. Skipped when CI is pending, absent, or for local changes. | High |
| **Callers outside the diff** (`callers.outside`) | Changed public code that's still called from places the PR didn't touch. See [The code graph](code-graph.md). | High when removed or re-signed code is still called, medium if only by name match, low for behaviour changes |
| **Database migrations** (`migrations.changed`) | Changed migrations. Critical when they drop, rename or reshape data (SQL, Django, Laravel, Doctrine). | Medium or critical |
| **Changed public signatures** (`signatures.changed`) | Exported functions, classes and methods whose signature changed or that were removed, in TS/JS, Python, PHP and Go. Go and PHP use the code graph; TS/JS and Python read the diff. | Low or medium |
| **Code changed without tests** (`tests.missing`) | Code changes with no test changes alongside them. Changes that are only comments or blank lines (TS/JS, Python including docstrings, Go, PHP and other C-style or `#` languages), and files moved without edits, don't count. | Medium |
| **Dependencies** (`dependencies.changed`) | Added, removed or re-versioned dependencies in package.json, composer.json, go.mod, requirements.txt and pyproject.toml, including package.json's `resolutions`, `overrides` and `pnpm.overrides`, which force versions on the whole tree. | Low, or medium for risky changes (a new runtime or peer package, a new override, a major upgrade) |
| **Configuration and environment** (`config.changed`) | Config files (`.env`, settings, Docker, Terraform, CI, deploy config) and new environment variable references. | Medium |
| **Sensitive paths** (`paths.sensitive`) | Files matching your [sensitive paths](configuration.md#queue). | Medium |

Severities, most serious first: **critical** (a likely secret, a migration that can lose data: harm on its own if
merged), **high**, **medium**, **low**. Passed and skipped checks are **info**. Critical is labelled in full and drawn
stronger than high in the terminal and the app.

## How Alden picks where to look

"Needs your eyes" holds 3 places unless you set `review.eyes` (1 to 10, in Settings or `alden config set review.eyes 5`):

1. The most severe findings come first. Alden takes them in turn across checks, so one noisy check can't fill every
   slot.
2. Each file and each directory gets at most one slot, so ten workflow files don't crowd out everything else. Secrets
   are exempt.
3. CI status never takes a slot: a failing build is already at the top of the checks, and the fix is the author's.
4. Lockfiles never take a slot, except for secrets.
5. Places in code come before places in tests. A caller in a test file never takes a slot; it stays in the
   "Callers outside the diff" evidence, which lists callers in code first.

A low-severity check gets one slot at most, so a harmless change with many callers doesn't fill the list.

With a model, its medium and high findings fill the slots that deterministic checks leave. A high or critical check always
keeps its slot. Model findings that point at a line outside the diff are dropped, and the footer counts them.

## Local reviews

`alden review` with no argument reviews your uncommitted changes (staged, unstaged and untracked) against `HEAD`. It's
the same briefing, without CI status. Use it before opening a PR.
