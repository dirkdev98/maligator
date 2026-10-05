Enable the Web surface and start an HTTP listener with `Mal.serve`. Set an explicit bind address and port for a service whose address other programs need to know.

## Start a listener

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	surface: { webPlatform: true },
});
```

{{example:http.ts}}

Save the example as `src/index.ts`, then run:

```shell
maligator dev
curl http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/missing
```

The first request returns `hello`; the second returns status 404. [ready](/api/application#ready) reports startup completion to the development supervisor after the listener has started.

The `fetch` handler may return a `Response` or an awaited response. The server handle exposes its actual bound `port`; port `0` asks the OS to choose. The current public handle has no stop method, so this listener lives with the application process.

## Set connection limits

[MaligatorServeOptions](/api/runtime#MaligatorServeOptions) includes header, request, and keep-alive deadlines in milliseconds, plus a concurrent connection limit. Use integer values; `0` selects the host default. Invalid limit values throw.

`Mal.serve` remains experimental. Invalid handler options and bind failures are not yet consistently reported as exceptions. Use valid options, confirm the bound port, and inspect startup output. Do not assume a complete production server lifecycle API.

## Use node:http

Enable `surface.node` to use the supported Node HTTP personality instead:

```typescript src/index.ts
import { createServer } from "node:http";
import { ready } from "maligator:application";

createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/plain" });
	response.end("hello");
}).listen(3000, "127.0.0.1", () => ready());
```

Use one of these examples at a time on port 3000. Consult [Compatibility](/compatibility) for supported Node and Web APIs before using a framework. Continue with [production builds](/guides/production) for packaging.
