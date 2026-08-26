# 17 — Tool Domains, Roles, and the Command Router

## 17.1 Status of this section

Files 01–16 specify a package-manager version manager. This file widens the subject
from *package manager* to **tool**, of which a package manager is one kind and a
language runtime is another, and fixes the parts of the design that cannot be changed
later without breaking users:

* the noun the data model is built on (§17.3),
* the command surface and how an argument is classified (§17.4),
* the store location and the environment-variable namespace (§17.6),
* the shim policy (§17.6).

It does **not** specify runtime management. No runtime appears in §02.5's table, so
no runtime pin is read from any manifest today, and no conforming implementation is
required to install a runtime in order to conform. Where §17.5 says
`devEngines.runtime` **is** the pin, it is fixing the choice, not asserting that a
manifest is being read: the field is inert until the table has an entry whose role
makes it meaningful. §17.7 lists what is deliberately left
undecided, so that an implementer does not have to guess and a later section does not
have to contradict one.

Everything here is nonetheless **normative today**, because every requirement
describes behaviour that already exists: a package manager is a tool whose role set
is `{package-manager}`, and today that is the only role any table entry has. The
point of specifying it now is that the alternative — bolting a second noun on after
1.0 — costs a migration for every user, and §17.6's changes cost nothing while the
tool is pre-release.

## 17.2 Why the scope changes

§01.7 previously read *"A conforming implementation MUST NOT … manage Node.js
versions."* That line was inherited from corepack, where it is not a scope decision
but a statement of fact: corepack ships *inside* Node.js, so the runtime is its host
and cannot also be its subject. A standalone binary has no such constraint, and the
prohibition does not survive the change of host.

Four things make the extension small rather than speculative:

* **The machinery already generalises.** §15.28 makes the fetch and execution model
  accept per-platform native artifacts and `"exec": "native"` entries — which is
  exactly the shape a runtime distribution has. §07's store, §06's integrity tiers,
  §04's resolution, §15.23's ranges and lockfile, and §10's shims are none of them
  package-manager-specific. What is missing is the noun, not the mechanism.
* **The pin already has a home.** npm's `devEngines` defines `runtime` beside
  `packageManager`; §02.7 types the field this spec reads today and reserves the
  other. A project that pins the tool which *installs* its
  dependencies but not the tool which *runs its code* has pinned the smaller half of
  the problem, and the field it would use for the larger half is already in its
  manifest.
* **The user already has both problems.** The version skew that `packageManager`
  exists to prevent is the same skew a `.nvmrc` read by a different program prevents,
  with a second cache, a second shim directory, and a second set of failure modes.
* **The alternative is a second tool.** Two trampolines fighting over `PATH`, each
  unaware of the other's store, is worse for the user than one that knows it manages
  two kinds of thing.

The scope line does not disappear; it moves. §17.8 restates it.

> **Consent is unchanged.** §15.21 and §15.28 require a tool's maintainers to agree
> before it is added to the built-in table. Making the architecture *able* to manage
> a runtime is a separate question from whether any particular runtime is added, and
> this section decides only the first.

## 17.3 Tools and roles

The data model's primary noun becomes **Tool**. §02.3's `PackageManager` definition
is renamed and gains one field:

```ts
type Role = "package-manager" | "runtime"

Tool {
  name:            string,
  roles:           Role[],          // non-empty
  default:         string,
  fetchLatestFrom: RegistrySpec,
  transparent:     { default?: string, commands: string[][] },
  ranges:          OrderedList<(range, ToolSpec)>,
}
```

`PackageManagerSpec` (§02.4) is renamed `ToolSpec`. No other field changes, and every
existing entry in §02.5 is valid unchanged with `roles: ["package-manager"]`.

**R1 — One entry per tool, not per role.** A tool that is both a runtime and a
package manager (Bun and Deno are the obvious candidates) is **one** table entry with
two roles, one store directory, and one recorded default. It MUST NOT be modelled as
two entries. The artifact is one artifact; splitting it would download it twice and
let the two copies drift.

**R2 — Names are globally unique.** Tool names and binary names live in one flat
namespace, as they already do in §02.4's "union of all `bin` names". A role does not
create a second namespace, and no *user-facing* lookup is role-qualified: a user
never writes `pm:bun`, and a manifest never names a role beside a name.

> This is deliberately weaker than "no lookup is role-qualified anywhere". §17.7 #2 —
> a Node distribution contains an `npm`, and the table contains a different `npm` —
> may well need an internal provider relation to answer, and R2 must not foreclose
> one. What R2 fixes is the surface: whatever the answer, `npm` stays one name.

