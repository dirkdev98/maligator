Call a C library from your application by declaring it in the build config. Maligator reads the library's headers with clang and compiles a binding into the application, so the C compiler handles calling conventions, structs passed by value, and macros. You need the library's headers, clang (or Zig for a `--target` build), and the library itself as an archive, a shared library, or sources.

Maligator hosts the application. Embedding the Maligator runtime in a C application is
outside the supported API.

## Bind a small library

A library compiled from sources shows the whole loop. Save a header and its
implementation:

```c native/stats.h
int stats_add(int a, int b);
double stats_mean(const double *values, int count);
```

```c native/stats.c
#include "stats.h"

int stats_add(int a, int b) {
	return a + b;
}

double stats_mean(const double *values, int count) {
	double total = 0;
	for (int index = 0; index < count; index++) total += values[index];
	return count == 0 ? 0 : total / count;
}
```

Declare the library in a contract and name the contract in the build config:

```typescript native/stats.ffi.ts
import { defineLibrary } from "@maligator/cli";

export default defineLibrary({
	headers: ["stats.h"],
	find: [{ includeDirs: ["."], sources: ["stats.c"] }],
});
```

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	ffi: { stats: { contract: "native/stats.ffi.ts" } },
});
```

Ask what binds:

```shell
maligator ffi inspect stats
```

`stats_add` takes and returns integers, so it binds as it is. `stats_mean` takes a
pointer, and a header cannot say whether that pointer is one value, an output, or an
array. The report says so and suggests the fact that binds it:

```text
stats_mean param 1 (values): pointer (const double *) needs a fact: a handle, buffer, out parameter, or string
  functions: {
    stats_mean: { params: { values: { array: { length: "count" } } } },
  },
```

Add the suggestion to the contract, beside `find`:

```typescript native/stats.ffi.ts
functions: { stats_mean: { params: { values: { array: { length: "count" } } } } },
```

`values` now takes a JavaScript array or a `Float64Array`, and `count` disappears from
the signature because the binding passes the array's length. Generate declarations and
call both functions:

```shell
maligator ffi types
```

```typescript src/index.ts
import { stats_add, stats_mean } from "maligator:ffi/stats";

console.log(stats_add(2, 3), stats_mean([1, 2, 3, 4]));
```

```shell
maligator run
```

```text
5 2.5
```

Larger libraries follow the same loop: declare, inspect, add the facts the report asks
for, and regenerate declarations.

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
application and its workers use, and for the handle types, fields, views, and callable
signatures those exports reach. When none of them registers a callback, wrappers skip
the rooting and pinning that callback reentry needs. Namespace access retains its
observable exports. Declaration generation and inspection describe the full header
surface; development runtimes retain it for later application edits.

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
storage, avoiding encoding work on later synchronous calls. Long ASCII inputs can
instead grow their existing backing to add a NUL terminator; short ones copy into
the call's frame. Preparation increases retained
memory and can cost more than copying for short reuse sequences. Mutable inputs,
callbacks, and asynchronous calls use private input copies.

## Describe what headers cannot say

Headers give types, not intent. A fact in the contract states the rest, and a fact
that does not fit its declaration fails the build:

| What the C code does                                    | Fact                              | Guide                                                        |
| ------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------ |
| Writes through a pointer, or reads and writes it        | `out`, `inout`                    | [Pointers and buffers](/guides/c-libraries/pointers)         |
| Takes a buffer or array with a count                    | `bytes`, `array` with `length`    | [Pointers and buffers](/guides/c-libraries/pointers)         |
| Takes or returns text                                   | `string`                          | [Pointers and buffers](/guides/c-libraries/pointers)         |
| Selects what a `void *` points at with another argument | `pointee` with `variants`         | [Pointers and buffers](/guides/c-libraries/pointers)         |
| Allocates a resource the program must release           | `handle` with `destroy`           | [C resources](/guides/c-libraries/resources)                 |
| Keeps owning a pointer it returns                       | `borrowed`                        | [C resources](/guides/c-libraries/resources)                 |
| Fills state the caller allocates                        | `handle` with `storage: "caller"` | [C resources](/guides/c-libraries/resources)                 |
| Calls back into the program                             | `callback`                        | [Callbacks](/guides/c-libraries/callbacks)                   |
| Returns a function pointer                              | `callable`                        | [Callbacks](/guides/c-libraries/callbacks)                   |
| Exposes globals, unions, or variadic functions          | `globals`, `shape`, `variants`    | [Globals, unions, and variadics](/guides/c-libraries/values) |

Facts go on a function's `params`, keyed by C name or 1-based position, on its
`returns`, or on a type under `types`.

## Find what cannot bind

```shell
maligator ffi inspect raylib
```

The report lists each function that is not exported and the fact it needs. It also suggests facts from naming and signature conventions: a count parameter beside a pointer, a pointer the function writes, the `void *` a callback receives or the function that returns it, a setter that replaces its callback, a struct with its own release function or an opaque one nothing releases, a getter's result as borrowed, a result whose documentation says how to free it. Each suggestion is checked against the headers and listed only when it makes a function bind, but it comes from names rather than the library's documentation, so review it before adding it to the contract.

`--json` includes the structured C model and the accepted `facts`, alongside mapped
signatures, header documentation, missing facts and suggestions in contract shape.
Each missing fact has a `code` naming the kind of fact it needs, such as `handle`,
`callback` or `text`, or `unsupported` when no fact binds it, and the C parameter it
belongs to. The model retains unresolved record fields and typedef chains, including
transitive system types, so a tool can follow a pointer's type before proposing a
fact. Its declaration tables are arrays, and exact C integer values are decimal
strings.

A contract error starts with the fact path it rejects, such as
`functions.png_read_row.params.row.bytes`, so the fix goes in that entry.

## Audited native calls

By default, a native call can invoke callbacks registered through any configured
library, including another binding to the same C dependency. An application whose
closed module graph imports no export that can register a callback, in any library,
compiles its calls without that reentry. If the C function's contract guarantees it
never enters JavaScript, state that fact on the function:

```typescript
functions: {
	read_value: { callsJavaScript: false },
}
```

This permits callback-free marshalling and compiler facts for eligible calls. Input
getters and result cleanup keep their own effects: a struct getter can run JavaScript,
and a configured release function can invoke an earlier callback. The fact gives no
purity or thread-safety guarantee. Typed variadic variants inherit it from their C
function; a returned function pointer has its own call contract.

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
