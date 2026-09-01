# `setup-jup` fixtures

These test projects each pin one package manager and one dependency. The
[`setup-jup` workflow](../workflows/setup-jup.yml) installs them from a relative
working directory, like packages in a monorepo.

Unpinned projects are created in `RUNNER_TEMP`. If they lived here, jup would
find this repository's pnpm pin in a parent directory.

Only the action tests use these files. Generated install files are ignored.

Two of them carry a marker that a real repository would not need. A nested
directory is not a separate project to pnpm or to Yarn: pnpm installs at the
nearest `pnpm-workspace.yaml` above it, and Yarn refuses a package that is not
listed in the outer project's workspaces. The empty `pnpm-workspace.yaml` and
the empty `yarn.lock` are what make each fixture the root of its own install.
Yarn's lockfile is committed for that reason and fills itself in during a run;
everything else a manager writes here is gitignored.