**R3 — Roles are data, not code.** As with §15.21's rule for names, the tool's own
structure MUST NOT branch on a literal role anywhere outside the table and the four
role-sensitive behaviours in the table below. Adding a runtime MUST be a data-only
change.

**R4 — What a role decides.**

| Concern | `package-manager` | `runtime` |
|---|---|---|
| Project pin field (§03) | `packageManager`, `devEngines.packageManager` | `devEngines.runtime` |
| **Project enforcement (§03.5)** | the invocation is reconciled against the package-manager pin | reconciled against the **runtime** pin, and never against the package-manager pin |
| **Transparent commands (§01.4)** | per the table's `transparent.commands` | a runtime has no transparent-command concept; every invocation is reconciled against its own pin, or falls back when there is none |
| `enable` with no names (§10, §15.16) | included | **excluded** — opt in by naming it (§17.6 C5) |
| Execution model (§08) | JS entry point via an interpreter, unless the band says `"exec": "native"` | `"exec": "native"` in practice; the same rule applies |
| Default scope word (§17.4) | `pm` | `runtime` |

The second row is the one an implementation is most likely to miss, and the symptom
is severe: without it, `node foo.js` in a project that pins pnpm reads the
`packageManager` field, finds a name that is not `node`, and fails with §12.5's
`This project is configured to use pnpm` — for running the runtime. **The role of the
invoked binary selects which pin it is reconciled against.** A project may pin one,
both, or neither, and a binary whose role has no pin takes the ordinary fallback path
(§03.5, §04.5).

Everything else — resolution, cache probe, integrity, store layout, last-known-good,
`use`/`up`/`pack`/`install` — is role-blind.

> **Error text is a known exception.** A dozen verbatim strings hardcode the noun:
> `Unsupported package manager specification`, `Invalid package manager name '<name>'`,
> `please specify the package manager to pack`, `This package manager (<name>) isn't
> supported…`. Under the `corepack` entry point they are frozen (§13, R12) and stay
> as they are. Under `jup` they are wrong the moment a runtime exists, and §17.6 C10a
> decides what they say instead: the noun is the scope in effect. This is not deferred to §17.7 because the wording is
> the compatibility contract.

**R5 — A dual-role tool needs a role only where a field is written.** Resolution and
installation never need one: `bun@1.2.3` is one locator and one directory whichever
role asked for it. Only a command that *writes a pin* has to know which field to
write, and §17.4 R11 says what happens when it cannot tell.

**R6 — The interpreter relationship is not a role.** A runtime that jup manages may
also be the interpreter jup uses to execute a JavaScript package manager (§08.3.1).
That is a use of an installed tool, not a property of the table, and it MUST NOT be
encoded as one.

## 17.4 The command router

### The problem

The surface in §09 is flat: one verb, and the tool it acts on comes from the
argument or the project. With two kinds of tool, three of those verbs become
ambiguous (`install`, `up`, `enable` with no arguments), and the corepack-compatible
entry point must keep meaning exactly what it means today.

### The shape

```
jup [<scope>] <verb> [...args]        management mode
jup <binary> [...args]                proxy mode
jup <name>@<version> [...args]        proxy mode, version override
```

`<scope>` is `pm` or `runtime`. It is **optional** at the top level and **implied**
when the binary is invoked as `corepack`.

**R7 — Classification order.** Argument classification MUST proceed in this order.
Steps 1 and 2 are corepack's rule (§01.2) and MUST keep their precedence, because
`corepack yarn --version` printing Yarn's version rather than corepack's is
test-asserted (§13 row 147) and because it is what makes the shim path work.

```
0. invoked-as: basename(argv[0]) is a known binary name and not one of the tool's
   own entry-point names (C1) → proxy mode with that binary (§10.1, §14.15)
1. arg0 matches /^([^@]*)(?:@(.*))?$/ and binaryName is a known binary name
                           → proxy mode
2. …binaryVersion is present (arg0 contained "@")
                           → proxy mode with an unknown tool (the §12.2
                             "Unsupported package manager specification" path)
3. arg0 is a top-level flag (`--version`, `--help`, `-h`)
                           → that command, in the scope in effect
4. arg0 is a scope word    → shift it; the NEXT token is classified by steps 3, 5
                             and 6 only — a top-level flag, a verb, or nothing —
                             and the command runs scoped to that role. A second
                             scope word falls to step 7
5. arg0 is a verb          → management mode, role inferred per R10
6. arg0 is absent, or `--` → help, in the scope in effect, exit 0
7. otherwise               → unknown-command usage error (§12.9)
```

