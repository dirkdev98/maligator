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

import type { FfiDirectEntry } from "../../build-config-values.ts";
import { PLATFORM_MODULES } from "../../platform/catalog.ts";
import type { PlatformData, PlatformModule } from "../../platform/catalog.ts";

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
	platform?: PlatformModule;
	constants?: Readonly<Record<string, PlatformData>>;
	/** Exports native code may call through a C entry instead of the function object. */
	direct?: Readonly<Record<string, FfiDirectEntry>>;
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
	return `mal_host_install_${specifier.replaceAll(/[^A-Za-z0-9]+/g, "_")}`;
}

/**
 * The C installer symbol for the global `process` object. Distinct from a module
 * installer because `process` is a free global, not a module import; it fills a
 * single global slot (see {@link ../runtime/src/vm.h#MalHostProcessInstaller}).
 */
export const PROCESS_INSTALLER_SYMBOL = "mal_host_install_process";

/** Installer shared by the free `Buffer` global and the `node:buffer` module. */
export const BUFFER_INSTALLER_SYMBOL = hostInstallerSymbol("node:buffer");

/** The node:perf_hooks installer, which gives Node's surface to the free `performance` global. */
export const PERFORMANCE_INSTALLER_SYMBOL = hostInstallerSymbol("node:perf_hooks");

/** The node:crypto installer, which makes the free `crypto` global Node's webcrypto. */
export const CRYPTO_INSTALLER_SYMBOL = hostInstallerSymbol("node:crypto");

/** Free WebCrypto globals that node:crypto replaces or defines. */
export const CRYPTO_GLOBALS: ReadonlyArray<string> = [
	"crypto",
	"Crypto",
	"CryptoKey",
	"SubtleCrypto",
];

/** Free globals that Node's perf_hooks defines or extends. */
export const PERFORMANCE_GLOBALS: ReadonlyArray<string> = [
	"performance",
	"Performance",
	"PerformanceEntry",
	"PerformanceMark",
	"PerformanceMeasure",
	"PerformanceObserver",
	"PerformanceObserverEntryList",
	"PerformanceResourceTiming",
];

/** The node:worker_threads installer, which also defines the messaging globals. */
export const WORKER_THREADS_INSTALLER_SYMBOL = hostInstallerSymbol("node:worker_threads");

/** The node:http installer, which also defines Node's WebSocket globals. */
export const HTTP_INSTALLER_SYMBOL = hostInstallerSymbol("node:http");

/** Free WebSocket globals that node:http defines; Node 26 exports all but ErrorEvent from it too. */
export const WEBSOCKET_GLOBALS: ReadonlyArray<string> = [
	"WebSocket",
	"MessageEvent",
	"CloseEvent",
	"ErrorEvent",
];

/** Free messaging globals that node:worker_threads defines. */
export const WORKER_GLOBALS: ReadonlyArray<string> = [
	"BroadcastChannel",
	"MessageChannel",
	"MessagePort",
];

/**
 * Module installers that also define free Node globals, retained at startup when a
 * program names one of them. `computedMember` means a computed `globalThis[key]`
 * read retains the installer once it is linked.
 */
export const HOST_GLOBAL_INSTALLERS: ReadonlyArray<{
	readonly installer: string;
	readonly globals: ReadonlyArray<string>;
	readonly computedMember: boolean;
}> = [
	{
		installer: PERFORMANCE_INSTALLER_SYMBOL,
		globals: PERFORMANCE_GLOBALS,
		computedMember: true,
	},
	{ installer: CRYPTO_INSTALLER_SYMBOL, globals: CRYPTO_GLOBALS, computedMember: false },
	{
		installer: WORKER_THREADS_INSTALLER_SYMBOL,
		globals: WORKER_GLOBALS,
		computedMember: false,
	},
	{ installer: HTTP_INSTALLER_SYMBOL, globals: WEBSOCKET_GLOBALS, computedMember: false },
];

