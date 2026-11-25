import {
	COMPILER_VALUE_KIND_NUMBER as NUMBER,
	COMPILER_VALUE_KIND_OBJECT as OBJECT,
	COMPILER_VALUE_KIND_STRING as STRING,
	COMPILER_VALUE_KIND_SYMBOL as SYMBOL,
	COMPILER_VALUE_KIND_TOP as TOP,
	COMPILER_VALUE_KIND_UNDEFINED as UNDEFINED,
} from "./compiler-value-kinds.ts";
import type { EffectDomain, EffectSummary } from "./effect-summary.ts";

export type HostInvocationReturn = "primitive" | "fresh" | "receiver" | number;

export interface HostInvocationBody {
	readonly effects: EffectSummary;
	readonly allocatesOnSuccess: boolean;
	readonly returns?: HostInvocationReturn;
	readonly mutates?: ReadonlyArray<"receiver" | number>;
	readonly retains?: ReadonlyArray<"receiver" | number>;
}

export type HostInvocationContract =
	| {
			readonly body: HostInvocationBody;
			readonly form?: "construct" | "getter";
			readonly requires?: "primitive-arguments" | ReadonlyArray<number>;
			readonly lockedPrimordials?: true;
			readonly otherwise?: string;
	  }
	| { readonly unavailable: string };

type Groups = ReadonlyArray<readonly [HostInvocationContract, ...Array<string>]>;

function calls(...groups: Groups): ReadonlyMap<string, HostInvocationContract> {
	return new Map(
		groups.flatMap(([contract, ...names]) =>
			names.map((name) => [name, contract] as const),
		),
	);
}

function body(
	reads: ReadonlyArray<EffectDomain>,
	writes: ReadonlyArray<EffectDomain>,
	allocatesOnSuccess: boolean,
	mayThrow: boolean,
	returns?: HostInvocationReturn,
	mutates?: ReadonlyArray<"receiver" | number>,
): HostInvocationBody {
	return {
		effects: {
			reads,
			writes,
			mayThrow,
			mayGc: allocatesOnSuccess || mayThrow,
			maySuspend: false,
			callsUserCode: false,
		},
		allocatesOnSuccess,
		returns,
		mutates,
	};
}

const tagProbe = { body: body([], [], false, false, "primitive") };
const byteLength = { body: body(["array-element"], [], false, true, "primitive") };
const scalarHostRead = { body: body(["host"], [], false, false, "primitive") };
const stringHostRead = { body: body(["host"], [], true, true, "primitive") };
const byteRead = {
	body: body(["array-element"], [], false, true, "primitive"),
	requires: "primitive-arguments",
	otherwise: "Invalid offsets and widths can describe supplied objects.",
} as const;
const byteWrite = {
	body: body(["array-element"], ["array-element"], false, true, "primitive", [
		"receiver",
	]),
	requires: "primitive-arguments",
	otherwise: "Conversion or invalid-input reporting can execute application code.",
} as const;
const nativeString = {
	body: body(["host"], ["host"], true, true, "primitive"),
	requires: "primitive-arguments",
	otherwise: "The error path describes a non-string argument.",
} as const;
const hostPrimitiveMutation = {
	body: body(["host"], ["host"], false, true, "primitive"),
	requires: "primitive-arguments",
	otherwise: "Input validation can describe the supplied object.",
} as const;
const freshFixedData = { body: body([], [], true, true, "fresh") };
const freshHostData = { body: body(["host"], [], true, true, "fresh") };
const timerCancellation = {
	body: body(["host"], ["host"], false, false, "primitive"),
	requires: [NUMBER | UNDEFINED],
	otherwise:
		"Timer handles and numeric coercion may involve property lookup and conversion.",
};
const pathHostAccess = {
	...nativeString,
	body: body(["host"], ["host"], true, true, "primitive"),
};
const fsPathRead = {
	body: body(["host", "io"], [], true, true, "primitive"),
	requires: [STRING, UNDEFINED],
	otherwise:
		"A PathLike object or option dictionary can execute getters and conversions.",
};
const freshEntries = {
	body: body(["object-property"], [], true, true, "fresh"),
	lockedPrimordials: true,
	otherwise: "Installing an index can encounter an inherited property descriptor.",
} as const;
const encodesInto = {
	body: body(["array-element"], ["array-element"], true, true, "fresh", [1]),
	requires: [STRING, OBJECT],
	lockedPrimordials: true,
	otherwise:
		"Input conversion can invoke JavaScript and inherited descriptors can block result writes.",
} as const;
const readsStringKey = {
	body: body(["object-property"], [], true, true, "primitive"),
	requires: [STRING],
	otherwise: "Converts the key to a string.",
} as const;
const mutatesStringKey = {
	...readsStringKey,
	body: body(["object-property"], ["object-property"], true, true, "primitive", [
		"receiver",
	]),
};
const storesStringPair = {
	body: { ...mutatesStringKey.body, retains: [0, 1] },
	requires: [STRING, STRING],
	otherwise: "Converts both name and value to strings.",
};
const iteratesEntries = {
	unavailable: "Invokes an application callback with the current entries and receiver.",
} as const;
const liveIterator = {
	body: { ...body(["object-property"], [], true, true, "fresh"), retains: ["receiver"] },
} as const;

