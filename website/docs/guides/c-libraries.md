Call a C library from your application by declaring it in the build config. Maligator reads the library's headers with clang and compiles a binding into the application, so the C compiler handles calling conventions, structs passed by value, and macros. You need the library's headers, clang (or Zig for a `--target` build), and the library itself as an archive, a shared library, or sources.

Maligator hosts the application. Embedding the Maligator runtime in a C application is
outside the supported API.

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

Production builds with a closed module graph generate wrappers for the exports the
application and its workers use. Namespace access retains its observable exports.
Declaration generation and inspection describe the full header surface; development
runtimes retain it for later application edits.

## How values cross

Conversions never coerce. A value of the wrong type throws a `TypeError`, and a number that is not an integer or does not fit throws a `RangeError`. Both name the C function and parameter.

- Integers up to 32 bits are numbers. Wider integers through 64 bits are bigints.
- `float` and `double` are numbers, `bool` is a boolean, and enums use their
  compiler-compatible integer type.
- A `const char *` parameter takes a string, passed as UTF-8 for the duration of the call. A string with a NUL character throws.
- A `const char *` result is copied into a string. `NULL` becomes `null`.
- A struct whose fields are all values passes as a plain object, copied in each direction.
- Anonymous struct members keep C's promoted field names. Named fields with anonymous
  struct types remain nested objects, including elements of fixed arrays.
- Named bit-fields use their declared widths for range checks. Padding fields stay hidden;
  the C compiler owns layout and packing.
- Enum members and macros are constants when their type maps, including struct literals such as raylib's `RAYWHITE`.

A function is exported only when every parameter and its result map. Functions that take or return other pointers, callbacks, or variadic arguments are not exported until the contract describes them.

For arithmetic typedefs that need their C precision, use a native representation:

```ts
types: {
    Wide: { representation: "native" },
    Precise: { representation: "native" },
}
```

Each type exports an opaque value box and a factory, such as `Wide()`, that creates
C arithmetic zero. C functions, constants, globals, records, and arrays retain the
opted typedef instead of converting it to a JavaScript scalar. Use C functions to
inspect or compute with these values. This preserves native arithmetic precision,
including complex components, fixed vector lanes, and bit-precise integer widths.
Clang supplies storage size and alignment, including vector padding and explicit
typedef alignment; `ffi check` tracks these ABI properties.

Arguments become independent native copies before calls or worker dispatch, so the
source box can be disposed afterward. Callback arguments also remain valid after
the invocation. Disposal releases a box's copied storage. The typedef definition
must be unqualified arithmetic; const-qualified aliases need a C value interface.

Plain records and copied struct handles can contain const members when returned by C
or passed to a JavaScript callback. Both also pass back to C by value, including on
workers. Input conversion reads properties before initializing the native value;
later JavaScript mutations do not change a queued worker's copy. A record output buffer can
contain const members when C initializes every selected field before returning. An
inout value is constructed before the call; C may update its mutable fields. Counted
arrays of const records also use initialized copies, including on workers. Fixed
numeric and record array buffers keep their declared bounds and nested dimensions.
Selected union members also use native initialization, including const scalars,
records, and fixed arrays. A const discriminator can share storage with an identical
integer member or a matching struct prefix. The selected payload initializes that
storage; its nested discriminator must match the outer JavaScript tag. Empty cases
initialize the tag directly. Incompatible types, offsets, and bit-field widths remain
unbound. JavaScript callbacks can return these values synchronously or through waiting
worker calls.
Failed or canceled callbacks return a zero native value while the JavaScript error
propagates to its caller.

Repeated string inputs can retain a UTF-8 encoding alongside their JavaScript
storage, avoiding encoding work on later synchronous calls. ASCII inputs can instead
grow their existing backing to add a NUL terminator. Preparation increases retained
memory and can cost more than copying for short reuse sequences. Mutable inputs,
callbacks, and asynchronous calls use private input copies.

