import { describe, expect, it } from "vitest";
import { messages, UsageError } from "../src/errors.ts";

describe("errors", () => {
  it("distinguishes UsageError from Error", () => {
    expect(new UsageError("x")).toBeInstanceOf(Error);
    expect(new UsageError("x").name).toBe("UsageError");
  });

  it("renders spec-parsing messages byte-exactly", () => {
    expect(messages.noVersionSpecified("yarn", "package.json")).toBe(
      `No version specified for yarn in "packageManager" of package.json`,
    );
    expect(messages.unsupportedSpec("foo@1.2.3")).toBe(
      `Unsupported package manager specification (foo@1.2.3)`,
    );
  });

  it("JSON-stringifies interpolated values in devEngines messages", () => {
    expect(messages.devEnginesBadVersion("yarn@1.x")).toBe(
      `The value of devEngines.packageManager.version "yarn@1.x" is not a valid semver range`,
    );
    expect(messages.devEnginesNotObject(10)).toBe(
      `! jup only supports objects as valid value for devEngines.packageManager. The current value (10) will be ignored.`,
    );
  });

  it("keeps the load-bearing env var names in the latest-version failure", () => {
    const message = messages.cannotDownloadLatest("yarn");
    expect(message).toContain("JUP_INTEGRITY_KEYS");
    expect(message).toContain("JUP_DEFAULT_TO_LATEST");
    expect(message).not.toContain("INTEGRITY_CHECK");
    expect(message).not.toContain("USE_LATEST");
  });

  it("keeps the trailing space on the download prompt", () => {
    expect(messages.downloadPrompt()).toBe("? Do you want to continue? [Y/n] ");
  });
});
