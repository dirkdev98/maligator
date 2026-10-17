# Contributing

This guide covers working on Maligator itself: the compiler, the native runtime, and
the website. Application projects use the [guides](https://maligator.ddv.tools/guides)
instead, including `maligator test` for their own tests.

Bugs and rough edges are best reported as an
[issue](https://github.com/dirkdev98/maligator/issues) with a small reproducer, the
Maligator version, your `maligator.build.ts`, and the host you ran it on.

## Set up the checkout

Source tooling needs Node.js 24 or newer. Native work also needs the C and Rust
toolchains from [Set up native builds](https://maligator.ddv.tools/guides/native-toolchain).

```shell
git clone https://github.com/dirkdev98/maligator.git
cd maligator
npm ci
npm run env:check -- --json
(cd runtime/rust && rustup show)
node ./src/index.ts doctor --verbose
```

`env:check` probes workspace, temporary, and cache writes plus loopback access. Fix a
reported capability failure before diagnosing product code. `rustup show` inside
`runtime/rust` installs and selects the pinned Rust toolchain.

The source CLI is `node ./src/index.ts`. It accepts the same commands as the
distributed `maligator` CLI and uses this checkout's runtime, while the working
directory stays the application project root:

```shell
node ./src/index.ts build path/to/entry.ts
```

## Verify a change

Run the tests that observe your change while editing, then type-check and lint once
after a cohesive piece of work:

```shell
npm run test:unit -- tests/platform-catalog.test.ts
npm run test:native -- <fixture>
npm run type-check
npm run lint:ci
```

Then push or open a pull request and let CI do the heavy work. Every pull request and
push runs the canonical check gate. Pushes to `main` also run the remaining native
coverage, Extended CI and the full Test262 corpus, which maintains its own baseline
and regression issue. There is no need to run those locally;
`npm run test:check -- --plan=json` shows what the gate covers without running it.
Unit commands run once by default; pass `-- --watch` for a watch loop.
[Verification](AGENTS.md#verification) lists the focused commands per purpose, and
[docs/testing.md](docs/testing.md) covers tiers, manifests, and where new tests belong.

## Repository layout

- `src/compiler`: the compiler, from module loading
  (`pipeline/compile-program.ts`) to the host-independent core that produces VM
  definitions (`pipeline/compile-core.ts`).
- `src/cli-commands.ts`: installation-aware command orchestration.
- `src/native-build-context.ts`, `src/runtime-build.ts`, `src/local-build.ts`: native
  build context, reusable artifacts, and final linking.
- `src/platform/catalog.ts` and `src/public-api.d.ts`: public modules, build
  configuration, and globals. The website reference is generated from them.
- `runtime`: the C runtime and its Rust crate.
- `tests`: unit and native integration coverage.
- `website`: the site at [maligator.ddv.tools](https://maligator.ddv.tools) and its
  documentation sources.
- `docs/decisions`: architecture decisions.

## Further reading

- [docs/native-builds.md](docs/native-builds.md): toolchain discovery, build modes,
  and the cache layout.
- [docs/testing.md](docs/testing.md), [docs/benchmarking.md](docs/benchmarking.md),
  and [docs/profiling.md](docs/profiling.md): test selection, performance comparisons,
  and application investigation.
- [website/README.md](website/README.md): generating and previewing the website.
- [docs/releasing.md](docs/releasing.md): preparing and publishing an alpha.
- [TODO.md](TODO.md): unfinished project work.

[AGENTS.md](AGENTS.md) is the working policy for coding agents in this repository. It
is also the most complete description of how changes here are verified, scoped, and
committed, so it is worth a read when working with or without an agent.
