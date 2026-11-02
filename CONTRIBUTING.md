# Contributing

## Branching model — GitFlow

```
main      ← releases only. Tags vX.Y.Z. Never work-in-progress.
  │
  ├── hotfix/<name>   → PR to main → squash → tag vX.Y.Z
  ├── release/<ver>   → PR to main → squash → tag vX.Y.0
  │
  └── develop         ← integration branch. Features live here.
        ├── feat/<name>   → PR to develop
        ├── fix/<name>    → PR to develop
        └── chore/<name>  → PR to develop
```

**Rules enforced by CI + branch protection** (you can't bypass them):

- `main` only accepts PRs whose source is `hotfix/*`, `release/*`, or
  `develop`. A feature branch PRed straight to main fails the `branch-gate`
  check and cannot merge. This keeps hotfixes and features from mixing —
  `main` is always clean, releaseable history.
- `develop` accepts PRs from `feat/*`, `fix/*`, `chore/*`, `docs/*`.
- Both branches: no direct push, no force push, no deletion, linear history,
  all 4 CI checks (`verify` + `test` × 3 OS) green and branch up to date.
- All merges are **squash** — one commit per PR. Branches auto-delete on
  merge.
- `enforce_admins` is on: these rules apply to the repo owner too.

## Everyday work (features, fixes, chores)

```bash
git checkout -b feat/my-thing develop
# ...work, commit...
gh pr create --base develop --title "feat: my thing"
# CI green → squash merge. Branch auto-deletes.
```

## Shipping a release

```bash
# 1. Cut a release branch off develop
git checkout -b release/0.5.0 develop
git push -u origin release/0.5.0

# 2. Stabilize on the release branch (fixes PRed to release/0.5.0)
# 3. When ready, PR the release branch into main
gh pr create --base main --head release/0.5.0 --title "release: v0.5.0"

# 4. Squash merge → tag
git checkout main && git pull
git tag v0.5.0 && git push origin v0.5.0

# 5. Merge main back into develop so the release commits aren't lost
git checkout develop && git merge main && git push
```

## Emergency hotfix (bug in the released version)

```bash
# 1. Branch off the tag (or main — same thing, main is always the last release)
git checkout -b hotfix/login-crash main

# 2. Fix + test
# 3. PR straight to main — hotfix/* is allowed by branch-gate
gh pr create --base main --title "fix: login crash on token refresh"

# 4. Squash merge → tag the patch
git checkout main && git pull
git tag v0.4.1 && git push origin v0.4.1

# 5. Port the fix into develop so it doesn't regress
git checkout develop && git merge main && git push
```

The hotfix touches `main` alone — no features ride along, so a rollback of the
patch is a rollback of just the fix.

## Local checks

Pre-push runs lint + typecheck via lefthook (~2s). Run the full suite locally
any time with:

```bash
bun run verify   # lint + bun check + bun test
```
