import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyEnvFile,
  DEFAULT_ENV_FILE_NAME,
  ENV_FILE_INELIGIBLE,
  SECURITY_ONLY_FROM_ENVIRONMENT,
  envDisabled,
  envFlag,
  isCI,
  isEnvFileEligible,
  isFrozenLockfile,
  loadEnvFileFrom,
  parseEnvFile,
} from "../../src/env.ts";
import { messages } from "../../src/errors.ts";

let dir: string;
let originalEnv: NodeJS.ProcessEnv;

/** Write `<dir>/<name>` and return its absolute path. */
function writeEnvFile(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

beforeEach(() => {
  originalEnv = process.env;
  // Work on a copy so assignments made by `applyEnvFile` never leak.
  process.env = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("COREPACK_")) {
      delete process.env[key];
    }
  }
  dir = mkdtempSync(join(tmpdir(), "pipack-env-"));
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("parseEnvFile", () => {
  it("parses dotenv-style content with node:util semantics", () => {
    const vars = parseEnvFile(
      [
        "# a comment",
        "COREPACK_ENABLE_AUTO_PIN=1",
        `COREPACK_NPM_REGISTRY="https://example.test/"`,
        "EMPTY=",
        "",
      ].join("\n"),
    );

    expect(vars).toEqual({
      COREPACK_ENABLE_AUTO_PIN: "1",
      COREPACK_NPM_REGISTRY: "https://example.test/",
      EMPTY: "",
    });
  });

  it("returns an empty record for an empty file", () => {
    expect(parseEnvFile("")).toEqual({});
  });
});

describe("loadEnvFileFrom", () => {
  it("reads .corepack.env from the given directory", () => {
    const path = writeEnvFile(DEFAULT_ENV_FILE_NAME, "COREPACK_ENABLE_AUTO_PIN=1\n");

    expect(loadEnvFileFrom(dir)).toEqual({
      path,
      vars: { COREPACK_ENABLE_AUTO_PIN: "1" },
    });
  });

  it("returns null when the file is missing, without throwing", () => {
    expect(loadEnvFileFrom(dir)).toBeNull();
  });

  it("propagates read errors other than ENOENT", () => {
    // A directory named `.corepack.env` fails with EISDIR, not ENOENT.
    mkdirSync(join(dir, DEFAULT_ENV_FILE_NAME));

    expect(() => loadEnvFileFrom(dir)).toThrow();
  });

  // Test 53.
  it("is disabled entirely by COREPACK_ENV_FILE=0", () => {
    writeEnvFile(DEFAULT_ENV_FILE_NAME, "COREPACK_ENABLE_AUTO_PIN=1\n");
    process.env.COREPACK_ENV_FILE = "0";

    expect(loadEnvFileFrom(dir)).toBeNull();
  });

  // Test 58.
  it("reads the file named by COREPACK_ENV_FILE and ignores .corepack.env", () => {
    writeEnvFile(DEFAULT_ENV_FILE_NAME, "COREPACK_ENABLE_AUTO_PIN=1\n");
    const other = writeEnvFile(".other.env", "COREPACK_ENABLE_STRICT=0\n");
    process.env.COREPACK_ENV_FILE = ".other.env";

    expect(loadEnvFileFrom(dir)).toEqual({
      path: other,
      vars: { COREPACK_ENABLE_STRICT: "0" },
    });
  });
});

describe("applyEnvFile", () => {
  // Test 52.
  it("applies eligible COREPACK_ variables to process.env", () => {
    applyEnvFile({ COREPACK_ENABLE_AUTO_PIN: "1" }, join(dir, DEFAULT_ENV_FILE_NAME));

    expect(process.env.COREPACK_ENABLE_AUTO_PIN).toBe("1");
    expect(envFlag("COREPACK_ENABLE_AUTO_PIN")).toBe(true);
  });

  // Test 59.
  it("ignores keys without the COREPACK_ prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    applyEnvFile(
      { HTTP_PROXY: "http://evil.test", NODE_OPTIONS: "--require=./evil.js", PATH: "/evil" },
      join(dir, DEFAULT_ENV_FILE_NAME),
    );

    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.NODE_OPTIONS).toBeUndefined();
    expect(process.env.PATH).toBe(originalEnv.PATH);
    // Non-prefixed keys are dropped silently — no warning is owed for them.
    expect(warn).not.toHaveBeenCalled();
  });

  // Test 57.
  it("lets a real environment variable win over the file", () => {
    process.env.COREPACK_NPM_REGISTRY = "https://real.test";

    applyEnvFile(
      { COREPACK_NPM_REGISTRY: "https://file.test", COREPACK_HOME: "/from-file" },
      join(dir, DEFAULT_ENV_FILE_NAME),
    );

    expect(process.env.COREPACK_NPM_REGISTRY).toBe("https://real.test");
    expect(process.env.COREPACK_HOME).toBe("/from-file");
  });

  it("keeps an empty real value winning over the file", () => {
    process.env.COREPACK_HOME = "";

    applyEnvFile({ COREPACK_HOME: "/from-file" }, join(dir, DEFAULT_ENV_FILE_NAME));

    expect(process.env.COREPACK_HOME).toBe("");
  });

  // Tests 60, 61, 62 — §14.5's five additions, each announced.
  describe.each([...SECURITY_ONLY_FROM_ENVIRONMENT])("%s", (name) => {
    it("is ignored when it comes from a file, with a warning on stderr", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const path = join(dir, DEFAULT_ENV_FILE_NAME);

      applyEnvFile({ [name]: "1" }, path);

      expect(process.env[name]).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        `! Ignoring ${name} from ${path}: this variable can only be set in the environment`,
      );
      expect(warn).toHaveBeenCalledWith(messages.ignoringEnvVar(name, path));
    });
  });

  // The two corepack already refuses are dropped without a word: conformance row
  // 48 asserts stderr is empty when a project's env file tries to turn the
  // download prompt on, and neither carries a security consequence to report.
  describe.each([...ENV_FILE_INELIGIBLE].filter((n) => !SECURITY_ONLY_FROM_ENVIRONMENT.has(n)))(
    "%s",
    (name) => {
      it("is ignored when it comes from a file, silently", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        applyEnvFile({ [name]: "1" }, join(dir, DEFAULT_ENV_FILE_NAME));

        expect(process.env[name]).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
      });
    },
  );

  it("drops every ineligible variable in one pass, warning once for each security one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = join(dir, DEFAULT_ENV_FILE_NAME);
    const vars = Object.fromEntries([...ENV_FILE_INELIGIBLE].map((name) => [name, "1"]));

    applyEnvFile({ ...vars, COREPACK_ENABLE_STRICT: "0" }, path);
    // A second application of the same file must not repeat the warnings.
    applyEnvFile({ ...vars, COREPACK_ENABLE_STRICT: "0" }, path);

    for (const name of ENV_FILE_INELIGIBLE) {
      expect(process.env[name]).toBeUndefined();
    }
    expect(process.env.COREPACK_ENABLE_STRICT).toBe("0");
    expect(warn).toHaveBeenCalledTimes(SECURITY_ONLY_FROM_ENVIRONMENT.size);
  });

  it("cannot re-enable env files through the file itself", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.COREPACK_ENV_FILE = "0";

    applyEnvFile({ COREPACK_ENV_FILE: ".corepack.env" }, join(dir, DEFAULT_ENV_FILE_NAME));

    expect(process.env.COREPACK_ENV_FILE).toBe("0");
  });
});

