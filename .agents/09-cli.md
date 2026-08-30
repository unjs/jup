# 09 — Command Surface

This is the complete surface. Anything not here is out of scope (§01.7).
`--help` prints it; `src/commands/usage.ts` holds the text.

```
jup <binary>[@<version>] [...args]     proxy mode (§01.2)

jup cache clean [--all]
jup cache clear [--all]
jup cache install
jup cache install -g|--global [--cache-only] [...name[@<version>] | <file>.tgz]
jup cache list [--json]
jup disable [--install-directory <path>|--system] [--exclude <name>] [...name]
jup enable  [--install-directory <path>|--system] [--exclude <name>] [--force] [...name]
jup info [--json]
jup pack [--json] [-o|--output <path>] [...name[@<version>]]
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
name from the default set (`--exclude npm` being the common case).

## 9.9 `info`

Prints, with **no request of any kind**, what the next run would do and why:

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
  long values are elided.

`--json` emits the same report with a `version` field, bumped only for a breaking
shape change.

## 9.10 `--version`, `--help`

`--version`/`-v` prints jup's own version; `--help`/`-h`/`help` prints the
surface above. The synopsis lists only the long spelling of each; the short and
bare forms are aliases corepack also accepts, kept so a hand or a script that
reaches for `-v` is not met with `Unknown command`. Both are ordinary management
commands and are shadowed by proxy mode: `jup yarn --version` is a *proxy*
invocation and prints Yarn's version.

## 9.11 (retired) Deprecated commands

`hydrate` and `prepare` were corepack's predecessors of `cache install -g
<file>.tgz` and of `pack` + `cache install -g`. They were dropped before publication:
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
