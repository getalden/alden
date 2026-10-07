---
"alden": minor
---

Alden notes which of its places you actually saw, so it can learn from what your reviews pass without a word: a guided review step in front of you for 1.5 seconds, or an **E1**, **E2**… marker in the Diff tab on screen for 1.5 seconds. Each place is kept once per PR and head commit, for 90 days and the last 200 PRs, on your machine only: never in usage stats or the feedback export, and never for **My changes**. Settings → Learning has **Learn from my reviews** (`learning.fromReviews`, on by default) to turn it off. The Memory view says where a learned item came from ("from your review of acme/shop#412, Oct 8", "and 3 more"), and after you send a review the Comments drawer says in one line what Alden learned from it.
