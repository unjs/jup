/**
 * Recognising a file the kernel would agree to execute — §07.4 rule 6's chmod
 * grant and §08.3.3's process replacement.
 */

const { accessSync, closeSync, constants, openSync, readSync } =
  process.getBuiltinModule("node:fs");
const { endianness } = process.getBuiltinModule("node:os");

/**
 * The leading bytes of a file the kernel would agree to execute.
 *
 * A shebang, ELF, and Mach-O in its four single-architecture forms plus the
 * universal-binary wrapper. Windows never reaches this — a `.exe` runs because
 * of its name — so `MZ` is deliberately absent.
 */
const PROGRAM_MAGIC: readonly (readonly number[])[] = [
  [0x23, 0x21], // `#!` — any interpreted script
  [0x7f, 0x45, 0x4c, 0x46], // ELF: Linux, the BSDs, Solaris
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O, 32-bit, big-endian
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O, 64-bit, big-endian
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O, 32-bit, little-endian
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O, 64-bit, little-endian
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal binary
];

/**
 * §07.4 rule 6 — whether the first `bytesRead` bytes of `head` begin with one
 * of {@link PROGRAM_MAGIC}. A question about *kind* only: the grant must not
 * make a data file executable, and nothing about this host is asked.
 */
export function isProgramHead(head: Uint8Array, bytesRead: number): boolean {
  return PROGRAM_MAGIC.some(
    (magic) => magic.length <= bytesRead && magic.every((byte, at) => head[at] === byte),
  );
}

/** ELF `e_machine` for each `process.arch` Node reports. */
const ELF_MACHINE: Record<string, number> = {
  ia32: 3,
  mips: 8,
  mipsel: 8,
  ppc: 20,
  ppc64: 21,
  s390: 22,
  s390x: 22,
  arm: 40,
  x64: 62,
  arm64: 183,
  riscv64: 243,
  loong64: 258,
};

/** Mach-O `cputype` for the two architectures macOS still runs. */
const MACHO_CPU: Record<string, number> = { x64: 0x01000007, arm64: 0x0100000c };

/**
 * Linux reads this much of a script to find its `#!` line (`BINPRM_BUF_SIZE`),
 * and nests script interpreters at most this deep; macOS reads more and nests
 * none, so these bounds are the conservative ones for both.
 */
const SHEBANG_BYTES = 256;
const SCRIPT_DEPTH = 4;

/**
 * §08.3.3 — will `execve(path)` succeed, as far as the file can say?
 *
 * Not {@link isProgramHead}: replacing the process hands the file straight to
 * the kernel, and Node aborts — `SIGABRT`, a native stack, perhaps a core file
 * in the user's project — on any `execve` that fails, where a spawn reports
 * §12.8's `Unable to execute`. So this answers the kernel's own questions and
 * says no on any doubt, which costs nothing but a spawn:
 *
 * * **executable** by us — `access(X_OK)`, which also covers a missing file and
 *   a `noexec` mount;
 * * an **ELF** of this byte order and machine, `ET_EXEC` or `ET_DYN`, whose
 *   `PT_INTERP` loader is itself executable — a glibc build on a host without
 *   glibc's loader (NixOS, a mis-detected musl) fails exactly there, with an
 *   `ENOENT` that names neither file;
 * * a **Mach-O** carrying this architecture's `cputype`, thin or universal,
 *   and only on macOS: an x86_64-only image on Apple silicon without Rosetta
 *   fails with `EBADARCH`, and with Rosetta it still runs under a spawn;
 * * a **script** whose `#!` interpreter passes the same test, within the
 *   kernel's line length and nesting depth.
 *
 * What is left is what the file cannot answer — `ETXTBSY`, `ENOMEM`, the store
 * entry vanishing under a concurrent `cache clean` between this call and the
 * `execve` — which is why the caller asks immediately before it.
 */