## Read and write globals

Name the accessor exports in the contract:

```typescript
globals: {
  library_mode: { get: "getMode", set: "setMode" },
  library_title: { get: "getTitle", value: { string: true } },
  library_context: { get: "getContext", value: { borrowed: true } },
  library_label: { get: "getLabel", set: "setLabel", value: { string: true } },
  library_key: { get: "getKey", set: "setKey", value: { bytes: true } },
}
```

Import and call these functions like other FFI exports. A getter reads the current C
object; a setter converts its argument completely before assigning. Value records
and integers use the same mappings as function arguments and results.

Staged records and arrays keep their C type's alignment, including worker copies
and callback messages. Headers can require stronger alignment than the platform
default without a separate contract fact.

Fixed arrays of values map to JavaScript tuples, including nested arrays. Reads
copy the C array before constructing the result. Writes stage the entire converted
array before changing C storage, so a throwing element getter leaves it unchanged.

Use `value.string: true` for a fixed byte array holding UTF-8 text. Reads require a
NUL within the declared bound. Writes reject embedded NULs and require room for the
encoded bytes and terminator, then zero-fill the remaining capacity.

Use `value.bytes: true` for a fixed byte array holding arbitrary data. A getter returns
a fresh `Uint8Array`; a setter accepts an `ArrayBuffer` or view with exactly the declared
byte length. Conversion failures leave C storage unchanged. These formats apply to
one-dimensional byte arrays, and the same `value` facts describe both accessors.

Access requires an externally linked object. Const objects have no setter. Setters
accept assignable values. Getter results cannot transfer ownership: strings are copied
and handles require `borrowed: true`.

For a pointer C retains, declare when its previous allocation stops being used:

```typescript
globals: {
  library_title: {
    get: "getTitle", set: "setTitle",
    value: { string: true, lifetime: "replacement" },
  },
  library_data: {
    get: "getData", set: "setData",
    value: { bytes: { length: "library_size" }, lifetime: "replacement" },
  },
}
```

`replacement` asserts that C stops retaining the old allocation before the setter
replaces or clears it. Setters stage an independent native copy before publishing the
pointer and count. The copy survives worker teardown and source-buffer detachment.
`null` clears the pointer and byte count; empty values keep a nonnull pointer. Getters
return snapshots. Initial C-owned storage remains owned by C.

C may advance a managed pointer or shorten its byte count within the assigned range.
Getters reject a pointer or count outside that allocation. The count must be a writable
external integer used only by this pointer, with no independent setter. Retained pointers
and their counts cannot be thread-local. Coordinate C readers and mutations using the
library's synchronization contract; the binding only serializes its own accessors.

Accessors run on the calling thread, including for thread-local objects. The C
library's synchronization rules still apply to globals shared between threads.

## Select a union value

A union needs a `shape` fact identifying its active member. Its JavaScript value is
that member's value: selecting an integer produces a number, while selecting a struct
produces an object. Other members stay hidden.

```typescript
types: { Scalar: { shape: { member: "integer" } } },
functions: {
  read_real: { returns: { shape: { member: "real" } } },
}
```

The type fact sets the default. A parameter or result can override it; on counted
arrays, the shape selects each element's union member. Callback parameters and results
accept the same shape fact. A value result needs no pointer lifetime.

For a discriminator stored beside the union, map each tag to its active C member
paths. Paths follow named fields and C's anonymous member promotion. A named union
field holds the selected member's value in JavaScript.

```typescript
types: {
  Event: {
    shape: {
      tag: "kind",
      cases: {
        EVENT_INTEGER: ["payload.integer"],
        EVENT_POINT: ["payload.point"],
        EVENT_DONE: [],
      },
    },
  },
}
```

