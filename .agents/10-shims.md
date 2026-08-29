# 10 — Shims & PATH Integration

`enable` puts the tool's names on `PATH`; `disable` takes them off. Everything else in
these rules assume `enable` has already run (or that the user types the tool's name
explicitly).

## 10.1 What a shim must do

A shim for binary `B` must invoke the tool as if the user had typed
`<tool> B <args…>`, and must set the download-prompt default to `1` (§05.5) because
the user asked for `B`, not for a download.

On POSIX, every name points to one executable proxy stub. The stub resolves the
jup entry point from the stub's own realpath and dispatches from the name used to
invoke it. It sets the download-prompt default to `1` for a known binary name and to
`0` for jup's own name. The explicit `<tool> <binary>` form remains available.

Windows wrappers preserve the binary name explicitly because their runtime does not
receive the wrapper's invocation name. Every generated stub and wrapper has mode
`0755`.

### Baking in the interpreter

> **Requirement.** Wherever a shim names the interpreter as a bare `node`,
> a conforming implementation MUST instead name it by **absolute path**: the
> `realpath` of the runtime executing `enable`, resolved at `enable` time. This
> covers the Windows wrappers, conditionally the POSIX stub's shebang, and under the
> same condition the tool's own CLI entry. A bare name is unsafe because `cmd.exe`
> searches the current directory and `#!/usr/bin/env node` re-searches `PATH`. If the
> shim directory claims `node`, either lookup can recurse into the shim.
>
> `realpath`, because `process.execPath` is frequently a symlink into a version
> manager's store and the point of baking a path in is that it names one file rather
> than whatever a lookup would answer later.
>
> **When it applies.** Windows always bakes it in. POSIX bakes it into the shared
> stub's shebang only when the install directory claims the interpreter's own name —
> either this run enables `node`, or an earlier one already installed a shim of ours
> at that name. Otherwise the stub keeps `#!/usr/bin/env node`, so the shipped stubs
> stay relocatable and §10.7's read-only stub folder is not rewritten for a user who
> never asked for a `node` shim. A *foreign* `node` in the directory does not count.
>
> **The stub's condition governs the tool's own CLI entry on every platform** — the
> file named by `package.json`'s `bin`, which need not sit in the stub folder.
> Windows's unconditional rule applies only to generated wrappers. When pinning is
> required, read the entry and replace only its first line if needed. Write a
> temporary file in **the entry's own directory**, preserve the entry's mode, and
> atomically rename it over the entry. If no built entry exists, do nothing — a
> source checkout is not an installation, and pinning one would leave an absolute
> shebang in a tracked file. On `EROFS`, `EACCES`, or `EPERM`, fail before writing any shims and
> name the entry and the remedies: install the tool somewhere writable or stop
> claiming the runtime name. `disable` MUST NOT restore the old shebang or otherwise
> modify the entry.
>
> The `%~dp0\node.exe` and `$basedir/node` branches are kept: they cost nothing, and
> they are what keeps a shim directory that *is* the Node install directory
> relocatable.

> **Which runtime.** "The runtime executing `enable`" is not always a
> runtime `enable` may name. `node` is a table entry, so once `enable node`
> has claimed that name on the prepended shim directory on `PATH`, the tool's own
> entry point resolves through the shim, downloads the project's runtime and runs
> under it — and `process.execPath` is then a path inside `<home>`, which
> `cache clean` (§09.7) exists to delete. An implementation MUST NOT bake in an
> interpreter that lies inside its own home directory. It selects one in this order:
>
> 1. `realpath(process.execPath)`, when that is **not** inside `<home>`.
> 2. The forwarded host runtime — the value of `COREPACK_HOST_RUNTIME` (§11.5),
>    which a run outside `<home>` writes into the environment of every native child
>    it spawns (§08.3). It is used only when it names an executable file
>    that is neither inside `<home>` nor a shim of this tool's own.
> 3. The first `node` on `PATH` that is neither inside `<home>` nor one of this
>    tool's shims, resolved through `realpath`.
>
> If none of the three yields a runtime, `enable` MUST **fail** and write nothing.
> The message names the runtime it found, names `<home>`, and says that baking it
> in would break every shim at the next `cache clean`. It MUST NOT fall back to
> `#!/usr/bin/env node`, which is the exec loop above, and it MUST NOT bake the
> store path, which is the failure this rule exists to prevent.
>
> The "is inside `<home>`" test is a path-boundary test on resolved paths, not a
> string prefix: a `<home>` of `~/.cache/jup` does not contain `~/.cache/jupiter`.

## 10.2 POSIX shim creation

