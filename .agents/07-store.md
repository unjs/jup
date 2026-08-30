# 07 — The Store: Layout, Download, Atomicity

jup owns exactly one directory. Its concurrency story is a single atomic rename.

## 7.1 Directory resolution

```
home := JUP_HOME
     ?? join(XDG_CACHE_HOME
              ?? (win32 ? LOCALAPPDATA : undefined)
              ?? join(homedir(), win32 ? "AppData/Local" : ".cache"),
             "jup")
installFolder := join(home, "v1")
```

`LOCALAPPDATA` is consulted only on Windows. The root ends in `jup`; there is no
`node/` segment. An explicitly empty `JUP_HOME` is honoured as set.

`v1` is a layout-version segment: incrementing it abandons incompatible caches
rather than migrating them.

## 7.2 Layout

```
<home>/
├── lastKnownGood.json     # global default per tool, plus §04.5's `#stamps` — outside v1
├── keys.json              # refreshed npm trust keys (§06.3) — outside v1
├── shims.json             # entries displaced by `enable --force` (§10.6)
├── self/<version>/        # jup's own copy (§7.11) — outside v1
└── v1/
    ├── jup-<pid>-<hex>/   # transient temp dirs, on the same filesystem
    └── <name>/<reference>/
        ├── .jup           # the marker
        └── … the extracted package, one directory level stripped …
```

The version directory is the **plain semver version with the build suffix
removed**, so two references differing only in their hash share one directory —
which is what makes the hash-mismatch path safe and the cache probe simple. For a
**URL** reference the directory is `encodeURIComponent(url without fragment)`,
making the whole URL one filesystem-safe segment.

### The `.jup` marker

```json
{"locator": {"name": "yarn", "reference": "4.18.0+sha512.…"},
 "bin": {"yarn": "./bin/yarn.js"},
 "hash": "sha512.…"}
```

Its presence means "this install is complete and valid", and reading it is the
entire warm path: `ENOENT` proceeds to download, any other error propagates.
`hash` is the serialised `<algo>.<hexdigest>` form, which the caller re-attaches
to the locator as its build suffix (§7.6).

**Shape validation is required, not optional.** A marker is a file on disk and not
everything that writes one is jup: `cache install -g <archive>.tgz` promotes markers
that arrived inside a tarball (§7.10), and a store directory is a directory like
any other. Two fields are used as more than data — `hash` lands in the user's
committed `packageManager` field, and `bin` names paths §08 executes:

* `hash` must be `<algo>.<digest>`, both parts a narrow character class
  (`[a-z0-9]`) of sane length. Everything jup writes is lowercase hex; the point
  is that no whitespace, quote, newline, `@` or `+` can reach a manifest field.
* `bin`, when present, must be §02.4's `{name: path}` map with string values.

A marker failing either check is treated exactly as a missing one, so the install
is redone and the bad file overwritten. A marker that is not parseable JSON still
propagates: that is a broken install, not an untrusted one.

### Pin-qualified directories

Because the directory name drops the build suffix, `pnpm@9.0.0+sha512.<A>` and
`…+sha512.<B>` would otherwise name one directory and silently share bytes. So
the requested pin is compared against the marker already being read, in constant
time; a mismatch is not a usable cache entry **for that reference**.

Refusing outright would be wrong, because the collision has a legitimate shape:
two projects can pin the same version under different algorithms — a hand-written
`+sha256.…` beside the `sha512` `use` writes — and the mismatch is nobody's
misconfiguration, with no remedy but wiping the cache. Instead the install target
becomes a **pin-qualified** directory, `<version>+<algo>.<hex>` — itself valid
semver, so still a legal `<name>/<reference>` subtree for `pack`, `cache list`
and `info`. The plain directory keeps its name, so nothing about the common case
changes on disk; the cost is one extra marker read, paid only by a reference that
collides.

This is now an **uncommon** path rather than a routine one. The built-in defaults
pin the same `sha512` the registry serves and `use` writes (§02.3), so the
ordinary sequence — a bare `yarn`, then a pinned project — agrees on one
directory. Rare is not never, and the mechanism stays.

Being valid semver has one consequence that is **not** benign: a pin-qualified
directory satisfies any range its bare sibling satisfies, and ties with it. §04.3
therefore requires the range probe to skip entries carrying build metadata. Such a
directory is reachable only through the exact reference that named it.

The comparison is against the marker's *recorded* hash, a statement about bytes
the store does not keep, which is sound for a marker jup wrote after checking the
download — and exactly why §7.10 treats a foreign marker differently.

## 7.3 Choosing the URL

```
supported (non-URL) locator:
    url := spec.url with {} → version and {platform}/{arch}/{target} resolved
    if a registry override is configured:
        registry := artifactRegistry ?? registry
        if npm: GET {registry}/{package}/{version} → use dist.tarball
        apply §05.2's parsed-origin rewrite
