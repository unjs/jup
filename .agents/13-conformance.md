# 13 — Conformance Test Matrix

Every row is a test a conforming implementation must pass. Derived from the reference
implementation's suite plus the requirements this spec adds. `⊕` marks tests that are
new here (they would fail against corepack today) — see §14/§15 for rationale.

## 13.1 Harness requirements

* Each test runs with a **fresh `COREPACK_HOME`** and a clean environment with every
  `COREPACK_*`, `DEBUG`, and `FORCE_COLOR` variable removed.
* Unless the test is about default-version lookup, set `COREPACK_DEFAULT_TO_LATEST=0`.
* Registry interaction is served by a local mock implementing: `GET /<pkg>`,
  `GET /<pkg>/<version>`, `GET /<pkg>/-/<pkg>-<version>.tgz`, scoped names, dist-tags,
  ECDSA signatures over `<name>@<version>:<integrity>`, `401` on bad auth, and a
  `CONNECT` proxy mode.
* Assertions are on `(exitCode, stdout, stderr)` and on the resulting filesystem.

## 13.2 Spec parsing and discovery

| # | Setup | Command | Expected |
|---|---|---|---|
| 1 | `packageManager: "yarn@1.22.4"` | `yarn --version` | `1.22.4\n`, exit 0 |
| 2 | `packageManager: "yarn"` | `yarn --version` | exit 1, stderr `No version specified for yarn in "packageManager" of package.json\n` |
| 3 | `packageManager: "yarn@stable"` | `yarn --version` | exit 1, stderr contains `expected a semver version` |
| 4 | `packageManager: "yarn@^1.0.0"` | `yarn --version` | exit 1, stderr contains `expected a semver version` |
| 5 | `packageManager: "yarn@"` | `yarn --version` | exit 1, `No version specified` |
| 6 | Manifest in `node_modules/foo` pins pnpm; ancestor pins `yarn@1.22.4` | `yarn --version` from that dir | `1.22.4\n` — vendored manifest ignored |
| 7 | Manifest in `node_modules/@scope/foo` pins pnpm; ancestor pins yarn | `yarn --version` | ancestor wins |
| 8 | `foo/package.json` pins `npm@6.14.2`; root pins `yarn@1.22.4` | `npm --version` in `foo/` | `6.14.2\n` — closest wins |
| 9 | No `package.json` anywhere | `yarn --version` | exit 0, default version |
| 10 | `package.json` is `{}` | `yarn --version` | exit 0, built-in default version |
| 11 | `package.json` contains invalid JSON | `yarn --version` | exit 1, `Invalid package.json in <path>` |
| 12 | `package.json` with a UTF-8 BOM, valid spec | `yarn --version` | parses correctly |
| 13 ⊕ | Same, then `corepack use yarn@1.22.4` | | the BOM is **preserved** in the rewritten file (§14.7) |

## 13.3 Version forms

| # | Reference | Expected |
|---|---|---|
| 14 | `yarn@1.22.4`, `pnpm@4.11.6`, `npm@6.14.2` | resolve exactly |
| 15 | `yarn@2.0.0-rc.30`, `yarn@3.0.0-rc.2`, `pnpm@11.0.0-dev.1005` | prereleases resolve, and match their range band |
| 16 | `+sha1.<40 hex>` and `+sha224.<56 hex>` suffixes | accepted and verified |
| 17 | `yarn@https://…/yarn-1.22.21.tgz` on the CLI, no opt-in | exit 1, `Illegal use of URL for known package manager` |
| 18 | Same with `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1` | resolves to `1.22.21` |
| 19 | `<unknown-name>@https://…tgz` with the opt-in | runs the downloaded package |
| 20 | URL with a `#sha1.<hex>` fragment | hash is verified against the fragment |
| 21 | URL form inside `devEngines.packageManager.version` | exit 1, `The value of devEngines.packageManager.version "…" is not a valid semver range\n` |

## 13.4 `devEngines`