/* ------------------------------------------------------------------ *
 * §15.37 — the TLS pair is INELIGIBLE
 *
 * A cloned repository must not be able to nominate the certificate
 * authority its own downloads are verified against, nor to switch that
 * verification off. Both are trust decisions, and §15.37's table marks
 * them "Env file: no" for the same reason the token is.
 * ------------------------------------------------------------------ */

describe("§15.37 — COREPACK_CAFILE and COREPACK_STRICT_SSL (§15.4)", () => {
  it.for([["COREPACK_CAFILE"], ["COREPACK_STRICT_SSL"]])(
    "%s is ineligible, security-relevant, and announced",
    ([name]) => {
      expect(ENV_FILE_INELIGIBLE.has(name!)).toBe(true);
      expect(SECURITY_ONLY_FROM_ENVIRONMENT.has(name!)).toBe(true);
      expect(isEnvFileEligible(name!)).toBe(false);

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const path = join(dir, DEFAULT_ENV_FILE_NAME);

      applyEnvFile({ [name!]: name === "COREPACK_CAFILE" ? "/tmp/evil.pem" : "0" }, path);

      expect(process.env[name!]).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(messages.ignoringEnvVar(name!, path));
    },
  );

  it("still lets the real environment set them", () => {
    process.env.COREPACK_STRICT_SSL = "0";
    process.env.COREPACK_CAFILE = "/etc/corp.pem";

    applyEnvFile({ COREPACK_STRICT_SSL: "1" }, join(dir, DEFAULT_ENV_FILE_NAME));

    expect(process.env.COREPACK_STRICT_SSL).toBe("0");
    expect(process.env.COREPACK_CAFILE).toBe("/etc/corp.pem");
  });
});

