# `setup-jup` fixtures

These test projects each pin one package manager and one dependency. The
[`setup-jup` workflow](../workflows/setup-jup.yml) installs them from a relative
working directory, like packages in a monorepo.

Unpinned projects are created in `RUNNER_TEMP`. If they lived here, jup would
find this repository's pnpm pin in a parent directory.

Only the action tests use these files. Generated install files are ignored.
