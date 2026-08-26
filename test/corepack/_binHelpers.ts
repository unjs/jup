/** Upstream's `tests/_binHelpers.ts`, on the local fslib shim. */

import { ppath, xfs, type Filename, type PortablePath } from "./_fslib.ts";

export async function makeBin(
  cwd: PortablePath,
  name: Filename,
  { ignorePlatform = false }: { ignorePlatform?: boolean } = {},
) {
  let path = ppath.join(cwd, name);
  if (process.platform === `win32` && !ignorePlatform) path = `${path}.CMD` as PortablePath;

  await xfs.writeFilePromise(path, ``);
  await xfs.chmodPromise(path, 0o755);

  return path;
}

export function getBinaryNames(name: string) {
  if (process.platform !== `win32`) return [name];

  return [`${name}`, `${name}.CMD`, `${name}.ps1`];
}
