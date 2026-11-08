## Summary

<!-- What does this PR change and why? -->

## Verification Checklist

- [ ] `./verify.sh --public` passes with `ALL CHECKS PASSED` (syntax, unit tests, manifest, zero-dependency audit, public repo hygiene).
- [ ] Zero npm dependencies added (Node 22 stdlib only).
- [ ] All process invocations use `child_process.execFile` with an explicit `argv` array (never `exec` or `shell: true`).
- [ ] Unreported metrics remain `?` (never guessed or fabricated).
- [ ] Added or updated unit tests in `test/*.test.js` and updated `CHANGELOG.md` under `## [Unreleased]`.
