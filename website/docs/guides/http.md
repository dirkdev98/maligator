Serve HTTP with `maligator:http`: a `fetch` handler takes a `Request` and returns a `Response`, as in other Fetch API servers.

## Start a listener

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({ entry: "src/index.ts" });
```

{{example:http.ts}}

Save the example as `src/index.ts`, then run:

```shell
maligator dev
curl http://127.0.0.1:3000/
curl -i http://127.0.0.1:3000/missing
```

The first request returns `hello`; the second returns status 404. [ready](/api/application#ready) reports startup completion to the development supervisor after the listener has started.

`serve` throws for invalid options and when it cannot bind, such as a port in use. Port `0` lets the OS choose; `server.port` and `server.url` report the result. Bind `127.0.0.1` for a listener only this machine reaches.

## Handle failures and shut down

A handler that throws or rejects reaches the `error` handler. Without one, the server logs the error and answers a plain 500, so clients never see its details:

```typescript src/index.ts
import { serve } from "maligator:http";

await using server = serve({
	port: 3000,
	fetch: () => {
		throw new Error("unavailable");
	},
	error: (error) => new Response(`failed: ${String(error)}`, { status: 503 }),
});
```

`server.close()` stops accepting connections and fulfills once in-flight requests have finished. `await using` closes the server at the end of its scope, and a `signal` option closes it when an `AbortSignal` aborts.

## Serve files

`serveAsset` turns a [declared asset](/guides/assets) into a handler. It sets the media type, an `ETag` and `Cache-Control`, answers `If-None-Match` with 304, honours a single `Range`, and serves a directory's `index.html` for paths that end in `/`:

```typescript src/index.ts
import { embedDirectory } from "maligator:assets";
import { serve, serveAsset } from "maligator:http";

const site = serveAsset(embedDirectory("../public"), {
	fallback: "index.html",
	immutable: ["assets/**"],
});
serve({ port: 3000, fetch: site });
```

`fallback` answers paths that name no file, as a client-side router expects. `immutable` marks content-hashed files as cacheable forever; other files revalidate. `prefix` serves the directory below a path, such as `/static`. A production build stores Brotli and gzip copies of the text files a program serves and picks one by `Accept-Encoding`.

When `serveAsset` is the whole handler, the server answers in native code without running JavaScript for each request. Call the handler from your own `fetch` to combine it with routes:

```typescript src/index.ts
import { embedDirectory } from "maligator:assets";
import { serve, serveAsset } from "maligator:http";

const files = serveAsset(embedDirectory("../web/dist"), { fallback: "index.html" });

serve({
	port: 3000,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname.startsWith("/api/")) return Response.json({ path: pathname });
		return files(request);
	},
});
```

## Develop a frontend behind the server

A declaration with a [watcher](/guides/assets#produce-files-with-a-build-step) serves from its dev server while the watcher runs: `serveAsset` forwards each request to the watcher's `url`, so the page, the API and the frontend's live updates share one origin. Point the dev server's hot-reload socket at its own port, such as Vite's `server.hmr.clientPort`, because the forwarding answers plain requests. A build embeds the produced files instead.

## Make requests

You can call the global `fetch` or import it from `maligator:http`. It streams request and response bodies, follows redirects, decodes gzip, deflate and Brotli bodies, and stops when its `AbortSignal` fires:

```typescript
const response = await fetch("https://api.example.com/items", {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ name: "widget" }),
	signal: AbortSignal.timeout(5000),
});
console.log(response.status, await response.json());
```

As in Deno and Node, a server has no browser context: `fetch` enforces no CORS, keeps no cookies or HTTP cache, sends no referrer, and resolves `redirect: "manual"` with the 3xx response itself. A network failure rejects with a `TypeError` whose `cause` says what failed. Requests use HTTP/1.1, and `integrity` metadata is not verified yet, so a request that sets it rejects.

## Use node:http

Import `createServer` from `node:http` to use Node’s request and response streams.

```typescript src/index.ts
import { createServer } from "node:http";
import { ready } from "maligator:application";

createServer((_request, response) => {
	response.writeHead(200, { "content-type": "text/plain" });
	response.end("hello");
}).listen(3000, "127.0.0.1", () => ready());
```

Use one of these examples at a time on port 3000. Consult [Compatibility](/compatibility) for supported Node and Web APIs before using a framework. Continue with [production builds](/guides/production) for packaging.
