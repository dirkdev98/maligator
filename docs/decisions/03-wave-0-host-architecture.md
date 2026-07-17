# Wave 0 host architecture

- Status: accepted
- Scope: HTTP/1.1 client and server transport, DNS, optional TLS, streaming host ABI,
  cancellation, and event-loop integration
- Roadmap: [Isolate, reactor, and host roadmap](../roadmaps/isolate-reactor.md)

## Context

Maligator already has the right coarse layers but not yet the contracts needed for a
production network host:

- `src/runtime-build.ts` builds `libLibMaligator.a`, `libMalHost.a`, and
  `libMalRuntime.a` separately. The engine exposes `MalVm.host` as opaque storage;
  `runtime/src/host/host.h` attaches the concrete host to it.
- `runtime/src/host/reactor.h` presents one-shot completions over kqueue or epoll,
  but completion storage is caller-owned and callbacks run directly while the
  backend is being drained.
- `runtime/src/host/net.c` owns non-blocking POSIX sockets, but supports only numeric
  IPv4 addresses. There is no DNS, IPv6, connection pool, or client TLS transport.
- `runtime/src/host/http.c` is a project-local request parser and dechunker.
  `runtime/src/host/server.c` buffers each complete request and response, invokes a
  process-global handler, and can retain an untyped connection pointer across an
  asynchronous runtime call.
- `runtime/src/runtime/fetch.c` is a WinterTC-specific adapter over that server. It
  copies complete bodies and converts raw transport headers directly into the
  runtime `Headers` representation in `runtime/src/runtime/headers.c`.
- `runtime/src/runtime/host_timer.c` currently keeps runtime timer state in
  `MalHost`. Its event loop already attempts one timer macrotask followed by a
  microtask checkpoint, while socket callbacks bypass that macrotask boundary.
- `runtime/rust/Cargo.toml` and `src/rust-build.ts` already build one optional-feature
  Rust static library. This is the required integration point for Rustls; a second
  Rust static library would duplicate Rust runtime symbols.

The current native acceptance tests in `tests/native/server.test.ts` and
`tests/native/fetch.test.ts` prove basic HTTP/1.1 keep-alive, fixed-length bodies,
chunked request decoding, and synchronous/asynchronous WinterTC handlers. They do
not establish bounded streaming, DNS, cancellation races, raw-header fidelity, or
client-side `fetch()`.

## Decision

### Protocol and dependency boundary

HTTP/1.1 is the only protocol implemented in Waves H0-H4. HTTP/2, HTTP/3, upgrades,
and WebSockets require later decisions; none may distort the HTTP/1 streaming ABI.

The host will use **llhttp** for HTTP/1 request and response syntax, incremental
parsing, and message framing. We will pin an upstream release and compile its C
sources into `libMalHost.a`. The lock/pin, license, generated-source provenance, and
llhttp ABI/version assertion are build inputs. We will not maintain an independent
HTTP grammar or dechunker after H2.

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

`libMalHost.a` must eventually compile without `vm.h`. The temporary attachment in
`runtime/src/host/host.h` may remain as entry/embedder glue, but protocol modules
must receive `MalHost *` and opaque handles, never `MalVm *`. Runtime timer lists
move out of `MalHost`; the host provides clock/timer tasks while each personality
owns callback values and GC roots.

### Proposed host ABI

Names may be adjusted for C style during H1, but the handle, buffer, task, and credit
semantics are normative. The implementation API must have this shape rather than
callbacks into a runtime:

```c
typedef u64 MalHostOp;
typedef u64 MalHostStream;
typedef u64 MalHostListener;

typedef struct MalHostSlice {
    const byte *ptr;
    usize len;
} MalHostSlice;

typedef struct MalHostHeader {
    MalHostSlice name;
    MalHostSlice value;
} MalHostHeader;

typedef struct MalHostError {
    MalHostErrorDomain domain;
    i32 code;             /* errno, resolver code, TLS alert, or HTTP reason */
    MalHostPhase phase;   /* resolve/connect/handshake/read/write/parse/shutdown */
    bool retryable;
} MalHostError;

typedef struct MalHostTask {
    MalHostTaskKind kind;
    MalHostOp op;
    MalHostStream stream;
    MalHostBuffer *bytes;
    const MalHostHeader *headers;
    usize header_count;
    MalHostError error;
    bool end_stream;
} MalHostTask;

MalHostStart mal_host_http_request_start(
    MalHost *, const MalHostHttpRequest *, MalHostOp *, MalHostStream *upload);
MalHostStart mal_host_http_listen(
    MalHost *, const MalHostListenOptions *, MalHostListener *);
MalHostWrite mal_host_stream_write(
    MalHost *, MalHostStream, MalHostBuffer *, bool end_stream);
bool mal_host_stream_read_credit(MalHost *, MalHostStream, usize bytes);
bool mal_host_cancel(MalHost *, MalHostOp, MalHostError reason);
bool mal_host_next_task(MalHost *, MalHostWaitMode, MalHostTask *);
void mal_host_task_release(MalHost *, MalHostTask *);
```

