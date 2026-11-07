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

- `borrowed` marks a result the library keeps owning. Closing it does not release it.
- A `handle` without `destroy` describes a pointer the library owns, such as the `sqlite3_context` SQLite lends to callbacks, unless `storage: "caller"` provides its outer storage.
- `collect: true` releases a handle the program drops once it is garbage collected. Leave it off for resources that must be released on one thread or before the library shuts down, such as raylib's GPU textures.
- `nullable` on a parameter accepts `null` for a string or handle pointer and passes `NULL`.

## Cleanup that can fail

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

## Structs the library allocates

A struct the library both allocates and passes by value, such as cimplot's
`ImPlotSpec`, binds with the same `handle` fact. A pointer result such as
`Style *style_new(void)` returns a `Style` handle that keeps the library's pointer as
its storage: by-value parameters copy the struct from it, pointer parameters update it
in place, its fields read the library's current values, and disposal passes that
pointer to `destroy`. With `borrowed: true`, closing such a handle leaves the struct to
the library. Unlike pointer handles, each result is a new handle object, so `fresh` and
`views` do not apply, and callbacks cannot receive these pointers. When `destroy` takes
a pointer, it also receives the address of a handle's copy for by-value results, so
mix the two only when that function cleans up the struct's contents without freeing it.

## Ownership through failures

If a callback throws or a worker result is discarded, cleanup preserves pointer
resources already known to that VM. Direct return and out-parameter aliases release
new storage once. Failed handle construction releases its undelivered C resource
even when automatic collection is disabled. Fresh-result facts distinguish recycled
storage from a resource whose destruction is still pending.

Bindings that combine direct resource pointers with copied values transfer ownership
and publish type views after every output conversion and final managed-input check
succeeds. A failed conversion releases new resources once and preserves existing
handles' ownership and views. This guarantee also covers owned pointer fields in
plain value records, arrays of those records, and flat owned pointer arrays.
An array's outer table may remain library owned; declare `free` only when the binding
must release that table.

Resource-table entries must remain readable and unchanged through delivery or failed
delivery cleanup. Element destructors must preserve the table while cleanup walks it.
For async results, this includes delayed conversion and native cleanup after worker
termination. Avoid overlapping calls that overwrite the same library-owned table.

Buffers supplied through `free` remain alive until every output is copied. Aliased
allocations are released once, using their first declared cleanup function. Cleanup
runs before result assembly and ownership commit, including when copying throws.

A cleanup function supplied through `free` may call JavaScript. A new alias exposed
during cleanup is provisional: it supports synchronous reads and leases for callback
results. Closing it, assigning an owner or library lifetime, passing it to a worker,
or retaining it as a callback input requires delivery first. Failed delivery closes
provisional aliases; C result leases preserve native storage until released. A separate
call that successfully acquires ownership keeps that ownership if the outer conversion
fails.

## Resources inside resources

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
Without `callback.owner`, a kept callback leases owner-bound inputs and their destruction roots until C releases
the callback or a replacement retires it. This includes handles inside compound inputs
and an owner-bound callable's captured handle. Disposal and destruction reject while
these leases remain; field reads and saved callables remain available for unregistration.
Unregister nullable callbacks with `null` before closing their resources. The library
must offer release or unregistration independently of root destruction. Declare
`callback.owner` when root destruction ends the registration instead. Children whose
root is a callback loan cannot become registration inputs. Registration results cannot borrow any retained
input root. Native leases also preserve the resources through VM teardown until C
releases the registration. Use a whole-result handle when its destructor releases
the record's resources together.

## Counted array fields

When a handle's struct points at a counted run of values, such as Dear ImGui's
`ImGuiTableSortSpecs` with `Specs` and `SpecsCount`, declare an `array` field:

```ts
types: {
	SortSpecs: { handle: {}, fields: { specs: { array: { length: "count" } } } },
},
functions: { sort_specs: { returns: { borrowed: true } } },
```

`specs.specs` returns a fresh array of as many `SortSpec` records as the `count` field
holds when it is read, or `null` for a null pointer. Each read copies again, so later C
changes appear in the next read and not in earlier arrays. Elements are values: records,
numbers, or strings, never handles. A negative or oversized count throws a `RangeError`.
Array fields work on any handle, including library-owned pointer handles whose other
fields stay hidden.

## Owned fields in records

For independently owned pointers in a value record, declare field ownership:

```typescript
types: {
	Token: { handle: { destroy: "token_free" } },
	TokenResult: { fields: { token: { handle: { owned: true } } } },
},
```

The field must point to a destructor-backed resource allocated by the library.
Nested plain records, selected union members, and active tagged payloads share the
result transaction.
Arrays of these records preserve fixed and counted dimensions. Aliased fields keep one
handle. A failed conversion preserves existing ownership while releasing new resources
once. Array elements follow C index order; the first owning field determines an aliased
resource's destructor.
Record inputs borrow their handles; callback arguments remain invocation loans.
Use `fresh: true` beside `owned` for a new lifetime at a recycled address.
Global getters and constants cannot transfer independently owned fields.

## Views of one allocation

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
Use `borrowed: true` on a pointer result or an `out`/`inout` handle when C retains
ownership. Result conversion publishes new views only after the complete delivery
succeeds. A failed delivery preserves independently delivered aliases and refinements,
including the original type of a new canonical handle exposed by a nested call.
Borrowed echoes preserve callback-loan scope.
When failed delivery leaves a resource retained by C, new ownership must wait for
its native leases to end. A `fresh` result can identify the next lifetime at a reused
address once C destroys the old resource; its registrations survive older cleanup.
Caller allocations keep ownership of their outer storage through views. A declared
caller destructor cleans initialized C state before the binding frees that storage.

## Caller-allocated state

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

Without managed cleanup facts, disposing or collecting the handle frees only its outer
storage. Retain the handle while C retains its pointer, and dispose it only after C
stops using it.
The wrapper also releases callbacks keyed by that storage; calls already queued can
finish from their copied arguments.
Asynchronous close needs the library's completion and lifetime contract.

To manage initialized state, pair an unconditional collecting destructor with an
initializer fact:

```ts
types: {
	CodecState: { handle: { storage: "caller", destroy: "codec_cleanup", collect: true } },
},
functions: {
	codec_init: { initializes: { param: "state", success: "0" } },
},
```

The initializer takes an exclusive, mutable handle input. Its `success` names an
integer status or C constant; omit it when every native return acquires cleanup
responsibility. Failure must leave the storage safe to free without C cleanup.
Repeated or concurrent initialization rejects before C. Ordinary pointer echoes do
not arm cleanup.

Native success arms cleanup before JavaScript result conversion. A later delivery
error therefore leaves the state initialized. Disposal, the destructor binding, and
collection run C cleanup before freeing the outer allocation. The destructor must
leave that allocation to the binding. Async initialization follows the same rules,
including discarded results during shutdown.

Initialized caller storage can own callback registrations directly or through
owner-bound children. Independent native leases preserve its storage and retained
byte buffers after VM teardown. Release managed caller state through its destructor
binding; a `callback.closes` completion cannot replace this cleanup contract.

## Trailing arrays

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

## Opaque caller state

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

## Retained buffers in state

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
