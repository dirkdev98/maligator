Declare the files an application ships with in its source, with `maligator:assets`. `maligator build` embeds them in the executable; `run`, `dev` and `test` read them from disk, so edits show up without a rebuild.

## Embed a file and a directory

```typescript src/index.ts
import { embedDirectory, embedFile } from "maligator:assets";

const message = embedFile("../message.txt");
const templates = embedDirectory("../templates", { include: ["**/*.html"] });

console.log(message.text().trim());
for (const file of templates.files()) console.log(file.path, file.size, file.type);
console.log(templates.get("home.html")?.text());
```

Create `message.txt` containing `hello` and `templates/home.html` next to `src`, then run:

```shell
maligator run src/index.ts
application=$(maligator build --production src/index.ts)
"$application"
```

The development run and the built executable print the message, the template list and the home page. The built executable keeps working after you delete the source files because it carries embedded copies.

Specifiers resolve like imports from the declaring module. A relative or absolute specifier names a path; a package specifier such as `ui-kit/dist` names a path inside that package. [Module aliases](/api/build#MaligatorBuildConfig) apply too, which suits a file a build step writes to a location the config chooses.

## Write declarations the build can see

`embedFile` and `embedDirectory` take a string literal specifier and literal options. The compiler replaces each call with its handle, so a declaration can't come from a variable, a wrapper function or a re-export. Repeated declarations of the same file, with the same options, share one handle.

`maligator build` embeds only the declarations the program can still reach after optimization. A declaration in an unused function or behind a branch the build removes adds nothing to the executable and may name a file that doesn't exist.

## Choose directory members

`include` and `exclude` take patterns relative to the directory, with `*` and `?` inside one path segment and `**` for any number of segments. Without `include`, every file belongs to the directory. Wildcards skip names that start with a dot unless you pass `dot: true`; a pattern segment that spells the dot, such as `.well-known/*`, still matches.

```typescript src/migrations.ts
import { embedDirectory } from "maligator:assets";

const migrations = embedDirectory("../migrations", { include: ["*.sql"] });
for (const file of migrations.files()) console.log(file.path);
```

`files()` lists members in code point order of their paths. In a build, each `include` pattern must match a file and every member must be a regular file; symbolic links fail the build.

## Produce files with a build step

A frontend built by a tool such as Vite declares how its files come about next to where they are embedded:

```typescript src/frontend.ts
import { embedDirectory } from "maligator:assets";

export const frontend = embedDirectory("../web/dist", {
	build: { command: ["npm", "run", "build"], cwd: "../web" },
	watch: {
		command: ["npm", "run", "dev", "--", "--port", "5173", "--strictPort"],
		cwd: "../web",
		url: "http://127.0.0.1:5173",
	},
});
```

`build` runs a command to completion before the files are read: before `maligator build` embeds them and before `run` starts the application. `watch` starts a long-running command, waits until its `url` answers, and keeps it running for the whole command: across every generation of `dev` and every rerun of `test --watch`. Commands run without a shell, from `cwd` resolved against the declaring module, and stop with Maligator.

By default `build` and `run` use the build command, `test` uses the files that already exist and `dev` uses the watcher, or the build command when there is none. Choose per command with `use`:

```typescript src/frontend.ts
import { embedDirectory } from "maligator:assets";

export const frontend = embedDirectory("../web/dist", {
	build: { command: ["npm", "run", "build"], cwd: "../web" },
	watch: { command: ["npm", "run", "dev"], cwd: "../web", url: "http://127.0.0.1:5173" },
	use: { run: "watch", test: "build" },
});
```

`existing` runs nothing, which suits a CI job that built the frontend in an earlier step. Commands only run for declarations the command reaches, and only the project's own modules may declare them; packages in `node_modules` embed what they ship. A built executable never contains the commands.

## Read contents or a path

A file handle has `path`, `size`, `digest` (hexadecimal SHA-256) and `type` (the media type of its extension). `bytes()` returns a `Uint8Array` over an immutable buffer, `text()` decodes UTF-8 without a byte order mark and `json()` parses the text.

Use `materialize()` when a library needs a filesystem path, such as a template engine or a C library loading a font. A built executable writes the embedded copy once per content identity below the OS temporary directory, or below `baseDirectory` when you pass one, and returns that path. Other commands return the source path itself. Treat the path as read-only either way.

```typescript src/fonts.ts
import { embedDirectory } from "maligator:assets";

const fonts = embedDirectory("../fonts");
console.log(fonts.materialize({ baseDirectory: "/var/lib/my-app" }));
```

## Import contents instead

When the program needs a file's contents as a value, import it with the standard attribute syntax. The build inlines the value and recompiles when the file changes:

```typescript src/index.ts
import logo from "./logo.png" with { type: "bytes" };
import message from "./message.txt" with { type: "text" };
import settings from "./settings.json" with { type: "json" };

console.log(message.trim(), logo.length, settings);
```

A `text` import is the file decoded as UTF-8, without a byte order mark. A `bytes` import is a `Uint8Array` over an immutable `ArrayBuffer`.

Treat embedded files as application inputs. Use a separate location for data that must survive rebuilding or replacement. Portable `--serialize` output and the Wasm reactor cannot embed assets. See [the API reference](/api/assets) for every handle member.