```
generatePosixLink(installDirectory, stubFolder, binName):
    file    := installDirectory/binName
    target  := RELATIVE path from installDirectory to stubFolder/<proxy stub>
    st      := lstat(file)                     # lstat, NOT stat — must not follow

    if st exists:
        if st is a symlink:
            if binName contains "yarn" and realpath(file) matches /[\/\\]switch[\/\\]bin[\/\\]/:
                stderr: `<binName> is already installed in <file> and points to a
                         Yarn Switch install - skipping`
                return                                    # exit 0, leave it alone
            if readlink(file) === target:
                return                                    # already correct — no write
        if entry is not jup-owned and not --force:
            print the foreign-entry message and return
        if entry is not jup-owned:
            atomically back up and record it in <home>/shims.json
        unlink(file)

    symlink(target, file)
```

`<proxy stub>` is **one file for every binary name**: it carries no name of
its own and reads the one it was invoked under from `argv[1]`. An implementation MUST
NOT make the target depend on `binName` — that is what leaves a per-name file behind
to go stale when the tool is upgraded or removed.

Required properties:

1. **`lstat`, not `stat`.** A dangling symlink must be detected as a symlink, not as
   a missing file.
2. **The link target is relative.** So the whole installation tree stays relocatable.
   This is why the install directory is `realpath`'d first (§10.4) — a relative path
   computed from a symlinked directory would be wrong.
3. **Idempotent.** An already-correct symlink is not rewritten; its mtime is
   unchanged across repeated `enable` runs. The conformance suite asserts this.
4. **The stub is written at most once per `enable`**, whatever the number of names,
   and not at all when it is already current — so `enable` still succeeds against a
   read-only stub folder that shipped it (§10.7).
5. **The stub is executable when `enable` returns.** A symlink carries no mode of
   its own, so the bit the kernel checks is the stub's; a shim pointing at a
   non-executable stub is skipped by the `PATH` lookup without a word. `enable`
   therefore tests the stub it links to for executability and `chmod`s it `0755`
   only when it is not executable — **only** then, so property 4's "writes nothing"
   still holds for the ordinary warm run. §10.7 defines the failure when `chmod` is refused.

Before replacing an entry, `enable` MUST establish that it is a jup-owned shim. A
POSIX entry is owned only when it points to jup's proxy stub. A Windows entry is
owned only when its complete generated contents or native executable identity match
jup's shim format. A dangling jup link remains owned; a name or file extension alone
is never proof of ownership.

Without `--force`, `enable` MUST leave a foreign entry unchanged and print exactly:
`<binName> already exists at <file> and was not installed by this tool - skipping (use --force to overwrite)`

With `--force`, `enable` MUST move every displaced entry to a private backup under
`<home>` and record its path, type, mode, backup path, and symlink target when
applicable in `<home>/shims.json` before installing the shim. The record and backup
write MUST complete atomically before replacement. Existing unresolved records MUST
NOT be overwritten.

### Yarn Switch

"Yarn Switch" installs a `yarn` binary whose realpath contains `…/switch/bin/…`.
Both `enable` and `disable` refuse to touch such an entry, warn, and exit 0. The
check applies to any binary name containing the substring `yarn` (so `yarnpkg` too).
POSIX only — on Windows the check is not performed and `disable` removes the files.

## 10.3 Windows shim creation

Windows has no usable symlink story for this purpose (it needs elevation or developer
mode), so write the shell, cmd.exe, and PowerShell wrappers shown below for each
binary name:

| File | Purpose |
|---|---|
| `<B>` (no extension) | sh script, for Git Bash / MSYS / Cygwin |
| `<B>.cmd` | cmd.exe |
| `<B>.ps1` | PowerShell |

Create every listed wrapper unconditionally (the generator is invoked with
`createCmdFile: true` so Windows shims can be produced from a POSIX build machine),
set mode `0o755`, and overwrite unconditionally — there is no idempotency
short-circuit on Windows.

Each existing entry MUST be **removed** before its replacement is written, never
written through. The ownership and `--force` rules decide whether the name may be
taken, so what reaches the write is one of our own entries — or any entry under
`--force` — and one of ours can be a symlink left by an earlier POSIX-style
`enable`, or pointing at a stub folder that no longer exists. A write that
follows the link edits the link's target instead of replacing the shim, and
fails with `ENOENT` when that target is gone.

Let `<rel>` be the path from the shim directory to the per-name stub for `B`,
backslash-separated for `.cmd` and forward-slash-separated for the other two.

Let `<node>` be the **absolute** path of the runtime `enable` is itself running
under, `realpath`'d — see §10.1's *Baking in the interpreter*. Windows always bakes
it in. It is forward-slash-separated in the sh body, which is the spelling Git Bash
and MSYS accept for a Windows path, and left as-is in the other two.

**`<B>.cmd`**
```bat
@SETLOCAL
@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\<rel>" %*
) ELSE (
  @SET PATHEXT=%PATHEXT:;.JS;=;%
  "<node>"  "%~dp0\<rel>" %*
)
```
The `PATHEXT` manipulation removes `.JS` from the executable-extension list so that
`node` resolves to `node.exe` rather than recursing into a `node.js` file. The double
spaces are real (an empty interpolated argument slot).

