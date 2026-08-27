# jup

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/jup?color=yellow)](https://npmjs.com/package/jup)
[![npm downloads](https://img.shields.io/npm/dm/jup?color=yellow)](https://npm.chart.dev/jup)

<!-- /automd -->

**jup runs the right tool version for every project.**

Pin a package manager in `package.json`, then use its normal command:

```json
{
  "packageManager": "pnpm@11.22.0+sha512.abc123..."
}
```

```sh
pnpm install
```

jup reads the pin, downloads and verifies that pnpm release, caches it, and runs it. Everyone on the project gets the same version—on developer machines, in CI, and while working offline with a prepared cache.

jup supports npm, pnpm, Yarn, Bun, Deno, aube, and nub. It can also run a project-pinned Node.js version from `devEngines.runtime`:

```sh
jup node@22 script.js
```

It is designed as a fast, small, zero-runtime-dependency replacement for [Corepack](https://github.com/nodejs/corepack), with support for more than package managers.

## Quick start

Install jup by following the [getting started guide](./docs/1.getting-started.md), then enable its command shims:

```sh
jup enable
```

Pin a package manager in your project:

```sh
jup use pnpm@11
```

Now run `pnpm`, `npm`, or `yarn` as usual. jup selects the version pinned by the project.

To run a manager without installing shims, put `jup` before the command:

```sh
jup pnpm install
```

Check which project, version, cache, and shims jup is using:

```sh
jup info
```

## Documentation

- [Introduction](./docs/0.intro.md)
- [Getting started](./docs/1.getting-started.md)
- [Projects and workspaces](./docs/2.projects-and-workspaces.md)
- [CI and offline](./docs/3.ci-and-offline.md)
- [Registries and networking](./docs/4.registries-and-networking.md)
- [Commands](./docs/5.commands.md)
- [Security](./docs/6.security.md)
- [Environment](./docs/7.settings-reference.md)
- [Moving from Corepack](./docs/8.corepack.md)
- [Troubleshooting](./docs/9.troubleshooting.md)

## Credits

jup builds on the work of [Corepack](https://github.com/nodejs/corepack) and its contributors. Its behavior is modeled on Corepack v0.35.0, so existing `packageManager` pins, commands, and messages keep working. Thanks to the Corepack contributors for the design jup started from.

## License

Published under the [MIT](./LICENSE) license.

Portions derived from [Corepack](https://github.com/nodejs/corepack), Copyright © Corepack contributors, also MIT licensed. See [LICENSE](./LICENSE) for the full notice.
