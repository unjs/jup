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
            ├── package.json
            └── bin/
                └── yarn.js          # @yarnpkg/cli-dist, an ordinary tarball
                                     # (a lone yarn.js here, before §15.41)
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

#### Shape validation — NORMATIVE

A marker is a file on disk, and not everything that writes one is this tool:
`install -g <archive>.tgz` promotes markers that arrived inside a tarball (§07.10),
and a store directory is a directory like any other. Two of its fields are then
used as more than data — `hash` is re-attached to the locator and lands in the
**committed** `packageManager` field of the user's `package.json`, and `bin` names
paths §08 resolves and executes.

An implementation therefore **MUST** validate the parsed marker before returning it:

* `hash` is a string of the form `<algo>.<digest>`, both parts restricted to a
  narrow character class (`[a-z0-9]`) and to a sane length. Every digest this tool
  writes is lowercase hex (§06.2); the requirement is that nothing outside that
  grammar — whitespace, quotes, newlines, `@`, `+` — can reach a manifest field.
* `bin`, when present, is §02.4's `{name: path}` map or `[name, …]` list, with
  string values throughout. It is optional (§08.1).

A marker that fails either check **MUST** be treated exactly as a missing one — the
`catch ENOENT` branch above — so the install is redone and the bad file written
over. A marker that is not parseable JSON still propagates: that is a broken
install, not an untrusted one.

#### Pin-qualified directories (§15.11)

The directory name is the plain semver version, so `pnpm@9.0.0+sha512.<A>` and
`pnpm@9.0.0+sha512.<B>` name one directory and the second reference would silently
get whatever the first installed. Corepack behaves the same way — the marker's hash
is *re-attached* to the locator (§07.6 step 3), never compared against it — which is
the one place §15.11's tier is recorded and then not enforced. Enforcing it costs one
string comparison against the marker already being read: no network, no store scan,
no second file.

When the marker does not prove the pin, the entry is not usable for *that* reference,
and there are three possible answers: run the wrong bytes, refuse, or install the
pinned artifact somewhere of its own. Refusing is wrong because the collision has a
legitimate shape — the embedded defaults pin `sha1` (§02.5) while `use` writes the
registry's `sha512`, so a bare `yarn` followed by a `yarn@1.22.22+sha512.…` project
is a mismatch nobody misconfigured, and whose only remedy would be wiping the cache.
So the install target becomes a **pin-qualified** directory,
`<version>+<algo>.<hex>`, itself valid semver and therefore still a legal
`<name>/<reference>` subtree for `pack` (§07.10), `cache list` and `info`. The plain
directory keeps its §07.2 name, so nothing about the common case changes on disk; the
cost is one extra marker read, paid only by a reference that collides.

The comparison is over the marker's own recorded `hash`, which is a *statement* about
the bytes, not a re-derivation from them: the digest covers the downloaded artifact,
which the store does not keep. That is sound for a marker this tool wrote after
checking the download, and it is exactly why §07.10's note below matters.

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
    extract gzip-tar into tmp, stripping ONE leading path component
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

### The single-file filter — removed (§15.41)

A `.tgz` could once be filtered down to one entry, named by `registry.bin`: only the
entry whose post-strip path matched was extracted, it was renamed to its basename,
and the recorded hash came from **re-reading that file** rather than from the
download stream. A missing entry was `Cannot locate '<binPath>' in downloaded
tarball` (§12.8).

It existed so Yarn Berry could arrive as a lone `yarn.js` when a custom npm registry
served `@yarnpkg/cli-dist`. §15.41 made that package the band outright, so nothing
sets `registry.bin`, `NpmRegistrySpec` no longer has the field, and a tarball is
always extracted whole. The error string is gone from §12.

The one remaining non-archive shape is a `.js` URL reference, whose bytes are written
verbatim — so the hashed bytes are always the bytes as received (§06.2).

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
   planted one. "Equivalent" is a requirement, not a hedge: a host with no such
   flag — Windows — MUST substitute `O_EXCL`, which fails on anything already at
   the path, and then remove that entry and retry. Treating a missing flag as
   `0` makes the rule hold on POSIX and silently not hold elsewhere, and the
   write then lands wherever the link points.
