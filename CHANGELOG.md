# Changelog


## v0.4.0

[compare changes](https://github.com/unjs/jup/compare/v0.3.0...v0.4.0)

### 🚀 Enhancements

- ⚠️  Rename `install` to `cache install`, drop the `upgrade` alias ([924f6c1](https://github.com/unjs/jup/commit/924f6c1))
- Accept `-v` as an alias for `--version` ([e61a1d0](https://github.com/unjs/jup/commit/e61a1d0))
- Answer to corepack's `install` under corepack's name ([9584678](https://github.com/unjs/jup/commit/9584678))

### 🩹 Fixes

- Exempt self-upgrade from the release-age cooldown ([d2ed610](https://github.com/unjs/jup/commit/d2ed610))
- Windows support ([1dcec49](https://github.com/unjs/jup/commit/1dcec49))
- Windows `node` shim exec'ing itself ([3afa857](https://github.com/unjs/jup/commit/3afa857))

### 🤖 CI

- Try setup-jup action ([b4c28c5](https://github.com/unjs/jup/commit/b4c28c5))
- Fix action ([b4dd2d3](https://github.com/unjs/jup/commit/b4dd2d3))

#### ⚠️ Breaking Changes

- ⚠️  Rename `install` to `cache install`, drop the `upgrade` alias ([924f6c1](https://github.com/unjs/jup/commit/924f6c1))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.3.0

[compare changes](https://github.com/unjs/jup/compare/v0.2.0...v0.3.0)

### 🩹 Fixes

- ⚠️  Resolve yarn's global default from @yarnpkg/cli-dist ([ef42774](https://github.com/unjs/jup/commit/ef42774))

#### ⚠️ Breaking Changes

- ⚠️  Resolve yarn's global default from @yarnpkg/cli-dist ([ef42774](https://github.com/unjs/jup/commit/ef42774))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.2.0

[compare changes](https://github.com/unjs/jup/compare/v0.1.0...v0.2.0)

### 🚀 Enhancements

- ⚠️  Announce downloads instead of asking ([b681804](https://github.com/unjs/jup/commit/b681804))
- ⚠️  Up refreshes jup.lock but never creates it ([87e97b9](https://github.com/unjs/jup/commit/87e97b9))
- Better message dx ([cb68f84](https://github.com/unjs/jup/commit/cb68f84))
- ⚠️  Re-check a recorded global default once a day ([a2ccbe1](https://github.com/unjs/jup/commit/a2ccbe1))
- Improve install script ([6144076](https://github.com/unjs/jup/commit/6144076))

### 🏡 Chore

- Refresh table ([e7211b6](https://github.com/unjs/jup/commit/e7211b6))

### ✅ Tests

- Track the refreshed nub default, and assert what the row is about ([7ee101b](https://github.com/unjs/jup/commit/7ee101b))
- Keep the JUP_NODE_EXECPATH row off Windows ([ab5ec07](https://github.com/unjs/jup/commit/ab5ec07))
- Keep a developer's own jup out of the suite ([156e74f](https://github.com/unjs/jup/commit/156e74f))
- Keep the machine's own shims off the suite's PATH ([f0aa3d5](https://github.com/unjs/jup/commit/f0aa3d5))
- Drop the shim directory even when jup manages the runtime ([86c6d65](https://github.com/unjs/jup/commit/86c6d65))

#### ⚠️ Breaking Changes

- ⚠️  Announce downloads instead of asking ([b681804](https://github.com/unjs/jup/commit/b681804))
- ⚠️  Up refreshes jup.lock but never creates it ([87e97b9](https://github.com/unjs/jup/commit/87e97b9))
- ⚠️  Re-check a recorded global default once a day ([a2ccbe1](https://github.com/unjs/jup/commit/a2ccbe1))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.1.0

[compare changes](https://github.com/unjs/jup/compare/v0.0.5...v0.1.0)

### 🚀 Enhancements

- Use colors in logs ([d55f7b9](https://github.com/unjs/jup/commit/d55f7b9))
- ⚠️  Prefer devEngines.packageManager over packageManager ([690cf20](https://github.com/unjs/jup/commit/690cf20))
- ⚠️  `--no-lockfile` and `--no-integrity` ([24b9f77](https://github.com/unjs/jup/commit/24b9f77))
- ⚠️  Documented public api ([4bc9333](https://github.com/unjs/jup/commit/4bc9333))
- ⚠️  New public api ([1c5add9](https://github.com/unjs/jup/commit/1c5add9))

### 🔥 Performance

- **test:** Give the spawned tools a compile cache of our own ([a705ec5](https://github.com/unjs/jup/commit/a705ec5))

### 🩹 Fixes

- Improve installer ([20fbfc0](https://github.com/unjs/jup/commit/20fbfc0))
- Link posix shims to per-name stubs ([df6717d](https://github.com/unjs/jup/commit/df6717d))
- Name the release to pin when a band outruns its npm package (§04.1) ([2c4ad8f](https://github.com/unjs/jup/commit/2c4ad8f))
- Keep a `__proto__` env-file key, as `parseEnv` now does ([a7b2d14](https://github.com/unjs/jup/commit/a7b2d14))

### 💅 Refactors

- ⚠️  Simplify ([b4f28c5](https://github.com/unjs/jup/commit/b4f28c5))

### 📖 Documentation

- Rewrite ([ee6e691](https://github.com/unjs/jup/commit/ee6e691))

### 🏡 Chore

- Rewrite agents docs ([7811b13](https://github.com/unjs/jup/commit/7811b13))
- Update citations ([7bb9d57](https://github.com/unjs/jup/commit/7bb9d57))
- Update docs ([29136a2](https://github.com/unjs/jup/commit/29136a2))

### ✅ Tests

- **corepack:** Re-port the Berry fixtures §15.41 and §07.2 moved ([87939fa](https://github.com/unjs/jup/commit/87939fa))
- Exclude `__proto__` from the env differential, whose fate is Node's ([ac72cfa](https://github.com/unjs/jup/commit/ac72cfa))
- Hold Windows to §10.3's unconditional rewrite, not §10.2's mtime ([0cfcbca](https://github.com/unjs/jup/commit/0cfcbca))
- Gate the native pnpm default off Windows' fake path ([46ce163](https://github.com/unjs/jup/commit/46ce163))
- Skip the Corepack rows §03.3 and §03.7 diverge from ([7516b88](https://github.com/unjs/jup/commit/7516b88))

#### ⚠️ Breaking Changes

- ⚠️  Prefer devEngines.packageManager over packageManager ([690cf20](https://github.com/unjs/jup/commit/690cf20))
- ⚠️  `--no-lockfile` and `--no-integrity` ([24b9f77](https://github.com/unjs/jup/commit/24b9f77))
- ⚠️  Documented public api ([4bc9333](https://github.com/unjs/jup/commit/4bc9333))
- ⚠️  New public api ([1c5add9](https://github.com/unjs/jup/commit/1c5add9))
- ⚠️  Simplify ([b4f28c5](https://github.com/unjs/jup/commit/b4f28c5))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.5

[compare changes](https://github.com/unjs/jup/compare/v0.0.4...v0.0.5)

### 🚀 Enhancements

- Add --system, and let root reach /usr/local/bin ([b67ad16](https://github.com/unjs/jup/commit/b67ad16))
- Improve dist ([bf7578e](https://github.com/unjs/jup/commit/bf7578e))
- Better install method ([a4bd5ad](https://github.com/unjs/jup/commit/a4bd5ad))

### 🩹 Fixes

- Make CI-failing rows portable ([5367f8d](https://github.com/unjs/jup/commit/5367f8d))
- Spell Bun's virtual root per platform in the binary-root row ([e12dd5d](https://github.com/unjs/jup/commit/e12dd5d))
- Pack with `xz -T1` so it stops warning about threads it cannot use ([c09298c](https://github.com/unjs/jup/commit/c09298c))

### 📖 Documentation

- Add experimental note ([d24abc7](https://github.com/unjs/jup/commit/d24abc7))
- Add native install instructions ([f4223b1](https://github.com/unjs/jup/commit/f4223b1))

### 🏡 Chore

- Compact comments ([2966e93](https://github.com/unjs/jup/commit/2966e93))
- Compact agents docs ([70e9640](https://github.com/unjs/jup/commit/70e9640))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.4

[compare changes](https://github.com/unjs/jup/compare/v0.0.3...v0.0.4)

### 📦 Build

- Minify ([52360e7](https://github.com/unjs/jup/commit/52360e7))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.3

[compare changes](https://github.com/unjs/jup/compare/v0.0.2...v0.0.3)

### 🚀 Enhancements

- Record range resolutions in jup.lock, and fix the review's findings ([dd8ab17](https://github.com/unjs/jup/commit/dd8ab17))

### 🩹 Fixes

- Never bake a shim interpreter that lives inside the store ([cc7753d](https://github.com/unjs/jup/commit/cc7753d))
- Cache clean spares the version the shims run on ([f6dfe35](https://github.com/unjs/jup/commit/f6dfe35))
- Enable guarantees the stub it links to is executable ([1f0e03e](https://github.com/unjs/jup/commit/1f0e03e))
- Pin the interpreter into jup's own CLI entry ([f7c47f3](https://github.com/unjs/jup/commit/f7c47f3))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.2

[compare changes](https://github.com/unjs/jup/compare/v0.0.1...v0.0.2)

### 🚀 Enhancements

- Node@lts resolves from a compiled-in table constant (§15.42) ([d5f80e9](https://github.com/unjs/jup/commit/d5f80e9))
- Prefer a per-user directory that is already on PATH (§15.13) ([32015fc](https://github.com/unjs/jup/commit/32015fc))

### 🔥 Performance

- EnableCompileCache ([6d42288](https://github.com/unjs/jup/commit/6d42288))
- Run §15.13's selection once, and pay for point 7's scan (§16.3) ([ae75df8](https://github.com/unjs/jup/commit/ae75df8))
- Name the emitted shim stubs `.mjs` (§14.27) ([749af99](https://github.com/unjs/jup/commit/749af99))

### 🩹 Fixes

- Narrow the semver version prefix and the x-range grammar ([c30d711](https://github.com/unjs/jup/commit/c30d711))
- Parse the rewritten manifest before handing it to writeFileSync ([d84f099](https://github.com/unjs/jup/commit/d84f099))
- Write package.json atomically when pinning ([19f8dfb](https://github.com/unjs/jup/commit/19f8dfb))
- Deny the three location variables in a project env file (§14.5) ([b4e4214](https://github.com/unjs/jup/commit/b4e4214))
- Stop the env-file search at the project boundary (§03.2) ([43c10db](https://github.com/unjs/jup/commit/43c10db))
- Refuse a spec whose name cannot be a store directory (§03.4, §07.2) ([679c2a5](https://github.com/unjs/jup/commit/679c2a5))
- Validate the marker's shape before trusting it (§07.2) ([d666611](https://github.com/unjs/jup/commit/d666611))
- Give the extractor and the store a fixed mode ceiling (§07.4 rule 6) ([780902e](https://github.com/unjs/jup/commit/780902e))
- Bound a GNU/PAX metadata block before reading it (§07.4 rule 7) ([2ca0eff](https://github.com/unjs/jup/commit/2ca0eff))
- Cap the bodies http reads into memory ([22be38c](https://github.com/unjs/jup/commit/22be38c))
- Refuse ${VAR} expansion in a project-level .npmrc (§15.1) ([e8c09f8](https://github.com/unjs/jup/commit/e8c09f8))
- Do not hand a credential to a registry the repository chose (§14.6) ([1fb72ed](https://github.com/unjs/jup/commit/1fb72ed))
- Promote the shim directory only when it holds a shim of ours (§15.32) ([58df88f](https://github.com/unjs/jup/commit/58df88f))
- Harden enable's writability probe and disable's displaced record ([6a0de72](https://github.com/unjs/jup/commit/6a0de72))
- Bake the interpreter path into the shims enable writes (§10.1, §10.3) ([a2f97ee](https://github.com/unjs/jup/commit/a2f97ee))
- Fetch every tool from the npm registry, Yarn included (§15.41) ([3e49289](https://github.com/unjs/jup/commit/3e49289))
- Stop the credential gate at the environment tier (§15.1, §15.38/149) ([4afd8dc](https://github.com/unjs/jup/commit/4afd8dc))
- **test:** Hand `--import` a URL, not a Windows path ([196b144](https://github.com/unjs/jup/commit/196b144))
- **shims:** Never write a Windows wrapper through a symlink (§10.3) ([5c3e065](https://github.com/unjs/jup/commit/5c3e065))
- **store:** §07.4 rule 5 held on POSIX and nowhere else ([fcef33f](https://github.com/unjs/jup/commit/fcef33f))
- **info:** §15.30 reported npm's own `npm.cmd` as a shim of ours ([0f2298c](https://github.com/unjs/jup/commit/0f2298c))
- Fall back to the ordinary member write when a sidecar pin has no digest ([91a6807](https://github.com/unjs/jup/commit/91a6807))
- Complete §14.27's rename in the ownership test `enable` actually calls ([13350ca](https://github.com/unjs/jup/commit/13350ca))
- Require proof of a completed install before promote discards its own bytes ([ce75084](https://github.com/unjs/jup/commit/ce75084))
- Re-run §15.11's probe after a lost rename race ([e735427](https://github.com/unjs/jup/commit/e735427))
- Case-fold only the host of an .npmrc auth prefix ([6e15d86](https://github.com/unjs/jup/commit/6e15d86))
- Percent-decode URL userinfo before it becomes a Basic credential ([28ad7d1](https://github.com/unjs/jup/commit/28ad7d1))
- Report the pin string the manifest actually holds ([7dfbc53](https://github.com/unjs/jup/commit/7dfbc53))
- Let `info` stop where the real walk stops ([e84943d](https://github.com/unjs/jup/commit/e84943d))
- Apply §15.39's runtime refusal in `info`, as every other reader does ([e495a02](https://github.com/unjs/jup/commit/e495a02))
- Edit the duplicate key that readers actually resolve to ([ee2ee7c](https://github.com/unjs/jup/commit/ee2ee7c))
- Check `bin` values, not just the container, before using them ([c4637b9](https://github.com/unjs/jup/commit/c4637b9))
- Actually honour a `Retry-After` longer than the cap ([e63d597](https://github.com/unjs/jup/commit/e63d597))
- Let an .npmrc auth pair outrank a token from a lower-precedence file ([ae3fce8](https://github.com/unjs/jup/commit/ae3fce8))
- Propagate a socket failure into the decompressor ([a1fd6ae](https://github.com/unjs/jup/commit/a1fd6ae))
- Read the ustar `prefix` field only from a ustar header ([715ce87](https://github.com/unjs/jup/commit/715ce87))
- Let the shim-directory lookup see a dangling shim ([892dd9d](https://github.com/unjs/jup/commit/892dd9d))
- Return the bin path that was actually validated ([568a387](https://github.com/unjs/jup/commit/568a387))
- Read an indented `#` after a comment line as a key, like `parseEnv` does ([3570c6e](https://github.com/unjs/jup/commit/3570c6e))
- Keep a pin digest and a root manifest path inside their own bounds ([7760fb9](https://github.com/unjs/jup/commit/7760fb9))

### 💅 Refactors

- Drop the deprecated PackageManager* type aliases ([43b243e](https://github.com/unjs/jup/commit/43b243e))
- Drop the bin-list read path, jup's only self-compat carve-out ([bb38e37](https://github.com/unjs/jup/commit/bb38e37))
- Keep the warm chunk inside §16.3's byte ceiling ([ac5a772](https://github.com/unjs/jup/commit/ac5a772))

### 📖 Documentation

- Move §15.11's pin-qualified reasoning into the spec ([3e5090e](https://github.com/unjs/jup/commit/3e5090e))
- Move §10.3's bodies onto the baked interpreter path (§14.26) ([6398c74](https://github.com/unjs/jup/commit/6398c74))
- §14.27's numbers, measured against the shipped layout ([daac1d8](https://github.com/unjs/jup/commit/daac1d8))

### 🏡 Chore

- Update release script ([dc8552e](https://github.com/unjs/jup/commit/dc8552e))

### ✅ Tests

- Give §15.32's fixture shims the banner the promotion reads (§14.16) ([662fd8a](https://github.com/unjs/jup/commit/662fd8a))
- Park §15.15's fixture backup where `displace` actually puts it ([902a133](https://github.com/unjs/jup/commit/902a133))
- Raise the warm chunk ceiling to 256,000 for ten commits of hardening ([a215d7e](https://github.com/unjs/jup/commit/a215d7e))
- Resolve the temp root, so macOS's symlinked $TMPDIR stops failing ([60e5fea](https://github.com/unjs/jup/commit/60e5fea))
- Redirect the per-user shim directory the way each platform spells it ([1d6d8ff](https://github.com/unjs/jup/commit/1d6d8ff))
- Stop the fixtures assuming POSIX where the platform decides ([f30a748](https://github.com/unjs/jup/commit/f30a748))
- The last six — PATHEXT's spelling, `{exe}`'s source, and a 5 s timeout ([e9853ab](https://github.com/unjs/jup/commit/e9853ab))

### 🤖 CI

- Run the suite on Linux, Windows and macOS ([539a8d2](https://github.com/unjs/jup/commit/539a8d2))
- Let the Windows leg report without blocking ([0fd71dc](https://github.com/unjs/jup/commit/0fd71dc))
- Windows blocks again ([1f36539](https://github.com/unjs/jup/commit/1f36539))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

## v0.0.1


### 🚀 Enhancements

- **env:** One table of variable names, each with a JUP_ spelling ([4c2a861](https://github.com/unjs/jup/commit/4c2a861))
- **env:** COREPACK_QUIET_ADVISORIES silences the notices jup adds ([350a87c](https://github.com/unjs/jup/commit/350a87c))
- **lockfile:** The resolution file is .jup.lock, not .corepack.lock ([edf5bea](https://github.com/unjs/jup/commit/edf5bea))
- The tool names itself in its own messages ([d17c018](https://github.com/unjs/jup/commit/d17c018))
- The tool names itself on disk, not just in its messages ([d52e349](https://github.com/unjs/jup/commit/d52e349))
- Bun and deno, the first per-host entries in the table ([a6ab1f7](https://github.com/unjs/jup/commit/a6ab1f7))
- Aube, and the libc half of the host name it needed ([299a4fb](https://github.com/unjs/jup/commit/299a4fb))
- Nub, and the executable bit its artifacts do not carry ([716ef12](https://github.com/unjs/jup/commit/716ef12))
- Bump versions ([24dbf26](https://github.com/unjs/jup/commit/24dbf26))
- Manage tools, not only package managers ([80c61fb](https://github.com/unjs/jup/commit/80c61fb))
- Node, and the four places its kind is read ([eb9008c](https://github.com/unjs/jup/commit/eb9008c))
- Read the version file the ecosystem already writes ([abdc382](https://github.com/unjs/jup/commit/abdc382))
- One shim stub for every name, dispatching on argv[1] ([8348711](https://github.com/unjs/jup/commit/8348711))

### 🔥 Performance

- Ship the warm path as one chunk, and load resolve.ts lazily ([51c9e10](https://github.com/unjs/jup/commit/51c9e10))
- Parse .corepack.env ourselves, and split the manifest rewriter ([b626590](https://github.com/unjs/jup/commit/b626590))

### 🩹 Fixes

- **exec:** Hand over with Module.runMain so require.main is set ([c8acf34](https://github.com/unjs/jup/commit/c8acf34))
- **exec:** Write process.exitCode only to report a failure ([c766eb7](https://github.com/unjs/jup/commit/c766eb7))
- **integrity:** Verify on whatever curve the trusted key declares ([4c20f07](https://github.com/unjs/jup/commit/4c20f07))
- **store:** Read bin from the package, not the range band ([2b80f1e](https://github.com/unjs/jup/commit/2b80f1e))
- Four portability and compatibility defects ([9ecd765](https://github.com/unjs/jup/commit/9ecd765))
- Three test literals the last two commits left behind ([1b4b3ec](https://github.com/unjs/jup/commit/1b4b3ec))
- Keep the machine's own .npmrc out of the key fetch and the report ([fc4f04e](https://github.com/unjs/jup/commit/fc4f04e))

### 💅 Refactors

- Group src/ by spec section ([6f7a61e](https://github.com/unjs/jup/commit/6f7a61e))
- Four duplicated answers, down to one each ([f35212e](https://github.com/unjs/jup/commit/f35212e))

### 📖 Documentation

- Initial README ([3600319](https://github.com/unjs/jup/commit/3600319))
- README reflects a working tool ([83d0b0b](https://github.com/unjs/jup/commit/83d0b0b))
- README reflects a complete, audited phase 1 ([bcfbdfd](https://github.com/unjs/jup/commit/bcfbdfd))
- Merge the .npmrc and defect-cluster sections into the README ([7e355a0](https://github.com/unjs/jup/commit/7e355a0))
- Native package managers, and honest warm-path numbers ([0f268d2](https://github.com/unjs/jup/commit/0f268d2))
- The verification tier, the cache-hit check, and --pin-style ([1cd6954](https://github.com/unjs/jup/commit/1cd6954))
- Final stats — 9 ms of our own work, against corepack's 32 ([fed9e24](https://github.com/unjs/jup/commit/fed9e24))
- Say what the §15 audit actually found, not what the plan claimed ([44feaf6](https://github.com/unjs/jup/commit/44feaf6))
- §15.31 and §15.32 landed ([f3a5943](https://github.com/unjs/jup/commit/f3a5943))
- Update ([4398a30](https://github.com/unjs/jup/commit/4398a30))
- Put the standing hazards where they are read ([d0e8cc7](https://github.com/unjs/jup/commit/d0e8cc7))
- The consent blocker where someone will meet it ([d48fd62](https://github.com/unjs/jup/commit/d48fd62))

### 📦 Build

- Improve chunk names ([d25523c](https://github.com/unjs/jup/commit/d25523c))

### 🏡 Chore

- Point repository metadata at pithings/pipack ([e2390ad](https://github.com/unjs/jup/commit/e2390ad))
- Correct the repository slug to pithings/jup ([e8670ac](https://github.com/unjs/jup/commit/e8670ac))
- Rename the package from pipack to jup ([7bbeb80](https://github.com/unjs/jup/commit/7bbeb80))
- Init docs ([e3868db](https://github.com/unjs/jup/commit/e3868db))
- Update undocs ([719cadc](https://github.com/unjs/jup/commit/719cadc))
- Cleanup todos ([6e57a8a](https://github.com/unjs/jup/commit/6e57a8a))
- Update docs ([b1d84f7](https://github.com/unjs/jup/commit/b1d84f7))

### ✅ Tests

- Assert four §15.38 rows, and make the group-signal row deterministic ([db2c945](https://github.com/unjs/jup/commit/db2c945))
- Add corepack tests ([b488eea](https://github.com/unjs/jup/commit/b488eea))
- **corepack:** Skip the deliberate divergences, with a reason each ([1496262](https://github.com/unjs/jup/commit/1496262))
- Present a certificate that is actually out of date ([5855e31](https://github.com/unjs/jup/commit/5855e31))

### ❤️ Contributors

- Pooya Parsa ([@pi0](https://github.com/pi0))

