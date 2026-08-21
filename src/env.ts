/**
 * Environment and `.corepack.env` — §03.2, §11, §14.5.
 *
 * Reading the environment is the *only* configuration input the tool has. There
 * is no config file, no user profile, no registry of registries.
 */

/** §11 — every variable the tool reads, so the whole block is read in one pass. */
export const ENV_VARS = [
  "COREPACK_ENABLE_PROJECT_SPEC",
  "COREPACK_ENABLE_STRICT",
  "COREPACK_ENABLE_AUTO_PIN",
  "COREPACK_DEFAULT_TO_LATEST",
  "COREPACK_ENABLE_NETWORK",
  "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "COREPACK_ENV_FILE",
  "COREPACK_HOME",
  "COREPACK_NPM_REGISTRY",
  "COREPACK_NPM_TOKEN",
  "COREPACK_NPM_USERNAME",
  "COREPACK_NPM_PASSWORD",
  "COREPACK_INTEGRITY_KEYS",
  "COREPACK_NODE_EXECPATH",
] as const;

/**
 * §03.2 + §14.5 — variables an env file may never supply.
 *
 * `COREPACK_ENV_FILE` is chicken-and-egg; `COREPACK_ENABLE_DOWNLOAD_PROMPT`'s
 * default depends on how the tool was invoked, which a project file must not be
 * able to override. The rest are §14.5's security additions: a hostile repo must
 * not be able to disable signature verification, point at an arbitrary host, or
 * pair a token with a hostile registry to exfiltrate it.
 */
export const ENV_FILE_INELIGIBLE = new Set([
  "COREPACK_ENV_FILE",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "COREPACK_INTEGRITY_KEYS",
  "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  "COREPACK_NPM_TOKEN",
  "COREPACK_NPM_USERNAME",
  "COREPACK_NPM_PASSWORD",
]);

/** dotenv-style parse, matching `node:util`'s `parseEnv` semantics. */
export function parseEnvFile(content: string): Record<string, string> {
  throw new Error(`TODO(T4): parseEnvFile(${content.length} chars)`);
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
  throw new Error(`TODO(T4): loadEnvFileFrom(${dir})`);
}

/**
 * Filter to `COREPACK_`-prefixed, drop the ineligible set (warning once each),
 * then merge as `{...fileVars, ...process.env}` — the real environment wins —
 * and assign the result to `process.env` for the remainder of the run.
 */
export function applyEnvFile(vars: Record<string, string>, path: string): void {
  throw new Error(`TODO(T4): applyEnvFile(${path})`);
}

export function isEnvFileEligible(name: string): boolean {
  throw new Error(`TODO(T4): isEnvFileEligible(${name})`);
}

/** `true` only for the exact string `"1"`, matching the spec's value tables. */
export function envFlag(name: string): boolean {
  throw new Error(`TODO(T4): envFlag(${name})`);
}

/** `true` only for the exact string `"0"`. */
export function envDisabled(name: string): boolean {
  throw new Error(`TODO(T4): envDisabled(${name})`);
}
