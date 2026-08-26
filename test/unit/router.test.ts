/**
 * The command router and the entry-point name — §17.4 R7–R13, §17.6 C1′, C10.
 *
 * §17.9's rows 208–215 spawn a process, which is what they have to do to prove
 * an invocation. These are the cases underneath them that a spawned row cannot
 * reach cheaply: every branch of R7's classification order, the argv[1] shapes a
 * real install produces, and C10's substitution seen from both sides of the same
 * sentence.
 */

import { describe, expect, it } from "vitest";
import {
  invocationPrefix,
  RESERVED,
  route,
  SCOPE_WORDS,
  usageLineFor,
} from "../../src/commands/router.ts";
import { COMMANDS, helpText, usageLine, VERBS } from "../../src/commands/usage.ts";
import { messages, ToolName, toolName, validationWarningPrefix } from "../../src/errors.ts";
import { entryNameFrom } from "../../src/utils/self.ts";

/** Run `body` with `process.argv[1]` pretending to be `path`. */
function invokedAs<T>(path: string, body: () => T): T {
  const saved = process.argv[1] ?? "";
  process.argv[1] = path;
  try {
    return body();
  } finally {
    process.argv[1] = saved;
  }
}

describe("the entry-point name — §17.6 C1′", () => {
  it.for([
    // A real install: npm writes the bin link under the name from `package.json`,
    // and Node does not realpath `argv[1]`, so the name arrives intact.
    ["/p/node_modules/.bin/corepack", "corepack"],
    ["/p/node_modules/.bin/jup", "jup"],
    // From source and from `dist/`.
    ["/p/src/corepack.ts", "corepack"],
    ["/p/dist/bin.mjs", "jup"],
    ["/p/jup.mjs", "jup"],
    ["C:\\tools\\corepack.exe", process.platform === "win32" ? "corepack" : "jup"],
    // §10.1's generated shims are neither name, and correctly get `jup`: a shim
    // reaches `runMain` with the binary name already prepended to argv, and has
    // no business inheriting corepack's spellings.
    ["/home/u/.local/bin/pnpm", "jup"],
    ["/p/src/bin.ts", "jup"],
    ["", "jup"],
  ])("reads %s as %s", ([argv1, expected]) => {
    expect(entryNameFrom(argv1)).toBe(expected);
  });

  it("defaults to jup when there is no argv[1] at all", () => {
    expect(entryNameFrom(undefined)).toBe("jup");
  });
});

describe("R7's classification order — steps 3 to 7", () => {
  it("step 3: a top-level flag is a command, not an unknown one", () => {
    // Omitting this branch is R7's named easy mistake, and its symptom is
    // `jup --version` reported as an unknown command.
    expect(route(["--version"], "jup")).toMatchObject({ kind: "version", scope: null });
    expect(route(["--help"], "jup")).toMatchObject({ kind: "help" });
    expect(route(["-h"], "jup")).toMatchObject({ kind: "help" });
  });

  it("step 4: a scope word is shifted and the command runs scoped", () => {
    for (const [word, role] of Object.entries(SCOPE_WORDS)) {
      expect(route([word, "use", "pnpm@10"], "jup")).toMatchObject({
        kind: "verb",
        verb: "use",
        scope: role,
        args: ["pnpm@10"],
      });
    }
  });

  it("step 4: only steps 3, 5 and 6 may classify what follows a scope word", () => {
    // A binary name never reaches a proxy test after a scope word (row 209)…
    expect(route(["pm", "yarn", "--version"], "jup")).toMatchObject({
      kind: "unknown",
      unknown: "yarn",
    });
    // …and a second scope word falls to step 7 for the same reason.
    expect(route(["pm", "runtime", "use"], "jup")).toMatchObject({
      kind: "unknown",
      unknown: "runtime",
    });
    // A flag still works, in the scope in effect.
    expect(route(["runtime", "--help"], "jup")).toMatchObject({
      kind: "help",
      scope: "runtime",
      scopeWord: "runtime",
    });
  });

  it("step 6: nothing, or `--`, is that scope's help", () => {
    expect(route([], "jup")).toMatchObject({ kind: "help", scope: null });
    expect(route(["--"], "jup")).toMatchObject({ kind: "help", scope: null });
    // A scope word is never a command by itself.
    expect(route(["pm"], "jup")).toMatchObject({ kind: "help", scope: "package-manager" });
    expect(route(["pm", "--"], "jup")).toMatchObject({ kind: "help", scope: "package-manager" });
  });

  it("step 7: anything else is an unknown command", () => {
    expect(route(["frobnicate"], "jup")).toMatchObject({
      kind: "unknown",
      unknown: "frobnicate",
    });
  });

  it("does not dispatch a verb the surface has not implemented yet", () => {
    // §15.34's `project` is in `VERBS` so that R8 can reserve the word, and
    // `pending` keeps it out of the dispatch table until it exists.
    expect(VERBS).toContain("project");
    expect(route(["project", "install"], "jup")).toMatchObject({
      kind: "unknown",
      unknown: "project",
    });
  });
});

