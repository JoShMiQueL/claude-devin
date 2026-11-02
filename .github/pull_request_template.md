<!--
PR title MUST be a conventional commit — on squash-merge it becomes the
commit message on the target branch and feeds CHANGELOG.md via release-please.

  feat(cli): add --json output to status
  fix(proxy): retry upstream 502 once
  chore(deps): bump oxlint to 1.91

Type → version bump: feat → minor · fix/perf → patch · feat! / BREAKING
CHANGE → major · chore/ci/docs/test/build → no bump.

Base branch: feat|fix|chore|docs → `develop`. Only hotfix/* and
release-please branches may target `main`.
-->

## What

<!-- One or two sentences. What does this change do? -->

## Why

<!-- Motivation: bug report, user need, linked issue (#NN). Delete if obvious. -->

## How verified

<!--
- [ ] `bun run verify` passes locally (lint + bun check + tests)
- [ ] CI green on this PR
- [ ] Manually tested: <what you ran>
-->

## Breaking changes

<!-- Any behavior/config the user must adapt to? Write NONE if not. -->
