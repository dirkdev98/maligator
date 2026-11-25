import {
	COMPILER_VALUE_KIND_BOOLEAN as BOOLEAN,
	COMPILER_VALUE_KIND_BIGINT as BIGINT,
	COMPILER_VALUE_KIND_NULL as NULL,
	COMPILER_VALUE_KIND_NUMBER as NUMBER,
	COMPILER_VALUE_KIND_OBJECT as OBJECT,
	COMPILER_VALUE_KIND_STRING as STRING,
	COMPILER_VALUE_KIND_SYMBOL as SYMBOL,
	COMPILER_VALUE_KIND_TOP as TOP,
	COMPILER_VALUE_KIND_UNDEFINED as UNDEFINED,
} from "./compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "./compiler-value-kinds.ts";

export interface HostValueContract {
	readonly mask: CompilerValueKindMask;
	readonly brand?: "Array" | "Uint8Array";
	readonly hostObject?: HostObjectKind;
	readonly installedObject?: true;
	readonly hostConstructor?: HostObjectKind;
	readonly assetHandle?: "file" | "directory";
	readonly platformObject?:
		| "file"
		| "directory"
		| "writer"
		| "watcher"
		| "server"
		| "workerPool"
		| "workerPoolStats"
		| "transferEnvelope";
	readonly selector?: {
		readonly argument: number;
		readonly kind:
			| "encoding"
			| "buffer-encoding"
			| "output-encoding"
			| "digest-encoding"
			| "signature-argument"
			| "read-size"
			| "callback-chunk"
			| "tls-socket"
			| "text-flag"
			| "stat-options"
			| "mkdir-options"
			| "compression-info"
			| "exec-output"
			| "exec-file-output"
			| "exec-fulfillment"
			| "exec-file-fulfillment"
			| "resolve-value";
	};
}

export type HostResultContract =
	| { readonly kind: "return"; readonly value: HostValueContract }
	| {
			// Only native direct fulfillment can guarantee object payloads without
			// first checking the resolved object's then behavior.
			readonly kind: "fulfill";
			readonly value: HostValueContract;
			readonly immediateMask?: CompilerValueKindMask;
			readonly optionalCallback?: number;
			readonly reason?: string;
	  }
	| {
			readonly kind: "resolve";
			readonly value: HostValueContract;
			readonly reason?: string;
	  }
	| { readonly kind: "callback"; readonly reason: string }
	| { readonly kind: "never"; readonly reason: string }
	| { readonly kind: "dynamic"; readonly reason: string };

const returned = (
	mask: CompilerValueKindMask,
	brand?: HostValueContract["brand"],
): HostResultContract => ({ kind: "return", value: { mask, brand } });
const fulfilled = (
	mask: CompilerValueKindMask,
	brand?: HostValueContract["brand"],
): HostResultContract => ({ kind: "fulfill", value: { mask, brand } });
const selected = (
	kind: "return" | "fulfill" | "resolve",
	selector: NonNullable<HostValueContract["selector"]>,
	mask = STRING | OBJECT,
): HostResultContract => ({ kind, value: { mask, selector } });
const callback: HostResultContract = {
	kind: "callback",
	reason: "The asynchronous operation reports completion to a Node-style callback.",
};
const dynamic = (reason: string): HostResultContract => ({ kind: "dynamic", reason });
const neverReturns = (reason: string): HostResultContract => ({ kind: "never", reason });

function exportsWithContracts(
	...groups: ReadonlyArray<readonly [HostResultContract, ...Array<string>]>
): ReadonlyMap<string, HostResultContract> {
	return new Map(
		groups.flatMap(([contract, ...names]) =>
			names.map((name) => [name, contract] as const),
		),
	);
}

function nativeConstructor(
	hostConstructor: HostObjectKind,
	brand?: HostValueContract["brand"],
): HostResultContract {
	return {
		kind: "return",
		value: { mask: OBJECT, hostObject: hostConstructor, hostConstructor, brand },
	};
}

function installedObject(hostObject: HostObjectKind): HostResultContract {
	return { kind: "return", value: { mask: OBJECT, hostObject, installedObject: true } };
}

function streamConstructor(hostConstructor: HostObjectKind): HostResultContract {
	return { kind: "return", value: { mask: OBJECT | UNDEFINED, hostConstructor } };
}

const fs = exportsWithContracts(
	[nativeConstructor("Stats"), "Stats"],
	[nativeConstructor("Dirent"), "Dirent"],
	[neverReturns("Directory handles are allocated by opendir."), "Dir"],
	[hostObject("Dir"), "opendirSync"],
	[selected("return", { kind: "encoding", argument: 1 }), "readFileSync"],
	[
		selected("return", { kind: "buffer-encoding", argument: 1 }),
		"mkdtempSync",
		"readlinkSync",
		"realpathSync",
	],
	[returned(BOOLEAN), "existsSync"],
	[returned(NUMBER), "openSync", "readSync", "readvSync", "writeSync", "writevSync"],
	[
		selected("return", { kind: "mkdir-options", argument: 1 }, STRING | UNDEFINED),
		"mkdirSync",
	],
	[
		{
			kind: "return",
			value: {
				hostObject: "Stats",
				mask: OBJECT | UNDEFINED,
				selector: { kind: "stat-options", argument: 1 },
			},
		},
		"lstatSync",
		"statSync",
	],
	[hostObject("Stats"), "fstatSync"],
	[returned(OBJECT, "Array"), "readdirSync", "globSync"],
	[
		returned(OBJECT),
		"FileReadStream",
		"FileWriteStream",
		"ReadStream",
		"WriteStream",
		"createReadStream",
		"createWriteStream",
		"mkdtempDisposableSync",
		"statfsSync",
		"watch",
		"watchFile",
	],
	[
		returned(UNDEFINED),
		"accessSync",
		"appendFileSync",
		"chmodSync",
		"chownSync",
		"closeSync",
		"copyFileSync",
		"cpSync",
		"fchmodSync",
		"fchownSync",
		"fdatasyncSync",
		"fsyncSync",
		"ftruncateSync",
		"futimesSync",
		"lchownSync",
		"linkSync",
		"lutimesSync",
		"renameSync",
		"rmSync",
		"rmdirSync",
		"symlinkSync",
		"truncateSync",
		"unlinkSync",
		"unwatchFile",
		"utimesSync",
		"writeFileSync",
	],
	[
		callback,
		"access",
		"appendFile",
		"chmod",
		"chown",
		"close",
		"copyFile",
		"cp",
		"exists",
		"fchmod",
		"fchown",
		"fdatasync",
		"fstat",
		"fsync",
		"ftruncate",
		"futimes",
		"glob",
		"lchown",
		"link",
		"lstat",
		"lutimes",
		"mkdir",
		"mkdtemp",
		"open",
		"opendir",
		"read",
		"readFile",
		"readlink",
		"readv",
		"readdir",
		"realpath",
		"rename",
		"rm",
		"rmdir",
		"stat",
		"statfs",
		"symlink",
		"truncate",
		"unlink",
		"utimes",
		"write",
		"writeFile",
		"writev",
	],
);

const fsPromises = exportsWithContracts(
	[selected("fulfill", { kind: "encoding", argument: 1 }), "readFile"],
	[
		selected("fulfill", { kind: "buffer-encoding", argument: 1 }),
		"mkdtemp",
		"readlink",
		"realpath",
	],
	[{ kind: "fulfill", value: { mask: OBJECT, hostObject: "FileHandle" } }, "open"],
	[{ kind: "fulfill", value: { mask: OBJECT, hostObject: "Dir" } }, "opendir"],
	[fulfilled(OBJECT), "statfs"],
	[
		{
			kind: "fulfill",
			value: {
				hostObject: "Stats",
				mask: OBJECT | UNDEFINED,
				selector: { kind: "stat-options", argument: 1 },
			},
		},
		"lstat",
		"stat",
	],
	[fulfilled(OBJECT, "Array"), "readdir"],
	[
		selected("fulfill", { kind: "mkdir-options", argument: 1 }, STRING | UNDEFINED),
		"mkdir",
	],
	[
		fulfilled(UNDEFINED),
		"access",
		"appendFile",
		"chmod",
		"chown",
		"copyFile",
		"cp",
		"lchown",
		"link",
		"lutimes",
		"rename",
		"rmdir",
		"rm",
		"symlink",
		"truncate",
		"unlink",
		"utimes",
		"writeFile",
	],
	[returned(OBJECT), "glob", "watch"],
	[fulfilled(OBJECT), "mkdtempDisposable"],
);

const maligatorFs = exportsWithContracts(
	[returned(STRING), "mediaType"],
	[selected("fulfill", { kind: "text-flag", argument: 1 }), "read"],
	[fulfilled(BOOLEAN), "exists"],
	[fulfilled(NUMBER), "write"],
	[fulfilled(OBJECT), "stat"],
	[fulfilled(OBJECT, "Array"), "list"],
	[fulfilled(STRING), "readlink", "realpath", "temporaryDirectory"],
	[
		fulfilled(UNDEFINED),
		"chmod",
		"copy",
		"createDirectory",
		"move",
		"remove",
		"removeDirectory",
		"symlink",
	],
);

export const NODE_FILE_HANDLE_RESULTS = {
	properties: exportsWithContracts([returned(NUMBER), "fd"]),
	methods: exportsWithContracts(
		[selected("fulfill", { kind: "encoding", argument: 0 }), "readFile"],
		[fulfilled(OBJECT), "read", "write"],
		[{ kind: "fulfill", value: { mask: OBJECT, hostObject: "Stats" } }, "stat"],
		[
			fulfilled(UNDEFINED),
			"appendFile",
			"close",
			"datasync",
			"sync",
			"truncate",
			"writeFile",
		],
	),
} as const;

const path = exportsWithContracts(
	[
		returned(STRING),
		"basename",
		"dirname",
		"extname",
		"format",
		"join",
		"normalize",
		"relative",
		"resolve",
	],
	[returned(BOOLEAN), "isAbsolute", "matchesGlob"],
	[returned(OBJECT), "parse"],
	[
		{ kind: "dynamic", reason: "Returns non-string inputs unchanged." },
		"toNamespacedPath",
	],
);

const os = exportsWithContracts(
	[
		returned(STRING),
		"arch",
		"endianness",
		"homedir",
		"hostname",
		"machine",
		"platform",
		"release",
		"tmpdir",
		"type",
		"version",
	],
	[
		returned(NUMBER),
		"availableParallelism",
		"freemem",
		"getPriority",
		"totalmem",
		"uptime",
	],
	[returned(OBJECT, "Array"), "cpus", "loadavg"],
	[returned(OBJECT), "networkInterfaces", "userInfo"],
	[returned(UNDEFINED), "setPriority"],
);

const fsDescriptor = exportsWithContracts(
	[fulfilled(OBJECT), "openDescriptor"],
	[fulfilled(OBJECT | UNDEFINED), "readChunk"],
	[fulfilled(NUMBER), "writeChunk"],
	[fulfilled(UNDEFINED), "flushDescriptor"],
	[
		{ kind: "fulfill", value: { mask: UNDEFINED }, immediateMask: OBJECT | UNDEFINED },
		"closeDescriptor",
	],
);

const process = exportsWithContracts(
	[returned(STRING), "cwd"],
	[
		returned(NUMBER),
		"availableMemory",
		"constrainedMemory",
		"getegid",
		"geteuid",
		"getgid",
		"getuid",
		"getMaxListeners",
		"listenerCount",
		"umask",
		"uptime",
	],
	[returned(BOOLEAN), "emit", "hasUncaughtExceptionCaptureCallback", "kill"],
	[
		returned(OBJECT, "Array"),
		"eventNames",
		"getActiveResourcesInfo",
		"getgroups",
		"hrtime",
		"listeners",
		"rawListeners",
	],
	[
		returned(OBJECT),
		"cpuUsage",
		"memoryUsage",
		"resourceUsage",
		"threadCpuUsage",
		"addListener",
		"off",
		"on",
		"once",
		"prependListener",
		"prependOnceListener",
		"removeAllListeners",
		"removeListener",
		"setMaxListeners",
	],
	[returned(OBJECT | UNDEFINED), "getBuiltinModule"],
	[
		returned(UNDEFINED),
		"chdir",
		"emitWarning",
		"exit",
		"initgroups",
		"loadEnvFile",
		"nextTick",
		"reallyExit",
		"ref",
		"setSourceMapsEnabled",
		"setUncaughtExceptionCaptureCallback",
		"setegid",
		"seteuid",
		"setgid",
		"setgroups",
		"setuid",
		"unref",
	],
	[{ kind: "never", reason: "Terminates the process or throws." }, "abort"],
	[
		{
			kind: "never",
			reason: "The installed function throws an unsupported-operation error.",
		},
		"binding",
		"dlopen",
		"execve",
	],
);

const url = exportsWithContracts(
	[nativeConstructor("URL"), "URL"],
	[nativeConstructor("URLSearchParams"), "URLSearchParams"],
	[{ kind: "return", value: { mask: OBJECT, hostConstructor: "LegacyUrl" } }, "Url"],
	[hostObject("LegacyUrl"), "parse"],
	[hostObject("URL"), "pathToFileURL"],
	[
		returned(STRING),
		"domainToASCII",
		"domainToUnicode",
		"fileURLToPath",
		"format",
		"resolve",
	],
	[returned(OBJECT), "urlToHttpOptions"],
	[
		{ kind: "dynamic", reason: "An absent base returns the second argument unchanged." },
		"resolveObject",
	],
);

