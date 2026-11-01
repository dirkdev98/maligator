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

A function is exported only when every parameter and its result map. Functions that take or return other pointers, callbacks, or variadic arguments are not exported until the contract describes them.

## Describe resources

A pointer the library allocates, or a struct that owns memory, needs to be released. Give its type a `handle` fact that names the function that releases it:

```typescript native/raylib.ffi.ts
import { defineLibrary } from "@maligator/cli";

export default defineLibrary({
	headers: ["raylib.h"],
	find: [{ pkgConfig: "raylib" }],
	types: {
		Image: { handle: { destroy: "UnloadImage", collect: true } },
		Texture: { handle: { destroy: "UnloadTexture" } },
	},
	functions: { GetFontDefault: { returns: { borrowed: true } } },
});
```

Functions that take or return the type then bind, and its values cross as handles. A handle that wraps a struct exposes the struct's value fields as read-only properties, and a function that takes a pointer to the struct updates the handle in place.

```typescript src/index.ts
import {
	BLUE,
	ExportImage,
	GenImageColor,
	ImageDrawRectangle,
	RAYWHITE,
} from "maligator:ffi/raylib";

using image = GenImageColor(64, 32, RAYWHITE);
ImageDrawRectangle(image, 8, 8, 16, 16, BLUE);
ExportImage(image, `image-${image.width}x${image.height}.png`);
```

Leaving a `using` scope or calling `[Symbol.dispose]()` releases the resource through `destroy`, and calling the destroy function yourself also closes the handle. A closed handle throws a `TypeError` instead of reaching C, and closing a handle while a C call uses it, from a callback or a getter, throws one too.

A function name in `destroy` asserts that cleanup always releases the resource,
regardless of its return status. For cleanup that can fail while keeping the resource
alive, state its successful return code:

```ts
types: {
	sqlite3: {
		handle: { destroy: { function: "sqlite3_close", success: "SQLITE_OK" } },
	},
	sqlite3_stmt: { handle: { destroy: "sqlite3_finalize" } },
}
```

