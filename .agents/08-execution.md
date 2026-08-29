# 08 — Handing Over Control

The last step: run the tool so convincingly that neither the user nor the tool
itself can tell a trampoline was involved.

## 8.1 Locating the entry point

```
bin := installSpec.bin ?? spec.bin        # always a MAP (§02.4)
own key binName?  → binPath := <location>/<bin[binName]>
otherwise         → "Assertion failed: Unable to locate path for bin '<binName>'"
```

`installSpec.bin` is the marker's own map, which §07.7 always records. The `??`
stands in for a marker jup did not write: §07.10 promotes markers from another
machine's archive, and one omitting `bin` must reach the assertion rather than a
type error.

Values are relative paths that may begin with `./`. When they came from an
extracted `package.json` they are attacker-adjacent, so the joined path is
resolved and **must stay inside `<location>`**; escaping is refused by name.

## 8.2 The JavaScript path: in-process

For a band with no `exec` (or `exec: "js"`), jup does not spawn. It loads the
entry module into its own process after rewriting the process state to look like
a direct invocation:

```js
process.env.JUP_ROOT = process.env.COREPACK_ROOT = <jup's own root>
process.argv     = [process.execPath, binPath, ...args]
process.execArgv = []
process.mainModule = undefined
process.nextTick(runMain, binPath)
```

| Line | Reason |
|---|---|
| `argv` | Yarn reads `process.argv[1]` to locate itself |
| `mainModule = undefined` | pnpm checks `require.main == null` to detect its own version |
| `execArgv = []` | the tool must not inherit jup's runtime flags |
| `nextTick` | unwinds jup's frames out of any stack trace the tool prints |
| `COREPACK_ROOT` | lets tools feature-detect that they run under a version manager |

This model is why the exit-code semantics in §8.4 are what they are: the tool
sets the real exit code from its own module body, which runs strictly after
`runProxy` returns 0.

## 8.3 The native path: spawn and wait

For a band declaring `exec: "native"` there is no interpreter to choose — the
`bin` targets are real executables and are run directly, which makes a native
tool the *cheaper* handover.

```
argv := [binPath, ...binArgs, ...args]      with argv[0] set to the INVOKED NAME
env  := parentEnv + COREPACK_ROOT + JUP_HOST_RUNTIME
cwd  := unchanged — the caller's cwd, not the project root
stdio: inherit all three, unmodified
```

* **`argv[0]` is the name the user typed**, not the artifact's path. That is how
  `bun` and `bunx` — literally one file — behave differently, and the same for
  `nub`/`nubx` and aube's three names. Where an artifact instead dispatches on
  its own file name, `binArgs` supplies the words that recover the intent
  (`pnpx` → `pnpm dlx`). Absent an invoked name — a `commands.use` handover,
  where nothing was invoked — the path is used.
* **stdio is inherited, never piped.** Tools detect TTYs to decide on colour,
  progress bars and prompts.
* **No new process group or session.** That would detach the child from terminal
  job control and break Ctrl-C.
* `JUP_HOST_RUNTIME` carries the realpath of the runtime hosting a chain that has
  since entered the store, so a later `enable` can find a durable interpreter
  (§10.1). It is written into the child's environment block, never into jup's own.

### Choosing an interpreter (JavaScript entry points only)

Only relevant if a JavaScript entry point ever has to be spawned rather than
loaded: `JUP_NODE_EXECPATH`, else a sibling runtime beside jup, else `node` on
`PATH`; failing all three, an error naming `JUP_NODE_EXECPATH`.

## 8.4 Exit codes

| The tool does | jup exits with |
|---|---|
| sets exit code 42 synchronously | 42 |
| sets 42, then throws uncaught | 1, error on stderr |
| sets 42 only in a `beforeExit` hook | 42 |
| exits normally | 0 |
| is killed by signal N | signal death, or `128+N` if it cannot be re-raised |

An uncaught exception resets the pending exit code to 1, and jup must not
override that runtime behaviour.

For jup's **own** errors:

| Class | Stream | Exit |
|---|---|---|
| `UsageError` in proxy mode | stderr, message only, no stack | 1 |
| `UsageError` in management mode | **stdout**, `Usage Error: `, blank line, usage line | 1 |
| Anything else | stderr, with stack | 1 |

The stdout-vs-stderr split between the two modes is real and test-asserted.

## 8.5 Signals

The in-process model inherits signal behaviour for free. The spawning path must
not regress it:

* **Install no handler that swallows a signal.** `SIGINT` from a terminal goes to
  the whole foreground process group, so the child receives it directly; jup
  waits and reflects the child's status.
* Forward `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGUSR1`, `SIGUSR2` when jup receives
  them directly rather than via the group.
* When the child dies by signal N, reset the handler for N to default and
  `raise(N)`, so the parent shell sees a signal death; exiting `128+N` is an
  acceptable fallback.
* On Windows, forward `CTRL_C_EVENT` / `CTRL_BREAK_EVENT`.

## 8.6 stdin

Passed through untouched — tools prompt (`npm init`) and are used in pipelines
(`echo … | npm publish`). jup itself reads stdin only for the download prompt
(§05.4), strictly before handover, only when stdin is a TTY, and exactly one
chunk.

## 8.7 The child's environment

* `COREPACK_ROOT` (and `JUP_ROOT`) — the directory containing jup's own
  installation root, found by walking up to the manifest because bundled chunks
  may be nested. Tools use it purely as an "am I under a version manager?" flag.
* `COREPACK_MIGRATE_FROM` (and `JUP_MIGRATE_FROM`) — set during `use`/`up` only,
  before running the tool's own `use` command (§09.5), to the previous pin value
  or the literal `unknown`.
* The resolved tool's directory is **prepended to `PATH`**, so scripts it spawns
  resolve the same tool.

Variables jup consumed for its own configuration are **not** stripped: the tool
sees the full ambient environment, env-file values included, because a project may
legitimately use them to configure the tool's own registry access. What jup does
not do is leak its own per-run bookkeeping into the parent process — the native
path builds the child's environment block by hand so its additions cannot flow
back.
