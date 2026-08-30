/**
 * §02.3 — tools, not only package managers (rows 230–236).
 *
 * The table has always held one *kind* of thing. §02.4 built the machinery that
 * makes a non-JavaScript, per-host tool an ordinary entry, and once that exists
 * "package manager" stops being a property of the pipeline and is only a
 * property of the manifest field an entry is declared in. `kind` is that
 * property, `node` is the first entry carrying `kind: "runtime"`, and these rows
 * are the four things §02.3 says `kind` may decide — plus the one thing it must
 * not, which is anything at all between resolution and execution.
 *
 * So the shape of this file is deliberately lopsided. Row 230 proves node is an
 * ordinary §02.4 entry (launcher for versions, per-host package for bytes, run
 * directly) in a single assertion, because there is nothing new there to test.
 * Everything else is about §03 and §10: which field speaks (231, 232), which
 * field may not (233), where a pin is written (234), and what a bare `enable`
 * claims (235). Row 236 is the host vocabulary, which node exercises differently
 * from every entry before it — it publishes an architecture the table has no
 * name for.
 *
 * The mock publishes under `hostTarget()`, so the suite asserts about whatever
 * host it is running on rather than about Linux.
 *
 * POSIX only, for the reason `15-28-native.test.ts` gives: the artifact has to
 * be a real executable, a `#!/bin/sh` script is one on a POSIX host and is
 * nothing on Windows, and a committed `.exe` is not worth carrying.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostTarget } from "../../src/config/table.ts";
import { messages } from "../../src/errors.ts";
import {
  cleanupFixtures,
  createFixture,
  type Fixture,
  makeTarball,
  MockRegistry,
  npmTarball,
  packageManagerTarball,
  run,
  withoutDownloadNotices,
} from "./_harness/index.ts";

const POSIX = process.platform !== "win32";

const registry = new MockRegistry();

const NODE_VERSION = "22.23.2";
const NODE_OTHER = "24.20.0";
const PNPM_VERSION = "11.1.2";

/**
 * The per-host package `{target}` resolves to on *this* machine.
 *
 * Three of the six are renames, and the reason is worth restating where it is
 * being relied on: the packages are `node-<platform>-<arch>` with `win32` spelled
 * `win`, and on Apple Silicon the prefix is `node-bin-` rather than `node-`
 * because `node-darwin-arm64` belongs to an unrelated publisher and stops at
 * 18.9.0. `node-bin-setup` — the launcher's own installer — makes exactly that
 * substitution, so the table's map is that rule rather than an invention.
 */
const NODE_TARGETS: Record<string, string> = {
  "darwin-arm64": "bin-darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
  "win32-arm64": "win-arm64",
  "win32-x64": "win-x64",
};

const NODE_PACKAGE = `node-${NODE_TARGETS[hostTarget()]}`;

/** Reports the name it was invoked under and its arguments. See `15-21`'s copy. */
const PROBE = `#!/bin/sh\nprintf 'ran=%s args=%s\\n' "$(basename "$0")" "$*"\n`;

/**
 * node's per-host packages **do** declare a `bin` — `bin/node`, and
 * `bin/node.exe` on the two Windows targets — so §07.7 reads it and the table's
 * copy is the ordinary fallback, as with aube rather than with bun.
 */
function artifact(version: string): Uint8Array {
  return makeTarball([
    {
      path: "package/package.json",
      content: `${JSON.stringify({ name: NODE_PACKAGE, version, bin: { node: "bin/node" } })}\n`,
      mode: 0o644,
    },
    { path: "package/bin/node", content: PROBE, mode: 0o755 },
  ]);
}

beforeAll(async () => {
  if (!POSIX) return;
  await registry.start();

  // The launcher, which is where §04 asks what versions exist. Its own tarball
  // is a ~1.8 kB `preinstall` stub and is never downloaded.
  for (const version of [NODE_VERSION, NODE_OTHER]) {
    registry.publish("node", version, npmTarball({ "package.json": "{}\n" }), {
      distTags: { latest: NODE_OTHER },
    });
  }

  // The artifacts, which is where §06 asks what the bytes should be.
  registry.publish(NODE_PACKAGE, NODE_VERSION, artifact(NODE_VERSION));
  registry.publish(NODE_PACKAGE, NODE_OTHER, artifact(NODE_OTHER));

  // A package manager to stand beside it: every row about "which field speaks"
  // needs a project that has already answered the other question.
  registry.publish("pnpm", PNPM_VERSION, packageManagerTarball("pnpm", PNPM_VERSION));
});

