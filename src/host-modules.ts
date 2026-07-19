/**
 * The central catalog of supported `node:*` host built-in modules (the first
 * Node-compatibility slice, behind `surface.node`). It is the single source of
 * truth for which `node:*` specifiers resolve and what each is planned to
 * export, shared by the module graph (resolution → virtual module records)
 * and the linker (host export binding synthesis).
 *
 * ES module imports use the `node:`-prefixed form. CommonJS resolution also
 * recognizes each catalog id without that prefix (`path`, `fs`, ...), and
 * canonicalizes both spellings to this catalog's `node:*` identity.
 *
 * The named lists are deliberately narrow: only the built-in APIs the compiler
 * and supported applications need today, not the full Node surface. The linker
 * binds used exports to global slots filled by each native module installer; unused
 * exports and installers remain eligible for dead-code elimination.
 */

export interface HostModuleSpec {
	/** Canonical specifier and virtual module identity, e.g. `"node:path"`. */
	id: string;
	/** Curated named exports the linker can bind. */
	named: ReadonlyArray<string>;
	/** Whether `import x from "<id>"` provides a default export. */
	hasDefault: boolean;
	/**
	 * The C symbol of this module's native installer — the function the emitted
	 * install manifest references to fill each declared export's global slot. The
	 * engine-neutral installer ABI ({@link
	 * ../runtime/src/vm.h#MalHostModuleInstall}) keeps Node names out of the
	 * intrinsic table; the name only ever appears as a string here and as an
	 * `extern` decl in emitted C. Derived from the specifier via
	 * {@link hostInstallerSymbol}, so the mapping has one source of truth.
	 */
	installer: string;
}

/**
 * The C installer symbol for a `node:*` specifier: `mal_host_install_` followed
 * by the specifier with every non-alphanumeric run collapsed to `_` (so
 * `node:path` → `mal_host_install_node_path`, `node:child_process` →
 * `mal_host_install_node_child_process`). A pure naming convention shared by the
 * catalog and the C emitter; the function itself is defined in the native
 * host-module layer.
 */
export function hostInstallerSymbol(specifier: string): string {
	let suffix = "";
	let separator = false;
	for (const char of specifier) {
		const alphanumeric =
			(char >= "a" && char <= "z") ||
			(char >= "A" && char <= "Z") ||
			(char >= "0" && char <= "9");
		if (alphanumeric) {
			suffix += char;
			separator = false;
		} else if (!separator) {
			suffix += "_";
			separator = true;
		}
	}
	return `mal_host_install_${suffix}`;
}

/**
 * The C installer symbol for the global `process` object. Distinct from a module
 * installer because `process` is a free global, not a module import; it fills a
 * single global slot (see {@link ../runtime/src/vm.h#MalHostProcessInstaller}).
 */
export const PROCESS_INSTALLER_SYMBOL = "mal_host_install_process";

/** Installer shared by the free `Buffer` global and the `node:buffer` module. */
export const BUFFER_INSTALLER_SYMBOL = hostInstallerSymbol("node:buffer");

