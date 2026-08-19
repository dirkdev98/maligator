# WinterTC minimum common web API roadmap

## Baseline and scope

The capability inventory records the gap between Maligator's optional
`surface.webPlatform` and
[ECMA-429, 1st edition, December 2025](https://ecma-international.org/publications-and-standards/standards/ecma-429/).
The fixed inventory reference is that 2025 snapshot. The
[living draft](https://min-common-api.proposal.wintertc.org/) observed on 17 July
2026 identifies itself as the 28 April 2026 draft; its common API index is also
tracked so that the implementation does not immediately drift. The draft source
was WinterTC commit `fe94bc2b0e349d7aae635c27c653b5165039ab66`.

ECMA-429 requires the listed interfaces and properties to follow their referenced
web standards. Merely exposing a constructor is not conformance. The status below
therefore means:

- **Partial (P):** useful code exists, but required surface or semantics are known
  to differ.
- **Missing (M):** no web-platform implementation was found. A similarly named
  Node host module does not count.

This is a source inventory, not a conformance claim. The pinned server-main WPT
runner and exact expectation policy live under `tests/wpt/`. ECMA-262 correctness
remains owned by [`test262.md`](test262.md). Workers are not required by ECMA-429
and are out of scope until Maligator defines a worker global.

### Active compatibility target

The implementation target is the complete ECMA-429 surface except WebAssembly.
Server applications still determine implementation order: Fetch, Streams, URL,
encoding, Headers, Blob/File/FormData, compression, crypto, timers, performance,
base64, structured clone, abort, and exception reporting land first. Required
message-port APIs, global aliases, event subclasses, and global event handlers are
roadmap commitments rather than deferred inventory. Workers remain outside the
target because ECMA-429 does not require a worker host. WebAssembly is the sole
intentional conformance exception and must remain documented as such.

## Capability matrix

| ECMA-429 area                                        | Status | Remaining gap or disposition                                                                                                                                                                                                                      |
| ---------------------------------------------------- | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `console`                                            |   P    | Complete Console Standard formatting/behavior coverage, descriptors, grouping/counting/timing/table methods, and applicable WPT.                                                                                                                  |
| `Event`, `EventTarget`                               |   P    | Web IDL branding/descriptors, remaining event state, listener objects/options (`capture`, `passive`, `signal`), remaining mutation/reentrancy cases, and exception reporting.                                                                     |
| `AbortController`, `AbortSignal`                     |   P    | Complete Web IDL range/coercion behavior and weak dependent-signal lifetime details; integrate cancellation into fetch, then expand the applicable abort WPT corpus.                                                                              |
| `CustomEvent`, `ErrorEvent`, `PromiseRejectionEvent` |   P    | Complete CustomEvent Web IDL coverage, then implement ErrorEvent and PromiseRejectionEvent state, descriptors, and exception/rejection integration.                                                                                               |
| `MessageEvent`, `MessageChannel`, `MessagePort`      |   M    | Implement messaging, entanglement/lifetime rules, task delivery, and transferable ports.                                                                                                                                                          |
| `DOMException`                                       |   P    | Apply it to remaining streams and fetch errors; close stack, descriptor, serialization, and Web IDL details with WPT.                                                                                                                             |
| `Headers`                                            |   P    | Close Proxy/Web IDL record behavior and residual descriptors, then expand applicable WPT alongside outbound fetch.                                                                                                                                |
| `Request`, `Response`, Body mixin                    |   P    | Add exact BodyInit-union validation, arbitrary `ReadableStream` bodies and asynchronous consumption, the complete Blob platform object, `formData()`, multipart and URL-encoded extraction, remaining constructor properties, and applicable WPT. |
| global `fetch()`                                     |   M    | Outbound HTTP(S), redirects, abort, streamed upload/download, decompression, URL/headers integration, error mapping, and a documented server-runtime origin policy.                                                                               |
| `Blob`, `File`, `FormData`                           |   M    | Implement branded immutable Blob storage/slicing/streaming, File metadata, ordered FormData entries, multipart parsing/serialization, `Body.formData()` multipart and URL-encoded extraction, and complete BodyInit integration.                  |
| Web Streams interfaces                               |   P    | Complete residual byte-stream pull-into/error edge cases, then add transform streams, remaining error/cancellation coverage, and encoding/compression integration.                                                                                |
| `TextEncoder`, `TextDecoder`                         |   P    | Additional decoder labels/encodings, remaining Web IDL coercion/descriptor details, and the complete Encoding Standard corpus.                                                                                                                    |
| `TextEncoderStream`, `TextDecoderStream`             |   M    | Build as TransformStream adapters after core streams and encoding state are correct.                                                                                                                                                              |
| `CompressionStream`, `DecompressionStream`           |   M    | Add the complete web format and direction surface, chunk/error/flush behavior, and cancellation-safe native state.                                                                                                                                |
| `URL`                                                |   P    | Complete remaining Web IDL behavior and the broader URL WPT corpus, and connect object URLs when Blob lands.                                                                                                                                      |
| `URLSearchParams`                                    |   P    | Close remaining Web IDL descriptors/coercions, secondary-realm coverage, and the broader URL WPT corpus.                                                                                                                                          |
| `URLPattern`                                         |   M    | Implement the URL Pattern Standard after URL behavior is WPT-backed.                                                                                                                                                                              |
| `Crypto`, global `crypto`                            |   P    | Real `Crypto` interface/branding, exact WebCrypto exceptions and integer-array rules, plus `crypto.subtle`.                                                                                                                                       |
| `CryptoKey`, `SubtleCrypto`                          |   M    | Key lifecycle and the ECMA-429 WebCrypto Level 2 algorithm surface, with constant-time audited/native primitives.                                                                                                                                 |
| `Performance`, global `performance`                  |   P    | Add the `Performance` interface/branding and prototype descriptors, `toJSON`, time coarsening policy, and isolate-owned clock state.                                                                                                              |
| `atob`, `btoa`                                       |   P    | Complete Web IDL coercion and the full base64 corpus.                                                                                                                                                                                             |
| Timers                                               |   P    | Required coercions/errors, nesting clamp and overflow rules, exception reporting, isolate-owned timer state, and the chosen server-global rule for string handlers. Non-callables currently return id 0.                                          |
| `queueMicrotask`                                     |   P    | Report callback exceptions through the global error mechanism rather than silently discard them; verify task/microtask ordering.                                                                                                                  |
| `structuredClone`                                    |   P    | DataView cloning, Blob/File and other active platform types, `MessagePort` transfer, plus remaining property/realm details.                                                                                                                       |
| `reportError`                                        |   M    | Define server-runtime exception reporting and wire uncaught exceptions exactly once.                                                                                                                                                              |
| `navigator.userAgent`, `self`                        |   M    | Implement the ECMA-429-required aliases and navigator surface without emulating a Window.                                                                                                                                                         |
| Global error/rejection behavior                      |   M    | Either make the main global an `EventTarget`, or document and implement ECMA-429's permitted alternative mechanism; wire uncaught exceptions and rejection transitions exactly once.                                                              |
| WebAssembly API 2 surface                            |   M    | Sole intentional compatibility exception; publish it explicitly wherever WinterTC compatibility is reported.                                                                                                                                      |

### Existing server extension

`Mal.serve` is a **Maligator extension**, not an ECMA-429 or Fetch Standard API.
It may accept/return standard `Request` and `Response` objects, but its presence
must never be counted as global `fetch()` conformance. It currently connects the
runtime handler to the native server in `runtime/src/runtime/web_fetch.c:1285-1520` and
is exercised by `tests/native/fetch.test.ts`.

## Architecture constraints

- Keep engine, web runtime, and host transport separate. Web objects own standard
  state and algorithms; the host owns sockets, DNS, TLS, entropy, clocks, and
  reactor completions.
- Use the shared llhttp-based host transport for outbound `fetch()` and inbound
  `Mal.serve`; neither path may maintain a private HTTP parser.
- Adapt llhttp body/header events to host byte producers/consumers, then bridge
  those to Web Streams in the runtime. Do not expose llhttp buffers or socket
  ownership to JS objects. Backpressure, abort, EOF, parse failure, and teardown
  each need one completion path.
- Preserve optional linking: `surface.webPlatform: false` must not be the sole
  retaining edge for llhttp, URL, compression, TLS, or WebCrypto code. Verify this
  with no other selected personality requiring each facility. Feature dependency
  order is Streams -> bodies -> Fetch, with encoding/compression as stream adapters.
- Prefer spec algorithms and shared primitives over endpoint-specific fixes. Every
  native object needs GC tracing/finalization and stress/verification coverage.

## Active milestones

### W1: semantic substrate and shared transport boundary

- [ ] Close `DOMException` stack/descriptor/serialization details, abort Web IDL
      coercions and weak-dependent lifetime semantics, shared Web IDL helpers, and
      the global exception/rejection-reporting model.
- [ ] Complete residual Web Streams BYOB descriptor and error semantics, transform
      streams, remaining error/cancellation WPT, and server integrations.
- [ ] Bridge the host H2 llhttp heads/body streams to Web Streams without
      exposing parser buffers or socket ownership.

Exit: active stream and abort WPT slices are green; host H2 owns llhttp transport
fragmentation, limits, framing, pipelining, cancellation, and cleanup tests.

### W2: bytes, bodies, URL, and transforms

- [ ] Complete BodyInit validation, arbitrary streams, BYOB, `tee()`,
      Blob/File/FormData, multipart serialization/parsing, URL-encoded extraction,
      and `formData()`.
- [ ] Close remaining Headers guards and Web IDL behavior, broader URL and
      URLSearchParams semantics, and URLPattern.
- [ ] Add remaining TextDecoder labels and Web IDL details, then implement
      TextEncoderStream and TextDecoderStream over TransformStream.
- [ ] Add compression/decompression streams over a DCE-friendly backend.

Exit: curated File API, XHR FormData, URL, Encoding, Streams, Compression, Headers,
Request, and Response constructor/body WPT slices are green.

### W3: network fetch and crypto

- [ ] After host H3 adds connection pooling and H4 closes production gates, implement
      the global `fetch()` adapter over the shared streaming HTTP and optional TLS
      layers, including redirects, abort/error mapping, limits, and one finalization
      path.
- [ ] Define server-runtime origin, credentials/cache, default `User-Agent`, and
      decompression policies, documenting every intentional Fetch divergence.
- [ ] Complete `Crypto`, `CryptoKey`, and `SubtleCrypto` with audited primitives and
      exact WebCrypto errors; retain the engine-neutral entropy boundary.

Exit: local deterministic Fetch/WPT server cases and WebCrypto vectors are green in
normal, interpreter where applicable, GC-stress, sanitizer, and cancellation runs.

### W4: compatibility closure

- [ ] Complete exception reporting, `reportError`, console, timers, performance,
      base64, messaging, event subclasses/global handlers, required global aliases,
      and structured-clone residuals.
- [ ] Expand from curated manifests to every applicable ECMA-429 WPT, publish the
      WebAssembly exception, and remove all stale expected failures.

Exit: every required non-WebAssembly global exists, the applicable pinned suite has
no unexpected results, the sole exception is published, and `Mal.serve` remains
clearly identified as an extension.

## Intentional exception

WebAssembly remains outside the compatibility target. No other required ECMA-429
area is deferred merely because it is less common in server applications.

## Status maintenance

Update a row only with implementation and test evidence. A constructor's existence
can move **M** to **P**; remove a row only after applicable WPT coverage and review
leave no material gap. Keep raw counts and verdicts in generated test output once a
harness exists; do not hand-maintain them here.
