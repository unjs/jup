/**
 * Upstream's `sources/folderUtils.ts`, mapped onto jup's store (§07.1).
 *
 * The two agree on the layout — `$COREPACK_HOME` (or the XDG cache fallback)
 * holding a `v1` install folder — so this is a rename. It is re-exported rather
 * than imported directly in the tests only to keep their `folderUtils.*` call
 * sites untouched.
 */

export { getHomeFolder as getCorepackHomeFolder, getInstallFolder } from "../../src/cache/store.ts";
