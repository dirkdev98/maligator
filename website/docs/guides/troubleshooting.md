Start with the diagnostic and the command that produced it. Keep the entry, configuration, Maligator version, and working directory when reporting a failure.

## No entry or configuration file

Run `maligator init` to create a config, or pass an existing entry explicitly: `maligator run src/index.ts`. For `config file not found`, verify the path relative to the current directory. Maligator does not search ancestors. See [configuration resolution](/guides/build-configuration).

## Toolchain is not ready

```shell
maligator doctor --verbose
```

Check the selected compiler and target against the [toolchain guide](/guides/native-toolchain). A planned Zig download happens on the next production build. If `doctor` reports missing Rust tools, check whether a matching archive is available for the target and configuration. To diagnose a cross-build, pass `--target` to `doctor` too.

## Unknown import or missing global

If the editor cannot resolve `maligator:workers`, load [the package types](/guides/typescript). If the compiler rejects a `node:` import or you cannot call a Web API, check [Compatibility](/compatibility).

## Compile error locations

Syntax errors, invalid JSON modules, and unresolved imports show `file:line:column` when the compiler has a source location. The code frame shows the source line with a caret marking where to look. Here the caret points to a semicolon where the parser expected an initializer.

```text
/projects/example/src/index.ts:1:16: Unexpected token: ';'
  const answer = ;
                 ^
```

## Runtime stack traces

For an uncaught error, start with the first stack frame in your code. The frame gives the function and its original source path, line, and column. Read the following frames to see the callers. Use `maligator run --verbose` when you also need build diagnostics.

## Edits are slow to trigger a rebuild

`dev` watches filesystem events where available and polls file identities as a fallback. On a filesystem that misses events, such as some mounted volumes, a rebuild starts after the next scan detects the change. Run `maligator dev --verbose` to see which watcher the CLI selected. Check that the file is an entry, a dependency, or the build config.

## Eval or RegExp is disabled

`eval is disabled in this build` means a dynamic compilation call ran under the default `engine.eval: false`. Set `engine.eval: true` to embed the runtime compiler, or `"compile-check"` to reject statically visible calls during the build instead. `RegExp is disabled by your build config` lists the regular expressions in an `engine.regexp: false` build; remove the setting or the expressions. See [engine choices](/guides/build-configuration).

## Import syntax is rejected

For `The import keyword can only be used with the module goal`, check the nearest `package.json`. Set `"type": "module"` for `.js` and `.ts` files, or use `.mjs` and `.mts`. This also enables top-level `await`. See [ES module setup](/guides/typescript#use-es-modules).

## Worker entry or admission fails

Use a static string literal and `import.meta.url` in [createWorkerUrl](/api/workers#createWorkerUrl). Await `ready` to separate startup failure from task failure. `NotSupportedError` indicates a host without threads; [capabilities](/api/workers#capabilities) reports host facilities.

`QueueFullError` means a task or message was not admitted. Reduce concurrent submission or use a bounded `map` window. `DataCloneError` points to a value or transfer-list problem. Failed admission preserves transferable ownership; an accepted submission moves it immediately. Handle synchronous throws as well as promise rejections.

A shutdown that never finishes can be a task that does not settle after cancellation. Check [cooperative cancellation](/guides/workers/cancellation) before increasing timeouts.

## Asset inclusion fails

A declaration the compiler rejects names its file and line: pass a string literal specifier and literal options, and call `embedFile` or `embedDirectory` directly. A build that fails to embed names the declared path: check it relative to the declaring module, confirm each `include` pattern matches a regular file, and remove symlinks or special files. At runtime, ensure the materialization parent is writable. See [Embed files](/guides/assets).

## HTTP startup fails

Use a valid handler and an available port. `serve` throws when it cannot bind, naming the address and the reason, such as an address already in use. Bind `127.0.0.1` for local testing and read `server.url` for the address it reached. See [Serve HTTP](/guides/http).

## HTTP bodies and buffering

`serve` returns HTTP 413 when an incoming request body exceeds 16 MiB. It buffers response bodies in full before writing them, including responses backed by a `ReadableStream`.

## Inspect cache usage

```shell
maligator cache status
maligator cache prune --dry-run
```

Normal source and configuration identity changes invalidate affected work automatically, and the cache trims itself in the background once it passes its budget (see [cache](/api/cli#cache)). Use the dry run before pruning by hand. `cache clear --all` deliberately removes rebuildable cache entries; it is not a routine fix for a compilation error. Include a small reproducer when [filing an issue](https://github.com/dirkdev98/maligator/issues).
