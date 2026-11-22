Use `dev` to keep the compiler session alive while you edit. Each successful rebuild starts a fresh application generation.

## Watch your entry point

From a project with `maligator.build.ts`:

```shell
maligator dev
maligator dev src/index.ts -- first-argument "two words"
```

Everything after `--` reaches the application unchanged. `dev` watches the dependency graph. It reports when the application starts, which files change, and how long a successful rebuild took. A compile failure leaves the last good application running. Fix the error and save again.

Module instances and globals start fresh in each replacement. Store data that must survive a restart in an external resource such as a file or database.

## Report readiness

For an application with asynchronous startup, call [ready](/api/application#ready) after your own resources accept work:

```typescript src/index.ts
import { createServer } from "node:http";
import { ready } from "maligator:application";

createServer((_request, response) => response.end("hello")).listen(
	3000,
	"127.0.0.1",
	() => ready(),
);
```

`ready()` returns `true` under the development supervisor and `false` in a standalone application or ordinary worker. Repeated calls are harmless.

Readiness is a notification only: it does not change how `dev` handles your listeners.

## Keep servers reachable

A supervised generation's listening sockets stay open while `dev` restarts it. A request that arrives during the restart waits in the socket's queue, and the next generation answers it once its server listens on the same address and port. This works for [maligator:http](/api/http), `node:http` and `node:net` servers on a fixed port.

A socket the next generation does not listen on by the end of its evaluation closes, which frees ports of servers you removed. A server your code closes frees its port at once, as it would outside `dev`. Requests in progress when the old generation stops end with it, and an application on the process runner restarts without this queue, so its clients see refused connections until the new process listens.

## Inspect a restart

```shell
maligator dev --status
```

The status stream shows generation and resource states, including whether `dev` launched an isolate or a separate process. For a startup error, check the application's output. For a syntax error, use the [source location and code frame](/guides/troubleshooting#compile-error-locations).

Press Ctrl+C to stop the watcher and join active work. For test reruns, use [application testing](/guides/testing); for a distributable binary, use [production builds](/guides/production).