URL locator:
    url := decodeURIComponent(the encoded directory name)
    apply the same rewrite when configured
```

An unsupported host fails on the first line, before any request. The
signature/integrity data fetched here is reused by §06 rather than re-fetched.

A band declaring `artifactRegistry` uses it in place of `registry` for
**everything on this path and in §06** — tarball URL, `dist.integrity`, and the
signature over it — while `registry` keeps answering §04's "which versions exist".

## 7.4 Download and extraction

```
tmp := <installFolder>/jup-<pid>-<random hex>     # same filesystem
stream := GET url
.tgz → gunzip + untar into tmp, stripping ONE leading path component
.js  → write the bytes to tmp/<basename of the URL path>
other → fail loudly
```

Dispatch is on the **URL path's extension**, not on Content-Type. Hashing happens
in the same pass (§06.2): one stream, teed to the digest and to the writer.

`strip: 1` exists because npm tarballs wrap everything in `package/`; entries with
no leading component are dropped.

### Extraction safety

A tarball is attacker-controlled input, and jup writes its own extractor. All of
this is required:

1. Reject absolute paths — a leading `/`, a Windows drive letter, a UNC prefix.
2. Reject any entry whose normalised path escapes the extraction root; resolve
   `.` and `..` before comparing against the root prefix.
3. Skip link entries entirely. The built-in tools need no symlinks or hardlinks,
   and skipping is safer than resolving.
4. Reject entry types other than regular file and directory — no devices, no
   FIFOs.
5. **Never follow an existing symlink when creating a file.** Open with
   `O_NOFOLLOW` semantics, or, where there is no such flag (Windows), `O_EXCL`
   plus remove-and-retry. Treating a missing flag as `0` makes the rule hold on
   POSIX and silently not hold elsewhere, and the write then lands wherever the
   link points.
6. **Write a fixed mode, never the header's.** The header contributes exactly one
   bit — whether any of `0o111` is set:

   ```
   file:      (header & 0o111 ? 0o755 : 0o644) & ~umask
   directory: 0o755 & ~umask
   ```

   setuid, setgid and sticky cannot survive this, no archive bit can widen the
   result, and the umask may only narrow it. The ceiling must **not** be
   umask-derived: `0o666`/`0o777 & ~umask` makes every extracted file
   world-writable under `umask 0`, which is the default in many container images
   and CI runners, and §08.2 loads code out of the store with no second hash
   check. The same ceiling governs the store's own directories: staging is
   `0o700` while being filled and widens to `0o755 & ~umask` on promotion, and
   every `mkdir` passes `0o755` rather than taking the `0o777 & ~umask` default.
7. **Bound the output**: cap total uncompressed bytes and entry count and reject
   an implausible expansion ratio (512 MiB and 200 000 entries are generous
   here). The stream cap alone is not enough — a GNU `L`/`K` or PAX `x`/`X` block
   is read whole into memory before anything can inspect it, so a header
   declaring a 500 MB "long name" is an OOM rather than a refusal. Reject a
   metadata body larger than a small fixed bound (64 KiB; `PATH_MAX` is 4 KiB)
   **from the header alone**.
8. Reject a PAX/GNU long name that decodes to a path failing rules 1–2.
9. Ignore, do not error on, unknown PAX extended headers.

One format subset is enough: ustar with GNU/PAX long-name extensions, gzipped.

### The execute bit for native bands

The mode above is a ceiling, not a grant, and a `native` band needs one more
step: after §7.7 has resolved `bin`, each path it names gets `mode | (0o111 &
~umask)`. Some per-host packages publish their binary at 0644 — npm normalises an
extracted file to 0755 only when the package's own `bin` names it, and these
packages declare none — and the publisher's `postinstall` chmods it back, which
jup does not run.

The grant is bounded on every side, and each bound matters:

* only a `native` band — a JavaScript entry point is loaded, not executed;
* only paths in the resolved `bin`, which §08.1 confines to the install and which
  are named by the band or the package manifest, never by a tar header;
* only a file whose first bytes are a **program image** (`#!`, ELF, or one of
  Mach-O's magics). A band whose `bin` path has gone stale and now names a data
  file would otherwise reach `execvp`, which falls back to `/bin/sh` and exits
  127 with the shell's complaint; left alone it is an `EACCES` that names the
  path;
* only `+x`, never setuid/setgid/sticky, and never a write to a file that already
  carries the bit.