The generated TypeScript type narrows by `kind`. Case keys are known integer constants
or decimal integers within the tag's range. Tags wider than 32 bits use BigInt.
Input conversion reads the tag once before payload getters; unknown tags throw before
reading payload fields. An empty selection hides union storage. Root unions also keep
the selected member name, and payload writes must preserve their discriminator.

Handles nested in callback arguments are loans that close when the callback returns.
Resource-bearing values require waiting callbacks when C calls from another thread.
Compound callback results containing handles need a pointer result interface with an
explicit lifetime. Describe borrowed resource fields on their owning handle.

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

Pass that pointer parameter directly for resource updates, preserving the handle's
storage and owner. An `inout` fact would create a separate result and is rejected for
copied struct handles.

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

If a callback throws or a worker result is discarded, cleanup preserves pointer
resources already known to that VM. Direct return and out-parameter aliases release
new storage once. Failed handle construction releases its undelivered C resource
even when automatic collection is disabled. Fresh-result facts distinguish recycled
storage from a resource whose destruction is still pending.

For a resource pointer inside a result handle, declare whether the containing resource
owns its lifetime or the library keeps it alive:

```ts
types: {
	Document: {
		handle: { destroy: "document_free", collect: true },
		fields: { root: { handle: { lifetime: "owner" } } },
	},
	Node: {
		handle: {},
		fields: { next: { handle: { lifetime: "owner" } } },
	},
},
```

`document.root` returns a borrowed canonical `Node` handle or `null`. Keeping that child
keeps the document reachable. Closing the document invalidates its children; disposing
a child view only closes that view. When a child type names its own destroy binding,
that binding rejects owner-bound children. Calls and callback-result leases also protect
the owning document. A child field that points at a sibling shares the document's lifetime.
Use `lifetime: "library"` for a borrowed pointer that remains valid independently of
the containing resource for the process's lifetime. Destroy bindings and inferred-owned
aliases reject that resource. Closing or collecting a view preserves the native lifetime
claim, including cleanup after callback failures and VM shutdown.

Owner fields must be reachable from a destructor-backed root through declared owner
fields and use library-owned child storage. Descendants can omit their own destructor.
Read them through an owning field before following their links; a raw borrowed alias
needs a proven owner before its resource fields can be read.
A kept callback leases owner-bound inputs and their destruction roots until C releases
the callback or a replacement retires it. This includes handles inside compound inputs
and an owner-bound callable's captured handle. Disposal and destruction reject while
these leases remain; field reads and saved callables remain available for unregistration.
Unregister nullable callbacks with `null` before closing their resources. The library
must offer release or unregistration independently of root destruction. Children whose
root is a callback loan cannot become registration inputs. Registration results cannot borrow any retained
input root. Native leases also preserve the resources through VM teardown until C
releases the registration. Plain records that transfer independent resource ownership
need a whole-result handle and destructor.

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

For a struct ending in a flexible or zero-length array, name that field with
`trailing`. The factory takes the number of trailing elements as a bigint:

```ts
types: {
	Packet: { handle: { storage: "caller", trailing: "payload" } },
}
```

`Packet(128n)` allocates space for the fixed header and the requested payload elements,
using C's layout and alignment. Counts that overflow allocation size throw a
`RangeError`. The allocation starts zeroed; initialize any length field through the
library's C API. The trailing array stays behind the handle and is not a JavaScript
array property. Initialization, cleanup, aliases, and worker pins follow the same
rules as fixed-size caller storage.

For an opaque, forward-declared struct, provide native layout queries:

```ts
types: {
	OpaqueState: {
		handle: {
			storage: "caller",
			layout: { size: "opaque_state_size", alignment: "opaque_state_alignment" },
		},
	},
}
```

`OpaqueState()` calls both zero-argument queries for each allocation. They must return
unsigned integers up to 64 bits. Invalid sizes, non-power-of-two alignments, and size
rounding overflow throw a `RangeError`. C initialization and cleanup remain explicit.

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