const util = exportsWithContracts(
	[nativeConstructor("TextEncoder"), "TextEncoder"],
	[nativeConstructor("TextDecoder"), "TextDecoder"],
	[nativeConstructor("MIMEType"), "MIMEType"],
	[nativeConstructor("MIMEParams"), "MIMEParams"],
	[
		returned(STRING),
		"format",
		"formatWithOptions",
		"getSystemErrorMessage",
		"getSystemErrorName",
		"inspect",
		"styleText",
		"toUSVString",
	],
	[returned(NUMBER), "convertProcessSignalToExitCode"],
	[
		returned(BOOLEAN),
		"isArray",
		"isBoolean",
		"isBuffer",
		"isDeepStrictEqual",
		"isFunction",
		"isNull",
		"isNullOrUndefined",
		"isNumber",
		"isObject",
		"isString",
		"isSymbol",
		"isUndefined",
	],
	[returned(OBJECT, "Array"), "diff", "getCallSites"],
	[
		returned(OBJECT),
		"callbackify",
		"debounce",
		"debug",
		"debuglog",
		"deprecate",
		"getSystemErrorMap",
		"parseArgs",
		"parseEnv",
		"promisify",
		"transferableAbortController",
		"transferableAbortSignal",
	],
	[returned(UNDEFINED), "inherits", "markPromiseAsHandled"],
	[fulfilled(UNDEFINED), "aborted"],
	[
		{ kind: "dynamic", reason: "Returns the initial target argument unchanged." },
		"_extend",
	],
	[
		{
			kind: "dynamic",
			reason: "The ANSI path returns the result of the String replace method.",
		},
		"stripVTControlCharacters",
	],
);

const utilTypes = exportsWithContracts([
	returned(BOOLEAN),
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
]);

const v8 = exportsWithContracts(
	[returned(NUMBER), "cachedDataVersionTag"],
	[returned(BOOLEAN), "isStringOneByteRepresentation"],
	[returned(OBJECT), "getHeapStatistics", "getHeapCodeStatistics"],
	[returned(OBJECT, "Array"), "getHeapSpaceStatistics"],
	[
		returned(UNDEFINED),
		"setFlagsFromString",
		"setHeapSnapshotNearHeapLimit",
		"stopCoverage",
		"takeCoverage",
	],
);

const perfHooks = exportsWithContracts(
	[nativeConstructor("PerformanceObserver"), "PerformanceObserver"],
	[installedObject("Performance"), "performance"],
	[hostObject("Histogram"), "createHistogram", "monitorEventLoopDelay"],
	[returned(OBJECT), "eventLoopUtilization", "timerify"],
	[
		{
			kind: "never",
			reason: "The installed constructor rejects direct construction and calls.",
		},
		"Performance",
		"PerformanceEntry",
		"PerformanceMark",
		"PerformanceMeasure",
		"PerformanceObserverEntryList",
		"PerformanceResourceTiming",
	],
);

const querystring = exportsWithContracts(
	[returned(OBJECT), "parse", "decode"],
	[returned(STRING), "stringify", "encode", "escape", "unescape"],
	[returned(OBJECT, "Uint8Array"), "unescapeBuffer"],
);

const buffer = exportsWithContracts(
	[nativeConstructor("Buffer", "Uint8Array"), "Buffer"],
	[hostObject("Buffer", "Uint8Array"), "SlowBuffer", "transcode"],
	[nativeConstructor("Blob"), "Blob"],
	[nativeConstructor("File"), "File"],
	[returned(STRING), "atob", "btoa"],
	[returned(BOOLEAN), "isAscii", "isUtf8"],
	[returned(UNDEFINED), "resolveObjectURL"],
);

const maligatorWorkers = exportsWithContracts(
	[nativeConstructor("MaligatorWorker"), "Worker"],
	[nativeConstructor("MaligatorMessageChannel"), "MessageChannel"],
	[hostObject("WorkerCapabilities"), "capabilities"],
	[hostObject("WorkerUrl"), "createWorkerUrl"],
	[hostObject("WorkerMessage", undefined, OBJECT | UNDEFINED), "receiveMessageOnPort"],
	[
		{ kind: "never", reason: "Ports are created by the channel and worker factories." },
		"MessagePort",
	],
	[
		{
			kind: "never",
			reason: "Terminates the current worker or throws outside a worker.",
		},
		"failCurrent",
	],
);

