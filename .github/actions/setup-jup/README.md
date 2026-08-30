# `setup-jup`

jup's unpublished CI action replaces `actions/setup-node` plus
`corepack enable`:

```yaml
- uses: actions/checkout@v6
- uses: ./.github/actions/setup-jup
  with: { node-version: lts }
- run: pnpm install
```

It uses only the documented [§09 command surface](../../../.agents/09-cli.md)
and `jup info --json`, making the action a standing test of that interface.

## How it works

1. Set `JUP_HOME` and `JUP_SHIM_DIRECTORY` under the runner's temp directory,
   add the shim directory to `PATH`, and restore jup's host-specific cache.
2. Bootstrap with the runner's node via `npx jup self-install`. The permanent
   jup copy and its `jup`/`corepack` shims are owned by jup
   ([§09.12](../../../.agents/09-cli.md)).
3. Enable `node` and the requested managers together so every shim gets the
   runner's absolute interpreter ([§10.2](../../../.agents/10-shims.md)).
4. Record an explicit `node-version` as jup's global default, then resolve,
   verify, install, and report the version through the `node` shim. Project
   runtime pins still take precedence.
5. Warm the project-pinned package manager with `jup cache install`.
6. Cache the manager's package store separately from jup's program store.

## Differences from `actions/setup-node`

| | `setup-node` | this action |
|---|---|---|
| Version source | `node-version`, `node-version-file` | `node-version`; otherwise `devEngines.runtime`, `.nvmrc`, or jup's default |
| `lts/*` | codename-specific | mapped to jup's single `lts` tag |
| Package managers | separate action or `corepack enable` | pinned, verified, and shimmed by jup |
| Integrity | download integrity only | per-host signature verification ([§06](../../../.agents/06-integrity.md)) |
| `npm` | runtime-bundled copy | jup shim resolving the project pin |
| `node` | extracted binary | jup shim; runtime pin changes apply mid-job at one process hop per call |

Not supported: `registry-url`, `scope`, `always-auth`, `mirror`, or problem
matchers. jup reads `.npmrc` for its requests without action configuration
([§05](../../../.agents/05-registry.md)).

## Inputs

| Name | Default | Meaning |
|---|---|---|
| `node-version` | *(empty)* | Version, range, or tag. Empty uses project/default resolution. |
| `jup-version` | `latest` | npm spec for jup. `latest` intentionally tests the published release. |
| `package-managers` | `auto` | Space-separated managers. `auto` enables the full table; `none` enables no manager. `node` is always enabled. |
| `cache` | `true` | Cache `JUP_HOME`. |
| `cache-dependencies` | `true` | Cache the package manager's store. |
| `working-directory` | `.` | Project directory whose pins are read. |

Outputs: `node-version`, `node-path`, `package-manager`, `bin-directory`, and
`jup-home`.

## Job changes

Later steps inherit:

- One new leading `PATH` entry containing all jup shims, including `node`,
  package managers, `jup`, and `corepack`.
- `JUP_HOME` and `JUP_SHIM_DIRECTORY`. Caller-provided values are preserved.

No other job variables are exported. Both cache keys use the `setup-jup-`
prefix to avoid caller cache collisions.

## Cache safety

`<JUP_HOME>/self` is excluded from the cache. Its CLI entry embeds the runner's
absolute node path ([§10.2](../../../.agents/10-shims.md)); restoring it could
retain a path from an older image because `self-install` compares the downloaded
source digest. npx downloads that source each run, so only a local copy is lost.

A restored `JUP_HOME` is trusted executable code
([CI docs](../../../docs/3.ci.md)). Cache keys therefore include the host triple,
jup version, and runtime request; restore prefixes stop at that boundary; and
`actions/cache` is pinned by digest. Do not let untrusted forks populate caches
used by release jobs.