For a UTF-8 field, use `label: { string: { length: "label_length" } }` and assign a
string or `null`. Assignment retains a private counted encoding, including embedded
NUL bytes. The getter returns a string snapshot of C's current pointer/count range;
C writes affect later snapshots without changing the original JavaScript string.
An empty string has a non-null pointer and a zero count. Text follows the same range,
operation, and close-lifetime rules as retained byte fields.

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

## Call returned functions

For a returned C function pointer, assert that its code and referenced state remain
valid for the linked library:

```typescript
functions: {
	choose_transform: {
		returns: { callable: { lifetime: "library" } },
	},
},
```

The result is a JavaScript function, or `null` for a null C pointer. Its arguments and
result follow the header signature and the same conversions as ordinary bindings.
The C compiler preserves the pointer's calling convention. `call`, `apply`, and `bind`
work; construction throws.

Use `callable.params`, keyed by 1-based position, and `callable.returns` to describe
pointers in that signature. For example, `params: { "1": { bytes: { length: "2" } } }`
accepts a buffer and supplies its byte count. Nested function-pointer results need
their own `callable` fact. The lifetime assertion includes state the function uses;
do not use it for a function that depends on a resource the application can close.

For a function table, declare callable fields on its complete handle type:

```typescript
types: {
	PluginApi: {
		handle: { destroy: "plugin_close" },
		fields: { transform: { callable: { lifetime: "owner" } } },
	},
},
```

Reading `api.transform` captures the current pointer and the handle. Saved functions
keep the handle reachable; closing it makes later calls throw before argument
conversion. Calls pin the owner through callbacks and result conversion, so reentrant
disposal throws. If C changes the field, a new read sees the new pointer; an earlier
function retains its snapshot. Explicit C self or user-data parameters remain explicit.
Use `"library"` for a field whose target remains valid independently of the handle.
Callable fields work through handle views, including aliases frozen before C supplies
a more specific view. Each getter checks that C has supplied evidence for its declaring
type before reading the field. Declare each callable property name on one type in the
view family; aliases share one object and cannot select different same-named getters.

Nested results can use `"owner"` to inherit the same captured handle, or `"library"` to
remain valid independently. A library-lifetime function cannot introduce an owner for
its result.

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

Input arrays, byte spans, and counted strings can share an integer `length` parameter.
The binding checks every input length before entering C. Counted strings contribute
their UTF-8 byte length. Shared counts must be integer inputs; writable counts and
output capacities keep separate parameters.

Const arithmetic-pointer inputs also accept the matching typed array. For example,
`const double *` accepts `Float64Array`, and `const uint64_t *` accepts `BigUint64Array`.
Use the generated SDK for the library's exact native widths. Synchronous calls lend
the view's current storage, including its offset, after argument getters finish.
C callbacks can observe JavaScript element writes, while resizing or transferring
the backing buffer is blocked until C returns. C must not retain the pointer.
Async calls snapshot numeric views before scheduling worker execution, so later
JavaScript writes and transfers cannot affect the native input. Ordinary arrays
keep their copy semantics. Mutable pointers and fixed array rows still use copies.

Counted arrays preserve fixed inner dimensions. A parameter such as
`const int (*rows)[3]` with `array: { length: "count" }` takes an array of
three-element tuples; only the outer length supplies `count`. Numeric and record
rows work through synchronous calls, workers, and callbacks. Inputs use
native copies, and C-allocated results copy every row before `free` runs. A `shape`
fact applies to each union leaf through the fixed dimensions.

For fixed character rows, choose a representation in the array fact:
`array: { length: "count", element: { string: true } }` maps `char (*)[N]` to
strings. Each row must contain a NUL within its declared bound; input UTF-8 bytes
must leave room for that terminator. `{ bytes: true }` maps each row to an exactly
sized byte view and returns copied `Uint8Array` values. These formats also apply to
rows within deeper fixed grids, caller output buffers, inout arrays, and callbacks.

