# Releasing

Maligator ships as numbered alpha prereleases on npm. `@maligator/cli` is a small
Node.js launcher with exact-version optional dependencies on the native packages:

- `@maligator/cli-darwin-arm64`
- `@maligator/cli-darwin-x64`
- `@maligator/cli-linux-arm64`
- `@maligator/cli-linux-x64`

There is no source-build fallback. An unsupported host or installation without its
optional platform package fails with an actionable message. Windows is deferred
because the native host/runtime currently depends on POSIX APIs. The alpha binaries
are unsigned; macOS artifacts are not notarized. Minimum OS versions will be fixed
after the release artifacts have run on the clean-host validation matrix.

## Versions and channels

`package.json` is the release version source of truth; `src/version.ts` is generated
and checked before building or publishing. Every prerelease is published explicitly
under the npm `alpha` dist-tag. The release automation does not attempt to change or
remove the registry's `latest` tag.

Prepare the next numeric alpha with `npm run version:alpha`, write its release notes in
`docs/releases/<version>.md`, commit the release preparation, and push that exact commit
to `main` before dispatching the workflow. The notes become the GitHub release body.

## Prepare the packages

Every package, release archive and `--artifact` output carries `LICENSE` and
`THIRD_PARTY_NOTICES.md`, and the embedded runtime sources include the vendored
license files. Run `npm run generate:third-party-notices` after changing
`runtime/rust/Cargo.lock`, vendored code, or a runtime file ported from Node.js or
libuv, and commit the result before cutting a release.

The `Prepare release packages` GitHub Actions workflow is the preferred packaging
path. Dispatch it on the exact release commit. It cross-builds all four targets on
macOS ARM, executes the native binary and installed npm launcher on every supported
host, and retains the validated tarballs plus `packages.json` for seven days. The
intermediate multi-target workspace is deleted after the smoke matrix passes.

## Create the GitHub release

Download the successful run's `maligator-<version>-packages` artifact into
`dist/release/packs` in a clean checkout. `release:create-github` then verifies the
commit and tarball checksums, creates the exact `v<package.json version>` tag and a
draft GitHub prerelease, uploads every npm tarball plus `packages.json`, verifies the
complete draft, and publishes the GitHub release. Publishing the prerelease triggers
the separate `Publish npm alpha` workflow.

```shell
gh workflow run release-packages.yml --ref main
run_id="$(gh run list --workflow release-packages.yml --commit "$(git rev-parse HEAD)" --event workflow_dispatch --status success --limit 1 --json databaseId --jq '.[0].databaseId')"
version="$(node -p 'require("./package.json").version')"
gh run download "$run_id" --name "maligator-$version-packages" --dir dist/release/packs
npm run release:create-github -- --confirm "$(node -p "require('./package.json').version")"
```

## Publish to npm

The publish workflow only checks out the tagged commit, validates its ancestry and
exact version tag, downloads the prepared assets, rechecks their manifest and
checksums, and publishes through npm trusted publishing. It has `id-token: write`
permission but no stored npm token. `--trusted-publishing` is accepted only for the
matching tag in a GitHub Actions OIDC environment; local publishing continues to
require web authentication. If draft creation or asset verification fails, the
GitHub release remains unpublished and the npm workflow does not run.

If publishing fails after an immutable release is created, repair and push `main`,
then retry that same release without replacing its tag or assets:

```shell
release_tag="v$(node -p 'require("./package.json").version')"
gh workflow run npm-release.yml --ref main -f release_tag="$release_tag"
```

The retry path accepts only the exact version in `package.json`, checks that the
release is an immutable prerelease whose tag commit is contained in `main`, and
revalidates every downloaded tarball before publishing.

## One-time repository setup

GitHub release immutability is a required repository setting. Once the draft is
published, GitHub then prevents replacement or deletion of its tag and assets. Enable
it with an administrative GitHub credential before the first release:

```shell
gh api --method PUT -H "X-GitHub-Api-Version: 2026-03-10" \
  repos/dirkdev98/maligator/immutable-releases
```

Before the first workflow release, configure every npm package once for repository
`dirkdev98/maligator`, workflow filename `npm-release.yml`, and the `npm publish`
permission. The CLI equivalent for each package is:

```shell
npm trust github @maligator/cli --repo dirkdev98/maligator --file npm-release.yml --allow-publish --yes
```

Repeat that command for the four `@maligator/cli-<platform>-<arch>` packages listed
above. npm protects this one-time trust change with 2FA; subsequent workflow
publishes use short-lived OIDC credentials and require neither an npm token nor an
OTP.

## Local fallback

The local single-target build remains available when the workflow cannot run:

```shell
npm run release:build -- --target aarch64-apple-darwin
npm run release:smoke
npm run release:pack -- --target aarch64-apple-darwin
git push origin main
npm run release:create-github -- --confirm "$(node -p "require('./package.json').version")"
```

`release:build` and `release:pack` default to `aarch64-apple-darwin` so a local
release only builds Apple Silicon macOS. Pass `-- --all-targets` for the complete
matrix or `-- --target <rust-triple>` for one explicit target. Build and pack must
use the same selection. Packing a native-host target also installs the two tarballs
into a clean temporary project and verifies the installed launcher.

`release:publish` verifies every selected tarball against `packages.json`, publishes
the platform packages first, and publishes `@maligator/cli` last under the `alpha`
dist-tag. Each publish is a plain synchronous `npm publish` with the terminal's
stdin/stdout/stderr inherited, so enter the OTP directly when npm prompts. Build,
pack, and publish log per-target progress and elapsed time.