**`<B>`** (sh)
```sh
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case `uname` in
    *CYGWIN*) basedir=`cygpath -w "$basedir"`;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/<rel>" "$@"
else
  exec "<node>"  "$basedir/<rel>" "$@"
fi
```

**`<B>.ps1`**
```powershell
#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/<rel>" $args
  } else {
    & "$basedir/node$exe"  "$basedir/<rel>" $args
  }
  $ret=$LASTEXITCODE
} else {
  if ($MyInvocation.ExpectingInput) {
    $input | & "<node>"  "$basedir/<rel>" $args
  } else {
    & "<node>"  "$basedir/<rel>" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
```

> **Requirement:** a native single-binary implementation writes a
> `<B>.exe` **copy or hardlink of itself** and dispatches on `argv[0]`. It does not
> create shell, cmd.exe, or PowerShell wrappers.

## 10.4 Install directory resolution

`--install-directory` wins. `--system` is mutually exclusive and selects
`/usr/local/bin` on POSIX or `%ProgramData%\jup\bin` on Windows. Otherwise use
`JUP_SHIM_DIRECTORY`, its compatibility spelling, or these deduplicated platform
candidates in order:

* Linux and BSD default to absolute `$XDG_BIN_HOME` when set, otherwise
  `<home>/.local/bin`; alternates are absolute `$XDG_BIN_HOME`,
  `<home>/.local/bin`, then `<home>/bin`.
* macOS defaults to `<home>/.local/bin`; alternates are absolute `$XDG_BIN_HOME`,
  `<home>/.local/bin`, then `<home>/bin`.
* Windows uses `%LOCALAPPDATA%\jup\bin` and has no alternate.

For `enable`, use the default when it is on `PATH`, otherwise the first candidate
that already contains a jup-owned shim, otherwise the first eligible alternate on
`PATH`, otherwise the default. Never adopt a directory merely because it appears on
`PATH`. Every existing directory selected automatically MUST be owned by the
effective user, be neither group- nor world-writable, and pass a writability probe.
An alternate's matching `PATH` entry must also be absolute and the directory must
already exist. Explicit `--install-directory` and `--system` targets are not subject
to the ownership or mode gate, but must pass the writability probe. Announce
alternate selection with the exact message:
`! <default> is not on your PATH; installing shims to <alternate> instead`

Create only the default, explicitly with mode `0755` independent of umask, then
realpath it. Probe the selected directory before writing any shim. A bare `enable`
that cannot write its initial selection falls back to the default and prints:
`! <dir> is not writable; installing shims to <fallback> instead`
A named directory and `--system` never fall back. For `disable`, `info`, and child
PATH promotion, prefer the candidate that already contains a jup-owned shim without
consulting `PATH`. Root may use the system candidate last. Use the messages in
§12.12 when no candidate exists, `%ProgramData%` is absent, or options conflict.

## 10.5 Target set

With no names, `enable` includes every entry except those with
`shimByDefault: false`; npm is included. `--exclude npm` opts out. `bun`, `deno`,
`nub`, and `node` opt out. Naming an entry enables it explicitly. `disable` with no
names covers every entry, including opt-outs.

`disable` with no names covers **every** entry, opt-outs included: removal has no
such hazard, and a `disable` that declined to undo an `enable bun` would be the
surprising one.

Each name expands to every binary name it declares across all range entries, deduped:

| Name | Binaries | In the default set |
|---|---|---|
| `npm` | `npm`, `npx` | yes |
| `pnpm` | `pnpm`, `pnpx` | yes |
| `yarn` | `yarn`, `yarnpkg` | yes |
| `bun` | `bun`, `bunx` | no — `shimByDefault: false` |
| `deno` | `deno` | no — `shimByDefault: false` |
| `aube` | `aube`, `aubr`, `aubx` | yes |
| `nub` | `nub`, `nubx` | no — `shimByDefault: false` |
| `node` | `node` | no — required of a runtime (§02.3) |

All binaries are processed concurrently.

`info` reports **every** binary name regardless, including the opt-outs: what
that report answers is "what does this name currently resolve to?", and for `bun` that
is the interesting question precisely because the answer is usually someone else's
install.

### Living beside a version manager

`enable node` claims the name `node` on `PATH`, and on a great many machines something
else already has it — nvm being the common case. There is no arbitration and none is
required: whichever shim directory comes first on `PATH` wins, and nvm re-prepends its
own on every shell start and on every `nvm use`, so after an `nvm use` nvm's `node` is
normally the one that runs.

