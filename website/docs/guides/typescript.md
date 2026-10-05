Load the CLI package's declarations so your editor recognizes build options, `maligator:` imports, and runtime globals. Maligator strips erasable TypeScript; it does not type-check your application during a build.

## Load the declarations

```shell
npm install --save-dev @maligator/cli@alpha typescript
```

Include the build file in your TypeScript project, or explicitly load the package types:

```json tsconfig.json
{
	"compilerOptions": {
		"target": "ESNext",
		"module": "NodeNext",
		"strict": true,
		"noEmit": true,
		"allowImportingTsExtensions": true,
		"erasableSyntaxOnly": true,
		"types": ["@maligator/cli"]
	},
	"include": ["src/**/*.ts", "maligator.build.ts"]
}
```

An alternative for a project that manages types through declarations is `/// <reference types="@maligator/cli" />` in a `.d.ts` file. If you already set `compilerOptions.types`, add the package to that list; an explicit list restricts automatic type loading.

## Use ES modules

For the `.ts` examples in these guides, set the project package format:

```shell
npm pkg set type=module
```

Run `npm init --yes` first if the project has no `package.json`. Maligator follows the nearest package's `"type"` for `.js` and `.ts` files. Use `"module"` for imports, exports, and top-level `await`; `.mjs` and `.mts` select ES modules by extension. `.cjs` and `.cts` select CommonJS.

## Use erasable syntax

Write type annotations, interfaces, type aliases, and `import type` statements. Use `.ts` extensions for local TypeScript imports. Avoid syntax that needs runtime generation, including TypeScript enums and constructor parameter properties.

```typescript
import { createPool, createWorkerUrl } from "maligator:workers";
import type { TaskContext } from "maligator:workers";
```

Run `npx tsc --noEmit` independently of `maligator run`. TypeScript catches type errors; Maligator checks compilation and runtime availability.

## Enable the required runtime surface

Types for `Mal.serve` and `node:` modules do not enable those APIs. Set `surface.webPlatform` for Web APIs and `Mal`, or `surface.node` for supported Node modules. The lowercase `mal` namespace uses `surface.maligator`, which defaults to enabled.

The [build reference](/api/build#surface) lists the defaults. [Compatibility](/compatibility) lists supported standard APIs. If an import is unknown to the editor, first check type loading; if it fails at build time, check the module and surface support.

Continue with [Configure a build](/guides/build-configuration) or the [worker guide](/guides/workers).
