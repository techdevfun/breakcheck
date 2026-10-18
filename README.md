# breakcheck

Your dependencies will break. Your CI will leak. Probably not today —
but the day the platform removes the API you depend on, or the tag you
pinned to gets moved, is the day you find out.

`breakcheck` scans a project for things that will break or leak *before*
they do: deprecated dependencies, end-of-life runtimes, unpinned CI
actions, over-broad workflow permissions, unpinned Docker bases, and
APIs that platforms have already removed. Zero dependencies, plain
Node.js, no network, no telemetry.

## Why

- Platforms remove things with short notice. Chrome and Edge are
  removing XSLT. Python removed `imp` and `distutils` in 3.12. A vendor
  can halve a shutdown notice and your migration plan breaks with it.
- A workflow pinned to `@v4` trusts that the tag still points where it
  did yesterday. Tags move. Commit SHAs don't.
- `permissions: write-all` plus a compromised action is how one repo
  becomes a supply-chain incident. (A recent wave hijacked ~1,900
  GitHub accounts and reached ~30,000 repos — most of the damage ran
  through over-privileged automation, not zero-days.)
- Deprecated packages don't announce themselves. `request` has been
  unmaintained since 2020 and still shows up in fresh projects.

`breakcheck` doesn't fix any of this for you. It tells you exactly
where it is, with a fix for each finding, so the next breakage is a
planned migration instead of a fire drill.

## Demo

The bundled `examples/broken/` project is broken on purpose — one of
almost everything:

```sh
node bin/breakcheck.js check --path examples/broken
```

```
[ERROR] broad-permissions: 'permissions: write-all' grants every permission to the workflow (.github/workflows/ci.yml:5)
       fix: Grant only the permissions each job needs, e.g. 'permissions: { contents: read }'
[ERROR] unpinned-action: Action 'actions/checkout@v4' is pinned to mutable ref 'v4' — tags and branches can be moved (.github/workflows/ci.yml:11)
       fix: Pin the action to a full commit SHA, e.g. 'owner/repo@<40-hex-sha>'
[ERROR] hardcoded-secret: Possible hardcoded AWS access key id in workflow file (.github/workflows/ci.yml:12)
       fix: Move the secret to GitHub Secrets and reference it as ${{ secrets.NAME }}
[ERROR] unpinned-base: Docker base image 'node:latest' uses the mutable ':latest' tag (Dockerfile:1)
       fix: Pin the base image, e.g. 'node:22-alpine'
[ERROR] removed-api: XSLT in the browser is being removed from Chrome and Edge — XSLTProcessor will stop working (app.js:2)
       fix: Move the transform to the server, or pre-render the output at build time
[ERROR] removed-api: The 'imp' module was removed in Python 3.12 (legacy.py:3)
       fix: Use 'importlib' instead
[WARN ] floating-version: Dependency 'foo' uses floating version '*' — installs are not reproducible (package.json:1)
       fix: Pin to an exact version or a caret range, e.g. '^1.2.3'
[WARN ] deprecated-dep: 'moment' is in maintenance mode (no new features) (package.json:1)
       fix: For new code consider day.js, date-fns, or Temporal
[ERROR] deprecated-dep: 'request' is deprecated since 2020 and unmaintained (package.json:1)
       fix: Replace with node:http / undici, axios, or node-fetch
[ERROR] eol-runtime: engines.node '14' targets Node 14, which is end-of-life (Node 16 EOL Sep 2023, Node 14 EOL Apr 2023) (package.json:1)
       fix: Move engines.node to '>=18' (20 LTS recommended) and test on it
[ERROR] eol-runtime: requires-python '>=3.8' allows Python 3.8, which is end-of-life (3.8 EOL Oct 2024) (pyproject.toml:1)
       fix: Raise requires-python to '>=3.9' (3.11+ recommended)
[ERROR] deprecated-dep: 'pycrypto' is dead and unmaintained (last release 2013) (requirements.txt:1)
       fix: Replace with 'pycryptodome'
[WARN ] unpinned-requirement: Requirement 'flask' is not pinned with '==' (requirements.txt:2)
       fix: Pin to an exact version, e.g. 'flask==3.0.0'
Summary: 10 error(s), 3 warning(s), 7 file(s) scanned.
```

`examples/clean/` passes with `Summary: 0 error(s), 0 warning(s), 6 file(s) scanned.`

## Install

```sh
# needs Node.js 18+
git clone https://github.com/techdevfun/breakcheck.git
cd breakcheck
npm link   # makes `breakcheck` available everywhere
```

Or just run it without installing:

```sh
node bin/breakcheck.js --help
```

## Usage

```sh
# Scan a project (exit 1 if any error-level finding)
breakcheck check --path ./my-project

# JSON output for CI / scripts
breakcheck check --path ./my-project --format json

# Also fail on warnings (strict mode)
breakcheck check --path ./my-project --fail-on warn
```

| Option | Default | What it does |
|---|---|---|
| `--path DIR` | (required) | Project directory to scan |
| `--format text\|json` | `text` | Output format |
| `--fail-on error\|warn` | `error` | Fail when findings reach this level |
| `--help`, `--version` | | Show help / version |

Exit codes: `0` clean (or only below-threshold findings) · `1` findings
at/above `--fail-on` · `2` bad arguments / unreadable directory.

## What it checks

| File | Rules |
|---|---|
| `package.json` | Deprecated deps (`request`, `node-sass`, `tslint`, `babel-eslint`, `core-js` 2.x, …), `moment` maintenance-mode warning, floating versions (`*`, `latest`, `>=`), `engines.node` on an EOL Node, missing `engines.node` |
| `requirements.txt` | Deprecated Python packages (`pycrypto`, `nose`), unpinned requirements (no `==`) |
| `pyproject.toml` | `requires-python` allowing EOL Python, missing `requires-python` |
| `.github/workflows/*.yml` | Actions pinned to a mutable tag/branch instead of a full commit SHA, `permissions: write-all`, broad `contents: write`, `pull_request_target` (runs with secrets — never run untrusted PR code under it), hardcoded token-shaped secrets |
| `Dockerfile` | Base image with no tag or `:latest`, major-only tag (mutable) |
| Code (`.js/.ts/.py`) | Removed APIs: browser `XSLTProcessor`, Python `imp`, `collections.Mapping`-style aliases, `distutils` |

The deprecation list is deliberately small: every entry is a removal or
deprecation that is public and settled, not a popularity contest. The
tool scans locally and never phones home, so it can't check live
advisories — pair it with your package manager's audit for CVEs.

## In CI

```yaml
- name: Check for breakage risks
  run: node bin/breakcheck.js check --path . --format text
```

Warnings don't fail the run by default, so you can adopt it without
breaking existing builds. Turn on `--fail-on warn` once the warnings
are down to zero.

## Roadmap

- `--fix` for the safe mechanical fixes (pin `:latest` → explicit tag is
  intentionally *not* auto-fixed — picking the version is a decision).
- SARIF output for GitHub code scanning.
- More removed-API entries, driven by real breakage reports (open an
  issue when a platform removal bites you).

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
