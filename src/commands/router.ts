/**
 * The command router — §17.4 R7–R13, §09.0.
 *
 * §01.2's proxy tests (R7 steps 0–2) live in `main.ts`, on the warm path, and
 * must stay there: they run on every `yarn`, `npm` and `pnpm` invocation on the
 * machine. Everything below is R7 steps 3–7 — top-level flags, the scope word,
 * the verb table, help, and the unknown-command error — none of which can be
 * reached except in management mode, which is already behind `main.ts`'s lazy
 * import. So the scope word and the verb table cost the proxy path nothing.
 *
 * The consequence to keep hold of is the ordering, which is the whole of R7:
 *
 * * `jup yarn --version` is step 1 — proxy mode, Yarn's version (§13 row 147).
 * * `jup pm yarn --version` never reaches a proxy test, because step 4 has
 *   already consumed `pm` and only steps 3, 5 and 6 may classify what follows.
 *   `yarn` is not a verb, so it is step 7's usage error.
 *
 * Both are §17.9 rows 210 and 209, and they are the same argument written twice.
 */

import type { Role } from "../types.ts";
import { type EntryName, getEntryName } from "../utils/self.ts";
import { isPendingVerb, usageLine, VERBS } from "./usage.ts";

/**
 * §17.4 R8's `SCOPE_WORDS` — **both spellings of both scopes**, accepted
 * interchangeably.
 *
 * Holding all four is the point: neither the abbreviation nor the full word can
 * later be spent on something else, and a user who guesses either one is right.
 * The value is the role; the canonical spelling for a usage line comes from
 * {@link SCOPE_SPELLING}, which quotes §09's `<scope> := pm | runtime`.
 */
export const SCOPE_WORDS: Readonly<Record<string, Role>> = {
  pm: "package-manager",
  "package-manager": "package-manager",
  rt: "runtime",
  runtime: "runtime",
};

/** §09's spelling of each role, which is what a usage line teaches back. */
const SCOPE_SPELLING: Readonly<Record<Role, ScopeWord>> = {
  "package-manager": "pm",
  runtime: "runtime",
};

export type ScopeWord = "pm" | "runtime";

/**
 * §17.4 R8's `RESERVED` — words that are not used today and MUST NOT become tool
 * names, binary names, scope words, or verbs.
 *
 * `node`, `deno` and `bun` sit here rather than in `NAMES` because no runtime is
 * in §02.5's table yet; they move sets when one is added.
 */
export const RESERVED: readonly string[] = [
  "run",
  "exec",
  "shim",
  "self",
  "doctor",
  "env",
  "list",
  "ls",
  "which",
  "clean",
  "add",
  "remove",
  "init",
  "version",
  "node",
  "deno",
  "bun",
];

/** §17.4 R7 steps 3–7 — what the arguments turned out to be. */
export interface Route {
  /** The entry point this process was invoked under (§17.6 C1′). */
  entry: EntryName;
  /**
   * The role the command is scoped to, or `null` when no scope word was given
   * and R10 has to infer one.
   *
   * Under the `corepack` entry point this is always `package-manager`: R12 makes
   * `corepack <verb>` exactly `jup pm <verb>`. It is set and, in D1, read by
   * nothing but the help text — R9's narrowing and R10's inference are the next
   * step's, and the field is what they will read.
   */
  scope: Role | null;
  /** The scope word as §09 spells it, or `null` — `corepack` never shows one. */
  scopeWord: ScopeWord | null;
  kind: "help" | "version" | "verb" | "unknown";
  /** Set when `kind` is `"verb"`. */
  verb?: string;
  /** Set when `kind` is `"unknown"`: the token §12.9's message names. */
  unknown?: string;
  /**
   * §12.9's specific refusal, when there is one — today only R12's, which is why
   * the corepack path has to recognise the scope words in order to decline them.
   */
  message?: string;
  /** The verb's own arguments. */
  args: string[];
}

/** §17.4 R7 step 3 — the top-level flags, which are not verbs. */
function topLevelFlag(arg: string): "help" | "version" | undefined {
  if (arg === "--help" || arg === "-h") return "help";
  if (arg === "--version") return "version";
  return undefined;
}

