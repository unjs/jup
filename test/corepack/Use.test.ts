import {ppath, xfs, npath}                from './_fslib.ts';
import process                            from 'node:process';
import {describe, beforeEach, it, expect} from 'vitest';

import {runCli}                           from './_runCli.ts';

beforeEach(async () => {
  const home = await xfs.mktempPromise();

  // `process.env` is reset after each tests in setupTests.js.
  process.env.COREPACK_HOME = npath.fromPortablePath(home);
  process.env.COREPACK_DEFAULT_TO_LATEST = `0`;

  return async () => {
    await xfs.removePromise(home, {recursive: true});
  };
});

describe(`UseCommand`, () => {
  describe(`should set the package manager in the current project`, () => {
    // SKIP (jup §09.4, §03.7): `use` prints an extra `Updated <path> to use
    // <ref>` line, so stdout no longer matches
    // `/^Installing … in the project\.\.\.\n\n/`; and the pin goes to
    // `devEngines.packageManager`, which retires the top-level field this row
    // reads back rather than refreshing it. Both are covered by 13-10-use-up
    // (105, 116) and 15-26-atomic-pin (190).
    it.skip(`With an existing 'packageManager' field`, async () => {
      await xfs.mktempPromise(async cwd => {
        await xfs.writeJsonPromise(ppath.join(cwd, `package.json`), {
          packageManager: `yarn@1.0.0`,
          license: `MIT`,
        });

        await expect(runCli(cwd, [`use`, `yarn@1.22.4`])).resolves.toMatchObject({
          exitCode: 0,
          stdout: expect.stringMatching(/^Installing yarn@1\.22\.4 in the project\.\.\.\n\n/),
          stderr: ``,
        });

        await expect(xfs.readJsonPromise(ppath.join(cwd, `package.json`))).resolves.toMatchObject({
          packageManager: `yarn@1.22.4+sha512.a1833b862fe52169bd6c2a033045a07df5bc6a23595c259e675fed1b2d035ab37abe6ce309720abb6636d68f03615054b6292dc0a70da31c8697fda228b50d18`,
        });

        await expect(runCli(cwd, [`yarn`, `--version`])).resolves.toMatchObject({
          exitCode: 0,
          stdout: `1.22.4\n`,
          stderr: ``,
        });
      });
    });
    // SKIP (jup §09): the usage line printed with the error carries
    // jup's extra flags — `$ corepack use [--here] [--no-integrity] [--no-lockfile]
    // <pattern>` — where Corepack has `$ corepack use <pattern>`. The refusal
    // itself, and its message, match. The second half of the row diverges twice
    // more under §03.7: the declared `2.x` is replaced by the version pinned
    // rather than preserved, and no top-level `packageManager` is created beside
    // it. 13-10-use-up (110) and 15-26-atomic-pin (189) assert the jup shape.
    it.skip(`with 'devEngines.packageManager' field`, async () => {
      await xfs.mktempPromise(async cwd => {
        process.env.NO_COLOR = `1`;
        const devEngines = {packageManager: {name: `yarn`, version: `2.x`}};
        await xfs.writeJsonPromise(ppath.join(cwd, `package.json`), {
          devEngines,
        });

        // Should refuse to install an incompatible version:
        await expect(runCli(cwd, [`use`, `yarn@1.22.4`])).resolves.toMatchObject({
          exitCode: 1,
          stderr: ``,
          stdout: `Installing yarn@1.22.4 in the project...\nUsage Error: The requested version of yarn@1.22.4+sha512.a1833b862fe52169bd6c2a033045a07df5bc6a23595c259e675fed1b2d035ab37abe6ce309720abb6636d68f03615054b6292dc0a70da31c8697fda228b50d18 does not match the devEngines specification (yarn@2.x)\n\n$ corepack use <pattern>\n`,
        });

        // Should accept setting to a compatible version:
        await expect(runCli(cwd, [`use`, `yarn@2.4.3`])).resolves.toMatchObject({
          exitCode: 0,
          stderr: ``,
          stdout: expect.stringMatching(/^Installing yarn@2\.4\.3 in the project\.\.\.\n\n/),
        });

        await expect(xfs.readJsonPromise(ppath.join(cwd, `package.json`))).resolves.toMatchObject({
          devEngines,
          packageManager: `yarn@2.4.3+sha512.8dd9fedc5451829619e526c56f42609ad88ae4776d9d3f9456d578ac085115c0c2f0fb02bb7d57fd2e1b6e1ac96efba35e80a20a056668f61c96934f67694fd0`,
        });

        await expect(runCli(cwd, [`yarn`, `--version`])).resolves.toMatchObject({
          exitCode: 0,
          stdout: `2.4.3\n`,
          stderr: ``,
        });
      });
    });

    // SKIP (jup §09.4, §03.7): the extra `Updated …` line again, and the row
    // reads both fields back after the write — where jup leaves the pin in the
    // member alone, having retired the top-level copy. 15-26-atomic-pin (190) is
    // this row in jup's spelling.
    it.skip(`with 'devEngines.packageManager' and 'packageManager' fields`, async () => {
      await xfs.mktempPromise(async cwd => {
        process.env.NO_COLOR = `1`;
        const devEngines = {packageManager: {name: `yarn`, version: `1.x || 2.x`}};
        await xfs.writeJsonPromise(ppath.join(cwd, `package.json`), {
          devEngines,
          packageManager: `yarn@1.1.0`,
          license: `MIT`,
        });

        // Should refuse to install an incompatible version:
        await expect(runCli(cwd, [`use`, `yarn@1.22.4`])).resolves.toMatchObject({
          exitCode: 0,
          stderr: ``,
          stdout: expect.stringMatching(/^Installing yarn@1\.22\.4 in the project\.\.\.\n\n/),
        });

        // Should accept setting to a compatible version:
        await expect(runCli(cwd, [`use`, `yarn@2.4.3`])).resolves.toMatchObject({
          exitCode: 0,
          stderr: ``,
          stdout: expect.stringMatching(/^Installing yarn@2\.4\.3 in the project\.\.\.\n\n/),
        });

        await expect(xfs.readJsonPromise(ppath.join(cwd, `package.json`))).resolves.toMatchObject({
          devEngines,
          packageManager: `yarn@2.4.3+sha512.8dd9fedc5451829619e526c56f42609ad88ae4776d9d3f9456d578ac085115c0c2f0fb02bb7d57fd2e1b6e1ac96efba35e80a20a056668f61c96934f67694fd0`,
        });

        await expect(runCli(cwd, [`yarn`, `--version`])).resolves.toMatchObject({
          exitCode: 0,
          stdout: `2.4.3\n`,
          stderr: ``,
        });
      });
    });
  });

  // SKIP (jup §03.7): `use` writes the pin to `devEngines.packageManager`, so
  // the created manifest carries no top-level `packageManager` for the row to
  // read. Everything else it asserts — the manifest is created, the pin is a
  // sha512 reference, and a later `use` from a subfolder updates the ancestor —
  // is covered by `test/conformance/13-10-use-up.test.ts` (105, 106, 107).
  it.skip(`should create a package.json if absent`, async () => {
    await xfs.mktempPromise(async cwd => {
      await expect(runCli(cwd, [`use`, `yarn@1.22.4`])).resolves.toMatchObject({
        exitCode: 0,
        stderr: `warning package.json: No license field\nwarning No license field\n`,
      });

      await expect(xfs.readJsonPromise(ppath.join(cwd, `package.json`))).resolves.toMatchObject({
        packageManager: `yarn@1.22.4+sha512.a1833b862fe52169bd6c2a033045a07df5bc6a23595c259e675fed1b2d035ab37abe6ce309720abb6636d68f03615054b6292dc0a70da31c8697fda228b50d18`,
      });

      await expect(runCli(cwd, [`yarn`, `--version`])).resolves.toMatchObject({
        exitCode: 0,
        stdout: `1.22.4\n`,
        stderr: ``,
      });

      // Ensure Corepack is able to detect package.json in parent directory
      const subfolder = ppath.join(cwd, `subfolder`);
      await xfs.mkdirPromise(subfolder);

      await expect(runCli(subfolder, [`use`, `yarn@2.4.1`])).resolves.toMatchObject({
        exitCode: 0,
        stderr: ``,
      });
      await expect(runCli(cwd, [`yarn`, `--version`])).resolves.toMatchObject({
        exitCode: 0,
        stdout: `2.4.1\n`,
        stderr: ``,
      });
    });
  });

  // SKIP (jup §09.4, §03.7): all four rows assert the exact stdout of `use`,
  // which carries jup's extra `Updated <path> to use <ref>` line, and then read
  // the invalid value back as a refreshed `packageManager` — where jup writes the
  // member and takes the malformed field out with the pin it used to hold. They
  // agree with jup on the point being made, though: an invalid incumbent value is
  // not an obstacle, which is 13-10-use-up (109).
  describe.skip(`should not care if packageManager is set to an invalid value`, () => {
    for (const {description, packageManager} of [
      {
        description: `when a version range is given`,
        packageManager: `yarn@1.x`,
      },
      {
        description: `when only the pm name is given`,
        packageManager: `yarn`,
      },
      {
        description: `when the version is missing`,
        packageManager: `yarn@`,
      },
      {
        description: `when the field is not a string`,
        packageManager: [],
      },
    ]) {
      it(description, async () => {
        await xfs.mktempPromise(async cwd => {
          await xfs.writeJsonPromise(ppath.join(cwd, `package.json`), {
            packageManager,
            license: `MIT`, // To avoid warning
          });

          await expect(runCli(cwd, [`use`, `yarn@1.22.4`])).resolves.toMatchObject({
            exitCode: 0,
            stderr: ``,
            stdout: expect.stringMatching(/^Installing yarn@1\.22\.4 in the project\.\.\.\n\n/),
          });

          await expect(xfs.readJsonPromise(ppath.join(cwd, `package.json`))).resolves.toMatchObject({
            packageManager: `yarn@1.22.4+sha512.a1833b862fe52169bd6c2a033045a07df5bc6a23595c259e675fed1b2d035ab37abe6ce309720abb6636d68f03615054b6292dc0a70da31c8697fda228b50d18`,
          });

          await expect(runCli(cwd, [`yarn`, `--version`])).resolves.toMatchObject({
            exitCode: 0,
            stdout: `1.22.4\n`,
            stderr: ``,
          });
        });
      });
    }
  });
});
