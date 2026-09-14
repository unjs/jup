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

**It is opt-in.** Giving the process away is only safe for a caller with nothing
after its `await`, which is every entry point jup ships and no host application
that embeds it. `runMain(argv, { handover: true })` selects it; the CLI entry and
§10's stubs pass it, `RunOptions` defaults it off, and without it a JavaScript
entry point is spawned under §8.3.1 instead. The entry point decides because the
core cannot know whether it is the last thing that will run.

## 8.3 The native path: spawn and wait

For a band declaring `exec: "native"` there is no interpreter to choose — the
`bin` targets are real executables and are run directly, which makes a native
tool the *cheaper* handover. Under handover, where it can, jup does not spawn
at all and becomes the tool instead (§8.3.3). What follows is the spawn: the
fallback there, and the only model without handover.

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
  progress bars and prompts. An IPC channel is fd 3 rather than one of the three
  and is handled by §8.3.2.
* **No new process group or session.** That would detach the child from terminal
  job control and break Ctrl-C.
* `JUP_HOST_RUNTIME` carries the realpath of the runtime hosting a chain that has
  since entered the store, so a later `enable` can find a durable interpreter
  (§10.2). It is written into the child's environment block, never into jup's own.

### 8.3.1 Choosing an interpreter (JavaScript entry points only)

Reached when a JavaScript entry point is spawned rather than loaded, which is
what handover being off means: `JUP_NODE_EXECPATH`, else the runtime hosting jup,
else `node` on `PATH`; failing all three, an error naming `JUP_NODE_EXECPATH`.

The last two tiers are §10.2's, called rather than restated — the question is the
same one (*which runtime here is durable enough to name?*) and a second copy of
its ordering would be a second copy of its `cache clean` hazard.

Everything else about such a run is §8.3's: same argv, same inherited stdio, same
`PATH` entry and `COREPACK_ROOT`. Two things differ from §8.2 and are the price
of the boundary:

* the child has a live `require.main`, which §8.2 clears so pnpm 4 can detect a
  version manager. `COREPACK_ROOT` (§8.7) is the supported spelling of that
  question and is set either way;
* there is a second process. A warm run costs one process startup that §8.2's
  does not, which is why the shims do not take this path.

`argv[0]` is left to the runtime here, unlike §8.3's native path: the spawned
process *is* an interpreter, so `[execPath, binPath, …]` is what it produces on
its own — the same array §8.2 writes by hand.

### 8.3.2 The IPC channel

`inherit` is fds 0, 1 and 2 and nothing else, so a caller that spawned a shim
with an `ipc` slot — `child_process.fork`, a worker pool, a test runner waiting
on a handshake — had its channel end *at the shim*: the runtime it meant to talk
to came up with no channel, `process.send` undefined, and a handshake that never
arrives. Under handover a shim therefore **relays** the channel it was given:

```
this process has a channel?   → stdio gains a fourth slot, "ipc"
message from the caller       → forwarded to the tool, sendHandle included
message from the tool         → forwarded to the caller, sendHandle included
either side disconnects       → the other side is disconnected, once the
                                forwarded messages have been written
```

Gated on handover, exactly as §8.5's re-raise is, and for the same reason: a shim
owns neither the channel nor the messages on it, and a host application that
called `runMain` mid-script owns both. Without handover the channel is left
alone.

**The relay is the fallback.** Where the tool can take the channel itself —
§8.3.3's replacement through the addon — it does, and nothing is relayed. The
relay remains for everything else: a host with no addon build (Windows among
them), a home the addon cannot be written into or loaded from, a worker thread
or the permission model, a shim interpreter that is not Node, a channel Node has
already read from, and an `advanced` channel to a tool other than `node`. It costs a deserialise and reserialise per message
and works against every runtime in the table, because bun and deno implement the
same `NODE_CHANNEL_FD` convention that the `ipc` slot writes.

Two things follow from the relay being one:

* messages cross as the default JSON serialisation. A caller that spawned with
  `serialization: "advanced"` reaches the tool with what JSON preserves of its
  messages;
* the process must outlive its own last write. Teardown drops the channel's
  listeners — and with them the ref that keeps the loop alive — only once no
  forwarded message is still in flight, or a handshake answered on the tool's
  last tick would be lost with the pipe;
* a disconnect relayed upward can be followed by the runtime's own, because its
  EOF handler disconnects unconditionally and a second disconnect arrives as an
  `error` **event** on `process` rather than as a throw. Nothing else in a shim
  emits one, and unhandled it replaces the tool's exit code with a stack, so
  `ERR_IPC_DISCONNECTED` is swallowed there and every other `error` is left
  alone. The window is not theoretical: a caller that hangs up on a message it
  cannot parse — `Bun.spawn`'s default `serialization: "advanced"`, handed the
  JSON any Node process writes — closes its end exactly then.

