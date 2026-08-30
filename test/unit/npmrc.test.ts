/**
 * `.npmrc` — the constrained subset (§05.3) and the registry decision it feeds
 * (§05.2).
 *
 * The security rules are the reason this file exists at all, so they are tested
 * from both sides: a project-level file must not be able to supply a credential
 * or a certificate authority, and a credential that *is* supplied must not reach
 * a URL outside the prefix it was written for.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isToolEnvName } from "../../src/config/env-vars.ts";
import {
  expandVariables,
  hasNpmProtocolRegistry,
  loadNpmrc,
  npmrcAuthorizationFor,
  npmrcTlsSettings,
  parseNpmrc,
  registryVariableFor,
  resetNpmrcCache,
  resolveRegistry,
} from "../../src/net/npmrc.ts";

const roots: string[] = [];
const savedEnv = { ...process.env };

/**
 * A throwaway tree with a `home/` (the user tier), a `prefix/etc/` (the global
 * tier) and a `project/` holding a manifest that stops §03.1's walk.
 */
function tree(): { root: string; home: string; prefix: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "jup-npmrc-"));
  roots.push(root);
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(prefix, "etc"), { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), `{"packageManager":"pnpm@11.1.2"}\n`);

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PREFIX = prefix;
  return { root, home, prefix, project };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeEach(() => {
  resetNpmrcCache();
  for (const name of Object.keys(process.env)) {
    // Either spelling — a developer's ambient `JUP_NPM_REGISTRY` outranks the
    // `COREPACK_` name this used to test for, and §05.3's tiers are the whole
    // subject here.
    if (isToolEnvName(name)) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...savedEnv };
  resetNpmrcCache();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe("parseNpmrc — the INI-ish line format", () => {
  it("reads pairs and ignores comments, blanks and section headers", () => {
    expect(
      parseNpmrc(
        [
          "# a comment",
          "; another",
          "",
          "[scoped-section]",
          "registry = https://example.org/",
          "  spaced=value  ",
          "no-equals",
          `quoted="a value"`,
          "ca[]=first",
        ].join("\n"),
      ),
    ).toEqual([
      { key: "registry", value: "https://example.org/", array: false },
      { key: "spaced", value: "value", array: false },
      { key: "quoted", value: "a value", array: false },
      { key: "ca", value: "first", array: true },
    ]);
  });

  it("keeps `=` inside a value", () => {
    expect(parseNpmrc("//h/:_authToken=abc=def")).toEqual([
      { key: "//h/:_authToken", value: "abc=def", array: false },
    ]);
  });

  it("unescapes the newlines npm writes into a quoted `ca`", () => {
    expect(parseNpmrc(String.raw`ca="-----BEGIN-----\nbody\n-----END-----"`)[0]!.value).toBe(
      "-----BEGIN-----\nbody\n-----END-----",
    );
  });
});

describe("expandVariables — §05.3's `${VAR}`", () => {
  it("substitutes a defined variable", () => {
    process.env.JUP_TEST_TOKEN = "s3cret";
    expect(expandVariables("${JUP_TEST_TOKEN}")).toEqual({ value: "s3cret" });
  });

  it("reports an undefined one rather than expanding to the literal text", () => {
    delete process.env.JUP_TEST_MISSING;
    // The failure mode this guards: sending the eight characters `${VAR}` to a
    // registry as if they were a bearer token.
    expect(expandVariables("${JUP_TEST_MISSING}")).toEqual({ missing: "JUP_TEST_MISSING" });
  });

  it("leaves a value with no reference alone", () => {
    expect(expandVariables("plain")).toEqual({ value: "plain" });
  });
});

/* -------------------------------------------------------------------------- */

describe("loadNpmrc — precedence (§05.3)", () => {
  it("orders global < user < project, closest project file winning", () => {
    const { home, prefix, project } = tree();
    write(join(prefix, "etc", "npmrc"), "registry=https://global.example.org\n");
    write(join(home, ".npmrc"), "registry=https://user.example.org\n");
    write(join(project, ".npmrc"), "registry=https://project.example.org\n");

    const config = loadNpmrc(project);

    expect(config.registry?.value).toBe("https://project.example.org");
    expect(config.registry?.origin.level).toBe("project");
    expect(config.files.map((file) => file.level)).toEqual(["global", "user", "project"]);
  });

  it("falls back to the user file when the project sets no registry", () => {
    const { home, project } = tree();
    write(join(home, ".npmrc"), "registry=https://user.example.org\n");
    write(join(project, ".npmrc"), "//other.example.org/:_authToken=nope\n");

    expect(loadNpmrc(project).registry?.value).toBe("https://user.example.org");
  });

  it("strips trailing slashes, as §05.2 requires of every registry base", () => {
    const { home, project } = tree();
    write(join(home, ".npmrc"), "registry=https://user.example.org///\n");

    expect(loadNpmrc(project).registry?.value).toBe("https://user.example.org");
  });

  it("ignores every key §05.3 does not list", () => {
    const { home, project } = tree();
    write(
      join(home, ".npmrc"),
      [
        "registry=https://user.example.org",
        "save-exact=true",
        "prefix=/opt/nope",
        "audit=false",
      ].join("\n"),
    );

    expect(loadNpmrc(project).files[0]!.keys).toEqual(["registry"]);
  });

  it("says nothing about a project file's *unlisted* keys", () => {
    const { project } = tree();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // §05.3 ignores everything outside its table. A project `.npmrc` full of
    // ordinary npm settings is the common case, and warning about each of them
    // would make the one warning that matters — a refused credential —
    // invisible.
    write(
      join(project, ".npmrc"),
      ["save-exact=true", "audit=false", "engine-strict=true"].join("\n"),
    );

    const config = loadNpmrc(project);
    expect(config.files[0]).toMatchObject({ keys: [], refused: [] });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("walks up from a nested directory, and stops at the project root", () => {
    const { project } = tree();
    const nested = join(project, "packages", "app");
    mkdirSync(nested, { recursive: true });
    write(join(project, ".npmrc"), "registry=https://root.example.org\n");
    write(join(nested, ".npmrc"), "registry=https://nested.example.org\n");

    expect(loadNpmrc(nested).registry?.value).toBe("https://nested.example.org");
    // Both were read; the closest simply won.
    expect(loadNpmrc(nested).files.map((file) => file.path)).toEqual([
      join(project, ".npmrc"),
      join(nested, ".npmrc"),
    ]);
  });

  it("skips a `.npmrc` belonging to a package inside node_modules (§03.1 step 1)", () => {
    const { project } = tree();
    const dependency = join(project, "node_modules", "evil");
    mkdirSync(dependency, { recursive: true });
    write(join(dependency, ".npmrc"), "registry=https://dependency.example.org\n");
    write(join(project, ".npmrc"), "registry=https://root.example.org\n");

    expect(loadNpmrc(dependency).registry?.value).toBe("https://root.example.org");
  });

  it("classifies $HOME/.npmrc as the user file even when cwd is beneath it", () => {
    const { home } = tree();
    const under = join(home, "work", "app");
    mkdirSync(under, { recursive: true });
    write(join(home, ".npmrc"), "//registry.example.org/:_authToken=tok\n");

    const config = loadNpmrc(under);

    // Had the walk called it "project", the token would have been refused — and
    // the user's own configuration would silently stop working the moment they
    // kept their projects in their home directory.
    expect(config.files.map((file) => file.level)).toEqual(["user"]);
    expect(config.auth).toHaveLength(1);
  });
});

describe("loadNpmrc — the project-level security rule (§05.3)", () => {
  it("refuses auth and TLS keys from a project file, and says so", () => {
    const { project } = tree();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write(
      join(project, ".npmrc"),
      [
        "registry=https://project.example.org",
        "@scope:registry=https://scope.example.org",
        "//project.example.org/:_authToken=stolen",
        "//project.example.org/:_auth=c3RvbGVu",
        "//project.example.org/:username=who",
        "//project.example.org/:_password=cGFzcw==",
        "cafile=/tmp/evil.pem",
        "ca=-----BEGIN CERTIFICATE-----",
        "strict-ssl=false",
      ].join("\n"),
    );

    const config = loadNpmrc(project);

    // The two it may set.
    expect(config.registry?.value).toBe("https://project.example.org");
    expect(config.scoped.get("@scope")?.value).toBe("https://scope.example.org");
    // And nothing else.
    expect(config.auth).toEqual([]);
    expect(config.cafile).toBeUndefined();
    expect(config.ca).toBeUndefined();
    expect(config.strictSsl).toBeUndefined();

    expect(config.files[0]!.refused).toEqual([
      "//project.example.org/:_authToken",
      "//project.example.org/:_auth",
      "//project.example.org/:username",
      "//project.example.org/:_password",
      "cafile",
      "ca",
      "strict-ssl",
    ]);
    // Announced, not silently dropped — a credential that vanishes without a
    // word looks exactly like a broken tool (§03.2's precedent).
    expect(warn).toHaveBeenCalledTimes(7);
    expect(warn.mock.calls.map(([message]) => String(message)).join("\n")).toContain(
      "a project-level .npmrc may only set registry and @scope:registry",
    );
    warn.mockRestore();
  });

  it("still honours the user file's auth while refusing the project's", () => {
    const { home, project } = tree();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    write(join(home, ".npmrc"), "//registry.example.org/:_authToken=real\n");
    write(join(project, ".npmrc"), "//registry.example.org/:_authToken=stolen\n");

    const config = loadNpmrc(project);

    expect(config.auth).toHaveLength(1);
    expect(config.auth[0]!.authorization).toBe("Bearer real");
    vi.restoreAllMocks();
  });
});

describe("loadNpmrc — credentials", () => {
  it("reads _authToken, _auth, and username + base64 _password", () => {
    const { home, project } = tree();
    write(
      join(home, ".npmrc"),
      [
        "//token.example.org/:_authToken=abc",
        "//auth.example.org/:_auth=dXNlcjpwYXNz",
        "//pair.example.org/:username=user",
        `//pair.example.org/:_password=${Buffer.from("pass").toString("base64")}`,
      ].join("\n"),
    );

    const byPrefix = new Map(loadNpmrc(project).auth.map((entry) => [entry.prefix, entry]));

    expect(byPrefix.get("//token.example.org/")!.authorization).toBe("Bearer abc");
    expect(byPrefix.get("//auth.example.org/")!.authorization).toBe("Basic dXNlcjpwYXNz");
    expect(byPrefix.get("//pair.example.org/")!.authorization).toBe(
      `Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
  });

  it("drops a username with no password", () => {
    const { home, project } = tree();
    write(join(home, ".npmrc"), "//pair.example.org/:username=user\n");
    expect(loadNpmrc(project).auth).toEqual([]);
  });

  it("drops a credential whose ${VAR} is not set, rather than sending the literal", () => {
    const { home, project } = tree();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.JUP_TEST_MISSING;
    write(join(home, ".npmrc"), "//registry.example.org/:_authToken=${JUP_TEST_MISSING}\n");

    expect(loadNpmrc(project).auth).toEqual([]);
    expect(String(warn.mock.calls[0]?.[0])).toContain("${JUP_TEST_MISSING}");
    warn.mockRestore();
  });
});

describe("npmrcAuthorizationFor — prefix scoping (§05.3)", () => {
  function configuredWith(lines: string[]): ReturnType<typeof loadNpmrc> {
    const { home, project } = tree();
    write(join(home, ".npmrc"), `${lines.join("\n")}\n`);
    return loadNpmrc(project);
  }

  it("attaches a host-scoped credential to any path on that host", () => {
    const config = configuredWith(["//registry.example.org/:_authToken=abc"]);
    expect(
      npmrcAuthorizationFor(new URL("https://registry.example.org/pnpm/-/pnpm-1.0.0.tgz"), config)
        ?.authorization,
    ).toBe("Bearer abc");
  });

  it("does not attach it to a different host", () => {
    const config = configuredWith(["//registry.example.org/:_authToken=abc"]);
    expect(
      npmrcAuthorizationFor(new URL("https://cdn.example.org/pnpm.tgz"), config),
    ).toBeUndefined();
  });

  it("does not attach it to a different port on the same host", () => {
    const config = configuredWith(["//registry.example.org:8080/:_authToken=abc"]);
    expect(
      npmrcAuthorizationFor(new URL("https://registry.example.org:9090/pnpm"), config),
    ).toBeUndefined();
  });

  it("respects the path prefix, and does not treat it as a bare string prefix", () => {
    const config = configuredWith(["//host.example.org/team/:_authToken=abc"]);

    expect(
      npmrcAuthorizationFor(new URL("https://host.example.org/team/pkg"), config)?.authorization,
    ).toBe("Bearer abc");
    // `/team-other` shares the characters of `/team` and must not match: that is
    // the whole reason the prefix is normalised to end in `/`.
    expect(
      npmrcAuthorizationFor(new URL("https://host.example.org/team-other/pkg"), config),
    ).toBeUndefined();
    expect(
      npmrcAuthorizationFor(new URL("https://host.example.org/other"), config),
    ).toBeUndefined();
  });

  it("prefers the most specific prefix", () => {
    const config = configuredWith([
      "//host.example.org/:_authToken=broad",
      "//host.example.org/team/:_authToken=narrow",
    ]);

    expect(
      npmrcAuthorizationFor(new URL("https://host.example.org/team/pkg"), config)?.authorization,
    ).toBe("Bearer narrow");
    expect(
      npmrcAuthorizationFor(new URL("https://host.example.org/else"), config)?.authorization,
    ).toBe("Bearer broad");
  });
});

/* -------------------------------------------------------------------------- */

describe("resolveRegistry — §05.2 and §05.3's precedence", () => {
  it("uses the built-in default when nothing is configured", () => {
    const { project } = tree();
    expect(resolveRegistry({ name: "pnpm", cwd: project })).toMatchObject({
      registry: "https://registry.npmjs.org",
      source: "built-in",
    });
  });

  it("lets .npmrc's registry beat the default", () => {
    const { home, project } = tree();
    write(join(home, ".npmrc"), "registry=https://npmrc.example.org\n");

    const decision = resolveRegistry({ name: "pnpm", cwd: project });
    expect(decision.registry).toBe("https://npmrc.example.org");
    expect(decision.kind).toBe("npmrc");
    expect(decision.source).toContain(join(home, ".npmrc"));
  });

  it("lets COREPACK_NPM_REGISTRY beat .npmrc (row 148)", () => {
    const { home, project } = tree();
    write(join(home, ".npmrc"), "registry=https://npmrc.example.org\n");
    process.env.COREPACK_NPM_REGISTRY = "https://env.example.org/";

    expect(resolveRegistry({ name: "pnpm", cwd: project })).toMatchObject({
      registry: "https://env.example.org",
      source: "COREPACK_NPM_REGISTRY",
    });
  });

  it("lets JUP_REGISTRY_<NAME> beat COREPACK_NPM_REGISTRY (§05.2)", () => {
    const { project } = tree();
    process.env.COREPACK_NPM_REGISTRY = "https://env.example.org";
    process.env.JUP_REGISTRY_YARN = "https://yarn-mirror.example.org/";

    expect(resolveRegistry({ name: "yarn", cwd: project })).toMatchObject({
      registry: "https://yarn-mirror.example.org",
      source: "JUP_REGISTRY_YARN",
    });
    // …and only for that package manager.
    expect(resolveRegistry({ name: "pnpm", cwd: project })).toMatchObject({
      registry: "https://env.example.org",
      source: "COREPACK_NPM_REGISTRY",
    });
  });

  it("prefers @scope:registry over registry for a scoped package (row 150)", () => {
    const { home, project } = tree();
    write(
      join(home, ".npmrc"),
      ["registry=https://plain.example.org", "@yarnpkg:registry=https://scoped.example.org"].join(
        "\n",
      ),
    );

    expect(
      resolveRegistry({ name: "yarn", packageName: "@yarnpkg/cli-dist", cwd: project }).registry,
    ).toBe("https://scoped.example.org");
    expect(resolveRegistry({ name: "yarn", packageName: "pnpm", cwd: project }).registry).toBe(
      "https://plain.example.org",
    );
  });

  it("spells the variable from the package manager's name", () => {
    expect(registryVariableFor("yarn")).toBe("JUP_REGISTRY_YARN");
    expect(registryVariableFor("pnpm")).toBe("JUP_REGISTRY_PNPM");
    expect(registryVariableFor("my-pm")).toBe("JUP_REGISTRY_MY_PM");
  });

  it("treats an empty value as unset, matching every other COREPACK_ flag", () => {
    const { project } = tree();
    process.env.COREPACK_NPM_REGISTRY = "";
    process.env.JUP_REGISTRY_YARN = "";
    expect(resolveRegistry({ name: "yarn", cwd: project }).source).toBe("built-in");
  });
});

describe("hasNpmProtocolRegistry — §05.2 rewrite 1's condition", () => {
  it("is false with nothing configured, and true once .npmrc names one", () => {
    const { home, project } = tree();
    expect(hasNpmProtocolRegistry("@yarnpkg/cli-dist", project)).toBe(false);

    write(join(home, ".npmrc"), "@yarnpkg:registry=https://scoped.example.org\n");
    resetNpmrcCache();
    expect(hasNpmProtocolRegistry("@yarnpkg/cli-dist", project)).toBe(true);
    // The scoped key says nothing about anything else.
    expect(hasNpmProtocolRegistry("pnpm", project)).toBe(false);
  });

  it("is false for JUP_REGISTRY_<NAME> alone — that is a mirror, not a protocol change", () => {
    const { project } = tree();
    process.env.JUP_REGISTRY_YARN = "https://yarn-mirror.example.org";
    expect(hasNpmProtocolRegistry("@yarnpkg/cli-dist", project)).toBe(false);
  });
});

describe("npmrcTlsSettings — §05.1's middle tier", () => {
  it("reads cafile, ca and strict-ssl from the user file", () => {
    const { home, project } = tree();
    write(
      join(home, ".npmrc"),
      ["cafile=/etc/ssl/corp.pem", "ca=-----BEGIN CERTIFICATE-----", "strict-ssl=false"].join("\n"),
    );

    const settings = npmrcTlsSettings(project);
    expect(settings.cafile?.value).toBe("/etc/ssl/corp.pem");
    expect(settings.ca?.value).toEqual(["-----BEGIN CERTIFICATE-----"]);
    expect(settings.strictSsl?.value).toBe(false);
  });

  it("appends repeated ca[] entries", () => {
    const { home, project } = tree();
    write(join(home, ".npmrc"), "ca[]=one\nca[]=two\n");
    expect(npmrcTlsSettings(project).ca?.value).toEqual(["one", "two"]);
  });

  it("treats any value other than `false` as strict", () => {
    const { home, project } = tree();
    write(join(home, ".npmrc"), "strict-ssl=true\n");
    expect(npmrcTlsSettings(project).strictSsl?.value).toBe(true);
  });
});
