The uppercase `Mal` namespace exposes the Web host extension. Its declarations are always available after loading the package types; the build configuration controls runtime availability.

## Mal {#Mal}

Requires `surface.webPlatform` (disabled by default). `Mal.serve` starts an HTTP listener and returns its bound port. The API is experimental: the handle has no public shutdown method, and invalid handlers or bind failures are not yet consistently reported as exceptions. Use valid options and verify startup before accepting traffic.

{{example:http.ts}}

Run this as `src/index.ts` with `surface.webPlatform: true`; `curl http://127.0.0.1:3000/` returns `hello`. See [Serve HTTP](/guides/http) for the config and Node alternative.