const utilProbes = [
	"isArray",
	"isBoolean",
	"isBuffer",
	"isFunction",
	"isNull",
	"isNullOrUndefined",
	"isNumber",
	"isObject",
	"isString",
	"isSymbol",
	"isUndefined",
];
const utilTypesCProbes = [
	"isAnyArrayBuffer",
	"isArgumentsObject",
	"isArrayBuffer",
	"isBigInt64Array",
	"isBigIntObject",
	"isBigUint64Array",
	"isBooleanObject",
	"isBoxedPrimitive",
	"isDataView",
	"isDate",
	"isExternal",
	"isFloat16Array",
	"isFloat32Array",
	"isFloat64Array",
	"isGeneratorObject",
	"isInt8Array",
	"isInt16Array",
	"isInt32Array",
	"isMap",
	"isMapIterator",
	"isModuleNamespaceObject",
	"isNumberObject",
	"isPromise",
	"isProxy",
	"isRegExp",
	"isSet",
	"isSetIterator",
	"isSharedArrayBuffer",
	"isStringObject",
	"isSymbolObject",
	"isTypedArray",
	"isUint8Array",
	"isUint8ClampedArray",
	"isUint16Array",
	"isUint32Array",
	"isWeakMap",
	"isWeakSet",
	"isArrayBufferView",
];
const util = calls(
	[tagProbe, ...utilProbes],
	[freshFixedData, "debug", "debuglog", "getCallSites", "getSystemErrorMap"],
	[nativeString, "toUSVString"],
	[
		{
			body: body([], [], true, true, "primitive"),
			requires: [NUMBER],
			otherwise: "Invalid errno values can enter argument error formatting.",
		},
		"getSystemErrorName",
		"getSystemErrorMessage",
	],
	[
		{
			body: body(["host", "object-property"], ["host"], true, true, "fresh"),
			requires: [STRING],
			otherwise: "Only a string can supply environment file text.",
		},
		"parseEnv",
	],
	[
		{
			body: tagProbe.body,
			requires: [TOP & ~OBJECT, TOP & ~OBJECT],
			otherwise:
				"Recursive comparison can inspect application properties and collection entries.",
		},
		"isDeepStrictEqual",
	],
	[
		{
			unavailable: "Reads mutable inspect.defaultOptions and may call inspection hooks.",
		},
		"format",
		"formatWithOptions",
		"inspect",
		"convertProcessSignalToExitCode",
	],
);
const utilTypes = calls(
	[
		tagProbe,
		...utilTypesCProbes,
		"isAsyncFunction",
		"isGeneratorFunction",
		"isNativeError",
	],
	[
		{
			body: body(["host", "object-property"], [], false, false, "primitive"),
		},
		"isCryptoKey",
	],
	[
		{
			body: body(
				["host", "object-property", "array-element"],
				[],
				false,
				false,
				"primitive",
			),
		},
		"isKeyObject",
	],
);
const path = calls(
	[
		nativeString,
		"isAbsolute",
		"normalize",
		"dirname",
		"basename",
		"extname",
		"matchesGlob",
		"join",
	],
	[pathHostAccess, "relative", "resolve"],
	[{ ...nativeString, body: body(["host"], ["host"], true, true, "fresh") }, "parse"],
	[
		{ unavailable: "Reads input record properties and may coerce a supplied component." },
		"format",
	],
	[
		{
			unavailable:
				"POSIX and Windows implementations have different argument and identity behavior.",
		},
		"toNamespacedPath",
	],
);
const process = calls(
	[
		scalarHostRead,
		"getegid",
		"geteuid",
		"getgid",
		"getuid",
		"uptime",
		"availableMemory",
		"constrainedMemory",
	],
	[stringHostRead, "cwd"],
	[{ body: body(["host"], ["host"], true, true, "primitive") }, "umask"],
	[
		{ ...freshEntries, body: body(["host"], [], true, true, "fresh") },
		"getActiveResourcesInfo",
		"getgroups",
	],
	[
		{
			body: body(["host"], [], true, true, "fresh"),
			requires: [UNDEFINED],
			otherwise: "A prior usage object can supply getters for the counter deltas.",
		},
		"cpuUsage",
		"threadCpuUsage",
	],
	[{ body: body(["host"], [], true, true, "fresh") }, "memoryUsage", "resourceUsage"],
	[
		{
			unavailable:
				"The event emitter invokes application listeners and keeps registered callbacks.",
		},
		"on",
		"addListener",
		"once",
		"prependListener",
		"prependOnceListener",
		"emit",
	],
	[
		{ unavailable: "Schedules and retains a callback together with its arguments." },
		"nextTick",
	],
);
const os = calls(
	[freshHostData, "userInfo"],
	[scalarHostRead, "availableParallelism", "freemem", "totalmem", "uptime"],
	[
		stringHostRead,
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
		{ ...freshEntries, body: body(["host"], [], true, true, "fresh") },
		"cpus",
		"loadavg",
		"networkInterfaces",
	],
	[
		{ ...hostPrimitiveMutation, body: body(["host"], [], false, true, "primitive") },
		"getPriority",
	],
	[hostPrimitiveMutation, "setPriority"],
);
const fs = calls(
	[
		{ ...fsPathRead, body: body(["host", "io"], [], false, true, "primitive") },
		"existsSync",
		"accessSync",
	],
	[fsPathRead, "readlinkSync", "realpathSync"],
	[
		{
			...fsPathRead,
			body: body(["host", "io"], [], true, true, "fresh"),
			lockedPrimordials: true,
			otherwise:
				"Options can run getters and indexed result writes can encounter inherited descriptors.",
		},
		"readdirSync",
	],
	[
		{
			unavailable:
				"Options, URL accessors and Buffer views select different reads and backing storage.",
		},
		"readSync",
		"readvSync",
		"fstatSync",
	],
	[
		{
			body: body(["host", "io"], ["host"], true, true, "primitive"),
			requires: [STRING, STRING],
			otherwise:
				"The overload reads option properties, consumes descriptor position or can lazily install Buffer.",
		},
		"readFileSync",
	],
	[
		{ ...fsPathRead, body: body(["host", "io"], [], true, true, "fresh") },
		"statSync",
		"lstatSync",
	],
	[
		{
			unavailable:
				"Path and option conversions, filesystem mutations and view reads depend on the overload.",
		},
		"writeFileSync",
		"writeSync",
		"writevSync",
		"appendFileSync",
		"cpSync",
		"copyFileSync",
		"renameSync",
	],
);
const fsPromises = calls(
	[
		{
			body: body(["host", "io"], ["host"], true, true, "fresh"),
			requires: [STRING, NUMBER | UNDEFINED],
			otherwise:
				"Path and mode conversion depend on the supplied path-like and numeric objects.",
		},
		"access",
	],
	[
		{
			body: body(["host", "io"], ["host", "io"], true, true, "fresh"),
			requires: [STRING],
			otherwise: "Path-like conversion can run getters.",
		},
		"unlink",
	],
	[
		{
			body: body(["host", "io"], ["host", "io"], true, true, "fresh"),
			requires: [STRING, STRING],
			otherwise: "Both path-like inputs may execute getters.",
		},
		"rename",
	],
	[
		{
			unavailable:
				"Enqueues the original arguments for deferred filesystem work. That work can read path and option properties.",
		},
		"chmod",
		"link",
		"lstat",
		"mkdir",
		"mkdtemp",
		"mkdtempDisposable",
		"opendir",
		"readFile",
		"readdir",
		"readlink",
		"realpath",
		"rmdir",
		"stat",
		"symlink",
		"utimes",
	],
	[
		{
			unavailable:
				"The job copies path and data before submission. Overloads select path conversion, options, descriptor state and mutable backing storage.",
		},
		"appendFile",
		"writeFile",
		"open",
	],
	[
		{
			unavailable:
				"Paths and options select descriptor/metadata operations and can invoke property access or conversions.",
		},
		"chown",
		"copyFile",
		"lchown",
		"lutimes",
		"rm",
		"statfs",
		"truncate",
	],
	[
		{
			unavailable:
				"Reads option properties, including callback filters or cancellation, over asynchronous filesystem work.",
		},
		"cp",
		"glob",
		"watch",
	],
);
const zlib = calls(
	[
		{
			body: body([], [], true, true, "primitive"),
			requires: [STRING, NUMBER | UNDEFINED],
			otherwise:
				"The alternate byte-source overload reads backing storage and invalid inputs can be described.",
		},
		"crc32",
	],
	[
		{
			body: body(["host"], ["host", "global-property"], true, true, "fresh"),
			requires: [STRING, UNDEFINED],
			otherwise:
				"Byte-source overloads borrow backing storage. Options can run getters and construct a returned transform.",
		},
		"brotliCompressSync",
		"brotliDecompressSync",
		"deflateRawSync",
		"deflateSync",
		"gunzipSync",
		"gzipSync",
		"inflateRawSync",
		"inflateSync",
		"unzipSync",
	],
);
const http = calls(
	[{ body: body(["host"], ["host"], true, false, "primitive") }, "isValidHeaderName"],
	[nativeString, "validateHeaderName"],
	[
		{
			body: body(["host"], ["host"], true, true, "primitive"),
			requires: [TOP & ~OBJECT, UNDEFINED],
			otherwise: "Converts the value and reads the optional validation dictionary.",
		},
		"isValidHeaderValue",
	],
	[
		{
			unavailable:
				"Header value conversion can invoke application-defined string conversion.",
		},
		"validateHeaderValue",
	],
);
const net = calls(
	[nativeString, "isIP", "isIPv4", "isIPv6"],
	[
		scalarHostRead,
		"getDefaultAutoSelectFamily",
		"getDefaultAutoSelectFamilyAttemptTimeout",
	],
	[
		hostPrimitiveMutation,
		"setDefaultAutoSelectFamily",
		"setDefaultAutoSelectFamilyAttemptTimeout",
	],
);
const crypto = calls(
	[{ body: body(["array-element"], [], false, true, "primitive") }, "timingSafeEqual"],
	[freshFixedData, "getHashes", "getCurves", "getCiphers"],
	[{ body: body(["host"], ["host"], true, true, "fresh") }, "createHash"],
	[
		{
			body: body(["host"], ["host"], true, true, "fresh"),
			requires: [STRING, STRING],
			otherwise:
				"Key objects and BufferSource values select a different backing-store path.",
		},
		"createHmac",
	],
	[
		{
			body: body(["host"], ["host"], true, true, "primitive"),
			requires: [UNDEFINED],
			otherwise: "Reads disableEntropyCache from the options argument.",
		},
		"randomUUID",
	],
	[{ body: body(["host"], ["host"], true, true, "primitive") }, "randomUUIDv7"],
	[
		{
			body: body(["host"], ["host"], true, true, "primitive"),
			requires: [STRING, STRING, UNDEFINED],
			otherwise:
				"The options and byte-source overloads select getter and backing-store paths.",
		},
		"hash",
	],
	[
		{
			body: body(
				["array-element", "host"],
				["array-element", "host"],
				false,
				true,
				0,
				[0],
			),
		},
		"getRandomValues",
	],
	[
		{
			body: body(["host"], ["host", "global-property"], true, true, "fresh"),
			requires: [NUMBER, UNDEFINED],
			otherwise: "The callback overload posts a completion and retains the callback.",
		},
		"randomBytes",
	],
	[
		{
			body: body(["host"], ["host"], false, true, "primitive"),
			requires: [NUMBER, NUMBER | UNDEFINED, UNDEFINED],
			otherwise: "The callback overload posts a completion and retains the callback.",
		},
		"randomInt",
	],
	[
		{
			unavailable:
				"The options dictionary and byte-source overloads determine the reads and user-code calls.",
		},
		"createCipheriv",
		"createDecipheriv",
	],
);

