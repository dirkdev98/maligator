# WinterTC minimum common web API roadmap

## Baseline and scope

Wave 0 records the gap between Maligator's optional `surface.webPlatform` and
[ECMA-429, 1st edition, December 2025](https://ecma-international.org/publications-and-standards/standards/ecma-429/).
The fixed conformance target is that 2025 snapshot. The
[living draft](https://min-common-api.proposal.wintertc.org/) observed on 17 July
2026 identifies itself as the 28 April 2026 draft; its common API index is also
tracked so that the implementation does not immediately drift. The draft source
was WinterTC commit `fe94bc2b0e349d7aae635c27c653b5165039ab66`.

ECMA-429 requires the listed interfaces and properties to follow their referenced
web standards. Merely exposing a constructor is not conformance. The status below
therefore means:

- **Implemented (I):** present with no known material gap at this inventory level;
  WPT can still find defects.
- **Partial (P):** useful code exists, but required surface or semantics are known
  to differ.
- **Missing (M):** no web-platform implementation was found. A similarly named
  Node host module does not count.

This is a source inventory, not a conformance claim. ECMA-262 correctness remains
owned by [`test262.md`](test262.md). Workers are not required by ECMA-429 and are
out of scope until Maligator defines a worker global.

### Active server-runtime profile

The active implementation profile prioritizes APIs used directly by server
applications: Fetch objects and outbound fetch, Streams, URL, encoding, Headers,
Blob/File/FormData body handling, compression, crypto, timers, performance, base64,
structured clone, abort, and exception reporting. WebAssembly, worker/message-port
APIs, browser-profile globals (`navigator` and `self`), browser event subclasses,
and browser global event-handler attributes remain inventoried but are deferred and
do not block this implementation phase. They must not be described as conforming
until restored to scope and completed.

## Capability matrix

| ECMA-429 area                                        | Status | Current capability and concrete evidence                                                                                                                                                                                                                                                                                                                                       | Required closure                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `globalThis`                                         |   I    | Installed by `runtime/src/intrinsics.c:506-513`; web globals are gated in `runtime/host_main.c:32-44`.                                                                                                                                                                                                                                                                         | Verify Web IDL descriptors and exposure with WPT.                                                                                                                                                                                                          |
| `console`                                            |   P    | `runtime/src/builtin_console.c` installs `log`, `info`, `warn`, `error`, and `trace`; string output uses the shared encoder for valid UTF-8 across BMP and supplementary characters, with raw-byte native coverage.                                                                                                                                                            | Complete Console Standard formatting/behavior coverage, descriptors, grouping/counting/timing/table methods, and applicable WPT.                                                                                                                           |
| `Event`, `EventTarget`                               |   P    | Constructors, dispatch, cancellation, and `once` are in `runtime/src/runtime/events.c:47-301` and exercised by `tests/local/events.js`.                                                                                                                                                                                                                                        | Web IDL branding/descriptors, full event state, listener objects/options (`capture`, `passive`, `signal`), mutation/reentrancy, and exception reporting.                                                                                                   |
| `AbortController`, `AbortSignal`                     |   P    | `abort`, `timeout`, `any`, reason, `throwIfAborted`, dependent propagation, and `DOMException` default reasons are in `runtime/src/runtime/events.c`; native GC-stress coverage is `tests/native/web.test.ts`.                                                                                                                                                                 | Complete Web IDL range/coercion behavior and weak dependent-signal lifetime details; integrate cancellation into streams and fetch, then run the applicable abort WPT corpus.                                                                              |
| `CustomEvent`, `ErrorEvent`, `PromiseRejectionEvent` |   M    | `runtime/host_main.c:38-43` installs only `Event`/`EventTarget` and abort classes; no runtime definitions were found.                                                                                                                                                                                                                                                          | Implement after the exception-reporting and global event model is chosen.                                                                                                                                                                                  |
| `MessageEvent`, `MessageChannel`, `MessagePort`      |   M    | No runtime definitions were found; current `structuredClone` has no ports or transfer list.                                                                                                                                                                                                                                                                                    | Entangled ports, task scheduling, close/start, message events, structured serialization, and transfer.                                                                                                                                                     |
| `DOMException`                                       |   P    | `runtime/src/runtime/events.c` installs a branded `Error`-derived constructor with name/message/code accessors, the legacy code table/constants, and abort/timeout integration; abort, timeout, base64, and structured-clone errors use it, with native fixture coverage.                                                                                                      | Apply it to remaining streams and fetch errors; close stack, descriptor, serialization, and Web IDL details with WPT.                                                                                                                                      |
| `Headers`                                            |   P    | `runtime/src/runtime/headers.c` validates and lowercases names, normalizes HTTP whitespace, supports record and sequence initialization, combines duplicates, preserves `Set-Cookie`, honors constructor/new-target semantics, and provides sorted live iteration; the pinned basic Headers WPT slice is green.                                                                | Add guards and forbidden-header policy, close remaining Proxy/Web IDL record behavior, branded standard iterator prototypes/descriptors, and expand the applicable Headers WPT corpus.                                                                     |
| `Request`, `Response`, Body mixin                    |   P    | Byte-backed string/`BufferSource` bodies expose identity-stable streams, `bodyUsed`, locking/disturbance, one-shot `text`, `json`, `arrayBuffer`, and `bytes`; JSON errors reject, cloning transfers an unused Request body, and constructor/body brands are enforced. Native compiled/interpreted, GC-stress, and sanitizer coverage is in `tests/native/fetch-body.test.ts`. | Add `ReadableStream` BodyInit and asynchronous stream consumption, byte/BYOB streams, `tee()`-based clone support, `blob()`/`formData()`, MIME handling, multipart/urlencoded extraction, remaining constructor properties/validation, and applicable WPT. |
| global `fetch()`                                     |   M    | Despite the comment at `runtime/host_main.c:40`, `mal_fetch_install` only installs `Request`, `Response`, `Headers`, and `Mal.serve` (`runtime/src/runtime/fetch.c:921-992`).                                                                                                                                                                                                  | Outbound HTTP(S), redirects, abort, streamed upload/download, decompression, URL/headers integration, error mapping, and a documented server-runtime origin policy.                                                                                        |
| `Blob`, `File`, `FormData`                           |   M    | No runtime definitions were found; fetch bodies only accept strings and `BufferSource` in `runtime/src/runtime/fetch.c:160-175`.                                                                                                                                                                                                                                               | Immutable blob storage/slicing/streaming, file metadata, ordered multipart fields, multipart and urlencoded parsing/serialization, and Body integration.                                                                                                   |
| Web Streams interfaces                               |   P    | `runtime/src/runtime/readable_stream.c` implements default `ReadableStream`, controller, and reader objects with queued and pending reads, start/pull/cancel algorithms, locking, disturbance, close/error, count-based backpressure, promises, GC-stress coverage, and byte-backed Fetch Body integration.                                                                    | Add byte/BYOB streams, custom size algorithms, writable/transform streams, tee/pipe/async iteration, transfer, WPT coverage, and integration with encoding, compression, and messaging.                                                                    |
| `TextEncoder`, `TextDecoder`                         |   P    | UTF-8 `encode`/`encodeInto` and buffered UTF-8, UTF-16LE, and UTF-16BE decoding are in `runtime/src/runtime/web_globals.c`; canonical labels, BOM policy, fatal/replacement behavior, surrogate pairs, odd bytes, branded option getters, and BufferSource byte windows have focused native and pinned WPT coverage.                                                           | Additional decoder labels/encodings, streaming state, remaining Web IDL coercion/descriptor details, and the complete Encoding Standard corpus.                                                                                                            |
| `TextEncoderStream`, `TextDecoderStream`             |   M    | No runtime definitions were found.                                                                                                                                                                                                                                                                                                                                             | Build as TransformStream adapters after core streams and encoding state are correct.                                                                                                                                                                       |
| `CompressionStream`, `DecompressionStream`           |   M    | No runtime definitions or compression backend were found.                                                                                                                                                                                                                                                                                                                      | `deflate`, `deflate-raw`, and `gzip` transforms, chunk/error/flush behavior, and cancellation-safe native state.                                                                                                                                           |
| `URL`                                                |   P    | Ada-backed parsing, components, setters, `canParse`, and stringification are in `runtime/src/runtime/url.c:67-233`; covered by `tests/native/url.test.ts`.                                                                                                                                                                                                                     | Complete Web IDL behavior and URL WPT corpus, add `URL.parse` if required by the tracked URL Standard, and connect object URLs when Blob lands.                                                                                                            |
| `URLSearchParams`                                    |   P    | Parsing, mutation, sort, serialization, optional-value `delete`/`has`, and sequence/record initialization are in `runtime/src/runtime/url.c`. Every URL eagerly owns a stable `searchParams` object; query assignment and params mutation synchronize in both directions with traced GC ownership. Snapshot iterators and focused Web IDL boundary coverage remain.            | Replace snapshot iteration with a dedicated branded live iterator and close remaining Web IDL descriptors/coercions against the URL WPT corpus.                                                                                                            |
| `URLPattern`                                         |   M    | No runtime definition was found.                                                                                                                                                                                                                                                                                                                                               | Implement the URL Pattern Standard after URL behavior is WPT-backed.                                                                                                                                                                                       |
| `Crypto`, global `crypto`                            |   P    | A plain object exposing `getRandomValues` and `randomUUID` uses host entropy in `runtime/src/runtime/web_globals.c:502-564,796-803`; covered by `tests/local/web_globals.js:102-130`.                                                                                                                                                                                          | Real `Crypto` interface/branding, exact WebCrypto exceptions and integer-array rules, plus `crypto.subtle`.                                                                                                                                                |
| `CryptoKey`, `SubtleCrypto`                          |   M    | No web crypto key or algorithm implementation was found. `node:crypto` is a separate optional host module.                                                                                                                                                                                                                                                                     | Key lifecycle and the ECMA-429 WebCrypto Level 2 algorithm surface, with constant-time audited/native primitives.                                                                                                                                          |
| `Performance`, global `performance`                  |   P    | A plain object with monotonic `now()` and `timeOrigin` is installed by `runtime/src/runtime/web_globals.c:30-39,486-500,788-794`.                                                                                                                                                                                                                                              | `Performance` interface/branding, required `EventTarget` inheritance, `toJSON`, time coarsening policy, descriptors, and isolate-owned clock state.                                                                                                        |
| `atob`, `btoa`                                       |   P    | Base64 logic and `InvalidCharacterError` `DOMException` failures are in `runtime/src/runtime/web_globals.c`; focused coverage is in `tests/local/web_globals.js`.                                                                                                                                                                                                              | Complete Web IDL coercion and the full base64 corpus.                                                                                                                                                                                                      |
| Timers                                               |   P    | Reactor-backed timeout/interval scheduling and shared cancellation IDs are in `runtime/src/runtime/host_timer.c`; ordering is covered by `tests/local/web_globals.js:132-162`.                                                                                                                                                                                                 | Required coercions/errors, nesting clamp and overflow rules, exception reporting, isolate-owned timer state, and the chosen server-global rule for string handlers. Non-callables currently return id 0 (`host_timer.c:160-183`).                          |
| `queueMicrotask`                                     |   P    | Enqueues a promise reaction job in `runtime/src/runtime/web_globals.c:465-484`.                                                                                                                                                                                                                                                                                                | Report callback exceptions through the global error mechanism rather than silently discard them; verify task/microtask ordering.                                                                                                                           |
| `structuredClone`                                    |   P    | Deep clone supports common JS containers, cycles, shared references, and `DataCloneError` `DOMException` failures in `runtime/src/runtime/web_globals.c`; covered by `tests/local/structured_clone.js`.                                                                                                                                                                        | Transfer lists/detachment, `MessagePort`, Blob/File and other platform types, plus remaining property/realm details.                                                                                                                                       |
| `navigator.userAgent`, `self`, `reportError`         |   M    | None is installed by `runtime/host_main.c:38-43` or shared intrinsics.                                                                                                                                                                                                                                                                                                         | Define the Maligator global profile, an RFC-conforming opaque default user agent, `self === globalThis`, and exception reporting.                                                                                                                          |
| Global error/rejection behavior                      |   M    | No `onerror`, `onunhandledrejection`, or `onrejectionhandled` surface or host rejection tracker was found; `globalThis` is not an `EventTarget`.                                                                                                                                                                                                                               | Either make the main global an `EventTarget`, or document and implement ECMA-429's permitted alternative mechanism; wire uncaught exceptions and rejection transitions exactly once.                                                                       |
| WebAssembly API 2 surface                            |   M    | No WebAssembly runtime, namespace, constructors, errors, compile/instantiate, streaming, `JSTag`, or validation implementation was found.                                                                                                                                                                                                                                      | Treat as a separate engine-sized dependency; streaming methods ultimately consume `Response` bodies. Do not claim ECMA-429 conformance before it lands.                                                                                                    |

### Existing server extension

`Mal.serve` is a **Maligator extension**, not an ECMA-429 or Fetch Standard API.
It may accept/return standard `Request` and `Response` objects, but its presence
must never be counted as global `fetch()` conformance. It currently connects the
runtime handler to the native server in `runtime/src/runtime/fetch.c:679-915` and
is exercised by `tests/native/fetch.test.ts`.

## Architecture constraints

- Keep engine, web runtime, and host transport separate. Web objects own standard
  state and algorithms; the host owns sockets, DNS, TLS, entropy, clocks, and
  reactor completions.
- Replace the bespoke HTTP/1 parser in `runtime/src/host/http.c` with one shared
  llhttp-based host transport. The same parser, connection state, limits, and
  framing events must drive outbound `fetch()` and inbound `Mal.serve`; neither
  path may maintain a private HTTP parser.
- Adapt llhttp body/header events to host byte producers/consumers, then bridge
  those to Web Streams in the runtime. Do not expose llhttp buffers or socket
  ownership to JS objects. Backpressure, abort, EOF, parse failure, and teardown
  each need one completion path.
- Preserve optional linking: `surface.webPlatform: false` must not retain llhttp,
  URL, compression, TLS, or WebCrypto code. Feature dependency order is Streams ->
  bodies -> Fetch, with encoding/compression as stream adapters.
- Prefer spec algorithms and shared primitives over endpoint-specific fixes. Every
  native object needs GC tracing/finalization and stress/verification coverage.

## Milestones

### W0: inventory and conformance contract

- [x] Pin ECMA-429 2025 as the baseline and record the current draft identity.
- [x] Inventory every required interface/global with repository evidence.
- [x] Define the initial curated WPT candidates and expected-failure policy in
      `tests/wpt/` without pretending that a WPT runner exists.
- [x] Add a real server-main testharness adapter, pin a WPT revision, record
      subtest-level results with exact expected failures, and run native GC-stress
      variants where the test does not depend on wall-clock precision. The curated
      lane now runs 137 subtests from 19 byte-pinned Abort, Encoding, Headers, timers,
      URL, and URLSearchParams files with no unexpected or stale normal/stress results.

Exit: no conformance claim; this document and the candidate manifests are the
reviewed baseline.

### W1: semantic substrate and shared transport boundary

- [ ] Implement `DOMException`, Web IDL conversion/branding helpers, complete abort
      composition, and the global exception/rejection-reporting model.
- [ ] Implement standard Web Streams, including byte/BYOB streams, backpressure,
      cancellation, queuing strategies, and transfer hooks.
      The default readable-stream/controller/reader vertical slice is implemented;
      byte/BYOB, writable/transform, composition, transfer, and WPT remain.
- [ ] Implement messaging interfaces and structured serialization/transfer using
      the same task queue and clone machinery.
- [ ] Introduce the host-neutral HTTP event/body contract and move both server and
      future client parsing to shared llhttp without changing `Mal.serve` into a
      standard API.

Exit: core stream/abort/messaging WPT slices are green; llhttp transport tests prove
fragmented input, limits, framing, pipelining, cancellation, and cleanup.

### W2: bytes, bodies, URL, and transforms

- [ ] Implement Blob, File, FormData, multipart/urlencoded codecs, Body mixin state,
      and stream-backed Request/Response cloning and consumption.
      Byte-backed Body state, one-shot consumption, disturbance/locking, parse-error
      rejection, and Request transfer semantics are implemented; arbitrary stream
      BodyInit, BYOB, `tee()`, Blob/FormData, and codecs remain.
- [ ] Close Headers and URL/URLSearchParams semantics, then implement URLPattern.
- [ ] Complete TextDecoder state/labels and add encoding streams. Buffered UTF-8,
      UTF-16LE, and UTF-16BE decoding is implemented; streaming state and the
      remaining Encoding Standard labels remain.
- [ ] Add compression/decompression streams over a DCE-friendly backend.

Exit: curated File API, XHR FormData, URL, Encoding, Streams, Compression, Headers,
Request, and Response constructor/body WPT slices are green.

### W3: network fetch and crypto

- [ ] Implement outbound `fetch()` over the shared llhttp transport with reactor
      DNS, IPv4/IPv6, redirects, streamed bodies, abort, limits, and one finalization
      path; add TLS as an optional host layer.
- [ ] Define server-runtime origin, credentials/cache, default `User-Agent`, and
      decompression policies, documenting every intentional Fetch divergence.
- [ ] Complete `Crypto`, `CryptoKey`, and `SubtleCrypto` with audited primitives and
      exact WebCrypto errors; retain the engine-neutral entropy boundary.

Exit: local deterministic Fetch/WPT server cases and WebCrypto vectors are green in
normal, interpreter where applicable, GC-stress, sanitizer, and cancellation runs.

### W4: global and conformance closure

- [ ] Complete server-relevant exception reporting, `reportError`, console, timers,
      performance, base64, and structured-clone residuals. Browser event subclasses,
      global event-handler attributes, navigator/self, and messaging remain deferred.
- [ ] Keep the product explicitly non-conforming while the deferred ECMA-429
      WebAssembly API 2 surface remains unimplemented.
- [ ] Expand from curated manifests to every applicable ECMA-429 WPT; classify only
      genuine server-global inapplicability, publish deviations, and remove all
      stale expected failures.

Exit: all required globals exist, the applicable pinned suite has no unexpected
results, documented deviations satisfy ECMA-429, and `Mal.serve` remains clearly
identified as an extension.

## Status maintenance

Update a row only with implementation and test evidence. A constructor's existence
can move **M** to **P**, but only applicable WPT coverage and review can move **P**
to **I**. Keep raw counts and verdicts in generated test output once a harness
exists; do not hand-maintain them here.