For caller-allocated array outputs, name both the written count and a capacity input:

```ts
functions: {
	fill_rows: {
		params: {
			rows: { out: true, array: { length: "written", capacity: "capacity" } },
		},
	},
}
```

The capacity stays in the JavaScript signature. The binding allocates aligned storage
and returns only the prefix C reports through `written`. To return the entire buffer,
use the same integer input for `length` and `capacity`. Inout arrays use their original
JavaScript length as the capacity and return a native snapshot without changing the
input. Invalid capacities and written counts throw a `RangeError`; a zero-capacity
buffer returns an empty array. Caller-owned buffers cannot declare `free` or contain
resource handles without an element ownership contract.

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

Counted text works with ordinary functions, async twins, and callbacks.
In `callback.params`, `length` names the count's 1-based parameter position.
Queued notifications copy exactly that many bytes before the C callback returns;
waiting callbacks borrow the source until JavaScript conversion finishes. Negative
or excessive counts reject before a foreign thread copies the buffer. Counted text
cannot accompany `bytes` or `array`.
With `nullable: true`, a null input passes `NULL` and a zero count; an empty string
passes a non-null pointer and a zero count.

An `out` string names an integer count pointer that C fills. The output object contains
the decoded text and updated count. An `inout` string initializes its count from the
encoded input and decodes the updated pointer/count pair, so C may advance a cursor
within that encoding. Both forms support async twins. Input encodings are borrowed:
C must not free or reallocate them. Use `free` only when the returned pointer owns a
separate C allocation.

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

Without a retention fact, the library may call the function only until the C function returns, as iteration and comparison functions do. An exception in the callback skips its remaining calls and rethrows when the C function returns. Such a callback binds without `data` too, as `qsort`'s comparator does: `callback: {}`.

`release` names the `void (*)(void *)` parameter that takes the destructor for `data`, for a library that keeps the callback, such as SQLite's `xDestroy`. The library may call the function until it calls the destructor, and an exception rethrows from the library call that triggered it.

`replaced: true` describes a setter that keeps its callback until its next call replaces it, such as GLFW's `glfwSetKeyCallback` or SQLite's `sqlite3_update_hook`. `data` is then optional:

```typescript native/glfw.ffi.ts
functions: {
	glfwSetKeyCallback: { params: { callback: { callback: { replaced: true }, nullable: true } } },
},
```

When the setter's first parameter is a handle, each handle keeps its own callback until its resource is destroyed. Without `data`, the callback must receive that handle, as GLFW's window callbacks do. With `nullable`, `null` removes the callback. A result that is the replaced callback, or with `data` its user data, is dropped.

A key has one pending setter at a time, including synchronous setters that call back
before returning. Another setter for that key throws; setters for other keys can run.
Await an async setter before replacing its registration again.

`closes` names the input handle released by a one-shot completion, such as libuv's
`uv_close`. Both the registration function and completion return `void`:

```typescript native/uv.ffi.ts
uv_close: { params: { close_cb: { callback: { closes: "handle" } } } },
```

The callback and handle are nonnullable. The callback receives the closing handle
or routes through `data`; other arguments must be safe to copy. Foreign completions
queue for the program's thread, so the program needs an event loop. Further C calls
and disposal reject the handle while close is pending. Completion receives the same
wrapper, already closed, and its retained buffers can then be transferred. Caller
storage and backing bytes remain alive through the native completion even after VM
teardown; detached completions release native ownership without running JavaScript.
The library must invoke completion exactly once and keep the resource valid until
then. `closes` extends a callback loan through completion and cannot accompany
`release` or `replaced`.

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

`queued: true` marks a kept callback the library may call from its own threads, as audio and network libraries do. A call from another thread copies its arguments and queues for the program's thread, and the C caller continues at once; a call on the program's thread runs immediately. So the callback returns nothing, and takes values, strings, buffers, structs, and counted arrays of values or terminated strings. Array copies preserve fixed rows, native alignment, and null string entries. Resource-bearing elements need a waiting callback. An exception it throws is uncaught, as one in an event handler. The program needs an event loop, such as the web platform surface, and it keeps running while the callback is kept.

