# Parallel workers

`maligator:workers` combines a small native isolate and message substrate with a
source task-pool library. `node:worker_threads` uses the same substrate. Workers
are persistent native threads with independent VMs, heaps, module instances and
event loops. JavaScript runs to completion within each isolate; this design does
not migrate stacks between threads or share language objects between heaps.

## Declaring entries

```js
import { createWorkerUrl, createPool } from "maligator:workers";

const jobs = createWorkerUrl("./jobs.mjs", import.meta.url);
const pool = createPool(jobs, { size: 2, maxQueuedTasks: 8 });
await pool.ready;
const result = await pool.run("sum", [[1, 2, 3]]);
await pool.close();
```

The entry module exports context-first tasks:

```js
export function sum(context, values) {
	let result = 0;
	for (const value of values) {
		context.throwIfCancelled();
		result += value;
	}
	return result;
}
```

`createWorkerUrl` produces an immutable descriptor with a canonical `href`. Its
module specifier and explicit base must resolve statically. The compiler follows
catalog export identity through import aliases, reexports and constant
aggregates. Declarations create worker graph edges independently of the eventual
consumer, so libraries can pass a descriptor or its `href` through their own
queues and options. Unknown entries fail before spawning a worker.

Worker graphs are separate evaluation roots. Declaring an entry does not evaluate
its module on the parent thread. Each image contains the declared module
candidates needed by a generic bootstrap's dynamic imports, while each worker
evaluates only its own reachable graph. Module evaluation preserves cycles,
live bindings, cached evaluation errors and asynchronous dependency ordering.
`Worker.ready` settles after the complete entry graph, including top-level
`await`; `Worker.closed` settles after thread reaping.

Native builds embed entry images. Interpreted development builds use a bounded,
digest-checked manifest of wire images and resolve the same canonical names.
Worker source changes invalidate worker artifacts and their parent manifest.
Product builds include the toolchain's pool source and bootstrap assets.

## Libraries and ownership

The native substrate exposes `Worker`, transferable `MessageChannel` and
`MessagePort`, synchronous `receiveMessageOnPort`, lifecycle events, reference
control and cooperative termination. A library can supply its own task
protocol, worker bootstrap, priorities or pool policy. The built-in pool is one
consumer of this substrate.

The Node personality supplies `Worker`, `parentPort`, `workerData`, `threadId`,
`isMainThread`, messaging, synchronous receive, reference control and termination,
plus transfer/clone marks. Unmodified Tinypool uses its ordinary bootstrap,
MessagePort protocol and SharedArrayBuffer/Atomics handshake. Runtime compilation,
`eval` workers, shared environment mutation, custom stdio and per-worker engine
resource limits are outside this basic personality and unsupported options are
rejected.

Serialization produces native snapshots containing bytes and native resource
descriptors. Committed snapshots contain no pointers into a sender heap.
Ordinary objects, arrays, maps, sets, dates, regular expressions, boxed values,
errors, buffers and views preserve their structured-clone identities and cycles.
Functions and unsupported objects fail with `DataCloneError`.

Transfer lists are captured once. All getters finish and every transferable is
revalidated before admission and commit. Maligator admission failure preserves
every still-owned listed resource. Node ports commit a successfully serialized
transfer even if a getter closes the channel or moves the caller away, then drop
the undeliverable snapshot. Clone errors and host quota failures preserve
transfers on both surfaces. A port retains its posting policy when transferred,
including through a channel or worker created by the other API.
ArrayBuffer ownership moves and the source detaches
synchronously; MessagePort ownership moves and the old wrapper loses access.
SharedArrayBuffer clones retain the same backing and are never transferable.
Receiving constructs heap-local wrappers. Port generations and native reference
counts protect close, transfer, delivery and isolate teardown races.

Each endpoint has message-count, total-byte and per-message bounds. The process
also bounds admitted data to 65,536 snapshots and 512 MiB. Reservations include
in-flight delivery until native snapshot release. Quota-rejected posts do not detach
buffers. FIFO order applies to each endpoint. Termination and Atomics cancellation
notification do not depend on room in a user-message queue.

Started referenced ports keep their event loop alive. Unreferenced ports remain
usable while reachable; abandoned idle ports finalize and close their native
endpoint. A live worker remains rooted until joined. Teardown closes native
producers and joins owned work before freeing the reactor or language heap.

## Pool scheduling

A pool uses a fixed number of persistent module instances, with one active task
per instance. Accepted tasks dispatch FIFO to idle workers. Each instance keeps
its own module state; there is no affinity promise between separate submissions.
`run()` reports invalid input, saturation, closed state and already-aborted
signals synchronously. Accepted transfers commit before `run()` returns; task
results and remote failures settle its returned promise.

Queued cancellation discards the native snapshot without executing the task.
Running cancellation sets a shared flag and notifies an asynchronous Atomics
wait. CPU tasks call `throwIfCancelled`; asynchronous tasks use the supplied
AbortSignal. A cancelled running task occupies its worker until its promise
settles. `terminate()` interrupts whole workers at runtime safepoints and waits
for reaping. Arbitrary native operations finish or follow their own cancellation
contract before disposal.

`map()` consumes a bounded window of argument tuples, observes every submitted
rejection immediately, and yields results in input order. Returning early aborts
its outstanding tasks and closes the input iterator. `close()` rejects new
submissions, drains accepted work and joins workers. A worker failure rejects
accepted work without replaying tasks that may have changed persistent state.
Statistics report size, active and queued tasks, completions, failures and
cancellations.

## Process resources and shared memory

Native blocking I/O, DNS, cryptographic work and GC each use process-owned
executors. Clients have their own bounded queues and concurrency grants. Ready
clients progress round-robin; disposing one client discards its queued work and
waits for its own running callbacks. I/O, DNS and crypto jobs contain no language
pointers; completions return to the owning reactor. GC jobs explicitly bind their
owning collector and trace that isolate's heap. GC ownership and pressure pacing are
described in [generational GC workers](09-generational-gc-workers.md).

Shared memory reserves its full maximum capacity before allocation and never
moves while growing. Published growth is zero-filled. Element Atomics use real
atomic operations; waiters are keyed by backing and byte offset, so wrappers in
different isolates communicate. `Atomics.wait` is available on native workers;
`waitAsync` resolves through the owner's event loop without blocking its mutator.
Termination interrupts native waits. Shared BufferSource consumers copy through
atomic byte access where a stable private snapshot is required.

The hard process reservation limit defaults to 1 GiB.
`MAL_SHARED_MEMORY_MAX_BYTES` accepts a decimal byte count; `0` means unlimited,
subject to addressable memory. Invalid values retain the default. Accounting
counts a backing once, regardless of wrapper count; the final release returns
its reservation.

The threadless Wasm reactor retains inline GC and shared-buffer element
semantics, but does not spawn native workers or provide a blocking wait. A
hookless embedder rejects an asynchronous wait that it cannot settle. No Node
portability adapter is included for `maligator:workers`.