Three consequences worth stating, because omitting the flag branch is the easy
mistake and it makes `jup --version` an unknown command:

* Steps 1 and 2 cannot match a token beginning with `-`; an implementation MAY test
  for the leading `-` first as an optimisation, but MUST NOT let that reordering
  change which mode a non-flag argument reaches.
* `jup pm` and `corepack` with no further token print that scope's help and exit 0
  (step 4 → step 6). A scope word is never a command by itself.
* `--` terminates the tool's own options. Everything after it belongs to the command
  or, in proxy mode, to the package manager, which already receives its arguments
  verbatim (§08.1). A scope word after `--` is an ordinary argument.

**R8 — Disjointness invariant.** The four sets

```
NAMES         = BINARY_NAMES ∪ TOOL_NAMES      (from the table, §02.4)
SCOPE_WORDS   = { pm, package-manager, rt, runtime }
VERBS         = the command words in §09's synopsis, plus §15.30's `info` and
                §15.34's `project` — one list, derived from the surface, never
                written out twice
RESERVED      = { run, exec, shim, self, doctor, env, list, ls, which, clean,
                  add, remove, init, version, node, deno, bun }
```

These four sets MUST be pairwise disjoint, and an implementation MUST assert it at
**build time**, not at runtime. R7's ordering means a collision does not produce an
error — it silently makes one of the two spellings unreachable, which is the failure
mode a test does not catch. `NAMES` is a union precisely because `yarn` is both a
tool name and a binary name; that overlap is normal and is not what the invariant is
about.

`SCOPE_WORDS` holds **both spellings of both scopes**, all four accepted
interchangeably, so that neither the abbreviation nor the full word can later be
spent on something else. `RESERVED` holds words that are not used today and MUST NOT
become tool names, binary names, scope words, or verbs; `node`, `deno`, and `bun` sit
there rather than in `NAMES` because no runtime is in the table yet, and move sets
when one is added.

**Collision with the ecosystem.** The invariant binds *this table*; it cannot bind
the world. If a real package manager ships a binary named `pm`, `rt`, or a reserved
word, the scope word wins and the tool stays reachable two ways that R7 already
provides — `jup pm@1.2.3 …` (step 2) and a shim on `PATH` (step 0) — with the
build-time assertion failing until the table records the decision. A scope word MUST
NOT be renamed to accommodate a name collision: the scope word is in users' shell
history and CI files, and the tool's own binary name is not.

**R9 — Scope narrows, never widens.** `jup pm <verb>` behaves exactly as `jup
<verb>` except that every tool it considers must have the `package-manager` role. A
scoped command given a spec naming a tool without that role is a usage error:

```
'<name>' is not a package manager - run 'jup runtime <verb> <spec>' instead
'<name>' is not a runtime - run 'jup pm <verb> <spec>' instead
```

**R10 — Role inference for an unscoped command.**