Extra fds beyond the channel are still not forwarded: a caller passing
`stdio: ["pipe", "pipe", "pipe", "pipe"]` loses fd 3 onwards through a shim.

### 8.3.3 Becoming the tool

A spawned tool is a second pid, and the pid a caller holds is the shim's. That
is invisible until the pid matters, and then it is wrong: `SIGKILL` and
`SIGSTOP` cannot be forwarded, so killing the pid kills the shim alone and the
tool — reparented to init — keeps its stdio, its ports and its own children's
channels open; pidfiles, supervisors, `process.ppid` and `/proc/<pid>` all see
the wrapper. Under handover a native run therefore **replaces the process
image** rather than spawning:

```
handover, main thread, permission model allows child processes
  the addon loads from <home>/addon/
    IPC channel? only if Node has read nothing from it
      → NODE_CHANNEL_FD, NODE_CHANNEL_SERIALIZATION_MODE back into env
    → release the streams jup wrote to
    → reset SIGPIPE/SIGXFSZ, addon execve(binPath, argv, env, channel fd)
  no addon, no IPC channel, process.execve exists (not Windows, Deno, Node < 22.15)
    → release the streams jup wrote to
    → argv + env block under 512 KiB, and the kernel will take binPath
        → reset SIGPIPE/SIGXFSZ, process.execve(binPath, argv, env)
otherwise, or execve returned
  → §8.3's spawn, and §8.3.2's relay for a channel
```

`argv` and `env` are §8.3's, `argv[0]` the invoked name included. The pid, the
process group, the controlling terminal and fds 0–2 are the caller's by
construction, and every signal reaches the tool with no forwarding at all.

**The addon.** `native/execve.zig` is a Node-API library of one function:
`execve` with a descriptor to keep, which returns the errno when the kernel
refuses. It exists for the two things `process.execve` cannot do:

* **carry the IPC channel.** Node marks every inherited descriptor above 2
  close-on-exec during startup (`uv_disable_stdio_inheritance`), and no
  JavaScript API clears the flag. The addon clears it on the channel's fd — and
  on 0–2, as Node's own does — immediately before the call, and restores the
  flags if the call returns;
* **fail.** Node's `execve` prints the errno and aborts on any refusal, perhaps
  leaving a core file in the user's project. The addon's returns, and the spawn
  that stands in reports §12.8's `Unable to execute` for the same refusal.

`scripts/build-addon.mjs` builds it with a pinned Zig for §02.4's POSIX hosts —
Intel macOS aside, as legacy: it keeps the rules without an addon — and
writes `src/run/addon-binaries.ts`: per host, the SHA-256, the size and the
zstd-compressed bytes, committed so a checkout builds and tests without Zig. The
Linux files link no C library — the system calls are made directly — so one per
architecture serves glibc and musl; the macOS ones bind `execve` and `fcntl`
from libSystem. Every Node-API symbol resolves against the loading process.

`enable` and `self-install` — and a run with a channel that finds the file missing
or damaged, which is how an upgrade gets its own — decompress this host's bytes,
check them against the digest, and rename them into `<home>/addon/execve-<digest16>.node` — the first 16 hex
digits of the digest (§07.2) —
best-effort: a home that will not take the file costs the shims their
replacement under a channel, not the command. A run loads the file by that name
with `process.dlopen` and checks its `abi` export; a missing, unloadable or
mismatched file is no addon, and the rules without one apply.

**The channel.** Node deletes `NODE_CHANNEL_FD` and
`NODE_CHANNEL_SERIALIZATION_MODE` from `process.env` during bootstrap, and begins
reading the pipe at once. So:

* the pipe is reached through `process[kChannelHandle]`, the symbol Node keeps it
  under — `process.channel` hides it. Its `fd` restores `NODE_CHANNEL_FD`, and the
  buffers Node gave it name the serialisation (`kMessageBuffer` is `advanced`).
  `advanced` is Node's own framing — bun and deno read nothing of it and hang — so
  an `advanced` channel is handed only to a tool invoked as `node`; the relay
  speaks JSON to the rest;
* nothing may have been read. A message Node took off the pipe is in this
  process and would never reach the tool, so `bytesRead` is checked immediately
  before the call, and anything non-zero keeps the relay;
* §10.1's stubs therefore stop the read with the handle's `readStop()` before
  their first `await` — before the loop can poll — and resume it after `runMain`
  returns, for a JavaScript tool handed over in process. The relay resumes it
  itself. A run that was not started by a stub (`jup <name>`), or whose preload
  (`--import`) let the loop poll first, replaces only when nothing was read;