| # | Setup | Expected |
|---|---|---|
| 22 | `{name:"yarn"}`, no `packageManager` | exit 1, `Invalid package manager specification in package.json (yarn@*); expected a semver version\n` |
| 23 | `{name:"pnpm", version:"6.x"}`, no `packageManager` | exit 1, `…(pnpm@6.x); expected a semver version\n` |
| 24 | Same + `packageManager: "pnpm@6.6.2+sha224.…"` | exit 0, `6.6.2\n` |
| 25 | `{name:"pnpm"}` + `packageManager: "pnpm@6.6.2+…"` | exit 0 — no version, no constraint |
| 26 | `version: "yarn@1.x"` (not a range) | exit 1, `The value of devEngines.packageManager.version "yarn@1.x" is not a valid semver range\n` |
| 27 | `devEngines.packageManager` is an array, valid `packageManager` present | exit 0, stderr `! Corepack does not currently support array values for devEngines.packageManager\n` |
| 28 | `devEngines.packageManager` is the string `"pnpm@10.x"` | exit 0, stderr `! Corepack only supports objects as valid value for devEngines.packageManager. The current value ("pnpm@10.x") will be ignored.\n` |
| 29 | `devEngines.packageManager` is the number `10` | exit 0, stderr `…The current value (10) will be ignored.\n` |
| 30 | Name mismatch, `onFail: "ignore"` | exit 0, no output |
| 31 | Name mismatch, `onFail: "warn"` | exit 0, stderr `! Corepack validation warning: "packageManager" field is set to "pnpm@6.6.2+sha1.…" which does not match the "devEngines.packageManager" field set to "yarn"\n` |
| 32 | Name mismatch, `onFail: "error"` | exit 1, same message without the `! Corepack validation warning: ` prefix |
| 33 | Name mismatch, `onFail` omitted | identical to #32 |
| 34 | Version-range mismatch, `onFail: "warn"` | exit 0, `…which does not match the value defined in "devEngines.packageManager" for "pnpm" of "10.x"\n` |
| 35 | Version-range mismatch, no `onFail` | exit 1, same body |
| 36 | Explicit CLI version outside the `devEngines` range (`npm@6.14.2` vs `^10.7.0`) | exit 0, `6.14.2\n` — CLI wins |
| 37 | Conflicting hashes between `packageManager` and `devEngines` | exit 1, `Mismatch hashes. Expected 11111, got …` — `packageManager`'s hash is authoritative |

## 13.5 Environment variables

| # | Setup | Expected |
|---|---|---|
| 38 | `COREPACK_ENABLE_STRICT` unset, project pins npm | `yarn --version` → exit 1, stderr `This project is configured to use npm…` |
| 39 | Project pins `yarn@1.0.0` | `pnpm --version` → exit 1, stderr exactly `This project is configured to use yarn because <abs path>/package.json has a "packageManager" field` |
| 40 | `COREPACK_ENABLE_STRICT=0`, project pins yarn | `pnpm --version` → exit 0, pnpm's default version; `yarn --version` → still `1.0.0` |
| 41 | `COREPACK_ENABLE_PROJECT_SPEC=0`, project pins `yarn@1.0.0` | `yarn --version` → the *default* version, not `1.0.0` |
| 42 | Project pins npm | `yarn dlx --help` → exit 0, empty stderr (transparent command) |
| 43 | `COREPACK_ENABLE_AUTO_PIN=1`, `package.json` is `{}` | after `yarn`, `packageManager` matches `/^yarn@/`; stderr carries the two `!` notices |
| 44 | Same without the variable | `packageManager` is **not** written |
| 45 | `COREPACK_ENABLE_NETWORK=0`, version not cached | exit 1, stderr contains `Network access disabled by the environment` |
| 46 | `COREPACK_ENABLE_DOWNLOAD_PROMPT=1`, project pins `yarn@3.0.0` | stderr exactly `! Corepack is about to download https://repo.yarnpkg.com/3.0.0/packages/yarnpkg-cli/bin/yarn.js\n` |
| 47 | Same, second run (cached) | stderr empty |
| 48 | `COREPACK_ENABLE_DOWNLOAD_PROMPT=1` only in `.corepack.env` | stderr empty — the file cannot set it |
| 49 | `COREPACK_NPM_REGISTRY` + prompt, no project spec | stderr matches `! Corepack is about to download <registry>/yarn/-/yarn-1.x.y.tgz` |
| 50 | Same with `packageManager: yarn@3.0.0-rc.2+sha224.…` | stderr names `<registry>/@yarnpkg/cli-dist/-/cli-dist-3.0.0-rc.2.tgz` |
| 51 | Project pins `npm@6.14.2` | `npm run env` output contains `COREPACK_ROOT=<tool root>` |

