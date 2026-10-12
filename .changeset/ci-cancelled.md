---
"alden": patch
---

A cancelled CI run no longer counts as failing CI. GitHub's summary calls it a failure, so Alden now reads the runs: a cancelled run of a check that ran again counts as that run, and when a cancelled run is all that kept CI from passing, the queue says **CI cancelled** (`cancelled` in `alden queue`) and the PR keeps its place instead of sinking with "CI failing: ping @author". The CI status check skips it. Any other failed run still makes CI failing.