This is why the last row of the table is a **MUST** rather than a preference. A bare
`jup enable` never claims `node`, so the collision exists only for someone who typed
`jup enable node`, which is a deliberate act with a predictable outcome. The matching rule is that jup **reads** `.nvmrc` and leaves everything else about
a machine's version manager alone — it installs no shell hooks, writes no profile, and
never removes or shadows another tool's directory.

## 10.6 `disable`

For every requested binary name, `disable` MUST apply the ownership test in §10.2
to each platform entry. It removes only a jup-owned entry. A missing or foreign entry
is left unchanged. The Yarn Switch guard still warns and skips.

After removing an owned entry, or when the destination is absent, `disable` MUST
restore its displaced entry from `<home>/shims.json`, including its type, contents or
symlink target, and mode, then atomically clear that record and backup. If installing
a shim fails after displacement, `enable` MUST roll back the displaced entry before
returning the error. If restoration fails, report the path and retain the record and
backup for another attempt. Never restore over a foreign entry installed after jup's
shim.

`disable` never touches a name it was not asked about and is safe to repeat. Note
`disable yarn` covers both `yarn` and `yarnpkg`, because the name expands to its full
binary set.

## 10.7 Read-only installation directories

`enable` fails when the directory containing the tool is read-only, which is common
in container images and system package installs. There is no fallback; the reference
implementation documents shell aliases as the workaround.

> **Requirement:** a conforming implementation SHOULD detect `EROFS`/`EACCES`
> on the install directory and emit an actionable error naming the two real options —
> `--install-directory <a writable dir on PATH>`, or shell aliases — rather than a raw
> errno. It MAY offer a `--print-shell-init` subcommand emitting shell functions for
> the current shell, which sidesteps the filesystem entirely.

A read-only directory *holding the tool itself* is the other half of this, and it is
the common one: a global npm install, a container image, an OS package. `enable`
succeeds there because it has nothing to write — §10.2 property 4 compares the stub
before rewriting it, and the shipped stub is already current. Two things break that
truce, and both fail rather than warn, because in each the shims `enable` is about to
write could not work:

* shimming the runtime rewrites the stub to pin the interpreter (§10.1), and the
  message names the **stub**, not the shim directory, whose remedies do not move it;
* shimming the runtime also rewrites the tool's own CLI entry, for the same reason, and that message names **that file** and the recursion it prevents —
  a third read-only failure with a third diagnosis;
* the stub is current but not executable, and the `chmod` §10.2 property 5 requires
  is itself refused.

When nothing needs writing, the install succeeds; here the write is load-bearing, and an `enable` that exited 0 would leave the
user with shims that are silently inert.

## 10.8 Self-install shims

`self-install` (§09.12) claims the tool's **own** names — `jup` and `corepack`, the
two keys of the package's `bin` — pointing them at the copy it just put in
`<home>/self/<version>` (§07.11). Everything about *how* a name is claimed is §10.2
and §10.3 unchanged: ownership, `--force`, §15.15's displacement, the idempotent
no-write, the install-directory chain of §10.4, and §15.29's verification. Only the
target differs, and it differs two ways:

| Platform | Target |
|---|---|
| POSIX | the shared stub in the copy's `bin/`, exactly as `enable` links it |
| Windows | §10.3's trio, naming the CLI entry under the interpreter |

Three requirements follow.

1. **The shared POSIX stub MUST recognise the tool's own names.** It already reads the
   name it was invoked under (§10.1); finding one of its own, it behaves as the CLI
   entry does — the download prompt defaults to `0` rather than `1` (§05.5), and the
   argv is passed through unchanged rather than gaining a leading binary name.
   Without the second, `jup use pnpm@12` reaches the entry point as
   `["jup", "use", …]` and is rejected as an unknown command.
2. **Windows wrappers MUST NOT be generated against a per-name stub here.** §10.3's
   stub for `jup` would be `jup.mjs`, which is the CLI entry's own name; the wrappers
   name that entry directly instead. Because they then name no stub, §14.16's
   ownership test cannot recognise them the usual way, so these wrappers carry the
   shim marker in a comment.
3. **A copy the running version did not produce MUST be linked as it arrived.**
   `self-install` copies the running installation, so the shared stub it links is one
   this version would have written anyway and §10.1's regeneration is free to run.
   `self-upgrade` (§09.13) installs a *different* version, whose stub belongs to it:
   regenerating that file from the running version's source puts an old stub in front
   of a new bundle, which is the one skew an upgrade exists to remove. The downloaded
   stub is therefore linked verbatim, and the only byte that may change is the
   shebang below — the same first-line-only rewrite §15.46 makes to the CLI entry, for
   the same reason and under the same condition.

Baking in the interpreter is §10.1's rule, unchanged and for its reason: the copy in
the store opens `#!/usr/bin/env node` like any other installation, and with the tool's
own `node` shim ahead of the runtime on `PATH` that lookup finds the shim.
