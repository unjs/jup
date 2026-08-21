import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messages } from "../../src/errors.ts";
import { resolveBinPath } from "../../src/exec.ts";
import type { BinList, BinSpec } from "../../src/types.ts";

/**
 * §08.4's contract is about how a *process* ends, so every one of these cases is
 * run in a real child process: `process.exitCode`, an uncaught error resetting it
 * to 1, and a `beforeExit` hook are all invisible from inside the test runner.
 * The child loads `src/exec.ts` through Node's own type stripping.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(
  new RegExp(`${sep === "\\" ? "\\\\" : sep}$`),
  "",
);
const EXEC_URL = pathToFileURL(join(REPO_ROOT, "src", "exec.ts")).href;

/** A single-file download's URL, whose basename is what a `bin` list resolves to. */
const YARN_URL = "https://repo.yarnpkg.com/4.0.0/packages/yarnpkg-cli/bin/yarn.js";
/** A tarball URL, so the `bin` map branch is the one under test. */
const TGZ_URL = "https://registry.npmjs.org/yarn/-/yarn-1.0.0.tgz";

let root: string;
let driver: string;

/** Lay out `<root>/<name>/yarn/<version>/` and write `files` into it. */
function fixture(name: string, files: Record<string, string>, version = "1.0.0"): string {
  const location = join(root, name, "yarn", version);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(location, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(location, { recursive: true });
  return location;
}

function run(
  location: string,
  binName: string,
  specUrl: string,
  bin: BinSpec | BinList,
  args: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [driver, location, binName, specUrl, JSON.stringify(bin), ...args],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "pipack-exec-"));
  driver = join(root, "driver.mjs");
  writeFileSync(
    driver,
    [
      `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
      `const [location, binName, specUrl, binJson, ...args] = process.argv.slice(2);`,
      `execPackageManager(binName, { location, bin: JSON.parse(binJson), hash: "" }, args, specUrl);`,
      ``,
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveBinPath — §08.1", () => {
  it("resolves a bin map entry against the install location", () => {
    const spec = {
      location: join(root, "map", "yarn", "1.0.0"),
      bin: { yarn: "./bin/yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec, TGZ_URL)).toBe(join(spec.location, "bin", "yarn.js"));
  });

  it("resolves a bin list entry to the basename of the spec URL path", () => {
    const spec = {
      location: join(root, "list", "yarn", "4.0.0"),
      bin: ["yarn", "yarnpkg"],
      hash: "",
    };
    expect(resolveBinPath("yarn", spec, YARN_URL)).toBe(join(spec.location, "yarn.js"));
    expect(resolveBinPath("yarnpkg", spec, YARN_URL)).toBe(join(spec.location, "yarn.js"));
  });

  it("leaves the path unset for a bin list whose URL is not a .js file", () => {
    const spec = { location: join(root, "list", "yarn", "1.22.0"), bin: ["yarn"], hash: "" };
    expect(() => resolveBinPath("yarn", spec, TGZ_URL)).toThrow(
      messages.assertUnableToLocateBinPath("yarn"),
    );
  });

  it("leaves the path unset for a bin name that is not declared", () => {
    const spec = {
      location: join(root, "map", "yarn", "1.0.0"),
      bin: { yarn: "./bin/yarn.js" },
      hash: "",
    };
    expect(() => resolveBinPath("yarnpkg", spec, TGZ_URL)).toThrow(
      messages.assertUnableToLocateBinPath("yarnpkg"),
    );
    expect(() => resolveBinPath("yarn", { ...spec, bin: ["yarnpkg"] }, YARN_URL)).toThrow(
      messages.assertUnableToLocateBinPath("yarn"),
    );
  });

  it("does not treat inherited object properties as declared bins", () => {
    const spec = { location: join(root, "map", "yarn", "1.0.0"), bin: {} as BinSpec, hash: "" };
    expect(() => resolveBinPath("constructor", spec, TGZ_URL)).toThrow(
      messages.assertUnableToLocateBinPath("constructor"),
    );
  });
});

describe("execPackageManager — §08.4 exit codes", () => {
  it("test 132 — a synchronously set exit code 42 is the tool's exit code", () => {
    const location = fixture("sync", { "bin/yarn.js": `process.exitCode = 42;\n` });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(42);
  });

  it("test 133 — exit code 42 then an uncaught error exits 1, with the message on stderr", () => {
    const location = fixture("throw", {
      "bin/yarn.js": `process.exitCode = 42;\nthrow new Error("kaboom-from-the-package-manager");\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    // The runtime's own rule, which the tool must not override (corepack 0.18.1).
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("kaboom-from-the-package-manager");
  });

  it("test 133b — an asynchronously thrown error also exits 1 rather than 42", () => {
    const location = fixture("throw-async", {
      "bin/yarn.js": `process.exitCode = 42;\nsetTimeout(() => { throw new Error("late-kaboom"); }, 0);\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("late-kaboom");
  });

  it("test 134 — an exit code set only in a beforeExit hook survives", () => {
    const location = fixture("before-exit", {
      "bin/yarn.js": `process.on("beforeExit", () => { process.exitCode = 42; });\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(42);
  });

  it("a package manager that returns normally exits 0", () => {
    const location = fixture("clean", { "bin/yarn.js": `console.log("ran");\n` });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ran\n");
  });
});