describe("isEnvFileEligible", () => {
  it("accepts the behavioural variables only", () => {
    expect(isEnvFileEligible("COREPACK_ENABLE_AUTO_PIN")).toBe(true);
    expect(isEnvFileEligible("COREPACK_ENABLE_PROJECT_SPEC")).toBe(true);
    expect(isEnvFileEligible("COREPACK_ENABLE_STRICT")).toBe(true);
    expect(isEnvFileEligible("COREPACK_DEFAULT_TO_LATEST")).toBe(true);
    expect(isEnvFileEligible("COREPACK_ENABLE_NETWORK")).toBe(true);
    expect(isEnvFileEligible("COREPACK_HOME")).toBe(true);
    expect(isEnvFileEligible("COREPACK_NPM_REGISTRY")).toBe(true);
    // §15.37 marks the per-source overrides eligible, on the same footing as
    // `COREPACK_NPM_REGISTRY`: they redirect a download, which a project may
    // do, rather than deciding who is trusted, which it may not.
    expect(isEnvFileEligible("COREPACK_REGISTRY_YARN")).toBe(true);
    expect(isEnvFileEligible("COREPACK_REGISTRY_PNPM")).toBe(true);
    expect(isEnvFileEligible("COREPACK_NODE_EXECPATH")).toBe(true);
    // §15.37 — mandating signed sources is a policy a project may state, unlike
    // the trust store itself (§14.5), which a cloned repo must never supply.
    expect(isEnvFileEligible("COREPACK_REQUIRE_SIGNATURES")).toBe(true);
    // §15.5's two knobs are preferences — how long to wait, how often to try
    // again — and §15.37's table marks them eligible.
    expect(isEnvFileEligible("COREPACK_NETWORK_TIMEOUT")).toBe(true);
    expect(isEnvFileEligible("COREPACK_NETWORK_RETRIES")).toBe(true);
    // §15.37 marks §15.13's shim directory eligible: where a project's tooling
    // lands is a preference, not a security boundary — nothing is executed from
    // it that was not already going to run. Asserted explicitly so a later edit
    // to ENV_FILE_INELIGIBLE cannot quietly withdraw it.
    expect(isEnvFileEligible("COREPACK_SHIM_DIRECTORY")).toBe(true);
    // §15.24's opt-in: choosing to accept prereleases is a project's call, and
    // it widens a candidate set rather than deciding who is trusted.
    expect(isEnvFileEligible("COREPACK_ENABLE_PRERELEASES")).toBe(true);

    // §15.11 / §15.37 — the one opt-out from "every artifact clears a
    // verification tier". Eligibility is a deny-list, so a new COREPACK_*
    // variable is env-file eligible with no edit to `env.ts` at all; these two
    // assertions are what make the omission fail a test rather than silently
    // hand a cloned repository the ability to permit its own unverified
    // download.
    expect(isEnvFileEligible("COREPACK_ALLOW_UNVERIFIED")).toBe(false);
    expect(SECURITY_ONLY_FROM_ENVIRONMENT.has("COREPACK_ALLOW_UNVERIFIED")).toBe(true);

    for (const name of ENV_FILE_INELIGIBLE) {
      expect(isEnvFileEligible(name)).toBe(false);
    }
    expect(isEnvFileEligible("HTTP_PROXY")).toBe(false);
    expect(isEnvFileEligible("PATH")).toBe(false);
  });
});