export function willExecute(path: string, depth = 0): boolean {
  let fd: number | undefined;
  try {
    accessSync(path, constants.X_OK);
    fd = openSync(path, "r");
    const head = Buffer.alloc(SHEBANG_BYTES);
    const bytesRead = readSync(fd, head, 0, SHEBANG_BYTES, 0);

    if (bytesRead >= 2 && head[0] === 0x23 && head[1] === 0x21) {
      return scriptWillExecute(head, bytesRead, depth);
    }
    if (bytesRead < 8) return false;
    if (head.readUInt32BE(0) === 0x7f454c46) return elfWillExecute(fd, head, bytesRead);
    return machoWillExecute(head, bytesRead);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function scriptWillExecute(head: Buffer, bytesRead: number, depth: number): boolean {
  if (process.platform === "darwin" ? depth > 0 : depth >= SCRIPT_DEPTH) return false;
  // A line the kernel would truncate names an interpreter we cannot read whole.
  const end = head.subarray(0, bytesRead).indexOf(0x0a, 2);
  if (end === -1) return false;
  const interpreter = /^[ \t]*([^ \t\0]+)/.exec(head.toString("latin1", 2, end))?.[1];
  return interpreter !== undefined && willExecute(interpreter, depth + 1);
}

function elfWillExecute(fd: number, head: Buffer, bytesRead: number): boolean {
  if (process.platform === "darwin" || process.platform === "win32" || bytesRead < 64) return false;
  const wide = head[4] === 2;
  if (!wide && head[4] !== 1) return false;
  const little = head[5] === 1;
  if (!little && head[5] !== 2) return false;
  if ((little ? "LE" : "BE") !== endianness()) return false;

  const u16 = (buffer: Buffer, at: number): number =>
    little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
  const u32 = (buffer: Buffer, at: number): number =>
    little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
  const word = (buffer: Buffer, at: number): number =>
    wide
      ? Number(little ? buffer.readBigUInt64LE(at) : buffer.readBigUInt64BE(at))
      : u32(buffer, at);

  const type = u16(head, 16);
  if (type !== 2 && type !== 3) return false;
  if (u16(head, 18) !== ELF_MACHINE[process.arch]) return false;

  const phoff = word(head, wide ? 32 : 28);
  const phentsize = u16(head, wide ? 54 : 42);
  const phnum = u16(head, wide ? 56 : 44);
  // The kernel's own checks on the table: one entry at least, of exactly the
  // class's size, within its ceiling.
  if (phentsize !== (wide ? 56 : 32) || phnum < 1 || phentsize * phnum > 65536) return false;

  const table = Buffer.alloc(phentsize * phnum);
  if (readSync(fd, table, 0, table.length, phoff) !== table.length) return false;
  for (let at = 0; at < table.length; at += phentsize) {
    if (u32(table, at) !== 3) continue; // PT_INTERP
    const size = word(table, at + (wide ? 32 : 16));
    if (size < 2 || size > 4096) return false;
    const interpreter = Buffer.alloc(size);
    if (readSync(fd, interpreter, 0, size, word(table, at + (wide ? 8 : 4))) !== size) {
      return false;
    }
    // The kernel wants the path NUL-terminated at exactly its declared end.
    if (interpreter[size - 1] !== 0) return false;
    // Throws for a loader that is missing or not executable; the caller's catch
    // turns that into the "no" it is.
    accessSync(interpreter.toString("latin1", 0, interpreter.indexOf(0)), constants.X_OK);
  }
  // No `PT_INTERP` is a static image, which needs nothing else.
  return true;
}

function machoWillExecute(head: Buffer, bytesRead: number): boolean {
  if (process.platform !== "darwin") return false;
  const cpu = MACHO_CPU[process.arch];
  if (cpu === undefined) return false;

  const magic = head.readUInt32BE(0);
  if (magic === 0xfeedfacf) return head.readUInt32BE(4) === cpu;
  if (magic === 0xcffaedfe) return head.readUInt32LE(4) === cpu;
  if (magic !== 0xcafebabe) return false;

  // Universal: a big-endian `fat_arch` table, 20 bytes an entry.
  const count = head.readUInt32BE(4);
  for (let entry = 0; entry < count; entry += 1) {
    const at = 8 + entry * 20;
    if (at + 4 > bytesRead) return false;
    if (head.readUInt32BE(at) === cpu) return true;
  }
  return false;
}
