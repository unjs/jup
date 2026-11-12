/**
 * §08.3.3's addon, for the scriptc build: not needed. The executable makes
 * the `execve` itself (`run/native.ts`), so there is nothing to extract and
 * the 280 kB of embedded binaries stay out of the image.
 */

export function extractAddon(): string | undefined {
  return undefined;
}