describe("envFlag / envDisabled", () => {
  it("matches the exact strings only", () => {
    for (const [value, flag, disabled] of [
      ["1", true, false],
      ["0", false, true],
      ["true", false, false],
      ["yes", false, false],
      ["", false, false],
      ["01", false, false],
      [" 1", false, false],
      ["1 ", false, false],
    ] as const) {
      process.env.COREPACK_ENABLE_AUTO_PIN = value;
      expect(envFlag("COREPACK_ENABLE_AUTO_PIN"), value).toBe(flag);
      expect(envDisabled("COREPACK_ENABLE_AUTO_PIN"), value).toBe(disabled);
    }

    delete process.env.COREPACK_ENABLE_AUTO_PIN;
    expect(envFlag("COREPACK_ENABLE_AUTO_PIN")).toBe(false);
    expect(envDisabled("COREPACK_ENABLE_AUTO_PIN")).toBe(false);
  });
});

describe("isCI / isFrozenLockfile — §15.23, §15.37", () => {
  beforeEach(() => {
    delete process.env.CI;
  });

  it("treats any non-empty CI value as CI, and an empty one as unset", () => {
    expect(isCI()).toBe(false);
    process.env.CI = "";
    expect(isCI()).toBe(false);
    process.env.CI = "true";
    expect(isCI()).toBe(true);
  });

  it("defaults to thawed outside CI and frozen inside it", () => {
    expect(isFrozenLockfile()).toBe(false);

    process.env.CI = "1";
    expect(isFrozenLockfile()).toBe(true);
    // ...but a command the user ran *to* refresh the file is not what the CI
    // default is guarding against.
    expect(isFrozenLockfile({ refresh: true })).toBe(false);
  });

  it("lets an explicit value win in both directions, refresh included", () => {
    process.env.COREPACK_FROZEN_LOCKFILE = "1";
    expect(isFrozenLockfile()).toBe(true);
    expect(isFrozenLockfile({ refresh: true })).toBe(true);

    process.env.CI = "1";
    process.env.COREPACK_FROZEN_LOCKFILE = "0";
    expect(isFrozenLockfile()).toBe(false);

    // An empty value is "unset", as everywhere else in this module.
    process.env.COREPACK_FROZEN_LOCKFILE = "";
    expect(isFrozenLockfile()).toBe(true);
  });

  // §15.37 marks it env-file eligible: it is a behavioural preference, not a
  // security decision, so a project may ship it in `.corepack.env`.
  it("is settable from an env file", () => {
    expect(isEnvFileEligible("COREPACK_FROZEN_LOCKFILE")).toBe(true);

    applyEnvFile({ COREPACK_FROZEN_LOCKFILE: "1" }, join(dir, DEFAULT_ENV_FILE_NAME));

    expect(process.env.COREPACK_FROZEN_LOCKFILE).toBe("1");
    expect(isFrozenLockfile()).toBe(true);
  });
});