const modules = new Map<string, ReadonlyMap<string, HostInvocationContract>>([
	[
		"mal_host_install_maligator_application",
		calls([{ body: body(["host"], ["host"], true, false, "primitive") }, "ready"]),
	],
	[
		"mal_host_install_maligator_internal_fetch",
		calls([
			{
				unavailable:
					"Converts the request and may stream application-provided body data.",
			},
			"fetch",
		]),
	],
	[
		"mal_host_install_maligator_internal_workers",
		calls(
			[freshHostData, "capabilities"],
			[
				{
					unavailable:
						"Launch and serialization read option or transfer list properties and may retain message handlers.",
				},
				"Worker",
				"createWorkerUrl",
				"receiveMessageOnPort",
			],
		),
	],
	["mal_host_install_node_util", util],
	["mal_host_install_node_sys", util],
	["mal_host_install_node_util_types", utilTypes],
	["mal_host_install_node_path", path],
	["mal_host_install_node_path_posix", path],
	["mal_host_install_node_path_win32", path],
	["mal_host_install_process", process],
	["mal_host_install_node_os", os],
	["mal_host_install_node_net", net],
	["mal_host_install_node_http", http],
	["mal_host_install_node_http_without_websocket", http],
	["mal_host_install_node_http_server", http],
	["mal_host_install_node_crypto", crypto],
	["mal_host_install_node_crypto_digests", crypto],
	[
		"mal_host_install_node_stream",
		calls(
			[
				{
					...tagProbe,
					requires: [TOP & ~OBJECT],
					otherwise: "Probes object stream flags through arbitrary property access.",
				},
				"isReadable",
				"isWritable",
				"isDestroyed",
				"isErrored",
				"isDisturbed",
			],
			[
				{ body: body(["object-property", "host"], [], false, false, "primitive") },
				"getDefaultHighWaterMark",
			],
			[
				{
					body: body(
						["object-property", "host"],
						["object-property", "host"],
						false,
						true,
						"primitive",
					),
					requires: [TOP, NUMBER],
					otherwise: "Invalid high-water marks can enter argument error formatting.",
				},
				"setDefaultHighWaterMark",
			],
		),
	],
	[
		"mal_host_install_node_vm",
		calls([
			{
				unavailable:
					"The rejected-object path can read values while constructing a diagnostic.",
			},
			"isContext",
		]),
	],
	[
		"mal_host_install_node_v8",
		calls(
			[
				{
					body: body(["host"], ["host"], true, false, "primitive"),
					requires: [STRING],
					otherwise: "A non-string input can enter the validation error path.",
				},
				"isStringOneByteRepresentation",
			],
			[tagProbe, "cachedDataVersionTag"],
			[freshHostData, "getHeapStatistics", "getHeapSpaceStatistics"],
			[freshFixedData, "getHeapCodeStatistics"],
			[tagProbe, "stopCoverage", "takeCoverage"],
			[
				{ body: body(["host"], ["host", "global-property"], true, true, "primitive") },
				"setFlagsFromString",
			],
			[
				{
					body: body([], [], false, true, "primitive"),
					requires: [NUMBER],
					otherwise: "Invalid limits can run argument formatting.",
				},
				"setHeapSnapshotNearHeapLimit",
			],
		),
	],
	[
		"mal_host_install_node_async_hooks",
		calls(
			[scalarHostRead, "executionAsyncId", "triggerAsyncId"],
			[{ body: body(["host"], [], false, false) }, "executionAsyncResource"],
		),
	],
	[
		"mal_host_install_node_tty",
		calls([{ body: body(["host", "io"], [], false, false, "primitive") }, "isatty"]),
	],
	[
		"mal_host_install_node_worker_threads",
		calls([scalarHostRead, "isMarkedAsUntransferable"]),
	],
	[
		"mal_host_install_node_diagnostics_channel",
		calls([
			{
				...scalarHostRead,
				requires: [STRING | SYMBOL],
				otherwise: "Invalid channel names enter argument error formatting.",
			},
			"hasSubscribers",
		]),
	],
	["mal_host_install_node_fs", fs],
	["mal_host_install_node_fs_named", fs],
	["mal_host_install_node_fs_read_file", fs],
	["mal_host_install_node_fs_read_stream", fs],
	["mal_host_install_node_fs_promises", fsPromises],
	["mal_host_install_node_zlib", zlib],
	["mal_host_install_node_zlib_decoders", zlib],
	[
		"mal_host_install_node_punycode",
		calls([nativeString, "decode", "encode", "toASCII", "toUnicode"]),
	],
	[
		"mal_host_install_node_tls",
		calls([freshFixedData, "getCertificateCompressionAlgorithms", "getCiphers"]),
	],
	[
		"mal_host_install_node_module",
		calls([{ body: body(["host"], ["host"], true, false, "primitive") }, "isBuiltin"]),
	],
	[
		"mal_host_install_node_buffer",
		calls(
			[nativeString, "atob", "btoa"],
			[nativeString, "resolveObjectURL"],
			[{ unavailable: "Invalid input type reporting can run accessors." }, "transcode"],
			[
				{
					unavailable:
						"Detached views and invalid inputs take separate paths, including argument error formatting.",
				},
				"isAscii",
				"isUtf8",
			],
		),
	],
	[
		"mal_host_install_maligator_internal_fs",
		calls(
			[
				{
					body: body([], [], true, true, "primitive"),
					requires: [STRING],
					otherwise: "Only a valid string enters the media-type lookup.",
				},
				"mediaType",
			],
			[
				{
					body: body(["host", "io"], ["host"], true, true, "fresh"),
					requires: [STRING],
					otherwise:
						"Invalid arguments or a pattern list require separate path and property proofs.",
				},
				"read",
				"exists",
				"stat",
				"realpath",
				"readlink",
			],
			[
				{
					body: body(["host", "io"], ["host", "io"], true, true, "fresh"),
					requires: [STRING, STRING],
					otherwise:
						"A byte source is copied from backing storage before submitting the job.",
				},
				"write",
			],
			[
				{ body: body(["host", "io"], ["host", "io"], true, true, "fresh") },
				"chmod",
				"createDirectory",
				"remove",
				"removeDirectory",
				"temporaryDirectory",
				"symlink",
				"copy",
				"move",
			],
			[
				{
					unavailable:
						"Reads the include and exclude arrays with ordinary property lookup.",
				},
				"list",
			],
		),
	],
	[
		"mal_host_install_maligator_internal_fs_descriptor",
		calls(
			[
				{ body: body(["host", "io"], ["host", "io"], true, true, "fresh") },
				"openDescriptor",
			],
			[
				{
					body: { ...body(["host", "io"], ["host"], true, true, "fresh"), retains: [1] },
				},
				"readChunk",
			],
			[
				{
					body: {
						...body(["host", "io", "array-element"], ["host", "io"], true, true, "fresh"),
						retains: [1],
					},
				},
				"writeChunk",
				"flushDescriptor",
			],
			[
				{
					body: {
						...body(["host", "io"], ["host", "io"], true, true, undefined, [1]),
						retains: [1],
					},
				},
				"closeDescriptor",
			],
		),
	],
	[
		"mal_host_install_maligator_internal_fs_stream",
		calls([
			{
				unavailable:
					"Creates a stream tied to read state, and the stream owns the underlying source callbacks.",
			},
			"readableStream",
		]),
	],
	[
		"mal_host_install_maligator_internal_fs_watch",
		calls([
			{
				unavailable:
					"Watcher setup retains the callback while the filesystem watcher is registered.",
			},
			"openWatch",
			"closeWatch",
		]),
	],
	[
		"mal_host_install_maligator_internal_http",
		calls([
			{
				unavailable:
					"Launch options and asset handles control request dispatch and streaming.",
			},
			"listen",
			"assetProxy",
			"assetResponse",
		]),
	],
	[
		"mal_host_install_node_timers",
		calls(
			[
				{
					unavailable:
						"Converts the delay and retains the callback and additional arguments for delivery.",
				},
				"setTimeout",
				"setInterval",
				"setImmediate",
			],
			[timerCancellation, "clearTimeout", "clearInterval", "clearImmediate"],
		),
	],
	[
		"mal_host_install_node_timers_promises",
		calls([
			{
				unavailable:
					"Converts the delay, observes cancellation options and retains the fulfillment value.",
			},
			"setTimeout",
			"setImmediate",
			"setInterval",
		]),
	],
]);