## 13.6 Env files

| # | Setup | Expected |
|---|---|---|
| 52 | `.corepack.env` sets `COREPACK_ENABLE_AUTO_PIN=1` | auto-pin happens |
| 53 | Same + real `COREPACK_ENV_FILE=0` | auto-pin does not happen |
| 54 | `.corepack.env` in both root and `subdir`, run from `subdir` | `subdir`'s value wins |
| 55 | `.corepack.env` above the directory containing `package.json` | ignored |
| 56 | `.corepack.env` inside `node_modules/pkg`, run from there | ignored |
| 57 | Real env var and `.corepack.env` both set the same key | real env var wins |
| 58 | `COREPACK_ENV_FILE=.other.env` | `.other.env` is read, `.corepack.env` ignored |
| 59 | `.corepack.env` sets a non-`COREPACK_` key | ignored |
| 60 ⊕ | `.corepack.env` sets `COREPACK_INTEGRITY_KEYS=0` | **ignored** — verification still runs (§14.5) |
| 61 ⊕ | `.corepack.env` sets `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1` | **ignored** (§14.5) |
| 62 ⊕ | `.corepack.env` sets `COREPACK_NPM_TOKEN` | **ignored** (§14.5) |

## 13.7 Registry, auth, integrity

| # | Setup | Expected |
|---|---|---|
| 63 | Default | metadata request is `GET <default registry>/<pkg>` with `Accept: application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8` |
| 64 | `COREPACK_NPM_REGISTRY` with a trailing slash | no doubled slash in the URL |
| 65 | `COREPACK_NPM_TOKEN=foo` | `authorization: Bearer foo` |
| 66 | Token **and** username/password | only the Bearer header |
| 67 | Username + password, no token | `authorization: Basic base64(user:pass)` |
| 68 | Username only | no authorization header |
| 69 | Registry URL with `user:pass@` userinfo | Basic auth sent; userinfo absent from the request line |
| 70 ⊕ | Username/password set, download served from a **different** origin | **no** credentials on that request (§14.6) |
| 71 | `HTTP_PROXY` + a `CONNECT` proxy, registry at `example.com` | request tunnels through the proxy |
| 72 ⊕ | Same **without** `NODE_USE_ENV_PROXY` | still tunnels (§14.8) |
| 73 | Mock signs with an untrusted key | exit 1, stderr contains `No compatible signature found in package metadata` |
| 74 | `COREPACK_INTEGRITY_KEYS` set to the mock's key | success |
| 75 | Mock signs with a mismatched keypair | exit 1, `Signature does not match` — for exact versions, ranges, tags, and no-arg default resolution |
| 76 | Mock serves a tarball inconsistent with its signed integrity | exit 1, `Mismatch hashes. Expected <128 hex>, got <128 hex>` |
| 77 | Explicit `+sha1.deadbeef` pin against a bad-signature mock | fails with **hash** mismatch, not signature |
| 78 | Same with the correct hash | succeeds despite the bad signature |
| 79 | Re-run after any integrity failure | fails identically — nothing was cached |
| 80 | `COREPACK_INTEGRITY_KEYS` = unset / `"0"` / `""` / arbitrary JSON | skip = false / true / true / false |
| 81 | Built-in trust store vs `GET https://registry.npmjs.org/-/npm/v1/keys` | identical (live staleness check) |
| 82 ⊕ | Trust store contains only an expired matching key | exit 1, `The package was signed with an expired key (<keyid>, expired <expires>)` (§14.4) |
| 83 ⊕ | `dist.tarball` points at a host other than the configured registry | refused (§14.9) |
| 84 ⊕ | Tarball entry with a `../` path, an absolute path, or an escaping symlink | refused, `Refusing to extract '<entry>': path escapes the extraction directory` (§07.4) |
| 85 ⊕ | Gzip bomb (implausible expansion ratio) | refused before exhausting disk (§07.4) |