| Command form | Role |
|---|---|
| Carries a spec argument (`use pnpm@10`, `install -g node@22`, `pack yarn`) | the roles of the named tool (R11 if more than one) |
| Acts on the project and takes no spec (`install`, `pack`, `up`) | **every role the project pins**, in a fixed order: package manager first, then runtime |
| Carries an archive path (`install -g <file>.tgz`, `hydrate <file>`) | role-blind — the archive names its own contents, and §07.10 validates each `<name>/<version>` subtree against the table exactly as it does today |
| Reports (`info`, `cache list`, `--version`, `--help`) | role-blind; a scope filters what is *reported*, nothing else |
| **Mutates the store** (`cache clean`, `cache clear`) | role-blind **and refuses a scope** — see below |
| `enable` / `disable` with no names | package-manager role only (R4) |
| `install --project` / `project install` (§15.34) | package-manager role only; it runs `commands.use`, which is a package-manager concept (§17.7 #6) |

Row 2 is what removes the need for an ambiguity error on the common commands: a
project that pins both gets both installed by one `jup install`, which is what a user
would expect and the reason the flat surface survives. It has three consequences that
MUST be specified rather than left to the implementation:

* **§09.1 returns a list.** `resolvePatternsToDescriptors([])` yields one descriptor
  per pinned role, in the fixed order above, instead of the single descriptor §09.1
  returns today. With one pinned role — every project today — the list has one
  element and every §09 command behaves exactly as specified there.
* **Roles are resolved independently and do not short-circuit each other.** A failure
  resolving or installing one role MUST NOT skip the others; each prints its own
  line, in order, and the command exits non-zero if any role failed. Aborting on the
  first failure would make `jup install` in CI report a runtime problem as a package
  manager problem, or hide it entirely.
* **`up` writes both pins in one atomic manifest update** (§15.26), not one write per
  role. A half-updated manifest is the failure §15.26 exists to prevent.

Row 5 is not a filter. `cache clean` is `rm -rf <home>/v1` (§07.9), so treating a
scope as "reporting only" would make `jup runtime cache clean` silently destroy every
cached package manager. A scope word on `cache clean` or `cache clear` is a usage
error until a revision specifies per-role pruning:

```
'cache clean' is not scoped - it removes the whole store; run 'jup cache clean'
```

`cache list` is unaffected: it reports, so a scope filters it (row 4).

**R11 — Dual-role specs.** When a spec names a tool with more than one role and the
command writes a pin (`use`, `up`, auto-pin), the role MUST be resolved as:

1. an explicit scope word, if given;
2. otherwise, **the role under which the binary was invoked**, when there is one —
   in proxy mode and therefore in auto-pin (§03.6), `bun install` is a
   package-manager use of the binary and `bun run x` a runtime use, and the tool
   already knows which because it had to choose an execution path;
3. otherwise, the roles the project **already** declares for that tool — if the
   manifest pins `bun` as its package manager, `jup use bun@1.2.3` updates that pin
   and nothing else;
4. otherwise, a usage error naming both spellings:

```
<name> can be both a package manager and a runtime - run 'jup pm use <spec>' or 'jup runtime use <spec>'
```

Never guess. Writing the wrong field here silently changes which program runs the
user's code.

Step 2 is what keeps auto-pin from becoming permanently unreachable for a dual-role
tool: it fires only in the `NoSpec` case in proxy mode (§03.6), where step 1 has no
CLI to read and step 3 has no declaration to read, so without it every auto-pin of
`bun` or `deno` would be the step-4 error. If even the invocation is ambiguous, the
`package-manager` role wins, because auto-pin's own verbatim notice is about the
`packageManager` field.

**R12 — The `corepack` entry point.** When the tool is invoked under the name
`corepack` (§17.6 C1), it behaves as `jup pm` with three additions:

* scope words are **not** accepted — `corepack pm use …` and `corepack runtime use …`
  are unknown-command errors, and the second says
  `runtime management is not available through the 'corepack' command - use 'jup runtime <verb>'`;
* every verbatim message that names the tool keeps its corepack spelling (§12), and
  usage lines read `$ corepack <verb> …`;
* it is otherwise the same code path. It MUST NOT be a separate implementation, a
  translation layer, or a subset that drifts.

Under any other name, usage lines name the invoked binary and the scope actually in
effect: `$ jup use <pattern>`, `$ jup pm use <pattern>`.

**R13 — Nothing is deprecated by this change.** `jup use pnpm@10` keeps working and
keeps its meaning. `jup pm use pnpm@10` is the same command written with its scope
made explicit. An implementation MUST NOT print a migration notice for the unscoped
form, and MUST NOT plan to remove it: a router that can infer the role is strictly
friendlier than one that demands a namespace, and the namespace exists for the cases
where inference genuinely cannot decide (R10 row 4, R11).

## 17.5 Where the runtime pin comes from

Reserved now so that §03 does not have to be redesigned later. Only the first two
rules are normative today.

**R14 — `devEngines.runtime` is the pin.** It is parsed, validated, and reconciled by
the same rules §03.3 applies to `devEngines.packageManager`, including `onFail` and
including §15.26's requirement that every field encoding one logical pin is updated
atomically. There is no top-level `runtime` field and this specification MUST NOT
invent one; `packageManager` is a historical shape, not a pattern to repeat.

**R15 — `engines.node` is not a pin and MUST NOT be used to select a version.** It
declares the range a package is *compatible with*, is written by library authors for
consumers, and is routinely open-ended (`>=18`). Resolving it would install the
newest release in the world on a project that merely said it does not need anything
older. It MAY be *checked* against the resolved runtime and reported; it MUST NOT
drive resolution.

**R16 — Foreign version files are deferred.** `.nvmrc`, `.node-version`, and
`.tool-versions` are not read. If a later section adopts any of them it MUST be as a
lower-precedence fallback behind an explicit opt-in, never as a silent input to the
walk in §03.1 — a file that changes which binary runs, discovered by a walk the user
did not know was happening, is the failure §15.35k already exists to mitigate.

## 17.6 Breaking changes adopted now

Each is cheap today and expensive after 1.0. Each is independent of whether a runtime
is ever added.

| # | Change | Before | After | Why now |
|---|---|---|---|---|
| **C1** | Entry-point names | `corepack`, `jup` | **one** binary; `jup` is its name and `corepack` a second name for the same file, defined as an alias for `jup pm` (R12). See C1′ below | Fixes what a compatibility promise covers before anyone relies on a wider reading of it |
| **C2** | Store home | `COREPACK_HOME` ?? `<cache>/node/corepack` | `JUP_HOME` ?? `COREPACK_HOME` ?? `<cache>/jup` (§07.1) | A directory named `node/corepack` is the wrong place to put a Node.js distribution, and a real corepack's `cache clean` would delete it |
| **C3** | Install marker | `.corepack` | `.jup` written; **both** accepted on read (§07.2, §07.10) | Dual-read keeps a warm corepack store usable, at one extra `stat` on a store jup did not write |
| **C4** | Env prefix | `COREPACK_` canonical, `JUP_` an alias (§14.22) | `JUP_` canonical everywhere. Two tiers, closed: corepack's own variables (§11.1–§11.4) keep both spellings permanently; variables this spec invents (§11.5, §15.37) are **`JUP_`-named**, accept `COREPACK_` only as a legacy alias, and are documented and reported under `JUP_`. Nothing added after §17 gets a `COREPACK_` spelling at all (§11.6) | A `COREPACK_` alias is compatibility where corepack had the variable and fiction where it did not — nobody's CI sets `COREPACK_MINIMUM_RELEASE_AGE` |
| **C5** | `enable` default set | every tool in the table except npm, then (§15.16) including npm | every tool with the `package-manager` role; runtime shims only when named explicitly or under `jup runtime enable` | Occupying `node` on `PATH` is a different order of intervention from occupying `yarn`, and a user who typed `jup enable` did not ask for it |
| **C6** | `--help` output | one flat list | scope-aware: `jup --help` shows both scopes, `jup pm --help` and `corepack --help` show the package-manager surface | The help text is the surface's documentation; it has to be able to describe a scope |

**C7 — No interpreter lookup may resolve to a shim.** Once `node` is a name this
tool can shim, any lookup of `node` can find that shim, re-enter the tool, and look
up `node` again. The recursion is unbounded and its symptom is a hang or a fork bomb,
not an error.

The guard is a property of **every** path that picks an interpreter, not of one of
them. There are four, and the two most dangerous run before the one that is easiest
to notice:

| Path | Where | Guard |
|---|---|---|
| The sibling-runtime preference — "a tool distributed alongside a runtime SHOULD prefer the sibling binary" | §08.3.1 | After `jup enable node`, the sibling in the shim directory **is** jup. Skip it. |
| A generated shim's own `node` lookup — `%~dp0\node.exe` on Windows, `$basedir/node` in the sh shim | §10.3 | Same directory, same problem, and it makes a `node` shim the interpreter for every *other* shim beside it. A generator that emits these MUST emit a form that cannot select a sibling shim. §14.15's self-dispatching model has no generated shim and is unaffected. |
| `#!/usr/bin/env node` on a JavaScript implementation's shims | §10.1 | Resolves through `PATH` before the tool gets control at all. §15.14 already requires replacing these; this is a second reason. |
| The tool's own `PATH` search | §08.3.1 step 3 | Skip and continue past every candidate that is one of the tool's shims. |

**Recognising a shim MUST NOT rely on identity with the tool's own executable.** That
test works only for §14.15's symlink-or-hardlink model; under §10.1's generated-script
model a shim is a different file with a different inode and the comparison never
fires. Use the record of shims the tool wrote — §15.15 already requires keeping one so
that `disable` can restore what it displaced — and fall back to the identity test for
a shim the record does not cover. If every candidate is excluded:

```
Every 'node' on PATH is a jup shim; set JUP_NODE_EXECPATH to a real runtime
```

**§15.32 makes this reachable without any `PATH` of the user's.** It prepends the
shim directory to `PATH` for every child process, so a `node` shim reaches everything
a package manager spawns, ahead of the real runtime. That is a *feature* for a pinned
runtime and a hazard for the tool's own lookups; the guard above is what separates
them, and §17.7 #4 decides only the ordering question, not this one.

This is the one genuinely new failure mode the extension introduces, and it is
silent-and-fatal rather than loud-and-obvious, so it is specified before the feature
that creates it. Whether a *project-pinned* runtime is preferred over `PATH` is a
precedence question, not a hazard, and is deferred to §17.7 #3.

**C1′ — What the two entry-point names are.** The tool ships as **one** executable.
`jup` is its name; `corepack` is a second name for the same file, created the same way
a shim is (§10.1, §14.15) and installed by whatever installs the tool — never by
`enable`, which manages the *managed tools'* names and not the tool's own. Both names
are members of "the tool's own entry-point names" in R7 step 0, so neither is ever
mistaken for a shim. Two consequences:

* §10.4 resolves the shim install directory from the tool's own path (§14.17), not
  from a `PATH` lookup of a particular name, so the answer is the same under either.
* A real corepack earlier on `PATH` wins for the name `corepack`, exactly as any
  earlier `PATH` entry wins for any name. §15.29's post-`enable` verification already
  reports a shadowed name; the same diagnostic covers this, and the tool MUST NOT try
  to detect or displace another program's `corepack`.

**C9 — The user-visible corepack-named files are renamed too.** C2 and C3 rename what
nobody types. These are what users type, commit, and `.gitignore`, and each takes the
same dual treatment: write the `jup` spelling, accept the `corepack` spelling on read,
and prefer the `jup` spelling in every message.

| Thing | Was | Is | Read-compat |
|---|---|---|---|
| Env file (§03.2) | `.corepack.env` | `.jup.env` | `.corepack.env` still read when `.jup.env` is absent, in the same directory, same rules |
| Resolution lockfile (§15.23) | `.corepack.lock` | `.jup.lock` | same; the verbatim error names the file it actually looked at |
| `pack` output (§07.10, §09.6) | `corepack.tgz` | `jup.tgz` | `-o` unaffected; `install -g <file>.tgz` never depended on the name |
| Windows shim directory (§15.13) | `%LOCALAPPDATA%\node\corepack\bin` | `%LOCALAPPDATA%\jup\bin` | none needed — `disable` reads what `enable` recorded (§15.15) |
| Store temp-dir prefix (§07.2) | `corepack-<pid>-<hex>` | `jup-<pid>-<hex>` | none needed — transient |

`COREPACK_ENV_FILE`'s default follows the env file, under both spellings of the
variable (C4). The lockfile is the strongest case of the five: it lives at the
**project root**, is committed to git, and is named in a verbatim error message, so
every day it is called `.corepack.lock` is a day the rename gets more expensive.

**C10 — User-facing text names the invoked entry point.** Corepack's messages say
"corepack" and "Corepack" in their *bodies*, not only in usage lines: `The 'corepack
up' command can only be used…`, `did it get generated by 'corepack pack'?`,
`! Corepack validation warning:`, `! Corepack will now add one referencing…`. Under
the `corepack` entry point they are frozen, byte for byte, and §13's rows assert them
(R12). Under `jup` they name `jup`, in the body as well as the usage line — a
`jup runtime` command reporting "Corepack validation warning" is a worse outcome than
a diff against a message no script running `jup` has ever matched.

Two constraints on the substitution: it is a **name** substitution, not a rewrite —
the same sentence, the same punctuation, the same interpolations, so a reader can
still match the two — and it never applies to a name that belongs to something else
(`packageManager`, `devEngines`, `COREPACK_*` variables under their legacy spelling,
`https://nodejs.org/api/packages.html#packagemanager`). §12.1 states the rule; §13
runs its rows through the `corepack` entry point (§13.1).

**C10a — The noun follows the scope in effect.** R4 defers to this section a second
set of verbatim strings: the ones that hardcode *package manager* as the **kind of
thing** being named — `Unsupported package manager specification`, `Invalid package
manager name '<name>'`, `please specify the package manager to pack`, `This package
manager (<name>) isn't supported…`. They are decided here on the same terms as the
name, and for the same reason: `jup runtime install -g node@22` answering
`Unsupported package manager specification` is not a compatibility win, it is a
sentence that contradicts the command that produced it.

The noun is **the scope in effect** (§17.4), not the role of anything resolved:

| Invocation | Noun |
|---|---|
| the `corepack` entry point | `package manager`, frozen byte for byte (R12) |
| an explicit scope | that scope's noun — `runtime` under `jup runtime`, `package manager` under `jup pm` |
| unscoped `jup` | `package manager` |

Unscoped stays corepack's wording deliberately. A command that fails *before* it has
resolved a name has no role to report, and R10's inference cannot supply one — the
name it would infer from is the name that just failed. Guessing there would trade a
wording that is merely dated for one that is wrong.

Two constraints, mirroring the name substitution:

* It is a **noun** substitution, not a rewrite: the same sentence, the same
  punctuation, the same interpolations.
* It applies only where the noun names *the kind of tool the command is acting on*.
  It MUST NOT touch a `packageManager` or `devEngines.packageManager` **field name**,
  which names something else — including in the messages that validate that field,
  where the field is the subject of the sentence and the noun is not a noun about the
  command at all (`Invalid package manager specification in <source>; expected a
  string` is a statement about a malformed `packageManager` field under every scope).

Where one sentence carries **both** — `The local project doesn't feature a
'packageManager' field nor a 'devEngines.packageManager' field - please specify the
package manager to pack` — the field names move with the noun, to the fields that
scope's role actually reads (§17.5 R14). A message that names the package-manager
fields while asking for a runtime is the incoherence this clause exists to remove,
and naming half of it correctly is worse than naming none of it.

**C8 — No migration is performed.** C2 and C3 abandon an existing corepack cache
rather than moving it, exactly as §07.1's `v1` segment abandons an old layout. The
cost is one re-download per tool per machine; the alternative is migration code that
runs on the hot path forever to serve one release.

## 17.7 Deliberately left undecided

Recorded so that no implementer infers an answer from silence. Each MUST be decided
by a future revision of this file before any runtime is added to §02.5.

1. **Which runtimes**, and on whose agreement (§15.21, §15.28). Nothing in this file
   grants that.
2. **Node's bundled npm.** A Node distribution contains an `npm`, and §02.5's table
   contains a different `npm`. Which one a shimmed `npm` reaches, whether a pinned
   runtime's bundled npm satisfies a `packageManager` pin, and what happens when the
   two disagree, are unresolved. This is the sharpest open question in the extension
   and the most likely source of a surprising bug. Answering it may require an
   internal provider relation ("this runtime supplies that binary"); R2 is scoped to
   the user-facing surface so that it does not foreclose one.
3. **Whether a pinned runtime is used to execute a JavaScript package manager**, and
   with what precedence against `JUP_NODE_EXECPATH` and `PATH` (§08.3.1, C7 fixes
   only the recursion hazard).
4. **`PATH` for child processes.** §15.32 puts the resolved package manager on
   `PATH`; whether a resolved runtime joins it, and in which position, is open.
5. **Multiple specs per command** — `jup use node@22 pnpm@10` — and whether `use`
   becomes variadic like `pack` already is.
6. **A `COREPACK_MIGRATE_FROM` analogue** for runtimes, and whether
   `commands.use` has any meaning for a runtime at all.
7. **Windows shim behaviour for a runtime**, where §10.3's three-file scheme meets
   programs that are commonly launched by other programs rather than by a shell.
8. **Platform/arch coverage** beyond §15.28's `linux|darwin|win32 × x64|arm64`, and
   what a request from an uncovered platform says.

## 17.8 The scope line, restated

§01.7's prohibition on managing Node.js versions is withdrawn. Everything else in it
stands, and §15.34's adopted rulings stand unchanged — none of them is about
runtimes. The line now reads:

> jup manages **the tool that installs a project's dependencies** and **the tool that
> runs a project's code**. It does not run the project's scripts (§15.34/#57), does
> not proxy a package manager's verbs (§15.34/#352), does not manage task runners
> (§15.34/#683), and does not manage development tools in general — linters,
> formatters, compilers, or anything else a project happens to depend on. Those have
> a package manager, which is the tool jup already manages.

The test for a proposed addition is not "could jup install this?" — it could install
anything — but "does a version mismatch here break the project for everyone who
clones it, before any dependency is installed?" That is true of the package manager
and of the runtime, and of nothing else.

## 17.9 Conformance

Appended to §13, and subject to two harness amendments (§13.1): rows 215–216 set the
store-home variables themselves rather than inheriting a fresh `COREPACK_HOME`, and
rows 208–232 that exercise a role need the **test-only table fixture** described
below.

**The fixture.** §02.5 contains no runtime, so every role-sensitive requirement —
R4's enforcement row, R9, R10 row 2, R11, C5 — is vacuously satisfied by an
implementation that ignores roles entirely. The harness MUST therefore be able to
substitute a table containing one fixture tool with `roles: ["runtime"]` and one with
both roles, served by the same mock registry as every other row. This is a test seam,
not the user-extensible registry §01.7 and §15.21 forbid: it is not reachable from a
released binary, from the environment, or from any file a project can contain.

| # | Setup | Expected |
|---|---|---|
| 208 | `jup use pnpm@<v>` and `jup pm use pnpm@<v>` in equivalent projects | identical stdout, stderr, exit code, and manifest result on the **success** path (R13); row 213 covers the usage line that differs on failure |
| 209 | `jup pm yarn --version` | `Usage Error:` on stdout, exit 1 — a scope word takes a verb or a top-level flag, never a binary (R7 step 4, §12.9) |
| 210 | `jup yarn --version` | **yarn's** version; step 1 still outranks the verb table (R7, §13 row 147) |
| 211 | `jup --version`, `jup --help`, `jup pm --help`, `jup pm`, bare `jup` | each succeeds, exit 0; the scoped forms print the package-manager surface (R7 steps 3/4/6, C6) |
| 212 | `corepack pm use pnpm@<v>` | unknown-command usage error (R12) |
| 213 | `corepack runtime enable` | the R12 message naming `jup runtime <verb>` — so the corepack path recognises the scope words in order to refuse them; exit 1 |
| 214 | `corepack use pnpm@<v>` failing | usage line `$ corepack use <pattern>` and a body naming `corepack`; the same failure under `jup pm` reads `$ jup pm use <pattern>` and names `jup` (R12, C10) |
| 215 | Build-time check over R8's four sets | fails the build when a table entry is named `pm`, `runtime`, `use`, or any `RESERVED` word. A build/unit assertion, not a `(exitCode, stdout, stderr)` row — §13.1's harness rule does not apply |
| 216 | Neither `JUP_HOME` nor `COREPACK_HOME` set | store is `<cache>/jup`, not `<cache>/node/corepack` (C2) |
| 217 | Both `JUP_HOME` and `COREPACK_HOME` set | `JUP_HOME` wins (C2, §11.6) |
| 218 | A store directory holding only a `.corepack` marker | treated as a valid warm install; a fresh install alongside it writes `.jup` (C3) |
| 219 | `pack`, then `install -g` on its output | round-trips; the default output is `jup.tgz` (C9); an archive whose markers are all `.corepack` also installs, and neither is reported as `Invalid archive format` (§07.10) |
| 220 | A project containing `.corepack.env` and no `.jup.env` | it is read, with the same rules and the same §14.5 deny-list; `.jup.env` wins where both exist (C9) |
| 221 | A range pin resolved with no lockfile, then re-run | `.jup.lock` is written and honoured; a pre-existing `.corepack.lock` is honoured (C9, §15.23) |
| 222 | *(fixture)* `jup enable` with no names | package-manager shims only; no shim for the runtime-role fixture (C5). `jup runtime enable` creates it |
| 223 | *(fixture)* A `node`-equivalent shim planted first on `PATH`, then a JS package manager run | the shim is skipped, the search continues to the real runtime, and it runs — no recursion (C7) |
| 224 | *(fixture)* Same, with every candidate a shim | C7's message; exit 1 |
| 225 | *(fixture)* Project pins the runtime fixture only; a package manager is invoked | no `This project is configured to use …` error — enforcement is per role (R4) |
| 226 | *(fixture)* Project pins a package manager; the runtime fixture's binary is invoked | likewise no mismatch error; the runtime falls back (R4) |
| 227 | *(fixture)* Project pins both; `jup install` | both are installed, package manager first, each with its own output line (R10 row 2) |
| 228 | *(fixture)* Same, but the runtime's version does not exist | the package manager still installs, the failure is reported for the runtime, exit is non-zero (R10 row 2) |
| 229 | *(fixture)* `jup up` on a project pinning both | one manifest write containing both updated pins (R10 row 2, §15.26) |
| 230 | *(fixture)* `jup pm use <runtime-only tool>@<v>` | R9's `is not a package manager` message naming the other spelling |
| 231 | *(fixture)* `jup use <dual-role tool>@<v>` with nothing declared | R11's both-spellings usage error; with the tool already declared in one field, that field is updated and no error |
| 232 | *(fixture)* Auto-pin in proxy mode for the dual-role fixture, nothing declared | the pin is written for the role the binary was invoked under — no usage error (R11 step 2) |
| 233 | `jup runtime cache clean` | usage error; the store is untouched. `jup cache clean` removes it (R10 row 5) |
| 234 | `install -g <unknown name>@<v>` under each of `corepack`, `jup`, `jup pm`, `jup runtime` | the first three say `Unsupported package manager specification (<raw>)` byte for byte; the fourth says `Unsupported runtime specification (<raw>)` (C10a) |
| 235 | *(fixture)* `jup runtime pack` in a project pinning only a package manager | the "no spec" error names the **runtime** and `devEngines.runtime`; the same command under `jup pm` is byte-identical to today's (C10a's both-halves rule) |
| 236 | A manifest whose `packageManager` field is not a string, read under `jup runtime` | `Invalid package manager specification in <source>; expected a string` — unchanged, because the field is the subject of the sentence (C10a's exclusion). The negative row: it fails if the substitution overreaches |

Rows conditional on a *real* runtime being in the table — which one, its artifact
shape, its platform matrix — are not written here; they belong with the revision that
adds one (§17.7).
