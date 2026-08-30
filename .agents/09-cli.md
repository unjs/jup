# 09 — Command Surface

This is the complete surface. Anything not here is out of scope (§01.7).
`--help` prints it; `src/commands/usage.ts` holds the text.

```
jup <binary>[@<version>] [...args]     proxy mode (§01.2)
jup <script> [...args]                 §09.17, and so §09.16

jup cache clean [--all]
jup cache clear [--all]
jup cache install
jup cache install -g|--global [--cache-only] [...name[@<version>] | <file>.tgz]
jup cache list [--json]
jup disable [--install-directory <path>|--system] [--exclude <name>] [...name]
jup enable  [--install-directory <path>|--system] [--all] [--exclude <name>] [--force] [...name]
jup info [--json]
jup info --store-path [<name>]
jup install [...args]
jup pack [--json] [-o|--output <path>] [...name[@<version>]]
jup run [...args]
jup self-install [--install-directory <path>|--system] [--force]
jup self-upgrade [--install-directory <path>|--system] [--force]
jup up  [--here] [--no-integrity] [--no-lockfile]
jup use [--here] [--no-integrity] [--no-lockfile] <name[@<version>]>
jup --version
jup --help | -h | help
```

Three flags apply to every mutating command:

* `--here` limits project changes to `cwd`'s own manifest; otherwise the search
  stops at a workspace root (§03.1).
* `--no-integrity` writes only the version and removes any existing digest.
  Otherwise, `devEngines` stores the digest in `integrity`, while the top-level
  `packageManager` stores it in `<version>+<algo>.<hex>`. Both forms are read the
  same way (§03.7).
* `--no-lockfile` writes no resolution to `jup.lock` and removes any resolution
  already recorded for the pin. It names the file only when the file changed
  (§12.11). Only range and tag pins record resolutions (§04.4), so the flag does
  nothing for an exact pin. A range is still resolved, installed, and written to
  the manifest. `JUP_FROZEN_LOCKFILE=1` refuses the run if an entry would be
  removed.

Every mutating command prints each path it changed.

## 9.1 Pattern resolution (`cache install`, `pack`, `up`, `use`)

```
patterns given → load ONLY the env file (envOnly, §03.2)
                 parse each with requireVersion: false
no patterns    → discover the project spec
    NoProject → "Couldn't find a project in the local directory …"
    NoSpec    → "The local project doesn't feature a 'packageManager' field nor …"
    Found     → [lookup.range ?? lookup.getSpec()]
```

`lookup.range ?? getSpec()` prefers a declared `devEngines.…​.version` range over
the top-level `packageManager` pin — the same order §3.3 reads them in — which is
what lets `up` follow a declared range across majors (§9.4).

## 9.2 `cache install`

