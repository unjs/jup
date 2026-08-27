# 07 — The Store: Layout, Download, Atomicity

## 7.1 Directory resolution

```
homeFolder :=
    COREPACK_HOME
    ?? join(
         XDG_CACHE_HOME
           ?? LOCALAPPDATA
           ?? join(homedir(), platform === "win32" ? "AppData/Local" : ".cache"),
         "jup")

installFolder := join(homeFolder, "v1")
```

Note the order: `XDG_CACHE_HOME` is consulted **before** `LOCALAPPDATA`, which is a
quirk of Corepack's fallback chain rather than design. It is kept because nothing
recommends changing it, not for compatibility — the last segment is `jup`, so a
Corepack cache under `node/corepack` is never read either way (§14.24). §15.13
point 5 narrows the other half of the chain: `LOCALAPPDATA` is consulted **only on
Windows**, where Corepack reads it on POSIX too.

There is no `node/` segment. Corepack has one because it ships inside Node; jup
does not, and the store holds package managers rather than anything Node owns.

`v1` is a layout-version segment. Incrementing it abandons old caches wholesale
rather than migrating them. Keep this mechanism — it is the cheapest possible
migration story, and the move off `node/corepack` is that mechanism applied to the
root instead of the segment below it.

## 7.2 Layout

```
<home>/
├── lastKnownGood.json               # NOT under v1 — survives `cache clean`
└── v1/
    ├── jup-<pid>-<8 hex>/      # transient; temp dirs live here (same FS)
    ├── npm/
    │   └── 11.14.1/
    │       ├── .jup
    │       └── … extracted package, one directory level stripped …
    ├── pnpm/
    │   └── 11.1.2/…
    └── yarn/
        ├── 1.22.22/…
        └── 4.14.1/
            ├── .jup
            └── yarn.js              # single-file download
```

The version directory name is the **plain semver version with the build suffix
removed** (`semverParse(reference).version`). Two references that differ only in
their hash therefore share one directory — which is what makes the hash-mismatch
path safe (a bad artifact never reaches the directory) and the cache probe simple.

For **URL** references the directory name is `encodeURIComponent(url without fragment)`.
This makes the whole URL a single, filesystem-safe path segment.

### The `.jup` marker

```json
{"locator": {"name": "yarn", "reference": "4.14.1+sha224.88b7…"},
 "bin": {"yarn": "./bin/yarn.js"},
 "hash": "sha224.88b7…"}
```

Its presence is the "this install is complete and valid" signal. Reading it is the
entire warm path:

```
try  read <installFolder>/<name>/<version>/.jup, parse
     → { hash, location: installFolder, bin }        ← DONE, no network, no download
catch ENOENT → proceed to download
catch other  → propagate
```

Note `hash` in the marker is the **serialized** form `<algo>.<hexdigest>`, which the
caller re-attaches to the locator as its build suffix (§07.6).

## 7.3 Choosing the URL

```
if the locator is a supported (non-URL) package manager:
    url := spec.url with "{}" replaced by <version>
                     and "{platform}"/"{arch}"/"{target}" resolved (§15.28)
    if COREPACK_NPM_REGISTRY is set:
        registry := spec.artifactRegistry ?? spec.npmRegistry ?? spec.registry
        if registry.type === "npm":
            {tarball, signatures, integrity} := GET {registry}/{package}/{version}
            url := tarball
            if registry.bin: binPath := registry.bin
        url := url with the prefix "https://registry.npmjs.org"
                    replaced by COREPACK_NPM_REGISTRY
else:                                    # URL reference
    url := decodeURIComponent(version)   # the encoded directory name, decoded back
    if COREPACK_NPM_REGISTRY is set and url starts with "https://registry.npmjs.org":
        url := url with that prefix replaced by COREPACK_NPM_REGISTRY
```

The signature/integrity data fetched here is reused by §06.3 rather than re-fetched.

§15.28 — a band declaring `artifactRegistry` uses it in place of `registry` for
**everything on this path and in §06**: the tarball URL, the `dist.integrity`, and the
signature over it. `registry` continues to answer §04's "which versions exist?". The
two differ only when a package manager publishes a launcher package and its real
binaries separately, which is how bun and deno ship (§02.5). An unsupported host fails
in the first line, before any request.

## 7.4 Download and extraction