It is best effort: a failed chmod does not fail an install, because the execution
error already names the path.

## 7.5 Atomic promotion

```
write tmp/.jup
mkdir -p dirname(target)
rename tmp → <installFolder>/<name>/<reference-directory>
```

The rename is the commit point, and `tmp` is inside the install tree on the same
filesystem, so it is atomic.

**Losing the race** — `EEXIST`, `ENOTEMPTY`, or Windows `EPERM` on an existing
directory — means another process installed the same version first. Remove `tmp`
and continue as if we had won. Anything else propagates.

**There is no lockfile, and none should be added.** Concurrent installs of the
same version are content-identical and the loser discards its work; installs of
different versions never collide. A lock would add stale-lock failures to solve a
problem the rename already solves, and would cost the fast-path budget.

The same rule governs the home-level JSON — `lastKnownGood.json`, `keys.json`
(§04.5, §06.3). Each is replaced by a temp-then-rename in its own directory, so a
reader sees one whole version or another and never a truncated file, which
matters because these readers treat a damaged file as empty and would otherwise
lose a default rather than notice. What the rename does **not** give is a guarded
read-modify-write: two processes recording different tools can interleave, and
the later rename wins. That costs at worst a dropped entry, and the next run
resolves it again — so the mitigation is to read as late as possible rather than
to lock. `recordLastKnownGood` is the one place that write happens for
last-known-good, and it re-reads immediately before writing for that reason.

A directory already present with **no** marker is not a lost race — it is an
incomplete install — and is reported rather than reused or silently overwritten.

**Windows rename retry.** Antivirus holds newly written files open, causing
`EPERM`/`ENOENT` on the rename. Retry up to 5 times with `100 · 2^i` ms backoff,
rethrowing on the last attempt.

## 7.6 Post-install

1. Resolve `bin` (§7.7).
2. Verify integrity (§06).
3. Rewrite the locator's reference to carry the *actual* digest:
   `<version>+<algo>.<hex>`. This is what `use`/`up` write into the manifest and
   what makes the written pin verifiable — **except for a per-host band**, where
   the digest describes this machine's artifact only. The marker still records it
   (the store is host-local) and `jup.lock` records it keyed by host (§04.4).
4. Auto-bump last-known-good if applicable (§04.8).

## 7.7 Resolving `bin`

```
single downloaded file → { locator.name: basename }
extracted tarball      → read tmp/package.json (unreadable → declares nothing):
    bin is a string           → { <package name>: bin }
    bin is a non-empty object → bin
    else, if a DECLARED band covers the version and its spec.bin is a non-empty object
                              → spec.bin
    else                      → "Unable to locate bin in package.json"
```

**The package's own `bin` is the source of truth.** An entry point is a property
of the package, not of the tool that downloads it, and by the time this runs the
`package.json` being read has cleared §06.1's verification tier — it is no more
attacker-controlled than the code about to run beside it. Its values are still
confined by §08.1.

The table's `bin` is the **fallback**, consulted only when the package declares no
usable one, and only when a *declared* band covers the version. The error is
reachable only for an unbanded version or a URL reference with no valid recorded
map; every declared band supplies a usable fallback.

## 7.8 Error tolerance

The store must keep working in containers, read-only images and CI sandboxes:

| Situation | Behaviour |
|---|---|
| Temp dir creation hits `EACCES` | UsageError naming the target and the remedy |
| Home folder cannot be created | not fatal on read paths — degrade to no last-known-good |
| `lastKnownGood.json` / `keys.json` / `jup.lock` corrupt | read as empty |
| Any of those cannot be written | swallowed; the run continues |
| Cache directory deleted between runs | recreated on demand |
| Store read-only but the needed version is present | full success, no writes attempted |

The suite exercises exactly the hard case: a read-only home containing a
truncated `lastKnownGood.json`, with the network unreachable, must still run a
cached package manager and print nothing to stderr.

## 7.9 `cache clean` / `cache clear`

Both names remove cached versions and preserve `lastKnownGood.json`.

If an installed shim names an interpreter inside `<home>/v1`, that version
directory is **preserved** unless `--all` is passed, and removing it with `--all`
warns first — otherwise the clean would leave every shim failing with "bad
interpreter". The interpreter is read from the shims themselves (the shebang of
the stub each links to) and, failing that, from the stub folder of the running
copy; a stub naming an absolute path answers for the set, and the relocatable
spelling is used only when no stub carries anything else.

That backstop is a symptom worth naming: §10.2 bakes an interpreter path into
generated files, and this command has to read those files back to know what it
may delete. If the interpreter pin ever moves into a single state file, this
section gets much smaller.

