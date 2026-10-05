# Website generation

Guide sources live in `docs/guides/`; reference introductions live in `docs/api/`.
`src/platform/catalog.ts` owns public module signatures and contracts.
`src/public-api.d.ts` owns build configuration and globals. `docs/model.ts` extracts
those declarations and combines them with the authored content. Keep defaults beside
fields; the documentation tests compare declared build defaults with runtime resolution.

`docs/render.ts`, `docs/docs.css`, and `docs/client.ts` own the documentation shell,
code blocks, navigation, and search interface. `templates/shared.css` owns the palette;
`templates/layout.ts` owns primary navigation, icons, and the footer. Examples in the
catalog are shared by API pages, declaration hovers, and guides. Other complete examples
live in `docs/examples/`.

## Generate and preview plain pages

```shell
npm run generate:platform-api
npm run site:docs
npm run site:preview
```

The preview prints a loopback URL. Plain HTML, Markdown, `reference.json`, `llms.txt`,
and a resource manifest are generated under `.cache/documentation/plain`. All
internal links and fragments are checked during generation. Plain previews support
symbol lookup; they contain neither Shiki markup nor a Pagefind index.

`npm run site:update` also updates Overview, Compatibility, and Explorer HTML. Those
three tracked outputs remain owned by `templates/` and `scripts/site-data.ts`.
Documentation HTML is generated only in ignored staging. Do not restore the retired
`maligator-*.html` outputs or commit a search index.

## Prepare the container

```shell
WASI_SDK_PATH=/path/to/wasi-sdk-34.0 npm run site:container
```

Use WASI SDK 34.0 to build the Explorer engine; `WASI_SDK_PATH` must point to the directory containing its `bin/clang` and `bin/llvm-ar`.

This is the production container preparation boundary. It regenerates plain pages,
copies them to `.cache/documentation/container`, highlights code with Shiki in the
website palette, and indexes the finished articles with Pagefind. Search excludes
navigation, copy controls, and footers. The index and all JavaScript/WASM files are
served from the website origin; no hosted search service is used.

The command builds Explorer assets, cross-builds the website for
`x86_64-unknown-linux-gnu`, and embeds the prepared documentation manifest and assets.
Use `npm run site:container -- --target aarch64-unknown-linux-gnu` for an ARM64 Linux
container. The prepared Docker context is printed at completion. Build the image
from that context with the matching Docker platform. Container preparation does not
publish or deploy it.

`npm run site:build` builds a plain native website for the host. It does not run
Pagefind or Shiki. The build config selects processed assets only when the container
build command sets `MALIGATOR_SITE_CONTAINER=1`. Generated code/search assets never
modify tracked website inputs.

For documentation-only container QA without compiling the runtime:

```shell
node scripts/prepare-site-container.ts
npm run site:preview -- --container
```

This prepares the same container assets and serves the same resource manifest and
response/CSP code. It does not introduce a second highlighting path. Previewing an
existing container stage does not rebuild it.

## Verify a change

```shell
npm run test:unit -- --run tests/documentation.test.ts tests/website-responses.test.ts tests/public-api-types.test.ts
npm run test:unit:full-only -- --run tests/documentation-container.test.ts
npm run lint:ci
```

The container integration checks staging isolation, code preservation, Markdown
parity, manifest integrity, and tracked-input preservation. Inspect desktop/mobile
pages and test keyboard search, copy, and deep links against prepared assets. Public
worker examples also run in the native developer gate.

Favicon files are resized from `mascot.webp` and served at the site root. Explorer
assets are built into `.cache/explorer-site/current`; its external CSS keeps its own
CSP free of inline scripts and styles.