6. **Write a fixed mode, not the header's.** The header contributes exactly one
   bit — whether any of `0o111` is set — and nothing else. The mode written is

   ```
   file:       (header & 0o111 ? 0o755 : 0o644) & ~umask
   directory:  0o755 & ~umask
   ```

   That is the whole rule. setuid, setgid and sticky cannot survive it because
   they are not in either base; no bit an archive sets can widen the result;
   and the umask may only *narrow* it. In particular the ceiling **MUST NOT**
   depend on the umask for its upper bound: `0o666`/`0o777 & ~umask` is not a
   conforming implementation of this rule, because under `umask 0` — the
   default in a good many container images and CI runners — it makes every
   extracted file and directory world-writable, and §08.2's warm path loads
   `bin/*.cjs` out of the store with no second hash check.

   The same ceiling governs the directories the store creates for itself
   (§07.5): the staging directory is `0o700` while it is being filled and is
   widened to `0o755 & ~umask` by the rename that publishes it, and every other
   `mkdir` under the store home passes `0o755` rather than taking `mkdir`'s
   `0o777 & ~umask` default.

   The mask is a ceiling, not a grant, and for a `native` band (§15.28) the
   ceiling alone is not enough: the implementation **MUST** additionally set
   `+x` — `mode | (0o111 & ~umask)` — on each path the resolved `bin` names,
   after §7.7 has decided what that is. `@nubjs/nub-<host>` publishes its
   binary at 0644, because npm normalises an extracted file to 0755 only when
   the package's `bin` names it and these per-host packages declare no `bin`;
   the publisher's own `postinstall` chmods it back, and an implementation that
   runs no lifecycle scripts must do it here or cache a file it cannot execute.

   The grant is bounded on every side, and each bound is required:

   * only a `native` band — a JavaScript one is loaded, not executed;
   * only the paths in the resolved `bin`, which are confined to the install by
     §14.13 and named by the band or the package manifest, never by a tar
     header;
   * only a file whose first bytes are a **program image** — `#!`, ELF, or one
     of Mach-O's magics. This bound keeps the grant from destroying information:
     a band whose `bin` path has gone stale and now names a data file would, if
     made executable, reach `execvp`, which falls back to `/bin/sh` and exits
     127 with the shell's complaint. Left alone it is the `EACCES` that §12's
     `cannotExecute` reports with the path in it;
   * only `+x`, never setuid/setgid/sticky, and never a write to a file that
     already carries the bit.

   It is best-effort: a failure to chmod MUST NOT fail an install, because
   `cannotExecute` already names the path if the bit really is missing.
7. **Bound the output**: cap total uncompressed bytes and entry count, and reject a
   gzip stream whose expansion ratio is implausible (zip-bomb defence). 512 MiB and
   200 000 entries are generous ceilings for this use case.

   The cap on the *stream* is not enough on its own. A GNU `L`/`K` block and a
   PAX `x`/`X` block are metadata: they are read whole into memory before
   anything can look at them, so an `L` header declaring a 500 MB "long name"
   costs several times that in resident memory — an OOM kill rather than the
   refusal this rule promises. An implementation **MUST** therefore reject a
   metadata body larger than a small fixed bound (64 KiB; `PATH_MAX` is 4 KiB)
   from the header alone, before reading it.
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
    bin := { locator.name: <basename of the downloaded file> }
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

The embedded table's `bin` is a **fallback**. It is consulted only when the package
declares no usable `bin` at all, and only when a *declared* range band covers the
version — the fall-forward guess §02.3 produces for an uncovered version MUST NOT
reach the marker.

**The single-file branch no longer consults the table at all.** Since §15.41 no band
produces a single file, so the branch is reached only by a URL reference naming a
`.js` (§04.1 step 1), which carries no version and is therefore never banded. The
marker records the **file**; Corepack's `BinList` recorded only the binary names and
left §08.1 to recover the file from the download URL a second time. jup has no such
form to record or read (§02.4).

One consequence: `Unable to locate bin in package.json` is now reachable only for an
unbanded version or a URL reference. Every declared band supplies a usable `BinSpec`
fallback, where Yarn Berry's used to supply an array and so could not.

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

> **Note (open).** "Not a security boundary" and §15.11's "**every** artifact MUST
> clear one of three verification tiers" do not currently meet. The markers in the
> archive are promoted into the store verbatim, and a marker's `hash` is a
> self-assertion (§07.2); the store cannot re-derive it, because the digest covers a
> downloaded artifact the store never keeps. So an archive that asserts the digest a
> later `packageManager` pin names satisfies that pin on a string comparison, and the
> pin's tier is cleared by bytes nothing verified. Extraction safety is unaffected —
> nothing escapes the store — and the user did ask for this archive to be installed,
> which is why this is a note rather than a rule today.
>
> Closing it belongs at the promotion, not in the store: `install -g <file>.tgz`
> should, for each `<name>/<reference>` it promotes, either re-derive the digest of a
> single-file artifact and refuse a marker that disagrees, or drop the `hash` from a
> marker it cannot attribute so the entry is usable only by references that pin
> nothing. Doing it in `readMarker` instead would break `pack` → `install -g`, the
> §15.19 workflow this section exists for: a marker written by *another machine's*
> jup is indistinguishable from one written by an attacker's.
