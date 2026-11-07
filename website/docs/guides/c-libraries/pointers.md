A pointer needs a fact about what it carries. Facts go on a function's `params`, keyed by C name or by 1-based position, or on its `returns`:

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

When C sizes a buffer from several parameters, write its length as their product:

```ts
functions: {
	fill_pixels: { params: { pixels: { bytes: { length: "width * height * 4" } } } },
}
```

`fill_pixels(width, height, pixels)` keeps every factor in its signature. Before C runs,
the binding multiplies the converted factors and literals and throws a `RangeError` when
the buffer is shorter, a factor is negative, or the product overflows. A longer buffer
passes unchanged, so one allocation can serve several sizes. On an `array`, the product
counts elements. Products apply to input buffers and arrays of functions, not to results,
outputs, strings, callbacks, or fields.

## Share and compute counts

Input arrays, byte spans, and counted strings can share an integer `length` parameter.
The binding checks every input length before entering C. Counted strings contribute
their UTF-8 byte length. Shared counts must be integer inputs; writable counts and
output capacities keep separate parameters.

## Arrays of handles

For a flat array of owned pointer handles, declare the element type's destructor
and the table's `free` function. The returned table must remain stable until `free`
runs. Its cleanup releases the table; each distinct element transfers to its handle.
Repeated pointers preserve identity. Conversion failures release new elements,
including elements not yet converted, and preserve existing handles' ownership.
Use `borrowed: true` on a returned or output pointer array when C keeps owning its
pointees. Its `free` function releases only the outer table. Borrowed output aliases
preserve any ownership already held by an existing handle.

## Typed arrays

Const arithmetic-pointer inputs also accept the matching typed array. For example,
`const double *` accepts `Float64Array`, and `const uint64_t *` accepts `BigUint64Array`.
Use the generated SDK for the library's exact native widths. Synchronous calls lend
the view's current storage, including its offset, after argument getters finish.
C callbacks can observe JavaScript element writes, while resizing or transferring
the backing buffer is blocked until C returns. C must not retain the pointer.
Compiled code hands a matching fixed-length view's storage straight to a function
of a library that registers no callbacks, so typed arrays are the faster choice for
calls in hot loops.
Async calls snapshot numeric views before scheduling worker execution, so later
JavaScript writes and transfers cannot affect the native input. Ordinary arrays
keep their copy semantics. Mutable pointers and fixed array rows still use copies.

To let C fill a reusable typed array, mark a mutable arithmetic pointer `writable`:

```ts
functions: {
	fill_samples: { params: { samples: { array: { length: "count", writable: true } } } },
}
```

`fill_samples(samples)` then lends a matching `Float64Array` to C, which writes its
elements in place. The view keeps the lending rules above and must not be backed by
an immutable buffer. Writable views are synchronous; a function with an `async`
twin rejects them. Ordinary arrays still pass a copy, so C's writes to them are discarded.

## Rows and fixed dimensions

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

## Caller-allocated outputs

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
buffer returns an empty array. Caller-owned buffers cannot declare `free`.

Record elements can transfer independently owned pointer fields using their
`handle: { owned: true }` field facts, including fixed inner rows and tagged payloads.
Only the written prefix transfers ownership. Invalid written counts trigger cleanup
within the allocated capacity, preserving existing input ownership. Inout handles stay
pinned through later getters, callbacks and worker execution.

Caller buffers of pointer handles require an explicit `borrowed` choice alongside
`array`: `false` transfers independently destructible pointees to their handles;
`true` leaves them owned by C. Null slots and repeated pointers preserve their values
and identity. Only the written prefix participates in ownership transfer, including
inout buffers. Inout pointer elements must be non-null handles.

## Counted text

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

## Fixed arguments

- `constant` passes a C macro, enumerator, or integer for a parameter, such as `SQLITE_TRANSIENT` for a destructor or `0` for a reserved argument. The parameter disappears from the JavaScript signature, and the C compiler checks the value's type.
- `sizeof` passes the C compiler's size of a complete struct or union, omitting the integer parameter from JavaScript. Compilation fails if its size does not fit the parameter.
- `end` passes the end of a NUL-terminated string parameter, for APIs such as Dear ImGui's `ImFont_CalcWordWrapPosition` that read text as a `[text, text_end)` range: `text_end: { end: "text" }` points at the terminator of the same UTF-8 encoding and disappears from the JavaScript signature. A null string passes `NULL` for both.

Each fact names the C declaration it describes. A fact that names nothing in the headers, or that does not fit the declaration, fails the build.

## Type void pointers

Some functions take a `void *` and an argument that says what it points at, as Dear
ImGui's `igSliderScalar` takes an `ImGuiDataType`. Give such a function a variant per
type. Variants of a function that is not variadic have no `args`; their `params` replace
the function's facts for the parameters they name:

```typescript
functions: {
	scalar_step: {
		variants: {
			scalar_step_double: {
				params: { type: { constant: "DATA_DOUBLE" }, value: { pointee: "double", inout: true } },
			},
			scalar_step_int: {
				params: { type: { constant: "DATA_INT" }, value: { pointee: "int", inout: true } },
			},
		},
	},
},
```

`pointee` names the C type the pointer addresses; the parameter then binds as a pointer
to that type, `const` for a `const void *`, so other facts such as `inout` and `array`
apply. `constant` fixes the selector, so each export can only pass the type it names.
Like variadic functions, a function with variants exports only its variants, and
`dispatch` adds a runtime selector over them.
