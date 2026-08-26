---
icon: i-lucide-package-check
---

# Introduction

jup runs the version of npm, pnpm, or Yarn that a project asks for. It downloads that version, checks it, saves it in a local cache, and then runs it.

This prevents one computer from changing a lockfile because it used a different package manager version.

## Get started

1. Install jup. A release is not on npm yet. To try the current source, clone the repository, run `pnpm install && pnpm pack`, then install the generated `.tgz` with `npm install -g ./jup-0.0.0.tgz`.

2. Install its **shims**. A shim is a small command that sends `npm`, `pnpm`, or `yarn` to jup.

   ```sh
   jup enable
   ```

3. In your project, choose a package manager:

   ```sh
   jup use pnpm@11
   ```

4. Use the package manager normally:

   ```sh
   pnpm install
   ```

jup reads the project pin from `package.json`. It then runs the pinned version, not an unrelated version installed elsewhere on your computer.

::note
jup is compatible with Corepack projects. It understands the same `packageManager` field and `COREPACK_*` settings. Every `COREPACK_*` setting also has a `JUP_*` name.
::

## Where to go next

- [Install and set up jup](./getting-started)
- [Understand project pins](./project-pins)
- [Use everyday commands](./commands)
- [Work with the cache, offline installs, and verification](./cache-and-security)
- [Configure registries, proxies, and environment variables](./configuration)
- [Learn how jup differs from Corepack](./corepack-compatibility)
- [Fix common problems](./troubleshooting)

::tip
Run `jup info` when the result is surprising. It explains which project file, pin, registry, cache entry, and shim jup found. It does not make a network request.
::
