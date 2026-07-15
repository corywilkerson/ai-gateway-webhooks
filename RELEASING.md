# Releasing

1. Bump `version` in `package.json` (and `templates/starter/package.json`'s
   dependency range if the major changed), commit, and push.
2. Create a GitHub Release with a `v<version>` tag (e.g. `v0.1.1`):
   `gh release create v0.1.1 --generate-notes`
3. The `release.yml` workflow runs checks and publishes to npm with
   provenance via trusted publishing. No tokens are involved; the trusted
   publisher is configured in the package's settings on npmjs.com.

The workflow fails if the tag doesn't match `package.json`'s version.