`MalHostTaskKind` must cover incoming request/response heads, body data, write
capacity, and one terminal completion. Server response heads use the same ordered
header and stream primitives as client request heads. DNS and connect remain
internal stages of the HTTP operation; a lower-level TCP personality may expose
the same stream/task substrate without importing HTTP types.

The ABI uses integer handles with generation checks, not host pointers encoded as
JavaScript numbers. Stale or cross-host handles return a synchronous invalid-handle
result and cannot address a reused operation slot.

### Ownership and lifetime

- `MalHost` is owned by one embedder and confined to its reactor thread. Only the
  DNS worker completion queue and wake primitive are cross-thread. Workers receive
  copied inputs and publish copied address results; they never access operations,
  parsers, VM state, or runtime objects directly.
- The host owns an operation from successful `start` through release of its terminal
  task. The runtime adapter owns only its handle and its rooted JS state. A start
  failure creates no handle and queues no task.
- The host owns listeners, socket descriptors, parser state, DNS requests,
  connections, and pooled idle connections. Closing an operation does not close a
  reusable connection until framing says it is unsafe to reuse.
- Request specifications and header arrays are deep-copied before `start` returns.
  No parser or socket retains a caller stack pointer.
- `MalHostBuffer` is immutable and reference-counted outside the GC. Passing it to
  `mal_host_stream_write` transfers one reference for the accepted range. Task
  payloads and header slices are borrowed until `mal_host_task_release`; adapters
  must retain a buffer or copy data they need afterward.
- Header storage belongs to the head task. Releasing that task invalidates every
  header slice. Body tasks each own a separate buffer lease.
- Runtime adapters remove roots and release operation state only after consuming the
  terminal task. Host shutdown first cancels all live operations, drains their
  terminal tasks without invoking JS, joins DNS workers, closes descriptors, and
  then frees host storage. VM teardown follows host/runtime detachment.

### Header and framing contract

The transport header list is not the WinterTC `Headers` object.

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

The default limits are 64 KiB per start-line-plus-header block, 16 KiB per field,
256 fields, and 64 KiB per emitted body buffer. They are host options with finite
hard maxima. There is no default whole-body limit because bodies are streamed.

### Backpressure

Read and write flow control are explicit and bounded:

- A stream starts with zero read credit. The host emits no body-data task until the
  adapter grants bytes with `mal_host_stream_read_credit`. One data task consumes
  credit by its payload length; EOF may be delivered with zero credit.
- Per stream, granted but not yet delivered read credit is capped at 256 KiB and an
  emitted chunk at 64 KiB. When credit reaches zero, socket reads stop except for
  bounded parser/framing progress already resident in the connection buffer.
- `mal_host_stream_write` either accepts a stated byte count and owns that range or
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
  requests behind an unfinished response. Client pooling is one in-flight request
  per connection in H3; pipelined client requests are out of scope.

### Completion, error, and cancellation contract

Every successfully started operation produces exactly one terminal task with one of
`OK`, `ERROR`, or `CANCELLED`. Head and body tasks are progress, never completion.

The reactor thread is the linearization point. Operation state follows:

```text
STARTING -> ACTIVE -> TERMINAL_QUEUED -> RELEASED
                   \-> CANCELLING --/
```

- `mal_host_cancel` is idempotent and may be called in any state. It records intent
  and wakes the reactor; it never calls the runtime or frees adapter state inline.
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

Errors are data, not strings. `MalHostErrorDomain` includes `SYSTEM`, `DNS`, `TLS`,
`HTTP_SYNTAX`, `HTTP_FRAMING`, `LIMIT`, `TIMEOUT`, `CANCELLED`, and `SHUTDOWN`.
`code` retains the native diagnostic and `phase` identifies where it occurred.
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
and cross-thread wakes all become host tasks. This replaces the direct callback
execution in `runtime/src/host/reactor.c` and `runtime/src/host/server.c` and extends
the one-timer-per-turn intent already documented in
`runtime/src/runtime/host_timer.c`. FIFO order is required within one task source;
cross-source ordering is the order in which the reactor thread enqueues tasks.

### DNS and sockets

The C host owns address parsing, DNS scheduling, Happy Eyeballs connection attempts,
socket options, and descriptor teardown. H1 adds `getaddrinfo` work on a bounded
thread pool because kqueue/epoll do not make libc DNS asynchronous. Results include
IPv6 and IPv4 addresses and are consumed only on the reactor thread. The initial
Happy Eyeballs policy follows RFC 8305 with a configurable 250 ms fallback delay;
tests use an injected resolver/clock to avoid timing dependence.

