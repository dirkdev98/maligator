Use `dev` to keep the compiler session alive while you edit. Each successful rebuild starts a fresh application generation.

## Watch your entry point

From a project with `maligator.build.ts`:

```shell
maligator dev
maligator dev src/index.ts -- first-argument "two words"
```

Everything after `--` reaches the application unchanged. `dev` watches the dependency graph, checks project files frequently, and checks `node_modules` less often. A compile failure leaves the watcher running and preserves the last good application until a valid replacement is available. Fix the error and save again.

Module instances and globals start fresh in each replacement. Store data that must survive a restart in an external resource such as a file or database.

## Report readiness

For an application with asynchronous startup, call [ready](/api/application#ready) after your own resources accept work:

```typescript src/index.ts
import { ready } from "maligator:application";
import { createServer } from "node:http";

createServer((_request, response) => response.end("hello")).listen(
	3000,
	"127.0.0.1",
	() => ready(),
);
```

Enable `surface.node` in your config for this example. `ready()` returns `true` under the development supervisor and `false` in a standalone application or ordinary worker. Repeated calls are harmless.

Readiness is a notification. It does not reserve a port or hand traffic to another listener. Plan port ownership and persistent connections separately when your application needs them.

## Inspect a restart

```shell
maligator dev --status
```

The status stream shows generation and resource states. Compatible applications use supervised isolates; policies the embedded runtime cannot support use a process runner. A startup error is different from a compilation error: inspect the application's output before changing the build config.

Press Ctrl+C to stop the watcher and join active work. For test reruns, use [application testing](/guides/testing); for a distributable binary, use [production builds](/guides/production).
