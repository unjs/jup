/** The conformance harness, §13.1. */

export {
  createFixture,
  cleanupFixtures,
  copyTool,
  binPathsFor,
  packageManagerTarball,
  pmScript,
  seedPackageManager,
  versionOf,
} from "./fixtures.ts";
export type { Fixture } from "./fixtures.ts";
export { KEYS_PATH, MockRegistry } from "./registry.ts";
export type { RecordedRequest, RegistryMode, TrustedKeyEntry } from "./registry.ts";
export { BIN, REPO_ROOT, cleanEnv, run } from "./run.ts";
export type { RunOptions, RunResult } from "./run.ts";
export {
  DUAL_TOOL,
  FIXTURE_TOOLS,
  FIXTURE_VERSION,
  RUNTIME_TOOL,
  useFixtureTable,
} from "./table-fixture.ts";
export type { FixtureTable } from "./table-fixture.ts";
export { hashOf, makeTarball, npmTarball, sriOf } from "./tarball.ts";
export type { TarEntryInput } from "./tarball.ts";
