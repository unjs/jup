---
icon: i-lucide-package-check
---

# jup documentation

jup reads the package manager declared in `package.json`, downloads and verifies that release, and runs it. It supports npm, pnpm, Yarn, Bun, and Deno.

```json
{
  "packageManager": "pnpm@11.1.2+sha512.abc123..."
}
```

When `pnpm install` runs through a jup shim, it uses the pinned release rather than an unrelated global installation. The same pin can be used on developer machines, in CI, and in containers.

::note
jup is not published to npm yet. Follow the source installation steps in [Getting started](./getting-started).
::

## Start here

- [Getting started](./getting-started) — install jup, enable its shims, and pin a package manager.
- [Projects and workspaces](./projects-and-workspaces) — configure exact versions, ranges, `devEngines`, workspaces, and `.jup.lock`.

## Deployment guides

- [CI and offline use](./ci-and-offline) — warm the cache, build container layers, freeze range resolutions, and move package managers to isolated machines.
- [Registries and networking](./registries-and-networking) — configure private registries, authentication, `.npmrc`, proxies, TLS, timeouts, and retries.
- [Download verification](./security) — understand digests, registry signatures, signing keys, trust boundaries, and Yarn Berry downloads.

## Reference

- [Commands](./commands) — review every command and its side effects.
- [Environment variables](./settings-reference) — find every supported `JUP_*` setting.

## Migration and support

- [Migrating from Corepack](./corepack-migration) — reuse existing project configuration and understand behavior that differs from Corepack.
- [Troubleshooting](./troubleshooting) — diagnose shim, cache, registry, TLS, and verification failures.

::tip
If jup selects an unexpected manifest or version, run `jup info`. It reports the project pin, registry, cache entry, and active shims without contacting the network.
::
