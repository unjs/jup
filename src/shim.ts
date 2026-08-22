/**
 * The entry module the generated shims import — §10.1, §16.3.
 *
 * Deliberately narrower than `index.ts`: a shim only ever calls `runMain`, and
 * every additional export here would be loaded on every `yarn`, `npm` and `pnpm`
 * invocation on the machine, forever. Keep this file to the one export.
 */

export { runMain } from "./main.ts";
