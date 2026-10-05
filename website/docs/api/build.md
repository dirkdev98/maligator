Import `defineBuild` from `@maligator/cli` in a trusted `maligator.build.ts`. These types describe build choices; the CLI validates the resulting value when loading configuration.

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	outputName: "my-app",
	surface: { webPlatform: true },
});
```

All configuration fields are optional. Entries and asset paths resolve from the project root (the working directory), and an explicit CLI entry takes precedence. `outputName` must be a safe single filename component. Without it, the CLI uses the unscoped package name or directory name.

[Configure a build](/guides/build-configuration) explains feature selection. [Embed files](/guides/assets) covers asset patterns and materialization. The signatures and field documentation below are extracted from the shipped declarations.