export function hostModuleInvocation(
	installer: string,
	name: string,
): HostInvocationContract | undefined {
	return modules.get(installer)?.get(name);
}

const byteAccessNames = [
	"UInt8",
	"Uint8",
	"Int8",
	"UInt16LE",
	"UInt16BE",
	"Uint16LE",
	"Uint16BE",
	"Int16LE",
	"Int16BE",
	"UInt32LE",
	"UInt32BE",
	"Uint32LE",
	"Uint32BE",
	"Int32LE",
	"Int32BE",
	"UIntLE",
	"UIntBE",
	"UintLE",
	"UintBE",
	"IntLE",
	"IntBE",
	"FloatLE",
	"FloatBE",
	"DoubleLE",
	"DoubleBE",
	"BigUInt64LE",
	"BigUInt64BE",
	"BigUint64LE",
	"BigUint64BE",
	"BigInt64LE",
	"BigInt64BE",
];
const bufferMethods = calls(
	[
		byteRead,
		...byteAccessNames
			.filter((name) => !name.startsWith("Big"))
			.map((name) => `read${name}`),
	],
	[
		{ ...byteRead, body: body(["array-element"], [], true, true, "primitive") },
		...byteAccessNames
			.filter((name) => name.startsWith("Big"))
			.map((name) => `read${name}`),
	],
	[byteWrite, ...byteAccessNames.map((name) => `write${name}`)],
	[
		{
			body: body(["array-element"], ["array-element"], true, true, "receiver", [
				"receiver",
			]),
			requires: "primitive-arguments",
			otherwise: "Fill can inspect an encoding or a byte-source object.",
		},
		"fill",
	],
	[
		{
			body: body(["array-element"], [], true, true),
			requires: "primitive-arguments",
			otherwise:
				"Bounds conversion may invoke JavaScript; the wrapper shares backing storage.",
		},
		"slice",
		"subarray",
	],
);
const bufferStatics = calls(
	[tagProbe, "isBuffer", "isEncoding"],
	[byteLength, "byteLength"],
	[
		{
			body: body([], [], true, true, "fresh"),
			requires: [NUMBER, UNDEFINED, UNDEFINED],
			otherwise:
				"The initialized overload can read a byte source and convert an encoding.",
		},
		"alloc",
	],
);
const objectMethods = new Map<string, ReadonlyMap<string, HostInvocationContract>>([
	["Performance", calls([scalarHostRead, "now"])],
	[
		"Crypto",
		calls(
			[{ body: body(["host"], ["host"], true, true, "primitive") }, "randomUUID"],
			[
				{
					body: body(
						["array-element", "host"],
						["array-element", "host"],
						false,
						true,
						0,
						[0],
					),
				},
				"getRandomValues",
			],
		),
	],
	...(["Hash", "Hmac"] as const).map(
		(kind) =>
			[
				kind,
				calls(
					[
						{
							body: body(
								["host", "object-property"],
								["host", "object-property"],
								true,
								true,
								"receiver",
								["receiver"],
							),
							requires: [STRING, STRING | UNDEFINED],
							otherwise:
								"Alternate inputs borrow view backing storage and must validate the encoding.",
						},
						"update",
					],
					[
						{
							unavailable:
								"Finalizes the digest state, and the output encoding selects a string or newly published Buffer.",
						},
						"digest",
					],
				),
			] as const,
	),
	["Buffer", bufferMethods],
	[
		"Headers",
		calls(
			[freshEntries, "getSetCookie"],
			[readsStringKey, "get", "has"],
			[mutatesStringKey, "delete"],
			[storesStringPair, "append", "set"],
			[liveIterator, "entries", "keys", "values", "[Symbol.iterator]"],
			[iteratesEntries, "forEach"],
		),
	],
	[
		"URLSearchParams",
		calls(
			[
				{
					...freshEntries,
					requires: [STRING],
					otherwise: "Converts the key and installs indexed results.",
				},
				"getAll",
			],
			[readsStringKey, "get"],
			[
				{
					...readsStringKey,
					requires: [STRING, STRING | UNDEFINED],
					otherwise: "Converts the name and optional value to strings.",
				},
				"has",
			],
			[
				{
					...mutatesStringKey,
					requires: [STRING, STRING | UNDEFINED],
					otherwise: "Converts the name and optional value to strings.",
				},
				"delete",
			],
			[storesStringPair, "append", "set"],
			[{ body: mutatesStringKey.body }, "sort"],
			[{ body: readsStringKey.body }, "toString"],
			[liveIterator, "entries", "keys", "values", "[Symbol.iterator]"],
			[iteratesEntries, "forEach"],
		),
	],
	[
		"FormData",
		calls(
			[
				{
					body: body(["object-property"], [], true, true, "fresh"),
					requires: [STRING],
					otherwise:
						"Name coercion can invoke JavaScript; returned files may alias existing entries.",
				},
				"getAll",
			],
			[readsStringKey, "has"],
			[{ ...readsStringKey, body: body(["object-property"], [], true, true) }, "get"],
			[mutatesStringKey, "delete"],
			[
				{
					unavailable:
						"Converts the name, value or filename and may keep a Blob argument.",
				},
				"append",
				"set",
			],
			[liveIterator, "entries", "keys", "values", "[Symbol.iterator]"],
			[iteratesEntries, "forEach"],
		),
	],
	[
		"TextEncoder",
		calls(
			[encodesInto, "encodeInto"],
			[
				{
					body: body([], [], true, true, "fresh"),
					requires: [STRING | UNDEFINED],
					otherwise: "Converts a supplied object to a string.",
				},
				"encode",
			],
		),
	],
]);