* the checks are asked again after the stream release's `await`: a channel closed
  in it keeps the spawn.

**Without the addon**, a channel keeps the spawn, and the kernel's questions are
asked of the file before `process.execve`, immediately before the call, with
any doubt spawning: executable by us; an ELF of this byte order and machine
whose `PT_INTERP` loader is executable (a glibc build on a host with no glibc
loader fails exactly there); a Mach-O carrying this architecture, on macOS only;
a script whose `#!` interpreter passes the same test within the kernel's line
and nesting limits. A single argument or environment string over Linux's 128 KiB
`MAX_ARG_STRLEN`, or a block over 512 KiB, spawns too. What is not checked still
aborts: `ETXTBSY`, a concurrent `cache clean` removing the entry in the instant
before the call, and a block under 512 KiB that jup's additions push past
Linux's quarter-of-the-stack-limit cap.

Either way:

* **Refusals that throw are avoided.** A worker thread and the permission model
  make Node's `execve` throw after it has queued an `ExperimentalWarning`, which
  would print over the spawn, and the addon's would take every other thread with
  it; both are checked for instead.
* **stdio is left as found, for the streams jup wrote to.** `execve` skips the
  exit hooks that flush a pending write and undo libuv's non-blocking mode on a
  piped stdout or stderr. Each stream jup's own writers constructed has any
  pending write waited for — with an `error` listener held, since a caller that
  hung up turns the wait into an `EPIPE` that would otherwise kill jup before the
  tool ran — and is set blocking. A stream jup never wrote to is not touched:
  constructing it costs the modules a warm run defers, and a warm run printed
  nothing and pays nothing. A stream only Node itself wrote to — its own warnings
  print through the console — is not seen, and is left as Node left it.
* **Signals are left at their defaults.** Node sets `SIGPIPE` and `SIGXFSZ` to
  ignored before any of jup runs, and an ignored disposition survives `execve`.
  A listener on each turns them into caught signals, which the kernel resets —
  matching the spawn, where libuv resets every disposition in the child. The
  listeners stay if `execve` returns: removing the last one would restore the
  default rather than Node's ignore, and jup would die writing its error into a
  closed pipe.
* **Extra fds are lost**, as §8.3.2 records: only the channel is handed through.

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

Without handover the last row is always the numeric form. Re-raising is right for
a shim, whose exit status *is* the tool's, and is an unrecoverable death for a
host application several frames below code that has more to do. The first four
rows are unchanged and, unlike §8.2's, are actually *returned*: an isolated run
answers with the tool's own exit code rather than with the placeholder `0`.

`runMain` returns `{ code }`, not the bare number — an object so that a later
fact about a run can be added without breaking every embedder a second time.

For jup's **own** errors:

| Class | Stream | Exit |
|---|---|---|
| `UsageError` in proxy mode | stderr, message only, no stack | 1 |
| `UsageError` in management mode | **stdout**, `Usage Error: `, blank line, usage line | 1 |
| Anything else | stderr, with stack | 1 |

The stdout-vs-stderr split between the two modes is real and test-asserted.

## 8.5 Signals

The in-process model and §8.3.3's replacement inherit signal behaviour for free:
there is one process, and it is the tool. The spawning path must not regress it:

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
(`echo … | npm publish`). jup itself MUST NOT read stdin at all: §05.4's download
notice announces and continues, so every byte the caller piped in reaches the
package manager.

## 8.7 The child's environment

* `COREPACK_ROOT` (and `JUP_ROOT`) — the directory containing jup's own
  installation root, found by walking up to the manifest because bundled chunks
  may be nested. Tools use it purely as an "am I under a version manager?" flag.
* `COREPACK_MIGRATE_FROM` (and `JUP_MIGRATE_FROM`) — set during `use`/`up` only,
  before running the tool's own `use` command (§09.5), to the previous pin value
  or the literal `unknown`. Without handover it is put back when that command
  returns; the child's environment block is a copy taken at spawn time, so it
  still carries the value.
* The resolved tool's directory is **prepended to `PATH`**, so scripts it spawns
  resolve the same tool.

Variables jup consumed for its own configuration are **not** stripped: the tool
sees the full ambient environment, env-file values included, because a project may
legitimately use them to configure the tool's own registry access. What jup does
not do is leak its own per-run bookkeeping into the parent process — the native
path builds the child's environment block by hand so its additions cannot flow
back.

Under §8.2's handover there is no parent to protect, and `process.env` *is* the
child's environment, so `COREPACK_ROOT` is written there. Without handover both
additions go into the spawned block alone and this process's environment is
unchanged by the run. What jup does not undo either way is §3.2's env-file load,
which happens during discovery and is documented as such.
