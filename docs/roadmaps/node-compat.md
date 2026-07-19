# Node and Express compatibility roadmap

The initial compatibility target is the unmodified CommonJS release
`express@5.2.1`, running with its unmodified dependency tree from
`tests/fixtures/express-5/package-lock.json`. Express 5 and several locked
dependencies require Node 18 or newer, so compatibility follows modern Node
behavior rather than historical Node quirks.

The fixture is both a real-Node baseline and a Maligator native acceptance target.
The suite now runs its unmodified smoke program through Maligator's inbound server
and outbound client in compiled and interpreted modes, including GC stress.

## Milestones

Milestones are ordered; each one is complete only when the fixture reaches the
stated acceptance point without patching Express or anything in `node_modules`.

- [x] **Wave 0: freeze the target.** Add a fixture-local manifest and npm
      lockfile with the direct dependency exactly `express@5.2.1`. Provide a
      CommonJS application and a Node-only smoke runner covering every behavior
      in the final milestone. Confirm `npm install` and `npm run smoke` on real
      Node. Do not add a passing expectation for Maligator yet.
- [x] **Wave 1: load the tree.** Resolve fixture-local `node_modules`, package
      entry points, relative JavaScript files, and JSON modules. Implement
      CommonJS `require`, `module`, `exports`, `require.main`, module caching,
      `__filename`, and `__dirname`, plus the Node globals used by the tree such
      as `process` and `Buffer`. Acceptance is loading `app.js` through
      `require()` with the exact lockfile install and no application edits.
      Static CommonJS wrappers, JSON modules, canonical bare/`node:` built-ins,
      cache identity/cycles/failure eviction, and identifier-level `__filename` /
      `__dirname` are implemented. Global `Buffer` and canonical bare/`node:buffer`
      imports now share one DCE-aware installer. Package boundaries stop goal lookup,
      `require` and `import` select their matching package export conditions, and the
      pinned `app.js` graph loads without application or dependency edits.
- [x] **Wave 2: supply core data and event primitives.** Support the built-in
      modules needed before network service: events, buffers and string
      decoding, streams, utilities, async context hooks, crypto helpers,
      filesystem/path helpers, URLs, query strings, TTY detection, and zlib.
      Acceptance is constructing the Express application and middleware stack
      without unresolved built-ins or initialization failures.
      `node:events` now provides the EventEmitter lifecycle required by the tree;
      `node:tty` and the dependency-used `node:util` formatting/inheritance helpers
      are also implemented. `node:buffer` now provides Uint8Array-backed allocation,
      conversion, comparison, concatenation, slicing, writing, UTF-8/Latin-1/base64/
      UTF-16 encodings, and the integer primitives used by `iconv-lite`; a native
      smoke test loads Express's real `safer-buffer` dependency. The Express
      graph now gives every modern bare core name precedence over npm packages.
      Curated `node:async_hooks` `AsyncResource`, incremental `node:string_decoder`,
      and in-memory `node:stream` Readable/Writable/Duplex/Transform foundations are
      implemented in compiled and interpreted modes, including GC-stress and
      sanitizer coverage. Native zlib, crypto, URL/query-string/net/OS companions,
      V8-compatible stack capture, process stdio, and Node-global text encoding now
      close initialization. `tests/native/node-companions.test.ts` constructs the
      unmodified Express application in compiled and interpreted builds with the web
      surface disabled, and exercises fragmented/reverse installation plus GC stress.
- [ ] **Wave 3: supply Node HTTP lifecycle semantics.** Implement the required
      `node:http` and `node:net` client, server, socket, request, and response
      behavior, including EventEmitter integration, headers, status codes,
      streaming bodies, `http.request`, response completion,
      `listen(0, "127.0.0.1")`, `server.address()`, and asynchronous
      `server.close(callback)`. Acceptance is starting the fixture on an ephemeral
      port, driving its smoke requests through `node:http`, and closing it cleanly.
      The server initialization floor (`METHODS`, `IncomingMessage`,
      `ServerResponse`, response-header helpers, and buffered `write`/`end`) is
      implemented. Per-realm `Server` and `createServer` inherit EventEmitter
      behavior and wire Express as the `request` listener. Real ephemeral IPv4
      listeners report the kernel address and emit ordered asynchronous lifecycle
      events. Parsed requests are copied into runtime macrotasks, dispatched as
      rooted Readable `IncomingMessage` objects, and paired with buffered
      `ServerResponse` objects whose completion follows the native write. Focused
      coverage exercises compiled/interpreted dispatch, request bodies, keep-alive,
      HEAD/no-body framing, close-after-response, reentrancy, GC stress, and UBSan.
      A buffered `http.request` client now covers localhost/numeric-IPv4 loopback,
      request headers and bodies, status/response headers, response bodies, and
      connection errors. The remaining slices are streaming/backpressure and richer
      socket, header, status, URL/options, cancellation, and connection-reuse behavior.
