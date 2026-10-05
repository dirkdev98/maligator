Use the source repository when changing the compiler, native runtime, or website. These commands test Maligator itself; application projects use [maligator test](/guides/testing).

## Set up the checkout

```shell
git clone https://github.com/dirkdev98/maligator.git
cd maligator
npm ci
npm run env:check -- --json
```

Source tooling needs Node.js 24 or newer. Read `AGENTS.md` and the [testing policy](https://github.com/dirkdev98/maligator/blob/main/docs/testing.md). Before native work, run `node ./src/index.ts doctor --verbose`. The environment probe checks workspace/cache writes and loopback access; resolve capability failures before diagnosing product code.

## Choose focused verification

```shell
npm run test:unit -- --run tests/platform-catalog.test.ts
npm run type-check
npm run lint:ci
npm run test:check -- --plan=json
npm run test:check
```

Use bounded one-shot commands during development. The normal gate includes smoke and selected native, sanitizer, and standards lanes; it is not the full standards corpus. Follow the repository policy for test placement and explicit authorization for full suites or baseline replacement.

For compiler diagnostics, `MAL_DEBUG=true node ./src/index.ts build <fixture>` prints per-pass Core evidence. Reproduce standards cases through their runner so includes and variants are honored.

## Edit the documentation

Guide sources live under `website/docs/guides`. Public module signatures and contracts live in `src/platform/catalog.ts`; build and global declarations live in `src/public-api.d.ts`. Regenerate shipped declarations with `npm run generate:platform-api`.

`npm run site:update` writes plain documentation to ignored staging. `npm run site:container` prepares the container build: it highlights code with Shiki, creates the Pagefind index, and embeds the prepared assets. Postprocessed HTML and search files are never committed. See the [website build instructions](https://github.com/dirkdev98/maligator/blob/main/website/README.md) for previews and the container boundary.

Keep reusable documentation decisions in `docs/decisions`, unfinished work in `TODO.md`, and disposable evidence in task-scoped cache or temporary directories. Preserve unrelated work and use the repository's supported cache commands.