// path is the one module with a planned default export (`import path from
// "node:path"`) alongside its named functions — `relative` included.
const PATH: HostModuleSpec = {
	id: "node:path",
	named: [
		"basename",
		"delimiter",
		"dirname",
		"extname",
		"format",
		"isAbsolute",
		"join",
		"normalize",
		"parse",
		"posix",
		"relative",
		"resolve",
		"matchesGlob",
		"sep",
		"toNamespacedPath",
		"win32",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:path"),
};

const PATH_POSIX: HostModuleSpec = {
	...PATH,
	id: "node:path/posix",
	installer: hostInstallerSymbol("node:path/posix"),
};

const PATH_WIN32: HostModuleSpec = {
	...PATH,
	id: "node:path/win32",
	installer: hostInstallerSymbol("node:path/win32"),
};

const FS: HostModuleSpec = {
	id: "node:fs",
	named: [
		"Dir",
		"Dirent",
		"FileReadStream",
		"FileWriteStream",
		"ReadStream",
		"Stats",
		"WriteStream",
		"access",
		"accessSync",
		"appendFile",
		"appendFileSync",
		"chmod",
		"chmodSync",
		"chown",
		"chownSync",
		"close",
		"closeSync",
		"copyFile",
		"copyFileSync",
		"cp",
		"cpSync",
		"createReadStream",
		"createWriteStream",
		"constants",
		"exists",
		"existsSync",
		"fchmod",
		"fchmodSync",
		"fchown",
		"fchownSync",
		"fdatasync",
		"fdatasyncSync",
		"fstat",
		"fstatSync",
		"fsync",
		"fsyncSync",
		"ftruncate",
		"ftruncateSync",
		"futimes",
		"futimesSync",
		"glob",
		"globSync",
		"lchown",
		"lchownSync",
		"link",
		"linkSync",
		"lstat",
		"lstatSync",
		"lutimes",
		"lutimesSync",
		"mkdir",
		"mkdirSync",
		"mkdtemp",
		"mkdtempDisposableSync",
		"mkdtempSync",
		"open",
		"openSync",
		"opendir",
		"opendirSync",
		"promises",
		"read",
		"readFile",
		"readFileSync",
		"readlink",
		"readlinkSync",
		"readSync",
		"readv",
		"readvSync",
		"readdir",
		"readdirSync",
		"realpath",
		"realpathSync",
		"rename",
		"renameSync",
		"rm",
		"rmSync",
		"rmdir",
		"rmdirSync",
		"statSync",
		"statfs",
		"statfsSync",
		"stat",
		"symlink",
		"symlinkSync",
		"truncate",
		"truncateSync",
		"unlink",
		"unlinkSync",
		"unwatchFile",
		"utimes",
		"utimesSync",
		"watch",
		"watchFile",
		"write",
		"writeFile",
		"writeFileSync",
		"writeSync",
		"writev",
		"writevSync",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:fs"),
};

const FS_PROMISES: HostModuleSpec = {
	id: "node:fs/promises",
	named: [
		"access",
		"constants",
		"appendFile",
		"copyFile",
		"chmod",
		"chown",
		"cp",
		"glob",
		"link",
		"lchown",
		"lstat",
		"lutimes",
		"mkdir",
		"mkdtemp",
		"mkdtempDisposable",
		"open",
		"opendir",
		"readFile",
		"readlink",
		"readdir",
		"rename",
		"realpath",
		"rmdir",
		"rm",
		"stat",
		"statfs",
		"symlink",
		"truncate",
		"unlink",
		"utimes",
		"watch",
		"writeFile",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:fs/promises"),
};

const V8: HostModuleSpec = {
	id: "node:v8",
	named: [
		"cachedDataVersionTag",
		"getHeapCodeStatistics",
		"getHeapSpaceStatistics",
		"getHeapStatistics",
		"isStringOneByteRepresentation",
		"setFlagsFromString",
		"setHeapSnapshotNearHeapLimit",
		"startupSnapshot",
		"stopCoverage",
		"takeCoverage",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:v8"),
};

const VM: HostModuleSpec = {
	id: "node:vm",
	named: [
		"Script",
		"compileFunction",
		"constants",
		"createContext",
		"createScript",
		"isContext",
		"runInContext",
		"runInNewContext",
		"runInThisContext",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:vm"),
};

const DIAGNOSTICS_CHANNEL: HostModuleSpec = {
	id: "node:diagnostics_channel",
	named: [
		"Channel",
		"channel",
		"hasSubscribers",
		"subscribe",
		"tracingChannel",
		"unsubscribe",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:diagnostics_channel"),
};

const DOMAIN: HostModuleSpec = {
	id: "node:domain",
	named: ["active", "create"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:domain"),
};

const DNS: HostModuleSpec = {
	id: "node:dns",
	named: [
		"ADDRCONFIG",
		"ADDRGETNETWORKPARAMS",
		"ALL",
		"BADFAMILY",
		"BADFLAGS",
		"BADHINTS",
		"BADNAME",
		"BADQUERY",
		"BADRESP",
		"BADSTR",
		"CANCELLED",
		"CONNREFUSED",
		"DESTRUCTION",
		"EOF",
		"FILE",
		"FORMERR",
		"LOADIPHLPAPI",
		"NODATA",
		"NOMEM",
		"NONAME",
		"NOTFOUND",
		"NOTIMP",
		"NOTINITIALIZED",
		"REFUSED",
		"Resolver",
		"SERVFAIL",
		"TIMEOUT",
		"V4MAPPED",
		"getDefaultResultOrder",
		"getServers",
		"lookup",
		"lookupService",
		"promises",
		"resolve",
		"resolve4",
		"resolve6",
		"resolveAny",
		"resolveCaa",
		"resolveCname",
		"resolveMx",
		"resolveNaptr",
		"resolveNs",
		"resolvePtr",
		"resolveSoa",
		"resolveSrv",
		"resolveTlsa",
		"resolveTxt",
		"reverse",
		"setDefaultResultOrder",
		"setServers",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:dns"),
};

const DNS_PROMISES: HostModuleSpec = {
	id: "node:dns/promises",
	named: [
		"ADDRGETNETWORKPARAMS",
		"BADFAMILY",
		"BADFLAGS",
		"BADHINTS",
		"BADNAME",
		"BADQUERY",
		"BADRESP",
		"BADSTR",
		"CANCELLED",
		"CONNREFUSED",
		"DESTRUCTION",
		"EOF",
		"FILE",
		"FORMERR",
		"LOADIPHLPAPI",
		"NODATA",
		"NOMEM",
		"NONAME",
		"NOTFOUND",
		"NOTIMP",
		"NOTINITIALIZED",
		"REFUSED",
		"Resolver",
		"SERVFAIL",
		"TIMEOUT",
		"getDefaultResultOrder",
		"getServers",
		"lookup",
		"lookupService",
		"resolve",
		"resolve4",
		"resolve6",
		"resolveAny",
		"resolveCaa",
		"resolveCname",
		"resolveMx",
		"resolveNaptr",
		"resolveNs",
		"resolvePtr",
		"resolveSoa",
		"resolveSrv",
		"resolveTlsa",
		"resolveTxt",
		"reverse",
		"setDefaultResultOrder",
		"setServers",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:dns/promises"),
};

const WORKER_THREADS: HostModuleSpec = {
	id: "node:worker_threads",
	named: [
		"BroadcastChannel",
		"MessageChannel",
		"MessagePort",
		"SHARE_ENV",
		"Worker",
		"getEnvironmentData",
		"isInternalThread",
		"isMainThread",
		"isMarkedAsUntransferable",
		"markAsUncloneable",
		"markAsUntransferable",
		"parentPort",
		"receiveMessageOnPort",
		"resourceLimits",
		"setEnvironmentData",
		"threadId",
		"threadName",
		"workerData",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:worker_threads"),
};

const MODULE: HostModuleSpec = {
	id: "node:module",
	named: [
		"Module",
		"builtinModules",
		"constants",
		"createRequire",
		"enableCompileCache",
		"findPackageJSON",
		"findSourceMap",
		"flushCompileCache",
		"getCompileCacheDir",
		"getSourceMapsSupport",
		"globalPaths",
		"isBuiltin",
		"register",
		"registerHooks",
		"setSourceMapsSupport",
		"syncBuiltinESMExports",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:module"),
};

const CHILD_PROCESS: HostModuleSpec = {
	id: "node:child_process",
	named: [
		"ChildProcess",
		"exec",
		"execFile",
		"execFileSync",
		"execSync",
		"fork",
		"spawn",
		"spawnSync",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:child_process"),
};

const CONSOLE: HostModuleSpec = {
	id: "node:console",
	named: [
		"Console",
		"assert",
		"clear",
		"count",
		"countReset",
		"debug",
		"dir",
		"dirxml",
		"error",
		"group",
		"groupCollapsed",
		"groupEnd",
		"info",
		"log",
		"profile",
		"profileEnd",
		"table",
		"time",
		"timeEnd",
		"timeLog",
		"timeStamp",
		"trace",
		"warn",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:console"),
};

const CLUSTER: HostModuleSpec = {
	id: "node:cluster",
	named: [
		"fork",
		"isMaster",
		"isPrimary",
		"isWorker",
		"on",
		"once",
		"setMaxListeners",
		"worker",
		"workers",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:cluster"),
};

// The authentication-grade slice: hashing, HMAC, PBKDF2, Argon2 (sync and
// off-event-loop), the CSPRNG helpers, RSA/EC/Ed25519 signing, plus what pinned
// Express dependencies reach for.
const CRYPTO: HostModuleSpec = {
	id: "node:crypto",
	named: [
		"Cipheriv",
		"Decipheriv",
		"Hash",
		"Hmac",
		"KeyObject",
		"Sign",
		"Verify",
		"X509Certificate",
		"argon2",
		"argon2Sync",
		"constants",
		"createCipheriv",
		"createDecipheriv",
		"createHash",
		"createHmac",
		"createPrivateKey",
		"createPublicKey",
		"createSecretKey",
		"createSign",
		"createVerify",
		"generateKey",
		"generateKeyPair",
		"generateKeyPairSync",
		"generateKeySync",
		"getCipherInfo",
		"getCiphers",
		"getCurves",
		"getHashes",
		"getRandomValues",
		"hash",
		"hkdf",
		"hkdfSync",
		"pbkdf2",
		"pbkdf2Sync",
		"publicEncrypt",
		"randomBytes",
		"randomFill",
		"randomFillSync",
		"randomInt",
		"randomUUID",
		"randomUUIDv7",
		"scrypt",
		"scryptSync",
		"sign",
		"subtle",
		"timingSafeEqual",
		"verify",
		"webcrypto",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:crypto"),
};

const PERF_HOOKS: HostModuleSpec = {
	id: "node:perf_hooks",
	named: [
		"Performance",
		"PerformanceEntry",
		"PerformanceMark",
		"PerformanceMeasure",
		"PerformanceObserver",
		"PerformanceObserverEntryList",
		"PerformanceResourceTiming",
		"constants",
		"createHistogram",
		"eventLoopUtilization",
		"monitorEventLoopDelay",
		"performance",
		"timerify",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:perf_hooks"),
};

const TLS: HostModuleSpec = {
	id: "node:tls",
	named: [
		"CLIENT_RENEG_LIMIT",
		"CLIENT_RENEG_WINDOW",
		"DEFAULT_CIPHERS",
		"DEFAULT_ECDH_CURVE",
		"DEFAULT_MAX_VERSION",
		"DEFAULT_MIN_VERSION",
		"SecureContext",
		"Server",
		"TLSSocket",
		"checkServerIdentity",
		"connect",
		"createSecureContext",
		"createServer",
		"getCACertificates",
		"getCertificateCompressionAlgorithms",
		"getCiphers",
		"rootCertificates",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:tls"),
};

const EVENTS: HostModuleSpec = {
	id: "node:events",
	named: [
		"EventEmitter",
		"EventEmitterAsyncResource",
		"addAbortListener",
		"captureRejectionSymbol",
		"captureRejections",
		"defaultMaxListeners",
		"errorMonitor",
		"getEventListeners",
		"getMaxListeners",
		"init",
		"listenerCount",
		"on",
		"once",
		"setMaxListeners",
		"usingDomains",
	],
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
	named: [
		"MIMEParams",
		"MIMEType",
		"TextDecoder",
		"TextEncoder",
		"_extend",
		"aborted",
		"callbackify",
		"convertProcessSignalToExitCode",
		"debounce",
		"debug",
		"debuglog",
		"deprecate",
		"diff",
		"format",
		"formatWithOptions",
		"getCallSites",
		"getSystemErrorMap",
		"getSystemErrorMessage",
		"getSystemErrorName",
		"inherits",
		"inspect",
		"isArray",
		"isBoolean",
		"isBuffer",
		"isDeepStrictEqual",
		"markPromiseAsHandled",
		"isFunction",
		"isNull",
		"isNullOrUndefined",
		"isNumber",
		"isObject",
		"isString",
		"isSymbol",
		"isUndefined",
		"parseArgs",
		"parseEnv",
		"promisify",
		"stripVTControlCharacters",
		"styleText",
		"toUSVString",
		"transferableAbortController",
		"transferableAbortSignal",
		"types",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:util"),
};

const SYS: HostModuleSpec = {
	id: "node:sys",
	named: UTIL.named,
	hasDefault: true,
	installer: hostInstallerSymbol("node:sys"),
};

const CONSTANTS: HostModuleSpec = {
	id: "node:constants",
	named: [],
	hasDefault: true,
	installer: hostInstallerSymbol("node:constants"),
};

const PUNYCODE: HostModuleSpec = {
	id: "node:punycode",
	named: ["decode", "encode", "toASCII", "toUnicode", "ucs2", "version"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:punycode"),
};

const UTIL_TYPES: HostModuleSpec = {
	id: "node:util/types",
	named: [
		"isArgumentsObject",
		"isNativeError",
		"isPromise",
		"isAnyArrayBuffer",
		"isArrayBuffer",
		"isSharedArrayBuffer",
		"isDataView",
		"isDate",
		"isMap",
		"isSet",
		"isWeakMap",
		"isWeakSet",
		"isRegExp",
		"isTypedArray",
		"isBoxedPrimitive",
		"isBigIntObject",
		"isBooleanObject",
		"isNumberObject",
		"isStringObject",
		"isSymbolObject",
		"isArrayBufferView",
		"isAsyncFunction",
		"isGeneratorFunction",
		"isGeneratorObject",
		"isModuleNamespaceObject",
		"isProxy",
		"isExternal",
		"isKeyObject",
		"isCryptoKey",
		"isMapIterator",
		"isSetIterator",
		"isInt8Array",
		"isUint8Array",
		"isUint8ClampedArray",
		"isInt16Array",
		"isUint16Array",
		"isInt32Array",
		"isUint32Array",
		"isFloat32Array",
		"isFloat64Array",
		"isBigInt64Array",
		"isBigUint64Array",
		"isFloat16Array",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:util/types"),
};

const BUFFER: HostModuleSpec = {
	id: "node:buffer",
	named: [
		"Blob",
		"Buffer",
		"File",
		"INSPECT_MAX_BYTES",
		"atob",
		"btoa",
		"constants",
		"isAscii",
		"isUtf8",
		"kMaxLength",
		"kStringMaxLength",
		"resolveObjectURL",
		"transcode",
	],
	hasDefault: true,
	installer: BUFFER_INSTALLER_SYMBOL,
};

const PROCESS: HostModuleSpec = {
	id: "node:process",
	// `process` inherits from EventEmitter.prototype, so the listener methods are
	// bindable named exports even though they are not own properties of it.
	named: [
		"abort",
		"addListener",
		"allowedNodeEnvironmentFlags",
		"arch",
		"argv",
		"argv0",
		"availableMemory",
		"binding",
		"chdir",
		"config",
		"constrainedMemory",
		"cpuUsage",
		"cwd",
		"debugPort",
		"dlopen",
		"domain",
		"emit",
		"emitWarning",
		"env",
		"eventNames",
		"execArgv",
		"execPath",
		"execve",
		"exit",
		"features",
		"getActiveResourcesInfo",
		"getBuiltinModule",
		"getMaxListeners",
		"getegid",
		"geteuid",
		"getgid",
		"getgroups",
		"getuid",
		"hasUncaughtExceptionCaptureCallback",
		"hrtime",
		"initgroups",
		"kill",
		"listenerCount",
		"listeners",
		"loadEnvFile",
		"memoryUsage",
		"moduleLoadList",
		"nextTick",
		"off",
		"on",
		"once",
		"pid",
		"platform",
		"ppid",
		"prependListener",
		"prependOnceListener",
		"rawListeners",
		"reallyExit",
		"ref",
		"release",
		"removeAllListeners",
		"removeListener",
		"report",
		"resourceUsage",
		"setMaxListeners",
		"setSourceMapsEnabled",
		"setUncaughtExceptionCaptureCallback",
		"setegid",
		"seteuid",
		"setgid",
		"setgroups",
		"setuid",
		"stderr",
		"stdin",
		"stdout",
		"threadCpuUsage",
		"title",
		"umask",
		"unref",
		"uptime",
		"version",
		"versions",
	],
	hasDefault: true,
	// The module and the free global deliberately share one cached installer so
	// every Node spelling observes the same mutable process object.
	installer: PROCESS_INSTALLER_SYMBOL,
};

const ASSERT_STRICT: HostModuleSpec = {
	id: "node:assert/strict",
	named: [
		"Assert",
		"AssertionError",
		"deepEqual",
		"deepStrictEqual",
		"doesNotMatch",
		"doesNotReject",
		"doesNotThrow",
		"equal",
		"fail",
		"ifError",
		"match",
		"notDeepEqual",
		"notDeepStrictEqual",
		"notEqual",
		"notStrictEqual",
		"ok",
		"partialDeepStrictEqual",
		"rejects",
		"strict",
		"strictEqual",
		"throws",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:assert/strict"),
};

const ASSERT: HostModuleSpec = {
	id: "node:assert",
	named: [
		"Assert",
		"AssertionError",
		"deepEqual",
		"deepStrictEqual",
		"doesNotMatch",
		"doesNotReject",
		"doesNotThrow",
		"equal",
		"fail",
		"ifError",
		"match",
		"notDeepEqual",
		"notDeepStrictEqual",
		"notEqual",
		"notStrictEqual",
		"ok",
		"partialDeepStrictEqual",
		"rejects",
		"strict",
		"strictEqual",
		"throws",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:assert"),
};

const ASYNC_HOOKS: HostModuleSpec = {
	id: "node:async_hooks",
	named: [
		"AsyncLocalStorage",
		"AsyncResource",
		"asyncWrapProviders",
		"createHook",
		"executionAsyncId",
		"executionAsyncResource",
		"triggerAsyncId",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:async_hooks"),
};

const STREAM: HostModuleSpec = {
	id: "node:stream",
	named: [
		"Stream",
		"Readable",
		"Writable",
		"Duplex",
		"Transform",
		"PassThrough",
		"addAbortSignal",
		"compose",
		"destroy",
		"duplexPair",
		"finished",
		"getDefaultHighWaterMark",
		"isDestroyed",
		"isDisturbed",
		"isErrored",
		"isReadable",
		"isWritable",
		"pipeline",
		"promises",
		"setDefaultHighWaterMark",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:stream"),
};

const STREAM_CONSUMERS: HostModuleSpec = {
	id: "node:stream/consumers",
	named: ["arrayBuffer", "blob", "buffer", "bytes", "json", "text"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:stream/consumers"),
};

const STREAM_WEB: HostModuleSpec = {
	id: "node:stream/web",
	named: [
		"ByteLengthQueuingStrategy",
		"CompressionStream",
		"CountQueuingStrategy",
		"DecompressionStream",
		"ReadableByteStreamController",
		"ReadableStream",
		"ReadableStreamBYOBReader",
		"ReadableStreamBYOBRequest",
		"ReadableStreamDefaultController",
		"ReadableStreamDefaultReader",
		"TextDecoderStream",
		"TextEncoderStream",
		"TransformStream",
		"TransformStreamDefaultController",
		"WritableStream",
		"WritableStreamDefaultController",
		"WritableStreamDefaultWriter",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:stream/web"),
};

const STREAM_PROMISES: HostModuleSpec = {
	id: "node:stream/promises",
	named: ["finished", "pipeline"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:stream/promises"),
};

const HTTP: HostModuleSpec = {
	id: "node:http",
	named: [
		"Agent",
		"CloseEvent",
		"METHODS",
		"MessageEvent",
		"STATUS_CODES",
		"IncomingMessage",
		"OutgoingMessage",
		"ServerResponse",
		"Server",
		"ClientRequest",
		"createServer",
		"get",
		"globalAgent",
		"isValidHeaderName",
		"isValidHeaderValue",
		"maxHeaderSize",
		"request",
		"setMaxIdleHTTPParsers",
		"validateHeaderName",
		"validateHeaderValue",
		"WebSocket",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:http"),
};

const HTTPS: HostModuleSpec = {
	id: "node:https",
	named: ["Agent", "Server", "createServer", "get", "globalAgent", "request"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:https"),
};

const HTTP2: HostModuleSpec = {
	id: "node:http2",
	named: ["connect"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:http2"),
};

const INSPECTOR: HostModuleSpec = {
	id: "node:inspector",
	named: ["Session", "close", "open", "url"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:inspector"),
};

const TIMERS: HostModuleSpec = {
	id: "node:timers",
	named: [
		"clearImmediate",
		"clearInterval",
		"clearTimeout",
		"promises",
		"setImmediate",
		"setInterval",
		"setTimeout",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:timers"),
};

const TIMERS_PROMISES: HostModuleSpec = {
	id: "node:timers/promises",
	named: ["scheduler", "setImmediate", "setInterval", "setTimeout"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:timers/promises"),
};

const URL: HostModuleSpec = {
	id: "node:url",
	named: [
		"URL",
		"URLSearchParams",
		"Url",
		"domainToASCII",
		"domainToUnicode",
		"fileURLToPath",
		"format",
		"parse",
		"pathToFileURL",
		"resolve",
		"resolveObject",
		"urlToHttpOptions",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:url"),
};

const QUERYSTRING: HostModuleSpec = {
	id: "node:querystring",
	named: [
		"decode",
		"encode",
		"escape",
		"parse",
		"stringify",
		"unescape",
		"unescapeBuffer",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:querystring"),
};

const READLINE: HostModuleSpec = {
	id: "node:readline",
	named: [
		"Interface",
		"clearLine",
		"clearScreenDown",
		"createInterface",
		"cursorTo",
		"emitKeypressEvents",
		"moveCursor",
		"promises",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:readline"),
};

const READLINE_PROMISES: HostModuleSpec = {
	id: "node:readline/promises",
	named: ["Interface", "createInterface"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:readline/promises"),
};

const DGRAM: HostModuleSpec = {
	id: "node:dgram",
	named: ["Socket", "createSocket"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:dgram"),
};

const NET: HostModuleSpec = {
	id: "node:net",
	named: [
		"Server",
		"Socket",
		"connect",
		"createConnection",
		"createServer",
		"getDefaultAutoSelectFamily",
		"getDefaultAutoSelectFamilyAttemptTimeout",
		"isIP",
		"isIPv4",
		"isIPv6",
		"setDefaultAutoSelectFamily",
		"setDefaultAutoSelectFamilyAttemptTimeout",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:net"),
};

const OS: HostModuleSpec = {
	id: "node:os",
	named: [
		"EOL",
		"arch",
		"availableParallelism",
		"constants",
		"cpus",
		"devNull",
		"endianness",
		"freemem",
		"getPriority",
		"homedir",
		"hostname",
		"loadavg",
		"machine",
		"networkInterfaces",
		"platform",
		"release",
		"setPriority",
		"tmpdir",
		"totalmem",
		"type",
		"uptime",
		"userInfo",
		"version",
	],
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
	named: [
		"BrotliCompress",
		"BrotliDecompress",
		"Deflate",
		"DeflateRaw",
		"Gunzip",
		"Gzip",
		"Inflate",
		"InflateRaw",
		"Unzip",
		"brotliCompress",
		"brotliCompressSync",
		"brotliDecompress",
		"brotliDecompressSync",
		"codes",
		"constants",
		"crc32",
		"createBrotliCompress",
		"createBrotliDecompress",
		"createDeflate",
		"createDeflateRaw",
		"createGunzip",
		"createGzip",
		"createInflate",
		"createInflateRaw",
		"createUnzip",
		"deflate",
		"deflateRaw",
		"deflateRawSync",
		"deflateSync",
		"gunzip",
		"gunzipSync",
		"gzip",
		"gzipSync",
		"inflate",
		"inflateRaw",
		"inflateRawSync",
		"inflateSync",
		"unzip",
		"unzipSync",
	],
	hasDefault: true,
	installer: hostInstallerSymbol("node:zlib"),
};

const SQLITE: HostModuleSpec = {
	id: "node:sqlite",
	named: ["DatabaseSync", "StatementSync"],
	hasDefault: true,
	installer: hostInstallerSymbol("node:sqlite"),
};

/** Supported `node:*` built-ins, keyed by canonical specifier. */
export const HOST_MODULES: ReadonlyMap<string, HostModuleSpec> = new Map(
	[
		PATH,
		PATH_POSIX,
		PATH_WIN32,
		FS,
		FS_PROMISES,
		V8,
		VM,
		DIAGNOSTICS_CHANNEL,
		DOMAIN,
		DNS,
		DNS_PROMISES,
		WORKER_THREADS,
		MODULE,
		CHILD_PROCESS,
		CLUSTER,
		CONSOLE,
		CRYPTO,
		PERF_HOOKS,
		TLS,
		EVENTS,
		TTY,
		UTIL,
		UTIL_TYPES,
		SYS,
		CONSTANTS,
		PUNYCODE,
		BUFFER,
		PROCESS,
		ASSERT,
		ASSERT_STRICT,
		ASYNC_HOOKS,
		STREAM,
		STREAM_PROMISES,
		STREAM_CONSUMERS,
		STREAM_WEB,
		HTTP,
		HTTPS,
		HTTP2,
		INSPECTOR,
		TIMERS,
		TIMERS_PROMISES,
		URL,
		QUERYSTRING,
		READLINE,
		READLINE_PROMISES,
		DGRAM,
		NET,
		OS,
		STRING_DECODER,
		ZLIB,
		SQLITE,
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
	const platform = PLATFORM_MODULES.find(
		(module) => module.id === specifier && module.kind === "native",
	);
	return platform === undefined || platform.kind !== "native"
		? HOST_MODULES.get(specifier)
		: {
				id: platform.id,
				named: platform.exports.map((entry) => entry.name),
				hasDefault: false,
				installer: platform.installer,
				platform,
			};
}

/** Canonical catalog id for a Node built-in spelling, if supported. */
export function canonicalNodeHostModuleId(specifier: string): string | undefined {
	const id = isNodeSpecifier(specifier) ? specifier : `node:${specifier}`;
	if (!isNodeSpecifier(specifier) && NODE_PREFIX_ONLY_BUILTIN_IDS.has(id)) {
		return undefined;
	}
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

export function supportedNodeBuiltinNames(): Array<string> {
	const names = [...HOST_MODULES.keys()]
		.map((id) => (NODE_PREFIX_ONLY_BUILTIN_IDS.has(id) ? id : id.slice(5)))
		.sort();
	return [
		...names.filter((name) => !isNodeSpecifier(name)),
		...names.filter(isNodeSpecifier),
	];
}
