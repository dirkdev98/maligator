Start with the diagnostic and the command that produced it. Keep the entry, configuration, Maligator version, and working directory when reporting a failure.

## No entry or configuration file

Run `maligator init` to create a config, or pass an existing entry explicitly: `maligator run src/index.ts`. For `config file not found`, verify the path relative to the current directory. Maligator does not search ancestors. See [configuration resolution](/guides/build-configuration).

## Toolchain is not ready

```shell
maligator doctor --verbose
```

Check resolved `CC`/`CXX`, `PATH`, Rust, and the requested target. Ordinary development execution with Intl disabled can use the distributed embedded runtime; native builds and profiling still need the toolchain. For a cross-build, run `doctor --target <rust-triple> --verbose` before compiling.

## Unknown import or missing global

If the editor cannot resolve `maligator:workers`, load [the package types](/guides/typescript). If the compiler rejects a `node:` or Web API, enable its surface and check [Compatibility](/compatibility). Enabling a surface does not add an unsupported API. `Mal` uses `surface.webPlatform`; `mal` uses `surface.maligator`.

## Import syntax is rejected

For `The import keyword can only be used with the module goal`, check the nearest `package.json`. Set `"type": "module"` for `.js` and `.ts` files, or use `.mjs` and `.mts`. This also enables top-level `await`. See [ES module setup](/guides/typescript#use-es-modules).

## Worker entry or admission fails

Use a static string literal and `import.meta.url` in [createWorkerUrl](/api/workers#createWorkerUrl). Await `ready` to separate startup failure from task failure. `NotSupportedError` indicates a host without threads; [capabilities](/api/workers#capabilities) reports host facilities.

`QueueFullError` means a task or message was not admitted. Reduce concurrent submission or use a bounded `map` window. `DataCloneError` points to a value or transfer-list problem. Failed admission preserves transferable ownership; an accepted submission moves it immediately. Handle synchronous throws as well as promise rejections.

A shutdown that never finishes can be a task that does not settle after cancellation. Check [cooperative cancellation](/guides/workers/cancellation) before increasing timeouts.

## Asset inclusion fails

Check the path from the project root, confirm each directory pattern matches a regular file, and remove symlinks or special files. Assets require `surface.maligator`. At runtime, ensure the materialization parent is writable. See [Embed files](/guides/assets).

## HTTP startup fails

Use an enabled Web or Node surface, a valid handler, and an available port. Bind `127.0.0.1` for local testing. Inspect startup output and the actual bound port; the experimental `Mal.serve` API does not yet consistently throw on bind failure. See [Serve HTTP](/guides/http).

## Inspect cache usage

```shell
maligator cache status
maligator cache prune --dry-run
```

Normal source and configuration identity changes invalidate affected work automatically. Use the dry run before pruning. `cache clear --all` deliberately removes rebuildable cache entries; it is not a routine fix for a compilation error. Include a small reproducer when [filing an issue](https://github.com/dirkdev98/maligator/issues).
