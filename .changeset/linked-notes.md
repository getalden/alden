---
"alden": minor
---

A comment on code GitHub won't take an inline comment on (a line outside the PR's diff, a file the PR doesn't change, a whole file) becomes a linked note instead of an error: a general note in the review body that starts with a link to that code at the PR's head when you wrote it, like **[`py/orders/tasks.py` line 5](…/blob/<sha>/py/orders/tasks.py#L5)**: your text. The editor says so before you save ("This line isn't in the PR's diff, so it goes in the review body with a link to it."), and the drawer lists it under **In the review body** with "links to py/orders/tasks.py, line 5". A suggested change in one posts as code headed "Suggested change" for the author to copy. `alden comment` and Claude Code's `alden_draft_comment` do the same and say so, after checking the file and line exist at the head. What the model also noticed, and the model's extra steps in guided review, get **Comment** too.
