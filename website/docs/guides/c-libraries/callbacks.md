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

## Kept callbacks

`release` names the `void (*)(void *)` parameter that takes the destructor for `data`, for a library that keeps the callback, such as SQLite's `xDestroy`. The library may call the function until it calls the destructor, and an exception rethrows from the library call that triggered it.

## Replaced callbacks

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

## Registration owners

Use `owner` when destroying a resource ends a registration on one of its borrowed
children, without an independent unregister operation. It roots a callback the
library keeps through `release` or `replaced`:

```typescript
subscribe: {
	params: { callback: { callback: { owner: "child", data: "data", release: "release" } } },
},
```

The selector names an input handle by C parameter name or 1-based position. Its actual
destruction root must be a non-null, independently owned resource with a destructor.
C must stop the registration and all its consumers before destruction returns. Other
borrowed inputs must share that root.

A copied struct can be the root when the registration takes a pointer to its stable
copy and its handle declares `collect: true` with an unconditional destructor. Native
leases retain that storage after VM teardown until the last consumer releases it.
Initialized caller storage can also be the root when it declares an unconditional
collecting destructor. Passing the owner by value is unsupported.

The root keeps the closure and borrowed inputs alive. A closure that captures the
root can still be collected with it. Active callback execution prevents closing the
root; conditional destruction failure preserves the registration. Queued calls skip
JavaScript after the root closes. Independent result leases still prevent destruction,
and this registration cannot return a lease on its own root or descendants.

## Close completions

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
then. `release`, `replaced`, `closes`, and `once` are alternative lifetimes; a callback
states at most one.

## One-shot callbacks

`once: true` describes a callback the library calls exactly once, during or after the
function, as WebGPU's request functions do. It needs `data` or `lookup`. The registration
stays alive until that call returns, then the library may forget the pointer; an
exception rethrows from the library call that triggered it. With `queued`, a call from
another thread queues for the program's thread and the event loop waits for it. A
registration the library never calls stays alive until the program exits.

## Callbacks in structs

Some libraries take the callback inside a struct passed by value, such as WebGPU's
`WGPURequestAdapterCallbackInfo`. Name its function pointer member with `field` and its
`void *` member with `data`; the parameter then takes a JavaScript function, and the
binding builds the struct around the callback. Other members start zeroed unless
`constants` fixes them:

```typescript
functions: {
	request_device: {
		params: {
			info: {
				callback: {
					field: "callback",
					data: "userdata",
					once: true,
					constants: { mode: "REQUEST_DEFERRED" },
				},
			},
		},
	},
},
```

A callback record keeps its callback for the call or, with `once`, for its one call.
One-shot and record callbacks register through synchronous calls only.

## User data from a lookup

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

## Callback arguments

Handles a callback receives are lent for that call: once it returns they read as closed, unless the program already held a handle for the same resource. A callback's own `params`, keyed by 1-based position, take `string`, `bytes`, `array`, and `nullable` facts. A `length` names another callback parameter, which the function does not receive, so the collation above receives two `Uint8Array` copies.

## Calls from other threads

JavaScript runs on one thread, so a library that calls back from another thread aborts the program, unless the callback is `queued`. A destructor may run on any thread; the release completes on the program's thread.

`queued: true` marks a kept callback the library may call from its own threads, as audio and network libraries do. A call from another thread copies its arguments and queues for the program's thread, and the C caller continues at once; a call on the program's thread runs immediately. So the callback returns nothing, and takes values, strings, buffers, structs, and counted arrays of values or terminated strings. Array copies preserve fixed rows, native alignment, and null string entries. Resource-bearing elements need a waiting callback. An exception it throws is uncaught, as one in an event handler. The program needs an event loop, such as the web platform surface, and it keeps running while the callback is kept.

Use `queued: "wait"` when the C caller needs a result.
The foreign thread waits until JavaScript returns and conversion succeeds. An exception
returns zero to C and remains uncaught on the program's thread. Shutdown cancels waiting
calls and rejects new ones with a zero result.
Waiting callbacks borrow pointed-to arguments while C waits. A handle they receive is
lent for that callback, unless the program already owns the same resource.

## Callback results

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