const vm = exportsWithContracts(
	[nativeConstructor("VmScript"), "Script"],
	[hostObject("VmScript"), "createScript"],
	[returned(OBJECT), "compileFunction", "createContext"],
	[returned(BOOLEAN), "isContext"],
	[
		dynamic("Returns the evaluated script's completion value."),
		"runInContext",
		"runInNewContext",
		"runInThisContext",
	],
);
const diagnostics = exportsWithContracts(
	[nativeConstructor("DiagnosticsChannel"), "Channel"],
	[hostObject("DiagnosticsChannel"), "channel"],
	[hostObject("TracingChannel"), "tracingChannel"],
	[returned(BOOLEAN), "hasSubscribers", "unsubscribe"],
	[returned(UNDEFINED), "subscribe"],
);
const cluster = exportsWithContracts(
	[neverReturns("Process clustering is unsupported."), "fork"],
	[dynamic("Returns the supplied receiver unchanged."), "on", "once", "setMaxListeners"],
);
const inspector = exportsWithContracts(
	[returned(UNDEFINED), "close", "url"],
	[neverReturns("The native inspector is unsupported."), "Session", "open"],
);
const asyncHooks = exportsWithContracts(
	[nativeConstructor("AsyncLocalStorage"), "AsyncLocalStorage"],
	[nativeConstructor("AsyncResource"), "AsyncResource"],
	[hostObject("AsyncHook"), "createHook"],
	[returned(OBJECT), "executionAsyncResource"],
	[returned(NUMBER), "executionAsyncId", "triggerAsyncId"],
);
const console = exportsWithContracts(
	[nativeConstructor("NodeConsole"), "Console"],
	[
		returned(UNDEFINED),
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
);
const module = exportsWithContracts(
	[nativeConstructor("NodeModule"), "default", "Module"],
	[hostObject("NodeRequire"), "createRequire"],
	[hostObject("ModuleHookRegistration"), "registerHooks"],
	[hostObject("SourceMapSupport"), "getSourceMapsSupport"],
	[hostObject("CompileCacheResult"), "enableCompileCache"],
	[
		neverReturns("The runtime graph cannot resolve unprepared module requests."),
		"_resolveFilename",
	],
	[returned(OBJECT, "Array"), "_nodeModulePaths"],
	[returned(BOOLEAN), "isBuiltin"],
	[returned(STRING | UNDEFINED), "findPackageJSON"],
	[
		returned(UNDEFINED),
		"findSourceMap",
		"flushCompileCache",
		"getCompileCacheDir",
		"register",
		"setSourceMapsSupport",
		"syncBuiltinESMExports",
	],
);

export const CAPTURED_HOST_RESULTS = exportsWithContracts(
	[hostObject("AnyKeyObject"), "%MAL_INTRINSIC_NODE_CRYPTO_MODULE%.KeyObject.from"],
	[returned(OBJECT, "Array"), "%MAL_INTRINSIC_NODE_MODULE_API_MODULE%._nodeModulePaths"],
	[
		neverReturns("The runtime graph cannot resolve unprepared module requests."),
		"%MAL_INTRINSIC_NODE_MODULE_API_MODULE%._resolveFilename",
	],
	[returned(BIGINT), "globalThis.process.hrtime.bigint"],
	[returned(NUMBER), "globalThis.process.memoryUsage.rss"],
	[returned(OBJECT), "globalThis.process.report.getReport"],
	[
		returned(BOOLEAN),
		"globalThis.process.stdout.write",
		"globalThis.process.stderr.write",
	],
	[
		returned(NUMBER | UNDEFINED),
		"globalThis.process.stdout.columns<get>",
		"globalThis.process.stderr.columns<get>",
		"globalThis.process.exitCode<get>",
	],
	[returned(BOOLEAN), "globalThis.process.sourceMapsEnabled<get>"],
	[returned(OBJECT), "%MAL_INTRINSIC_NODE_FS_MODULE%.promises<get>"],
	[returned(OBJECT, "Array"), "%MAL_INTRINSIC_NODE_TLS_MODULE%.rootCertificates<get>"],
	[
		selected("return", { kind: "buffer-encoding", argument: 1 }),
		"%MAL_INTRINSIC_NODE_FS_MODULE%.realpathSync.native",
	],
	[callback, "%MAL_INTRINSIC_NODE_FS_MODULE%.realpath.native"],
	[returned(STRING), '%MAL_INTRINSIC_NODE_BUILTIN_MODULES%["node:punycode"].ucs2.encode'],
	[
		returned(OBJECT, "Array"),
		'%MAL_INTRINSIC_NODE_BUILTIN_MODULES%["node:punycode"].ucs2.decode',
	],
	[
		selected("fulfill", { kind: "exec-fulfillment", argument: 1 }, OBJECT),
		'%MAL_INTRINSIC_NODE_BUILTIN_MODULES%["node:child_process"].exec[%MAL_INTRINSIC_NODE_BUILTIN_MODULES%["node:child_process"].exec.[[SymbolKey:nodejs.util.promisify.custom]]]',
	],
	[
		selected("fulfill", { kind: "exec-file-fulfillment", argument: 1 }, OBJECT),
		'%MAL_INTRINSIC_NODE_BUILTIN_MODULES%["node:child_process"].execFile[%MAL_INTRINSIC_NODE_BUILTIN_MODULES%["node:child_process"].exec.[[SymbolKey:nodejs.util.promisify.custom]]]',
	],
	[
		returned(BOOLEAN),
		"%MAL_INTRINSIC_NODE_V8_MODULE%.startupSnapshot.isBuildingSnapshot",
	],
	[
		neverReturns("The runtime does not build startup snapshots."),
		"%MAL_INTRINSIC_NODE_V8_MODULE%.startupSnapshot.addDeserializeCallback",
		"%MAL_INTRINSIC_NODE_V8_MODULE%.startupSnapshot.addSerializeCallback",
		"%MAL_INTRINSIC_NODE_V8_MODULE%.startupSnapshot.setDeserializeMainFunction",
	],
);
const nodeWorkers = exportsWithContracts(
	[nativeConstructor("BroadcastChannel"), "BroadcastChannel"],
	[nativeConstructor("MessageChannel"), "MessageChannel"],
	[nativeConstructor("NodeWorker"), "Worker"],
	[returned(BOOLEAN), "isMarkedAsUntransferable"],
	[
		returned(UNDEFINED),
		"markAsUncloneable",
		"markAsUntransferable",
		"setEnvironmentData",
	],
	[hostObject("WorkerMessage", undefined, OBJECT | UNDEFINED), "receiveMessageOnPort"],
	[
		dynamic("Reads an application-defined value from the environment data map."),
		"getEnvironmentData",
	],
	[neverReturns("Ports are created by the channel and worker factories."), "MessagePort"],
);
const assertions = exportsWithContracts(
	[nativeConstructor("Assert"), "Assert"],
	[returned(OBJECT), "AssertionError"],
	[fulfilled(UNDEFINED), "rejects", "doesNotReject"],
	[neverReturns("Always throws the assertion failure."), "fail"],
	[
		returned(UNDEFINED),
		"default",
		"strict",
		"deepEqual",
		"deepStrictEqual",
		"doesNotMatch",
		"doesNotThrow",
		"equal",
		"ifError",
		"match",
		"notDeepEqual",
		"notDeepStrictEqual",
		"notEqual",
		"notStrictEqual",
		"ok",
		"partialDeepStrictEqual",
		"strictEqual",
		"throws",
	],
);
const zlib = exportsWithContracts(
	[
		nativeConstructor("ZlibStream"),
		"BrotliCompress",
		"BrotliDecompress",
		"Deflate",
		"DeflateRaw",
		"Gunzip",
		"Gzip",
		"Inflate",
		"InflateRaw",
		"Unzip",
	],
	[
		hostObject("ZlibStream"),
		"createBrotliCompress",
		"createBrotliDecompress",
		"createDeflate",
		"createDeflateRaw",
		"createGunzip",
		"createGzip",
		"createInflate",
		"createInflateRaw",
		"createUnzip",
	],
	[
		selected("return", { kind: "compression-info", argument: 1 }, OBJECT),
		"brotliCompressSync",
		"brotliDecompressSync",
		"deflateSync",
		"deflateRawSync",
		"gunzipSync",
		"gzipSync",
		"inflateSync",
		"inflateRawSync",
		"unzipSync",
	],
	[returned(NUMBER), "crc32"],
	[
		callback,
		"brotliCompress",
		"brotliDecompress",
		"deflate",
		"deflateRaw",
		"gunzip",
		"gzip",
		"inflate",
		"inflateRaw",
		"unzip",
	],
);
const dnsShared = [
	[returned(OBJECT, "Array"), "getServers"],
	[returned(STRING), "getDefaultResultOrder"],
	[returned(UNDEFINED), "setDefaultResultOrder", "setServers"],
] as const;
const dnsQueries = [
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
];
const dns = exportsWithContracts(
	...dnsShared,
	[nativeConstructor("DnsResolver"), "Resolver"],
	[returned(OBJECT), "lookup"],
	[callback, ...dnsQueries],
);
const dnsPromises = exportsWithContracts(
	...dnsShared,
	[nativeConstructor("DnsPromiseResolver"), "Resolver"],
	[
		{ kind: "resolve", value: { mask: OBJECT } },
		"lookup",
		...dnsQueries.filter((name) => name !== "resolveAny"),
	],
	[fulfilled(0), "resolveAny"],
);
const tty = exportsWithContracts(
	[returned(BOOLEAN), "isatty"],
	[nativeConstructor("TtyReadStream"), "ReadStream"],
	[nativeConstructor("TtyWriteStream"), "WriteStream"],
);
const sqlite = exportsWithContracts(
	[nativeConstructor("DatabaseSync"), "DatabaseSync"],
	[neverReturns("Statements are created by DatabaseSync.prepare."), "StatementSync"],
);

const http = exportsWithContracts(
	[nativeConstructor("HttpAgent"), "Agent"],
	[installedObject("HttpAgent"), "globalAgent"],
	[nativeConstructor("CloseEvent"), "CloseEvent"],
	[nativeConstructor("MessageEvent"), "MessageEvent"],
	[nativeConstructor("WebSocket"), "WebSocket"],
	[nativeConstructor("HttpIncomingMessage"), "IncomingMessage"],
	[nativeConstructor("HttpOutgoingMessage"), "OutgoingMessage"],
	[nativeConstructor("HttpServerResponse"), "ServerResponse"],
	[nativeConstructor("HttpClientRequest"), "ClientRequest"],
	[nativeConstructor("HttpServer"), "Server"],
	[hostObject("HttpServer"), "createServer"],
	[hostObject("HttpClientRequest"), "get", "request"],
	[returned(BOOLEAN), "isValidHeaderName", "isValidHeaderValue"],
	[
		returned(UNDEFINED),
		"validateHeaderName",
		"validateHeaderValue",
		"setMaxIdleHTTPParsers",
	],
);
const https = exportsWithContracts(
	[nativeConstructor("HttpsAgent"), "Agent"],
	[installedObject("HttpsAgent"), "globalAgent"],
	[nativeConstructor("HttpsServer"), "Server"],
	[hostObject("HttpsServer"), "createServer"],
	[hostObject("HttpClientRequest"), "request", "get"],
);
const tls = exportsWithContracts(
	[selected("return", { kind: "tls-socket", argument: 0 }, OBJECT), "connect"],
	[nativeConstructor("TlsServer"), "Server"],
	[hostObject("TlsServer"), "createServer"],
	[returned(OBJECT), "createSecureContext", "SecureContext"],
	[
		returned(OBJECT, "Array"),
		"getCACertificates",
		"getCiphers",
		"getCertificateCompressionAlgorithms",
	],
	[returned(OBJECT | UNDEFINED), "checkServerIdentity"],
	[neverReturns("The installed TLSSocket adapter is unsupported."), "TLSSocket"],
);
const net = exportsWithContracts(
	[nativeConstructor("NetBlockList"), "BlockList"],
	[nativeConstructor("NetServer"), "Server"],
	[hostObject("NetServer"), "createServer"],
	[hostObject("NetSocket"), "connect", "createConnection"],
	[streamConstructor("NetSocket"), "Socket"],
	[returned(BOOLEAN), "isIPv4", "isIPv6", "getDefaultAutoSelectFamily"],
	[returned(NUMBER), "isIP", "getDefaultAutoSelectFamilyAttemptTimeout"],
	[
		returned(UNDEFINED),
		"setDefaultAutoSelectFamily",
		"setDefaultAutoSelectFamilyAttemptTimeout",
	],
);
const childProcess = exportsWithContracts(
	[nativeConstructor("ChildProcess"), "ChildProcess"],
	[hostObject("SpawnedChildProcess"), "exec", "execFile", "spawn"],
	[hostObject("SpawnSyncResult"), "spawnSync"],
	[
		selected("return", { kind: "exec-output", argument: 1 }, STRING | OBJECT | NULL),
		"execSync",
	],
	[
		selected("return", { kind: "exec-file-output", argument: 1 }, STRING | OBJECT | NULL),
		"execFileSync",
	],
	[neverReturns("The native runtime does not support fork IPC."), "fork"],
);
const readline = exportsWithContracts(
	[nativeConstructor("ReadlineInterface"), "Interface"],
	[hostObject("ReadlineInterface"), "createInterface"],
	[returned(UNDEFINED), "emitKeypressEvents"],
	[
		dynamic("The output stream's write method supplies the return value."),
		"clearLine",
		"clearScreenDown",
		"cursorTo",
		"moveCursor",
	],
);
const readlinePromises = new Map([
	...readline,
	...exportsWithContracts(
		[nativeConstructor("ReadlinePromiseInterface"), "Interface"],
		[hostObject("ReadlinePromiseInterface"), "createInterface"],
	),
]);
const crypto = exportsWithContracts(
	[hostObject("Hash"), "createHash"],
	[hostObject("Hmac"), "createHmac"],
	[hostObject("Cipheriv"), "createCipheriv"],
	[hostObject("Decipheriv"), "createDecipheriv"],
	[hostObject("Sign"), "createSign"],
	[hostObject("Verify"), "createVerify"],
	[hostObject("SecretKeyObject"), "createSecretKey"],
	[hostObject("AsymmetricKeyObject"), "createPrivateKey", "createPublicKey"],
	[installedObject("Crypto"), "webcrypto"],
	[installedObject("SubtleCrypto"), "subtle"],
	...(
		[
			"Hash",
			"Hmac",
			"Cipheriv",
			"Decipheriv",
			"Sign",
			"Verify",
			"X509Certificate",
		] as const
	).map((name) => [nativeConstructor(name), name] as const),
	[returned(STRING), "randomUUID", "randomUUIDv7"],
	[returned(BOOLEAN), "timingSafeEqual", "verify"],
	[returned(OBJECT, "Array"), "getCiphers", "getCurves", "getHashes"],
	[returned(OBJECT | UNDEFINED), "getCipherInfo", "randomBytes"],
	[returned(NUMBER | UNDEFINED), "randomInt"],
	[returned(OBJECT, "Uint8Array"), "argon2Sync", "pbkdf2Sync", "scryptSync", "sign"],
	[
		returned(OBJECT),
		"hkdfSync",
		"randomFillSync",
		"getRandomValues",
		"generateKeySync",
		"generateKeyPairSync",
	],
	[selected("return", { kind: "output-encoding", argument: 2 }), "hash"],
	[
		neverReturns("The native entry is a compatibility stub or an abstract constructor."),
		"KeyObject",
		"publicEncrypt",
	],
	[
		callback,
		"argon2",
		"pbkdf2",
		"scrypt",
		"hkdf",
		"randomFill",
		"generateKeyPair",
		"generateKey",
	],
);
const stream = exportsWithContracts(
	[streamConstructor("NodeStream"), "default", "Stream"],
	[streamConstructor("NodeReadable"), "Readable"],
	[streamConstructor("NodeWritable"), "Writable"],
	[streamConstructor("NodeDuplex"), "Duplex"],
	[streamConstructor("NodeTransform"), "Transform"],
	[streamConstructor("NodePassThrough"), "PassThrough"],
	[returned(BOOLEAN | NULL), "isReadable", "isWritable", "isDestroyed"],
	[returned(BOOLEAN), "isErrored", "isDisturbed"],
	[returned(NUMBER), "getDefaultHighWaterMark"],
	[returned(UNDEFINED), "destroy", "setDefaultHighWaterMark"],
	[returned(OBJECT), "addAbortSignal", "compose", "finished", "pipeline"],
	[returned(OBJECT, "Array"), "duplexPair"],
);
const streamPromises = exportsWithContracts(
	[fulfilled(UNDEFINED), "finished"],
	[
		{
			kind: "fulfill",
			value: { mask: TOP },
			reason: "An async destination function can produce any result.",
		},
		"pipeline",
	],
);
const streamConsumers = exportsWithContracts(
	[fulfilled(OBJECT | UNDEFINED), "blob", "buffer", "bytes"],
	[
		{
			kind: "fulfill",
			value: { mask: TOP },
			reason: "The consumer invokes a mutable conversion method or reads a JSON value.",
		},
		"arrayBuffer",
		"json",
		"text",
	],
);
const streamWeb = exportsWithContracts(
	...(
		[
			"ReadableStream",
			"ReadableStreamDefaultReader",
			"ReadableStreamBYOBReader",
			"WritableStream",
			"WritableStreamDefaultWriter",
			"TransformStream",
			"TextEncoderStream",
			"TextDecoderStream",
			"ByteLengthQueuingStrategy",
			"CountQueuingStrategy",
		] as const
	).map((name) => [nativeConstructor(name), name] as const),
	[
		neverReturns("The controller or request is only created by a stream."),
		"ReadableStreamDefaultController",
		"ReadableByteStreamController",
		"ReadableStreamBYOBRequest",
		"WritableStreamDefaultController",
		"TransformStreamDefaultController",
	],
);
const events = exportsWithContracts(
	[
		{ kind: "return", value: { mask: UNDEFINED, hostConstructor: "EventEmitter" } },
		"default",
		"EventEmitter",
	],
	[returned(UNDEFINED), "init", "setMaxListeners"],
	[nativeConstructor("EventEmitterAsyncResource"), "EventEmitterAsyncResource"],
	[hostObject("AbortListener"), "addAbortListener"],
	[hostObject("EventIterator"), "on"],
	[returned(NUMBER), "listenerCount"],
	[{ kind: "resolve", value: { mask: OBJECT, brand: "Array" } }, "once"],
	[
		dynamic("A custom emitter can return an arbitrary result from its method."),
		"getEventListeners",
		"getMaxListeners",
	],
);
const timers = exportsWithContracts(
	[hostObject("Timeout"), "setTimeout", "setInterval"],
	[hostObject("Immediate"), "setImmediate"],
	[returned(UNDEFINED), "clearTimeout", "clearInterval", "clearImmediate"],
);
const timersPromises = exportsWithContracts(
	[hostObject("TimerIntervalIterator"), "setInterval"],
	[installedObject("TimerScheduler"), "scheduler"],
	[selected("resolve", { kind: "resolve-value", argument: 1 }, TOP), "setTimeout"],
	[selected("resolve", { kind: "resolve-value", argument: 0 }, TOP), "setImmediate"],
);

export const HOST_RESULT_CONTRACTS: ReadonlyMap<
	string,
	ReadonlyMap<string, HostResultContract>
> = new Map([
	["mal_host_install_node_http", http],
	["mal_host_install_node_http_without_websocket", http],
	["mal_host_install_node_https", https],
	["mal_host_install_node_tls", tls],
	["mal_host_install_node_net", net],
	["mal_host_install_node_child_process", childProcess],
	[
		"mal_host_install_node_dgram",
		exportsWithContracts(
			[nativeConstructor("DgramSocket"), "Socket"],
			[hostObject("DgramSocket"), "createSocket"],
		),
	],
	["mal_host_install_node_readline", readline],
	["mal_host_install_node_readline_promises", readlinePromises],
	["mal_host_install_node_crypto", crypto],
	["mal_host_install_node_stream", stream],
	["mal_host_install_node_stream_promises", streamPromises],
	["mal_host_install_node_stream_consumers", streamConsumers],
	["mal_host_install_node_stream_web", streamWeb],
	["mal_host_install_node_events", events],
	["mal_host_install_node_timers", timers],
	["mal_host_install_node_timers_promises", timersPromises],
	[
		"mal_host_install_node_punycode",
		exportsWithContracts([returned(STRING), "decode", "encode", "toASCII", "toUnicode"]),
	],
	["mal_host_install_node_sys", util],
	["mal_host_install_node_vm", vm],
	["mal_host_install_node_diagnostics_channel", diagnostics],
	[
		"mal_host_install_node_domain",
		exportsWithContracts([neverReturns("Domains are unsupported."), "create"]),
	],
	["mal_host_install_node_cluster", cluster],
	["mal_host_install_node_inspector", inspector],
	["mal_host_install_node_async_hooks", asyncHooks],
	["mal_host_install_node_console", console],
	["mal_host_install_node_module", module],
	["mal_host_install_node_worker_threads", nodeWorkers],
	["mal_host_install_node_assert", assertions],
	["mal_host_install_node_assert_strict", assertions],
	["mal_host_install_node_zlib", zlib],
	["mal_host_install_node_zlib_decoders", zlib],
	["mal_host_install_node_dns", dns],
	["mal_host_install_node_dns_promises", dnsPromises],
	["mal_host_install_node_tty", tty],
	["mal_host_install_node_sqlite", sqlite],
	[
		"mal_host_install_node_http2",
		exportsWithContracts([neverReturns("HTTP/2 is unsupported."), "connect"]),
	],
	["mal_host_install_node_fs", fs],
	["mal_host_install_node_fs_named", fs],
	["mal_host_install_node_fs_read_file", fs],
	["mal_host_install_node_fs_promises", fsPromises],
	["mal_host_install_maligator_internal_fs", maligatorFs],
	["mal_host_install_maligator_internal_fs_descriptor", fsDescriptor],
	[
		"mal_host_install_maligator_internal_fs_stream",
		exportsWithContracts([returned(OBJECT), "readableStream"]),
	],
	[
		"mal_host_install_maligator_internal_fs_watch",
		exportsWithContracts([returned(UNDEFINED), "openWatch", "closeWatch"]),
	],
	[
		"mal_host_install_maligator_application",
		exportsWithContracts([returned(BOOLEAN), "ready"]),
	],
	[
		"mal_host_install_maligator_internal_http",
		exportsWithContracts(
			[hostObject("NativeHttpServer"), "listen"],
			[hostObject("Response", undefined, OBJECT | UNDEFINED), "assetResponse"],
			[returned(STRING | UNDEFINED), "assetProxy"],
		),
	],
	[
		"mal_host_install_maligator_internal_fetch",
		exportsWithContracts([
			{ kind: "fulfill", value: { mask: OBJECT, hostObject: "Response" } },
			"fetch",
		]),
	],
	["mal_host_install_maligator_internal_workers", maligatorWorkers],
	["mal_host_install_node_path", path],
	["mal_host_install_node_path_posix", path],
	["mal_host_install_node_path_win32", path],
	["mal_host_install_node_os", os],
	["mal_host_install_process", process],
	["mal_host_install_node_url", url],
	["mal_host_install_node_util", util],
	["mal_host_install_node_util_types", utilTypes],
	["mal_host_install_node_v8", v8],
	["mal_host_install_node_perf_hooks", perfHooks],
	["mal_host_install_node_querystring", querystring],
	["mal_host_install_node_buffer", buffer],
	[
		"mal_host_install_node_string_decoder",
		exportsWithContracts([nativeConstructor("StringDecoder"), "StringDecoder"]),
	],
]);

const resolved = (mask: CompilerValueKindMask): HostResultContract => ({
	kind: "resolve",
	value: { mask },
});

export const EMBEDDED_ASSET_RESULTS = {
	file: {
		properties: exportsWithContracts(
			[returned(STRING), "path", "type", "digest"],
			[returned(NUMBER), "size"],
		),
		methods: exportsWithContracts(
			[returned(OBJECT, "Uint8Array"), "bytes"],
			[returned(STRING), "text", "materialize"],
			[returned(STRING | NUMBER | BOOLEAN | NULL | OBJECT), "json"],
		),
	},
	directory: {
		properties: exportsWithContracts(),
		methods: exportsWithContracts(
			[returned(OBJECT, "Array"), "files"],
			[
				{ kind: "return", value: { mask: OBJECT | UNDEFINED, assetHandle: "file" } },
				"get",
			],
			[returned(STRING), "materialize"],
		),
	},
} as const;

export const DISK_HANDLE_EXPORTS = exportsWithContracts(
	[{ kind: "return", value: { mask: OBJECT, platformObject: "file" } }, "file"],
	[{ kind: "return", value: { mask: OBJECT, platformObject: "directory" } }, "directory"],
	[fulfilled(STRING), "realpath", "readlink"],
	[fulfilled(UNDEFINED), "symlink"],
	[
		{ kind: "fulfill", value: { mask: OBJECT, platformObject: "directory" } },
		"temporaryDirectory",
	],
	[{ kind: "return", value: { mask: OBJECT, platformObject: "watcher" } }, "watch"],
	[returned(OBJECT), "FileSystemError"],
);

export const PLATFORM_SOURCE_EXPORTS = new Map([
	[
		"node:test",
		exportsWithContracts(
			[resolved(UNDEFINED), "registerTest", "registerSuite"],
			[returned(UNDEFINED), "before", "after", "beforeEach", "afterEach"],
		),
	],
	[
		"maligator:test",
		exportsWithContracts(
			[returned(OBJECT), "expect"],
			[resolved(OBJECT), "__run"],
			[
				returned(UNDEFINED),
				"test",
				"describe",
				"beforeAll",
				"afterAll",
				"beforeEach",
				"afterEach",
				"__beginFile",
				"__endFile",
				"__reset",
				"__initializeRunner",
			],
		),
	],
	["maligator:fs", DISK_HANDLE_EXPORTS],
	[
		"maligator:http",
		exportsWithContracts(
			[{ kind: "return", value: { mask: OBJECT, platformObject: "server" } }, "serve"],
			[returned(OBJECT), "serveAsset", "proxy"],
		),
	],
	[
		"maligator:workers",
		exportsWithContracts(
			[
				{ kind: "return", value: { mask: OBJECT, platformObject: "workerPool" } },
				"createPool",
			],
			[
				{ kind: "return", value: { mask: OBJECT, platformObject: "transferEnvelope" } },
				"transfer",
			],
		),
	],
	[
		"maligator:assets",
		exportsWithContracts([
			neverReturns(
				"The compiler replaces calls with declaration-specific handles before lowering.",
			),
			"embedFile",
			"embedDirectory",
		]),
	],
]);

export const PLATFORM_OBJECT_RESULTS = {
	server: {
		properties: exportsWithContracts(
			[returned(NUMBER), "port"],
			[returned(STRING), "url", "hostname"],
		),
		methods: exportsWithContracts([
			fulfilled(UNDEFINED),
			"close",
			"[Symbol.asyncDispose]",
		]),
	},
	workerPool: {
		properties: exportsWithContracts([resolved(UNDEFINED), "ready"]),
		methods: exportsWithContracts(
			[
				{
					kind: "resolve",
					value: { mask: TOP },
					reason: "The worker task serializes and transports its own result.",
				},
				"run",
			],
			[returned(OBJECT), "map"],
			[
				{ kind: "return", value: { mask: OBJECT, platformObject: "workerPoolStats" } },
				"stats",
			],
			[
				{ kind: "return", value: { mask: OBJECT, platformObject: "workerPool" } },
				"ref",
				"unref",
			],
			[returned(BOOLEAN), "hasRef"],
			[fulfilled(UNDEFINED), "close", "terminate"],
		),
	},
	workerPoolStats: {
		properties: exportsWithContracts([
			returned(NUMBER),
			"size",
			"active",
			"queued",
			"completed",
			"failed",
			"cancelled",
		]),
		methods: exportsWithContracts(),
	},
	transferEnvelope: {
		properties: exportsWithContracts(
			[returned(OBJECT, "Array"), "transferList"],
			[dynamic("The transfer envelope carries the caller's original value."), "value"],
		),
		methods: exportsWithContracts(),
	},
	file: {
		properties: exportsWithContracts([returned(STRING), "path", "type"]),
		methods: exportsWithContracts(
			[fulfilled(STRING), "text"],
			[fulfilled(OBJECT, "Uint8Array"), "bytes"],
			[fulfilled(BOOLEAN), "exists"],
			[fulfilled(NUMBER), "write", "append"],
			[fulfilled(OBJECT), "stat"],
			[fulfilled(UNDEFINED), "chmod", "delete", "copyTo", "moveTo"],
			[returned(OBJECT), "stream"],
			[{ kind: "return", value: { mask: OBJECT, platformObject: "writer" } }, "writer"],
			[
				{
					kind: "fulfill",
					value: { mask: STRING | NUMBER | BOOLEAN | NULL | OBJECT },
					reason: "Parses the bytes returned by the file read as JSON.",
				},
				"json",
			],
		),
	},
	directory: {
		properties: exportsWithContracts([returned(STRING), "path"]),
		methods: exportsWithContracts(
			[fulfilled(BOOLEAN), "exists"],
			[fulfilled(OBJECT), "stat"],
			[fulfilled(OBJECT, "Array"), "entries", "files"],
			[fulfilled(UNDEFINED), "chmod", "create", "delete", "moveTo"],
			[{ kind: "return", value: { mask: OBJECT, platformObject: "file" } }, "file"],
			[
				{ kind: "return", value: { mask: OBJECT, platformObject: "directory" } },
				"directory",
			],
			[
				{ kind: "fulfill", value: { mask: OBJECT | UNDEFINED, platformObject: "file" } },
				"get",
			],
		),
	},
	writer: {
		properties: exportsWithContracts(),
		methods: exportsWithContracts(
			[fulfilled(NUMBER), "write"],
			[fulfilled(UNDEFINED), "flush", "close", "end", "[Symbol.asyncDispose]"],
		),
	},
	watcher: {
		properties: exportsWithContracts(),
		methods: exportsWithContracts(
			[fulfilled(OBJECT), "next", "return"],
			[
				{ kind: "return", value: { mask: OBJECT, platformObject: "watcher" } },
				"[Symbol.asyncIterator]",
			],
		),
	},
} as const;

export type HostObjectKind =
	| "ReadableStreamDefaultController"
	| "ReadableByteStreamController"
	| "ReadableStreamBYOBRequest"
	| "WritableStreamDefaultController"
	| "TransformStreamDefaultController"
	| "Assert"
	| "NodeConsole"
	| "VmScript"
	| "DiagnosticsChannel"
	| "TracingChannel"
	| "DnsResolver"
	| "DnsPromiseResolver"
	| "TtyReadStream"
	| "TtyWriteStream"
	| "Performance"
	| "PerformanceEntry"
	| "PerformanceObserver"
	| "PerformanceNodeTiming"
	| "Histogram"
	| "NetBlockList"
	| "NetServer"
	| "NetSocket"
	| "DgramSocket"
	| "SocketAddress"
	| "TlsServer"
	| "TlsSocket"
	| "HttpAgent"
	| "HttpIncomingMessage"
	| "HttpOutgoingMessage"
	| "HttpServerResponse"
	| "HttpClientRequest"
	| "HttpServer"
	| "HttpsServer"
	| "HttpsAgent"
	| "ChildProcess"
	| "SpawnedChildProcess"
	| "SpawnSyncResult"
	| "ExecTextOutput"
	| "ExecBufferOutput"
	| "ExecOutput"
	| "NodeModule"
	| "NodeRequire"
	| "ModuleHookRegistration"
	| "SourceMapSupport"
	| "CompileCacheResult"
	| "ReadlineInterface"
	| "ReadlinePromiseInterface"
	| "ReadlineCursor"
	| "ReadlineIterator"
	| "BroadcastChannel"
	| "MaligatorMessageChannel"
	| "MaligatorMessagePort"
	| "MaligatorWorker"
	| "MessageChannel"
	| "MessagePort"
	| "NodeWorker"
	| "WorkerCapabilities"
	| "WorkerExit"
	| "WorkerMessage"
	| "WorkerUrl"
	| "NodeStream"
	| "NodeReadable"
	| "NodeWritable"
	| "NodeDuplex"
	| "NodeTransform"
	| "NodePassThrough"
	| "NodeStreamIterator"
	| "WebStreamPair"
	| "ZlibStream"
	| "CompressionInfo"
	| "AbortListener"
	| "AsyncHook"
	| "AsyncLocalStorage"
	| "AsyncLocalScope"
	| "AsyncResource"
	| "EventEmitter"
	| "EventEmitterAsyncResource"
	| "EventIterator"
	| "LegacyUrl"
	| "NativeHttpServer"
	| "TimerScheduler"
	| "TimerIntervalIterator"
	| "AbortController"
	| "AbortSignal"
	| "Blob"
	| "Buffer"
	| "Cipheriv"
	| "Decipheriv"
	| "Hash"
	| "Hmac"
	| "Sign"
	| "Verify"
	| "X509Certificate"
	| "SecretKeyObject"
	| "AsymmetricKeyObject"
	| "AnyKeyObject"
	| "Crypto"
	| "SubtleCrypto"
	| "ByteLengthQueuingStrategy"
	| "CompressionStream"
	| "CountQueuingStrategy"
	| "DatabaseSync"
	| "DecompressionStream"
	| "DOMException"
	| "Dir"
	| "Dirent"
	| "DirIterator"
	| "FileHandle"
	| "Stats"
	| "Event"
	| "CustomEvent"
	| "CloseEvent"
	| "ErrorEvent"
	| "MessageEvent"
	| "MIMEType"
	| "MIMEParams"
	| "EventTarget"
	| "WebSocket"
	| "File"
	| "FormData"
	| "Headers"
	| "Request"
	| "Response"
	| "ReadableStream"
	| "ReadableStreamDefaultReader"
	| "ReadableStreamBYOBReader"
	| "ReadableStreamReader"
	| "ReadableStreamIterator"
	| "StreamReadResult"
	| "StatementSync"
	| "StringDecoder"
	| "TextDecoder"
	| "TextDecoderStream"
	| "TextEncoder"
	| "TextEncoderStream"
	| "TransformStream"
	| "URL"
	| "URLSearchParams"
	| "URLSearchParamsIterator"
	| "WritableStream"
	| "WritableStreamDefaultWriter"
	| "Timeout"
	| "Immediate"
	| "FormDataIterator"
	| "HeadersIterator";

const body = exportsWithContracts(
	[resolved(STRING), "text"],
	[resolved(OBJECT), "arrayBuffer"],
	[{ kind: "resolve", value: { mask: OBJECT, brand: "Uint8Array" } }, "bytes"],
	[{ kind: "resolve", value: { mask: OBJECT, hostObject: "Blob" } }, "blob"],
	[{ kind: "resolve", value: { mask: OBJECT, hostObject: "FormData" } }, "formData"],
	[
		{
			kind: "resolve",
			value: { mask: NUMBER | STRING | BOOLEAN | OBJECT | NULL },
			reason: "The body can contain any valid JSON value.",
		},
		"json",
	],
);

function hostObject(
	instance: HostObjectKind,
	brand?: HostValueContract["brand"],
	mask = OBJECT,
): HostResultContract {
	return { kind: "return", value: { mask, hostObject: instance, brand } };
}

const blob = exportsWithContracts(
	[resolved(STRING), "text"],
	[resolved(OBJECT), "arrayBuffer"],
	[{ kind: "resolve", value: { mask: OBJECT, brand: "Uint8Array" } }, "bytes"],
	[hostObject("ReadableStream"), "stream"],
);
const blobProperties = exportsWithContracts(
	[returned(NUMBER), "size"],
	[returned(STRING), "type"],
);
const bodyProperties = exportsWithContracts(
	[returned(OBJECT | NULL), "body"],
	[returned(BOOLEAN), "bodyUsed"],
);

const readableReaderMethods = exportsWithContracts(
	[fulfilled(UNDEFINED), "cancel"],
	[returned(UNDEFINED), "releaseLock"],
	[{ kind: "fulfill", value: { mask: OBJECT, hostObject: "StreamReadResult" } }, "read"],
);
const readableReaderProperties = exportsWithContracts([fulfilled(UNDEFINED), "closed"]);
const readableControllerMethods = exportsWithContracts([
	returned(UNDEFINED),
	"enqueue",
	"close",
	"error",
]);
const transformStreamProperties = exportsWithContracts(
	[hostObject("ReadableStream"), "readable"],
	[hostObject("WritableStream"), "writable"],
);
const abortSink: HostResultContract = {
	kind: "resolve",
	value: { mask: TOP },
	reason: "The runtime adopts the underlying sink's abort callback result.",
};

const eventMethods = exportsWithContracts([
	returned(UNDEFINED),
	"preventDefault",
	"stopPropagation",
	"stopImmediatePropagation",
	"initEvent",
]);
const eventTargetMethods = exportsWithContracts(
	[returned(UNDEFINED), "addEventListener", "removeEventListener"],
	[returned(BOOLEAN), "dispatchEvent"],
);
const eventProperties = exportsWithContracts(
	[returned(STRING), "type"],
	[returned(NUMBER), "eventPhase", "timeStamp"],
	[
		returned(BOOLEAN),
		"bubbles",
		"cancelable",
		"defaultPrevented",
		"returnValue",
		"cancelBubble",
		"composed",
		"isTrusted",
	],
	[returned(OBJECT | NULL), "target", "srcElement", "currentTarget"],
);
const fileTypePredicates = exportsWithContracts([
	returned(BOOLEAN),
	"isFile",
	"isDirectory",
	"isBlockDevice",
	"isCharacterDevice",
	"isFIFO",
	"isSocket",
	"isSymbolicLink",
]);

export const BUFFER_STRING_ENCODINGS = new Set([
	"utf8",
	"utf-8",
	"latin1",
	"binary",
	"ascii",
	"hex",
	"base64",
	"base64url",
	"ucs2",
	"ucs-2",
	"utf16le",
	"utf-16le",
]);

function digestMethods(kind: "Hash" | "Hmac") {
	return new Map([
		...cryptoStreamDelegates(kind),
		...exportsWithContracts(
			[hostObject(kind), "update"],
			[selected("return", { kind: "digest-encoding", argument: 0 }), "digest"],
			[callback, "_transform", "_flush"],
		),
	]);
}

function listenerMethods(kind: HostObjectKind) {
	return exportsWithContracts(
		[returned(BOOLEAN), "emit"],
		[returned(NUMBER), "listenerCount"],
		[
			hostObject(kind),
			"on",
			"addListener",
			"once",
			"prependListener",
			"prependOnceListener",
			"off",
			"removeListener",
			"removeAllListeners",
		],
	);
}

function emitterMethods(kind: HostObjectKind) {
	return new Map([
		...listenerMethods(kind),
		...exportsWithContracts(
			[returned(NUMBER), "getMaxListeners"],
			[returned(OBJECT, "Array"), "eventNames", "listeners", "rawListeners"],
			[hostObject(kind), "setMaxListeners"],
		),
	]);
}

function nodeStreamMethods(kind: HostObjectKind, readable: boolean, writable: boolean) {
	return new Map([
		...emitterMethods(kind),
		...exportsWithContracts([hostObject(kind), "destroy"]),
		...(readable
			? exportsWithContracts(
					[hostObject(kind), "pause", "resume", "setEncoding", "unpipe", "wrap"],
					[returned(BOOLEAN), "isPaused", "push"],
					[returned(OBJECT), "pipe"],
					[
						{
							kind: "return",
							value: { mask: TOP, selector: { kind: "read-size", argument: 0 } },
						},
						"read",
					],
					[hostObject("NodeStreamIterator"), "[Symbol.asyncIterator]"],
				)
			: []),
		...(writable
			? exportsWithContracts([returned(BOOLEAN), "write"], [hostObject(kind), "end"])
			: []),
	]);
}

const readableStateFields = exportsWithContracts(
	[returned(BOOLEAN), "readableDidRead", "readableAborted"],
	[
		dynamic("Returns a public _readableState field without converting it."),
		"readableLength",
		"readableHighWaterMark",
		"readableEncoding",
		"readableObjectMode",
	],
);
const writableStateFields = exportsWithContracts([
	dynamic("Returns a public _writableState field without converting it."),
	"writableLength",
	"writableHighWaterMark",
	"writableObjectMode",
]);
const duplexStateFields = new Map([...readableStateFields, ...writableStateFields]);

const mutableDispatch = dynamic("Forwards the result of a mutable method lookup.");

export const CRYPTO_STREAM_DELEGATES = [
	"write",
	"end",
	"pipe",
	"unpipe",
	"on",
	"addListener",
	"once",
	"prependListener",
	"prependOnceListener",
	"removeListener",
	"off",
	"removeAllListeners",
	"setEncoding",
	"read",
	"resume",
	"pause",
	"isPaused",
	"unshift",
	"cork",
	"uncork",
	"destroy",
	"setDefaultEncoding",
	"push",
] as const;

function cryptoStreamDelegates(kind: HostObjectKind) {
	const stream = nodeStreamMethods(kind, true, true);
	return CRYPTO_STREAM_DELEGATES.map(
		(name) => [name, stream.get(name) ?? mutableDispatch] as const,
	);
}

function netServerMethods(kind: "NetServer" | "TlsServer") {
	return new Map([
		...emitterMethods(kind),
		...exportsWithContracts(
			[hostObject(kind), "listen", "close", "ref", "unref", "getConnections"],
			[returned(OBJECT | STRING | NULL), "address"],
			[fulfilled(UNDEFINED), "[Symbol.asyncDispose]"],
		),
	]);
}

function netSocketMethods(kind: "NetSocket" | "TlsSocket") {
	return new Map([
		...nodeStreamMethods(kind, true, true),
		...exportsWithContracts(
			[
				hostObject(kind),
				"connect",
				"end",
				"resetAndDestroy",
				"setTimeout",
				"setNoDelay",
				"setKeepAlive",
			],
			[returned(BOOLEAN), "write"],
			[mutableDispatch, "destroy", "pause", "resume"],
		),
	]);
}

function outgoingMethods(
	kind: "HttpOutgoingMessage" | "HttpServerResponse" | "HttpClientRequest",
) {
	return new Map([
		...emitterMethods(kind),
		...exportsWithContracts(
			[hostObject(kind), "setHeader", "destroy"],
			[returned(BOOLEAN), "hasHeader"],
			[returned(UNDEFINED), "removeHeader"],
			[returned(OBJECT), "getHeaders"],
			[returned(OBJECT, "Array"), "getHeaderNames"],
			[dynamic("A header contains the value originally set by the caller."), "getHeader"],
		),
	]);
}

function httpServerMethods(kind: "HttpServer" | "HttpsServer") {
	return new Map([
		...emitterMethods(kind),
		...exportsWithContracts(
			[hostObject(kind, undefined, OBJECT | UNDEFINED), "listen", "close", "setTimeout"],
			[hostObject("SocketAddress", undefined, OBJECT | NULL), "address"],
			[returned(UNDEFINED), "closeAllConnections", "closeIdleConnections"],
		),
	]);
}

const socketProperties = exportsWithContracts(
	[returned(BOOLEAN), "connecting", "pending"],
	[returned(STRING), "readyState"],
	[returned(NUMBER | UNDEFINED), "remotePort", "localPort"],
	[
		returned(STRING | UNDEFINED),
		"remoteAddress",
		"localAddress",
		"remoteFamily",
		"localFamily",
	],
);
const outgoingProperties = exportsWithContracts(
	[returned(BOOLEAN), "headersSent"],
	[dynamic("Stores an arbitrary error supplied by the caller."), "errored"],
);
const httpServerProperties = exportsWithContracts(
	[
		returned(NUMBER),
		"headersTimeout",
		"requestTimeout",
		"keepAliveTimeout",
		"maxConnections",
		"timeout",
	],
	[returned(NUMBER | UNDEFINED), "maxHeaderSize"],
	[returned(NUMBER | NULL), "maxHeadersCount"],
);
const childProcessProperties = exportsWithContracts(
	[returned(BOOLEAN), "killed", "connected"],
	[returned(NUMBER | UNDEFINED), "pid"],
	[returned(NUMBER | NULL), "exitCode"],
	[returned(STRING | NULL), "signalCode"],
);

function childProcessMethods(kind: "ChildProcess" | "SpawnedChildProcess") {
	return new Map([
		...emitterMethods(kind),
		...exportsWithContracts(
			[returned(BOOLEAN), "kill"],
			[returned(UNDEFINED), "ref", "unref"],
		),
	]);
}

function readlineMethods(kind: "ReadlineInterface" | "ReadlinePromiseInterface") {
	return new Map([
		...emitterMethods(kind),
		...exportsWithContracts(
			[hostObject(kind), "pause", "resume"],
			[returned(UNDEFINED), "prompt", "setPrompt", "close", "write"],
			[
				dynamic("setPrompt and constructor options store the prompt value unchanged."),
				"getPrompt",
			],
			[hostObject("ReadlineCursor"), "getCursorPos"],
			[hostObject("ReadlineIterator"), "[Symbol.asyncIterator]"],
			[kind === "ReadlinePromiseInterface" ? resolved(STRING) : callback, "question"],
		),
	]);
}

const iteratorResult = {
	kind: "resolve",
	value: { mask: OBJECT, hostObject: "StreamReadResult" },
} as const;
const forwardsCallbackResult = dynamic(
	"Returns any value produced by the caller's callback.",
);
const vmCompletion = dynamic("Returns the evaluated script's completion value.");
const performanceMethods = exportsWithContracts(
	[returned(NUMBER), "now"],
	[hostObject("PerformanceEntry"), "mark", "measure"],
	[returned(OBJECT), "eventLoopUtilization", "timerify", "toJSON"],
	[returned(OBJECT, "Array"), "getEntries", "getEntriesByName", "getEntriesByType"],
	[returned(UNDEFINED), "clearMarks", "clearMeasures"],
);

const assertionInstanceMethods = exportsWithContracts(
	[fulfilled(UNDEFINED), "rejects", "doesNotReject"],
	[neverReturns("Always throws the assertion failure."), "fail"],
	[
		returned(UNDEFINED),
		"ok",
		"equal",
		"notEqual",
		"deepEqual",
		"notDeepEqual",
		"deepStrictEqual",
		"notDeepStrictEqual",
		"strictEqual",
		"notStrictEqual",
		"partialDeepStrictEqual",
		"throws",
		"doesNotThrow",
		"match",
		"doesNotMatch",
		"ifError",
	],
);

function dnsResolverMethods(promises: boolean) {
	return exportsWithContracts(
		[returned(OBJECT, "Array"), "getServers"],
		[returned(UNDEFINED), "setServers", "cancel"],
		[
			promises ? resolved(OBJECT) : callback,
			...dnsQueries.filter((name) => name !== "lookupService" && name !== "resolveAny"),
		],
		[promises ? fulfilled(0) : callback, "resolveAny"],
	);
}

function cipherMethods(kind: "Cipheriv" | "Decipheriv") {
	return new Map([
		...cryptoStreamDelegates(kind),
		...exportsWithContracts(
			[hostObject(kind), "setAutoPadding", "setAAD"],
			[selected("return", { kind: "digest-encoding", argument: 0 }), "final"],
			[selected("return", { kind: "digest-encoding", argument: 2 }), "update"],
			kind === "Cipheriv"
				? [hostObject("Buffer", "Uint8Array"), "getAuthTag"]
				: [hostObject(kind), "setAuthTag"],
			[callback, "_transform", "_flush"],
		),
	]);
}

export const GLOBAL_HOST_OBJECT_BRANDS: ReadonlyMap<string, HostObjectKind> = new Map([
	["crypto", "Crypto"],
	["performance", "Performance"],
]);

function directoryCompletion(value: HostValueContract): HostResultContract {
	return {
		kind: "fulfill",
		value,
		immediateMask: OBJECT | UNDEFINED,
		optionalCallback: 0,
	};
}

export const GLOBAL_HOST_FUNCTION_RESULTS = exportsWithContracts(
	[returned(STRING), "atob", "btoa"],
	[
		returned(UNDEFINED),
		"queueMicrotask",
		"clearTimeout",
		"clearInterval",
		"clearImmediate",
		"__mal_collect_garbage",
		"__mal_fail_next_cell_allocation",
		"__mal_reset_perf_stats",
	],
	[
		returned(NUMBER),
		"__mal_gc_live_bytes",
		"__mal_gc_allocated_bytes",
		"__mal_gc_collections",
	],
	[hostObject("Timeout"), "setTimeout", "setInterval"],
	[hostObject("Immediate"), "setImmediate"],
	[returned(TOP & ~SYMBOL), "structuredClone"],
);

export const GLOBAL_HOST_NAMESPACE_RESULTS = new Map([
	["console", console],
	["process", process],
	[
		"performance",
		exportsWithContracts(
			[returned(NUMBER), "now"],
			[returned(OBJECT), "mark", "measure", "eventLoopUtilization", "timerify", "toJSON"],
			[returned(OBJECT, "Array"), "getEntries", "getEntriesByName", "getEntriesByType"],
			[returned(UNDEFINED), "clearMarks", "clearMeasures"],
		),
	],
	[
		"mal",
		exportsWithContracts([returned(UNDEFINED), "_profilePhaseBegin", "_profilePhaseEnd"]),
	],
]);

export const GLOBAL_HOST_CONSTRUCTORS = [
	"BroadcastChannel",
	"PerformanceObserver",
	"MessageChannel",
	"Response",
	"Request",
	"Blob",
	"File",
	"FormData",
	"Headers",
	"AbortController",
	"AbortSignal",
	"Buffer",
	"DOMException",
	"Event",
	"CustomEvent",
	"CloseEvent",
	"ErrorEvent",
	"MessageEvent",
	"EventTarget",
	"WebSocket",
	"TextDecoder",
	"TextEncoder",
	"URL",
	"URLSearchParams",
	"ByteLengthQueuingStrategy",
	"CompressionStream",
	"CountQueuingStrategy",
	"DecompressionStream",
	"ReadableStream",
	"ReadableStreamDefaultReader",
	"ReadableStreamBYOBReader",
	"TextDecoderStream",
	"TextEncoderStream",
	"TransformStream",
	"WritableStream",
	"WritableStreamDefaultWriter",
] as const;

// Object-valued resolutions require stable prototypes through settlement.
export const HOST_OBJECT_RESULTS: {
	readonly fetch: HostResultContract;
	readonly statics: Partial<
		Record<HostObjectKind, ReadonlyMap<string, HostResultContract>>
	>;
	readonly staticProperties: Partial<
		Record<HostObjectKind, ReadonlyMap<string, HostResultContract>>
	>;
	readonly methods: Record<HostObjectKind, ReadonlyMap<string, HostResultContract>>;
	readonly properties: Partial<
		Record<HostObjectKind, ReadonlyMap<string, HostResultContract>>
	>;
} = {
	fetch: { kind: "fulfill", value: { mask: OBJECT, hostObject: "Response" } },
	staticProperties: {
		EventEmitter: exportsWithContracts([returned(NUMBER), "defaultMaxListeners"]),
	},
	statics: {
		NetBlockList: exportsWithContracts([returned(BOOLEAN), "isBlockList"]),
		NodeReadable: exportsWithContracts(
			[hostObject("NodeReadable"), "from", "fromWeb", "wrap"],
			[hostObject("ReadableStream"), "toWeb"],
		),
		NodeWritable: exportsWithContracts(
			[hostObject("NodeWritable"), "fromWeb"],
			[hostObject("WritableStream"), "toWeb"],
		),
		NodeDuplex: exportsWithContracts(
			[hostObject("NodeDuplex"), "fromWeb"],
			[hostObject("WebStreamPair"), "toWeb"],
			[returned(OBJECT), "from"],
		),
		AsyncLocalStorage: exportsWithContracts([returned(OBJECT), "bind", "snapshot"]),
		AsyncResource: exportsWithContracts([returned(OBJECT), "bind"]),
		MIMEType: exportsWithContracts([
			hostObject("MIMEType", undefined, OBJECT | NULL),
			"parse",
		]),
		ReadableStream: exportsWithContracts([hostObject("ReadableStream"), "from"]),
		AbortSignal: exportsWithContracts([
			hostObject("AbortSignal"),
			"abort",
			"any",
			"timeout",
		]),
		Buffer: exportsWithContracts(
			[
				hostObject("Buffer", "Uint8Array"),
				"from",
				"alloc",
				"allocUnsafe",
				"allocUnsafeSlow",
				"copyBytesFrom",
				"concat",
				"of",
			],
			[returned(BOOLEAN), "isBuffer", "isEncoding"],
			[returned(NUMBER), "byteLength", "compare"],
		),
		URL: exportsWithContracts(
			[returned(BOOLEAN), "canParse"],
			[hostObject("URL", undefined, OBJECT | NULL), "parse"],
		),
		Response: exportsWithContracts([hostObject("Response"), "error", "json", "redirect"]),
	},
	methods: {
		ReadableStreamDefaultController: readableControllerMethods,
		ReadableByteStreamController: readableControllerMethods,
		ReadableStreamBYOBRequest: exportsWithContracts([
			returned(UNDEFINED),
			"respond",
			"respondWithNewView",
		]),
		WritableStreamDefaultController: exportsWithContracts([returned(UNDEFINED), "error"]),
		TransformStreamDefaultController: exportsWithContracts([
			returned(UNDEFINED),
			"enqueue",
			"error",
			"terminate",
		]),
		Assert: assertionInstanceMethods,
		NodeConsole: exportsWithContracts([
			returned(UNDEFINED),
			"log",
			"info",
			"debug",
			"warn",
			"error",
			"dir",
			"dirxml",
			"table",
			"trace",
			"group",
			"groupCollapsed",
			"groupEnd",
			"count",
			"countReset",
			"time",
			"timeEnd",
			"timeLog",
			"assert",
			"clear",
			"profile",
			"profileEnd",
			"timeStamp",
		]),
		VmScript: exportsWithContracts(
			[vmCompletion, "runInContext", "runInNewContext", "runInThisContext"],
			[hostObject("Buffer", "Uint8Array"), "createCachedData"],
		),
		DiagnosticsChannel: exportsWithContracts(
			[returned(UNDEFINED), "subscribe", "publish", "bindStore"],
			[returned(BOOLEAN), "unsubscribe", "unbindStore"],
			[forwardsCallbackResult, "runStores"],
		),
		TracingChannel: exportsWithContracts(
			[returned(UNDEFINED), "subscribe"],
			[returned(BOOLEAN), "unsubscribe"],
			[forwardsCallbackResult, "traceSync", "tracePromise"],
		),
		DnsResolver: dnsResolverMethods(false),
		DnsPromiseResolver: dnsResolverMethods(true),
		TtyReadStream: new Map([
			...netSocketMethods("NetSocket"),
			["setRawMode", hostObject("TtyReadStream")],
		]),
		TtyWriteStream: new Map([
			...netSocketMethods("NetSocket"),
			...exportsWithContracts(
				[returned(NUMBER), "getColorDepth"],
				[returned(BOOLEAN), "hasColors"],
				[returned(OBJECT, "Array"), "getWindowSize"],
			),
		]),
		Performance: performanceMethods,
		PerformanceEntry: exportsWithContracts([returned(OBJECT), "toJSON"]),
		PerformanceObserver: exportsWithContracts(
			[returned(UNDEFINED), "observe", "disconnect"],
			[returned(OBJECT, "Array"), "takeRecords"],
		),
		PerformanceNodeTiming: exportsWithContracts([returned(OBJECT), "toJSON"]),
		Histogram: exportsWithContracts(
			[returned(UNDEFINED), "reset", "record", "recordDelta"],
			[returned(NUMBER), "percentile"],
			[returned(BOOLEAN), "enable", "disable"],
		),
		NetBlockList: exportsWithContracts(
			[returned(UNDEFINED), "addAddress", "addRange", "addSubnet"],
			[returned(BOOLEAN), "check"],
		),
		NetServer: netServerMethods("NetServer"),
		NetSocket: netSocketMethods("NetSocket"),
		DgramSocket: new Map([
			...emitterMethods("DgramSocket"),
			...exportsWithContracts(
				[hostObject("DgramSocket"), "bind", "close", "ref", "unref"],
				[
					returned(UNDEFINED),
					"connect",
					"send",
					"disconnect",
					"setBroadcast",
					"setMulticastLoopback",
					"setMulticastInterface",
					"addMembership",
					"dropMembership",
				],
				[
					returned(NUMBER),
					"setTTL",
					"setMulticastTTL",
					"setRecvBufferSize",
					"setSendBufferSize",
					"getRecvBufferSize",
					"getSendBufferSize",
					"getSendQueueSize",
					"getSendQueueCount",
				],
				[hostObject("SocketAddress"), "address", "remoteAddress"],
				[fulfilled(UNDEFINED), "[Symbol.asyncDispose]"],
			),
		]),
		SocketAddress: exportsWithContracts(),
		TlsServer: new Map([
			...netServerMethods("TlsServer"),
			...exportsWithContracts([returned(UNDEFINED), "setSecureContext", "addContext"]),
		]),
		TlsSocket: new Map([
			...netSocketMethods("TlsSocket"),
			...exportsWithContracts(
				[returned(STRING | NULL), "getProtocol"],
				[returned(OBJECT | UNDEFINED), "getCipher"],
				[returned(OBJECT), "getPeerCertificate"],
			),
		]),
		HttpAgent: exportsWithContracts([hostObject("HttpAgent"), "destroy"]),
		HttpsAgent: exportsWithContracts([hostObject("HttpsAgent"), "destroy"]),
		HttpIncomingMessage: new Map([
			...nodeStreamMethods("HttpIncomingMessage", true, false),
			["destroy", mutableDispatch],
			["_read", returned(UNDEFINED)],
		]),
		HttpOutgoingMessage: outgoingMethods("HttpOutgoingMessage"),
		HttpServerResponse: new Map([
			...outgoingMethods("HttpServerResponse"),
			...exportsWithContracts(
				[
					hostObject("HttpServerResponse", undefined, OBJECT | UNDEFINED),
					"writeHead",
					"end",
				],
				[returned(BOOLEAN | UNDEFINED), "write"],
				[returned(UNDEFINED), "_implicitHeader"],
			),
		]),
		HttpClientRequest: new Map([
			...outgoingMethods("HttpClientRequest"),
			...exportsWithContracts(
				[
					hostObject("HttpClientRequest", undefined, OBJECT | UNDEFINED),
					"end",
					"setTimeout",
				],
				[returned(BOOLEAN), "write"],
				[returned(UNDEFINED), "abort"],
			),
		]),
		HttpServer: httpServerMethods("HttpServer"),
		HttpsServer: new Map([
			...httpServerMethods("HttpsServer"),
			...exportsWithContracts(
				[returned(UNDEFINED), "setSecureContext", "addContext"],
				[mutableDispatch, "listen"],
			),
		]),
		ChildProcess: childProcessMethods("ChildProcess"),
		SpawnedChildProcess: childProcessMethods("SpawnedChildProcess"),
		SpawnSyncResult: exportsWithContracts(),
		ExecTextOutput: exportsWithContracts(),
		ExecBufferOutput: exportsWithContracts(),
		ExecOutput: exportsWithContracts(),
		NodeModule: exportsWithContracts([
			neverReturns(
				"Runtime Module.prototype.require rejects requests outside the prepared module graph.",
			),
			"require",
		]),
		NodeRequire: exportsWithContracts([returned(STRING), "resolve"]),
		ModuleHookRegistration: exportsWithContracts([returned(UNDEFINED), "deregister"]),
		SourceMapSupport: exportsWithContracts(),
		CompileCacheResult: exportsWithContracts(),
		ReadlineInterface: readlineMethods("ReadlineInterface"),
		ReadlinePromiseInterface: readlineMethods("ReadlinePromiseInterface"),
		ReadlineCursor: exportsWithContracts(),
		ReadlineIterator: exportsWithContracts(
			[iteratorResult, "next", "return"],
			[hostObject("ReadlineIterator"), "[Symbol.asyncIterator]"],
		),
		CompressionInfo: exportsWithContracts(),
		NodeStream: nodeStreamMethods("NodeStream", false, false),
		NodeReadable: nodeStreamMethods("NodeReadable", true, false),
		NodeWritable: nodeStreamMethods("NodeWritable", false, true),
		NodeDuplex: nodeStreamMethods("NodeDuplex", true, true),
		NodeTransform: nodeStreamMethods("NodeTransform", true, true),
		NodePassThrough: new Map([
			...nodeStreamMethods("NodePassThrough", true, true),
			["_transform", callback],
		]),
		NodeStreamIterator: exportsWithContracts(
			[
				{ kind: "fulfill", value: { mask: OBJECT, hostObject: "StreamReadResult" } },
				"next",
			],
			[
				dynamic(
					"The close path forwards the mutable close Promise's then method result.",
				),
				"return",
			],
			[hostObject("NodeStreamIterator"), "[Symbol.asyncIterator]"],
		),
		WebStreamPair: exportsWithContracts(),
		ZlibStream: new Map([
			...nodeStreamMethods("ZlibStream", true, true),
			...exportsWithContracts(
				[returned(UNDEFINED), "flush", "params", "reset", "close", "_read"],
				[callback, "_transform", "_flush", "_destroy"],
				[
					selected("return", { kind: "callback-chunk", argument: 2 }, OBJECT | UNDEFINED),
					"_processChunk",
				],
			),
		]),
		BroadcastChannel: new Map([
			...eventTargetMethods,
			...exportsWithContracts(
				[returned(UNDEFINED), "close", "postMessage"],
				[hostObject("BroadcastChannel"), "ref", "unref"],
			),
		]),
		MessageChannel: exportsWithContracts(),
		MaligatorMessageChannel: exportsWithContracts(),
		MessagePort: new Map([
			...eventTargetMethods,
			...listenerMethods("MessagePort"),
			...exportsWithContracts(
				[returned(UNDEFINED), "postMessage", "start", "close", "ref", "unref"],
				[returned(BOOLEAN), "hasRef"],
			),
		]),
		MaligatorMessagePort: new Map([
			...eventTargetMethods,
			...listenerMethods("MaligatorMessagePort"),
			...exportsWithContracts(
				[returned(NUMBER | UNDEFINED), "postMessage"],
				[returned(UNDEFINED), "start", "close"],
				[returned(BOOLEAN), "hasRef", "_discard"],
				[hostObject("MaligatorMessagePort"), "ref", "unref"],
			),
		]),
		NodeWorker: new Map([
			...listenerMethods("NodeWorker"),
			...exportsWithContracts(
				[returned(UNDEFINED), "postMessage"],
				[returned(BOOLEAN), "hasRef"],
				[hostObject("NodeWorker"), "ref", "unref"],
				[fulfilled(NUMBER | UNDEFINED), "terminate"],
			),
		]),
		MaligatorWorker: exportsWithContracts(
			[returned(BOOLEAN), "hasRef"],
			[hostObject("MaligatorWorker"), "ref", "unref"],
			[
				{ kind: "fulfill", value: { mask: OBJECT, hostObject: "WorkerExit" } },
				"terminate",
			],
		),
		WorkerCapabilities: exportsWithContracts(),
		WorkerExit: exportsWithContracts(),
		WorkerMessage: exportsWithContracts(),
		WorkerUrl: exportsWithContracts(),
		NativeHttpServer: exportsWithContracts([fulfilled(UNDEFINED), "close"]),
		AbortListener: exportsWithContracts([returned(UNDEFINED), "[Symbol.dispose]"]),
		AsyncHook: exportsWithContracts([hostObject("AsyncHook"), "enable", "disable"]),
		AsyncLocalStorage: exportsWithContracts(
			[returned(UNDEFINED), "disable", "enterWith"],
			[forwardsCallbackResult, "run", "exit"],
			[dynamic("The stored or default value can be any JavaScript value."), "getStore"],
			[hostObject("AsyncLocalScope"), "withScope"],
		),
		AsyncLocalScope: exportsWithContracts([
			returned(UNDEFINED),
			"dispose",
			"[Symbol.dispose]",
		]),
		AsyncResource: exportsWithContracts(
			[returned(NUMBER), "asyncId", "triggerAsyncId"],
			[returned(OBJECT), "bind"],
			[hostObject("AsyncResource"), "emitDestroy"],
			[forwardsCallbackResult, "runInAsyncScope"],
		),
		EventEmitter: emitterMethods("EventEmitter"),
		EventEmitterAsyncResource: new Map([
			...emitterMethods("EventEmitterAsyncResource"),
			...exportsWithContracts([
				dynamic("Forwards through the nested resource's mutable method lookup."),
				"emit",
				"emitDestroy",
			]),
		]),
		EventIterator: exportsWithContracts(
			[iteratorResult, "next", "return"],
			[returned(UNDEFINED), "throw"],
			[hostObject("EventIterator"), "[Symbol.asyncIterator]"],
		),
		LegacyUrl: exportsWithContracts(
			[hostObject("LegacyUrl"), "parse"],
			[returned(STRING), "resolve", "format"],
			[returned(OBJECT), "resolveObject"],
		),
		TimerScheduler: exportsWithContracts([resolved(UNDEFINED), "wait", "yield"]),
		TimerIntervalIterator: exportsWithContracts(
			[iteratorResult, "next", "return"],
			[hostObject("TimerIntervalIterator"), "[Symbol.asyncIterator]"],
		),
		Cipheriv: cipherMethods("Cipheriv"),
		Decipheriv: cipherMethods("Decipheriv"),
		Hash: digestMethods("Hash"),
		Hmac: digestMethods("Hmac"),
		Sign: new Map([
			...nodeStreamMethods("Sign", false, true),
			...exportsWithContracts(
				[hostObject("Sign"), "update"],
				[selected("return", { kind: "digest-encoding", argument: 1 }), "sign"],
				[callback, "_write"],
			),
		]),
		Verify: new Map([
			...nodeStreamMethods("Verify", false, true),
			...exportsWithContracts(
				[hostObject("Verify"), "update"],
				[returned(BOOLEAN), "verify"],
				[callback, "_write"],
			),
		]),
		X509Certificate: exportsWithContracts(
			[returned(STRING), "toString", "toJSON"],
			[returned(STRING | UNDEFINED), "checkHost", "checkEmail", "checkIP"],
			[returned(BOOLEAN), "checkIssued", "checkPrivateKey", "verify"],
			[returned(OBJECT), "toLegacyObject"],
		),
		SecretKeyObject: exportsWithContracts(
			[returned(BOOLEAN), "equals"],
			[returned(OBJECT), "export"],
		),
		AnyKeyObject: exportsWithContracts([returned(BOOLEAN), "equals"]),
		AsymmetricKeyObject: exportsWithContracts(
			[returned(BOOLEAN), "equals"],
			[returned(STRING | OBJECT), "export"],
			[returned(OBJECT), "toCryptoKey"],
		),
		Crypto: exportsWithContracts(
			[returned(OBJECT), "getRandomValues"],
			[returned(STRING), "randomUUID"],
		),
		SubtleCrypto: exportsWithContracts(
			[
				fulfilled(OBJECT),
				"digest",
				"deriveBits",
				"encrypt",
				"decrypt",
				"sign",
				"importKey",
				"exportKey",
				"generateKey",
			],
			[
				selected(
					"fulfill",
					{ kind: "signature-argument", argument: 2 },
					BOOLEAN | OBJECT,
				),
				"verify",
			],
		),
		MIMEType: exportsWithContracts([returned(STRING), "toString", "toJSON"]),
		MIMEParams: exportsWithContracts(
			[returned(STRING | NULL), "get"],
			[returned(BOOLEAN), "has"],
			[returned(UNDEFINED), "set", "delete"],
			[returned(STRING), "toString", "toJSON"],
			[returned(OBJECT), "keys", "values", "entries", "[Symbol.iterator]"],
		),
		Dir: exportsWithContracts(
			[directoryCompletion({ mask: OBJECT | NULL, hostObject: "Dirent" }), "read"],
			[hostObject("Dirent", undefined, OBJECT | NULL), "readSync"],
			[directoryCompletion({ mask: UNDEFINED }), "close"],
			[returned(UNDEFINED), "closeSync"],
			[hostObject("DirIterator"), "[Symbol.asyncIterator]"],
		),
		Dirent: fileTypePredicates,
		DirIterator: exportsWithContracts([fulfilled(OBJECT), "next", "return"]),
		FileHandle: NODE_FILE_HANDLE_RESULTS.methods,
		Stats: fileTypePredicates,
		ByteLengthQueuingStrategy: exportsWithContracts([
			dynamic("Returns the supplied chunk's byteLength property without converting it."),
			"size",
		]),
		CompressionStream: exportsWithContracts(),
		CountQueuingStrategy: exportsWithContracts([returned(NUMBER), "size"]),
		DecompressionStream: exportsWithContracts(),
		AbortController: exportsWithContracts([returned(UNDEFINED), "abort"]),
		AbortSignal: new Map([
			...eventTargetMethods,
			["throwIfAborted", returned(UNDEFINED)],
		]),
		Blob: blob,
		Buffer: exportsWithContracts(
			[
				hostObject("Buffer", "Uint8Array"),
				"slice",
				"subarray",
				"fill",
				"swap16",
				"swap32",
				"swap64",
			],
			[returned(BOOLEAN), "equals", "includes"],
			[returned(OBJECT), "toJSON"],
			[
				returned(STRING),
				"toString",
				"toLocaleString",
				"inspect",
				"[[SymbolKey:nodejs.util.inspect.custom]]",
				"utf8Slice",
				"latin1Slice",
				"asciiSlice",
				"hexSlice",
				"base64Slice",
				"base64urlSlice",
				"ucs2Slice",
			],
			[
				returned(BIGINT),
				"readBigUInt64LE",
				"readBigUint64LE",
				"readBigUInt64BE",
				"readBigUint64BE",
				"readBigInt64LE",
				"readBigInt64BE",
			],
			[
				returned(NUMBER),
				"compare",
				"write",
				"copy",
				"indexOf",
				"lastIndexOf",
				"utf8Write",
				"latin1Write",
				"asciiWrite",
				"hexWrite",
				"base64Write",
				"base64urlWrite",
				"ucs2Write",
				"readUInt8",
				"readUint8",
				"writeUInt8",
				"writeUint8",
				"readInt8",
				"writeInt8",
				"readUInt16LE",
				"readUint16LE",
				"writeUInt16LE",
				"writeUint16LE",
				"readUInt16BE",
				"readUint16BE",
				"writeUInt16BE",
				"writeUint16BE",
				"readInt16LE",
				"writeInt16LE",
				"readInt16BE",
				"writeInt16BE",
				"readUInt32LE",
				"readUint32LE",
				"writeUInt32LE",
				"writeUint32LE",
				"readUInt32BE",
				"readUint32BE",
				"writeUInt32BE",
				"writeUint32BE",
				"readInt32LE",
				"writeInt32LE",
				"readInt32BE",
				"writeInt32BE",
				"readFloatLE",
				"writeFloatLE",
				"readFloatBE",
				"writeFloatBE",
				"readDoubleLE",
				"writeDoubleLE",
				"readDoubleBE",
				"writeDoubleBE",
				"writeBigUInt64LE",
				"writeBigUint64LE",
				"writeBigUInt64BE",
				"writeBigUint64BE",
				"writeBigInt64LE",
				"writeBigInt64BE",
				"readUIntLE",
				"readUintLE",
				"writeUIntLE",
				"writeUintLE",
				"readUIntBE",
				"readUintBE",
				"writeUIntBE",
				"writeUintBE",
				"readIntLE",
				"writeIntLE",
				"readIntBE",
				"writeIntBE",
			],
		),
		DatabaseSync: exportsWithContracts(
			[returned(UNDEFINED), "close", "exec"],
			[hostObject("StatementSync"), "prepare"],
		),
		DOMException: exportsWithContracts(),
		Event: eventMethods,
		CustomEvent: eventMethods,
		CloseEvent: eventMethods,
		ErrorEvent: eventMethods,
		MessageEvent: eventMethods,
		EventTarget: eventTargetMethods,
		WebSocket: new Map([
			...eventTargetMethods,
			...exportsWithContracts([returned(UNDEFINED), "close", "send"]),
		]),
		File: blob,
		FormData: exportsWithContracts(
			[returned(UNDEFINED), "append", "delete", "set", "forEach"],
			[returned(BOOLEAN), "has"],
			[returned(STRING | OBJECT | NULL), "get"],
			[returned(OBJECT, "Array"), "getAll"],
			[hostObject("FormDataIterator"), "entries", "keys", "values", "[Symbol.iterator]"],
		),
		Headers: exportsWithContracts(
			[returned(UNDEFINED), "append", "delete", "set", "forEach"],
			[returned(BOOLEAN), "has"],
			[returned(STRING | NULL), "get"],
			[returned(OBJECT, "Array"), "getSetCookie"],
			[hostObject("HeadersIterator"), "entries", "keys", "values", "[Symbol.iterator]"],
		),
		Request: new Map([...body, ["clone", hostObject("Request")]]),
		Response: body,
		ReadableStream: exportsWithContracts(
			[fulfilled(UNDEFINED), "cancel", "pipeTo"],
			[hostObject("ReadableStreamReader"), "getReader"],
			[returned(OBJECT), "pipeThrough"],
			[returned(OBJECT, "Array"), "tee"],
			[hostObject("ReadableStreamIterator"), "values", "[Symbol.asyncIterator]"],
		),
		ReadableStreamDefaultReader: readableReaderMethods,
		ReadableStreamBYOBReader: readableReaderMethods,
		ReadableStreamReader: readableReaderMethods,
		ReadableStreamIterator: exportsWithContracts([fulfilled(OBJECT), "next", "return"]),
		StreamReadResult: exportsWithContracts(),
		StatementSync: exportsWithContracts(
			[returned(OBJECT, "Array"), "all"],
			[returned(OBJECT | UNDEFINED), "get"],
			[returned(OBJECT), "run"],
			[returned(UNDEFINED), "setReturnArrays", "setReadBigInts"],
		),
		StringDecoder: exportsWithContracts([returned(STRING), "write", "end"]),
		TextDecoder: exportsWithContracts([returned(STRING), "decode"]),
		TextDecoderStream: exportsWithContracts(),
		TextEncoder: exportsWithContracts(
			[returned(OBJECT, "Uint8Array"), "encode"],
			[returned(OBJECT), "encodeInto"],
		),
		TextEncoderStream: exportsWithContracts(),
		TransformStream: exportsWithContracts(),
		URL: exportsWithContracts([returned(STRING), "toString", "toJSON"]),
		URLSearchParams: exportsWithContracts(
			[returned(STRING | NULL), "get"],
			[returned(OBJECT, "Array"), "getAll"],
			[returned(BOOLEAN), "has"],
			[returned(UNDEFINED), "set", "append", "delete", "sort", "forEach"],
			[returned(STRING), "toString"],
			[
				hostObject("URLSearchParamsIterator"),
				"entries",
				"keys",
				"values",
				"[Symbol.iterator]",
			],
		),
		URLSearchParamsIterator: exportsWithContracts([returned(OBJECT), "next"]),
		WritableStream: exportsWithContracts(
			[abortSink, "abort"],
			[fulfilled(UNDEFINED), "close"],
			[hostObject("WritableStreamDefaultWriter"), "getWriter"],
		),
		WritableStreamDefaultWriter: exportsWithContracts(
			[abortSink, "abort"],
			[fulfilled(UNDEFINED), "close", "write"],
			[returned(UNDEFINED), "releaseLock"],
		),
		Timeout: exportsWithContracts(
			[hostObject("Timeout"), "ref", "unref", "refresh", "close"],
			[returned(BOOLEAN), "hasRef"],
			[returned(NUMBER), "[Symbol.toPrimitive]"],
		),
		Immediate: exportsWithContracts(
			[hostObject("Immediate"), "ref", "unref"],
			[returned(BOOLEAN), "hasRef"],
			[returned(UNDEFINED), "[Symbol.dispose]"],
		),
		FormDataIterator: exportsWithContracts([returned(OBJECT), "next"]),
		HeadersIterator: exportsWithContracts([returned(OBJECT), "next"]),
	},
	properties: {
		ReadableStreamDefaultController: exportsWithContracts([
			returned(NUMBER | NULL),
			"desiredSize",
		]),
		ReadableByteStreamController: exportsWithContracts(
			[returned(NUMBER | NULL), "desiredSize"],
			[hostObject("ReadableStreamBYOBRequest", undefined, OBJECT | NULL), "byobRequest"],
		),
		ReadableStreamBYOBRequest: exportsWithContracts([returned(OBJECT | NULL), "view"]),
		WritableStreamDefaultController: exportsWithContracts([
			returned(UNDEFINED),
			"signal",
		]),
		TransformStreamDefaultController: exportsWithContracts([
			returned(NUMBER | NULL),
			"desiredSize",
		]),
		DiagnosticsChannel: exportsWithContracts(
			[returned(BOOLEAN), "hasSubscribers"],
			[returned(STRING | SYMBOL), "name"],
		),
		TracingChannel: exportsWithContracts(
			[returned(BOOLEAN), "hasSubscribers"],
			[
				hostObject("DiagnosticsChannel"),
				"start",
				"end",
				"asyncStart",
				"asyncEnd",
				"error",
			],
		),
		Performance: exportsWithContracts(
			[returned(NUMBER), "timeOrigin"],
			[hostObject("PerformanceNodeTiming", undefined, OBJECT | UNDEFINED), "nodeTiming"],
		),
		PerformanceEntry: exportsWithContracts(
			[returned(STRING), "name", "entryType"],
			[returned(NUMBER), "startTime", "duration"],
			[dynamic("Contains a structured clone of the caller's detail value."), "detail"],
		),
		PerformanceNodeTiming: exportsWithContracts([returned(NUMBER), "duration"]),
		Histogram: exportsWithContracts([
			returned(NUMBER),
			"min",
			"max",
			"mean",
			"stddev",
			"exceeds",
			"count",
		]),
		TtyReadStream: new Map([
			...socketProperties,
			...exportsWithContracts([returned(BOOLEAN), "isTTY", "isRaw"]),
		]),
		TtyWriteStream: new Map([
			...socketProperties,
			...exportsWithContracts(
				[returned(BOOLEAN), "isTTY"],
				[returned(NUMBER | UNDEFINED), "columns", "rows"],
			),
		]),
		NetBlockList: exportsWithContracts([returned(OBJECT, "Array"), "rules"]),
		NetServer: exportsWithContracts([returned(BOOLEAN), "listening"]),
		TlsServer: exportsWithContracts([returned(BOOLEAN), "listening"]),
		NetSocket: socketProperties,
		TlsSocket: new Map([...socketProperties, ["encrypted", returned(BOOLEAN)]]),
		SocketAddress: exportsWithContracts(
			[returned(STRING), "address", "family"],
			[returned(NUMBER), "port"],
		),
		HttpAgent: exportsWithContracts(
			[returned(NUMBER), "maxTotalSockets", "agentKeepAliveTimeoutBuffer"],
			[returned(STRING), "scheduling"],
		),
		HttpIncomingMessage: new Map([
			...readableStateFields,
			["connection", dynamic("Reads the caller-writable socket field.")],
		]),
		HttpOutgoingMessage: outgoingProperties,
		HttpServerResponse: outgoingProperties,
		HttpClientRequest: outgoingProperties,
		HttpServer: httpServerProperties,
		HttpsServer: httpServerProperties,
		ChildProcess: childProcessProperties,
		SpawnedChildProcess: new Map([
			...childProcessProperties,
			...exportsWithContracts(
				[returned(STRING), "spawnfile"],
				[returned(OBJECT, "Array"), "spawnargs", "stdio"],
				[hostObject("NodeWritable", undefined, OBJECT | NULL), "stdin"],
				[hostObject("NodeReadable", undefined, OBJECT | NULL), "stdout", "stderr"],
			),
		]),
		SpawnSyncResult: exportsWithContracts(
			[returned(NUMBER), "pid"],
			[returned(NUMBER | NULL), "status"],
			[returned(STRING | NUMBER | NULL), "signal"],
			[returned(OBJECT | NULL), "output"],
			[returned(OBJECT | UNDEFINED), "error"],
			[returned(STRING | OBJECT | NULL | UNDEFINED), "stdout", "stderr"],
		),
		SourceMapSupport: exportsWithContracts([
			returned(BOOLEAN),
			"enabled",
			"nodeModules",
			"generatedCode",
		]),
		CompileCacheResult: exportsWithContracts(
			[returned(NUMBER), "status"],
			[returned(STRING), "message"],
		),
		ExecTextOutput: exportsWithContracts([returned(STRING), "stdout", "stderr"]),
		ExecBufferOutput: exportsWithContracts([
			hostObject("Buffer", "Uint8Array"),
			"stdout",
			"stderr",
		]),
		ExecOutput: exportsWithContracts([returned(STRING | OBJECT), "stdout", "stderr"]),
		ReadlineCursor: exportsWithContracts(
			[returned(NUMBER), "rows"],
			[dynamic("Returns the public cursor value unchanged."), "cols"],
		),
		CompressionInfo: exportsWithContracts(
			[hostObject("Buffer", "Uint8Array"), "buffer"],
			[hostObject("ZlibStream"), "engine"],
		),
		NodeReadable: readableStateFields,
		NodeWritable: writableStateFields,
		NodeDuplex: duplexStateFields,
		NodeTransform: duplexStateFields,
		NodePassThrough: duplexStateFields,
		ZlibStream: new Map([
			...duplexStateFields,
			...exportsWithContracts(
				[returned(BOOLEAN), "_closed"],
				[returned(NUMBER), "bytesWritten"],
			),
		]),
		WebStreamPair: transformStreamProperties,
		BroadcastChannel: exportsWithContracts(
			[returned(STRING), "name"],
			[returned(OBJECT | NULL), "onmessage", "onmessageerror"],
		),
		MessageChannel: exportsWithContracts([hostObject("MessagePort"), "port1", "port2"]),
		MaligatorMessageChannel: exportsWithContracts([
			hostObject("MaligatorMessagePort"),
			"port1",
			"port2",
		]),
		MessagePort: exportsWithContracts([
			returned(OBJECT | NULL),
			"onmessage",
			"onmessageerror",
		]),
		MaligatorMessagePort: exportsWithContracts([
			returned(OBJECT | NULL),
			"onmessage",
			"onmessageerror",
		]),
		NodeWorker: exportsWithContracts([returned(NUMBER), "threadId"]),
		MaligatorWorker: exportsWithContracts(
			[returned(NUMBER), "id"],
			[fulfilled(UNDEFINED), "ready"],
			[
				{
					kind: "fulfill",
					immediateMask: OBJECT | UNDEFINED,
					value: { mask: UNDEFINED },
				},
				"applicationReady",
			],
			[{ kind: "fulfill", value: { mask: OBJECT, hostObject: "WorkerExit" } }, "closed"],
			[hostObject("MaligatorMessagePort"), "port"],
		),
		WorkerCapabilities: exportsWithContracts(
			[returned(BOOLEAN), "threads", "sharedMemory"],
			[returned(NUMBER), "parallelism", "maxWorkers"],
		),
		WorkerExit: exportsWithContracts(
			[returned(NUMBER), "id", "code"],
			[returned(STRING), "reason"],
			[dynamic("Contains a worker-defined failure value when available."), "error"],
		),
		WorkerMessage: exportsWithContracts([
			dynamic("The queued message can be any supported cloneable value."),
			"message",
		]),
		WorkerUrl: exportsWithContracts([returned(STRING), "href"]),
		NativeHttpServer: exportsWithContracts([returned(NUMBER), "port"]),
		AsyncLocalStorage: exportsWithContracts([returned(STRING), "name"]),
		EventEmitterAsyncResource: exportsWithContracts(
			[hostObject("AsyncResource"), "asyncResource"],
			[
				dynamic("Forwards through the nested resource's mutable method lookup."),
				"asyncId",
				"triggerAsyncId",
			],
		),
		Crypto: exportsWithContracts([hostObject("SubtleCrypto"), "subtle"]),
		MIMEType: exportsWithContracts(
			[returned(STRING), "type", "subtype", "essence"],
			[hostObject("MIMEParams"), "params"],
		),
		SecretKeyObject: exportsWithContracts(
			[returned(STRING), "type"],
			[returned(NUMBER), "symmetricKeySize"],
		),
		AnyKeyObject: exportsWithContracts([returned(STRING), "type"]),
		AsymmetricKeyObject: exportsWithContracts(
			[returned(STRING), "type", "asymmetricKeyType"],
			[returned(OBJECT), "asymmetricKeyDetails"],
		),
		X509Certificate: exportsWithContracts(
			[
				returned(STRING | UNDEFINED),
				"subject",
				"subjectAltName",
				"issuer",
				"infoAccess",
				"validFrom",
				"validTo",
				"fingerprint",
				"fingerprint256",
				"fingerprint512",
				"serialNumber",
				"signatureAlgorithm",
				"signatureAlgorithmOid",
			],
			[returned(OBJECT | UNDEFINED), "validFromDate", "validToDate", "keyUsage"],
			[returned(UNDEFINED), "issuerCertificate"],
			[hostObject("AsymmetricKeyObject"), "publicKey"],
			[hostObject("Buffer", "Uint8Array"), "raw"],
			[returned(BOOLEAN), "ca"],
		),
		Dir: exportsWithContracts([returned(STRING), "path"]),
		FileHandle: NODE_FILE_HANDLE_RESULTS.properties,
		Stats: exportsWithContracts([
			returned(OBJECT),
			"atime",
			"mtime",
			"ctime",
			"birthtime",
		]),
		ByteLengthQueuingStrategy: exportsWithContracts(
			[returned(NUMBER), "highWaterMark"],
			[returned(OBJECT), "size"],
		),
		CompressionStream: transformStreamProperties,
		CountQueuingStrategy: exportsWithContracts(
			[returned(NUMBER), "highWaterMark"],
			[returned(OBJECT), "size"],
		),
		DecompressionStream: transformStreamProperties,
		AbortController: exportsWithContracts([hostObject("AbortSignal"), "signal"]),
		AbortSignal: exportsWithContracts(
			[returned(BOOLEAN), "aborted"],
			[dynamic("The abort reason can be any supplied JavaScript value."), "reason"],
		),
		Blob: blobProperties,
		Buffer: exportsWithContracts(
			[returned(OBJECT), "parent"],
			[returned(NUMBER), "offset"],
		),
		DatabaseSync: exportsWithContracts([returned(BOOLEAN), "isOpen", "isTransaction"]),
		DOMException: exportsWithContracts(
			[returned(STRING), "name", "message"],
			[returned(NUMBER), "code"],
		),
		Event: eventProperties,
		CustomEvent: new Map([
			...eventProperties,
			["detail", dynamic("Carries the detail supplied by the caller.")],
		]),
		CloseEvent: new Map([
			...eventProperties,
			...exportsWithContracts(
				[returned(BOOLEAN), "wasClean"],
				[returned(NUMBER), "code"],
				[returned(STRING), "reason"],
			),
		]),
		ErrorEvent: new Map([
			...eventProperties,
			...exportsWithContracts(
				[returned(STRING), "message", "filename"],
				[returned(NUMBER), "lineno", "colno"],
				[dynamic("Carries the error value supplied by the caller."), "error"],
			),
		]),
		MessageEvent: new Map([
			...eventProperties,
			...exportsWithContracts(
				[returned(STRING), "origin", "lastEventId"],
				[
					dynamic(
						"Carries the corresponding value supplied by the caller, without conversion.",
					),
					"data",
					"source",
					"ports",
				],
			),
		]),
		WebSocket: exportsWithContracts(
			[returned(NUMBER), "readyState", "bufferedAmount"],
			[returned(STRING), "url", "extensions", "protocol", "binaryType"],
			[returned(OBJECT | NULL), "onopen", "onerror", "onclose", "onmessage"],
		),
		File: new Map([
			...blobProperties,
			...exportsWithContracts(
				[returned(STRING), "name"],
				[returned(NUMBER), "lastModified"],
			),
		]),
		Request: new Map([
			...bodyProperties,
			...exportsWithContracts(
				[
					returned(STRING),
					"method",
					"url",
					"destination",
					"referrer",
					"referrerPolicy",
					"mode",
					"credentials",
					"cache",
					"redirect",
					"integrity",
					"duplex",
				],
				[returned(OBJECT | UNDEFINED), "headers", "signal"],
				[returned(BOOLEAN), "isReloadNavigation", "isHistoryNavigation"],
			),
		]),
		Response: new Map([
			...bodyProperties,
			...exportsWithContracts(
				[returned(NUMBER), "status"],
				[returned(BOOLEAN), "ok", "redirected"],
				[returned(STRING), "statusText", "type", "url"],
				[returned(OBJECT | UNDEFINED), "headers"],
			),
		]),
		ReadableStream: exportsWithContracts([returned(BOOLEAN), "locked"]),
		ReadableStreamDefaultReader: readableReaderProperties,
		ReadableStreamBYOBReader: readableReaderProperties,
		ReadableStreamReader: readableReaderProperties,
		StreamReadResult: exportsWithContracts(
			[returned(BOOLEAN), "done"],
			[dynamic("The stream can enqueue any JavaScript value."), "value"],
		),
		TextDecoder: exportsWithContracts(
			[returned(STRING), "encoding"],
			[returned(BOOLEAN), "fatal", "ignoreBOM"],
		),
		TextEncoder: exportsWithContracts([returned(STRING), "encoding"]),
		TextDecoderStream: new Map([
			...transformStreamProperties,
			...exportsWithContracts(
				[returned(STRING), "encoding"],
				[returned(BOOLEAN), "fatal", "ignoreBOM"],
			),
		]),
		TextEncoderStream: new Map([
			...transformStreamProperties,
			["encoding", returned(STRING)],
		]),
		TransformStream: transformStreamProperties,
		URL: exportsWithContracts(
			[
				returned(STRING),
				"href",
				"protocol",
				"username",
				"password",
				"host",
				"hostname",
				"port",
				"pathname",
				"search",
				"hash",
				"origin",
			],
			[hostObject("URLSearchParams"), "searchParams"],
		),
		URLSearchParams: exportsWithContracts([returned(NUMBER), "size"]),
		WritableStream: exportsWithContracts([returned(BOOLEAN), "locked"]),
		WritableStreamDefaultWriter: exportsWithContracts(
			[fulfilled(UNDEFINED), "closed", "ready"],
			[returned(NUMBER | NULL), "desiredSize"],
		),
	},
} as const;