Use `queued: "wait"` when the C caller needs a result.
The foreign thread waits until JavaScript returns and conversion succeeds. An exception
returns zero to C and remains uncaught on the program's thread. Shutdown cancels waiting
calls and rejects new ones with a zero result.
Waiting callbacks borrow pointed-to arguments while C waits. A handle they receive is
lent for that callback, unless the program already owns the same resource.

For a callback returning text or bytes, describe `callback.returns`:

```ts
callback: {
	data: "data",
	returns: { string: { length: "1" }, lifetime: "call" },
},
```

The length names a writable integer pointer by its callback parameter position. It is
hidden from JavaScript and receives the returned UTF-8 byte count. Use `string: true`
for NUL-terminated text, or `bytes: { length: "1" }` for a buffer result. `nullable`
permits `null`; empty values keep a non-null pointer with a zero count.

Each result gets an independent native copy. All copies survive subsequent and nested
callbacks, garbage collection, and source-buffer transfer until the enclosing binding
finishes converting its outputs. C must stop using them before that binding returns.
Async twins retain the same lifetime through worker execution and completion conversion.
An exception returns a null pointer and zero count to C.

A retained callback uses `lifetime: "registration"` instead. Its copies survive until
the library invokes `release`, the next setter replaces the callback, or its owning
resource closes. C must stop using all returned pointers at that boundary, including
ones held by pending consumers. All earlier results remain valid when the same callback
returns again. A callback that releases or replaces itself cannot then publish another
non-null result; conversion throws a `TypeError` and C receives null and a zero count.
Native copies can outlive the VM when C still owns the registration; callbacks after
VM shutdown return null without running JavaScript.
One-shot `closes` completions cannot return pointers because their registration ends
as the completion runs.

A callback can return a pointer handle with an explicit result lifetime. C borrows
the resource; ownership stays with the canonical handle. The handle must belong to the
program rather than being a callback loan. Disposal and destruction throw while C holds
a result lease. Managed state also rejects field access and other C operations until
the call finishes converting its outputs or the registration ends. Repeated results and compatible views share
the same owner. Collection keeps the wrapper alive while the VM runs; native leases
preserve storage and retained backing stores during teardown and follow the handle's
existing `collect` policy when they retire. `collect: false` still requires explicit
resource cleanup.

For `lifetime: "registration"`, unregister the callback before closing resources it
returned. Registration cleanup must be independent of those resources. A keyed callback
cannot return its own registration owner because the resulting lease would prevent
cleanup. The same constraint applies to indirect ownership cycles and release-backed
registrations whose owners are opaque to the binding.

Stop or join callback producers through an async twin so the program's thread remains
available to run their callbacks. A handle whose destructor joins such a producer also
needs `collect: false` and asynchronous destruction.

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

`TraceLogText(LOG_INFO, "loaded %s", name)` then calls `TraceLog` with a string as its
third argument. The C compiler applies the usual argument promotions. A variant's
`params` adds facts for its arguments, keyed by `arg<position>` or by position. An empty
`args` list describes a call with no extra arguments.

Add `dispatch: "log"` beside `variants` to export a runtime selector. Call
`log("TraceLogText", LOG_INFO, "loaded %s", name)` to select that declared signature.
The generated declarations preserve the correlation between a selector and its argument
tuple. Only declared signatures are accepted, with their visible JavaScript argument
counts after hidden constants, counts, and output buffers. Invalid selectors and argument
counts fail before payload conversion or entering C. Individual variants remain available
as direct exports.