describe("execPackageManager — §08.2 handover", () => {
  it("test 135 — an ESM entry point runs", () => {
    const location = fixture("esm", {
      "package.json": `{"type":"module"}\n`,
      "bin/yarn.js": [
        `import { pathToFileURL } from "node:url";`,
        `console.log("esm-ok", import.meta.url === pathToFileURL(process.argv[1]).href);`,
        ``,
      ].join("\n"),
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("esm-ok true\n");
  });

  it("a CJS entry point runs with require.main undefined (pnpm's version detection)", () => {
    const location = fixture("cjs", {
      "bin/yarn.js": `console.log("main:", require.main === undefined, "execArgv:", JSON.stringify(process.execArgv));\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("main: true execArgv: []\n");
  });

  it("test 136 — a bin list resolves every declared name to the same file", () => {
    const location = fixture(
      "binlist",
      { "yarn.js": `console.log(process.argv[1], JSON.stringify(process.argv.slice(2)));\n` },
      "4.0.0",
    );
    const yarn = run(location, "yarn", YARN_URL, ["yarn", "yarnpkg"], ["--version"]);
    const yarnpkg = run(location, "yarnpkg", YARN_URL, ["yarn", "yarnpkg"], ["--version"]);
    expect(yarn.status).toBe(0);
    expect(yarnpkg.status).toBe(0);
    expect(yarn.stdout).toBe(`${join(location, "yarn.js")} ["--version"]\n`);
    // Both names run the same file, with the same argv.
    expect(yarnpkg.stdout).toBe(yarn.stdout);
  });

  it("passes the arguments through untouched after argv[0] and argv[1]", () => {
    const location = fixture("argv", {
      "bin/yarn.js": `console.log(JSON.stringify([process.argv[0] === process.execPath, process.argv.slice(1)]));\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" }, [
      "add",
      "-D",
      "--",
      "x y",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      true,
      [join(location, "bin", "yarn.js"), "add", "-D", "--", "x y"],
    ]);
  });
});

describe("execPackageManager — §08.7 environment", () => {
  it("test 51 — COREPACK_ROOT points at our own installation root and is visible to the child", () => {
    const location = fixture("env", {
      "bin/yarn.js": `console.log(process.env.COREPACK_ROOT);\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(REPO_ROOT);
  });
});

describe("resolveBinPath — §14.13 confinement", () => {
  it("test 141 — a bin value escaping the install directory is refused", () => {
    const spec = {
      location: join(root, "evil", "yarn", "1.0.0"),
      bin: { yarn: "../../../evil" },
      hash: "",
    };
    expect(() => resolveBinPath("yarn", spec, TGZ_URL)).toThrow(
      messages.binEscapes("../../../evil", "yarn", "1.0.0"),
    );
  });

  it("test 141 — the escaping bin is refused before anything is executed", () => {
    const location = fixture("evil", { "bin/yarn.js": `console.log("should not run");\n` });
    // Plant the file the malicious bin points at, so a missing target cannot be
    // what makes this test pass.
    writeFileSync(join(root, "evil.js"), `console.log("pwned");\n`);
    const result = run(location, "yarn", TGZ_URL, { yarn: "../../../evil.js" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(messages.binEscapes("../../../evil.js", "yarn", "1.0.0"));
  });

  it("refuses an absolute bin path", () => {
    const spec = {
      location: join(root, "abs", "yarn", "1.0.0"),
      bin: { yarn: "/etc/passwd" },
      hash: "",
    };
    expect(() => resolveBinPath("yarn", spec, TGZ_URL)).toThrow(
      messages.binEscapes("/etc/passwd", "yarn", "1.0.0"),
    );
  });

  it("accepts a bin path that only looks like it escapes", () => {
    const spec = {
      location: join(root, "ok", "yarn", "1.0.0"),
      bin: { yarn: "./bin/../bin/yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec, TGZ_URL)).toBe(
      join(spec.location, "bin", "..", "bin", "yarn.js"),
    );
  });
});
