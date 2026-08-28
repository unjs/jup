# 10 — Shims & PATH Integration

`enable` puts the tool's names on `PATH`; `disable` takes them off. Everything else in
this spec assumes `enable` has already run (or that the user types the tool's name
explicitly).

## 10.1 What a shim must do

A shim for binary `B` must invoke the tool as if the user had typed
`<tool> B <args…>`, and must set the download-prompt default to `1` (§05.5) because
the user asked for `B`, not for a download.

The reference implementation bakes the name into a generated file rather than
sniffing `argv[0]`:

```js
// dist/<B>.js
#!/usr/bin/env node
process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT??='1'
require('module').enableCompileCache?.();
require('./lib/corepack.cjs').runMain(['<B>', ...process.argv.slice(2)]);
```

versus its own entry point:

```js
// dist/corepack.js
#!/usr/bin/env node
process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT??='0';
require('module').enableCompileCache?.();
require('./lib/corepack.cjs').runMain(process.argv.slice(2));
```

Both `chmod 0o755`.

> **Divergence (§14.25).** The relative specifier above resolves correctly only
> because the runtime resolves the main module through its realpath, and the name
> on `PATH` is a symlink to the stub (§10.2). A conforming implementation MUST
> resolve the entry against the stub's **own realpath** instead, so the shim also
> works under `node --preserve-symlinks-main` and on runtimes that resolve from
> the link:
>
> ```js
> import { realpathSync } from "node:fs";
> import { pathToFileURL } from "node:url";
> const entry = new URL("<entry>", pathToFileURL(realpathSync(import.meta.filename)));
> const { runMain } = await import(entry.href);
> ```
>
> `<entry>` is the bare file name from §10.4's candidate list. See §14.25 for the
> failure this avoids and its measured cost.

> **Divergence (§14.15).** The shim MUST NOT bake the binary name into a per-name
> file **on POSIX**. It reads the name it was invoked under instead:
>
> ```
> name := basename(argv[0]), with a trailing ".exe" removed on Windows
> if name is one of the known binary names and name != <tool's own name>:
>     downloadPromptDefault := "1"
>     proxy-mode with binaryName = name, args = argv[1..]
> else:
>     downloadPromptDefault := "0"
>     normal dispatch on argv[1..]
> ```
>
> The reference implementation avoided this because a runtime `realpath`s the module
> it executes and so loses the invocation name. It does — but the *invocation path*
> survives in `argv[1]`, which is not `realpath`'d, under a direct `PATH` execution,
> under `<runtime> <shim>`, and under `--preserve-symlinks-main`. A hosted
> implementation therefore gets the same dispatch a native one gets from `argv[0]`,
> and §10.2's target becomes one stub rather than one per name.
>
> It MUST NOT be used to *replace* the explicit `<tool> <binary>` form, which stays
> available.
>
> **Windows is excluded**, and the exclusion is not a limitation of this rule but of
> §10.3: a `.cmd` or `.ps1` wrapper invokes `<runtime> <stub>`, so by the time the
> tool runs the invocation name is genuinely gone. Windows keeps one stub per name.

### Baking in the interpreter

> **Divergence (§14.26).** Wherever a shim names the interpreter as a bare `node`,
> a conforming implementation MUST instead name it by **absolute path**: the
> `realpath` of the runtime executing `enable`, resolved at `enable` time. This
> covers §10.3's three Windows wrappers and, conditionally, the POSIX stub's
> shebang. Two failures make the bare name unusable:
>
> 1. **`cmd.exe` resolves a bare name from the current directory first.** `cd` into
>    any repository that ships a `node.bat`, `node.cmd` or `node.exe`, type
>    `yarn --version`, and that file runs. Corepack was shielded by accident — its
>    shims sat beside `node.exe` in the Node install directory, so the `IF EXIST`
>    branch was the one that fired. §15.13 moves ours to `%LOCALAPPDATA%\jup\bin`,
>    where there is no `node.exe`, which makes the fallback the *default* Windows
>    path. Git Bash has the same problem in the extensionless wrapper.
> 2. **`#!/usr/bin/env node` re-searches `PATH`,** which §15.32 asks the user to put
>    the shim directory *first* on. Once `enable node` (§10.5) has claimed the name
>    `node` there, `env` finds the shim rather than the runtime and the stub execs
>    itself until the machine gives up — on Windows a new `cmd.exe` per level rather
>    than one spinning process.
>
> `realpath`, because `process.execPath` is frequently a symlink into a version
> manager's store and the point of baking a path in is that it names one file rather
> than whatever a lookup would answer later.
>
> **When it applies.** Windows always bakes it in. POSIX bakes it into the shared
> stub's shebang only when the install directory claims the interpreter's own name —
> either this run enables `node`, or an earlier one already installed a shim of ours
> at that name. Otherwise the stub keeps `#!/usr/bin/env node`, so the shipped stubs
> stay relocatable and §10.7's read-only `distFolder` is not rewritten for a user who
> never asked for a `node` shim. A *foreign* `node` in the directory does not count.
>
> The `%~dp0\node.exe` and `$basedir/node` branches are kept: they cost nothing, and
> they are what keeps a shim directory that *is* the Node install directory
> relocatable.