Resolves the project's spec (tags allowed), prints `Adding <name>@<ref> to the
cache...`, and installs it. It does **not** touch `lastKnownGood.json`. It reads
`jup.lock` through the same path the proxy does, so a warmed Docker layer and the
run it warms cannot disagree about which version the files name. Exit 0, stderr
empty.

## 9.3 `cache install -g` / `--global`

Accepts a mixed list of specs and `.tgz` archive paths; `--cache-only` downloads
and extracts without making anything the default.

For a spec: resolve (tags allowed), print `Installing <name>@<ref>...` (or
`Adding … to the cache...` with `--cache-only`), install, and — unless
`--cache-only` — set the last-known-good **unconditionally**. Unlike §04.8's
guarded bump, `cache install -g yarn@1.0.0` sets the default to 1.0.0 even when the
current default is 4.x.

For an archive: §07.10.

## 9.4 `up`

No positional arguments. Updates the project's pin.

**When the project declares a range** — in `devEngines.packageManager.version`,
or in `packageManager` where the member names no version (§3.3) — `up`
refreshes the recorded resolution in `jup.lock` and leaves the field alone. The
range is the user's statement of intent, and there is no second, major-confining
resolve because a range already says how far the user will move. `^2.0.0` derived
from a `~2.1.0` pin would pick a version the pin itself rejects. The memo for
that key is retired at the same time.

`up` refreshes that file; it never creates it (§04.4). On a project with no
`jup.lock` the resolution goes to the memo instead, no path is printed — nothing
committed changed — and `JUP_FROZEN_LOCKFILE=1` does not bind a run that writes
nothing. Where the file *is* there, the flag makes the refresh a hard error. A
dist-tag pin is refused either way.

**Otherwise** — an exact pin — two resolves, both with `useCache: false` and tags
**not** allowed:

```
resolved := resolve(descriptor)            # null → "Failed to successfully resolve …"
highest  := resolve(^major(resolved).0.0)  # null → "Failed to find the highest release …"
install, write the pin, run the tool's `use` command (§9.5)
```

The second resolve is what confines the update to the current major line.
`useCache: false` on both is required — with the cache consulted, `up` would
return the installed version and never update anything.

Note the interaction with §9.1: when the descriptor came from a `devEngines` range
spanning majors (`1.x || 2.x`), the *first* resolve has already crossed the
boundary and the second pins the major it landed in. A declared range can
therefore carry `up` across a major; a bare `packageManager` pin cannot. The
range survives this because `up` takes the branch above and writes no pin — only
an explicit `jup use <exact>` replaces a declared range (§3.7).

A non-semver pin is refused: "The 'jup up' command can only be used when your
project's packageManager field is set to a semver version or semver range".

## 9.5 `use <pattern>`

Parse the pattern (`requireVersion: false`), resolve it with tags allowed and
`useCache: false`, print `Installing <name>@<ref> in the project...`, install,
then write the pin (§03.7).

**A typed semver range** — so neither a bare `jup use pnpm` nor a dist-tag — goes
into the field as written, and the version it resolved to is recorded in
`jup.lock` beside the manifest. Both paths are printed, the digest goes to the
lockfile rather than the field, the replaced key's resolution is retired, and
`JUP_FROZEN_LOCKFILE=1` refuses the command *before* it resolves. Every other
pattern pins exactly.

Then, if the resolved band declares `commands.use`:

```
JUP_MIGRATE_FROM := the previous pin, or "unknown"
stdout: a blank line
run the tool: argv = commands.use            # e.g. ["yarn", "install"]
```

So `jup use yarn@4` prints the banner, a blank line, then everything `yarn
install` prints. With no `commands.use` the command returns 0 after writing —
which is every `use` of a runtime, so `jup use node@22` writes
`devEngines.runtime` and stops there.

`jup install` (§09.15) is the same handover without the pin.

Behaviours worth knowing, all test-asserted:

* An existing **malformed** `packageManager` (a range, a bare name, a trailing
  `@`, a non-string) does not block `use`; it is overwritten. This is why spec
  parsing is lazy (§03.1).
* If no `package.json` exists anywhere, one is created at `cwd`.
* If the project root is an ancestor of `cwd`, the ancestor's manifest is updated
  — unless `--here`.
* The written pin carries a digest computed from the actual downloaded bytes,
  whatever algorithm the input pattern used — except for a per-host tool, where
  no digest reaches the manifest (§02.4).
* A `devEngines` **name** mismatch surfaces through `writePin`'s check and routes
  through `onFail`. With the default, the banner has *already* reached stdout, so
  the failure prints underneath it — banner, then `Usage Error: …`, then a blank
  line and the usage line, all on stdout, stderr empty, exit 1. A version outside
  a declared range is *not* a mismatch here: the write replaces that range (§3.7),
  so there is nothing left for the pin to violate.

## 9.6 `pack`

Resolve each pattern (tags allowed), install it, set it as last-known-good, and
tar the resulting store subtrees rooted at the install folder into
`--output` (default `./jup.tgz`). `--json` prints the output path as JSON instead
of the human log.

`pack` updating last-known-good is deliberate: you pack what you intend to run.

## 9.7 `cache clean` / `clear` / `list`

`clean` and `clear` are aliases; behaviour and output are in §07.9. `cache list`
is the store half of `info` — the installed versions per tool, with `--json`
sharing `info`'s report shape. `cache install` is §09.2 and §09.3; it is dispatched
ahead of these three because it carries its own flags and positionals.

## 9.8 `enable` / `disable`

§10 defines directory selection, validation, target expansion, ownership,
replacement, restoration, output and idempotency. `--exclude <name>` removes a
name from the default set (`--exclude npm` being the common case), and `enable
--all` widens that set to every entry the table has, opt-outs included — the set
a bare `disable` already covers (§10.7). `--all` takes no names beside it.

## 9.9 `info`

The report — every form of the command **except** `--store-path` below — prints,
with **no request of any kind** and no process but this one, what the next run
would do and why:

* the project — which manifest or version file speaks, which field carries the
  pin, whether the spec is exact, a range, a tag or a URL, and why it cannot be
  used when it cannot;
* the recorded resolution and the memo, read through the same range gate and
  expiry rule a run applies, so it reports what the next run would accept — for a
  per-host tool it prints the whole host map;
* what the next run would resolve to, following §01.3's own order;
* every installed version, every shim and what each name on `PATH` currently
  resolves to — including entries that are not shimmed by default, because for
  `bun` the interesting answer is usually someone else's install;
* the recorded global defaults, each annotated `(pinned)` or `(expired)` when
  §04.6's TTL has something to say about it — a healthy entry is annotated with
  nothing, because a report is read to find the unexpected;
* the effective `.npmrc` settings with the file and key that supplied each, and
  what TLS verification the next request would do and who decided;
* the environment snapshot, taken **before** the env file is applied. Credentials
  (`*_TOKEN`, `*_PASSWORD`, `*_USERNAME`) are reported as present, never printed;
  long values are elided;
* the **project inputs** — every file §03.1's discovery consults, absolute, in
  walk order, each labelled as a manifest, a version file, an env file or the
  lockfile, with the tool it speaks for, whether it is there, and whether it is
  the one of its kind the walk chose. Candidates that are **absent** are listed
  too, and are the point rather than noise: this is the set a CI cache key is
  built over, and such a key has to move when a file that was not there appears.
  The version file's name comes from §02's table, so `.nvmrc` is not spelled
  anywhere a cache key can drift from it, and the manifest listed as selected is
  the one the walk climbed to — which in a workspace is not the one the job is
  standing in. The walk reported runs from `cwd` out to that selection; above it
  §03.1 had nothing left to find, and stopping there keeps a home directory out
  of somebody's cache key. The memo under `node_modules` is not an input: it is
  derived state, restored with `node_modules` or not at all.

`--json` emits the same report with a `version` field, bumped only for a breaking
shape change. Adding a field is not one, so a reader ignores what it does not
know.

### `--store-path [<name>]`

A different command wearing `info`'s name, and the one part of §09.9 that is not
the report. It answers where **the manager's own** dependency store is — the
directory a CI job caches beside `JUP_HOME`, which holds jup's programs and not
theirs. With no name it asks the tool §09.1's discovery selects; with one it asks
that entry.

```
name    := <name> given, else §09.1's discovery
    NoProject / NoSpec → §12.10's two project errors
    a name the table does not know → §12.4's "isn't supported by this jup build"