## 13.8 Store, cache, offline

| # | Setup | Expected |
|---|---|---|
| 86 | `corepack install` with `packageManager: yarn@2.2.2` | exit 0, stdout `Adding yarn@2.2.2 to the cache...\n`, stderr empty |
| 87 | Then `COREPACK_ENABLE_NETWORK=0`, `yarn --version` | `2.2.2\n` |
| 88 | Then corrupt `lastKnownGood.json` to `{`, chmod home `0555`, proxies to `0.0.0.0` | `yarn --version` → exit 0, `2.2.2\n`, stderr empty |
| 89 | `corepack install --global yarn@2.2.2` | stdout `Installing yarn@2.2.2...\n`; survives the same read-only/offline treatment |
| 90 | `corepack pack yarn@2.2.2`, fresh empty `COREPACK_HOME`, network off, `install -g corepack.tgz` | exit 0; `yarn --version` → `2.2.2\n` |
| 91 | Same but the new `COREPACK_HOME` directory is deleted first | still works |
| 92 | `corepack pack yarn@2.2.2 pnpm@5.8.0`, hydrate, offline | both resolve |
| 93 | `install -g` with a tarball that is not from `pack` | exit 1, `Invalid archive format; did it get generated by 'corepack pack'?` |
| 94 | Three concurrent `yarn --version` needing the same fresh download | all three exit 0 with identical output |
| 95 | `cache clean`, then `cache clear` | both remove `<home>/v1`; `lastKnownGood.json` survives; second run is a no-op |
| 96 ⊕ | Warm run with an exact pin | **zero** network requests and no `lastKnownGood.json` read (§01.3) |

## 13.9 Default version and last-known-good

| # | Setup | Expected |
|---|---|---|
| 97 | Seed `{yarn: "1.0.0"}`, `COREPACK_DEFAULT_TO_LATEST=1`, project pins `yarn@1.22.4+…` | `1.22.4\n`; LKG becomes `1.22.4` (same major) |
| 98 | Remove `package.json`, re-run | `1.22.4\n` |
| 99 | Project pins `yarn@2.2.2`, run | `2.2.2\n`; LKG **unchanged** (different major) |
| 100 | Remove `package.json`, re-run | `1.22.4\n` |
| 101 | `install -g yarn@1.0.0`, then empty project | `1.0.0\n` — unconditional |
| 102 | `install -g npm@latest-7` | later `npm --version` matches `/^7\./` |
| 103 | `install -g yarn` (bare) | resolves to real latest (not 1/2/3.x) |
| 104 | `COREPACK_DEFAULT_TO_LATEST=1`, empty project, `COREPACK_HOME` deleted mid-run | re-created, still succeeds |

## 13.10 `use` / `up`

| # | Setup | Expected |
|---|---|---|
| 105 | `use yarn@1.22.4` | stdout `Installing yarn@1.22.4 in the project...\n\n` + yarn's own output; pin gets a `+sha512.` suffix |
| 106 | `use` in an empty directory | `package.json` is created |
| 107 | `use` from a subfolder | the ancestor manifest is updated |
| 108 | `use yarn@latest` against the mock | resolves through `@yarnpkg/cli-dist` |
| 109 | `use` with a pre-existing malformed `packageManager` (range / name-only / trailing `@` / non-string) | exit 0, overwritten |
| 110 | `use yarn@1.22.4` with `devEngines` requiring `yarn@2.x` | exit 1; banner **and** `Usage Error:` on stdout; stderr empty |
| 111 | `up` with `packageManager: yarn@2.1.0` | bumps to the highest 2.x (`2.4.3`) |
| 112 | `up` with `yarn@1.1.0` + `devEngines` range `"1.x \|\| 2.x"` | bumps to `2.4.3` — crosses majors |
| 113 | Same with `onFail: "ignore"` | identical |
| 114 | `up` with only `devEngines`, no `packageManager` | a `packageManager` field is created |
| 115 | `up` with a non-semver pin | exit 1, `The 'corepack up' command can only be used when…` |
| 116 | `use`/`up` preserve the manifest's indentation and line endings | tab-indented and CRLF files round-trip unchanged |

