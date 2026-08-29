# 12 — Errors, Messages, Exit Codes

These strings are asserted byte for byte by the test suite, including the leading
`! `, the absent trailing periods, and the exact interpolation. `src/errors.ts`
holds the ones the warm path can print; `src/errors-cold.ts` holds everything
else and re-exports the first, so a warm run never parses the download and
network vocabulary. Both are the authority; this page is the map.

Messages say `jup` and name `JUP_` variables. A message that reports *where* a
value came from names the spelling the user set (§11.6), which is the only place
`COREPACK_` appears in output.

## 12.1 Classes

| Class | Meaning | Presentation |
|---|---|---|
| `UsageError` | The user asked for something impossible or contradictory | proxy: message on stderr, no stack, exit 1. management: `Usage Error: <message>` on **stdout**, a blank line, then the command's usage line, exit 1 |
| `Error` | Anything else, internal assertions included | stderr with a stack, exit 1 |

Only `UsageError` gets friendly treatment; a stack trace is the correct output
for a bug. The management-mode shape:

```
Usage Error: The requested version of yarn@1.22.4+sha512.… does not match the devEngines specification (yarn@2.x)

$ jup use [--here] [--no-integrity] [--no-lockfile] <pattern>
```

The usage line is keyed by the command word, falling back to `$ jup <command>`.

## 12.2 Spec parsing (§03.4)

```
Invalid package manager specification in <source>; expected a string
No version specified for <raw> in "packageManager" of <source>
Unsupported package manager specification (<name|raw>)
Invalid package manager specification in <source> (<raw>); expected a semver version
Illegal use of URL for known package manager. Instead, select a specific version, or set JUP_ENABLE_UNSAFE_CUSTOM_URLS=1 in your environment (<raw>)
Invalid package.json in <relative path>
"packageManager" cannot name <name>: it is a runtime, not a package manager - declare it in "devEngines.runtime" instead
JUP_SPEC_FILE points at <path>, which does not exist
```

`<source>` is `CLI arguments` or the manifest path relative to the initial cwd.

Version files:

```
Invalid <source>: expected a single version, optionally with # comments and key=value lines
Unsupported version "<declared>" in <source>: jup resolves semver versions and ranges, not nvm aliases - write a version or range there, or declare it in "devEngines.runtime"
```

Both name `<source>` because in a monorepo *which* `.nvmrc` spoke is the reader's
first question, and neither is a warning: falling back to the compiled-in default
would run a version the project explicitly did not ask for.

## 12.3 `devEngines` validation (§03.3)

Unconditional warnings, regardless of `onFail`, on stderr:

```
! jup only supports objects as valid value for devEngines.<field>. The current value (<JSON>) will be ignored.
! jup does not currently support array values for devEngines.<field>
```

Everything else routes through `warnOrThrow`, whose bodies are:

```
The value of devEngines.<field>.name <JSON> is not a supported string value
The value of devEngines.<field>.version <JSON> is not a valid semver range
"packageManager" field is set to <JSON> which does not match the "devEngines.packageManager" field set to <JSON>
"packageManager" field is set to <JSON> which does not match the value defined in "devEngines.packageManager" for <JSON> of <JSON>
The requested version of <name>@<reference> does not match the devEngines specification (<name>@<range>)
Invalid "devEngines.packageManager.integrity" field: <JSON>
The "packageManager" field (<pm>) and "devEngines.packageManager.integrity" (<sri>) pin different hashes
```

`<field>` is `packageManager` or `runtime`. Thrown, the body appears bare (proxy)
or wrapped in `Usage Error:` (management); warned, it is prefixed
`! jup validation warning: `. `<JSON>` means `JSON.stringify(value)`, so strings
appear quoted.

## 12.4 Resolution (§04)

```
Failed to successfully resolve '<range>' to a valid <name> release
Tag not found (<tag>)
Packages managers can't be referenced via tags in this context
This package manager (<name>) isn't supported by this jup build
Assertion failed: Specified resolution (<reference>) isn't supported by any of <ranges>
The 'jup up' command can only be used when your project's packageManager field is set to a semver version or semver range
Failed to find the highest release for <name> <major>.x
<name>@<range> is not resolved in jup.lock and lockfile updates are disabled.
```

Stale-resolution advisories (§04.4), the only output a successful fallback
produces:

```
! Unable to reach the registry to resolve <name>@<range>; running <name>@<version>, the expired resolution recorded in <memo>. Its stamp is not extended, so this repeats until the registry answers again.
! The registry lists no release matching <name>@<range>; running <name>@<version>, the expired resolution recorded in <memo>. Its stamp is not extended, so this repeats until a matching release is published.
```