## 10.2 POSIX shim creation

```
generatePosixLink(installDirectory, distFolder, binName):
    file    := installDirectory/binName
    target  := RELATIVE path from installDirectory to distFolder/<proxy stub>
    st      := lstat(file)                     # lstat, NOT stat — must not follow

    if st exists:
        if st is a symlink:
            if binName contains "yarn" and realpath(file) matches /[\/\\]switch[\/\\]bin[\/\\]/:
                stderr: `<binName> is already installed in <file> and points to a
                         Yarn Switch install - skipping`
                return                                    # exit 0, leave it alone
            if readlink(file) === target:
                return                                    # already correct — no write
        unlink(file)

    symlink(target, file)
```

`<proxy stub>` is **one file for every binary name** (§14.15): it carries no name of
its own and reads the one it was invoked under from `argv[1]`. An implementation MUST
NOT make the target depend on `binName` — that is what leaves a per-name file behind
to go stale when the tool is upgraded or removed (§15.14, #751).

Four properties this MUST have:

1. **`lstat`, not `stat`.** A dangling symlink must be detected as a symlink, not as
   a missing file. (Corepack fixed exactly this bug in 0.34.4.)
2. **The link target is relative.** So the whole installation tree stays relocatable.
   This is why the install directory is `realpath`'d first (§10.4) — a relative path
   computed from a symlinked directory would be wrong.
3. **Idempotent.** An already-correct symlink is not rewritten; its mtime is
   unchanged across repeated `enable` runs. The conformance suite asserts this.
4. **The stub is written at most once per `enable`**, whatever the number of names,
   and not at all when it is already current — so `enable` still succeeds against a
   read-only `distFolder` that shipped it (§10.7, §14.18).

Anything else occupying the name — a plain file, a wrong symlink, a real binary — is
**unlinked and replaced without warning**. The only exception is the Yarn Switch
guard.

> **Divergence (§14.16):** silently clobbering a real, non-tool binary is hostile.
> A conforming implementation SHOULD detect that the existing entry is a regular file
> that is not one of its own shims and refuse, printing:
> `<binName> already exists at <file> and was not installed by this tool - skipping (use --force to overwrite)`
> and SHOULD add `--force`. The Yarn Switch special case then becomes one instance of
> a general rule rather than a hard-coded exception.

### Yarn Switch

"Yarn Switch" installs a `yarn` binary whose realpath contains `…/switch/bin/…`.
Both `enable` and `disable` refuse to touch such an entry, warn, and exit 0. The
check applies to any binary name containing the substring `yarn` (so `yarnpkg` too).
POSIX only — on Windows the check is not performed and `disable` removes the files.

## 10.3 Windows shim creation

Windows has no usable symlink story for this purpose (it needs elevation or developer
mode), so three files are written per binary name:

| File | Purpose |
|---|---|
| `<B>` (no extension) | sh script, for Git Bash / MSYS / Cygwin |
| `<B>.cmd` | cmd.exe |
| `<B>.ps1` | PowerShell |

All three are created unconditionally (the generator is invoked with
`createCmdFile: true` so the Windows shims can be produced from a POSIX build
machine), all `chmod 0o755`, and all **overwrite unconditionally** — there is no
idempotency short-circuit on Windows.

Let `<rel>` be the path from the shim directory to `dist/<B>.js`, backslash-separated
for `.cmd` and forward-slash-separated for the other two.

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

> **Divergence (§14.15 cont.):** a native single-binary implementation writes a
> `<B>.exe` **copy or hardlink of itself** plus nothing else, and dispatches on
> `argv[0]`. That removes three generated scripts per binary, the `PATHEXT` hack, the
> PowerShell pipeline special-casing, and the dependency on a JS runtime being on
> `PATH` at shim time. It is strictly smaller and faster. `.cmd`/`.ps1` variants are
> then unnecessary because a real `.exe` is directly executable from every Windows
> shell.

## 10.4 Install directory resolution

```
if --install-directory was given:
    dir := that path
else:
    dir := dirname(which("<tool name>"))      # PATH lookup

# enable ONLY:
dir := realpath(dir)
```

The `PATH` lookup exists because the runtime `realpath`s the executed script, so the
tool cannot see how it was invoked. A native implementation can use the platform's
"path to my own executable" primitive (`/proc/self/exe`, `_NSGetExecutablePath`,
`GetModuleFileNameW`) instead, which is more reliable — the `PATH` lookup picks the
*wrong* directory when the tool was invoked by absolute path and a different copy is
earlier on `PATH`, and fails outright when nothing named `<tool>` is on `PATH`.

> **Divergence (§14.17):** use the self-path primitive, fall back to the `PATH`
> lookup, and error clearly if both fail:
> `Unable to determine where to install the shims; pass --install-directory`
> Corepack currently propagates a raw rejection from its `PATH` lookup here.

`disable` deliberately does **not** `realpath` the directory — removal does not need
a correct relative-path computation.

## 10.5 Target set

Default targets: every supported tool **except npm** and the `shimByDefault: false`
opt-outs (§02.3). npm is excluded
because it ships with Node through other means and shadowing it is more likely to
break a machine than to help it. `enable npm` explicitly is supported.

> §15.16 overturns the npm exclusion: it is inter-team policy jup is not party to,
> and its consequence is that a yarn-pinned project correctly blocks `pnpm` while
> `npm install` silently works anyway. `--exclude npm` restores it.

An entry MAY opt out of the default set with `shimByDefault: false` (§02.3), and
`bun`, `deno`, `nub` and `node` do — the last **MUST**, being a runtime (§02.3). Those names are ones people install deliberately and run
outside any project, so a bare `enable` — which existing users run on upgrade, having
asked for nothing — must not claim them on `PATH`. Naming the entry is the opt-in.

The test is **whether the name means anything outside a project**, and it is neither
old-versus-new nor a category the entry is filed under:

* §15.21's `aube` is a per-host native entry exactly as `bun` and `deno` are, and
  does **not** opt out: `aube`, `aubr` and `aubx` name nothing outside a project.
  An entry that opted out merely for being recent would freeze the default set at
  the three names corepack shipped.
* §15.21's `nub` is a package manager — `nub install` is pnpm-compatible on the CLI
  and on the lockfile — and opts out anyway, because `nub server.ts` runs a file and
  `nub node` manages Node versions. Being a package manager is not what earns a
  place in the default set; having no meaning outside a project is.

`disable` with no names covers **every** entry, opt-outs included: removal has no
such hazard, and a `disable` that declined to undo an `enable bun` would be the
surprising one.

Each name expands to every binary name it declares across all range entries, deduped:

| Name | Binaries | In the default set |
|---|---|---|
| `npm` | `npm`, `npx` | yes (§15.16) |
| `pnpm` | `pnpm`, `pnpx` | yes |
| `yarn` | `yarn`, `yarnpkg` | yes |
| `bun` | `bun`, `bunx` | no — `shimByDefault: false` |
| `deno` | `deno` | no — `shimByDefault: false` |
| `aube` | `aube`, `aubr`, `aubx` | yes |
| `nub` | `nub`, `nubx` | no — `shimByDefault: false` |
| `node` | `node` | no — required of a runtime (§02.3, §15.39) |

All binaries are processed concurrently.

`info` (§15.30) reports **every** binary name regardless, including the opt-outs: what
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
`jup enable node`, which is a deliberate act with a predictable outcome. §15.40 is the
other half of the same posture: jup **reads** `.nvmrc` and leaves everything else about
a machine's version manager alone — it installs no shell hooks, writes no profile, and
never removes or shadows another tool's directory.

## 10.6 `disable`

```
POSIX:
    if binName contains "yarn" and realpath(file) is a Yarn Switch path:
        warn and skip
    unlink(file)              # ENOENT ignored, anything else propagates

Windows:
    for ext in ["", ".ps1", ".cmd"]:
        unlink(installDirectory/<binName><ext>)     # ENOENT ignored
```

`disable` never touches a name it was not asked about — an unrelated binary in the
same directory is left alone. It is safe to run repeatedly and on a directory with no
shims.

Note `disable yarn` removes **both** `yarn` and `yarnpkg`, because the name expands
to its full binary set.

## 10.7 Read-only installation directories

`enable` fails when the directory containing the tool is read-only, which is common
in container images and system package installs. There is no fallback; the reference
implementation documents shell aliases as the workaround.

> **Divergence (§14.18):** a conforming implementation SHOULD detect `EROFS`/`EACCES`
> on the install directory and emit an actionable error naming the two real options —
> `--install-directory <a writable dir on PATH>`, or shell aliases — rather than a raw
> errno. It MAY offer a `--print-shell-init` subcommand emitting shell functions for
> the current shell, which sidesteps the filesystem entirely.
