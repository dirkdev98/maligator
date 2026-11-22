Import `defineBuild` from `@maligator/cli` in a trusted `maligator.build.ts`. These types describe build choices; the CLI validates the resulting value when loading configuration.

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	outputName: "my-app",
});
```

All configuration fields are optional. Entries resolve from the project root, which is the working directory. An explicit CLI entry takes precedence. `outputName` must be a safe single filename component. Without it, the CLI uses the unscoped package name or directory name.

To use a C library, name it under `ffi` and set its `contract` to the file that declares it with [defineLibrary](/api/library#defineLibrary).

[Configure a build](/guides/build-configuration) explains feature selection. [Embed files](/guides/assets) covers asset patterns and materialization. The signatures and field documentation below are extracted from the shipped declarations.
