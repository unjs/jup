import type {Filename}                          from './_fslib.ts';
import {ppath, xfs, npath}                      from './_fslib.ts';
import {delimiter}                              from 'node:path';
import process                                  from 'node:process';
import {setTimeout}                             from 'node:timers/promises';
import {describe, beforeEach, it, expect, test} from 'vitest';

import { engine } from './_compat.ts';
import { SupportedPackageManagerSetWithoutNpm } from './_compat.ts';

import {makeBin, getBinaryNames}                from './_binHelpers.ts';
import {runCli}                                 from './_runCli.ts';


beforeEach(async () => {
  // `process.env` is reset after each tests in setupTests.js.
  process.env.COREPACK_HOME = npath.fromPortablePath(await xfs.mktempPromise());
  process.env.COREPACK_DEFAULT_TO_LATEST = `0`;
});

describe(`EnableCommand`, () => {
  // SKIP (jup §10.5): jup does not derive the install directory from a `PATH`
  // lookup of its own name. It uses `--install-directory`, else
  // COREPACK_SHIM_DIRECTORY, else $XDG_BIN_HOME/~/.local/bin — so the shims
  // land there rather than in the directory this row puts on PATH.
  it.skip(`should add the binaries in the folder found in the PATH`, async () => {
    await xfs.mktempPromise(async cwd => {
      const corepackBin = await makeBin(cwd, `corepack` as Filename);

      process.env.PATH = `${npath.fromPortablePath(cwd)}${delimiter}${process.env.PATH}`;
      await expect(runCli(cwd, [`enable`])).resolves.toMatchObject({
        stdout: ``,
        stderr: ``,
        exitCode: 0,
      });

      const sortedEntries = xfs.readdirPromise(cwd).then(entries => {
        return entries.sort();
      });

      const expectedEntries: Array<string> = [ppath.basename(corepackBin)];
      for (const packageManager of SupportedPackageManagerSetWithoutNpm)
        for (const binName of engine.getBinariesFor(packageManager))
          expectedEntries.push(...getBinaryNames(binName));

      await expect(sortedEntries).resolves.toEqual(expectedEntries.sort());
    });
  });

  // SKIP (jup §10.7, #138): jup's default target set includes npm, so `npm` and
  // `npx` shims appear where Corepack writes none. Corepack excludes npm
  // deliberately; #138 records why that is the wrong call. Conformance row 117
  // pins the inclusion.
  it.skip(`should add the binaries to the specified folder when using --install-directory`, async () => {
    await xfs.mktempPromise(async cwd => {
      const corepackBin = await makeBin(cwd, `corepack` as Filename);

      await expect(runCli(cwd, [`enable`, `--install-directory`, npath.fromPortablePath(cwd)])).resolves.toMatchObject({
        stdout: ``,
        stderr: ``,
        exitCode: 0,
      });

      const sortedEntries = xfs.readdirPromise(cwd).then(entries => {
        return entries.sort();
      });

      const expectedEntries: Array<string> = [ppath.basename(corepackBin)];
      for (const packageManager of SupportedPackageManagerSetWithoutNpm)
        for (const binName of engine.getBinariesFor(packageManager))
          expectedEntries.push(...getBinaryNames(binName));

      await expect(sortedEntries).resolves.toEqual(expectedEntries.sort());
    });
  });

  it(`should add binaries only for the requested package managers`, async () => {
    await xfs.mktempPromise(async cwd => {
      const corepackBin = await makeBin(cwd, `corepack` as Filename);

      await expect(runCli(cwd, [`enable`, `--install-directory=${npath.fromPortablePath(cwd)}`, `yarn`])).resolves.toMatchObject({
        stdout: ``,
        stderr: ``,
        exitCode: 0,
      });

      const sortedEntries = xfs.readdirPromise(cwd).then(entries => {
        return entries.sort();
      });

      const expectedEntries: Array<string> = [ppath.basename(corepackBin)];
      for (const binName of engine.getBinariesFor(`yarn`))
        expectedEntries.push(...getBinaryNames(binName));

      await expect(sortedEntries).resolves.toEqual(expectedEntries.sort());
    });
  });

  // SKIP (jup §10.6): silently clobbering a regular file jup did not install
  // is hostile, so it refuses and prints `… was not installed by this tool -
  // skipping (use --force to overwrite)`. This row writes `hello` to `yarn`
  // and asserts it is replaced; under jup it survives unless --force is given.
  // (Was `test.skipIf(win32)`; now skipped everywhere.)
  test.skip(`should overwrite existing files`, async () => {
    await xfs.mktempPromise(async cwd => {
      await xfs.writeFilePromise(ppath.join(cwd, `yarn`), `hello`);

      await expect(runCli(cwd, [`enable`, `--install-directory`, npath.fromPortablePath(cwd)])).resolves.toMatchObject({
        stdout: ``,
        stderr: ``,
        exitCode: 0,
      });

      const file = await xfs.readFilePromise(ppath.join(cwd, `yarn`), `utf8`);
      expect(file).not.toBe(`hello`);
    });
  });

  test.skipIf(process.platform === `win32`)(`shouldn't overwrite Yarn files if they are in a /switch/ folder`, async () => {
    await xfs.mktempPromise(async cwd => {
      await xfs.mkdirPromise(ppath.join(cwd, `switch/bin`), {recursive: true});
      await xfs.writeFilePromise(ppath.join(cwd, `switch/bin/yarn`), `hello`);

      await xfs.symlinkPromise(
        ppath.join(cwd, `switch/bin/yarn`),
        ppath.join(cwd, `yarn`),
      );

      await expect(runCli(cwd, [`enable`, `--install-directory`, npath.fromPortablePath(cwd)])).resolves.toMatchObject({
        stdout: ``,
        stderr: expect.stringMatching(/^yarn is already installed in .+ and points to a Yarn Switch install - skipping\n$/),
        exitCode: 0,
      });

      const file = await xfs.readFilePromise(ppath.join(cwd, `yarn`), `utf8`);
      expect(file).toBe(`hello`);
    });
  });

  test.skipIf(process.platform === `win32`)(`should not re-link if binaries are already correct`, async () => {
    await xfs.mktempPromise(async cwd => {
      await makeBin(cwd, `corepack` as Filename);

      await expect(runCli(cwd, [`enable`, `--install-directory`, npath.fromPortablePath(cwd)])).resolves.toMatchObject({
        stdout: ``,
        stderr: ``,
        exitCode: 0,
      });
      const yarnStat1 = await xfs.lstatPromise(ppath.join(cwd, `yarn`));

      await setTimeout(10);

      await expect(runCli(cwd, [`enable`, `--install-directory`, npath.fromPortablePath(cwd)])).resolves.toMatchObject({
        stdout: ``,
        stderr: ``,
        exitCode: 0,
      });
      const yarnStat2 = await xfs.lstatPromise(ppath.join(cwd, `yarn`));

      expect(yarnStat2.mtimeMs).toBe(yarnStat1.mtimeMs);
    });
  });

  // §10.3 gives every name its own stub, so the corrected link reads `yarn.mjs`,
  // which is what this row's last assertion wants. (Was `test.skipIf(win32)`.)
  test.skipIf(process.platform === `win32`)(`should overwrite existing symlinks if they are incorrect`, async () => {
    await xfs.mktempPromise(async cwd => {
      await makeBin(cwd, `corepack` as Filename);

      await xfs.writeFilePromise(ppath.join(cwd, `dummy-target`), `hello`);
      await xfs.symlinkPromise(ppath.join(cwd, `dummy-target`), ppath.join(cwd, `yarn`));

      await expect(runCli(cwd, [`enable`, `--install-directory`, npath.fromPortablePath(cwd)])).resolves.toMatchObject({
        stdout: ``,
        stderr: ``,
        exitCode: 0,
      });

      const newLink = await xfs.readlinkPromise(ppath.join(cwd, `yarn`));
      expect(newLink).toContain(`yarn.mjs`);
    });
  });
});
