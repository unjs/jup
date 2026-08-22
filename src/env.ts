/**
 * Environment and `.corepack.env` — §03.2, §11, §14.5.
 *
 * Reading the environment is the *only* configuration input the tool has. There
 * is no config file, no user profile, no registry of registries.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { messages } from "./errors.ts";

/**
 * §03.2 — the prefix filter is the entire sandbox against a hostile repository.
 * Keys without it (`HTTP_PROXY`, `PATH`, `NODE_OPTIONS`, …) are dropped before
 * anything is merged.
 */
export const ENV_FILE_PREFIX = "COREPACK_";

/** §03.2 — the file looked for when `COREPACK_ENV_FILE` is unset. */
export const DEFAULT_ENV_FILE_NAME = ".corepack.env";

/**
 * §03.2 + §14.5 — variables an env file may never supply.
 *
 * `COREPACK_ENV_FILE` is chicken-and-egg; `COREPACK_ENABLE_DOWNLOAD_PROMPT`'s
 * default depends on how the tool was invoked, which a project file must not be
 * able to override. The rest are §14.5's and §15.37's security additions: a
 * hostile repo must not be able to disable signature verification, point at an
 * arbitrary host, pair a token with a hostile registry to exfiltrate it, or
 * switch off (or redirect) TLS certificate verification.
 */
export const ENV_FILE_INELIGIBLE = new Set([
  "COREPACK_ENV_FILE",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "COREPACK_INTEGRITY_KEYS",
  "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  "COREPACK_NPM_TOKEN",
  "COREPACK_NPM_USERNAME",
  "COREPACK_NPM_PASSWORD",
  "COREPACK_CAFILE",
  "COREPACK_STRICT_SSL",
]);

/**
 * §14.5's additions: variables a project file must never supply because doing so
 * is a security decision, not a preference. Corepack honours all of these from
 * an env file, so a cloned repo can disable signature verification, point
 * downloads at an arbitrary host, or pair a token with a hostile registry to
 * exfiltrate it.
 *
 * These are the ones worth telling the user about; the other two entries in
 * {@link ENV_FILE_INELIGIBLE} are refused silently, as corepack refuses them.
 */
export const SECURITY_ONLY_FROM_ENVIRONMENT = new Set([
  "COREPACK_INTEGRITY_KEYS",
  "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  "COREPACK_NPM_TOKEN",
  "COREPACK_NPM_USERNAME",
  "COREPACK_NPM_PASSWORD",
  // §15.37 marks both TLS variables env-file INELIGIBLE, and for the same
  // reason as the rest of this list: a cloned repository must not be able to
  // switch certificate verification off, or to nominate the certificate
  // authority its downloads are checked against. `COREPACK_NETWORK_TIMEOUT` and
  // `COREPACK_NETWORK_RETRIES` are eligible — they are preferences, not trust
  // decisions.
  "COREPACK_CAFILE",
  "COREPACK_STRICT_SSL",
]);

/**
 * Warned-about `<path>\0<NAME>` pairs.
 *
 * §14.5 asks for one warning per offending variable. Only the closest env file
 * is ever loaded (§03.2), so a run applies at most one file and keying by path
 * as well as name costs nothing while keeping repeated applications of *the same*
 * file quiet.
 */
const warnedIneligible = new Set<string>();

/** dotenv-style parse, matching `node:util`'s `parseEnv` semantics. */
export function parseEnvFile(content: string): Record<string, string> {
  const parsed = parseEnv(content);
  const vars: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(parsed)) {
    const value = parsed[key];
    if (typeof value === "string") {
      vars[key] = value;
    }
  }
  return vars;
}

/**
 * Load the env file for one directory, if any.
 *
 * Path is `resolve(dir, COREPACK_ENV_FILE ?? ".corepack.env")`; `COREPACK_ENV_FILE === "0"`
 * disables env files entirely. `ENOENT` is not an error. Only the **closest**
 * file is ever loaded.
 */
export function loadEnvFileFrom(
  dir: string,
): { vars: Record<string, string>; path: string } | null {
  const configured = process.env.COREPACK_ENV_FILE;
  if (configured === "0") {
    return null;
  }

  const path = resolve(dir, configured ?? DEFAULT_ENV_FILE_NAME);

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  return { vars: parseEnvFile(content), path };
}

/**
 * Filter to `COREPACK_`-prefixed, drop the ineligible set (warning once each),
 * then merge as `{...fileVars, ...process.env}` — the real environment wins —
 * and assign the result to `process.env` for the remainder of the run.
 */
export function applyEnvFile(vars: Record<string, string>, path: string): void {
  const eligible: Record<string, string> = {};

  for (const name of Object.keys(vars)) {
    // §03.2 security note: the prefix filter runs *before* anything is merged.
    if (!name.startsWith(ENV_FILE_PREFIX)) {
      continue;
    }

    if (!isEnvFileEligible(name)) {
      // Warn only for the five §14.5 adds. Corepack already refuses
      // COREPACK_ENV_FILE and COREPACK_ENABLE_DOWNLOAD_PROMPT silently, and
      // conformance row 48 asserts stderr is empty when a project's env file
      // tries to turn the download prompt on — so announcing those two would
      // break a row while telling the user nothing they can act on.
      if (SECURITY_ONLY_FROM_ENVIRONMENT.has(name)) {
        const seen = `${path}\0${name}`;
        if (!warnedIneligible.has(seen)) {
          warnedIneligible.add(seen);
          console.warn(messages.ignoringEnvVar(name, path));
        }
      }
      continue;
    }

    const value = vars[name];
    if (value !== undefined) {
      eligible[name] = value;
    }
  }

  // §11.6 — the real process environment always wins over the file.
  process.env = { ...eligible, ...process.env };
}

export function isEnvFileEligible(name: string): boolean {
  return name.startsWith(ENV_FILE_PREFIX) && !ENV_FILE_INELIGIBLE.has(name);
}

/** `true` only for the exact string `"1"`, matching the spec's value tables. */
export function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

/** `true` only for the exact string `"0"`. */
export function envDisabled(name: string): boolean {
  return process.env[name] === "0";
}

/**
 * §08.6 — "an unset `CI`", the way every other tool spells it: any non-empty
 * value means a non-interactive automated environment.
 *
 * It gates two unrelated things, which is why it lives here rather than in
 * either caller: the interactive half of the download prompt (§05.5), and
 * §15.23's frozen-lockfile default.
 */
export function isCI(): boolean {
  const ci = process.env.CI;
  return ci !== undefined && ci !== "";
}

/**
 * §15.23 / §15.37 — whether `.corepack.lock` may be written or refreshed.
 *
 * `COREPACK_FROZEN_LOCKFILE` wins in **both** directions when it is set: `1`
 * freezes, anything else thaws, including inside CI. With it unset, CI defaults
 * to frozen — the convention every package manager's own `--frozen-lockfile`
 * follows, and the behaviour that makes a CI run fail loudly instead of quietly
 * resolving a range to something the developer never saw.
 *
 * @param options `refresh` marks a command the user ran *in order to* update the
 * resolution (`corepack up`). The CI default must not block that — it exists to
 * stop an *implicit* update — but an explicit `COREPACK_FROZEN_LOCKFILE=1` still
 * does, because §15.37 defines it as "refuse to write/refresh".
 */
export function isFrozenLockfile(options?: { refresh?: boolean }): boolean {
  const raw = process.env.COREPACK_FROZEN_LOCKFILE;
  if (raw !== undefined && raw !== "") return raw === "1";
  return options?.refresh === true ? false : isCI();
}