Resolver cancellation suppresses publication to a retired operation even when the
underlying libc call cannot be interrupted. The bounded pool and result queue have
explicit capacities; saturation returns a retryable DNS error instead of creating
unbounded threads or queued requests.

### Optional Rustls

TLS is optional and implemented through a new `rustls` Cargo feature in the existing
`mal_rust` static library. The C ABI is flat and opaque: create/free client state,
set server name and trust configuration, feed/drain TLS records, read/write
plaintext, inspect wants-read/wants-write, and extract a structured alert/error.
Rust owns Rustls objects and allocations; C owns sockets, DNS, reactor registration,
timeouts, operation state, and all buffers passed across the ABI.

The TLS feature must be absent from Cargo resolution and final links when disabled.
An HTTP-only build has no Rustls symbols, trust store, or TLS code/data. Enabling TLS
does not enable HTTP/2. Certificate and hostname verification are on by default;
custom roots are explicit host options, and an insecure verifier is test-only.

### Build gates

Each checkpoint must keep these configurations green:

| Configuration           | Required result                                                            |
| ----------------------- | -------------------------------------------------------------------------- |
| Bare engine/test262     | No host, llhttp, networking, or Rustls references in the final binary      |
| Host without HTTP users | Reactor/timers link; llhttp and Rustls are dead-code eliminated            |
| HTTP/1, TLS off         | llhttp links from `libMalHost.a`; no Rustls Cargo feature or symbols       |
| HTTP/1, TLS on          | Same C host plus the `rustls` feature in the existing `libmal_rust.a`      |
| WinterTC only           | WinterTC adapter over the neutral ABI; no Node adapter symbols             |
| Node only               | Node adapter over the same ABI; no WinterTC object dependency              |
| WinterTC and Node       | One C transport implementation, two runtime adapters, no duplicate reactor |

The resolved feature set, llhttp source digest/version, Cargo features, C defines,
and platform link arguments must participate in the content-addressed native cache
keys used by `src/runtime-build.ts` and `src/rust-build.ts`. Feature mismatch must
fail before compilation. CI must inspect symbols and binary size for disabled
features rather than relying only on source preprocessor guards.

## Verification requirements

### Tests

- Unit-test handle generations, task FIFO order, buffer reference ownership, read
  credit, write high/low water marks, and every state transition in the
  exactly-once table.
- Use injected reactor, resolver, clock, and short-read/short-write transports to
  deterministically cover DNS completion after cancel, timeout versus success,
  cancel during connect/TLS/head/body/write/idle-pool, duplicate readiness, peer
  half-close, and host teardown with live operations.
- Test llhttp with every possible split point and byte-at-a-time input for request
  and response start lines, fields, fixed-length bodies, chunk extensions, trailers,
  and EOF-delimited responses. Include duplicate fields and mixed field-name case.
- Add a request-smuggling corpus: conflicting/duplicate `Content-Length`, all
  `Transfer-Encoding`/`Content-Length` combinations, malformed chunks, obs-fold,
  invalid tokens/control bytes, premature EOF, oversized lines/fields/counts, and
  surplus bytes before a pipelined message.
- Extend native loopback tests for streaming upload/download, pause/resume under
  backpressure, keep-alive reuse and non-reuse, pipelining response order, raw header
  order/case, `Set-Cookie`, trailers, compressed bytes passed unchanged, DNS
  IPv4/IPv6 fallback, abort, timeout, and handler rejection.
- Run the same neutral transport fixtures through WinterTC and Node adapters. Their
  object-level assertions differ, but captured wire bytes and terminal host records
  must match.
- Run targeted native tests under UBSan on macOS and ASan+UBSan on Linux, plus
  `MAL_GC_STRESS`/`MAL_GC_VERIFY` for adapters retaining JS state across tasks.

### Fuzzing

- Fuzz the llhttp callback adapter and framing state machine, not llhttp alone. The
  harness fragments arbitrary input, enforces allocation/field limits, and checks
  that success consumes a deterministic prefix and failure never resumes parsing.
- Fuzz serialization from arbitrary ordered raw headers and body boundaries. Parse
  the output again and assert framing, byte preservation, and no CR/LF injection.
- Maintain seed corpora from llhttp, HTTP conformance cases, smuggling advisories,
  and every fixed parser bug. CI runs a bounded smoke corpus; scheduled jobs run
  sanitizers for at least 30 minutes per target. Every crash becomes a checked-in
  regression input.