Both name the memo's path, because the reader's next question is which file to
delete. The two halves are kept distinct because the remedies differ: an
unreachable registry is somebody's outage and will pass; a range nothing matches
will not fix itself. Neither may be raised for an error that is a statement about
the *request* (§04.4).

## 12.5 Project enforcement (§03.5)

```
This project is configured to use <name> because <absolute path> has a "<field>" field
```

with this clause appended when that path resolves to the home directory or above,
making the manifest's unusually broad scope explicit:

```
 (this manifest is outside any project — a stray "<field>" field there affects every directory)
```

`<field>` is the field the spec was **read from** (§3.3) — `packageManager` or
`devEngines.packageManager` — and is the same in both slots. It is not simply
whichever field exists: this is the one message whose job is to name the file and
the field to edit, and since the member outranks the top-level field, naming
`packageManager` unconditionally would send the reader to a field that is either
absent or not the one being obeyed.

Absolute, native-separator path, stderr, exit 1.

## 12.6 Network and TLS (§05)

```
Network access disabled by the environment; can't reach <url>
Network access disabled by the environment; can't reach npm repository <registryUrl>
Error when performing the request to <url>; for troubleshooting help, see https://github.com/unjs/jup#troubleshooting
Server answered with HTTP <status> when performing the request to <url>; for troubleshooting help, see …
Timed out after <ms>ms waiting for <url> (set JUP_NETWORK_TIMEOUT to allow longer)
Giving up after <n> attempt(s) (set JUP_NETWORK_RETRIES to change)
<packageName>@<version> does not have a valid tarball.
<name>@<version> does not exist in <registry>. Run 'jup info' to see the resolved spec and where it came from.
<name>@<version> does not exist in <registry>. jup installs <name> from <package>, whose earliest published version is <from>; releases before it were only ever distributed elsewhere. Pin <from> or newer.
Refusing to download from <host>: it does not match the configured registry <registry>
Aborted by the user
```

TLS:

```
! TLS certificate verification is disabled (set by <source>)
TLS certificate verification failed for <host>: the certificate was issued by an unknown authority. If your network uses a TLS-inspecting proxy, point JUP_CAFILE at its CA bundle.
TLS certificate for <host> is expired or not yet valid (check the system clock).
TLS certificate for <host> does not match that hostname.
Unable to read the TLS certificate bundle at <path> (set by <source>)
The TLS certificate bundle at <path> contains no PEM certificate
The TLS certificates from <source> were installed, but this runtime's trust store does not reflect them; requests would fail with an unexplained certificate error
This runtime cannot apply the TLS certificates from <source>: node:tls provides no setDefaultCACertificates
```

And the wrapped default-version failure, whose two variable names are asserted:

```
jup cannot download the latest stable version of <packageName>; you can disable signature verification by setting JUP_INTEGRITY_KEYS to 0 in your env, or instruct jup to use the latest stable release known by this version of jup by setting JUP_DEFAULT_TO_LATEST to 0
```

Every URL is passed through userinfo redaction before it reaches any message.

## 12.7 Integrity (§06)

```
No compatible signature found in package metadata
The package was not signed by any trusted keys: <pretty-printed {signatures, trustedKeys}>
Signature does not match
Mismatch hashes. Expected <expected>, got <actual>
Unsupported hash algorithm '<algo>' in the packageManager field
The package was signed with an expired key (<keyid>, expired <expires>)
Refusing to install <name>@<version>: <source> provides no signature and no hash was pinned. Pin a hash in the packageManager field, or set JUP_ALLOW_UNVERIFIED=1.
! jup integrity warning: <name>@<version> carries a valid signature from <keyid>, a key that expired <expires>; accepting it
! <registry> does not publish signatures for <package>@<version>; falling back to integrity-only verification
! Installing <name>@<version> from <source> with no signature and no pinned hash (JUP_ALLOW_UNVERIFIED=1)
```

The hash-mismatch format is used operationally — users read the `got` value and
paste it into their pin — so keep it.

## 12.8 Store and filesystem (§07)