Output is `Removed <n> cached version(s) from <path>` or `Nothing to remove`; a
failed removal warns by path.

## 7.10 Portable archives (`pack` / `cache install -g <file>.tgz`)

`pack` produces a gzip tar **rooted at `<home>/v1`** containing one or more
complete `<name>/<version>/` subtrees, markers included. It is a copy of cache
subtrees, not a repackaging. Default output `./jup.tgz`; `-o/--output` overrides;
`--json` prints the output path as JSON.

`cache install -g <file>.tgz` validates the archive before touching anything:

```
scan entries whose LAST segment is ".jup"
  fewer than 3 segments → invalid
  else record (segments[0], segments[1]) as (name, reference)
no entries recorded, or any short entry → "Invalid archive format; did it get generated by 'jup pack'?"
each name must be supported, and each segment usable as a path component
extract only the validated "<name>/<reference>" subtrees into the install folder,
  each promoted by §7.5's atomic rename
unless --cache-only: set as last-known-good
```

This validation guards against passing the wrong tarball by accident. It is **not
a security boundary**: the archive is extracted with the same extractor and §7.4
applies in full. Never relax extraction safety for "our own" archives.

A marker produced on another machine is not inherently trusted. During promotion,
re-derive and verify the digest where the artifact bytes are available;
otherwise strip an unattributable `hash`, so the promoted entry is usable only by
an unpinned reference. Do not weaken marker validation to accommodate it.

## 7.11 The self root (`<home>/self`)

`self-install` (§09.12) copies jup itself into:

```
<home>/self/<version>/
├── .jup            # marker; `hash` is over the copied payload
├── package.json    # so §08.7's root walk stops here
├── dist/           # the bundle …
└── bin/            # … and the CLI entry plus the shim stubs
```

`self/` is a **sibling of `v1`, not a child**, and that placement is load-bearing:
the copy it holds is what the shims on `PATH` execute, so a `cache clean` that
reached it would not free a cache entry but uninstall jup. Neither `cache clean`
nor `cache clean --all` may remove it.

The same placement is available to anything else that must outlive a clean, and
one thing uses it: an install script that finds no runtime on the machine
downloads one into `<home>/node`. jup neither creates nor reads that directory,
but it shares the consequence — **a runtime under `<home>` but outside the
install folder is not a store runtime**, `cache clean` cannot take it away, and a
shim may name it (§10.2). Answering that boundary question with "is it under
`<home>`" rather than "is it under the install folder" is what leaves a
bootstrapped machine with shims that all exit 127.

`<home>/node/bin/node` is normally a **hard link** into `v1/node/<version>`, not
a copy. `docs/public/install.sh` downloads `node.default` — no other version, or
the first real command fetches a second one — verifies its npm signature against
§02.6's embedded keys, and promotes it as a §7.2 entry before linking the binary
out. One download serves both the bootstrap and the cache, and the link is what
keeps the paragraph above true: `cache clean` unlinks the store's name and the
inode survives under `<home>/node`. A host that cannot run that check — the sh
half needs openssl, and `install.ps1` cannot run it at all — parks the download
at `<home>/node` alone and leaves the store to jup, because §06.1 is not
negotiable for something the store will hand to a later pinned run.

The marker is §7.2's, with two differences that both follow from nothing having
been downloaded:

* `hash` is a `sha256` digest over the payload — each file's store-relative path,
  its execute bit, and its bytes, in sorted order. It is not a verification;
  nothing signed these files. It answers "are the files in the store already the
  ones I would copy?", which makes a repeated `self-install` free and a rebuilt
  one at the same version actually replace what is there.
* `bin` names the entry point each of jup's own names runs. Nothing resolves jup
  through §04, so the store never executes it; the field is there because a
  marker describing its own directory is what lets promotion read it back.

After a `self-upgrade` (§09.13) `hash` is instead the artifact's own digest, as
everywhere else.

**`self/` holds one copy.** Once the shims name a version, every other version
directory under `self/` is unreferenced, and both commands should delete them
after the shims are installed and verified. Two must not be touched: an entry
whose name is not a version, which is not jup's to interpret, and the copy the
running process was started from — removing it pulls files out from under a live
run and cannot succeed at all on Windows. Removal is best effort and never fails
the command; whatever survives is retried next run.

Replacing an occupied `<home>/self/<version>` renames it aside and deletes it
after promotion, so the window in which the directory does not exist is one
rename long; a failed promotion puts the old directory back. On Windows the
rename can fail outright when a running process holds a file open, and that is
reported with its remedy rather than retried.