[`sqlite3_close`](https://www.sqlite.org/c3ref/close.html) leaves a busy database
open, while [`sqlite3_finalize`](https://www.sqlite.org/c3ref/finalize.html) releases
a statement even when returning an error. A conditional destroy binding preserves
the C status and closes the handle only when it equals `success`, a known C integer
constant or integer literal. Failed `[Symbol.dispose]()` throws an `Error` and leaves
the handle open for retry. Cleanup callbacks cannot use or recursively close the
handle while its release is in progress. Conditional cleanup requires explicit
disposal, so it cannot use `collect: true`.

- `borrowed` marks a result the library keeps owning. Closing it does not release it.
- A `handle` without `destroy` describes a pointer the library owns, such as the `sqlite3_context` SQLite lends to callbacks, unless `storage: "caller"` provides its outer storage.
- `collect: true` releases a handle the program drops once it is garbage collected. Leave it off for resources that must be released on one thread or before the library shuts down, such as raylib's GPU textures.
- `nullable` on a parameter accepts `null` for a string or handle pointer and passes `NULL`.

When a library accepts the same allocation through another pointer type, declare directed
`views`. For example, libuv accepts a timer pointer as a general handle pointer:

```ts
types: {
	uv_handle_t: { handle: {} },
	uv_timer_t: { handle: { storage: "caller", views: ["uv_handle_t"] } },
},
```

A view asserts that the pointer needs no adjustment. Both types need pointer handle
facts; copied struct values cannot declare views. Compatibility follows transitive views,
and the reverse conversion requires C to return or lend that more specific pointer type.
Returned pointers and callback arguments share one JavaScript identity across views,
including when C exposes the general type first. Views share pins, callback scope, and
closed state. Observing another view preserves the destructor policy established when
ownership was acquired. The object's original prototype and display tag stay unchanged.
Caller allocations keep explicit C cleanup through views; a library destroy binding
cannot take ownership of their outer storage.

Some APIs fill a state struct allocated by their caller. For a complete, fixed-size
struct, `storage: "caller"` exports a zero-argument factory named by the type fact:

```ts
types: {
	CodecState: { handle: { storage: "caller" } },
}
```

`CodecState()` returns a handle to aligned, zeroed C storage. It passes by pointer
and keeps its address between calls. The factory result exposes scalar fields as
read-only properties. Initialization and cleanup are separate C calls, with the same
preconditions the library documents:

```ts
using state = CodecState();
if (codec_init(state) !== 0) throw new Error("Codec initialization failed");
try {
	codec_run(state);
} finally {
	codec_cleanup(state);
}
```

Disposing or collecting the handle frees its outer storage. This does not call C
cleanup, so `destroy` and `collect: true` cannot accompany caller storage. Retain the
handle while C retains its pointer, and dispose it only after C stops using it.
The wrapper also releases callbacks keyed by that storage; calls already queued can
finish from their copied arguments.
Asynchronous close needs the library's completion and lifetime contract.

For state such as zlib's `z_stream`, describe each retained byte pointer and its count:

```ts
types: {
	z_stream: {
		handle: { storage: "caller" },
		fields: {
			next_in: { bytes: { length: "avail_in", writable: false } },
			next_out: { bytes: { length: "avail_out", writable: true } },
		},
	},
},
```

Assign an `ArrayBuffer`, view, or `null` to `stream.next_in` or `stream.next_out`.
Assignment sets the pointer and byte count together; a subview supplies a shorter range.
The handle retains and pins the backing buffer until replacement, clearing, or disposal.
Failed assignment preserves the previous range. Shared and detached buffers are refused;
writable ranges also refuse immutable buffers. `writable` defaults to true for a
non-const pointee, and `false` describes input bytes even when a header omits `const`.

The pointer getter returns a `Uint8Array` over the remaining bytes, following C's cursor.
Count properties remain read-only. C must keep the pointer and count inside the assigned
range; invalid pairs throw before another C entry and after the call that produced them.
While a C operation uses managed state, reading or writing fields, disposal, and
overlapping calls through any view are refused. Keep the factory result for property
access: C function signatures expose opaque pointer handles, whose canonical object may
have originated through another view.

Zlib's header exposes `deflateInit_` with version and ABI-size parameters. Fixed facts
let generated C supply both while JavaScript supplies the stream and compression level:

```ts
functions: {
	deflateInit_: {
		params: {
			version: { constant: "ZLIB_VERSION" },
			stream_size: { sizeof: "z_stream" },
		},
	},
},
```

## Describe pointers

Other pointers need a fact about what they carry. Facts go on a function's `params`, keyed by C name or by 1-based position, or on its `returns`:

```typescript native/raylib.ffi.ts
functions: {
	GetCodepoint: { params: { codepointSize: { out: true } } },
	UpdateCamera: { params: { camera: { inout: true } } },
	DrawTriangleStrip: { params: { points: { array: { length: "pointCount" } } } },
	LoadFileData: { returns: { bytes: { length: "dataSize" }, free: "UnloadFileData" } },
	LoadFileText: { returns: { string: true, free: "UnloadFileText" } },
},
```

- `out` marks a pointer the function writes through, and `inout` also passes the current value in. A function with outputs returns an object with each output and the C result as `result`, so `GetCodepoint("✓")` returns `{ result: 10003, codepointSize: 3 }`. A status code stays in `result`; the binding does not throw for it.
- `bytes` passes an `ArrayBuffer` or a view without copying, and `array` copies a JavaScript array into C memory for the call. `length` names the parameter that carries the count, which disappears from the JavaScript signature. When it names a pointer to the count, as `compress` in zlib takes `destLen`, the function receives the buffer's size, and the count it writes there returns as an output. Shared buffers are rejected, as are immutable buffers where C may write. While C uses a buffer, transferring or resizing it, including from a callback, throws a `TypeError`.
- On a result, `bytes` and `array` copy the C memory into a `Uint8Array` or an array. `length` names an integer parameter, or a pointer the function writes the count through.
- `string` marks a `char *` or `unsigned char *` as UTF-8 text.
- `free` names the function that releases a string, buffer, or array result after it is copied.

Use `string: { length: "byteCount" }` for UTF-8 pointer/count pairs. The count
measures encoded bytes and disappears from input signatures. Counted text permits
embedded NUL bytes; `string: true` remains NUL-terminated and rejects them on input.

```ts
functions: {
	copy_text: {
		params: { text: { string: { length: "length" } } },
		returns: { string: { length: "written" }, free: "text_free" },
	},
}
```

A result's length comes from an integer parameter or a count the function writes
through a pointer. Results copy exactly that many UTF-8 bytes, preserving NULs and
replacing invalid sequences. Negative or excessive lengths throw before reading
the buffer; `free` still releases an owned result when conversion fails. The fact
must describe the C buffer's actual allocation.

Counted text works with ordinary functions, async twins, and callbacks on the VM
thread. In `callback.params`, `length` names the count's 1-based parameter position.
Callback text is copied before entering JavaScript, so it remains valid after the
C callback returns. Counted text cannot accompany `bytes` or `array`; queued
callbacks, out parameters, and inout parameters reject counted strings.
With `nullable: true`, a null input passes `NULL` and a zero count; an empty string
passes a non-null pointer and a zero count.

Array inputs convert in index order. A conversion error prevents later elements'
getters and Proxy traps from running.

- `constant` passes a C macro, enumerator, or integer for a parameter, such as `SQLITE_TRANSIENT` for a destructor or `0` for a reserved argument. The parameter disappears from the JavaScript signature, and the C compiler checks the value's type.
- `sizeof` passes the C compiler's size of a complete struct or union, omitting the integer parameter from JavaScript. Compilation fails if its size does not fit the parameter.

Each fact names the C declaration it describes. A fact that names nothing in the headers, or that does not fit the declaration, fails the build.

## Pass callbacks

A `callback` fact passes a JavaScript function where the library takes a function pointer. `data` names the `void *` parameter the library hands back to the callback; it disappears from the JavaScript signature:

```typescript native/sqlite.ffi.ts
functions: {
	sqlite3_create_collation_v2: {
		params: {
			xCompare: {
				callback: {
					data: "pArg",
					release: "xDestroy",
					params: { 3: { bytes: { length: "2" } }, 5: { bytes: { length: "4" } } },
				},
			},
		},
	},
},
```

Without `release`, the library may call the function only until the C function returns, as iteration and comparison functions do. An exception in the callback skips its remaining calls and rethrows when the C function returns. Such a callback binds without `data` too, as `qsort`'s comparator does: `callback: {}`.

`release` names the `void (*)(void *)` parameter that takes the destructor for `data`, for a library that keeps the callback, such as SQLite's `xDestroy`. The library may call the function until it calls the destructor, and an exception rethrows from the library call that triggered it.

`replaced: true` describes a setter that keeps its callback until its next call replaces it, such as GLFW's `glfwSetKeyCallback` or SQLite's `sqlite3_update_hook`. `data` is then optional:

```typescript native/glfw.ffi.ts
functions: {
	glfwSetKeyCallback: { params: { callback: { callback: { replaced: true }, nullable: true } } },
},
```

When the setter's first parameter is a handle, each handle keeps its own callback until its resource is destroyed. Without `data`, the callback must receive that handle, as GLFW's window callbacks do. With `nullable`, `null` removes the callback. A result that is the replaced callback, or with `data` its user data, is dropped.

`lookup` names the function that returns `data` for a callback without a `void *` parameter, and the 1-based position of the callback parameter it takes. SQLite's user functions read it with `sqlite3_user_data` from their `sqlite3_context *`:

```typescript native/sqlite.ffi.ts
sqlite3_create_function_v2: {
	params: {
		xFunc: {
			callback: {
				data: "pApp",
				release: "xDestroy",
				lookup: { function: "sqlite3_user_data", param: "1" },
				params: { 3: { array: { length: "2" } } },
			},
		},
		xStep: { constant: "0" },
		xFinal: { constant: "0" },
	},
},
```

Handles a callback receives are lent for that call: once it returns they read as closed, unless the program already held a handle for the same resource. A callback's own `params`, keyed by 1-based position, take `string`, `bytes`, `array`, and `nullable` facts. A `length` names another callback parameter, which the function does not receive, so the collation above receives two `Uint8Array` copies.

JavaScript runs on one thread, so a library that calls back from another thread aborts the program, unless the callback is `queued`. A destructor may run on any thread; the release completes on the program's thread.

`queued: true` marks a kept callback the library may call from its own threads, as audio and network libraries do. A call from another thread copies its arguments and queues for the program's thread, and the C caller continues at once; a call on the program's thread runs immediately. So the callback returns nothing, and takes values, strings, buffers, and structs. An exception it throws is uncaught, as one in an event handler. The program needs an event loop, such as the web platform surface, and it keeps running while the callback is kept.

## Call variadic functions

A variadic function such as `TraceLog(int logLevel, const char *text, ...)` binds through variants. Each variant fixes the C types of the arguments after the fixed ones and becomes its own export, with those arguments named by position:

```typescript native/raylib.ffi.ts
functions: {
	TraceLog: {
		variants: {
			TraceLogNumber: { args: ["double"] },
			TraceLogText: { args: ["const char *"] },
		},
	},
},
```

`TraceLogText(LOG_INFO, "loaded %s", name)` then calls `TraceLog` with a string as its third argument. The C compiler applies the usual argument promotions. A variant's `params` adds facts for its arguments, keyed by `arg<position>` or by position. The variadic function itself is not exported. The function reads the arguments by the types its other arguments announce, such as a format string, so a mismatch is undefined behavior in C. Pass fixed formats from a wrapper rather than text a user controls.

## Run blocking calls on a worker

`async` exports a function a second time, under a new name, as one that runs the C call on a worker thread and returns a promise of its result. A slow call, such as a database query or an image decode, then leaves the event loop free:

```typescript native/sqlite.ffi.ts
functions: {
	sqlite3_step: { async: "sqlite3_step_async" },
},
```

The arguments convert before the call starts, and a conversion error rejects the promise. Buffers and handles the call uses stay pinned until the promise settles: transferring or resizing such a buffer, or closing such a handle, throws. JavaScript can still write the buffer's bytes in the meantime, so leave them alone until then. A handle a callback lends is refused, since the call outlives the callback. The result converts when the promise settles, so a call that changes what a pointer result points to must wait until then. An async export takes no callbacks, copies array arguments, and the program needs an event loop, such as the web platform surface.

Use `async` only for functions the library allows on another thread while the program makes other calls, such as SQLite in its default serialized mode.

A handle's destroy function can also have an `async` export. The handle rejects other
calls and disposal until destruction finishes. A conditional destroy preserves the
handle when C reports failure, so you can retry. VM teardown joins running destructors
and reconciles their results even when their promises are discarded; a destroy call
cancelled before execution leaves the resource open for its normal cleanup policy.

For a constructor that returns a new resource lifetime, set `returns.fresh` to `true`.
This distinguishes a new allocation from an alias when C reuses the address
of a resource whose worker destruction has not returned. Without this fact, calls
that return the same handle family reject before entering C while its worker close
is pending. Existing aliases keep their shared identity; a fresh resource gets a new
wrapper and its own callbacks.

## Find what cannot bind

```shell
maligator ffi inspect raylib
```

The report lists each function that is not exported and the fact it needs. It also suggests facts from naming and signature conventions: a count parameter beside a pointer, a pointer the function writes, the `void *` a callback receives or the function that returns it, a setter that replaces its callback, a struct with its own release function or an opaque one nothing releases, a getter's result as borrowed, a result whose documentation says how to free it. Each suggestion is checked against the headers and listed only when it makes a function bind, but it comes from names rather than the library's documentation, so review it before adding it to the contract.

`--json` includes the structured C model and the accepted `facts`, alongside mapped
signatures, header documentation, missing facts and suggestions in contract shape.
The model retains unresolved record fields and typedef chains, including transitive
system types, so a tool can follow a pointer's type before proposing a fact. Its
declaration tables are arrays, and exact C integer values are decimal strings.

## Check a library upgrade

C declarations can change without changing their TypeScript types. For example,
`short` and `int` both map to `number`, but accept different ranges. Record fields,
pointer qualifiers and accepted ownership facts can change too.

After reviewing a contract against the installed headers, record its declarations:

```shell
maligator ffi check --update
```

Commit `maligator-ffi.lock.json` with the contract. Fixed argument and cleanup status
facts also watch macros and enums in the declared library headers, including macro
aliases that have no JavaScript export. Add supporting headers to `headers` when
their macros belong to the contract. Run `maligator ffi check` in CI to report changes
before accepting a library upgrade. The command reads the headers and facts and exits
with status 1 if they differ or have no accepted snapshot. Review
the changes, update the facts if needed, then run `--update` again.

Ownership rules can change while the C signature stays the same. Cite the header
documentation that supports a type or function fact so the check watches its text:

```typescript
functions: {
  shapes_name: {
    returns: { free: "shapes_release" },
    evidence: [{ kind: "function", name: "shapes_release" }],
  },
},
```

The `kind` can be `function`, `typedef`, `struct`, `union`, `enum` or `macro`.
The check includes documentation on parameters, fields and enumerators of the cited
declaration. Uncited comments do not affect it. A citation must resolve to extracted
documentation; removing the declaration or its documentation prevents an update.
Reviewing the text and the library's behavior remains the contract author's job.

Write [Maligator tests](/guides/testing) that exercise the facts, such as releasing
an owned resource or copying a counted buffer. Run them as a sanitizer probe before
accepting an upgrade:

```shell
maligator ffi check raylib --probe tests/raylib.test.ts --update
```

The probe uses UBSan on macOS and ASan+UBSan elsewhere. Its test output and source
identities are retained under `.cache/ffi-check/`. A failed or skipped-only probe,
a changed input or an edited lockfile prevents acceptance. `--probe-timeout` sets the
child process deadline in milliseconds, including time spent inside C; it defaults
to 30000. Probes run on the host. Prebuilt libraries need an instrumented build for
sanitizer coverage inside their code.

Use `--target rust-triple` to check or accept headers for a cross-build target. Each
target has its own snapshots, and `ffi check raylib --update` updates only raylib for
the selected target. Header snapshots and probes provide evidence for reviewing a
contract; they do not establish the linked binary's ABI or every ownership rule.

`maligator test` builds a test runtime with the bindings too. Note that `test --watch` does not support C libraries, and portable wire output rejects them.
