Keep build choices in `maligator.build.ts` at the project root. The CLI evaluates this trusted TypeScript on every invocation and rejects unknown or invalid fields.

## Create a configuration

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	outputName: "my-app",
	surface: { node: true },
});
```

[defineBuild](/api/build#defineBuild) preserves the inferred type. Validation happens when the CLI loads the config. Ordinary variables, functions, conditions, and environment reads are allowed. The supported package import is `defineBuild`; do not import arbitrary helper modules into this file.

```shell
maligator run
maligator build src/other.ts --config maligator.build.ts --production
```

The working directory is the project root. An explicit entry overrides `config.entry`; `--config` resolves from that same directory. No parent-directory search occurs. Without a config, an explicit entry uses product defaults.

## Select features and host APIs

Enable only the APIs your application uses. `surface.node` includes supported Node modules; `surface.webPlatform` includes Web APIs and `Mal.serve`. `surface.maligator` defaults to enabled and provides `mal.assets`.

Engine choices apply to the whole image, including workers. RegExp is enabled by default. Eval, Realm support, Temporal, and Intl are opt-in. `engine.eval: true` embeds the runtime compiler; `"compile-check"` rejects visible dynamic compilation and keeps it disabled at runtime.

The [configuration reference](/api/build#MaligatorBuildConfig) lists each default and interaction. Type declarations remain visible even for disabled surfaces. Check [Compatibility](/compatibility) for support within an enabled surface.

With `surface.node`, `node:module.builtinModules` and `isBuiltin` describe the modules this image supports. The list is frozen and uses Node's spellings, including the required `node:` prefix for `node:sqlite`. A listed module can still expose a subset of Node's APIs; consult Compatibility for its exports.

`node:buffer.isAscii` and `isUtf8` validate the bytes of Buffers, typed arrays, and ArrayBuffers, including shared backing stores. They honor typed-array offsets and validate UTF-8 scalar values without accepting surrogate encodings. Detached and out-of-bounds inputs are empty; DataViews and proxies are rejected, matching Node 26.8 and later.

`node:util.toUSVString` coerces its input to a string and replaces unpaired surrogates with U+FFFD. The supported `node:util/types` predicates share identity with `util.types`, inspect runtime brands without invoking property getters, and preserve the distinction between ordinary, async, and generator functions. Arguments and native errors retain their brands after prototype changes; prototypes and `Symbol.toStringTag` cannot forge them.

`node:path/posix` exposes the existing POSIX path implementation with the same object and function identities as `path.posix`. `Buffer.isEncoding` recognizes supported encoding names without coercing other values.

`Buffer.copyBytesFrom` copies a typed array's raw bytes into an independent Buffer. Its offset and length count elements; shared backing stores are read atomically, and detached or out-of-bounds views are empty. `node:url.urlToHttpOptions` converts URL-like objects, retaining enumerable extensions and Node's property-access and coercion order. Ordinary invalid arguments preserve the supported Node error types and codes; error-message wording can differ. Buffer invalid-type diagnostics use a generic formatter and do not invoke `util.inspect.custom` hooks, including hooks that would throw in Node.

`node:url.URL` and `URLSearchParams` share identity with the global constructors. `node:net.isIP`, `isIPv4`, and `isIPv6` preserve Node's string coercions, reject leading-zero IPv4 components, and support IPv6 zone identifiers.

Callback and promise forms of filesystem `access`, `unlink`, and `rename` run through the bounded host worker pool. Callbacks run after the initiating call and retain their async-local context. `fs.promises`, its named export, and `node:fs/promises` share one module; public sync-export replacement does not replace captured promise implementations. The three promise methods preserve async-function branding, and error types and codes match the supported Node behavior; error-message wording can differ.

`node:fs/promises.constants` shares the `fs.constants` object. Its module property can be replaced, while a named import retains its original binding, matching Node.

`mkdtemp` supports callback and promise forms, while `mkdtempSync` performs the same operation synchronously. All three honor encoding options, including Buffer paths, and preserve Node's option-getter order. Callback `fsync` and `fdatasync` run on the host worker pool; `fsyncSync` and `fdatasyncSync` flush directly. These APIs retain Node's descriptor validation, callback signatures, and construction behavior.

`fs.cp`, `cpSync` and `node:fs/promises.cp` follow Node 26's copy algorithm, including `filter`, `force`, `errorOnExist`, `dereference`, `verbatimSymlinks`, `preserveTimestamps` and its error codes. Without a filter the whole copy runs on the host worker pool. `fs.glob`, `globSync` and `readdir` with `recursive` walk in Node's order. `fs.watch` uses kqueue on macOS and inotify on Linux. `recursive: true` watches the whole tree and reports names relative to the watched directory, such as `sub/file.txt`; on macOS one kqueue descriptor per watched file and subdirectory caps a watcher at 256 entries. `copyFile`, `copyFileSync` and `fs.promises.copyFile` honor `COPYFILE_EXCL`, `COPYFILE_FICLONE` and `COPYFILE_FICLONE_FORCE` like libuv; as in Node, `COPYFILE_FICLONE_FORCE` fails with `ENOSYS` on macOS. `watchFile` polls `stat` on a timer.

`node:net` servers accept connections through the host reactor and hand them out as ordinary `net.Socket` instances, over TCP or Unix domain socket paths. `node:dgram` sends datagrams straight from the caller's buffers. Both resolve host names through `dns.lookup`, and client sockets accept a custom `lookup` function and emit `'lookup'` events. `node:dns` answers `lookup` through the system resolver and sends SRV, TXT, MX, CNAME, NS, PTR, NAPTR, SOA, CAA and TLSA queries itself, to the servers from `setServers()` or `/etc/resolv.conf`.

`node:worker_threads` provides `BroadcastChannel` across the main thread and workers, `setEnvironmentData`/`getEnvironmentData`, and `markAsUntransferable`. `BroadcastChannel`, `MessageChannel` and `MessagePort` are also globals. `locks` and the `MessageEvent` global are not available yet.

`node:vm` runs scripts in the current context with the global semantics of indirect eval, and a `Script` parses once. A context from `createContext` is a separate realm: the sandbox's own enumerable properties are copied in before a run, and globals the script created or changed are copied back afterwards. Note that the sandbox's prototype chain, getters and deletions do not reach the script.

`node:crypto` imports, exports and generates asymmetric keys as `KeyObject`s, and signs and verifies with RSA (PKCS#1 v1.5 and PSS), ECDSA on P-256 and P-384, and Ed25519. `crypto.subtle` handles the same keys, and `X509Certificate` reads PEM and DER certificates. RSA key generation, encrypted PEM keys and `createECDH` are not supported yet.

`tls.createServer` and `https.createServer` terminate TLS with rustls on the sockets `node:net` and `node:http` already use, including ALPN, client certificates, `setSecureContext` and Node's `ERR_SSL_*` codes for failed handshakes. `tls.Server` also takes `SNICallback` and `addContext`, and TLS sockets answer `getPeerCertificate()`. Unverified client certificates are rejected even with `rejectUnauthorized: false`, so `authorizationError` is not available yet.

`createRequire(import.meta.url)` resolves at build time like CommonJS `require`: modules required with a literal specifier are bundled. A require with a computed specifier finds only modules that are bundled that way. `import.meta.resolve` answers a literal specifier from the build's resolution, packages included, and resolves a computed path or URL against the module's URL when it runs.

`TransformStream`, `TextEncoderStream` and `TextDecoderStream` are available with either the web platform or the Node surface. `CompressionStream` and `DecompressionStream` need the Node surface, since the zlib codec ships with it. `util.MIMEType` and `MIMEParams` port Node's parser, including its quoting rules and error messages.

## Replace a module specifier

```typescript maligator.build.ts
import { defineBuild } from "@maligator/cli";

export default defineBuild({
	entry: "src/index.ts",
	modules: { aliases: { "app-store": "./src/store.ts" } },
});
```

Aliases replace exact specifiers before resolution. They are not prefix mappings or TypeScript `paths` configuration. Create the replacement module before building.

## Check a configuration failure

For `config file not found`, verify the working directory and `--config` path. For an unknown field, check the full field path in the diagnostic against [the reference](/api/build). Locale-data filtering is not implemented: `engine.intl.languages` must remain empty.

Assets require `surface.maligator`. Follow [Embed files](/guides/assets) for inclusion patterns, or [Build for production](/guides/production) for target and artifact options.
