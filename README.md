# jup

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/jup?color=yellow)](https://npmjs.com/package/jup)
[![npm downloads](https://img.shields.io/npm/dm/jup?color=yellow)](https://npm.chart.dev/jup)

<!-- /automd -->

jup runs the package manager version your project asks for.

It reads the pin in `package.json`, downloads and verifies the requested version, saves it in a local cache, and runs it. This keeps npm, pnpm, Yarn, Bun, Deno, aube, and nub versions consistent across developer machines and CI.

```json
{
  "packageManager": "pnpm@11.1.2+sha512.abc123..."
}
```

```sh
pnpm install # jup runs the pinned pnpm version
```

jup is designed as a fast, small, zero-dependency replacement for [Corepack](https://github.com/nodejs/corepack).

## Documentation

Start with the [documentation home page](./docs/index.md), or go directly to:

- [Getting started](./docs/1.getting-started.md)
- [Projects and workspaces](./docs/2.projects-and-workspaces.md)
- [CI and offline use](./docs/3.ci-and-offline.md)
- [Registries and networking](./docs/4.registries-and-networking.md)
- [Command reference](./docs/5.commands.md)
- [Download verification](./docs/6.security.md)
- [Environment variables](./docs/7.settings-reference.md)
- [Migrating from Corepack](./docs/8.corepack-migration.md)
- [Troubleshooting](./docs/9.troubleshooting.md)

## License

[MIT](./LICENSE)