describe("R12 — the corepack entry point", () => {
  it("is `jup pm`: the scope is in effect but never spelled", () => {
    const command = route(["use", "pnpm@10"], "corepack");
    expect(command).toMatchObject({ kind: "verb", verb: "use", scope: "package-manager" });
    expect(command.scopeWord).toBe(null);
    expect(invocationPrefix(command)).toBe("corepack");
  });

  it("recognises the scope words in order to refuse them", () => {
    expect(route(["pm", "use"], "corepack")).toMatchObject({ kind: "unknown", unknown: "pm" });
    expect(route(["pm", "use"], "corepack").message).toBe(undefined);

    for (const word of ["runtime", "rt"]) {
      expect(route([word, "enable"], "corepack").message).toBe(
        `runtime management is not available through the 'corepack' command - use 'jup runtime <verb>'`,
      );
    }
  });

  it("still answers its own flags", () => {
    expect(route(["--version"], "corepack")).toMatchObject({ kind: "version" });
    expect(route([], "corepack")).toMatchObject({ kind: "help" });
  });
});

describe("§12.1 — the usage line names the binary and the scope in effect", () => {
  it.for([
    [["use", "pnpm@10"], "$ jup use [--here] [--pin-style=suffix|sidecar] <pattern>"],
    [["pm", "use", "pnpm@10"], "$ jup pm use [--here] [--pin-style=suffix|sidecar] <pattern>"],
    [["runtime", "install"], "$ jup runtime install [-g,--global] [--cache-only] ..."],
    // Nothing recognised: the generic line, still carrying the scope.
    [["pm", "yarn"], "$ jup pm <command>"],
    [["frobnicate"], "$ jup <command>"],
  ])("renders %s as %s", ([args, expected]) => {
    expect(invokedAs("/p/bin/jup", () => usageLineFor(args as string[]))).toBe(expected);
  });

  it("keeps corepack's spellings under the corepack entry point", () => {
    expect(invokedAs("/p/bin/corepack", () => usageLineFor(["use", "pnpm@10"]))).toBe(
      "$ corepack use [--here] [--pin-style=suffix|sidecar] <pattern>",
    );
  });

  it("has a line for every verb the surface dispatches", () => {
    for (const [verb, surface] of Object.entries(COMMANDS)) {
      if (surface.usage === null) continue;
      expect(usageLine(verb, "corepack")).toBe(`$ corepack ${surface.usage}`);
    }
  });
});

describe("§17.6 C6 — scope-aware help", () => {
  const render = (prefix: string, scopes: boolean): string =>
    helpText({ entry: prefix.split(" ")[0]!, prefix, scopes });

  it("describes both scopes only where a scope can be given", () => {
    expect(render("jup", true)).toContain("jup runtime <command>");
    expect(render("jup pm", false)).not.toContain("jup runtime <command>");
    expect(render("corepack", false)).not.toContain("<scope>");
  });

  it("spells every synopsis line the way the reader would have to type it", () => {
    expect(render("jup pm", false)).toContain("  jup pm use [--here]");
    expect(render("corepack", false)).toContain("  corepack use [--here]");
  });

  it("never advertises a scoped proxy invocation, which R7 makes an error", () => {
    // Steps 1–2 run before step 4, so `jup pm yarn` cannot work — the proxy line
    // keeps the bare entry name even under a scope.
    expect(render("jup pm", false)).toContain("  jup <binary>[@<version>]");
    expect(render("jup pm", false)).not.toContain("jup pm <binary>");
  });

  it("names the invoked entry point in its prose (C10)", () => {
    expect(render("jup", true)).toContain("when invoked as\njup itself.");
    expect(render("corepack", false)).toContain("when invoked as\ncorepack itself.");
  });
});