const deferredCallback: HostInvocationContract = {
	body: { ...body([], ["host"], true, true, "primitive"), retains: [0] },
};
const globalInvocations = calls(
	[deferredCallback, "queueMicrotask"],
	[nativeString, "atob", "btoa"],
	[timerCancellation, "clearTimeout", "clearInterval", "clearImmediate"],
	[
		{
			unavailable:
				"Converts the delay and keeps the callback and arguments until delivery.",
		},
		"setTimeout",
		"setInterval",
		"setImmediate",
	],
	[
		{
			unavailable:
				"Runtime diagnostics read or change global allocation, GC or profiling state.",
		},
		"__mal_collect_garbage",
		"__mal_fail_next_cell_allocation",
		"__mal_reset_perf_stats",
		"__mal_gc_live_bytes",
		"__mal_gc_allocated_bytes",
		"__mal_gc_collections",
	],
	[
		{
			unavailable:
				"Serialization reads application properties, and transfer options can detach storage.",
		},
		"structuredClone",
	],
	[
		{
			unavailable:
				"Request dictionaries, byte sources, and cancellation signals determine conversion, retention and I/O.",
		},
		"fetch",
	],
);
const fixedConstructor = {
	body: body(["object-property"], [], true, true, "fresh"),
	form: "construct",
	lockedPrimordials: true,
	otherwise: "Prototype selection reads newTarget.prototype.",
} as const;
const constructInvocations = calls([fixedConstructor, "TextEncoder", "AbortController"]);
const scalarGetter = {
	body: body(["object-property"], [], false, true, "primitive"),
	form: "getter",
} as const;
const allocatingGetter = {
	...scalarGetter,
	body: body(["object-property"], [], true, true, "primitive"),
};
const getterInvocations = new Map([
	["Blob", calls([scalarGetter, "size"], [allocatingGetter, "type"])],
	[
		"File",
		calls([scalarGetter, "size", "lastModified"], [allocatingGetter, "type", "name"]),
	],
	[
		"Response",
		calls(
			[scalarGetter, "status", "ok"],
			[allocatingGetter, "statusText", "type", "url"],
		),
	],
	[
		"URL",
		calls([
			allocatingGetter,
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
		]),
	],
	["URLSearchParams", calls([scalarGetter, "size"])],
]);

