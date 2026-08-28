# 16 — Maintenance

This page covers recurring work only. The topical pages own behavior.

## Quality gate

Run focused unit and conformance tests while editing. Before merge, run:

```sh
pnpm test
pnpm build
```

Run `pnpm bench` for startup, project discovery, cache, or execution changes. A warm
exact pin must remain network-free, skip last-known-good and directory scans, and use
the direct marker probe described in §01 and §07.

## Built-in table and trust keys

The table in §02 is closed, ordered data. A change requires:

1. upstream maintainer consent for a newly supported tool;
2. verified registry packages, release targets, bin paths, and signatures/digests;
3. explicit range boundaries and host mappings;
4. unit and conformance coverage for resolution, installation, execution, and shims;
5. human review of generated changes.

The scheduled `.github/workflows/refresh-table.yml` workflow opens reviewed update
PRs. It MUST NOT auto-merge. Refresh npm trust keys from
`https://registry.npmjs.org/-/npm/v1/keys`; check origin, key IDs, SPKI bytes, expiry,
and rollover behavior. The refresh script removes expired keys, so maintainers MUST
confirm that ending verification for signatures that need those keys matches the
supported verification window before merging.

## Security review checklist

For network, archive, store, or execution changes, confirm:

- secrets never enter logs, redirects, project env, or foreign origins;
- TLS remains verified unless an ambient explicit opt-out is used;
- the verified bytes are the bytes promoted and executed;
- extraction cannot escape through paths, links, existing symlinks, or special files;
- temp data and atomic promotion stay on one filesystem;
- bin paths remain inside the install directory;
- native aliases receive the correct `argv[0]` and JavaScript launchers use a trusted
  runtime outside the managed store.

## Failure posture

Fail closed for verification, unsafe archives, escaped bins, malformed explicit
project intent, and unsupported hosts. Degrade safely for corrupt global defaults,
unwritable optional global state, race losers, and already-present read-only cache
entries. Never turn an internal error into a usage error.

## Source map

Start at `src/bin.ts` for CLI bootstrap and `src/main.ts` for classification and
dispatch. Then follow project/config, resolution/network/verification/cache, and
execution through `src/project`, `src/config`, `src/version`, `src/net`, `src/verify`,
`src/cache`, and `src/run`. Management commands and shims branch from that
path. Use `test/unit` and `test/conformance` as the nearest executable examples.
