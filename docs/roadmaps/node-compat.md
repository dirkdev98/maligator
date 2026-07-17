# Node and Express compatibility roadmap

The initial compatibility target is the unmodified CommonJS release
`express@5.2.1`, running with its unmodified dependency tree from
`tests/fixtures/express-5/package-lock.json`. Express 5 and several locked
dependencies require Node 18 or newer, so compatibility follows modern Node
behavior rather than historical Node quirks.

The fixture is a target and a real-Node baseline. It is deliberately not wired
into the Maligator test suite until the module and host surfaces can load it.

## Milestones

Milestones are ordered; each one is complete only when the fixture reaches the
stated acceptance point without patching Express or anything in `node_modules`.

- [x] **Wave 0: freeze the target.** Add a fixture-local manifest and npm
      lockfile with the direct dependency exactly `express@5.2.1`. Provide a
      CommonJS application and a Node-only smoke runner covering every behavior
      in the final milestone. Confirm `npm install` and `npm run smoke` on real
      Node. Do not add a passing expectation for Maligator yet.
- [ ] **Wave 1: load the tree.** Resolve fixture-local `node_modules`, package
      entry points, relative JavaScript files, and JSON modules. Implement
      CommonJS `require`, `module`, `exports`, `require.main`, module caching,
      `__filename`, and `__dirname`, plus the Node globals used by the tree such
      as `process` and `Buffer`. Acceptance is loading `app.js` through
      `require()` with the exact lockfile install and no application edits.
      Static CommonJS wrappers, JSON modules, canonical bare/`node:` built-ins,
      cache identity/cycles/failure eviction, and identifier-level `__filename` /
      `__dirname` are implemented. Entry-goal detection, `require.main`, complete
      module metadata, globals, and the remaining built-ins still block acceptance.
- [ ] **Wave 2: supply core data and event primitives.** Support the built-in
      modules needed before network service: events, buffers and string
      decoding, streams, utilities, async context hooks, crypto helpers,
      filesystem/path helpers, URLs, query strings, TTY detection, and zlib.
      Acceptance is constructing the Express application and middleware stack
      without unresolved built-ins or initialization failures.
      `node:events` now provides the EventEmitter lifecycle required by the tree;
      `node:tty` and the dependency-used `node:util` formatting/inheritance helpers
      are also implemented. The forced Express graph now advances to `node:zlib`,
      the first substantial Buffer/Node Streams/compression boundary.
- [ ] **Wave 3: supply Node HTTP lifecycle semantics.** Implement the required
      `node:http` and `node:net` client, server, socket, request, and response
      behavior, including EventEmitter integration, headers, status codes,
      streaming bodies, `http.request`, response completion,
      `listen(0, "127.0.0.1")`, `server.address()`, and asynchronous
      `server.close(callback)`. Acceptance is starting the fixture on an ephemeral
      port, driving its smoke requests through `node:http`, and closing it cleanly.
- [ ] **Wave 4: pass the Express behavior baseline.** Run the existing smoke
      runner under Maligator and match real Node for route dispatch, decoded
      route parameters, repeated query values, ordered application/route/async
      middleware, automatic forwarding of async rejections, JSON and
      URL-encoded request bodies, cookie serialization, redirects, custom 404
      handling, custom error middleware, ephemeral listen, and graceful close.
      Only at this point should the fixture become a Maligator test expected to
      pass.

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

The Node-only smoke runner additionally imports `node:assert/strict` and
`node:http`. These are harness requirements, not additional Express production
dependencies.

## Baseline workflow

Run from `tests/fixtures/express-5/`:

```sh
npm install
npm run smoke
```

`node_modules` remains ignored. The manifest, lockfile, application, and smoke
runner are the only fixture inputs that should be versioned.
