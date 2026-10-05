Keep build choices in `maligator.build.ts` at the project root. The CLI evaluates this trusted TypeScript on every invocation and rejects unknown or invalid fields.

## Create a configuration

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	outputName: "my-app",
	surface: { node: true },
});
```

[defineBuild](/api/build#defineBuild) preserves the inferred type. Validation happens when the CLI loads the config. Ordinary variables, functions, conditions, and environment reads are allowed. The supported package import is `defineBuild`; do not import arbitrary helper modules into this file.

```shell
maligator run
maligator build src/other.ts --config maligator.build.ts --production
```

The working directory is the project root. An explicit entry overrides `config.entry`; `--config` resolves from that same directory. No parent-directory search occurs. Without a config, an explicit entry uses product defaults.

## Select features and host APIs

Enable only the APIs your application uses. `surface.node` includes supported Node modules; `surface.webPlatform` includes Web APIs and `Mal.serve`. `surface.maligator` defaults to enabled and provides `mal.assets`.

Engine choices apply to the whole image, including workers. RegExp is enabled by default. Eval, Realm support, Temporal, and Intl are opt-in. `engine.eval: true` embeds the runtime compiler; `"compile-check"` rejects visible dynamic compilation and keeps it disabled at runtime.

The [configuration reference](/api/build#MaligatorBuildConfig) lists each default and interaction. Type declarations remain visible even for disabled surfaces. Check [Compatibility](/compatibility) for support within an enabled surface.

## Replace a module specifier

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	modules: { aliases: { "app-store": "./src/store.ts" } },
});
```

Aliases replace exact specifiers before resolution. They are not prefix mappings or TypeScript `paths` configuration. Create the replacement module before building.

## Check a configuration failure

For `config file not found`, verify the working directory and `--config` path. For an unknown field, check the full field path in the diagnostic against [the reference](/api/build). Locale-data filtering is not implemented: `engine.intl.languages` must remain empty.

Assets require `surface.maligator`. Follow [Embed files](/guides/assets) for inclusion patterns, or [Build for production](/guides/production) for target and artifact options.
