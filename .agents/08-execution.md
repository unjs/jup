# 08 — Handing Over Control

The final step: run the package manager so convincingly that neither the user nor the
package manager itself can tell a trampoline was involved.

## 8.1 Locating the entry point

```
bin := installSpec.bin ?? spec.bin

if bin is a LIST:
    if binName is in the list:
        ext := extension of the spec.url path
        if ext === ".js":
            binPath := <location>/<basename of the spec.url path>
        # any other extension leaves binPath unset → assertion failure below
else:                                   # bin is a MAP
    binPath := <location>/<bin[binName]>   for the matching key

if binPath is unset:
    → Error `Assertion failed: Unable to locate path for bin '<binName>'`
```

`bin[binName]` values are relative paths that may begin with `./` — join them
naively, do not normalise away the possibility that they escape (they come from a
downloaded `package.json` in the untrusted-tarball case).

> **Divergence (§14.13):** when `bin` comes from an extracted `package.json` rather
> than the embedded table, `bin[binName]` is attacker-controlled. A conforming
> implementation MUST resolve it and verify the result stays inside `<location>`,
> erroring otherwise. Corepack does not check this.

## 8.2 The reference execution model: in-process

The reference implementation does **not** spawn a subprocess. It loads the package
manager's entry module into its own process after rewriting the process state to look
like a direct invocation:

```js
process.env.COREPACK_ROOT = <directory containing the tool's own package.json>
process.argv    = [process.execPath, binPath, ...args]
process.execArgv = []
process.mainModule = undefined          // let the runtime set it
process.nextTick(runMain, binPath)      // unwind the stack first
```

Why each line exists:

