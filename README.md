# jup

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/jup?color=yellow)](https://npmjs.com/package/jup)
[![npm downloads](https://img.shields.io/npm/dm/jup?color=yellow)](https://npm.chart.dev/jup)

<!-- /automd -->

jup runs the package manager version your project asks for.

It reads the pin in `package.json`, downloads and verifies the requested version, saves it in a local cache, and runs it. This keeps npm, pnpm, and Yarn versions consistent across developer machines and CI.

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

- [Getting started](./docs/1.getting-started.md)
- [Project pins](./docs/2.project-pins.md)
- [Commands](./docs/3.commands.md)
- [Cache, offline use, and security](./docs/4.cache-and-security.md)
- [Configuration](./docs/5.configuration.md)
- [Corepack compatibility](./docs/6.corepack-compatibility.md)
- [Troubleshooting](./docs/7.troubleshooting.md)

See the [documentation home page](./docs/index.md) for the complete guide.

## License

[MIT](./LICENSE)
