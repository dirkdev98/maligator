import {
	COMPILER_VALUE_KIND_BOOLEAN as BOOLEAN,
	COMPILER_VALUE_KIND_BIGINT as BIGINT,
	COMPILER_VALUE_KIND_NULL as NULL,
	COMPILER_VALUE_KIND_NUMBER as NUMBER,
	COMPILER_VALUE_KIND_OBJECT as OBJECT,
	COMPILER_VALUE_KIND_STRING as STRING,
	COMPILER_VALUE_KIND_TOP as TOP,
	COMPILER_VALUE_KIND_UNDEFINED as UNDEFINED,
} from "./compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "./compiler-value-kinds.ts";

export interface HostValueContract {
	readonly mask: CompilerValueKindMask;
	readonly brand?: "Array" | "Uint8Array";
	readonly hostObject?: HostObjectKind;
	readonly hostConstructor?: HostObjectKind;
	readonly assetHandle?: "file" | "directory";
	readonly nodeFileHandle?: true;
	readonly diskHandle?: "file" | "directory" | "writer" | "watcher";
	readonly selector?: {
		readonly argument: number;
		readonly kind:
			| "encoding"
			| "buffer-encoding"
			| "output-encoding"
			| "text-flag"
			| "stat-options"
			| "mkdir-options"
			| "compression-info"
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

const fs = exportsWithContracts(
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
		selected("return", { kind: "stat-options", argument: 1 }, OBJECT | UNDEFINED),
		"lstatSync",
		"statSync",
	],
	[returned(OBJECT), "fstatSync"],
	[returned(OBJECT, "Array"), "readdirSync", "globSync"],
	[
		returned(OBJECT),
		"Dir",
		"Dirent",
		"FileReadStream",
		"FileWriteStream",
		"ReadStream",
		"Stats",
		"WriteStream",
		"createReadStream",
		"createWriteStream",
		"mkdtempDisposableSync",
		"opendirSync",
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
	[{ kind: "fulfill", value: { mask: OBJECT, nodeFileHandle: true } }, "open"],
	[fulfilled(OBJECT), "opendir", "statfs"],
	[
		selected("fulfill", { kind: "stat-options", argument: 1 }, OBJECT | UNDEFINED),
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
		[fulfilled(OBJECT), "read", "stat", "write"],
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
	[hostObject("URL"), "pathToFileURL"],
	[
		returned(STRING),
		"domainToASCII",
		"domainToUnicode",
		"fileURLToPath",
		"format",
		"resolve",
	],
	[returned(OBJECT), "Url", "parse", "urlToHttpOptions"],
	[
		{ kind: "dynamic", reason: "An absent base returns the second argument unchanged." },
		"resolveObject",
	],
);

const util = exportsWithContracts(
	[nativeConstructor("TextEncoder"), "TextEncoder"],
	[nativeConstructor("TextDecoder"), "TextDecoder"],
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
		"MIMEParams",
		"MIMEType",
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
	[
		returned(OBJECT),
		"createHistogram",
		"eventLoopUtilization",
		"monitorEventLoopDelay",
		"timerify",
		"PerformanceObserver",
	],
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
	[returned(OBJECT), "Worker", "MessageChannel", "capabilities", "createWorkerUrl"],
	[returned(OBJECT | UNDEFINED), "receiveMessageOnPort"],
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
	[returned(OBJECT), "Script", "compileFunction", "createContext", "createScript"],
	[returned(BOOLEAN), "isContext"],
	[
		dynamic("Returns the evaluated script's completion value."),
		"runInContext",
		"runInNewContext",
		"runInThisContext",
	],
);
const diagnostics = exportsWithContracts(
	[returned(OBJECT), "Channel", "channel", "tracingChannel"],
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
	[
		returned(OBJECT),
		"AsyncLocalStorage",
		"AsyncResource",
		"createHook",
		"executionAsyncResource",
	],
	[returned(NUMBER), "executionAsyncId", "triggerAsyncId"],
);
const console = exportsWithContracts(
	[returned(OBJECT), "Console"],
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
	[
		returned(OBJECT),
		"default",
		"Module",
		"createRequire",
		"enableCompileCache",
		"getSourceMapsSupport",
		"registerHooks",
	],
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
const nodeWorkers = exportsWithContracts(
	[returned(OBJECT), "BroadcastChannel", "MessageChannel", "Worker"],
	[returned(BOOLEAN), "isMarkedAsUntransferable"],
	[
		returned(UNDEFINED),
		"markAsUncloneable",
		"markAsUntransferable",
		"setEnvironmentData",
	],
	[returned(OBJECT | UNDEFINED), "receiveMessageOnPort"],
	[
		dynamic("Reads an application-defined value from the environment data map."),
		"getEnvironmentData",
	],
	[neverReturns("Ports are created by the channel and worker factories."), "MessagePort"],
);
const assertions = exportsWithContracts(
	[returned(OBJECT), "Assert", "AssertionError"],
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
		returned(OBJECT),
		"BrotliCompress",
		"BrotliDecompress",
		"Deflate",
		"DeflateRaw",
		"Gunzip",
		"Gzip",
		"Inflate",
		"InflateRaw",
		"Unzip",
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
	[returned(OBJECT), "Resolver"],
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
	[returned(OBJECT), "lookup"],
	[callback, ...dnsQueries],
);
const dnsPromises = exportsWithContracts(
	...dnsShared,
	[
		{ kind: "resolve", value: { mask: OBJECT } },
		"lookup",
		...dnsQueries.filter((name) => name !== "resolveAny"),
	],
	[fulfilled(0), "resolveAny"],
);
const tty = exportsWithContracts(
	[returned(BOOLEAN), "isatty"],
	[returned(OBJECT), "ReadStream", "WriteStream"],
);
const sqlite = exportsWithContracts(
	[nativeConstructor("DatabaseSync"), "DatabaseSync"],
	[neverReturns("Statements are created by DatabaseSync.prepare."), "StatementSync"],
);

const http = exportsWithContracts(
	[returned(BOOLEAN), "isValidHeaderName", "isValidHeaderValue"],
	[
		returned(UNDEFINED),
		"validateHeaderName",
		"validateHeaderValue",
		"setMaxIdleHTTPParsers",
	],
	[
		returned(OBJECT),
		"Agent",
		"CloseEvent",
		"MessageEvent",
		"IncomingMessage",
		"OutgoingMessage",
		"ServerResponse",
		"Server",
		"ClientRequest",
		"createServer",
		"request",
		"get",
		"WebSocket",
	],
);
const https = exportsWithContracts([
	returned(OBJECT),
	"Agent",
	"Server",
	"createServer",
	"request",
	"get",
]);
const tls = exportsWithContracts(
	[
		returned(OBJECT),
		"connect",
		"createSecureContext",
		"SecureContext",
		"createServer",
		"Server",
	],
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
	[returned(BOOLEAN), "isIPv4", "isIPv6", "getDefaultAutoSelectFamily"],
	[returned(NUMBER), "isIP", "getDefaultAutoSelectFamilyAttemptTimeout"],
	[
		returned(UNDEFINED),
		"setDefaultAutoSelectFamily",
		"setDefaultAutoSelectFamilyAttemptTimeout",
	],
	[
		returned(OBJECT),
		"BlockList",
		"Server",
		"connect",
		"createConnection",
		"createServer",
	],
	[returned(OBJECT | UNDEFINED), "Socket"],
);
const childProcess = exportsWithContracts(
	[returned(OBJECT), "ChildProcess", "exec", "execFile", "spawn", "spawnSync"],
	[returned(STRING | OBJECT | NULL), "execSync", "execFileSync"],
	[neverReturns("The native runtime does not support fork IPC."), "fork"],
);
const readline = exportsWithContracts(
	[returned(OBJECT), "Interface", "createInterface"],
	[returned(UNDEFINED), "emitKeypressEvents"],
	[
		dynamic("The output stream's write method supplies the return value."),
		"clearLine",
		"clearScreenDown",
		"cursorTo",
		"moveCursor",
	],
);
const crypto = exportsWithContracts(
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
		"createCipheriv",
		"createDecipheriv",
		"createHash",
		"createHmac",
		"createSign",
		"createVerify",
		"createPrivateKey",
		"createPublicKey",
		"createSecretKey",
		"generateKeySync",
		"Cipheriv",
		"Decipheriv",
		"Hash",
		"Hmac",
		"Sign",
		"Verify",
		"X509Certificate",
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
	[
		returned(OBJECT | UNDEFINED),
		"default",
		"Stream",
		"Readable",
		"Writable",
		"Duplex",
		"Transform",
		"PassThrough",
	],
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
	[
		returned(OBJECT),
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
	],
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
	[returned(UNDEFINED), "default", "EventEmitter", "init", "setMaxListeners"],
	[returned(OBJECT), "EventEmitterAsyncResource", "addAbortListener", "on"],
	[returned(NUMBER), "listenerCount"],
	[{ kind: "resolve", value: { mask: OBJECT, brand: "Array" } }, "once"],
	[
		dynamic("A custom emitter can return an arbitrary result from its method."),
		"getEventListeners",
		"getMaxListeners",
	],
);
const timers = exportsWithContracts(
	[returned(OBJECT), "setTimeout", "setInterval", "setImmediate"],
	[returned(UNDEFINED), "clearTimeout", "clearInterval", "clearImmediate"],
);
const timersPromises = exportsWithContracts(
	[returned(OBJECT), "setInterval"],
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
		exportsWithContracts([returned(OBJECT), "Socket", "createSocket"]),
	],
	["mal_host_install_node_readline", readline],
	["mal_host_install_node_readline_promises", readline],
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
			[returned(OBJECT), "listen"],
			[returned(OBJECT | UNDEFINED), "assetResponse"],
			[returned(STRING | UNDEFINED), "assetProxy"],
		),
	],
	[
		"mal_host_install_maligator_internal_fetch",
		exportsWithContracts([fulfilled(OBJECT), "fetch"]),
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
		exportsWithContracts([returned(OBJECT), "StringDecoder"]),
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
	[{ kind: "return", value: { mask: OBJECT, diskHandle: "file" } }, "file"],
	[{ kind: "return", value: { mask: OBJECT, diskHandle: "directory" } }, "directory"],
	[fulfilled(STRING), "realpath", "readlink"],
	[fulfilled(UNDEFINED), "symlink"],
	[
		{ kind: "fulfill", value: { mask: OBJECT, diskHandle: "directory" } },
		"temporaryDirectory",
	],
	[{ kind: "return", value: { mask: OBJECT, diskHandle: "watcher" } }, "watch"],
	[returned(OBJECT), "FileSystemError"],
);

export const DISK_HANDLE_RESULTS = {
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
			[{ kind: "return", value: { mask: OBJECT, diskHandle: "writer" } }, "writer"],
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
			[{ kind: "return", value: { mask: OBJECT, diskHandle: "file" } }, "file"],
			[{ kind: "return", value: { mask: OBJECT, diskHandle: "directory" } }, "directory"],
			[
				{ kind: "fulfill", value: { mask: OBJECT | UNDEFINED, diskHandle: "file" } },
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
				{ kind: "return", value: { mask: OBJECT, diskHandle: "watcher" } },
				"[Symbol.asyncIterator]",
			],
		),
	},
} as const;

