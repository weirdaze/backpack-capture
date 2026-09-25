# CLAUDE.md

Guidance for Claude Code working in this repository.

## Releasing

**Merging a version bump to `master` does not release anything.** A GitHub
release only exists once a `v*` tag is pushed — `.github/workflows/release.yml`
triggers on the tag, runs `npm test`, checks the tag matches
`manifest.json`'s `version`, zips `manifest.json icons src` and publishes
`backpack-capture-vX.Y.Z.zip` as the release. 0.8.0 sat merged but untagged
(and so missing from the release list) until this was done by hand.

Whenever a change bumps `manifest.json`'s `version`, finish with:

```
git tag -a vX.Y.Z <merge-commit-on-master> -m "vX.Y.Z"
git push origin vX.Y.Z
gh run list --workflow release.yml -L 1        # watch it to completion
gh release view vX.Y.Z                         # confirm the zip is attached
```

- Tag the merge commit on `master`, not the feature branch — the workflow
  checks out the tagged commit.
- The tag must equal the manifest version exactly (`v` + `version`), or the
  workflow fails on purpose. Bump the manifest first; never retag to fit.
- A GitHub release is not a Chrome Web Store release. Store submission is a
  separate, manual upload of the same zip.
