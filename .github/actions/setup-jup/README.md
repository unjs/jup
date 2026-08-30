# `setup-jup`

jup's own CI, run by jup. One step replaces `actions/setup-node` **and**
`corepack enable`:

```yaml
- uses: actions/checkout@v6
- uses: ./.github/actions/setup-jup
  with: { node-version: lts }
- run: pnpm install
```

It is intentionally unpublished. Everything here goes through the documented
command surface ([§09](../../../.agents/09-cli.md)) and `jup info --json`, so it
is also a standing test that those two are enough to build on.

## What it does

1. Points `JUP_HOME` and `JUP_SHIM_DIRECTORY` at the runner's temp directory and
   restores that store from the cache, keyed by OS, architecture, jup version
   and the project's pins. The shim directory goes on `PATH` here, while it is
   still empty, so `enable` can see that its install directory is reachable.
2. Installs jup with the runner's own node — the only bootstrap step — into an
   npm prefix of its own, beside the shim directory. On Windows that is load
   bearing: a §10.4 wrapper names its stub relative to its own directory, and
   there is no relative path from `D:\a\_temp\jup-bin` to a global install on
   `C:`. `-f` covers the `corepack` name jup's `bin` also claims.
3. `jup enable` writes the package-manager shims into that directory.
4. `jup node --version` resolves, verifies and installs the runtime, and the
   real binary is linked beside those shims. `node` is a genuine executable, not
   a shim: no per-invocation cost, and `process.execPath` is what any tool would
   expect.
5. `jup install` warms the pinned package manager, so the first `pnpm install`
   of the job is already a store hit.
6. The manager's *own* store is cached separately — jup keeps programs, the
   package manager keeps packages, and preparing one does not prepare the other.

## Differences from `actions/setup-node`

| | `setup-node` | this |
|---|---|---|
| Version source | `node-version`, `node-version-file` | `node-version`, else `devEngines.runtime`, else `.nvmrc`, else jup's built-in default |
| `lts/*` | a codename per line | one `lts` tag, answered by jup's table; `lts/<codename>` is read as `lts` |
| Package manager | separate action, or `corepack enable` | pinned, verified and shimmed by the same step |
| Integrity | none beyond the download | signature-verified per host ([§06](../../../.agents/06-integrity.md)) |
| `npm` on `PATH` | the runtime's bundled copy | jup's shim, resolving the project's pin — `node-<target>` ships the binary alone |

Not carried over: `registry-url`, `scope`, `always-auth`, `mirror`, and the
problem matchers. Nothing here needs them; jup reads `.npmrc` for its own
requests either way ([§05](../../../.agents/05-registry.md)).

## Inputs

| Name | Default | Meaning |
|---|---|---|
| `node-version` | *(empty)* | Version, range or tag. Empty lets the project decide. |
| `jup-version` | `latest` | The jup release to install. `latest` is deliberate: a published release that cannot run this repository's own CI is worth finding out about here. |
| `package-managers` | `auto` | Names to shim. `auto` is jup's default set; `none` shims nothing. |
| `cache` | `true` | Save and restore `JUP_HOME`. |
| `cache-dependencies` | `true` | Save and restore the package manager's store. |
| `working-directory` | `.` | Which project's pins are read. |

Outputs: `node-version`, `node-path`, `package-manager`, `bin-directory`,
`jup-home`.

## A caveat worth keeping

A restored `JUP_HOME` is executable code trusted on a cache hit
([CI docs](../../../docs/3.ci.md)). The key carries the host triple and the
`restore-keys` prefix stops at the same jup and the same runtime request, and
`actions/cache` is pinned by digest for the same reason. Do not let an untrusted
fork populate a cache a release job reads.