// path is the one module with a planned default export (`import path from
// "node:path"`) alongside its named functions — `relative` included.
const PATH: HostModuleSpec = {
	id: "node:path",
	named: [
		"basename",
		"delimiter",
		"dirname",
		"extname",
		"isAbsolute",
		"join",
		"normalize",
		"relative",
		"resolve",
		"sep",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:path"),
};

const FS: HostModuleSpec = {
	id: "node:fs",
	named: [
		"copyFileSync",
		"existsSync",
		"mkdirSync",
		"mkdtempSync",
		"readFileSync",
		"readdirSync",
		"realpathSync",
		"renameSync",
		"rmSync",
		"statSync",
		"writeFileSync",
	],
	hasDefault: false,
	installer: hostInstallerSymbol("node:fs"),
};

const CHILD_PROCESS: HostModuleSpec = {
	id: "node:child_process",
	named: ["execFileSync"],
	hasDefault: false,
	installer: hostInstallerSymbol("node:child_process"),
};

// Curated hashing helpers used by the runtime and pinned Express dependencies.
const CRYPTO: HostModuleSpec = {
	id: "node:crypto",
	named: ["createHash", "createHmac", "hash", "randomUUID", "timingSafeEqual"],
	hasDefault: false,
	installer: hostInstallerSymbol("node:crypto"),
};

const EVENTS: HostModuleSpec = {
	id: "node:events",
	named: ["EventEmitter"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:events"),
};

const TTY: HostModuleSpec = {
	id: "node:tty",
	named: ["ReadStream", "WriteStream", "isatty"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:tty"),
};

const UTIL: HostModuleSpec = {
	id: "node:util",
	named: ["deprecate", "format", "formatWithOptions", "inherits", "inspect"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:util"),
};

const BUFFER: HostModuleSpec = {
	id: "node:buffer",
	named: ["Buffer"],
	hasDefault: true,
	installer: BUFFER_INSTALLER_SYMBOL,
};

const ASSERT_STRICT: HostModuleSpec = {
	id: "node:assert/strict",
	named: ["equal", "deepEqual", "match"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:assert/strict"),
};

const ASYNC_HOOKS: HostModuleSpec = {
	id: "node:async_hooks",
	named: ["AsyncResource"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:async_hooks"),
};

const STREAM: HostModuleSpec = {
	id: "node:stream",
	named: ["Stream", "Readable", "Writable", "Duplex", "Transform"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:stream"),
};

const HTTP: HostModuleSpec = {
	id: "node:http",
	named: [
		"METHODS",
		"IncomingMessage",
		"ServerResponse",
		"Server",
		"ClientRequest",
		"createServer",
		"get",
		"request",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:http"),
};

const URL: HostModuleSpec = {
	id: "node:url",
	named: ["Url", "parse", "format"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:url"),
};

const QUERYSTRING: HostModuleSpec = {
	id: "node:querystring",
	named: ["parse"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:querystring"),
};

const NET: HostModuleSpec = {
	id: "node:net",
	named: ["isIP"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:net"),
};

const OS: HostModuleSpec = {
	id: "node:os",
	named: ["release"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:os"),
};

const STRING_DECODER: HostModuleSpec = {
	id: "node:string_decoder",
	named: ["StringDecoder"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:string_decoder"),
};

const ZLIB: HostModuleSpec = {
	id: "node:zlib",
	named: ["createInflate", "createGunzip", "createBrotliDecompress"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:zlib"),
};

/** Supported `node:*` built-ins, keyed by canonical specifier. */
export const HOST_MODULES: ReadonlyMap<string, HostModuleSpec> = new Map(
	[
		PATH,
		FS,
		CHILD_PROCESS,
		CRYPTO,
		EVENTS,
		TTY,
		UTIL,
		BUFFER,
		ASSERT_STRICT,
		ASYNC_HOOKS,
		STREAM,
		HTTP,
		URL,
		QUERYSTRING,
		NET,
		OS,
		STRING_DECODER,
		ZLIB,
	].map((spec) => [spec.id, spec]),
);

// Public modern-Node core names. Keep this independent of the compiler host's
// Node version so bare-core precedence is reproducible and self-hosting does not
// introduce a node:module dependency into the compiler graph.
const NODE_BUILTIN_IDS = new Set(
	[
		"assert",
		"assert/strict",
		"async_hooks",
		"buffer",
		"child_process",
		"cluster",
		"console",
		"constants",
		"crypto",
		"dgram",
		"diagnostics_channel",
		"dns",
		"dns/promises",
		"domain",
		"events",
		"fs",
		"fs/promises",
		"http",
		"http2",
		"https",
		"inspector",
		"inspector/promises",
		"module",
		"net",
		"os",
		"path",
		"path/posix",
		"path/win32",
		"perf_hooks",
		"process",
		"punycode",
		"querystring",
		"readline",
		"readline/promises",
		"repl",
		"stream",
		"stream/consumers",
		"stream/promises",
		"stream/web",
		"string_decoder",
		"sys",
		"timers",
		"timers/promises",
		"tls",
		"trace_events",
		"tty",
		"url",
		"util",
		"util/types",
		"v8",
		"vm",
		"wasi",
		"worker_threads",
		"zlib",
	].map((specifier) => `node:${specifier}`),
);

// These built-ins deliberately require the node: prefix in Node itself.
const NODE_PREFIX_ONLY_BUILTIN_IDS = new Set([
	"node:sea",
	"node:sqlite",
	"node:test",
	"node:test/reporters",
]);

/** True for any `node:`-prefixed specifier, supported or not. */
export function isNodeSpecifier(specifier: string): boolean {
	return specifier.startsWith("node:");
}

/** The catalog entry for a specifier, or undefined when it is not a supported built-in. */
export function lookupHostModule(specifier: string): HostModuleSpec | undefined {
	return HOST_MODULES.get(specifier);
}

/** Canonical catalog id for a Node built-in spelling, if supported. */
export function canonicalNodeHostModuleId(specifier: string): string | undefined {
	const id = isNodeSpecifier(specifier) ? specifier : `node:${specifier}`;
	return HOST_MODULES.has(id) ? id : undefined;
}

/** Canonical Node core identity, including built-ins not implemented by Maligator yet. */
export function canonicalNodeBuiltinId(specifier: string): string | undefined {
	const id = isNodeSpecifier(specifier) ? specifier : `node:${specifier}`;
	return NODE_BUILTIN_IDS.has(id) ||
		(isNodeSpecifier(specifier) && NODE_PREFIX_ONLY_BUILTIN_IDS.has(id))
		? id
		: undefined;
}

/** Sorted list of supported specifiers, for clear "unknown module" diagnostics. */
export function supportedHostModuleIds(): Array<string> {
	return [...HOST_MODULES.keys()];
}