Without `dispatch`, the original variadic function has no export. A dispatcher may use
that original name. Selection never infers C types from JavaScript values or format text;
each case calls its typed C wrapper with the original variadic prototype. The function
still reads arguments by the types its other arguments announce, such as a format string,
so a mismatch is undefined behavior in C. Pass fixed formats from a wrapper rather than
text a user controls.

## Run blocking calls on a worker

`async` exports a function a second time, under a new name, as one that runs the C call on a worker thread and returns a promise of its result. A slow call, such as a database query or an image decode, then leaves the event loop free:

```typescript native/sqlite.ffi.ts
functions: {
	sqlite3_step: { async: "sqlite3_step_async" },
},
```

The arguments convert before the call starts, and a conversion error rejects the promise. Buffers and handles the call uses stay pinned until the promise settles: transferring or resizing such a buffer, or closing such a handle, throws. JavaScript can still write the buffer's bytes in the meantime, so leave them alone until then. A handle a callback lends is refused, since the call outlives the callback. The result converts when the promise settles, so a call that changes what a pointer result points to must wait until then. An async export copies array arguments, and the program needs an event loop, such as the web platform surface.

Call-scoped callbacks run on the program's thread while the C caller waits, including
callbacks from threads the library creates. Without user data, the library must invoke
the C callback on the worker executing that call. An unhandled callback exception rejects
that call's promise; later callbacks in the same call return zero without running
JavaScript. Exceptions caught inside a callback keep their ordinary behavior.

Callbacks retained through a `release` parameter can also be registered asynchronously.
They continue to queue and wait after registration settles, until C releases them.
Explicit `queued: true` callbacks continue without waiting. Replacement setters and
`closes` registrations can also have async twins. A close registration's promise
settles when its C call returns; a deferred completion remains retained afterward.
Async registration requires a handle the program holds, rather than a callback loan.
Failed scheduling leaves the handle open for retry. Once accepted, close registrations
drain on native workers during teardown, retaining caller storage and managed buffers
until the C completion arrives. For a synchronous registration, use `queued` if the
library calls back from other threads.

Use `async` only for functions the library allows on another thread while the program makes other calls, such as SQLite in its default serialized mode.

Handle field reads throw a `TypeError` while a worker call uses the handle, including
handles passed in arrays. Read fields after the call's promise settles.

A handle's destroy function can also have an `async` export. The handle rejects other
calls and disposal until destruction finishes. A conditional destroy preserves the
handle when C reports failure, so you can retry. VM teardown drains accepted destructors
on native workers and reconciles their results even when their promises are discarded.
A scheduling error leaves the resource open for retry.

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

Commit `maligator-ffi.lock.json` with the contract. Fixed argument, cleanup status, and
documentation facts follow macro definitions through included headers, including
function-like helpers and token-pasted expansions. Supporting macros stay private unless
their headers belong to the declared library surface. Context-dependent macros such as
`__COUNTER__` and `__FILE__` cannot become automatic JavaScript constants or cleanup success
codes; fixed arguments remain C expressions evaluated by the C compiler.
Run `maligator ffi check` in CI to report changes
before accepting a library upgrade. The command reads the headers and facts and exits
with status 1 if they differ or have no accepted snapshot. Review
the changes, update the facts if needed, then run `--update` again.
Record snapshots include target size, alignment, field offsets, and declaration
attributes. Packing and alignment changes require review even when the generated
JavaScript types stay the same. Layout values in JSON use bits so bit-fields retain
their exact offsets. A reachable complete record without an identifiable layout
cannot be accepted.
Typedef snapshots also retain declaration attributes. Aliases with alignment
attributes record their effective target alignment, which can differ from the
alignment of the underlying record.

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

`maligator test` builds a test runtime with the bindings too. In `test --watch`,
JavaScript edits start a fresh application in the linked runtime, preserving the C
library's process state. Changes to contracts, headers, sources, or resolved library
files replace that runtime after its applications finish cleanup. Portable wire
output rejects C libraries.