```
Failed to create cache directory. Please ensure the user has write access to the target directory (<target>). If the user's home directory does not exist, create it first.
Refusing to use <target>: a directory is already there with no `.jup` marker, so it is not a complete install. Remove it and run again.
Refusing to extract '<entry>': path escapes the extraction directory
Unable to locate bin in package.json
Assertion failed: Unable to locate path for bin '<binName>'
The bin path '<path>' declared by <name>@<version> escapes its installation directory
Unable to execute <binPath>: <reason>
Unable to locate a Node.js runtime to execute <binName>; set JUP_NODE_EXECPATH to point at one
Invalid archive format; did it get generated by 'jup pack'?
Unsupported package manager '<name>'
Removed <n> cached version(s) from <path>
Removed <n> cached version(s) and <m> recorded default(s) from <path>
Nothing to remove
! Could not remove <path>; it is still in the cache. Remove it by hand, or re-run with permission to delete it.
```

The interpreter guards of §07.9:

```
! Kept <name>@<version>: jup's shims name <interpreter> as their interpreter, so removing it would leave every one of them failing with 'bad interpreter'. Re-run 'jup enable' under a node installed outside <home> to repin them, then clean again.
! Removing <name>@<version>, which jup's shims name as their interpreter (<interpreter>): they will fail with 'bad interpreter' until 'jup enable' is re-run under a node installed outside <home>.
```

## 12.9 Hosts (§02.4)

Raised **before any request**, so an unsupported host never costs a round trip,
and never replaced by a 404 on a URL still containing a literal placeholder:

```
<name>@<reference> ships per-platform artifacts, and there is none for platform '<platform>' (supported: darwin, linux, win32)
<name>@<reference> ships per-platform artifacts, and there is none for architecture '<arch>' (supported: arm64, x64)
<name>@<reference> publishes no artifact for <host> (this version ships: <targets>)
```

The first two say the *tool* does not cover the host; the third says this
*version* does not publish for it.

## 12.10 Commands and shims (§09, §10)

```
Couldn't find a project in the local directory - please specify the package manager to pack, or run this command from a valid project
The local project doesn't feature a 'packageManager' field nor a 'devEngines.packageManager' field - please specify the package manager to pack, or update the manifest to reference it
The local project doesn't feature a 'packageManager' field - please specify the package manager to pack, or update the manifest to reference it
Invalid package manager name '<name>'
Assertion failed: The stub folder doesn't exist
Unable to determine where to install the shims; pass --install-directory
Options --system and --install-directory both name an install directory; pass one or the other
--system has no directory on this platform: %ProgramData% is not set. Pass --install-directory <a writable directory on your PATH> instead
<binName> already exists at <file> and was not installed by this tool - skipping (use --force to overwrite)
<binName> is already installed in <file> and points to a Yarn Switch install - skipping
! <directory> is not writable; installing shims to <fallback> instead
! <fallback> is not on your PATH; installing shims to <chosen> instead
! <name> on PATH resolves to <path>, not the shim just installed at <shim>. Another version manager may be shadowing it.
! Unable to restore <path>: <reason>
```

`shims.ts`, `npmrc.ts`, `tls.ts` and `info.ts` keep their own longer diagnostic
strings beside the code that raises them; they are behaviour-prescribed rather
than byte-prescribed, and the read-only-install messages of §10.8 are there.

## 12.11 Informational output

```
Adding <name>@<reference> to the cache...
Installing <name>@<reference>...
Installing <name>@<reference> in the project...
Updated <path> to use <name>@<reference>
Removed <name>@<range> from <path>
All done!
! jup is about to download <url>
? Do you want to continue? [Y/n] 
! The local project doesn't define a package manager. jup will now add a 'devEngines.packageManager' entry referencing <name>@<reference>.
! For more details about this field, consult the documentation at https://nodejs.org/api/packages.html#packagemanager
! Ignoring <name> from <path>: this variable can only be set in the environment
```

The confirmation prompt has a trailing space and no newline.

`--no-lockfile` prints `Removed …` only when it removes an entry from the
committed `jup.lock` (§09).

## 12.12 Exit codes

| Situation | Code |
|---|---|
| Success | 0 |
| Any jup error, usage or internal | 1 |
| The tool set an exit code | that code |
| The tool threw uncaught | 1 |
| The tool was killed by signal N | signal death, or `128+N` |
| Yarn Switch skip during `enable`/`disable` | **0** — a warning, not a failure |
| `--version`, `--help` | 0 |

## 12.13 Known warts

Inherited spellings that are wrong but currently asserted. Fixing any of them is
a deliberate change with a test update, not a drive-by:

* `Packages managers can't be referenced via tags in this context` — a typo
  carried over from corepack.
* The `install`/`up`/`use` "no project" errors say **"to pack"**, so `jup up` in
  a bare directory advises specifying the package manager *to pack*.
* `COREPACK_MIGRATE_FROM` carries the literal string `unknown` when there was no
  previous pin, which a tool cannot distinguish from a package manager named
  `unknown`.