commands := the entry's storeCommands (§02.5), in order; none → print nothing
version  := §04.1's order without step 5 — the recorded resolution or the memo,
            else the store probed against the pin, else the recorded default,
            else the built-in one. Not installed → print nothing
for each command: run it, take stdout's last non-empty line
    exit 0, and the line is an absolute path → print it, exit 0
    anything else — including the literal `undefined` → the next command
none answered → print nothing, exit 0
```

Three properties are the contract, and the shell script this replaced is what
each is for:

* **One absolute path on stdout, or nothing, and always exit 0.** Cache discovery
  is optional; a job that asks must not fail because the answer is "there
  isn't one". Only a request that cannot mean anything — an unknown name, or no
  name where §09.1 finds no pin — is a `UsageError` (§12.1).
* **The last line**, because a manager's own notices arrive before its answer.
* **`undefined` is not a path.** Yarn Classic prints it for Berry's
  `cacheFolder`, which is exactly why `storeCommands` is a chain: the sentinel
  advances to the next candidate rather than being normalised by every caller.

It **resolves and installs nothing**: the probe runs what the store already
holds, so a cold machine prints nothing rather than downloading a package manager
from a diagnostic command. `jup cache install` is the step that makes it answer,
and the order the CI action uses. This is also why `--store-path` is refused
together with `--json`: the report is a versioned document and this is one line
for a shell, and there is no shape that is both.

## 9.10 `--version`, `--help`

`--version`/`-v` prints jup's own version; `--help`/`-h`/`help` prints the
surface above. The synopsis lists only the long spelling of each; the short and
bare forms are aliases corepack also accepts, kept so a hand or a script that
reaches for `-v` is not met with `Unknown command`. Both are ordinary management
commands and are shadowed by proxy mode: `jup yarn --version` is a *proxy*
invocation and prints Yarn's version.

## 9.11 (retired) Deprecated commands

**`install` under corepack's name.** On jup's own surface `install` is §09.15,
which runs the project package manager's install command. Invoked through
`corepack` — meaning `bin/corepack.mjs` ran, which §10.9 makes the only reliable
statement of that —
`install` and `install -g` are rewritten to `cache install` and
`cache install -g` before dispatch, so a Dockerfile or CI job written against
corepack keeps working. The rewrite happens in `runMain`, ahead of both the
dispatch switch and §12.1's presenter, so a failure inside prints the `cache`
usage line rather than the generic one.

It maps command spellings and nothing else. In particular it does not carry the
hatches `test/corepack/_runCli.ts` sets: §06's verification and §05.4's download
notice are the same under both names, because a security posture chosen by which
symlink was typed is one nobody chose. See `RunOptions.corepackCompat`.

`hydrate` and `prepare` were corepack's predecessors of `cache install -g
<file>.tgz` and of `pack` + `cache install -g`. §09.17 is why the compatibility
flag also suppresses the script fallback: under corepack's name their word must
keep saying it is gone. They were dropped before publication:
they existed for scripts written against corepack, jup has no install base of its
own, and the corepack compatibility suite never exercised them. `cache install -g
<file>.tgz` and `pack` (§09.3, §09.6) cover both.

The number is kept so §09.12-§09.14 do not move. Do not reuse it.

## 9.12 `self-install`

Installs **jup itself**: copies the running installation into the store and puts
jup's own two names on `PATH`.

```
payload := the running installation — <root>/dist, <root>/bin, <root>/package.json
           a source checkout (no dist/, no bin/) → UsageError naming what it looked for
