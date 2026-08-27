# 12 — Errors, Messages, Exit Codes

User-facing strings are part of the contract. Scripts, CI logs, and support docs
match on them. Reproduce them **byte for byte**, including the leading `! `, the
absence of trailing periods, and the exact interpolation.

Where Corepack's own text names itself, these strings name **this** tool instead —
`jup` for the program, `JUP_` for the variable a remedy points at (§14.24). Nothing
else about the wording moves; a row below that differs from Corepack's differs in
that name and nowhere else.

## 12.1 Error classes

| Class | Meaning | Presentation |
|---|---|---|
| **UsageError** | The user asked for something impossible or contradictory | proxy mode: message on stderr, no stack, exit 1.<br>management mode: `Usage Error: <message>` on **stdout**, then a blank line, then the command's usage line, exit 1 |
| **Error** | Anything else, including internal assertions | stderr with a stack, exit 1 |

Only `UsageError` gets the friendly treatment. Corepack fixed a bug where every error
was presented as a usage error (0.31.0); a re-implementation MUST keep the
distinction, because a stack trace is the correct output for a bug.

Management-mode format, verbatim shape:

```
Usage Error: The requested version of yarn@1.22.4+sha512.… does not match the devEngines specification (yarn@2.x)

$ jup use [--here] [--pin-style=suffix|sidecar] <pattern>
```

## 12.2 Spec parsing (§03.4)

| Condition | Message |
|---|---|
| Non-string `packageManager` | `Invalid package manager specification in <source>; expected a string` |
| No version, exact required | `No version specified for <raw> in "packageManager" of <source>` |
| Name-only, unsupported name | `Unsupported package manager specification (<name>)` |
| Version present, unsupported name | `Unsupported package manager specification (<raw>)` |
| Not a valid exact version | `Invalid package manager specification in <source> (<raw>); expected a semver version` |
| URL for a known package manager | `Illegal use of URL for known package manager. Instead, select a specific version, or set JUP_ENABLE_UNSAFE_CUSTOM_URLS=1 in your environment (<raw>)` |
| Malformed manifest JSON | `Invalid package.json in <relative path>` |

`<source>` is `CLI arguments` or the manifest path relative to the initial cwd.

## 12.3 `devEngines` validation (§03.3)

Warnings (always stderr, always prefixed `! `):

```
! jup only supports objects as valid value for devEngines.packageManager. The current value (<JSON>) will be ignored.
! jup does not currently support array values for devEngines.packageManager
! jup validation warning: <message>
```

The first two are unconditional warnings regardless of `onFail`. Everything else
routes through `warnOrThrow`, whose message bodies are:

```
The value of devEngines.packageManager.name <JSON> is not a supported string value
The value of devEngines.packageManager.version <JSON> is not a valid semver range
"packageManager" field is set to <JSON> which does not match the "devEngines.packageManager" field set to <JSON>
"packageManager" field is set to <JSON> which does not match the value defined in "devEngines.packageManager" for <JSON> of <JSON>
The requested version of <name>@<reference> does not match the devEngines specification (<name>@<range>)
```

When thrown, the message appears bare (proxy mode) or wrapped in `Usage Error:`
(management mode). When warned, it is prefixed `! jup validation warning: `.

`<JSON>` means `JSON.stringify(value)` — strings appear with their quotes.

## 12.4 Resolution

| Condition | Message |
|---|---|
| Range matched nothing | `Failed to successfully resolve '<range>' to a valid <name> release` |
| Tag not in the registry's dist-tags | `Tag not found (<tag>)` |
| Tag used where tags aren't allowed | `Packages managers can't be referenced via tags in this context` |
| Unknown package manager in the table | `This package manager (<name>) isn't supported by this jup build` |
| No range band covers the version | `Assertion failed: Specified resolution (<reference>) isn't supported by any of <ranges joined by ", ">` |
| `up` on a non-semver pin | `The 'jup up' command can only be used when your project's packageManager field is set to a semver version or semver range` |
| `up` cannot find the major line | `Failed to find the highest release for <name> <major>.x` |

## 12.5 Project enforcement

```
This project is configured to use <name> because <absolute path to package.json> has a "packageManager" field
```

**§15.35k** appends a clause when that path resolves to the home directory or above:
`(this manifest is outside any project — a stray "packageManager" field there affects
every directory)`. A stray `$HOME/package.json` otherwise breaks one package manager
everywhere, with no clue as to why — the single most-repeated confusion in the
issue thread behind that requirement.