afterAll(async () => {
  cleanupFixtures();
  if (POSIX) await registry.stop();
});

describe.skipIf(!POSIX)("§02.3 node, and tools that are not package managers", () => {
  function options(fixture: Fixture, env?: Record<string, string | undefined>) {
    return {
      cwd: fixture.cwd,
      home: fixture.home,
      registry,
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...env },
    };
  }

  it("230: `node@<version>` installs the host's artifact package and runs it directly", async () => {
    const fixture = createFixture();
    registry.reset();

    const result = await run([`node@${NODE_VERSION}`, "--version"], options(fixture));

    expect(withoutDownloadNotices(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ran=node args=--version");

    // §02.4's split, unchanged by the `kind`: the version line comes from the
    // launcher and the bytes from the per-host package, and the launcher's own
    // tarball — a `preinstall` stub that shells out to `npm install` — is never
    // fetched. A runtime needed no new machinery, and this is that claim.
    const fetched = registry.requests.map((request) => request.path);
    expect(fetched.some((path) => path.includes(`${NODE_PACKAGE}/-/`))).toBe(true);
    expect(fetched.some((path) => path.includes("/node/-/"))).toBe(false);

    // §07.7 — the package declares its own `bin`, so that is what the marker
    // records; the table agrees, and did not have to.
    expect(JSON.parse(readMarker(fixture, "node", NODE_VERSION)).bin).toEqual({
      node: "bin/node",
    });
  });

  it("231: a package-manager pin is not a reason to refuse a runtime", async () => {
    const fixture = createFixture({
      name: "app",
      packageManager: `pnpm@${PNPM_VERSION}`,
      devEngines: { runtime: { name: "node", version: NODE_VERSION } },
    });

    // §03.5's mismatch cannot arise across kinds, because the spec being
    // reconciled is the one for the *requested tool*: `node` reads
    // `devEngines.runtime` and never sees the pin beside it. Before §02.3 this
    // was `This project is configured to use pnpm`.
    const node = await run(["node", "server.js"], options(fixture));
    expect(withoutDownloadNotices(node.stderr)).toBe("");
    expect(node.exitCode).toBe(0);
    expect(node.stdout.trim()).toBe("ran=node args=server.js");

    // And the traffic runs both ways: the runtime declaration beside the pin
    // changes nothing about what `pnpm` resolves to.
    const pnpm = await run(["pnpm", "install"], options(fixture));
    expect(pnpm.exitCode).toBe(0);
    expect(pnpm.stdout).toContain(PNPM_VERSION);
  });

  it("232: both members are read, and neither constrains the other", async () => {
    const fixture = createFixture({
      name: "app",
      packageManager: `pnpm@${PNPM_VERSION}`,
      devEngines: { runtime: { name: "node", version: "22.x" } },
    });

    // The runtime resolves *within its own range* — 24.20.0 is `latest` and is
    // not what this project asked for — while the package manager resolves from
    // the pin. One manifest, two answers, no conflict: they describe different
    // tools, so §03.3's cross-checks have nothing to compare.
    expect((await run(["node", "-e", "0"], options(fixture))).exitCode).toBe(0);
    expect(existsSync(join(fixture.home, "v1", "node", NODE_VERSION))).toBe(true);
    expect(existsSync(join(fixture.home, "v1", "node", NODE_OTHER))).toBe(false);

    expect((await run(["pnpm", "--version"], options(fixture))).stdout).toContain(PNPM_VERSION);
  });

  it("233: `packageManager` may not name a runtime, and says where it belongs", async () => {
    const fixture = createFixture({ name: "app", packageManager: `node@${NODE_VERSION}` });
    registry.reset();

    // The refusal fires when something *reads* the field, which is any request
    // for a package manager — that is what the field is for, and §03.5 is about
    // to enforce it. The message names the member that would have worked.
    const result = await run(["pnpm", "install"], options(fixture));

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trim()).toBe(messages.runtimeInPackageManager("node"));
    // §03.4 raises it on the parse, so nothing is resolved and nothing is
    // requested — the manifest is wrong before any question is asked.
    expect(registry.requests).toHaveLength(0);
  });

  it("233: and the stray field does not quietly become the runtime's pin", async () => {
    const fixture = createFixture({ name: "app", packageManager: `node@${NODE_VERSION}` });

    // §02.3 — the top-level field speaks for package managers, full stop. A
    // runtime request reads `devEngines.runtime`, finds nothing, and falls back
    // (§03.5), so this project says nothing about the runtime and gets the
    // default rather than the 22.23.2 someone wrote in the wrong place. Honouring
    // it here would be honouring a field the previous row refuses to read.
    const result = await run(["node", "--version"], options(fixture));
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(fixture.home, "v1", "node", NODE_VERSION))).toBe(false);
  });

  it("233: the same field may still be overwritten, because reading it is lazy", async () => {
    const fixture = createFixture({ name: "app", packageManager: `node@${NODE_VERSION}` });

    // §03.1's laziness is what makes this recoverable: `use` is about to replace
    // the field, so it must not be blocked by what the field currently says.
    const result = await run(["use", `pnpm@${PNPM_VERSION}`], options(fixture));
    expect(result.exitCode).toBe(0);
    expect((fixture.json("package.json") as { packageManager: string }).packageManager).toMatch(
      new RegExp(`^pnpm@${PNPM_VERSION.replaceAll(".", "\\.")}\\+sha`),
    );
  });

  it("234: `use node@…` writes `devEngines.runtime` and creates no `packageManager`", async () => {
    const fixture = createFixture({ name: "app", packageManager: `pnpm@${PNPM_VERSION}` });

    const result = await run(["use", `node@${NODE_VERSION}`], options(fixture));
    expect(result.exitCode).toBe(0);
    // §03.7 — every mutating command names the file it touched.
    expect(result.stdout).toContain(fixture.path("package.json"));

    const manifest = fixture.json("package.json") as {
      packageManager: string;
      devEngines: { runtime: { name: string; version: string } };
    };
    // The member is created around the pin, `name` included: §03.3 reads `name`
    // first and a member without one describes nothing.
    expect(manifest.devEngines.runtime.name).toBe("node");
    expect(manifest.devEngines.runtime.version).toBe(NODE_VERSION);
    // The package manager beside it is untouched — a runtime has no business in
    // that field (row 233), so `use` cannot have put one there.
    expect(manifest.packageManager).toBe(`pnpm@${PNPM_VERSION}`);

    // §02.3 — a runtime declares no `commands.use`, so `use` returns after the
    // write rather than running an install. What `pnpm install` would have
    // printed is the probe's line, and it is not here.
    expect(result.stdout).not.toContain("ran=");

    // §03.7 steps 5–8 — the member is inserted at the nesting the document is
    // already using. It sits one level inside `devEngines`, so its own keys are
    // two levels in, and getting that wrong is invisible to every assertion
    // above: the manifest still parses and still reads back correctly.
    expect(fixture.read("package.json")).toContain(
      '  "devEngines": {\n    "runtime": {\n      "name": "node",\n',
    );

    // And the manifest it just wrote is one it reads back: the next run resolves
    // from the member without asking the registry anything.
    registry.reset();
    expect((await run(["node", "-e", "0"], options(fixture))).exitCode).toBe(0);
    expect(registry.requests).toHaveLength(0);
  });

  it("234: `use node@<range>` keeps the range in the member and records it", async () => {
    const fixture = createFixture({ name: "app" });

    const result = await run(["use", "node@22.x"], options(fixture));
    expect(result.exitCode).toBe(0);

    const manifest = fixture.json("package.json") as {
      devEngines: { runtime: { name: string; version: string } };
    };
    // §04.4 — a runtime's field is validated as a semver range, so a typed
    // range goes in as written, exactly as `packageManager` takes one.
    expect(manifest.devEngines.runtime).toMatchObject({ name: "node", version: "22.x" });
    expect(
      (
        fixture.json("jup.lock") as {
          resolutions: Record<string, { resolved: string } | undefined>;
        }
      ).resolutions["node@22.x"]?.resolved,
    ).toBe(NODE_VERSION);

    // And the next run answers from that record, with no request at all.
    registry.reset();
    expect((await run(["node", "-e", "0"], options(fixture))).exitCode).toBe(0);
    expect(registry.requests).toHaveLength(0);
  });

  it("234: `use node@…` creates the whole block when the manifest has no devEngines", async () => {
    const fixture = createFixture({ name: "app" });

    expect((await run(["use", `node@${NODE_VERSION}`], options(fixture))).exitCode).toBe(0);

    const manifest = fixture.json("package.json") as {
      packageManager?: unknown;
      devEngines: { runtime: { name: string; version: string } };
    };
    expect(manifest.devEngines.runtime).toMatchObject({ name: "node", version: NODE_VERSION });
    // §03.7 bullet 2, arrived at from the other direction: a runtime's pin has
    // exactly one home, so there is no second field for `use` to create.
    expect(manifest.packageManager).toBeUndefined();
    // The document's own formatting survives the insertion (§03.7 steps 5–8).
    expect(fixture.read("package.json")).toContain('  "devEngines": {\n');
  });

  it("234: the member is created beside an existing devEngines block", async () => {
    const fixture = createFixture({
      name: "app",
      packageManager: `pnpm@${PNPM_VERSION}`,
      devEngines: { packageManager: { name: "pnpm" } },
    });

    expect((await run(["use", `node@${NODE_VERSION}`], options(fixture))).exitCode).toBe(0);

    const manifest = fixture.json("package.json") as {
      devEngines: { runtime: { name: string; version: string }; packageManager: { name: string } };
    };
    expect(manifest.devEngines.runtime).toMatchObject({ name: "node", version: NODE_VERSION });
    // The declaration already there is untouched — it speaks for a different
    // tool, and §03.3 is explicit that neither member constrains the other.
    expect(manifest.devEngines.packageManager).toEqual({ name: "pnpm" });
    // And it is inserted at the nesting its sibling uses, not at the document's.
    expect(fixture.read("package.json")).toContain(
      '    "runtime": {\n      "name": "node",\n      "version": "' + NODE_VERSION + '"\n    },',
    );
  });

  it("234: a warned name mismatch leaves the member describing one tool, not two", async () => {
    const fixture = createFixture({
      name: "app",
      devEngines: { runtime: { name: "deno", version: "2.x", onFail: "warn" } },
    });

    // `onFail: "warn"` lets the write proceed where the default would have
    // thrown. For a package manager the pin then goes to the top-level field and
    // `devEngines` is left alone; a runtime has no such second home, so the name
    // has to be corrected in place — otherwise the member would carry node's
    // version under deno's name, and §03.3 would read it back as deno's pin.
    const result = await run(["use", `node@${NODE_VERSION}`], options(fixture));
    expect(result.exitCode).toBe(0);

    const manifest = fixture.json("package.json") as {
      devEngines: { runtime: { name: string; version: string; onFail: string } };
    };
    expect(manifest.devEngines.runtime.name).toBe("node");
    expect(manifest.devEngines.runtime.version).toBe(NODE_VERSION);
    // Everything else the user wrote survives the surgical edit.
    expect(manifest.devEngines.runtime.onFail).toBe("warn");
  });

  it("235: a bare `enable` never claims a runtime's name; naming it does", async () => {
    const fixture = createFixture({ name: "app" });
    const shims = join(fixture.root, "shims");

    expect((await run(["enable", "--install-directory", shims], options(fixture))).exitCode).toBe(
      0,
    );
    // §02.3 makes this a requirement rather than a judgement call: §10.7's test
    // is whether the name means anything outside a project, and a runtime's does
    // by definition. `node` is the case where getting it wrong would be worst.
    expect(existsSync(join(shims, "node"))).toBe(false);
    expect(existsSync(join(shims, "pnpm"))).toBe(true);

    expect(
      (await run(["enable", "node", "--install-directory", shims], options(fixture))).exitCode,
    ).toBe(0);
    expect(existsSync(join(shims, "node"))).toBe(true);

    // Removal has no such hazard, so a bare `disable` covers the opt-out.
    expect((await run(["disable", "--install-directory", shims], options(fixture))).exitCode).toBe(
      0,
    );
    expect(existsSync(join(shims, "node"))).toBe(false);
  });

  // Row 236 — the hosts node does *not* publish for — lives in
  // `test/unit/config.test.ts` beside bun's, aube's and nub's, for the reason
  // that file gives: `process.platform` and `process.arch` are read-only on a
  // real process, so the only way to reach either branch is to redefine them,
  // and that is not something a spawned run can do to itself. What the rows
  // there assert is the requirement stated here — both errors are raised from
  // the URL template, before any request exists to make.
});

/* -------------------------------------------------------------------------- */

function readMarker(fixture: Fixture, name: string, version: string): string {
  return readFileSync(join(fixture.home, "v1", name, version, ".jup"), "utf8");
}