```
tmp := <installFolder>/jup-<pid>-<random hex>      # MUST be on the same filesystem
stream := GET url                                        # §05
ext := extension of the URL's path component

if ext === ".tgz":
    extract gzip-tar into tmp, stripping ONE leading path component,
    optionally filtering to a single entry (see below)
elif ext === ".js":
    write the bytes to tmp/<basename of URL path>
else:
    (unreachable with the built-in table)
```

Dispatch is on the **URL path's extension**, not on Content-Type. A conforming
implementation MUST do the same, and MUST fail loudly on an unrecognised extension
rather than guessing.

### The `strip: 1` rule

npm tarballs wrap everything in `package/`. Exactly one leading path component is
removed from every entry, so `package/bin/yarn.js` lands at `<tmp>/bin/yarn.js`.
Entries with no leading component are dropped.

### Single-file filter (`binPath` set)

Only the entry whose path — after removing its first segment — equals `binPath` is
extracted. Everything else is skipped. Then:

```
src := tmp/<binPath>            # e.g. tmp/bin/yarn.js
dst := tmp/<basename(binPath)>  # e.g. tmp/yarn.js
rename src → dst
    ENOENT             → Error `Cannot locate '<binPath>' in downloaded tarball`
    EEXIST / ENOTEMPTY → another process raced us; delete src and continue
```

The hash is then computed by **re-reading `dst`**, not from the download stream.

### Extraction safety — NORMATIVE

The reference implementation delegates all of this to its tar library and adds
nothing. A zero-dependency implementation writes its own extractor and therefore
**MUST** enforce all of the following. These are not optional; a tarball is
attacker-controlled input.

1. **Reject absolute paths** (leading `/`, or a Windows drive letter / UNC prefix).
2. **Reject any entry whose normalised path escapes the extraction root** — resolve
   `.` and `..` before use and compare against the root prefix.
3. **Reject or skip symlinks and hardlinks** whose target resolves outside the root.
   Safest posture: skip link entries entirely; the built-in package managers do not
   need them.
4. **Reject entry types other than regular file and directory** (no character
   devices, block devices, FIFOs).
5. **Never follow an existing symlink when creating a file** — open with
   `O_NOFOLLOW`-equivalent semantics, since a prior malicious entry could have
   planted one.
6. **Apply a sane mode mask**: take only the executable bit from the tar header,
   `mode & 0o777 & ~umask`, and never honour setuid/setgid/sticky bits.
7. **Bound the output**: cap total uncompressed bytes and entry count, and reject a
   gzip stream whose expansion ratio is implausible (zip-bomb defence). 512 MiB and
   200 000 entries are generous ceilings for this use case.
8. **Reject a PAX/GNU long-name entry that decodes to a path failing rules 1–2.**
9. Ignore, do not error on, unknown PAX extended headers.

A single tar format subset is enough: ustar with GNU/PAX long-name extensions,
gzip-compressed. No need for sparse files, no need for other compressors.

## 7.5 Atomic promotion

```
write tmp/.jup
mkdir -p dirname(installFolder)
rename tmp → installFolder
```

The rename is the commit point. Because `tmp` was created *inside* the install tree,
it is guaranteed to be on the same filesystem, so the rename is atomic.

### Losing the race

```
on rename failure:
    if EEXIST or ENOTEMPTY
       or (win32 and EPERM and installFolder is a directory):
        # another process installed the same version first — that's fine
        rm -rf tmp
        continue as if we had won
    else:
        propagate
```

This is the entire concurrency story. **There is no lockfile.** Concurrent installs
of the same version are safe because they are content-identical and the loser simply
discards its work. Concurrent installs of *different* versions never collide.

A conforming implementation MUST NOT introduce a lockfile here. It would add a
failure mode (stale locks) to solve a problem the rename already solves, and it
would violate the fast-path budget.

### Windows rename retry

Windows antivirus holds newly-written files open, causing `EPERM`/`ENOENT` on the
rename. Retry up to 5 times with backoff `100 · 2^i` ms (100, 200, 400, 800 ms),
rethrowing on the last attempt.

## 7.6 Post-install

1. Determine the `bin` mapping (§07.7).
2. Verify integrity (§06).
3. Rewrite the locator's reference to carry the *actual* hash:
   `<version without build>+<algo>.<actualHexDigest>`. This is what `use`/`up`
   write into `package.json` and what makes the written pin trustworthy.

   §15.28 — **not** for a per-host band (§02.4), where the digest describes this
   machine's artifact and no other. Committed to `packageManager`, it is a pin no
   other platform can satisfy. The marker written in step 5 still records it, because
   the store is host-local; §15.23's `.jup.lock` records it keyed by host.