/**
 * §17.4 R7 steps 3–7, given the arguments left after `main.ts` decided this is
 * not proxy mode.
 *
 * Steps 1 and 2 cannot match a token beginning with `-`, so testing the flags
 * first here changes nothing about which mode a non-flag argument reaches — R7
 * permits exactly that reordering and forbids exactly the other consequence.
 */
export function route(args: string[], entry: EntryName): Route {
  // R12 — `corepack <verb>` is `jup pm <verb>`, so the scope is in effect from
  // the start even though no scope word may be written.
  const corepack = entry === "corepack";
  const base: Route = {
    entry,
    scope: corepack ? "package-manager" : null,
    scopeWord: null,
    kind: "help",
    args: [],
  };

  const first = args[0];

  // Step 3 — a top-level flag, in the scope in effect.
  const flag = first === undefined ? undefined : topLevelFlag(first);
  if (flag !== undefined) return { ...base, kind: flag, args: args.slice(1) };

  // Step 4 — a scope word: shift it, and classify the next token by steps 3, 5
  // and 6 only. A second scope word therefore falls to step 7.
  if (first !== undefined && Object.hasOwn(SCOPE_WORDS, first)) {
    const role = SCOPE_WORDS[first]!;
    // R12 — the corepack entry point recognises the scope words *in order to
    // refuse them*, which is why this branch exists on a path that does not
    // accept them. A silent `Unknown command "runtime"` would leave a user who
    // typed the right thing under the wrong name with nothing to go on.
    if (corepack) {
      return {
        ...base,
        kind: "unknown",
        unknown: first,
        ...(role === "runtime"
          ? {
              message: `runtime management is not available through the 'corepack' command - use 'jup runtime <verb>'`,
            }
          : {}),
        args: args.slice(1),
      };
    }
    return scoped({ ...base, scope: role, scopeWord: SCOPE_SPELLING[role] }, args.slice(1));
  }

  return scoped(base, args);
}

/**
 * Steps 3, 5, 6 and 7 — the classification a scope word leaves behind, and the
 * same one an unscoped command starts from.
 */
function scoped(base: Route, args: string[]): Route {
  const first = args[0];

  // Step 6 — nothing, or `--`: that scope's help, exit 0. A scope word is never
  // a command by itself.
  if (first === undefined || first === "--") return { ...base, kind: "help", args: [] };

  // Step 3, again, for the token after a scope word.
  const flag = topLevelFlag(first);
  if (flag !== undefined) return { ...base, kind: flag, args: args.slice(1) };

  // Step 5 — a verb. `pending` verbs (§15.34's `project`) are named by the
  // surface but not dispatched, so they fall through to step 7 and reach §12.9's
  // `Unknown command` exactly as they do today.
  if (VERBS.includes(first) && !isPendingVerb(first)) {
    return { ...base, kind: "verb", verb: first, args: args.slice(1) };
  }

  // Step 7.
  return { ...base, kind: "unknown", unknown: first, args: args.slice(1) };
}

/** {@link route}, for the name this process was actually invoked under. */
export function routeArgv(args: string[]): Route {
  return route(args, getEntryName());
}

/**
 * §12.1 — "the binary the user invoked and the scope in effect".
 *
 * `corepack`, `jup`, `jup pm`, `jup runtime`. Under the corepack entry point the
 * scope is package-manager and is never spelled (R12).
 */
export function invocationPrefix(command: Route): string {
  return command.scopeWord === null ? command.entry : `${command.entry} ${command.scopeWord}`;
}

/**
 * §12.1 — the usage line appended to a management-mode `Usage Error:`.
 *
 * Routed rather than keyed off `args[0]` directly, so `jup pm use …` gets
 * `$ jup pm use <pattern>` instead of a generic line about a command called
 * `pm` (§17.9 row 214).
 */
export function usageLineFor(args: string[]): string {
  const command = routeArgv(args);
  return usageLine(command.verb, invocationPrefix(command));
}
