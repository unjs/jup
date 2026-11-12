/**
 * The management commands' option parser — §09.
 *
 * Its own module so that `env.ts` can use it without loading `cli.ts`: `jup
 * env` runs on every directory change once `--use-on-cd` is installed, and
 * `cli.ts` statically reaches the install pipeline, which loads `node:crypto`,
 * `node:zlib` and `node:fs/promises` on the way in (§16, Build shape).
 */

import { UsageError } from "../errors.ts";

interface ArgSpec {
  booleans?: string[];
  strings?: string[];
}

interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  positionals: string[];
}

/**
 * A deliberately tiny parser: `--flag`, `--flag value`, `--flag=value`, `-o
 * value`, `-o=value`, and `--` to end option parsing. Anything unrecognised is a
 * usage error rather than a silently-ignored typo.
 */
export function parseArgs(args: string[], spec: ArgSpec): ParsedArgs {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);

  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  let literal = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;

    if (literal || arg === "-" || !arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);

    if (equals === -1 && booleans.has(name)) {
      flags.add(name);
      continue;
    }

    if (strings.has(name)) {
      if (equals !== -1) {
        values.set(name, arg.slice(equals + 1));
        continue;
      }
      const next = args[index + 1];
      if (next !== undefined && (next === "-" || !next.startsWith("-"))) {
        values.set(name, next);
        index++;
        continue;
      }
      throw new UsageError(`Option "${name}" requires a value`);
    }

    throw new UsageError(`Unsupported option name ("${arg}")`);
  }

  return { flags, values, positionals };
}

export function firstValue(parsed: ParsedArgs, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = parsed.values.get(name);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function hasFlag(parsed: ParsedArgs, ...names: string[]): boolean {
  return names.some((name) => parsed.flags.has(name));
}
