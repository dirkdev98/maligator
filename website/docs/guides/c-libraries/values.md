Bind C globals through accessor functions, choose which member of a union JavaScript sees, and call variadic functions through typed variants.

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

Declare independently owned pointers with `handle: { owned: true }` in the payload
record's field facts.
Only the active case's resources enter the result transaction; inactive union storage
is neither converted nor released. Arrays can mix tagged variants while preserving
resource aliases and ownership.

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
