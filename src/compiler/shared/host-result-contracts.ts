import {
	COMPILER_VALUE_KIND_BOOLEAN as BOOLEAN,
	COMPILER_VALUE_KIND_NULL as NULL,
	COMPILER_VALUE_KIND_NUMBER as NUMBER,
	COMPILER_VALUE_KIND_OBJECT as OBJECT,
	COMPILER_VALUE_KIND_STRING as STRING,
	COMPILER_VALUE_KIND_UNDEFINED as UNDEFINED,
} from "./compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "./compiler-value-kinds.ts";

export interface HostValueContract {
	readonly mask: CompilerValueKindMask;
	readonly brand?: "Array" | "Uint8Array";
	readonly webInstance?: WebFetchInstance;
	readonly selector?: {
		readonly argument: number;
		readonly kind: "encoding" | "buffer-encoding" | "text-flag";
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
	kind: "return" | "fulfill",
	selector: NonNullable<HostValueContract["selector"]>,
): HostResultContract => ({ kind, value: { mask: STRING | OBJECT, selector } });
const callback: HostResultContract = {
	kind: "callback",
	reason: "The asynchronous operation reports completion to a Node-style callback.",
};

function exportsWithContracts(
	...groups: ReadonlyArray<readonly [HostResultContract, ...Array<string>]>
): ReadonlyMap<string, HostResultContract> {
	return new Map(
		groups.flatMap(([contract, ...names]) =>
			names.map((name) => [name, contract] as const),
		),
	);
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
	[returned(STRING | UNDEFINED), "mkdirSync"],
	[returned(OBJECT | UNDEFINED), "fstatSync", "lstatSync", "statSync"],
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
	[fulfilled(OBJECT), "open", "opendir", "statfs"],
	[fulfilled(OBJECT | UNDEFINED), "lstat", "stat"],
	[fulfilled(OBJECT, "Array"), "readdir"],
	[fulfilled(STRING | UNDEFINED), "mkdir"],
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
	[
		returned(STRING),
		"domainToASCII",
		"domainToUnicode",
		"fileURLToPath",
		"format",
		"resolve",
	],
	[
		returned(OBJECT),
		"URL",
		"URLSearchParams",
		"Url",
		"parse",
		"pathToFileURL",
		"urlToHttpOptions",
	],
	[
		{ kind: "dynamic", reason: "An absent base returns the second argument unchanged." },
		"resolveObject",
	],
);

const util = exportsWithContracts(
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
		"TextDecoder",
		"TextEncoder",
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
	[returned(OBJECT, "Uint8Array"), "Buffer", "SlowBuffer", "transcode"],
	[returned(OBJECT), "Blob", "File"],
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

export const HOST_RESULT_CONTRACTS: ReadonlyMap<
	string,
	ReadonlyMap<string, HostResultContract>
> = new Map([
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

export type WebFetchInstance =
	| "Blob"
	| "File"
	| "FormData"
	| "Headers"
	| "Request"
	| "Response"
	| "FormDataIterator"
	| "HeadersIterator";

const body = exportsWithContracts(
	[resolved(STRING), "text"],
	[resolved(OBJECT), "arrayBuffer", "bytes"],
	[{ kind: "resolve", value: { mask: OBJECT, webInstance: "Blob" } }, "blob"],
	[{ kind: "resolve", value: { mask: OBJECT, webInstance: "FormData" } }, "formData"],
	[
		{
			kind: "resolve",
			value: { mask: NUMBER | STRING | BOOLEAN | OBJECT | NULL },
			reason: "The body can contain any valid JSON value.",
		},
		"json",
	],
);

function webInstance(instance: WebFetchInstance): HostResultContract {
	return { kind: "return", value: { mask: OBJECT, webInstance: instance } };
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

export const WEB_FETCH_CONSTRUCTORS = [
	"Response",
	"Request",
	"Blob",
	"File",
	"FormData",
	"Headers",
] as const;

// These identities are attached to the fetch installer. Object-valued
// resolutions require stable prototypes through settlement.
export const WEB_FETCH_RESULTS: {
	readonly fetch: HostResultContract;
	readonly statics: Partial<
		Record<WebFetchInstance, ReadonlyMap<string, HostResultContract>>
	>;
	readonly methods: Record<WebFetchInstance, ReadonlyMap<string, HostResultContract>>;
	readonly properties: Partial<
		Record<WebFetchInstance, ReadonlyMap<string, HostResultContract>>
	>;
} = {
	fetch: { kind: "fulfill", value: { mask: OBJECT, webInstance: "Response" } },
	statics: {
		Response: exportsWithContracts([
			webInstance("Response"),
			"error",
			"json",
			"redirect",
		]),
	},
	methods: {
		Blob: blob,
		File: blob,
		FormData: exportsWithContracts(
			[returned(UNDEFINED), "append", "delete", "set", "forEach"],
			[returned(BOOLEAN), "has"],
			[returned(STRING | OBJECT | NULL), "get"],
			[returned(OBJECT, "Array"), "getAll"],
			[webInstance("FormDataIterator"), "entries", "keys", "values", "[Symbol.iterator]"],
		),
		Headers: exportsWithContracts(
			[returned(UNDEFINED), "append", "delete", "set", "forEach"],
			[returned(BOOLEAN), "has"],
			[returned(STRING | NULL), "get"],
			[returned(OBJECT, "Array"), "getSetCookie"],
			[webInstance("HeadersIterator"), "entries", "keys", "values", "[Symbol.iterator]"],
		),
		Request: new Map([...body, ["clone", webInstance("Request")]]),
		Response: body,
		FormDataIterator: exportsWithContracts([returned(OBJECT), "next"]),
		HeadersIterator: exportsWithContracts([returned(OBJECT), "next"]),
	},
	properties: {
		Blob: blobProperties,
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
	},
} as const;
