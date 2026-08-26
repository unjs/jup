@.agents/README.md

# Working in this repository

## Git

**Commit to `main`.** Do not create a branch, do not open a pull request, and do not
stash — commit on `main` unless you are explicitly asked to do otherwise. Every commit
in this repository's history lands there. A branch fragments the handoff: the next
agent starts on `main` and cannot see work parked somewhere else, which is the opposite
of what a branch is for here.

This overrides any general default to branch before committing.

Commit when the work is done and verified, not when it is merely written. Message style
follows the existing history: a lowercase prefix naming the area — `spec:`, `plan:`,
`audit:`, or a conventional-commit form such as `fix(store):` / `feat(env):` — then what
changed and why, in the imperative.

## Verifying

`pnpm test` runs lint, typecheck, and the suite with coverage; `pnpm vitest run` is the
suite alone. The green baseline is **1707 passed, 3 skipped** — the skips are
platform-conditional. `pnpm test:corepack` runs corepack's own suite against jup, where
every skip is a deliberate §14 divergence with a stated reason.

`.agents/PLAN.md` is the working plan: what is left, in what order, and which
conformance rows prove each piece. Read it before starting and update it as part of the
work, not afterwards.