- [x] **Wave 4: pass the Express behavior baseline.** Run the existing smoke
      runner under Maligator and match real Node for route dispatch, decoded
      route parameters, repeated query values, ordered application/route/async
      middleware, automatic forwarding of async rejections, JSON and
      URL-encoded request bodies, cookie serialization, redirects, custom 404
      handling, custom error middleware, ephemeral listen, and graceful close.
      Only at this point should the fixture become a Maligator test expected to
      pass. The externally driven unmodified-Express checkpoint now covers route
      parameters, repeated query values, ordered async middleware, JSON and
      URL-encoded bodies, cookies, redirects, async rejection forwarding, and custom
      error middleware in normal and GC-stress runs. `tests/native/express-smoke.test.ts`
      now compiles and runs the fixture's own unchanged smoke program in compiled and
      interpreted modes, normal and GC-stress, with UBSan coverage. Its harness-only
      `node:assert/strict` dependency has the `equal`, `deepEqual`, and `match` subset
      used by this fixture; that module is not yet a general Node assertion surface.
- [x] **Benchmark native Express serving.** After the behavior baseline is green,
      add a representative unmodified-Express request mix to the consolidated
      `npm run bench` HTTP tracker. Record binary-size, throughput, and latency
      baselines before optimizing the buffered adapter or replacing it with the
      streaming transport, so compatibility work cannot hide performance regressions.
      The tracker now measures a six-route mix plus JSON and URL-encoded POSTs against
      Node, with compiled binary size, request throughput, and p99 latency. The first
      clean baseline is recorded at `1b7734a`.
- [ ] **Close measured Express performance gaps.** Keep a profiling-driven performance
      lane beside compatibility work, preserving fixture behavior and bare-server
      throughput. Servicing deferred GC polls at safe host macrotask boundaries reduced
      five-second route-load RSS from roughly 2.1 GiB to 20 MiB and raised the clean
      route baseline to 12,235 req/s (0.25x Node), with JSON at 9,240 req/s (0.20x) and
      form parsing at 6,943 req/s (0.16x). Next target measured call-dispatch,
      string/RegExp, property-lookup, and object-shaping costs rather than endpoint
      shortcuts.

## Likely built-ins

The following production built-ins are referenced by Express and the installed
locked dependency sources. Both `node:` and legacy bare specifiers must resolve
to the same built-in where the tree uses both forms.

- `node:http`: HTTP constants, request/response prototypes, and server creation.
- `node:net`: IP address validation and the TCP substrate used by HTTP.
- `node:events`: `EventEmitter`, inherited throughout Express and Node streams.
- `node:stream`: response/file streaming, piping, and body consumption.
- `node:buffer`: body chunks, response payloads, and encoding conversions.
- `node:string_decoder`: incremental decoding through `iconv-lite`.
- `node:async_hooks`: async resource preservation used by body completion paths.
- `node:crypto`: ETag generation and signed-cookie helpers.
- `node:zlib`: compressed request-body handling in `body-parser`.
- `node:fs` and `node:path`: view/static/send initialization and path handling.
- `node:url` and `node:querystring`: request URL parsing and the default simple
  query parser.
- `node:util`: inheritance and inspection helpers used by dependencies.
- `node:tty`: terminal/color detection in `debug`.
- `node:os`: release metadata used by terminal color detection.

The Node-only smoke runner additionally imports `node:assert/strict` and
`node:http`. These are harness requirements, not additional Express production
dependencies. Only the three strict assertion methods exercised by this runner are
currently implemented.

## Baseline workflow

Run from `tests/fixtures/express-5/`:

```sh
npm install
npm run smoke
```

`node_modules` remains ignored. The manifest, lockfile, application, and smoke
runner are the only fixture inputs that should be versioned.