| Line | Reason |
|---|---|
| `argv = [execPath, binPath, …]` | Yarn reads `process.argv[1]` to locate itself |
| `mainModule = undefined` | pnpm checks `require.main == null` to detect its own version |
| `execArgv = []` | the package manager must not inherit the tool's own runtime flags |
| `nextTick` | removes the tool's frames from any stack trace the package manager prints |
| `COREPACK_ROOT` | lets package managers feature-detect that they are running under a version manager (Yarn's `yarn init` uses it) |

This model is why the observable exit-code semantics in §8.4 are what they are.

### Compile cache

If the runtime exposes a module compile cache, it is enabled — except for
`npm >= 9.7.0`, where the older userland compile-cache package segfaulted. The guard
is `locator.name !== "npm" || semverLt(locator.reference, "9.7.0")`.

This is a Node-specific performance detail with **no observable contract**. A
re-implementation ignores it.

## 8.3 The execution model for a native implementation

A native implementation cannot load a JavaScript module into itself. It **MUST**
spawn a child process, and it MUST reproduce the observable behaviour of the
in-process model. This is the single largest divergence in the spec, so it is
specified precisely.

### 8.3.1 Choosing the interpreter

The package manager entry points are JavaScript — unless the band declares
`"exec": "native"` (§15.28), in which case this whole subsection is skipped and the
bin target is executed directly. Otherwise the tool must locate a JavaScript runtime:

1. If `JUP_NODE_EXECPATH` is set, use it. *(New in this spec — see §11.)*
2. Otherwise, a tool distributed *alongside* a runtime (the way corepack ships inside
   Node) SHOULD prefer the sibling runtime binary — **unless that sibling is one of
   its own shims** (§17.6 C7), which after `enable node` it may well be.
3. Otherwise search `PATH` for `node`, **skipping every candidate that is one of the
   tool's own shims** and continuing past it (§17.6 C7).
4. If not found → error:
   `Unable to locate a Node.js runtime to execute <binName>; set JUP_NODE_EXECPATH to point at one`
   — or, when every candidate was excluded by steps 2–3:
   `Every 'node' on PATH is a jup shim; set JUP_NODE_EXECPATH to a real runtime`

> **The exclusions in steps 2 and 3 are not optional.** Once `node` is a name this
> tool can shim (§17.3 R4), either lookup can find the tool's own shim, which
> re-enters the tool, which looks up `node` again. The recursion is unbounded and its
> symptom — a hang or a fork bomb, not an error — is why the rule is written before
> the feature that creates it. §17.6 C7 specifies how a shim is recognised (from the
> record `enable` keeps, per §15.15, *not* from identity with the tool's own
> executable, which only holds for §14.15's link-based shims), and lists the two
> further lookups outside this section that need the same guard: §10.3's generated
> shims and §15.32's `PATH` injection.
>
> §17.7 #3 leaves open whether a *project-pinned* runtime is preferred here. When it
> is decided it lands between steps 1 and 2, and it does not change either exclusion.

### 8.3.2 Spawning

```
argv := [nodeExecPath, binPath, ...args]
env  := parentEnv
        + COREPACK_ROOT=<tool's own root>
        - any variable the tool set only for its own use
cwd  := unchanged (the caller's cwd, NOT the project root)
stdio: inherit all three, unmodified
```

Requirements:

* **`stdio` MUST be inherited, not piped.** Package managers detect TTYs to decide on
  colour, progress bars, and interactive prompts. Piping breaks all three. This is
  also why the reference implementation's in-process model works transparently.
* **The child MUST become the process group leader only if the tool does not need to
  forward signals** — see §8.5.
* On POSIX, an implementation MAY `exec()` instead of `fork()`+`wait()` once it has
  nothing left to do. This is strictly better: it removes a process from the tree,
  makes signal handling automatic, and makes exit-code propagation exact. **This is
  the RECOMMENDED model.** It is only possible because every write the tool performs
  (store promotion, last-known-good, pin writing) happens *before* handover.
* On Windows, `exec` has no equivalent; spawn and wait, forwarding console control
  events (§8.5).

### 8.3.3 What `exec` buys, concretely

| Property | in-process (reference) | `exec` (recommended) | spawn+wait |
|---|---|---|---|
| Exit code fidelity | exact | exact | exact if mapped correctly |
| Signal delivery | exact | exact | requires forwarding |
| TTY / job control | exact | exact | mostly, with care |
| Extra process in `ps` | no | no | yes |
| Peak RSS | one runtime | one runtime | two processes briefly |
| Startup cost | zero extra | one `execve` | one fork + one exec |

## 8.4 Exit codes

The contract, verified by the conformance suite:

| Package manager does | Tool exits with |
|---|---|
| sets exit code 42 synchronously | **42** |
| sets exit code 42, then throws an uncaught error | **1**, error message on stderr |
| sets exit code 42 only in a `beforeExit` hook | **42** |
| exits normally | **0** |
| is killed by signal N | killed by signal N (POSIX), or `128+N` if the runtime cannot re-raise |

The second row is the runtime's own rule — an uncaught exception resets the pending
exit code to 1 — and the tool must **not** override it. Corepack's changelog records
a bug where it did (`don't override process.exitCode`, 0.18.1).

For the tool's **own** errors:

| Error class | Output stream | Exit code |
|---|---|---|
| `UsageError` in proxy mode | stderr, message only, no stack | 1 |
| `UsageError` in management mode | **stdout**, prefixed `Usage Error: `, followed by a blank line and the command's usage line | 1 |
| Any other error | stderr, with stack | 1 |

The stdout-vs-stderr split for `UsageError` between the two modes is a real,
test-asserted difference and MUST be preserved. See §12 for the exact formats.

## 8.5 Signals

The reference implementation inherits signal behaviour for free because there is only
one process. A spawning implementation MUST NOT regress this.

Requirements for the spawn+wait model:

* **Do not install handlers that swallow signals.** `SIGINT` from a terminal is
  delivered to the whole foreground process group, so the child receives it directly;
  the tool must simply wait and then reflect the child's status.
* Forward `SIGTERM`, `SIGHUP`, `SIGQUIT`, and `SIGUSR1/2` to the child if the tool
  receives them directly (not via the group).
* **Do not** create a new process group or session for the child — that detaches it
  from terminal job control and breaks Ctrl-C.
* When the child is killed by signal N, the tool SHOULD reset its own handler for N
  to default and `raise(N)` so that the parent shell sees a signal death rather than
  a numeric exit. Falling back to exiting `128+N` is acceptable.
* On Windows, forward `CTRL_C_EVENT` / `CTRL_BREAK_EVENT`.

With the `exec` model, none of this applies — the kernel does it.

## 8.6 stdin

stdin MUST be passed through untouched. Two cases matter:

* Package managers read stdin for prompts (`npm init`, `yarn init`).
* Package managers are frequently used in pipelines (`echo … | npm publish`).

The one place the tool itself reads stdin is the download prompt (§05.5), which
happens strictly *before* handover and only when stdin is a TTY. A conforming
implementation MUST NOT consume buffered stdin bytes it did not need — read exactly
one chunk, and only under the TTY condition.

## 8.7 Environment passed to the package manager

Only one variable is added: `COREPACK_ROOT`, set to the directory containing the
tool's own manifest/installation root. Package managers use it purely as a "am I
running under a version manager?" flag.

Additionally, during `use`/`up` only, `COREPACK_MIGRATE_FROM` is set to the previous
`packageManager` value (or the literal `unknown`) before running the package
manager's install command (§09.5).

`PATH` is **not** modified, so a script the package manager spawns may resolve a
*different* copy of that package manager, or none at all. **§15.32 requires prepending
the resolved package manager's directory to `PATH`** in the child environment.

Variables the tool consumed for its own configuration are **not** stripped — the
package manager sees the full ambient environment, including any values that came
from `.corepack.env`. A conforming implementation MUST propagate the env-file values
too, since a project may legitimately use them to configure the package manager's own
registry access.