hash    := digest over the payload's (relative path, mode bit, bytes)

stdout: `Installing jup@<version>...`
unless the store's marker already records that hash:
    stage the payload, write its marker, promote it (§07.11)
stdout: `jup <version> -> <home>/self/<version>`
install the shims (§10.9) into §10.5's directory
stdout: `<names> -> <install directory>`      omitted when nothing was installed
verify the result is what `PATH` resolves
```

It resolves nothing, opens no socket and never reads the project: the bytes it
installs are the ones already running, which is the only way a command that
installs jup can be run by the jup it installs. It does not touch
`lastKnownGood.json` — jup is not a table entry.

Both halves are idempotent. An unchanged payload writes nothing, and a correct
shim is left alone (§10.3). The digest is what makes the first true, and also
what makes a *changed* payload at the same version replace what is there — the
case §07.5's promotion alone would treat as a lost race.

`--force` takes a name another tool owns, which is what replacing a Node-bundled
`corepack` needs.

## 9.13 `self-upgrade` (also spelled `upgrade`)

§9.12 with the payload fetched from the registry rather than copied. It is the
only command that installs **jup** from the network, and the only one whose
artifact is not a table entry.

```
version+digest := §04.6's `latest` lookup for jup's own package
    signature-verified, refused outright with no verification tier
    NOT release-age gated (§04.1) — the gate filters implicit choices among table
      entries, and this is an explicit request for jup's own release
    a non-semver answer → UsageError naming what the registry said