4. Auto-bump last-known-good if applicable (§04.7).

## 7.7 Resolving `bin`

```
if the download produced a single file:            # there is no package.json
    if the locator is a known package manager and spec.bin is a non-empty ARRAY:
        bin := spec.bin
    else:
        bin := [locator.name]
else:                                     # extracted tarball
    read tmp/package.json (unreadable or unparseable → treat as declaring nothing):
        packageBin is a string        → bin := { <package name>: packageBin }
        packageBin is a non-empty object → bin := packageBin
        otherwise, if a DECLARED range band covers the version
                   and spec.bin is a non-empty OBJECT
                                      → bin := spec.bin
        otherwise                     → Error `Unable to locate bin in package.json`
```

**The package's own `bin` is the source of truth** (§15.17). An entry point is a
property of the package, not of the tool that downloads it, and by the time this
runs the `package.json` being read has cleared §15.11's verification tier — it is no
more attacker-controlled than the code about to be executed beside it. The values it
yields MUST be confined per §14.13.

The embedded table's `bin` is a **fallback**, and it is authoritative in exactly one
place: a single-file download, which carries no manifest to consult. For a tarball it
is consulted only when the package declares no usable `bin` at all, and only when a
*declared* range band covers the version — the fall-forward guess §02.3 produces for
an uncovered version MUST NOT reach the marker.

Yarn Berry falls out of this: its table entry declares an **array** `bin`
(single-file form), and through a custom npm registry it arrives as a *tarball*, so
the package's own `bin` map is what describes it. The `isValidBinList` /
`isValidBinSpec` discrimination MUST be preserved.

## 7.8 Error tolerance

Filesystem failures around the store are handled with deliberate leniency, because
the tool must keep working in containers, read-only images, and CI sandboxes:

| Situation | Behaviour |
|---|---|
| Temp dir creation hits `EACCES` | `UsageError: Failed to create cache directory. Please ensure the user has write access to the target directory (<target>). If the user's home directory does not exist, create it first.` |
| Home folder cannot be created | Not fatal on the read paths — degrade to no last-known-good |
| `lastKnownGood.json` is corrupt or unreadable | Treated as `{}` (§04.4) |
| `lastKnownGood.json` cannot be written (read-only FS, `EROFS`) | Swallowed; the run continues |
| Cache directory deleted between runs | Recreated on demand |
| Store directory read-only but the needed version is present | Full success, no writes attempted |

The conformance suite exercises exactly this: a read-only `COREPACK_HOME` containing
a truncated `lastKnownGood.json`, with the network unreachable, must still run a
cached package manager successfully and print nothing to stderr.

## 7.9 `cache clean` / `cache clear`

Both names are aliases for one action: `rm -rf <home>/v1`, `force`-style (missing
directory is not an error). `lastKnownGood.json` is **not** removed, so the recorded
default version survives and is simply re-downloaded on next use.

## 7.10 Portable archives (`pack` / `install -g <file>.tgz`)

`pack` produces a gzip tar **rooted at `<home>/v1`** containing one or more complete
`<name>/<version>/` subtrees, `.jup` markers included. It is literally a copy of
cache subtrees, not a repackaging.

Default output path: `./jup.tgz`. `-o/--output` overrides. `--json` prints
`JSON.stringify(outputPath)` to stdout instead of the human-readable log.

`install -g <file>.tgz` validates that the archive came from `pack` before touching
anything:

```
scan entries; consider only those whose LAST path segment is ".jup"
    fewer than 3 segments (i.e. not <name>/<version>/.jup) → hasShortEntries
    otherwise record (segments[0], segments[1]) as (name, reference)
if hasShortEntries or no entries recorded:
    → UsageError `Invalid archive format; did it get generated by 'jup pack'?`
for each (name, reference):
    if not a supported package manager → UsageError `Unsupported package manager '<name>'`
    mkdir -p <installFolder>
    extract only the subtree "<name>/<reference>" into <installFolder>
    unless --cache-only: set as last-known-good
```

> **Note.** This validation guards against *accidentally* passing the wrong tarball.
> It is **not** a security boundary — the archive's contents are extracted with the
> same extractor and therefore the §07.4 safety rules apply in full. A conforming
> implementation MUST NOT relax extraction safety for "our own" archives.
