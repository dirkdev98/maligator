# Maligator roadmap

This is the committed cross-project index. Each task has one owning roadmap;
completed work belongs in commits, tests, and benchmark baselines rather than in
active checklists. Test262 verdict counts live only in `scripts/test262.json`.

## Current priorities

1. First alpha release.
2. Safety and bounded resource use.
3. AOT throughput and allocation elimination.
4. Outbound I/O and server-runtime APIs.
5. ECMAScript correctness and runtime usability.
6. Actors, SMP, GUI embedding, and freestanding targets.

## First alpha release

The alpha is ready when a user on every supported host can install Maligator from
npm, run the prebuilt product CLI outside this checkout, and use it to produce and
run a production application binary.

### Production build creation

- [x] Support application `build --production` with `-O2`, capability-probed LTO,
      and capability-probed symbol stripping.
- [ ] Add a deterministic release command around the existing product-CLI builder.
- [ ] Make the package version, `maligator --version`, and artifact version come
      from one source of truth.
- [ ] Define release artifact names and archive layout, and emit checksums.
- [ ] Smoke-test the production CLI without the repository or Node.js on `PATH`,
      including `--help`, `--version`, `doctor`, `init`, `build --production`, and
      running the resulting application.

### Cross-platform native binaries

- [x] Support target-specific Zig toolchain detection and cross-building for the
      initial macOS/Linux x64/arm64 Rust target triples.
- [ ] Declare the initial supported OS/architecture matrix and minimum host
      versions; explicitly decide whether Windows is in the first alpha.
- [ ] Build the product CLI natively for every supported target in CI.
- [ ] Run the release smoke test on every artifact, including a clean host with the
      documented C/C++ and Rust toolchain requirements.
- [ ] Decide and document the signing/notarization policy for each platform.

### Publish to npm

- [ ] Choose the npm distribution layout: platform packages plus a small launcher,
      or one package containing all supported binaries.
- [ ] Complete publishable package metadata: remove `private`, add a description,
      license, keywords, supported platforms/CPU policy, and an explicit `files`
      allowlist.
- [ ] Make installation select the correct binary and fail clearly on unsupported
      hosts; document whether a source-build fallback exists.
- [ ] Verify `npm pack` contents and install the tarball in a clean temporary
      project before publishing.
- [ ] Publish prereleases with SemVer alpha versions under the npm `alpha` dist-tag,
      leaving `latest` untouched.

### Release gates and operations

- [ ] Add a tag-driven release workflow that runs the release-candidate gate,
      builds all artifacts once, and publishes those exact tested artifacts using
      npm trusted publishing.
- [ ] Run `npm run test:full:report` for a release candidate and resolve or record
      every failure; this remains approval-only.
- [ ] Write concise release notes with the supported matrix, required application
      build toolchains, known limitations, and an issue-reporting path.
- [ ] Define the failed-release procedure: stop the workflow, deprecate a broken npm
      version rather than reusing it, fix forward, and publish a new alpha.

## Queued cross-cutting runtime work

- [ ] Implement or reject `host.scheduler: "multiprocessing"`.
- [ ] Add Intl locale subsetting.

Compiler optimization and analysis are owned by the
[compiler roadmap](docs/roadmaps/compiler.md). Test262 compiler and suite throughput
is owned by the [Test262 performance roadmap](test262-perf-todo.md).

## Domain roadmaps

- [Compiler optimization and analysis](docs/roadmaps/compiler.md)
- [GC, allocation, and recoverable OOM](docs/roadmaps/gc.md)
- [Isolates, reactor, actors, and hosts](docs/roadmaps/isolate-reactor.md)
- [WinterTC server profile](docs/roadmaps/wintertc.md)
- [Node and Express compatibility](docs/roadmaps/node-compat.md)
- [eval, Function, and realms](docs/roadmaps/eval-realms.md)
- [Test262 correctness](docs/roadmaps/test262.md)

## Triggered work

These are not active tasks:

- Revisit `MalVm` and host-structure layout when SMP creates multiple VMs.
- Revisit concurrent GC marker threads and parallel marking when a real big-heap
  workload shows mutator marking is a top cost.
