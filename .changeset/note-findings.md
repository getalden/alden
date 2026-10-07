---
"alden": minor
---

A model finding raised because of one of your notes now says so: "Because of your note: Every file needs a code owner header", in the briefing, guided review, the terminal and `alden_review`. Each note goes to the model with a short id for that review, and Alden keeps the link only when the model names one of those ids, so text in a PR can't pass itself off as your note. Reacting to such a finding teaches the note, not a check: **Useful** confirms it (Memory shows "confirmed 3×"), and after **Not useful** `alden ui` offers **Stop applying this note to app/api?** or **Edit the note**; without either, nothing changes. A note you stop under a folder or file isn't sent for changes there, and the model is told where it doesn't apply for changes that are partly there. `alden memory` lists where each note is stopped, and `alden memory exclude <id> <path>` / `alden memory include <id> <path>` change it from a terminal.
