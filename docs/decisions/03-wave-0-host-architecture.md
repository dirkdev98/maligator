# Host architecture

The host owns transport independently of WinterTC and Node object semantics.
This contract defines layering, streaming, ownership, cancellation, and turn
ordering. Unfinished implementation and verification work lives in
[TODO.md](../../TODO.md#host-architecture-and-transport).

## Decision

### Protocol and dependency boundary

The HTTP/1 transport uses **llhttp** for request and response syntax, incremental
parsing, and message framing. Its pinned C sources compile into `libMalHost.a`;
the pin, license, generated-source provenance, and ABI/version assertion are build
inputs. Other protocols must preserve the host's ownership and streaming boundary.

There will be **no Hyper dependency** in the product, build graph, generated code,
or tests that gate an ordinary build. Hyper's connection state machines, buffer
management, dispatch boundaries, cancellation handling, and benchmark results are
a design and performance reference. Reference benchmarks or differential tools may
build Hyper out of tree and must not add it to Maligator's Cargo manifest or lockfile.

The host never auto-decompresses content codings. `Content-Encoding` and body bytes
cross the host ABI unchanged. Decompression, if a runtime surface later requests
it, is a runtime policy layered over the byte stream.

### Layering

The dependency direction is fixed:

```text
entry/embedder
    -> runtime personality (WinterTC, Node, Maligator)
        -> runtime-neutral host ABI
            -> HTTP/1 codec (llhttp) and connection state machines
                -> optional TLS byte transform (Rustls FFI)
                    -> DNS, TCP sockets, reactor, clock, wake source

engine <- opaque runtime/host attachment and root-source hooks only
```

Responsibilities are divided as follows:

| Layer               | Owns                                                                                                                        | Must not own                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Engine              | VM, GC, jobs/microtasks, opaque embedder pointers                                                                           | Sockets, DNS, HTTP, TLS, runtime header policy                       |
| C host              | Reactor, wake source, DNS workers, socket descriptors, connection pool, llhttp parsers, wire buffers, operation/task queues | `MalValue`, promises, WinterTC or Node objects, JavaScript callbacks |
| Rust FFI            | Optional Rustls state and byte transformation                                                                               | Sockets, DNS, reactor polling, JavaScript semantics                  |
| Runtime personality | JS objects, roots, promise settlement, normalized header views, redirects/cookies and other personality policy              | File descriptors, parser structs, TLS state                          |
| Entry/embedder      | Runtime selection and turn pumping                                                                                          | Protocol parsing or direct JS invocation from I/O callbacks          |

Protocol modules receive `MalHost *` and opaque handles. Runtime adapters own
callback values and GC roots. Remaining timer-ownership and embedder-boundary work
is tracked in [the host roadmap](../../TODO.md#active-host-work).

### Host ABI

[Host tasks](../../runtime/src/host/host_task.h) define operation handles, progress,
terminal completion, cancellation, and payload release. The
[HTTP codec](../../runtime/src/host/http_codec.h),
[server](../../runtime/src/host/server.h), and
[client](../../runtime/src/host/http_client.h) own their transport-specific APIs.
Runtime adapters translate those records into public objects and callbacks.

The ABI uses integer handles with generation checks, not host pointers encoded as
JavaScript numbers. Stale or cross-host handles return a synchronous invalid-handle
result and cannot address a reused operation slot.

### Ownership and lifetime

- `MalHost` is owned by one embedder and confined to its reactor thread. Cross-thread
  producers own plain host data and wake the reactor to publish results. They never
  access operations, parsers, VM state, or runtime objects directly.
- The host owns an operation from successful `start` through release of its terminal
  task. The runtime adapter owns only its handle and its rooted JS state. A start
  failure creates no handle and queues no task.
- The host owns listeners, socket descriptors, parser state, DNS requests,
  connections, and pooled idle connections. Closing an operation does not close a
  reusable connection until framing says it is unsafe to reuse.
- Data retained after a start call must be copied or have its ownership transferred.
  No parser or socket retains a caller stack pointer.
- Owned writes transfer byte-buffer ownership only when accepted. Task payloads
  remain host-owned until `mal_host_task_release` or an explicit ownership transfer;
  adapters must take ownership or copy data they need afterward.
- Header storage belongs to the head task. Releasing that task invalidates every
  header slice. Body tasks each own a separate buffer lease.
- Runtime adapters remove roots and release operation state only after consuming the
  terminal task. Host shutdown first cancels all live operations, drains their
  terminal tasks without invoking JS, joins DNS workers, closes descriptors, and
  then frees host storage. VM teardown follows host/runtime detachment.

### Header and framing contract

The transport header list is not the WinterTC `Headers` object.
Node incoming-header objects keep normalized names in collectable dictionary storage.
Remote names and field ordering must not populate permanent atom or shared shape caches.

- For received messages, each field is emitted in wire order with duplicate fields
  separate and the original field-name case preserved. Values exclude surrounding
  optional whitespace but otherwise preserve bytes. llhttp callbacks split across
  input buffers are coalesced into the head's arena without changing bytes.
- For sent messages, user fields retain supplied order, duplicates, name case, and
  value bytes. The HTTP codec may reject invalid names/values and may add or replace
  only framing fields required to make the message unambiguous. It must not sort,
  title-case, combine, or otherwise normalize user fields.
- Framing validation happens before runtime dispatch. Conflicting or invalid
  `Content-Length`, unsupported transfer-coding chains, forbidden body framing, and
  header/line/field limit violations terminate with an HTTP framing or limit error.
  A server may serialize the corresponding 4xx response before closing when safe.
- Runtime personalities derive their own case-insensitive lookup and iteration
  views. WinterTC combination rules and Node's `rawHeaders` can therefore coexist
  without loss. `Set-Cookie` remains separate in the raw list.
- Request and response trailers use a distinct ordered raw-header task. If trailers
  are not exposed by a personality, it must explicitly discard that task; the host
  still parses framing correctly.

Header limits follow Node. The request target or status text, field names and values
share one byte budget per message, 16 KiB unless `maxHeaderSize` raises it, and
trailers count against a fresh budget. A server request may also carry at most
`maxHeadersCount` fields, 1000 by default. Reaching either limit answers 431; a client
response that reaches the byte budget fails with `HPE_HEADER_OVERFLOW` and keeps its
first 1000 fields otherwise. Emitted body buffers hold at most 64 KiB. The transport
streams bodies; adapters can impose their own buffering limits.

Node stream constructors and the HTTP incoming adapter reserve capacity for the
initial state fields in the state object itself. The public `_readableState` and
`_writableState` objects retain their ordinary descriptors and mutation behavior.
Properties become visible through the existing initialization writes.

Readable startup and synchronous `_read` callbacks buffer pushes until the read
boundary has returned. Scheduled flow primes `read(0)` and drains through ordinary
`read()` calls, preserving FIFO consumption, pause handling and readable lengths.
Later pushes may deliver directly only outside that boundary with an empty buffer.
EOF after the boundary drains without adding a tick before end scheduling, so
Transform readable completion keeps its ordering relative to writable finish.

### Backpressure

Read and write flow control are explicit and bounded:

- A stream starts with zero read credit. The host emits no body-data task until the
  adapter grants bytes through the transport read-credit API. One data task consumes
  credit by its payload length; EOF may be delivered with zero credit.
- Per stream, granted but not yet delivered read credit is capped at 256 KiB and an
  emitted chunk at 64 KiB. When credit reaches zero, socket reads stop except for
  bounded parser/framing progress already resident in the connection buffer.
- The transport write API either accepts a stated byte count and owns that range or
  returns `WOULD_BLOCK` without ownership. Queued plaintext per stream is capped at
  256 KiB. Crossing the high-water mark suppresses further acceptance; crossing the
  128 KiB low-water mark queues one write-capacity task.
- Rustls ciphertext and llhttp input staging have separate bounded buffers included
  in the connection's memory budget. TLS must not turn a blocked plaintext writer
  into unbounded ciphertext buffering.
- Each I/O task performs bounded work: at most 64 KiB of socket read/write and at
  most 32 accepts. Remaining readiness is requeued. One busy connection cannot
  monopolize a runtime turn.
- For HTTP/1.1 pipelining, response order is connection order. Parsed follow-up heads
  and bodies are flow-controlled; the host must not buffer unbounded pipelined
  requests behind an unfinished response. Client pooling permits one in-flight request
  per connection; pipelined client requests need a separate contract.
- The server parses a follow-up request only after the previous response finishes, so
  a malformed follow-up gets its bodiless 400 after the earlier responses, and bytes
  after a `Connection: close` request are never parsed. Node parses eagerly instead
  and drops the pending response in both cases; RFC 9112 asks for the order kept here.
- The codec reports the same events however a peer segments its bytes, including
  the body bytes that precede a parse error. `httptest` checks that with seeded
  fragmentation of valid and mutated pipelined requests.

### Completion, error, and cancellation contract

Every successfully started operation produces exactly one terminal task with one of
`OK`, `ERROR`, or `CANCELLED`. Head and body tasks are progress, never completion.

The reactor thread is the linearization point. Operation state follows:

```text
STARTING -> ACTIVE -> TERMINAL_QUEUED -> RELEASED
                   \-> CANCELLING --/
```

- Cancelling a live operation is idempotent. The host can close transport resources
  immediately, but runtime settlement and adapter release follow terminal-task dispatch.
- If success/error linearizes first, a later cancellation is a no-op and the
  existing terminal result wins. If cancellation linearizes first, queued
  nonterminal tasks for that operation are suppressed and `CANCELLED` wins.
- DNS completion, timeout, peer close, parser failure, TLS failure, explicit abort,
  listener shutdown, and host teardown all use the same terminal path. No branch may
  settle a promise or callback directly.
- Releasing a terminal task retires the handle generation. Duplicate kernel events,
  worker results, timeouts, and stale readiness notifications then become no-ops.
- A stream write accepted before cancellation may be partially sent, but no success
  is reported after cancellation wins. Cancellation is not a transactional network
  rollback.

Errors retain their native diagnostic and the stage where they occurred.
Transport errors distinguish resolution, connection, socket, TLS, framing, limits,
timeout, cancellation, and shutdown failures.
WinterTC maps network failures to rejected fetch promises and aborts to its abort
reason; Node maps the same record to Node-shaped errors. Neither mapping belongs in
the C host.

### Event-loop contract

Readiness collection and runtime execution are separate phases. Reactor backends
may harvest many events per wait, but they only update host state and enqueue host
tasks. They never invoke JavaScript, settle promises, or call personality callbacks.

A runtime turn is exactly:

1. Dequeue and dispatch at most one host task.
2. Run the active personality's runtime checkpoint to empty.
3. Return control to the embedder or begin the next turn.

The WinterTC checkpoint drains VM promise/microtask jobs. The Node checkpoint drains
`process.nextTick` before promise/microtask jobs and repeats if either queue makes the
other runnable. This ordering belongs above the host task queue; the reactor does not
distinguish personalities.

After top-level execution, the entry performs its existing microtask checkpoint,
then repeats turns. If no task is queued, the embedder may poll/block the reactor
until one is queued. A pumped embedder uses a non-blocking one-turn entry and the
host's pollable wake source. It must observe the same ordering as the blocking loop.

Timers, DNS results, accepts, readable/writable progress, terminal operation events,
and cross-thread wakes use host tasks. FIFO order is required within one task source;
cross-source ordering is the order in which the reactor thread enqueues tasks.

### DNS and sockets

The C host owns address parsing, DNS scheduling, connection attempts, socket options,
and descriptor teardown. `getaddrinfo` runs on a bounded thread pool because
kqueue/epoll do not make libc DNS asynchronous. Results include IPv6 and IPv4
addresses and are consumed only on the reactor thread. The HTTP client attempts one
address per request; Happy Eyeballs racing remains in
[the host roadmap](../../TODO.md#active-host-work).

Resolver cancellation suppresses publication to a retired operation even when the
underlying libc call cannot be interrupted. The bounded pool and result queue have
explicit capacities; saturation returns a retryable DNS error instead of creating
unbounded threads or queued requests.

### Optional Rustls

TLS is optional and implemented through the `node-tls` Cargo feature in the existing
`mal_rust` static library. The C ABI is flat and opaque: create/free client state,
set server name and trust configuration, feed/drain TLS records, read/write
plaintext, inspect wants-read/wants-write, and extract a structured alert/error.
Rust owns Rustls objects and allocations; C owns sockets, DNS, reactor registration,
timeouts, operation state, and all buffers passed across the ABI.

Client trust and hostname policy is resolved before DNS begins. The Node adapter
retains that policy across address retries, while each transport owns a fresh TLS
session installed before reactor activation. Queued application writes therefore
stay encrypted even when a connection attempt fails or the caller ends early.

The TLS feature must be absent from Cargo resolution and final links when disabled.
An HTTP-only build has no Rustls symbols, trust store, or TLS code/data. Enabling TLS
does not enable HTTP/2. Certificate and hostname verification are on by default;
custom roots and `rejectUnauthorized` are explicit caller policy.

### Build gates

Feature selection must preserve these configurations:

| Configuration           | Required result                                                            |
| ----------------------- | -------------------------------------------------------------------------- |
| Bare engine/test262     | No host, llhttp, networking, or Rustls references in the final binary      |
| Host without HTTP users | Reactor/timers link; llhttp and Rustls are dead-code eliminated            |
| HTTP/1, TLS off         | llhttp links from `libMalHost.a`; no Rustls Cargo feature or symbols       |
| HTTP/1, TLS on          | Same C host plus the `node-tls` feature in the existing `libmal_rust.a`    |
| WinterTC only           | WinterTC adapter over the neutral ABI; no Node adapter symbols             |
| Node only               | Node adapter over the same ABI; no WinterTC object dependency              |
| WinterTC and Node       | One C transport implementation, two runtime adapters, no duplicate reactor |

The resolved feature set, llhttp source digest/version, Cargo features, C defines,
and platform link arguments must participate in the content-addressed native cache
keys used by `src/runtime-build.ts` and `src/rust-build.ts`. Feature mismatch must
fail before compilation. CI must inspect symbols and binary size for disabled
features rather than relying only on source preprocessor guards.

## Verification requirements

Verify framing and raw-byte preservation, bounded buffering, exactly-once completion,
cancellation races, and teardown through public adapter APIs. Use GC stress and
sanitizers where ownership crosses tasks. When fuzzing, target the callback adapter,
framing state, and operation-state transitions.

Use [testing](../testing.md) for the selected gates and
[benchmarking](../benchmarking.md) for matched throughput, latency, memory, and size
comparisons. Unfinished coverage belongs in
[the host roadmap](../../TODO.md#active-host-work).

## Consequences

The neutral host ABI is lower-level than either WinterTC or Node and requires each
personality to maintain rooted adapter state. In return, transport correctness,
pooling, DNS, TLS, backpressure, and cancellation are implemented once without
forcing one runtime's object model onto the other.

The ordered task, stream, raw-header, and terminal-operation contracts permit later
protocols without forcing their abstractions into the HTTP/1 implementation.
