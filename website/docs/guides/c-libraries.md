Call a C library from your application by declaring it in the build config. Maligator reads the library's headers with clang and compiles a binding into the application, so the C compiler handles calling conventions, structs passed by value, and macros. You need the library's headers, clang (or Zig for a `--target` build), and the library itself as an archive, a shared library, or sources.

## Declare the library

Name the library under `ffi` and point it at a contract:

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	ffi: { raylib: { contract: "native/raylib.ffi.ts" } },
});
```

The contract holds what is true of the library wherever it is installed: the headers to bind and how to find it.

```typescript native/raylib.ffi.ts
import { defineLibrary } from "@maligator/cli";

export default defineLibrary({
	headers: ["raylib.h"],
	find: [
		{
			pkgConfig: "raylib",
			frameworks: ["Cocoa", "IOKit", "OpenGL", "QuartzCore", "CoreVideo"],
		},
	],
});
```

Spell headers the way C code includes them, such as `curl/curl.h`. Each `find` entry names a pkg-config package, `libraries` to link from `libraryDirs`, or `sources` to compile into the application, plus `includeDirs`, `defines`, and `frameworks` as needed. The build uses the first entry that works on the machine. Paths in a contract resolve from the contract's directory.

A `find` in the build config replaces the contract's entries on one machine, and `link` chooses between `"static"` and `"shared"`. Without `link`, the build links statically when every library has an archive.

Note that a static archive does not carry its own dependencies. The build adds the private libraries pkg-config lists; name any others in `libraries` or `frameworks`, as the raylib contract does for macOS.

## Call it

Import from `maligator:ffi/<name>`. Exports keep their C names.

```typescript src/index.ts
import {
	BeginDrawing,
	ClearBackground,
	CloseWindow,
	DrawCircleV,
	EndDrawing,
	GetMousePosition,
	InitWindow,
	MAROON,
	RAYWHITE,
	WindowShouldClose,
} from "maligator:ffi/raylib";

InitWindow(800, 450, "Hello from Maligator");
while (!WindowShouldClose()) {
	BeginDrawing();
	ClearBackground(RAYWHITE);
	DrawCircleV(GetMousePosition(), 40, MAROON);
	EndDrawing();
}
CloseWindow();
```

Generate declarations so the editor and `tsc` resolve the import, and include the file in your TypeScript project:

```shell
maligator ffi types
```

`maligator run`, `dev`, and `build` compile the binding and link the library. `run` and `dev` build a development runtime that contains the binding instead of using a packaged one, so they need the native toolchain.

## How values cross

Conversions never coerce. A value of the wrong type throws a `TypeError`, and a number that is not an integer or does not fit throws a `RangeError`. Both name the C function and parameter.

- Integers up to 32 bits are numbers. 64-bit integers are bigints.
- `float` and `double` are numbers, `bool` is a boolean, and enums are numbers.
- A `const char *` parameter takes a string, passed as UTF-8 for the duration of the call. A string with a NUL character throws.
- A `const char *` result is copied into a string. `NULL` becomes `null`.
- A struct whose fields are all values passes as a plain object, copied in each direction.
- Enum members and macros are constants when their type maps, including struct literals such as raylib's `RAYWHITE`.

A function is exported only when every parameter and its result map. Functions that take or return other pointers, callbacks, or variadic arguments are not exported.

## Find what cannot bind

```shell
maligator ffi inspect raylib
```

The report lists each function that is not exported and the fact it needs. `--json` prints every declaration with its C and TypeScript forms, its header documentation, and the missing facts, for tools that propose facts.

Note that `maligator test` does not support C libraries, and portable wire output rejects them.
