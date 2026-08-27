# Changelog


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