## 13.11 `enable` / `disable`

| # | Setup | Expected |
|---|---|---|
| 117 | `enable` with the tool on `PATH` | shims for every non-npm package manager appear beside it; stdout/stderr empty; exit 0 |
| 118 | `enable --install-directory <dir>` | shims land in `<dir>` |
| 119 | `enable --install-directory=<dir> yarn` | only `yarn` and `yarnpkg` |
| 120 | `enable` over a plain pre-existing file (POSIX) | replaced |
| 121 ⊕ | Same, when that file is a real non-shim binary | **refused** with the "was not installed by this tool" message unless `--force` (§14.16) |
| 122 | `enable` twice (POSIX) | symlink mtime unchanged — idempotent |
| 123 | `enable` over a symlink pointing elsewhere | corrected |
| 124 | `enable` over a `/switch/bin/` symlink named `yarn` | exit 0, stderr matches `^yarn is already installed in .+ and points to a Yarn Switch install - skipping\n$`, file untouched |
| 125 | `disable` | shims removed; the tool's own binary and unrelated binaries untouched |
| 126 | `disable --install-directory=<dir> yarn` | removes `yarn` **and** `yarnpkg` only |
| 127 | `disable` over a Yarn Switch symlink (POSIX) | skipped with the same warning |
| 128 | Same on Windows | removed, no warning |
| 129 | `disable` on a directory with no shims | exit 0, no error |
| 130 | `enable <not a package manager>` | exit 1, `Invalid package manager name '<name>'` |
| 131 | Windows `enable` | `<B>`, `<B>.cmd`, `<B>.ps1` all written |

## 13.12 Execution

| # | Setup | Expected |
|---|---|---|
| 132 | Fake package manager sets exit code 42 | tool exits 42 |
| 133 | Sets 42 then throws | exits 1, stderr contains the message |
| 134 | Sets 42 only in a `beforeExit` hook | exits 42 |
| 135 | Entry point is ESM (`"type": "module"` beside it) | runs |
| 136 | `bin` declared as a list (`yarn`, `yarnpkg`) | both names run the same file |
| 137 | `yarn --version` for a real classic yarn | stdout exactly `1.22.4\n` — no decoration |
| 138 ⊕ | Package manager killed by `SIGINT` | tool dies by signal, not a plain exit code (§08.5) |
| 139 ⊕ | `echo x \| <tool> npm <cmd reading stdin>` | stdin passes through intact (§08.6) |
| 140 ⊕ | Package manager writing to a TTY | TTY detection still succeeds (§08.3.2) |
| 141 ⊕ | A downloaded `package.json` declaring `bin: {"yarn": "../../../evil"}` | refused (§08.1, §14.13) |

## 13.13 CLI errors

| # | Command | Expected |
|---|---|---|
| 142 | `install` with no project | `Couldn't find a project in the local directory - please specify the package manager to pack, or run this command from a valid project` |
| 143 | `install` with a project but no spec | `The local project doesn't feature a 'packageManager' field nor a 'devEngines.packageManager' field - …` |
| 144 | Any command resolving an impossible range | `Failed to successfully resolve '<range>' to a valid <name> release` |
| 145 | A tag that does not exist | `Tag not found (<tag>)` |
| 146 | `<tool> --version` | the tool's own version |
| 147 | `<tool> yarn --version` | **yarn's** version — proxy mode shadows the builtin |
