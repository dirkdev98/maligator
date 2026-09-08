# Website generation

Run `npm run site:update` to regenerate the Overview, Compatibility, Explorer HTML,
and all platform API reference pages. This does not compile the native server or
build the Explorer's JavaScript and WebAssembly assets.

Edit page content in `templates/index.html`, `templates/compatibility.html`, or
`templates/explorer.html`. API reference content comes from `src/platform/catalog.ts`
and `src/platform/generate.ts`.
API typography and property layouts live in `templates/api.css`.

`templates/layout.ts` owns the primary navigation and site footer;
`templates/shared.css` owns the site palette, base typography, and their styling.
Explorer bundles it into its external CSS asset to satisfy its content security policy.
Each page selects its active navigation
entry during generation. API pages also render their active module link statically.
The HTML files directly under `website/` are generated outputs.

`npm run site:build` regenerates the pages before building the Explorer assets and
native server. Explorer asset placeholders in its generated HTML are filled by that
build step.