The path is absolute and native-separator-formatted. This message goes to **stderr**
and exits 1.

## 12.6 Network (§05)

```
Network access disabled by the environment; can't reach <url>
Network access disabled by the environment; can't reach npm repository <registryUrl>
Error when performing the request to <url>; for troubleshooting help, see https://github.com/unjs/jup#troubleshooting
Server answered with HTTP <status> when performing the request to <url>; for troubleshooting help, see https://github.com/unjs/jup#troubleshooting
<packageName>@<version> does not have a valid tarball.
Aborted by the user
```

Plus the wrapped default-version failure:

```
jup cannot download the latest stable version of <packageName>; you can disable signature verification by setting JUP_INTEGRITY_KEYS to 0 in your env, or instruct jup to use the latest stable release known by this version of jup by setting JUP_DEFAULT_TO_LATEST to 0
```

Both env var names in that last message are asserted by the conformance suite, as is
the *absence* of the never-existing names `INTEGRITY_CHECK` and `USE_LATEST` under
either prefix. Corepack's own wording is the same sentence with its name in place of
this one's, so a log scraper keyed to either half of the remedy still matches.

## 12.7 Integrity (§06)

```
No compatible signature found in package metadata
The package was not signed by any trusted keys: <pretty-printed {signatures, trustedKeys}>
Signature does not match
Mismatch hashes. Expected <expected>, got <actual>
```

The hash-mismatch message is used operationally: users run the command, read the
`got` value, and paste it into their `packageManager` field. Keep the format.

## 12.8 Store & filesystem (§07)

```
Failed to create cache directory. Please ensure the user has write access to the target directory (<target>). If the user's home directory does not exist, create it first.
Cannot locate '<binPath>' in downloaded tarball
Unable to locate bin in package.json
Assertion failed: Unable to locate path for bin '<binName>'
Invalid archive format; did it get generated by 'jup pack'?
Unsupported package manager '<name>'
```

Deprecated `hydrate` uses `did it get generated by 'jup prepare'?` instead.

## 12.9 Commands (§09, §10)

```
Couldn't find a project in the local directory - please specify the package manager to pack, or run this command from a valid project
The local project doesn't feature a 'packageManager' field nor a 'devEngines.packageManager' field - please specify the package manager to pack, or update the manifest to reference it
The local project doesn't feature a 'packageManager' field - please specify the package manager to pack, or update the manifest to reference it
Invalid package manager name '<name>'
Assertion failed: The stub folder doesn't exist
<binName> is already installed in <file> and points to a Yarn Switch install - skipping
```

## 12.10 Informational output

```
Adding <name>@<reference> to the cache...
Installing <name>@<reference>...
Installing <name>@<reference> in the project...
All done!
! jup is about to download <url>
? Do you want to continue? [Y/n] 
! The local project doesn't define a 'packageManager' field. jup will now add one referencing <name>@<reference>.
! For more details about this field, consult the documentation at https://nodejs.org/api/packages.html#packagemanager
```

(The confirmation prompt has a trailing space and no newline.)

## 12.11 Exit codes

| Situation | Code |
|---|---|
| Success | 0 |
| Any tool error (usage or internal) | 1 |
| Package manager set an exit code | that code |
| Package manager threw an uncaught error | 1 |
| Package manager killed by signal N | signal death, or `128+N` |
| Yarn Switch skip during `enable`/`disable` | **0** — a warning, not a failure |
| `--version`, `--help` | 0 |

## 12.12 New messages required by this spec

Messages for behaviours this spec adds over the reference implementation. They are
new, so they may be worded freely, but a conforming implementation SHOULD use these:

```
The package was signed with an expired key (<keyid>, expired <expires>)                     §06.5
Unable to locate a Node.js runtime to execute <binName>; set JUP_NODE_EXECPATH to point at one   §08.3.1
Unable to determine where to install the shims; pass --install-directory                    §10.4
<binName> already exists at <file> and was not installed by this tool - skipping (use --force to overwrite)   §10.2
Refusing to extract '<entry>': path escapes the extraction directory                        §07.4
Refusing to download from <host>: it does not match the configured registry <registry>      §05.2
The bin path '<path>' declared by <name>@<version> escapes its installation directory       §08.1
Unsupported hash algorithm '<algo>' in the packageManager field                             §06.2
```
