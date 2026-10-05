Capture files into the application image and obtain a filesystem path when the application runs. Enable `surface.node` in these examples to read the materialized files; `surface.maligator` must also remain enabled.

## Include a file and a directory

Create `message.txt` containing `hello`, and `templates/home.html` containing your HTML:

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	surface: { node: true },
	assets: {
		message: { type: "file", path: "message.txt" },
		templates: {
			type: "directory",
			path: "templates",
			include: ["**/*.html"],
		},
	},
});
```

Paths resolve from the project root. Capture includes configured assets even if the application never reads them. Only regular files are accepted; symlinks and special files fail the build. Patterns support `*`, `?`, and a whole-segment `**`. Every include pattern must match at least one file.

## Read a materialized resource

```typescript src/index.ts
import { readFileSync } from "node:fs";

const message = mal.assets.materialize("message");
const templates = mal.assets.materialize("templates");
console.log(readFileSync(message, "utf8").trim());
console.log(readFileSync(`${templates}/home.html`, "utf8"));
```

```shell
maligator run
maligator build --production
```

The application prints the captured message and HTML. Editing the original file after building does not change an existing executable. Rebuild to capture new content.

[materialize](/api/runtime#mal.assets.materialize) returns an absolute file or directory path. It writes atomically beneath the OS temporary directory by default and reuses completed materializations by content identity. Pass `{ baseDirectory: "/chosen/parent" }` when your host needs another location; ensure that parent is writable.

Treat captured resources as application inputs. Use a separate location for data that must survive rebuilding or replacement. Filesystem assets are supported in native executables and development execution, but cannot be included in portable `--serialize` output.

If a pattern fails, inspect its directory and spelling before widening it. An unknown asset name or a materialization filesystem failure throws synchronously. See [AssetInclusion](/api/build#AssetInclusion) and [materialization options](/api/runtime#MaligatorMaterializeOptions).
