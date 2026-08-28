# 08 — Handing Over Control

The final step: run the package manager so convincingly that neither the user nor the
package manager itself can tell a trampoline was involved.

## 8.1 Locating the entry point

```
bin := installSpec.bin ?? spec.bin       # always a MAP (§02.4)

if bin has an OWN key binName:
    binPath := <location>/<bin[binName]>

if binPath is unset:
    → Error `Assertion failed: Unable to locate path for bin '<binName>'`
```

`bin` follows the single `BinSpec` map rule in §02.4; `resolveBinPath` needs only the
install location and that map.

`installSpec.bin` is the marker's own `bin`, which §07.7 always records. The `??`
stands in for a marker jup did not write: §07.10 promotes markers out of an archive
another machine produced, and one that omits `bin` MUST reach the assertion above
rather than a type error.

`bin[binName]` values are relative paths that may begin with `./` — join them
naively, do not normalise away the possibility that they escape (they come from a
downloaded `package.json` in the untrusted-tarball case).

> **Requirement:** when `bin` comes from an extracted `package.json` rather
> than the embedded table, `bin[binName]` is attacker-controlled. Resolve it and
> verify the result stays inside `<location>`, erroring otherwise.

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

## 8.3 The execution model for a native implementation

A native implementation cannot load a JavaScript module into itself. It **MUST**
spawn a child process, and it MUST reproduce the observable behaviour of the
in-process model. This is the single largest divergence in the spec, so it is
specified precisely.

### 8.3.1 Choosing the interpreter

> this whole step is **skipped** for a band declaring `"exec": "native"`.
> Its `bin` targets are real executables and are run directly, which makes a native
> package manager the *cheaper* handover, not the more expensive one. On that path
> `argv[0]` is the binary name the user invoked rather than the artifact's path; see
> §02.4 for the shared-path `BinSpec` rule (`bunx` and `bun` are one file).

The package manager entry points are JavaScript. The tool must locate a JavaScript
runtime:

1. If `COREPACK_NODE_EXECPATH` is set, use it. *(Additional settings — see §11.)*
2. Otherwise search `PATH` for `node`.
3. If not found → error:
   `Unable to locate a Node.js runtime to execute <binName>; set COREPACK_NODE_EXECPATH to point at one`

A tool distributed alongside a runtime SHOULD prefer the sibling runtime binary
before consulting `PATH`.

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

Required exit behavior, verified by the conformance suite:

| Package manager does | Tool exits with |
|---|---|
| sets exit code 42 synchronously | **42** |
| sets exit code 42, then throws an uncaught error | **1**, error message on stderr |
| sets exit code 42 only in a `beforeExit` hook | **42** |
| exits normally | **0** |
| is killed by signal N | killed by signal N (POSIX), or `128+N` if the runtime cannot re-raise |

An uncaught exception resets the pending exit code to 1; the tool MUST NOT override
that runtime behavior.

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

stdin MUST be passed through untouched, including for:

* Package managers read stdin for prompts (`npm init`, `yarn init`).
* Package managers are frequently used in pipelines (`echo … | npm publish`).

The tool itself reads stdin only for the download prompt (§05.5), which
happens strictly *before* handover and only when stdin is a TTY. A conforming
implementation MUST NOT consume buffered stdin bytes it did not need — read exactly
one chunk, and only under the TTY condition.

## 8.7 Environment passed to the package manager

Add `COREPACK_ROOT`, set to the directory containing the tool's own
manifest/installation root. Package managers use it purely as an "am I
running under a version manager?" flag.

Additionally, during `use`/`up` only, `COREPACK_MIGRATE_FROM` is set to the previous
`packageManager` value (or the literal `unknown`) before running the package
manager's install command (§09.5).

Prepend the resolved package manager's directory to `PATH` in the child environment,
so scripts it spawns resolve the same package manager.

Variables the tool consumed for its own configuration are **not** stripped — the
package manager sees the full ambient environment, including any values that came
from `.jup.env`. A conforming implementation MUST propagate the env-file values
too, since a project may legitimately use them to configure the package manager's own
registry access.
