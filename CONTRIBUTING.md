# Contributing to breakcheck

Small, focused PRs are welcome.

- Keep it zero-dependency. If a feature needs a package, it probably
  doesn't belong here.
- Add a test in `tests/breakcheck.test.js` for every behavior change
  (`node --test tests/breakcheck.test.js`).
- Keep the CLI contract stable: flags, exit codes, and the `--format json`
  shape. If you must change them, say so loudly in the PR description.
- Every new deprecation / removed-API entry must be public and settled
  (official deprecation notice or removal in a released version) — no
  "this package feels dead" entries. Link the source in the PR.
- Run the examples before pushing:
  `node bin/breakcheck.js check --path examples/broken` (expect exit 1)
  and `node bin/breakcheck.js check --path examples/clean` (expect exit 0).