- Add a randomized operation-state harness that permutes readiness, DNS, timeout,
  cancellation, shutdown, and task release. Its invariants are one terminal task,
  no progress after cancellation wins, no live resources after release, and no task
  referencing a retired generation.

### Benchmarks

Record the pre-H1 fixed-response server as the migration baseline, then track:

- loopback requests/second and p50/p95/p99 latency for 0 B, 1 KiB, and 1 MiB bodies;
- concurrent keep-alive at 1, 32, 256, and 1,024 connections;
- streaming upload/download with a deliberately slow consumer;
- peak RSS and host allocations per connection/request;
- HTTP-only and TLS-enabled binary size;
- optional out-of-tree Hyper results on the same machine and harness as a reference,
  never as a correctness oracle or product dependency.

H2 and H3 cannot merge with more than a 10% throughput regression, 15% p99 latency
regression, or unbounded/whole-body memory growth relative to the preceding
checkpoint without an explicit recorded exception. A paused stream must remain
within its configured connection budget plus one 64 KiB task buffer. Benchmark
entries record compiler, optimization mode, OS, CPU, llhttp version, TLS setting,
and commit.

## Checkpoints

### H0: contract accepted

- This decision and the linked roadmap are the source of truth.
- Record current server/fetch behavior and benchmark commands before replacing code.
- Reject implementation proposals that add Hyper, bypass task dispatch, expose host
  pointers, buffer whole bodies, normalize raw headers, or auto-decompress.

Exit gate: ownership, cancellation, backpressure, errors, one-task turns, build
variants, and H1-H4 work can be reviewed without unresolved architectural choices.

### H1: neutral task and stream substrate

- Replace direct reactor wakers with a host task queue and pollable wake source.
- Implement generated handles, buffer leases, terminal-task accounting, bounded
  turn work, non-blocking and blocking one-turn pumps, and injected test backends.
- Move timer callback/root state out of `MalHost`; timers enqueue neutral tasks.
- Add bounded DNS workers, IPv6, Happy Eyeballs, and structured errors.

Exit gate: deterministic race tests prove exactly-once completion/cancellation;
engine and host archives respect the layering/build matrix; no HTTP behavior changes.

### H2: llhttp HTTP/1 server and streaming codec

- Pin/build llhttp and replace `runtime/src/host/http.c` parsing/dechunking.
- Rebuild the server over neutral heads, streams, raw headers, and terminal tasks.
- Enforce limits, framing/smuggling rules, backpressure, trailers, keep-alive, and
  ordered pipelining. Remove the process-global runtime handler seam.
- Land parser/serializer fuzz targets and migration benchmarks.

Exit gate: existing server/fetch tests plus the H2 matrix pass; byte-at-a-time,
raw-header, cancellation, slow-consumer, sanitizer, fuzz-smoke, and benchmark gates
pass.

### H3: outbound HTTP/1 client and both adapters

- Add connection pooling, DNS/connect timeouts, streaming request and response
  bodies, and safe connection reuse to the C host.
- Implement outbound WinterTC `fetch()` and the Node HTTP client/server adapters over
  the same ABI. Redirect, abort-reason, cookie, and header-view behavior stays in
  the relevant personality.
- Prove no auto-decompression and exact raw-byte parity across personalities.

Exit gate: loopback and external-fixture client matrices pass for WinterTC and Node;
all cancellation phases and pool reuse/non-reuse cases pass; H3 benchmark gates pass.

### H4: optional TLS and production hardening

- Add the Rustls feature and flat FFI to the existing Rust archive.
- Cover trust roots, SNI/hostname verification, handshake/close alerts, TLS
  backpressure, cancellation, timeout, and pooled TLS connections.
- Complete platform CI, long fuzz/sanitizer runs, leak checks, symbol/size audits,
  and operational counters for active ops, queue depth, bytes, errors, cancels, and
  pool reuse.

Exit gate: TLS-off artifacts contain no Rustls; TLS-on WinterTC and Node matrices
pass; no known leaks, duplicate terminals, limit bypasses, or critical fuzz findings
remain. HTTP/2 is still out of scope.

## Consequences

The current parser, full-body server buffers, direct reactor callbacks, global HTTP
handler, and boxed connection pointers are migration scaffolding rather than APIs to
preserve. Replacing them is intentional.

The neutral host ABI is lower-level than either WinterTC or Node and requires each
personality to maintain rooted adapter state. In return, transport correctness,
pooling, DNS, TLS, backpressure, and cancellation are implemented once without
forcing one runtime's object model onto the other.

HTTP/1.1-first postpones multiplexing and protocol negotiation. The ordered task,
stream, raw-header, and terminal-operation contracts remain usable by a later
HTTP/2/3 implementation, but no speculative protocol abstraction is required in
H0-H4.