export function hostGlobalInvocation(name: string): HostInvocationContract | undefined {
	return globalInvocations.get(name);
}

export function hostConstructorInvocation(
	name: string,
): HostInvocationContract | undefined {
	return constructInvocations.get(name);
}

export function hostGetterInvocation(
	brand: string,
	name: string,
): HostInvocationContract | undefined {
	return getterInvocations.get(brand)?.get(name);
}

export function hostMemberInvocation(
	brand: string,
	name: string,
	staticMethod: boolean,
): HostInvocationContract | undefined {
	return staticMethod
		? brand === "Buffer"
			? bufferStatics.get(name)
			: undefined
		: objectMethods.get(brand)?.get(name);
}

const invocationNames = new Set([
	...Array.from(modules.values()).flatMap((exports) =>
		[...exports].flatMap(([name, contract]) => ("body" in contract ? [name] : [])),
	),
	...Array.from(objectMethods.values()).flatMap((members) => [...members.keys()]),
	...bufferStatics.keys(),
	...globalInvocations.keys(),
	...constructInvocations.keys(),
]);

export function hostInvocationName(name: string): boolean {
	return invocationNames.has(name);
}

const getterNames = new Set(
	Array.from(getterInvocations.values()).flatMap((members) => [...members.keys()]),
);

export function hostGetterInvocationName(name: string): boolean {
	return getterNames.has(name);
}