describe("§17.6 C10 — a name substitution, not a rewrite", () => {
  const bothWays = (build: () => string): [string, string] => [
    invokedAs("/p/bin/corepack", build),
    invokedAs("/p/bin/jup", build),
  ];

  it("substitutes the name and nothing else", () => {
    const cases: (() => string)[] = [
      () => validationWarningPrefix(),
      () => messages.devEnginesArray(),
      () => messages.upNotSemver(),
      () => messages.aboutToDownload("https://example.test/x.tgz"),
      () => messages.invalidArchiveFormat("pack"),
      () => messages.deprecatedCommand("prepare", "pack"),
      () => messages.notInCacheOffline("pnpm", "10.x"),
      () => messages.versionDoesNotExist("pnpm", "10.0.0", "https://example.test"),
      () => messages.unsupportedByBuild("bun"),
      () => messages.autoPinNotice("pnpm", "10.0.0"),
      () => messages.cannotDownloadLatest("pnpm"),
    ];

    for (const build of cases) {
      const [asCorepack, asJup] = bothWays(build);
      expect(asJup).not.toBe(asCorepack);
      // Same sentence, same punctuation, same interpolations: replacing the name
      // in one yields the other exactly.
      expect(asCorepack.replaceAll("Corepack", "Jup").replaceAll("corepack", "jup")).toBe(asJup);
    }
  });

  it("leaves a name that belongs to something else alone", () => {
    // The manifest's vocabulary…
    const [devEngines] = bothWays(() => messages.devEnginesNotObject("pnpm@10.x"));
    expect(invokedAs("/p/bin/jup", () => messages.devEnginesNotObject("pnpm@10.x"))).toContain(
      "devEngines.packageManager",
    );
    expect(devEngines).toContain("devEngines.packageManager");

    // …a `COREPACK_*` variable under its legacy spelling (§11.6)…
    expect(invokedAs("/p/bin/jup", () => messages.cannotDownloadLatest("pnpm"))).toContain(
      "COREPACK_INTEGRITY_KEYS",
    );

    // …the nodejs.org documentation URL…
    expect(invokedAs("/p/bin/jup", () => messages.autoPinDocs())).toContain(
      "https://nodejs.org/api/packages.html#packagemanager",
    );

    // …and `https://github.com/nodejs/corepack#troubleshooting`, which names a
    // *repository*: substituting would turn a working pointer into a 404, and
    // aiming the sentence elsewhere would be a rewrite rather than a name
    // substitution.
    const [corepackUrl, jupUrl] = bothWays(() => messages.requestFailed("https://x.test"));
    expect(jupUrl).toBe(corepackUrl);
    expect(jupUrl).toContain("https://github.com/nodejs/corepack#troubleshooting");
  });

  it("leaves a corepack-named *file* alone — that is C9, and it is not this", () => {
    const [asCorepack, asJup] = bothWays(() => messages.lockfileUnresolved("pnpm", "10.x"));
    expect(asJup).toBe(asCorepack);
    expect(asJup).toContain(".corepack.lock");
  });

  it("capitalises to match the sentence", () => {
    expect(invokedAs("/p/bin/jup", () => [toolName(), ToolName()])).toEqual(["jup", "Jup"]);
    expect(invokedAs("/p/bin/corepack", () => [toolName(), ToolName()])).toEqual([
      "corepack",
      "Corepack",
    ]);
  });
});

describe("R8's sets, as the router holds them", () => {
  it("accepts both spellings of both scopes, interchangeably", () => {
    expect(SCOPE_WORDS).toEqual({
      pm: "package-manager",
      "package-manager": "package-manager",
      rt: "runtime",
      runtime: "runtime",
    });
  });

  it("reserves the words §17.4 R8 lists", () => {
    for (const word of ["run", "exec", "node", "deno", "bun", "version", "which"]) {
      expect(RESERVED).toContain(word);
    }
  });

  it("derives VERBS from the surface rather than from a second list", () => {
    expect(VERBS).toEqual(Object.keys(COMMANDS));
    // §09's synopsis, plus §15.30's `info` and §15.34's `project`.
    expect([...VERBS].sort()).toEqual(
      [
        "cache",
        "disable",
        "enable",
        "help",
        "hydrate",
        "info",
        "install",
        "pack",
        "prepare",
        "project",
        "up",
        "use",
      ].sort(),
    );
  });
});
