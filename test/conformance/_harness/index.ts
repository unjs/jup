/** The conformance harness, §13.1. */

export {
  alternateShims,
  createFixture,
  cleanupFixtures,
  copyTool,
  binPathsFor,
  effectivePin,
  packageManagerTarball,
  perUserShims,
  publishBerry,
  pmScript,
  seedPackageManager,
  tempRoot,
  versionOf,
} from "./fixtures.ts";
export type { Fixture } from "./fixtures.ts";
export { KEYS_PATH, MockRegistry } from "./registry.ts";
export type { RecordedRequest, RegistryMode, TrustedKeyEntry } from "./registry.ts";
export {
  BIN,
  REPO_ROOT,
  childPath,
  cleanEnv,
  downloadNotice,
  run,
  withoutDownloadNotices,
} from "./run.ts";
export type { RunOptions, RunResult } from "./run.ts";
export { hashOf, makeTarball, npmTarball, sriOf } from "./tarball.ts";
export type { TarEntryInput } from "./tarball.ts";