export type HostObjectKind =
	| "AbortController"
	| "AbortSignal"
	| "Blob"
	| "Buffer"
	| "DatabaseSync"
	| "DOMException"
	| "File"
	| "FormData"
	| "Headers"
	| "Request"
	| "Response"
	| "StatementSync"
	| "TextDecoder"
	| "TextEncoder"
	| "URL"
	| "URLSearchParams"
	| "URLSearchParamsIterator"
	| "FormDataIterator"
	| "HeadersIterator";

const body = exportsWithContracts(
	[resolved(STRING), "text"],
	[resolved(OBJECT), "arrayBuffer", "bytes"],
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
	[resolved(OBJECT), "arrayBuffer", "bytes"],
	[returned(OBJECT), "stream"],
);
const blobProperties = exportsWithContracts(
	[returned(NUMBER), "size"],
	[returned(STRING), "type"],
);
const bodyProperties = exportsWithContracts(
	[returned(OBJECT | NULL), "body"],
	[returned(BOOLEAN), "bodyUsed"],
);

export const GLOBAL_HOST_CONSTRUCTORS = [
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
	"TextDecoder",
	"TextEncoder",
	"URL",
	"URLSearchParams",
] as const;

// Object-valued resolutions require stable prototypes through settlement.
export const HOST_OBJECT_RESULTS: {
	readonly fetch: HostResultContract;
	readonly statics: Partial<
		Record<HostObjectKind, ReadonlyMap<string, HostResultContract>>
	>;
	readonly methods: Record<HostObjectKind, ReadonlyMap<string, HostResultContract>>;
	readonly properties: Partial<
		Record<HostObjectKind, ReadonlyMap<string, HostResultContract>>
	>;
} = {
	fetch: { kind: "fulfill", value: { mask: OBJECT, hostObject: "Response" } },
	statics: {
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
		AbortController: exportsWithContracts([returned(UNDEFINED), "abort"]),
		AbortSignal: exportsWithContracts([returned(UNDEFINED), "throwIfAborted"]),
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
		StatementSync: exportsWithContracts(
			[returned(OBJECT, "Array"), "all"],
			[returned(OBJECT | UNDEFINED), "get"],
			[returned(OBJECT), "run"],
			[returned(UNDEFINED), "setReturnArrays", "setReadBigInts"],
		),
		TextDecoder: exportsWithContracts([returned(STRING), "decode"]),
		TextEncoder: exportsWithContracts(
			[returned(OBJECT, "Uint8Array"), "encode"],
			[returned(OBJECT), "encodeInto"],
		),
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
		FormDataIterator: exportsWithContracts([returned(OBJECT), "next"]),
		HeadersIterator: exportsWithContracts([returned(OBJECT), "next"]),
	},
	properties: {
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
		TextDecoder: exportsWithContracts(
			[returned(STRING), "encoding"],
			[returned(BOOLEAN), "fatal", "ignoreBOM"],
		),
		TextEncoder: exportsWithContracts([returned(STRING), "encoding"]),
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
	},
} as const;