version older than the running one → say so on stdout, exit 0, install nothing
stdout: `Installing jup@<version>...`
unless <home>/self/<version> holds a readable marker:
    metadata → tarball URL (§07.3), download notice (§05.4)
    one pass: hash the stream while extracting it (strip 1)
    digest mismatch → discard, install nothing
    the archive must contain dist/ and the bin/ CLI entry both names point at,
      otherwise UsageError — a registry publishing something else under our name
    grant the execute bit to that entry, write the marker, promote as §9.12 does
<same as §9.12 from here>
```

Two differences are load-bearing:

1. **The marker's `hash` is the artifact's digest**, as for every other download —
   not §9.12's digest over a copied payload. Nothing compares contents here: a
   complete marker for that version is what says the work is done, which makes a
   second run cost one metadata request and no transfer.
2. **Nothing downloaded is rewritten.** The shims link the *published* CLI entry;
   regenerating it from the running version's source would put an old entry in
   front of a new bundle. The only permitted edit is §10.2's shebang pin, under
   the condition that already governs it.
3. **It never resolves backwards.** `JUP_MINIMUM_RELEASE_AGE` is not applied
   here — `install.sh` does not apply it either, and its gated selector is the
   newest *eligible* release rather than a cap on the running one, so a cooldown
   outliving a release would turn an upgrade into a downgrade. Independently of
   that, a `latest` below the running version (a rolled-back tag, a lagging
   mirror) is reported and nothing is installed: the equal case still reinstalls,
   which is what makes the command a repair.

The command is spelled in full, and only in full. The short `upgrade` was too
close to `up`, which writes the project's pin, and the word is reserved for a
project-level command; `jup upgrade` is an unknown command (§12.1).

## 9.14 Output streams

| Content | Stream |
|---|---|
| `Adding …`, `Installing …`, `Updated <path> …` from a management command | stdout |
| `--json` output, `info`, `cache list` | stdout |
| Management-mode `Usage Error: …` and its usage block | **stdout** |
| Validation warnings, advisories, the download notice, Yarn Switch notices | stderr |
| Auto-pin's notice and its `Updated …` line (proxy mode) | stderr |
| Proxy-mode `UsageError` | stderr |
| Everything the tool itself prints | passthrough, unmodified |

Never wrap, prefix, colourise or buffer the tool's own output: `jup yarn
--version` prints exactly `1.22.4\n` and nothing else.

### Colour

jup's own lines may be coloured under three constraints:

* **The text is unchanged.** Colour wraps characters a message already contains;
  an escape sequence may not add, drop or reorder one. What is styled is
  decoration: the leading `⚠`, its `│` continuation gutter, the download
  notice's `↓`, the `Usage Error:` label, and — in `--help` — the
  headings, the program name and command word, a trailing description, every
  flag, and every environment-variable name in the prose.
* **Decided per stream, per write**, and only when that stream is a terminal
  reporting colour support. A pipe, a redirect, `NO_COLOR` or `TERM=dumb` must
  produce the bytes an uncoloured implementation would; `FORCE_COLOR` overrides
  in the other direction.
* **An AI coding agent is not a person at a terminal.** Agents commonly capture
  streams through a pty, so escapes land verbatim in a transcript with no use for
  them; when the environment announces one (§11.4), colour is suppressed.
  `FORCE_COLOR` still wins — an explicit ask beats a read of the environment.

A run with colour off is byte-identical to one from an implementation with no
colour at all, which is what lets §13 assert exact output.

The agent-detection list is a vendored copy of someone else's table and a moving
target. It buys a nicer transcript and costs recurring maintenance; if it ever
starts producing surprises, dropping back to `NO_COLOR`/`FORCE_COLOR`/TTY is a
reasonable retreat.

## 9.15 `install [...args]`

Runs the project package manager's own install command — §09.5's handover
without the pin. It writes nothing: not the manifest, not `jup.lock`, not
`lastKnownGood.json`, not the memo.

```
descriptor := the project's spec (§09.1, no patterns)
    NoProject / NoSpec → §12.10's two project errors
locator    := the recorded resolution or memo, else resolve(descriptor)  # §09.2
install
argv       := commands.use ++ args                                       # §09.5
```

Resolution is §09.2's, not §09.5's: the committed resolution and the memo are
read first and the spec is not re-resolved, so a warm pinned project reaches the
package manager with no request of any kind, and `jup install` and `jup pnpm
install` cannot disagree about which version a range currently means.

Everything after the command word is forwarded verbatim after `commands.use`, so
`jup install --frozen-lockfile` passes the manager's own flag through and jup
claims no flags of its own here — `--here` and the two pin opt-outs are for the
commands that write. There is no banner and no blank line: what the tool prints
is the whole of the output, and its exit code is the command's.

`JUP_MIGRATE_FROM` is **not** set. Nothing migrated: the pin is what it was
before the command ran.

A pin with no band — a custom URL (§04.1 step 1) — declares no `commands.use`,
and is §12.10's `The 'jup install' command isn't supported for <name>@<reference>`.
Every entry in the table declares one, so no table pin can reach it. A runtime
cannot: `packageManager` refuses to name one (§12.2), and this command reads that
field pair alone.

## 9.16 `run [...args]`

§9.15 with `commands.run` in place of `commands.use`: the band's script runner,
which is `pnpm run`, `yarn run`, `bun run`, and `deno task`. Everything else
about it — §09.2's resolution, verbatim forwarding, no banner, no writes, no
`JUP_MIGRATE_FROM`, the tool's own exit code — is §9.15's, from the same code.

```
argv := commands.run ++ args                                  # else §9.15's refusal
```

`jup run build --watch` is `jup pnpm run build --watch`. A bare `jup run` is a
bare `pnpm run`, which is how that manager lists its scripts; jup neither reads
the manifest's `scripts` nor claims a flag of its own, so what a script is, and
what an unknown one prints, stay the package manager's answers.

The refusal is §9.15's with the word the user typed:
`The 'jup run' command isn't supported for <name>@<reference>`. Every table entry
declares `commands.run`, and the field is argv rather than a subcommand name
precisely so deno's `task` can be spelled.

## 9.17 An unrecognised command word

A word §09's dispatch does not know is a **script**, not a mistake: `jup lint` is
`jup run lint`, with the word itself at the front of the forwarded arguments.

Three things keep `Unknown command "<word>"` instead.

* A **flag**. `jup --frobnicate` is a mistyped option, and no package manager's
  script runner would make more sense of it than jup does.
* A **reserved word**. `upgrade` was `self-upgrade`'s short spelling (§9.13) and
  is reserved for a project-level command; a project that happens to have a
  script of that name must not be what settles the question.
* The **`corepack` name** (`RunOptions.corepackCompat`, §9.11). The compatibility
  surface is corepack's, and a CI job that still says `corepack prepare` is owed
  the sentence saying the command is gone rather than a run of a script that is
  not there.

The command word reaches §12.1's presenter as itself, so an unrecognised one has
no `USAGE_LINES` entry and the generic `$ jup <command>` is what prints under a
project error. The word is a script name, not a command jup has usage for.

`jup <script>` never shadows §01.2's proxy mode: `parseArgs` classifies argv[0]
first, so a word the table knows as a binary — or any word with an `@` in it —
is a tool invocation and never reaches this switch.
