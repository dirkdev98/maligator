import type { CompilerNumericTypedArrayKind } from "./compiler-instruction.ts";
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
	COMPILER_VALUE_KIND_UNREGISTERED_SYMBOL as UNREGISTERED_SYMBOL,
} from "./compiler-value-kinds.ts";
import type { CompilerValueKindMask } from "./compiler-value-kinds.ts";
import type { HostInvocationContract } from "./host-invocation-contracts.ts";
import {
	COMPILER_INT32_RANGE,
	COMPILER_UINT32_RANGE,
	compilerIntegerRange,
} from "./integer-range.ts";
import type { CompilerIntegerRange } from "./integer-range.ts";

export interface HostValueContract {
	readonly mask: CompilerValueKindMask;
	readonly integerRange?: CompilerIntegerRange;
	readonly numericRangeUnavailable?: string;
	readonly brand?: "Array" | CompilerNumericTypedArrayKind;
	readonly initialContents?: HostInitialContents;
	readonly contentsUnavailable?: string;
	readonly hostObject?: HostObjectKind;
	readonly installedObject?: true;
	readonly hostConstructor?: HostObjectKind;
	readonly assetHandle?: "file" | "directory";
	readonly platformCallable?: "testEach";
	readonly platformObject?:
		| "file"
		| "directory"
		| "writer"
		| "watcher"
		| "fileStat"
		| "assertion"
		| "pendingAssertion"
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
			| "fstat-options"
			| "directory-entries"
			| "dns-lookup"
			| "dns-resolve"
			| "dns-ttl"
			| "maligator-directory-list"
			| "temporary-directory"
			| "mkdir-options"
			| "compression-info"
			| "exec-output"
			| "exec-file-output"
			| "exec-fulfillment"
			| "exec-file-fulfillment"
			| "buffer-signed-width"
			| "buffer-unsigned-width"
			| "buffer-write-width"
			| "random-int"
			| "resolve-value";
	};
}

export type HostContentValue = Pick<
	HostValueContract,
	"mask" | "brand" | "integerRange" | "hostObject"
> & {
	readonly fields?: Readonly<Record<string, HostContentValue>>;
	readonly argument?: number;
};

export type HostInitialContents =
	| {
			readonly kind: "dense-array";
			readonly element: HostContentValue;
			readonly length?: number;
	  }
	| {
			readonly kind: "record";
			readonly fields: Readonly<Record<string, HostContentValue>>;
	  };

export type HostInputBrand =
	| CompilerNumericTypedArrayKind
	| "Array"
	| "Map"
	| "Set"
	| "WeakMap"
	| "WeakSet";

export interface HostInputFact {
	readonly argument: number | "receiver" | "all" | "last";
	readonly mask: CompilerValueKindMask;
	readonly brand?: HostInputBrand;
}

export interface HostInputContract {
	readonly onTrue?: ReadonlyArray<HostInputFact>;
	readonly onFalse?: ReadonlyArray<HostInputFact>;
	readonly onReturn?: ReadonlyArray<HostInputFact>;
	readonly onFulfill?: ReadonlyArray<HostInputFact>;
	readonly unavailable?: string;
}

export type HostResultContract = (
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
			readonly testContextArguments?: ReadonlyArray<number>;
	  }
	| { readonly kind: "callback"; readonly reason: string }
	| { readonly kind: "never"; readonly reason: string }
	| { readonly kind: "dynamic"; readonly reason: string }
) & {
	readonly inputs?: HostInputContract;
	readonly invocation?: HostInvocationContract;
};

const returned = (
	mask: CompilerValueKindMask,
	brand?: HostValueContract["brand"],
): HostResultContract => ({ kind: "return", value: { mask, brand } });

function denseArray(
	element: HostContentValue,
	length?: number,
	kind: "return" | "fulfill" = "return",
): HostResultContract {
	return {
		kind,
		value: {
			mask: OBJECT,
			brand: "Array",
			initialContents: { kind: "dense-array", element, length },
		},
	};
}

const dynamicArrayContents = (reason: string): HostResultContract => ({
	kind: "return",
	value: { mask: OBJECT, brand: "Array", contentsUnavailable: reason },
});

const dynamicRecordContents = (reason: string): HostResultContract => ({
	kind: "return",
	value: { mask: OBJECT, contentsUnavailable: reason },
});

function ownRecord(
	fields: Readonly<Record<string, HostContentValue>>,
	kind: "return" | "fulfill" = "return",
	hostObject?: HostObjectKind,
): HostResultContract {
	return {
		kind,
		value: { mask: OBJECT, hostObject, initialContents: { kind: "record", fields } },
	};
}

const stringField = { mask: STRING };
const numberField = { mask: NUMBER };
const ownIteratorResult = (
	value: HostContentValue,
	kind: "return" | "fulfill" = "return",
): HostResultContract => ownRecord({ done: { mask: BOOLEAN }, value }, kind);
const strings = denseArray(stringField);
const objects = denseArray({ mask: OBJECT });
const arbitraryElements = denseArray({ mask: TOP });
const eventNames = denseArray({ mask: STRING | SYMBOL });
const performanceEntries = denseArray({ mask: OBJECT, hostObject: "PerformanceEntry" });
const observedPerformanceEntries = denseArray({
	mask: OBJECT,
	hostObject: "ObservedPerformanceEntry",
});
export const nodeDirectoryEntryContent: HostContentValue = {
	mask: OBJECT,
	hostObject: "Dirent",
	fields: { name: stringField, parentPath: stringField },
};
export const diskDirectoryEntryContent: HostContentValue = {
	mask: OBJECT,
	fields: {
		path: stringField,
		type: { ...numberField, integerRange: COMPILER_INT32_RANGE },
	},
};
const numberFields = (
	...names: Array<string>
): Readonly<Record<string, HostContentValue>> =>
	Object.fromEntries(names.map((name) => [name, numberField]));
const cpuUsageRecord = ownRecord({ user: numberField, system: numberField });
const eventLoopUtilizationRecord = ownRecord(
	numberFields("idle", "active", "utilization"),
	"return",
	"EventLoopUtilization",
);
const fulfilled = (
	mask: CompilerValueKindMask,
	brand?: HostValueContract["brand"],
): HostResultContract => ({ kind: "fulfill", value: { mask, brand } });
const selected = (
	kind: "return" | "fulfill" | "resolve",
	selector: NonNullable<HostValueContract["selector"]>,
	mask = STRING | OBJECT,
): HostResultContract => ({ kind, value: { mask, selector } });
const integerResult = (
	range: CompilerIntegerRange,
	kind: "return" | "fulfill" = "return",
	mask: CompilerValueKindMask = NUMBER,
): HostResultContract => ({ kind, value: { mask, integerRange: range } });
const numericResult = (
	reason: string,
	mask: CompilerValueKindMask = NUMBER,
): HostResultContract => ({
	kind: "return",
	value: { mask, numericRangeUnavailable: reason },
});
const int32 = integerResult(COMPILER_INT32_RANGE);
const uint32 = integerResult(COMPILER_UINT32_RANGE);
const nonnegativeInt32 = integerResult(compilerIntegerRange(0, 0x7fff_ffff));
const byteCount = compilerIntegerRange(0, 3 * 0x7fff_ffff);

function bufferWidth(
	kind: "buffer-signed-width" | "buffer-unsigned-width" | "buffer-write-width",
	range: CompilerIntegerRange,
): HostResultContract {
	return {
		kind: "return",
		value: {
			mask: NUMBER,
			integerRange: range,
			selector: { kind, argument: kind === "buffer-write-width" ? 2 : 1 },
		},
	};
}

const callback: HostResultContract = {
	kind: "callback",
	reason: "The asynchronous operation reports completion to a Node-style callback.",
};
const dynamic = (reason: string): HostResultContract => ({ kind: "dynamic", reason });
const neverReturns = (reason: string): HostResultContract => ({ kind: "never", reason });

function exportsWithContracts(
	...groups: ReadonlyArray<readonly [HostResultContract, ...Array<string>]>
): Map<string, HostResultContract> {
	return new Map(
		groups.flatMap(([contract, ...names]) =>
			names.map((name) => [name, contract] as const),
		),
	);
}

const input = (
	argument: HostInputFact["argument"],
	mask: number,
	brand?: HostInputBrand,
): HostInputFact => ({ argument, mask, brand });
const validates = (...onReturn: ReadonlyArray<HostInputFact>): HostInputContract => ({
	onReturn,
});
const validatesBeforeFulfillment = (
	...onFulfill: ReadonlyArray<HostInputFact>
): HostInputContract => ({ onFulfill });
const predicate = (
	mask: number,
	complementary = false,
	brand?: HostInputBrand,
): HostInputContract => ({
	onTrue: [input(0, mask, brand)],
	...(complementary ? { onFalse: [input(0, TOP & ~mask)] } : {}),
});
const noInputFact = (unavailable: string): HostInputContract => ({ unavailable });
const stringInput = validates(input(0, STRING));
const objectInput = validates(input(0, OBJECT));
const numberInput = validates(input(0, NUMBER));
const stringPair = validates(input(0, STRING), input(1, STRING));
const bufferPredicate = predicate(OBJECT, false, "Uint8Array");
const bufferReceiver = input("receiver", OBJECT, "Uint8Array");
const bufferFixedRead = validates(bufferReceiver, input(0, NUMBER | UNDEFINED));
const bufferVariableRead = validates(bufferReceiver, input(0, NUMBER), input(1, NUMBER));
const bufferFixedWrite = validates(bufferReceiver, input(1, NUMBER | UNDEFINED));
const bufferVariableWrite = validates(bufferReceiver, input(1, NUMBER), input(2, NUMBER));

const builtinInputs = new Map<string, HostInputContract>([
	["Array.isArray", predicate(OBJECT)],
	["ArrayBuffer.isView", predicate(OBJECT)],
	["Error.isError", predicate(OBJECT)],
	["JSON.isRawJSON", predicate(OBJECT)],
	["Object.prototype.isPrototypeOf", predicate(OBJECT)],
	[
		"Atomics.isLockFree",
		noInputFact("Converts the byte size using ToIntegerOrInfinity."),
	],
	[
		"String.prototype.isWellFormed",
		validates(input("receiver", TOP & ~(NULL | UNDEFINED))),
	],
	["Number.prototype.valueOf", validates(input("receiver", NUMBER | OBJECT))],
	["Boolean.prototype.valueOf", validates(input("receiver", BOOLEAN | OBJECT))],
	["Boolean.prototype.toString", validates(input("receiver", BOOLEAN | OBJECT))],
	["String.prototype.valueOf", validates(input("receiver", STRING | OBJECT))],
	["String.prototype.toString", validates(input("receiver", STRING | OBJECT))],
	["RegExp.prototype.exec", validates(input("receiver", OBJECT))],
	["RegExp.prototype.test", validates(input("receiver", OBJECT))],
	...["toFixed", "toExponential", "toPrecision"].map(
		(name) =>
			[
				`Number.prototype.${name}`,
				validates(input("receiver", NUMBER | OBJECT)),
			] as const,
	),
	...[
		"charCodeAt",
		"slice",
		"substring",
		"substr",
		"trim",
		"trimStart",
		"trimEnd",
		"trimLeft",
		"trimRight",
		"split",
	].map(
		(name) =>
			[
				`String.prototype.${name}`,
				validates(input("receiver", TOP & ~(NULL | UNDEFINED))),
			] as const,
	),
	...[
		"Int8",
		"Uint8",
		"Int16",
		"Uint16",
		"Int32",
		"Uint32",
		"Float16",
		"Float32",
		"Float64",
		"BigInt64",
		"BigUint64",
	].flatMap((type) =>
		["get", "set"].map(
			(action) =>
				[
					`DataView.prototype.${action}${type}`,
					validates(input("receiver", OBJECT)),
				] as const,
		),
	),
	...["Map", "Set", "WeakMap", "WeakSet"].flatMap((kind) =>
		(kind === "Map" || kind === "WeakMap"
			? ["get", "set", "has", "delete"]
			: ["add", "has", "delete"]
		).map(
			(name) =>
				[
					`${kind}.prototype.${name}`,
					validates(input("receiver", OBJECT, kind as HostInputBrand)),
				] as const,
		),
	),
	[
		"Map.prototype.forEach",
		validates(input("receiver", OBJECT, "Map"), input(0, OBJECT)),
	],
	[
		"Set.prototype.forEach",
		validates(input("receiver", OBJECT, "Set"), input(0, OBJECT)),
	],
	...[
		"isDisjointFrom",
		"isSubsetOf",
		"isSupersetOf",
		"difference",
		"intersection",
		"symmetricDifference",
		"union",
	].map(
		(name) =>
			[
				`Set.prototype.${name}`,
				validates(input("receiver", OBJECT, "Set"), input(0, OBJECT)),
			] as const,
	),
	...[
		"every",
		"some",
		"forEach",
		"find",
		"findIndex",
		"findLast",
		"findLastIndex",
		"map",
		"filter",
		"reduce",
		"reduceRight",
	].map(
		(name) =>
			[
				`TypedArray.prototype.${name}`,
				validates(input("receiver", OBJECT), input(0, OBJECT)),
			] as const,
	),
	["Number.isFinite", predicate(NUMBER)],
	["Number.isInteger", predicate(NUMBER)],
	["Number.isNaN", predicate(NUMBER)],
	["Number.isSafeInteger", predicate(NUMBER)],
	["Object.isExtensible", predicate(OBJECT)],
	["Object.isFrozen", { onFalse: [input(0, OBJECT)] }],
	["Object.isSealed", { onFalse: [input(0, OBJECT)] }],
	[
		"Object.setPrototypeOf",
		validates(input(0, TOP & ~(NULL | UNDEFINED)), input(1, OBJECT | NULL)),
	],
	["Object.defineProperty", validates(input(0, OBJECT), input(2, OBJECT))],
	["Object.defineProperties", objectInput],
	["Object.create", validates(input(0, OBJECT | NULL))],
	["Object.getOwnPropertyDescriptor", validates(input(0, TOP & ~(NULL | UNDEFINED)))],
	["Object.getOwnPropertyDescriptors", validates(input(0, TOP & ~(NULL | UNDEFINED)))],
	["Object.getPrototypeOf", validates(input(0, TOP & ~(NULL | UNDEFINED)))],
	["Object.getOwnPropertyNames", validates(input(0, TOP & ~(NULL | UNDEFINED)))],
	["Object.getOwnPropertySymbols", validates(input(0, TOP & ~(NULL | UNDEFINED)))],
	["Object.keys", validates(input(0, TOP & ~(NULL | UNDEFINED)))],
	["Object.values", validates(input(0, TOP & ~(NULL | UNDEFINED)))],
	["Object.entries", validates(input(0, TOP & ~(NULL | UNDEFINED)))],
	["Object.hasOwn", validates(input(0, TOP & ~(NULL | UNDEFINED)))],
	["Reflect.defineProperty", validates(input(0, OBJECT), input(2, OBJECT))],
	["Reflect.setPrototypeOf", validates(input(0, OBJECT), input(1, OBJECT | NULL))],
	...[
		"apply",
		"construct",
		"deleteProperty",
		"get",
		"getOwnPropertyDescriptor",
		"getPrototypeOf",
		"has",
		"isExtensible",
		"ownKeys",
		"preventExtensions",
		"set",
	].map((name) => [`Reflect.${name}`, objectInput] as const),
]);

const constructionInputs = new Map<string, HostInputContract>([
	...[
		"DataView",
		"Promise",
		"FinalizationRegistry",
		"ByteLengthQueuingStrategy",
		"CountQueuingStrategy",
		"ReadableStreamDefaultReader",
		"ReadableStreamBYOBReader",
		"WritableStreamDefaultWriter",
	].map((name) => [name, objectInput] as const),
	["WeakRef", validates(input(0, OBJECT | UNREGISTERED_SYMBOL))],
	["Proxy", validates(input(0, OBJECT), input(1, OBJECT))],
	[
		"ReadableStream",
		validates(input(0, OBJECT | UNDEFINED), input(1, OBJECT | NULL | UNDEFINED)),
	],
	["WritableStream", validates(input(1, OBJECT | NULL | UNDEFINED))],
	["TransformStream", validates(input(0, OBJECT | NULL | UNDEFINED))],
	["URL", noInputFact("Converts the URL and base arguments to strings.")],
	[
		"TextDecoder",
		noInputFact("Converts the label to a string and ignores non-object options."),
	],
	[
		"DatabaseSync",
		noInputFact("Converts the path to a string and ignores non-object options."),
	],
]);

export function builtinInputContract(
	operation: string,
	construct = false,
): HostInputContract | undefined {
	return construct
		? constructionInputs.get(operation.replace(/^globalThis\./, ""))
		: builtinInputs.get(operation);
}

const hostInputMemberNames = new Set<string>();

export function hostHasInputContractMember(name: string): boolean {
	return hostInputMemberNames.has(name);
}

function withInputs(
	results: Map<string, HostResultContract>,
	...groups: ReadonlyArray<readonly [HostInputContract, ...Array<string>]>
): ReadonlyMap<string, HostResultContract> {
	for (const [inputs, ...names] of groups)
		for (const name of names) {
			const result = results.get(name);
			if (result === undefined)
				throw new Error(`Missing result contract for input facts of ${name}`);
			results.set(name, { ...result, inputs });
			if (inputs.unavailable === undefined) hostInputMemberNames.add(name);
		}
	return results;
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

function installedObject(hostObject: HostObjectKind, mask = OBJECT): HostResultContract {
	return { kind: "return", value: { mask, hostObject, installedObject: true } };
}

function streamConstructor(hostConstructor: HostObjectKind): HostResultContract {
	return { kind: "return", value: { mask: OBJECT | UNDEFINED, hostConstructor } };
}

const fs = exportsWithContracts(
	[nativeConstructor("Stats"), "Stats"],
	[nativeConstructor("ConstructedDirent"), "Dirent"],
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
	[nonnegativeInt32, "openSync"],
	[uint32, "readSync"],
	[integerResult(byteCount), "writeSync"],
	[
		numericResult("Native vectored I/O sums byte counts without a safe-integer limit."),
		"readvSync",
		"writevSync",
	],
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
	[selected("return", { kind: "fstat-options", argument: 1 }, OBJECT), "fstatSync"],
	[
		selected("return", { kind: "directory-entries", argument: 1 }, OBJECT),
		"readdirSync",
		"globSync",
	],
	[hostObject("FilesystemStats"), "statfsSync"],
	[
		selected("return", { kind: "temporary-directory", argument: 1 }, OBJECT),
		"mkdtempDisposableSync",
	],
	[hostObject("FsWatcher", undefined, OBJECT | UNDEFINED), "watch"],
	[hostObject("FsStatWatcher", undefined, OBJECT | UNDEFINED), "watchFile"],
	[nativeConstructor("NodeFsReadStream"), "ReadStream", "FileReadStream"],
	[nativeConstructor("NodeFsWriteStream"), "WriteStream", "FileWriteStream"],
	[hostObject("NodeFsReadStream"), "createReadStream"],
	[hostObject("NodeFsWriteStream"), "createWriteStream"],
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
withInputs(
	fs,
	[validates(input(0, NUMBER), input(1, OBJECT)), "readSync", "readvSync", "writevSync"],
	[validates(input(0, NUMBER), input(1, STRING | OBJECT)), "writeSync"],
	[validates(input(0, NUMBER), input(1, NUMBER | UNDEFINED)), "ftruncateSync"],
	[
		numberInput,
		"closeSync",
		"fstatSync",
		"fsyncSync",
		"fdatasyncSync",
		"fchmodSync",
		"fchownSync",
		"futimesSync",
	],
	[
		validates(input(0, NUMBER | STRING | OBJECT)),
		"readFileSync",
		"writeFileSync",
		"appendFileSync",
	],
	[
		validates(input(0, NUMBER | STRING | OBJECT), input(1, NUMBER | UNDEFINED)),
		"truncateSync",
	],
	[
		validates(input(0, STRING | OBJECT)),
		"accessSync",
		"chmodSync",
		"chownSync",
		"lchownSync",
		"lstatSync",
		"statSync",
		"mkdirSync",
		"openSync",
		"opendirSync",
		"readdirSync",
		"readlinkSync",
		"realpathSync",
		"rmSync",
		"rmdirSync",
		"unlinkSync",
		"utimesSync",
		"lutimesSync",
		"statfsSync",
	],
	[
		validates(input(0, STRING | OBJECT), input(1, STRING | OBJECT)),
		"copyFileSync",
		"cpSync",
		"linkSync",
		"renameSync",
		"symlinkSync",
	],
	[
		noInputFact("Invalid path types can return false without an exception."),
		"existsSync",
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
	[fulfilledHostObject("FilesystemStats"), "statfs"],
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
	[selected("fulfill", { kind: "directory-entries", argument: 1 }, OBJECT), "readdir"],
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
	[hostObject("FsGlobIterator"), "glob"],
	[hostObject("FsWatchIterator", undefined, OBJECT | UNDEFINED), "watch"],
	[
		selected("fulfill", { kind: "temporary-directory", argument: 1 }, OBJECT),
		"mkdtempDisposable",
	],
);

withInputs(
	fsPromises,
	[
		validatesBeforeFulfillment(input(0, STRING | OBJECT)),
		"access",
		"chmod",
		"chown",
		"lchown",
		"lutimes",
		"open",
		"opendir",
		"stat",
		"lstat",
		"statfs",
		"readdir",
		"mkdir",
		"readlink",
		"realpath",
		"rmdir",
		"rm",
		"unlink",
		"utimes",
	],
	[
		validatesBeforeFulfillment(input(0, STRING | NUMBER | OBJECT)),
		"readFile",
		"writeFile",
		"appendFile",
	],
	[
		validatesBeforeFulfillment(
			input(0, NUMBER | STRING | OBJECT),
			input(1, NUMBER | UNDEFINED),
		),
		"truncate",
	],
	[
		validatesBeforeFulfillment(input(0, STRING | OBJECT), input(1, STRING | OBJECT)),
		"copyFile",
		"cp",
		"link",
		"rename",
		"symlink",
	],
);

const maligatorFs = exportsWithContracts(
	[returned(STRING), "mediaType"],
	[selected("fulfill", { kind: "text-flag", argument: 1 }), "read"],
	[fulfilled(BOOLEAN), "exists"],
	[integerResult(byteCount, "fulfill"), "write"],
	[fulfilledHostObject("MaligatorStat"), "stat"],
	[
		selected("fulfill", { kind: "maligator-directory-list", argument: 2 }, OBJECT),
		"list",
	],
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
withInputs(
	maligatorFs,
	[
		stringInput,
		"mediaType",
		"exists",
		"stat",
		"read",
		"remove",
		"chmod",
		"realpath",
		"readlink",
		"createDirectory",
		"removeDirectory",
	],
	[validates(input(0, STRING | UNDEFINED)), "temporaryDirectory"],
	[stringPair, "copy", "move", "symlink"],
	[validates(input(0, STRING), input(1, STRING | OBJECT)), "write"],
	[
		validates(
			input(0, STRING),
			input(4, OBJECT | UNDEFINED),
			input(5, OBJECT | UNDEFINED),
		),
		"list",
	],
);

export const NODE_FILE_HANDLE_RESULTS = {
	properties: exportsWithContracts([
		integerResult(compilerIntegerRange(-1, 0x7fff_ffff)),
		"fd",
	]),
	methods: exportsWithContracts(
		[selected("fulfill", { kind: "encoding", argument: 0 }), "readFile"],
		[
			ownRecord(
				{
					bytesRead: { ...numberField, integerRange: COMPILER_UINT32_RANGE },
					buffer: { mask: TOP, argument: 0 },
				},
				"fulfill",
				"FileHandleRead",
			),
			"read",
		],
		[
			ownRecord(
				{
					bytesWritten: { ...numberField, integerRange: byteCount },
					buffer: { mask: TOP, argument: 0 },
				},
				"fulfill",
				"FileHandleWrite",
			),
			"write",
		],
		[selected("fulfill", { kind: "fstat-options", argument: 0 }, OBJECT), "stat"],
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
		"join",
		"normalize",
		"relative",
		"resolve",
	],
	[returned(BOOLEAN), "isAbsolute", "matchesGlob"],
	[
		ownRecord({
			root: stringField,
			dir: stringField,
			base: stringField,
			ext: stringField,
			name: stringField,
		}),
		"parse",
	],
	[
		dynamic(
			"Can return the supplied base property unchanged when the directory is empty.",
		),
		"format",
	],
	[
		{ kind: "dynamic", reason: "Returns non-string inputs unchanged." },
		"toNamespacedPath",
	],
);
withInputs(
	path,
	[stringInput, "dirname", "extname", "isAbsolute", "normalize", "parse"],
	[validates(input(0, STRING), input(1, STRING | UNDEFINED)), "basename"],
	[stringPair, "relative", "matchesGlob"],
	[validates(input("all", STRING)), "join"],
	[validates(input("last", STRING)), "resolve"],
	[objectInput, "format"],
	[
		noInputFact("POSIX and non-string Windows inputs pass through unchanged."),
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
	[integerResult(compilerIntegerRange(1, 0x7fff_ffff)), "availableParallelism"],
	[int32, "getPriority"],
	[
		numericResult("Native memory sizes may exceed JavaScript's safe-integer limit."),
		"freemem",
		"totalmem",
	],
	[numericResult("Elapsed seconds may be fractional."), "uptime"],
	[
		denseArray({
			mask: OBJECT,
			fields: {
				model: stringField,
				speed: { ...numberField, integerRange: compilerIntegerRange(0, 0) },
				times: {
					mask: OBJECT,
					fields: numberFields("user", "nice", "sys", "idle", "irq"),
				},
			},
		}),
		"cpus",
	],
	[denseArray(numberField, 3), "loadavg"],
	[
		dynamicRecordContents(
			"Own keys are host interface names. Their address lists vary by interface.",
		),
		"networkInterfaces",
	],
	[
		ownRecord({
			username: stringField,
			homedir: stringField,
			shell: stringField,
			uid: { ...numberField, integerRange: COMPILER_INT32_RANGE },
			gid: { ...numberField, integerRange: COMPILER_INT32_RANGE },
		}),
		"userInfo",
	],
	[returned(UNDEFINED), "setPriority"],
);

const fsDescriptor = exportsWithContracts(
	[fulfilled(OBJECT), "openDescriptor"],
	[fulfilled(OBJECT | UNDEFINED), "readChunk"],
	[integerResult(byteCount, "fulfill"), "writeChunk"],
	[fulfilled(UNDEFINED), "flushDescriptor"],
	[
		{ kind: "fulfill", value: { mask: UNDEFINED }, immediateMask: OBJECT | UNDEFINED },
		"closeDescriptor",
	],
);

const process = exportsWithContracts(
	[returned(STRING), "cwd"],
	[
		numericResult("Native memory sizes may exceed JavaScript's safe-integer limit."),
		"availableMemory",
	],
	[integerResult(compilerIntegerRange(0, 0)), "constrainedMemory"],
	[uint32, "getegid", "geteuid", "getgid", "getuid"],
	[
		numericResult(
			"Preserves the Number supplied to setMaxListeners, or the mutable default.",
		),
		"getMaxListeners",
	],
	[int32, "listenerCount", "umask"],
	[numericResult("Elapsed seconds may be fractional."), "uptime"],
	[returned(BOOLEAN), "emit", "hasUncaughtExceptionCaptureCallback", "kill"],
	[strings, "getActiveResourcesInfo"],
	[denseArray(numberField), "getgroups"],
	[denseArray(numberField, 2), "hrtime"],
	[eventNames, "eventNames"],
	[arbitraryElements, "listeners", "rawListeners"],
	[cpuUsageRecord, "cpuUsage", "threadCpuUsage"],
	[
		ownRecord(numberFields("rss", "heapTotal", "heapUsed", "external", "arrayBuffers")),
		"memoryUsage",
	],
	[
		ownRecord(
			numberFields(
				"userCPUTime",
				"systemCPUTime",
				"maxRSS",
				"sharedMemorySize",
				"unsharedDataSize",
				"unsharedStackSize",
				"minorPageFault",
				"majorPageFault",
				"swappedOut",
				"fsRead",
				"fsWrite",
				"ipcSent",
				"ipcReceived",
				"signalsCount",
				"voluntaryContextSwitches",
				"involuntaryContextSwitches",
			),
		),
		"resourceUsage",
	],
	[
		returned(OBJECT),
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
withInputs(
	process,
	[stringInput, "chdir", "getBuiltinModule"],
	[objectInput, "nextTick"],
	[validates(input(0, BOOLEAN)), "setSourceMapsEnabled"],
	[validates(input(0, NUMBER | STRING | UNDEFINED)), "umask"],
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
	[ownRecord({ path: stringField }), "urlToHttpOptions"],
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
	[int32, "convertProcessSignalToExitCode"],
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
	[
		denseArray({
			mask: OBJECT,
			brand: "Array",
			fields: {
				"0": { mask: NUMBER, integerRange: compilerIntegerRange(-1, 1) },
				"1": { mask: TOP },
			},
		}),
		"diff",
	],
	[denseArray({ mask: OBJECT }, 0), "getCallSites"],
	[
		ownRecord({
			values: { mask: OBJECT },
			positionals: { mask: OBJECT, brand: "Array" },
		}),
		"parseArgs",
	],
	[
		returned(OBJECT),
		"callbackify",
		"debounce",
		"debug",
		"debuglog",
		"deprecate",
		"getSystemErrorMap",
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
withInputs(
	util,
	[predicate(BOOLEAN, true), "isBoolean"],
	[predicate(NULL, true), "isNull"],
	[predicate(NULL | UNDEFINED, true), "isNullOrUndefined"],
	[predicate(NUMBER, true), "isNumber"],
	[predicate(STRING, true), "isString"],
	[predicate(SYMBOL, true), "isSymbol"],
	[predicate(UNDEFINED, true), "isUndefined"],
	[predicate(OBJECT), "isFunction", "isObject"],
	[predicate(OBJECT, false, "Array"), "isArray"],
	[bufferPredicate, "isBuffer"],
	[noInputFact("Both outcomes are possible for all operand kinds."), "isDeepStrictEqual"],
	[stringInput, "parseEnv", "stripVTControlCharacters", "convertProcessSignalToExitCode"],
	[numberInput, "getSystemErrorName", "getSystemErrorMessage"],
	[objectInput, "promisify", "callbackify"],
	[validates(input(0, OBJECT), input(1, OBJECT)), "inherits", "aborted"],
	[validates(input(0, OBJECT), input(1, NUMBER)), "debounce"],
	[validates(input(0, STRING | OBJECT), input(1, STRING)), "styleText"],
	[noInputFact("Converts arbitrary input to a well-formed string."), "toUSVString"],
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
withInputs(
	utilTypes,
	[predicate(OBJECT, false, "Int8Array"), "isInt8Array"],
	[predicate(OBJECT, false, "Uint8Array"), "isUint8Array"],
	[predicate(OBJECT, false, "Uint8ClampedArray"), "isUint8ClampedArray"],
	[predicate(OBJECT, false, "Int16Array"), "isInt16Array"],
	[predicate(OBJECT, false, "Uint16Array"), "isUint16Array"],
	[predicate(OBJECT, false, "Int32Array"), "isInt32Array"],
	[predicate(OBJECT, false, "Uint32Array"), "isUint32Array"],
	[predicate(OBJECT, false, "Float32Array"), "isFloat32Array"],
	[predicate(OBJECT, false, "Float64Array"), "isFloat64Array"],
	[predicate(OBJECT, false, "Map"), "isMap"],
	[predicate(OBJECT, false, "Set"), "isSet"],
	[predicate(OBJECT, false, "WeakMap"), "isWeakMap"],
	[predicate(OBJECT, false, "WeakSet"), "isWeakSet"],
	[
		predicate(OBJECT),
		"isArgumentsObject",
		"isNativeError",
		"isPromise",
		"isAnyArrayBuffer",
		"isArrayBuffer",
		"isSharedArrayBuffer",
		"isDataView",
		"isDate",
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
		"isKeyObject",
		"isCryptoKey",
		"isMapIterator",
		"isSetIterator",
		"isBigInt64Array",
		"isBigUint64Array",
	],
	[
		noInputFact("The runtime always returns false for this unsupported brand."),
		"isExternal",
		"isFloat16Array",
	],
);

const v8 = exportsWithContracts(
	[uint32, "cachedDataVersionTag"],
	[returned(BOOLEAN), "isStringOneByteRepresentation"],
	[
		ownRecord(
			numberFields(
				"total_heap_size",
				"total_heap_size_executable",
				"total_physical_size",
				"total_available_size",
				"used_heap_size",
				"heap_size_limit",
				"malloced_memory",
				"peak_malloced_memory",
				"does_zap_garbage",
				"number_of_native_contexts",
				"number_of_detached_contexts",
				"total_global_handles_size",
				"used_global_handles_size",
				"external_memory",
				"total_allocated_bytes",
			),
		),
		"getHeapStatistics",
	],
	[
		ownRecord(
			numberFields(
				"code_and_metadata_size",
				"bytecode_and_metadata_size",
				"external_script_source_size",
				"cpu_profiler_metadata_size",
			),
		),
		"getHeapCodeStatistics",
	],
	[
		denseArray(
			{
				mask: OBJECT,
				fields: {
					space_name: stringField,
					...numberFields(
						"space_size",
						"space_used_size",
						"space_available_size",
						"physical_space_size",
					),
				},
			},
			1,
		),
		"getHeapSpaceStatistics",
	],
	[
		returned(UNDEFINED),
		"setFlagsFromString",
		"setHeapSnapshotNearHeapLimit",
		"stopCoverage",
		"takeCoverage",
	],
);
withInputs(v8, [stringInput, "isStringOneByteRepresentation"]);

const perfHooks = exportsWithContracts(
	[nativeConstructor("PerformanceObserver"), "PerformanceObserver"],
	[installedObject("Performance"), "performance"],
	[hostObject("Histogram"), "createHistogram", "monitorEventLoopDelay"],
	[eventLoopUtilizationRecord, "eventLoopUtilization"],
	[returned(OBJECT), "timerify"],
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
	[
		dynamicRecordContents(
			"The input supplies keys and repeated keys become arrays of strings.",
		),
		"parse",
		"decode",
	],
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
withInputs(
	buffer,
	[validates(input(0, OBJECT, "Uint8Array")), "transcode"],
	[objectInput, "isAscii", "isUtf8"],
	[noInputFact("Converts the input to a string."), "resolveObjectURL"],
);

const maligatorWorkers = exportsWithContracts(
	[nativeConstructor("MaligatorWorker"), "Worker"],
	[nativeConstructor("MaligatorMessageChannel"), "MessageChannel"],
	[hostObject("WorkerCapabilities"), "capabilities"],
	[hostObject("WorkerUrl"), "createWorkerUrl"],
	[hostObject("WorkerMessage", undefined, OBJECT | UNDEFINED), "receiveMessageOnPort"],
	[installedObject("MaligatorMessagePort", OBJECT | NULL), "parentPort"],
	[installedObject("WorkerUrl", OBJECT | NULL), "poolEntry"],
	[
		dynamic("The isolate receives an application-supplied worker data value."),
		"workerData",
	],
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
withInputs(
	vm,
	[objectInput, "isContext"],
	[validates(input(0, STRING), input(1, OBJECT | UNDEFINED)), "compileFunction"],
);
const diagnostics = exportsWithContracts(
	[nativeConstructor("DiagnosticsChannel"), "Channel"],
	[hostObject("DiagnosticsChannel"), "channel"],
	[hostObject("TracingChannel"), "tracingChannel"],
	[returned(BOOLEAN), "hasSubscribers", "unsubscribe"],
	[returned(UNDEFINED), "subscribe"],
);
withInputs(
	diagnostics,
	[validates(input(0, STRING | SYMBOL)), "channel", "hasSubscribers", "unsubscribe"],
	[validates(input(0, STRING | SYMBOL), input(1, OBJECT)), "subscribe"],
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
	[
		numericResult("Async resource IDs are uncapped or supplied by the caller."),
		"executionAsyncId",
		"triggerAsyncId",
	],
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
	[strings, "_nodeModulePaths"],
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
withInputs(
	module,
	[predicate(STRING), "isBuiltin"],
	[stringInput, "_nodeModulePaths", "createRequire"],
	[validates(input(0, STRING | OBJECT), input(1, STRING | UNDEFINED)), "findPackageJSON"],
);

export const CAPTURED_HOST_RESULTS = exportsWithContracts(
	[hostObject("AnyKeyObject"), "%MAL_INTRINSIC_NODE_CRYPTO_MODULE%.KeyObject.from"],
	[strings, "%MAL_INTRINSIC_NODE_MODULE_API_MODULE%._nodeModulePaths"],
	[
		neverReturns("The runtime graph cannot resolve unprepared module requests."),
		"%MAL_INTRINSIC_NODE_MODULE_API_MODULE%._resolveFilename",
	],
	[returned(BIGINT), "globalThis.process.hrtime.bigint"],
	[
		numericResult("The host returns a byte count without a safe-integer limit."),
		"globalThis.process.memoryUsage.rss",
	],
	[ownRecord({ header: { mask: OBJECT } }), "globalThis.process.report.getReport"],
	[
		returned(BOOLEAN),
		"globalThis.process.stdout.write",
		"globalThis.process.stderr.write",
	],
	[
		integerResult(compilerIntegerRange(0, 0xffff), "return", NUMBER | UNDEFINED),
		"globalThis.process.stdout.columns<get>",
		"globalThis.process.stderr.columns<get>",
	],
	[
		numericResult(
			"The exit code may be unset or contain a caller-supplied Number.",
			NUMBER | UNDEFINED,
		),
		"globalThis.process.exitCode<get>",
	],
	[returned(BOOLEAN), "globalThis.process.sourceMapsEnabled<get>"],
	[returned(OBJECT), "%MAL_INTRINSIC_NODE_FS_MODULE%.promises<get>"],
	[strings, "%MAL_INTRINSIC_NODE_TLS_MODULE%.rootCertificates<get>"],
	[
		selected("return", { kind: "buffer-encoding", argument: 1 }),
		"%MAL_INTRINSIC_NODE_FS_MODULE%.realpathSync.native",
	],
	[callback, "%MAL_INTRINSIC_NODE_FS_MODULE%.realpath.native"],
	[returned(STRING), '%MAL_INTRINSIC_NODE_BUILTIN_MODULES%["node:punycode"].ucs2.encode'],
	[
		denseArray({ mask: NUMBER, integerRange: compilerIntegerRange(0, 0x10ffff) }),
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
withInputs(nodeWorkers, [predicate(OBJECT), "isMarkedAsUntransferable"]);

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
withInputs(
	assertions,
	[validates(input(0, STRING), input(1, OBJECT)), "match", "doesNotMatch"],
	[objectInput, "throws", "doesNotThrow"],
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
	[uint32, "crc32"],
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
withInputs(zlib, [
	validates(input(0, STRING | OBJECT), input(1, NUMBER | UNDEFINED)),
	"crc32",
]);
const dnsShared = [
	[strings, "getServers"],
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
const dnsUInt8 = { mask: NUMBER, integerRange: compilerIntegerRange(0, 0xff) };
const dnsUInt16 = { mask: NUMBER, integerRange: compilerIntegerRange(0, 0xffff) };
const dnsUInt32 = { mask: NUMBER, integerRange: COMPILER_UINT32_RANGE };
export const dnsAddressContent: HostContentValue = {
	mask: OBJECT,
	fields: {
		address: stringField,
		family: { mask: NUMBER, integerRange: compilerIntegerRange(4, 6) },
	},
};
export const dnsTtlAddressContent: HostContentValue = {
	mask: OBJECT,
	fields: {
		address: stringField,
		ttl: { mask: NUMBER, integerRange: compilerIntegerRange(0, 0) },
	},
};
const dnsStringResults = denseArray(stringField, undefined, "fulfill");
export const DNS_RESOLUTION_RESULTS: ReadonlyMap<string, HostResultContract> = new Map([
	["A", dnsStringResults],
	["AAAA", dnsStringResults],
	["NS", dnsStringResults],
	["CNAME", dnsStringResults],
	["PTR", dnsStringResults],
	[
		"MX",
		denseArray(
			{ mask: OBJECT, fields: { exchange: stringField, priority: dnsUInt16 } },
			undefined,
			"fulfill",
		),
	],
	[
		"SRV",
		denseArray(
			{
				mask: OBJECT,
				fields: {
					name: stringField,
					port: dnsUInt16,
					priority: dnsUInt16,
					weight: dnsUInt16,
				},
			},
			undefined,
			"fulfill",
		),
	],
	["TXT", denseArray({ mask: OBJECT, brand: "Array" }, undefined, "fulfill")],
	[
		"SOA",
		ownRecord(
			{
				nsname: stringField,
				hostmaster: stringField,
				serial: dnsUInt32,
				refresh: dnsUInt32,
				retry: dnsUInt32,
				expire: dnsUInt32,
				minttl: dnsUInt32,
			},
			"fulfill",
		),
	],
	[
		"NAPTR",
		denseArray(
			{
				mask: OBJECT,
				fields: {
					flags: stringField,
					service: stringField,
					regexp: stringField,
					replacement: stringField,
					order: dnsUInt16,
					preference: dnsUInt16,
				},
			},
			undefined,
			"fulfill",
		),
	],
	// The reply supplies the tag key and can overwrite critical or type.
	[
		"CAA",
		denseArray(
			{
				mask: OBJECT,
				fields: { critical: { mask: STRING | NUMBER }, type: stringField },
			},
			undefined,
			"fulfill",
		),
	],
	[
		"TLSA",
		denseArray(
			{
				mask: OBJECT,
				fields: {
					certUsage: dnsUInt8,
					selector: dnsUInt8,
					match: dnsUInt8,
					data: { mask: OBJECT },
				},
			},
			undefined,
			"fulfill",
		),
	],
]);
const dnsPromiseQueries = exportsWithContracts(
	[selected("fulfill", { kind: "dns-resolve", argument: 1 }, OBJECT), "resolve"],
	[selected("fulfill", { kind: "dns-ttl", argument: 1 }, OBJECT), "resolve4", "resolve6"],
	[fulfilled(0), "resolveAny"],
	[dnsStringResults, "reverse"],
);
for (const [type, contract] of DNS_RESOLUTION_RESULTS) {
	if (type === "A" || type === "AAAA") continue;
	dnsPromiseQueries.set(`resolve${type[0]}${type.slice(1).toLowerCase()}`, contract);
}
const dns = exportsWithContracts(
	...dnsShared,
	[nativeConstructor("DnsResolver"), "Resolver"],
	[returned(OBJECT), "lookup"],
	[callback, ...dnsQueries],
);
const dnsPromises = exportsWithContracts(
	...dnsShared,
	[nativeConstructor("DnsPromiseResolver"), "Resolver"],
	[selected("fulfill", { kind: "dns-lookup", argument: 1 }, OBJECT), "lookup"],
	[
		ownRecord({ hostname: stringField, service: stringField }, "fulfill"),
		"lookupService",
	],
);
for (const [name, contract] of dnsPromiseQueries) dnsPromises.set(name, contract);
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
withInputs(
	http,
	[predicate(STRING), "isValidHeaderName"],
	[stringInput, "validateHeaderName"],
	[
		{
			onTrue: [input(0, TOP & ~(SYMBOL | UNDEFINED))],
			onReturn: [input(1, OBJECT | UNDEFINED)],
		},
		"isValidHeaderValue",
	],
	[noInputFact("Converts the header value to a string."), "validateHeaderValue"],
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
	[strings, "getCACertificates", "getCiphers"],
	[denseArray(stringField, 0), "getCertificateCompressionAlgorithms"],
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
	[integerResult(compilerIntegerRange(0, 6)), "isIP"],
	[
		integerResult(compilerIntegerRange(10, 0x7fff_ffff)),
		"getDefaultAutoSelectFamilyAttemptTimeout",
	],
	[
		returned(UNDEFINED),
		"setDefaultAutoSelectFamily",
		"setDefaultAutoSelectFamilyAttemptTimeout",
	],
);
withInputs(net, [
	noInputFact("Converts the address to a string."),
	"isIP",
	"isIPv4",
	"isIPv6",
]);
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
	[strings, "getCiphers", "getCurves", "getHashes"],
	[returned(OBJECT | UNDEFINED), "getCipherInfo", "randomBytes"],
	[
		selected("return", { kind: "random-int", argument: 0 }, NUMBER | UNDEFINED),
		"randomInt",
	],
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
withInputs(
	crypto,
	[
		stringInput,
		"createHash",
		"createHmac",
		"createSign",
		"createVerify",
		"createCipheriv",
		"createDecipheriv",
	],
	[
		validates(input(0, STRING), input(1, STRING | OBJECT), input(2, STRING | UNDEFINED)),
		"hash",
	],
	[numberInput, "randomBytes", "randomInt"],
	[objectInput, "getRandomValues", "randomFillSync"],
	[validates(input(0, OBJECT), input(1, OBJECT)), "timingSafeEqual"],
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
	[
		numericResult("Reads mutable defaults that may contain arbitrary Numbers."),
		"getDefaultHighWaterMark",
	],
	[returned(UNDEFINED), "destroy", "setDefaultHighWaterMark"],
	[returned(OBJECT), "addAbortSignal", "compose", "finished", "pipeline"],
	[denseArray({ mask: OBJECT, hostObject: "NodeDuplex" }, 2), "duplexPair"],
);
withInputs(
	stream,
	[
		predicate(OBJECT),
		"isReadable",
		"isWritable",
		"isDestroyed",
		"isErrored",
		"isDisturbed",
	],
	[validates(input(1, NUMBER)), "setDefaultHighWaterMark"],
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
	[int32, "listenerCount"],
	[
		{
			kind: "resolve",
			value: {
				mask: OBJECT,
				brand: "Array",
				contentsUnavailable:
					"Emitted arguments are arbitrary JavaScript values and resolution observes then.",
			},
		},
		"once",
	],
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
withInputs(
	timers,
	[objectInput, "setTimeout", "setInterval", "setImmediate"],
	[
		noInputFact("Ignores values that do not identify a live timer."),
		"clearTimeout",
		"clearInterval",
		"clearImmediate",
	],
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
	["mal_host_install_node_http_server", http],
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
	["mal_host_install_node_crypto_digests", crypto],
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
	["mal_host_install_node_fs_read_stream", fs],
	["mal_host_install_node_fs_promises", fsPromises],
	["mal_host_install_maligator_internal_fs", maligatorFs],
	["mal_host_install_maligator_internal_fs_descriptor", fsDescriptor],
	[
		"mal_host_install_maligator_internal_fs_stream",
		exportsWithContracts([hostObject("ReadableStream"), "readableStream"]),
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
			[
				numericResult(
					"Native storage reports a byte count without a safe-integer limit.",
				),
				"size",
			],
		),
		methods: exportsWithContracts(
			[returned(OBJECT, "Uint8Array"), "bytes"],
			[returned(STRING), "text", "materialize"],
			[
				numericResult(
					"Parses JSON, whose numbers can be fractional or negative zero.",
					STRING | NUMBER | BOOLEAN | NULL | OBJECT,
				),
				"json",
			],
		),
	},
	directory: {
		properties: exportsWithContracts(),
		methods: exportsWithContracts(
			[objects, "files"],
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
withInputs(
	DISK_HANDLE_EXPORTS,
	[validates(input(0, STRING | OBJECT)), "file", "directory"],
	[noInputFact("The iterator validates the path on its first next() request."), "watch"],
);

export const NODE_TEST_EXPORT_TARGETS: ReadonlyMap<string, string> = new Map([
	["test", "registerTest"],
	["it", "registerTest"],
	["default", "registerTest"],
	["module.exports", "registerTest"],
	["describe", "registerSuite"],
	["suite", "registerSuite"],
]);

export const PLATFORM_SOURCE_EXPORTS = new Map([
	[
		"node:test",
		exportsWithContracts(
			[
				{ kind: "resolve", value: { mask: UNDEFINED }, testContextArguments: [0, 1, 2] },
				"registerTest",
			],
			[resolved(UNDEFINED), "registerSuite"],
			[returned(UNDEFINED), "before", "after", "beforeEach", "afterEach"],
		),
	],
	[
		"maligator:test",
		exportsWithContracts(
			[
				{ kind: "return", value: { mask: OBJECT, platformObject: "assertion" } },
				"expect",
			],
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
		withInputs(
			exportsWithContracts(
				[{ kind: "return", value: { mask: OBJECT, platformObject: "server" } }, "serve"],
				[returned(OBJECT), "serveAsset", "proxy"],
			),
			[objectInput, "serve"],
			[validates(input(1, OBJECT | UNDEFINED)), "serveAsset"],
			[noInputFact("The URL constructor converts the target to a string."), "proxy"],
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

export const TEST_MATCHER_NAMES = [
	"toBe",
	"toEqual",
	"toStrictEqual",
	"toBeDefined",
	"toBeUndefined",
	"toBeNull",
	"toBeTruthy",
	"toBeFalsy",
	"toContain",
	"toHaveLength",
	"toMatch",
	"toMatchObject",
	"toThrow",
] as const;

const nodeTestStatics = exportsWithContracts(
	[resolved(UNDEFINED), "skip", "todo"],
	[neverReturns("Exclusive test selection is unsupported."), "only"],
);
export const PLATFORM_SOURCE_STATICS = new Map([
	[
		"node:test",
		new Map([
			["registerTest", nodeTestStatics],
			["registerSuite", nodeTestStatics],
		]),
	],
	[
		"maligator:test",
		new Map([
			[
				"test",
				exportsWithContracts(
					[returned(UNDEFINED), "skip", "todo", "only"],
					[
						{ kind: "return", value: { mask: OBJECT, platformCallable: "testEach" } },
						"each",
					],
				),
			],
			["describe", exportsWithContracts([returned(UNDEFINED), "skip", "only"])],
			[
				"expect",
				exportsWithContracts([
					returned(OBJECT),
					"any",
					"anything",
					"stringMatching",
					"objectContaining",
					"arrayContaining",
				]),
			],
		]),
	],
]);

function testAssertionProperties(pending: boolean) {
	return exportsWithContracts(
		[
			{
				kind: "return",
				value: {
					mask: OBJECT,
					platformObject: pending ? "pendingAssertion" : "assertion",
				},
			},
			"not",
		],
		[
			{ kind: "return", value: { mask: OBJECT, platformObject: "pendingAssertion" } },
			"resolves",
			"rejects",
		],
	);
}

export const PLATFORM_OBJECT_RESULTS = {
	assertion: {
		properties: testAssertionProperties(false),
		methods: exportsWithContracts([returned(UNDEFINED), ...TEST_MATCHER_NAMES]),
	},
	pendingAssertion: {
		properties: testAssertionProperties(true),
		methods: exportsWithContracts([resolved(UNDEFINED), ...TEST_MATCHER_NAMES]),
	},
	fileStat: {
		properties: exportsWithContracts(
			[
				numericResult("The filesystem byte count may exceed the safe-integer limit."),
				"size",
			],
			[int32, "mode"],
			[returned(BOOLEAN), "isFile", "isDirectory", "isSymbolicLink"],
			[returned(OBJECT), "mtime"],
		),
		methods: exportsWithContracts(),
	},
	server: {
		properties: exportsWithContracts(
			[integerResult(compilerIntegerRange(0, 0xffff)), "port"],
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
		methods: withInputs(
			exportsWithContracts(
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
			[validates(input(0, STRING), input(1, OBJECT | UNDEFINED)), "run"],
		),
	},
	workerPoolStats: {
		properties: exportsWithContracts([
			numericResult(
				"Pool counters and configured sizes have no common safe-integer bound.",
			),
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
			[
				dynamicArrayContents(
					"The envelope retains the caller's array, including holes and later mutations.",
				),
				"transferList",
			],
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
			[integerResult(byteCount, "fulfill"), "write", "append"],
			[{ kind: "fulfill", value: { mask: OBJECT, platformObject: "fileStat" } }, "stat"],
			[fulfilled(UNDEFINED), "chmod", "delete", "copyTo", "moveTo"],
			[hostObject("ReadableStream"), "stream"],
			[{ kind: "return", value: { mask: OBJECT, platformObject: "writer" } }, "writer"],
			[
				{
					kind: "fulfill",
					value: {
						mask: STRING | NUMBER | BOOLEAN | NULL | OBJECT,
						numericRangeUnavailable: "JSON numbers can be fractional or negative zero.",
					},
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
			[{ kind: "fulfill", value: { mask: OBJECT, platformObject: "fileStat" } }, "stat"],
			[
				denseArray(
					{
						mask: OBJECT,
						fields: { name: stringField, path: stringField, kind: stringField },
					},
					undefined,
					"fulfill",
				),
				"entries",
			],
			[denseArray({ mask: OBJECT }, undefined, "fulfill"), "files"],
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
			[integerResult(byteCount, "fulfill"), "write"],
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
	| "ObservedPerformanceEntry"
	| "PerformanceObserver"
	| "PerformanceObserverEntryList"
	| "EventLoopUtilization"
	| "NodeTestContext"
	| "NodeTestAssertions"
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
	| "NodeFsReadStream"
	| "NodeFsWriteStream"
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
	| "ConstructedDirent"
	| "DirIterator"
	| "FileHandle"
	| "Stats"
	| "NumberStats"
	| "BigIntStats"
	| "FilesystemStats"
	| "MaligatorStat"
	| "FileHandleRead"
	| "FileHandleWrite"
	| "DirectoryEntries"
	| "DirectoryNames"
	| "DirectoryDirents"
	| "TemporaryDirectory"
	| "TemporaryDirectoryBuffer"
	| "TemporaryDirectoryText"
	| "TemporaryDirectorySync"
	| "TemporaryDirectorySyncBuffer"
	| "TemporaryDirectorySyncText"
	| "FsWatcher"
	| "FsStatWatcher"
	| "FsGlobIterator"
	| "FsWatchIterator"
	| "Navigator"
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
			value: {
				mask: NUMBER | STRING | BOOLEAN | OBJECT | NULL,
				numericRangeUnavailable: "JSON numbers can be fractional or negative zero.",
			},
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

function fulfilledHostObject(hostObject: HostObjectKind): HostResultContract {
	return { kind: "fulfill", value: { mask: OBJECT, hostObject } };
}

const blob = exportsWithContracts(
	[resolved(STRING), "text"],
	[resolved(OBJECT), "arrayBuffer"],
	[{ kind: "resolve", value: { mask: OBJECT, brand: "Uint8Array" } }, "bytes"],
	[hostObject("ReadableStream"), "stream"],
);
const blobProperties = exportsWithContracts(
	[
		numericResult("Native storage reports a byte count without a safe-integer limit."),
		"size",
	],
	[returned(STRING), "type"],
);
const bodyProperties = exportsWithContracts(
	[returned(OBJECT | NULL), "body"],
	[returned(BOOLEAN), "bodyUsed"],
);

const readableReaderMethods = exportsWithContracts(
	[fulfilled(UNDEFINED), "cancel"],
	[returned(UNDEFINED), "releaseLock"],
	[
		ownRecord(
			{ done: { mask: BOOLEAN }, value: { mask: TOP } },
			"fulfill",
			"StreamReadResult",
		),
		"read",
	],
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
	[integerResult(compilerIntegerRange(0, 3)), "eventPhase"],
	[
		numericResult("The event clock returns milliseconds with fractional precision."),
		"timeStamp",
	],
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
		[int32, "listenerCount"],
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
			[
				numericResult("Uses the supplied Number or the writable listener limit."),
				"getMaxListeners",
			],
			[eventNames, "eventNames"],
			[arbitraryElements, "listeners", "rawListeners"],
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
							value: {
								mask: TOP,
								selector: { kind: "read-size", argument: 0 },
								numericRangeUnavailable: "Object-mode streams can contain any Number.",
							},
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
			[
				dynamicRecordContents(
					"Header names and values come from caller mutations on the outgoing message.",
				),
				"getHeaders",
			],
			[strings, "getHeaderNames"],
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
	[
		integerResult(compilerIntegerRange(0, 0xffff), "return", NUMBER | UNDEFINED),
		"remotePort",
		"localPort",
	],
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
		nonnegativeInt32,
		"headersTimeout",
		"requestTimeout",
		"keepAliveTimeout",
		"maxConnections",
	],
	[
		numericResult("The timeout setter accepts fractional and negative-zero numbers."),
		"timeout",
	],
	[
		numericResult(
			"May be unset and follows the server option value.",
			NUMBER | UNDEFINED,
		),
		"maxHeaderSize",
	],
	[
		numericResult("May be null or contain an option value.", NUMBER | NULL),
		"maxHeadersCount",
	],
);
const childProcessProperties = exportsWithContracts(
	[returned(BOOLEAN), "killed", "connected"],
	[integerResult(COMPILER_INT32_RANGE, "return", NUMBER | UNDEFINED), "pid"],
	[integerResult(COMPILER_INT32_RANGE, "return", NUMBER | NULL), "exitCode"],
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
	[numericResult("The performance clock returns fractional milliseconds."), "now"],
	[hostObject("PerformanceEntry"), "mark", "measure"],
	[eventLoopUtilizationRecord, "eventLoopUtilization"],
	[returned(OBJECT), "timerify", "toJSON"],
	[performanceEntries, "getEntries", "getEntriesByName", "getEntriesByType"],
	[returned(UNDEFINED), "clearMarks", "clearMeasures"],
);
const performanceEntryJSON = {
	entryType: stringField,
	startTime: numberField,
	duration: numberField,
	detail: { mask: TOP },
};
const performanceEntryProperties = exportsWithContracts(
	[returned(STRING), "entryType"],
	[
		numericResult("Timing fields allow fractional milliseconds."),
		"startTime",
		"duration",
	],
	[dynamic("Contains the detail value captured when this entry was recorded."), "detail"],
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
	const methods = exportsWithContracts(
		[strings, "getServers"],
		[returned(UNDEFINED), "setServers", "cancel"],
	);
	for (const name of dnsQueries) {
		if (name === "lookupService") continue;
		methods.set(name, promises ? dnsPromiseQueries.get(name)! : callback);
	}
	return methods;
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
	["navigator", "Navigator"],
]);

const statsDates = exportsWithContracts([
	returned(OBJECT),
	"atime",
	"mtime",
	"ctime",
	"birthtime",
]);
function statsFields(mask: number): ReadonlyMap<string, HostResultContract> {
	const integer =
		(mask & NUMBER) === 0
			? returned(mask)
			: integerResult(COMPILER_UINT32_RANGE, "return", mask);
	const size =
		(mask & NUMBER) === 0
			? returned(mask)
			: numericResult(
					"The filesystem can return integers beyond the safe-integer limit.",
					mask,
				);
	const timestamp =
		(mask & NUMBER) === 0
			? returned(mask)
			: numericResult(
					"Filesystem timestamps can be fractional or NaN for constructed Stats.",
					mask,
				);
	return new Map([
		...statsDates,
		...exportsWithContracts([integer, "mode", "uid", "gid"]),
		...exportsWithContracts(
			[size, "dev", "nlink", "rdev", "blksize", "ino", "size", "blocks"],
			[timestamp, "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs"],
		),
	]);
}

export const HOST_INDEXED_RESULTS: ReadonlyMap<HostObjectKind, HostResultContract> =
	new Map([
		["DirectoryEntries", returned(STRING | OBJECT | UNDEFINED)],
		["DirectoryNames", returned(STRING | UNDEFINED)],
		["DirectoryDirents", hostObject("Dirent", undefined, OBJECT | UNDEFINED)],
	]);

function directoryCompletion(value: HostValueContract): HostResultContract {
	return {
		kind: "fulfill",
		value,
		immediateMask: OBJECT | UNDEFINED,
		optionalCallback: 0,
	};
}

const globalHostFunctions = exportsWithContracts(
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
		numericResult("Runtime counters have no safe-integer limit."),
		"__mal_gc_live_bytes",
		"__mal_gc_allocated_bytes",
		"__mal_gc_collections",
	],
	[hostObject("Timeout"), "setTimeout", "setInterval"],
	[hostObject("Immediate"), "setImmediate"],
	[
		numericResult(
			"Clones arbitrary supported input, including any Number.",
			TOP & ~SYMBOL,
		),
		"structuredClone",
	],
);
export const GLOBAL_HOST_FUNCTION_RESULTS = withInputs(
	globalHostFunctions,
	[objectInput, "queueMicrotask", "setTimeout", "setInterval", "setImmediate"],
	[noInputFact("Converts the value to a string."), "atob", "btoa"],
	[
		noInputFact("Ignores values that do not identify a live timer."),
		"clearTimeout",
		"clearInterval",
		"clearImmediate",
	],
);

export const GLOBAL_HOST_NAMESPACE_RESULTS = new Map([
	["console", console],
	["process", process],
	["performance", performanceMethods],
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

export const GLOBAL_HOST_ABSTRACT_CONSTRUCTORS = exportsWithContracts([
	neverReturns(
		"The host allocates these instances internally and the public constructor rejects direct calls and construction.",
	),
	"Crypto",
	"CryptoKey",
	"SubtleCrypto",
	"MessagePort",
	"Performance",
	"PerformanceEntry",
	"PerformanceMark",
	"PerformanceMeasure",
	"PerformanceObserverEntryList",
	"PerformanceResourceTiming",
	"ReadableByteStreamController",
	"ReadableStreamDefaultController",
	"ReadableStreamBYOBRequest",
	"TransformStreamDefaultController",
	"WritableStreamDefaultController",
]);

const temporaryDirectoryMethods = exportsWithContracts([
	fulfilled(UNDEFINED),
	"remove",
	"[Symbol.asyncDispose]",
]);
const temporaryDirectorySyncMethods = exportsWithContracts([
	returned(UNDEFINED),
	"remove",
	"[Symbol.dispose]",
]);
const temporaryDirectoryPath = exportsWithContracts([returned(STRING | OBJECT), "path"]);
const temporaryDirectoryTextPath = exportsWithContracts([returned(STRING), "path"]);
const temporaryDirectoryBufferPath = exportsWithContracts([
	hostObject("Buffer", "Uint8Array"),
	"path",
]);

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
		EventEmitter: exportsWithContracts([
			numericResult("The property accepts caller-supplied numbers."),
			"defaultMaxListeners",
		]),
	},
	statics: {
		NetBlockList: withInputs(exportsWithContracts([returned(BOOLEAN), "isBlockList"]), [
			predicate(OBJECT),
			"isBlockList",
		]),
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
		Buffer: withInputs(
			exportsWithContracts(
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
				[integerResult(byteCount), "byteLength"],
				[integerResult(compilerIntegerRange(-1, 1)), "compare"],
			),
			[bufferPredicate, "isBuffer"],
			[predicate(STRING), "isEncoding"],
			[validates(input(0, STRING | OBJECT)), "byteLength"],
			[
				validates(input(0, OBJECT, "Uint8Array"), input(1, OBJECT, "Uint8Array")),
				"compare",
			],
		),
		URL: withInputs(
			exportsWithContracts(
				[returned(BOOLEAN), "canParse"],
				[hostObject("URL", undefined, OBJECT | NULL), "parse"],
			),
			[
				noInputFact("Converts the URL and base through Web IDL string conversion."),
				"canParse",
				"parse",
			],
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
				[
					integerResult(compilerIntegerRange(1, 24), "return", NUMBER | UNDEFINED),
					"getColorDepth",
				],
				[returned(BOOLEAN), "hasColors"],
				[denseArray({ mask: NUMBER | UNDEFINED }, 2), "getWindowSize"],
			),
		]),
		Performance: performanceMethods,
		PerformanceEntry: exportsWithContracts([
			ownRecord({ ...performanceEntryJSON, name: stringField }),
			"toJSON",
		]),
		ObservedPerformanceEntry: exportsWithContracts([
			ownRecord({ ...performanceEntryJSON, name: { mask: TOP } }),
			"toJSON",
		]),
		PerformanceObserver: exportsWithContracts(
			[returned(UNDEFINED), "observe", "disconnect"],
			[observedPerformanceEntries, "takeRecords"],
		),
		PerformanceObserverEntryList: exportsWithContracts([
			observedPerformanceEntries,
			"getEntries",
			"getEntriesByName",
			"getEntriesByType",
		]),
		EventLoopUtilization: exportsWithContracts(),
		NodeTestContext: exportsWithContracts(
			[returned(UNDEFINED), "plan", "after", "diagnostic"],
			[neverReturns("The test runtime rejects nested tests."), "test"],
		),
		NodeTestAssertions: assertionInstanceMethods,
		PerformanceNodeTiming: exportsWithContracts([returned(OBJECT), "toJSON"]),
		Histogram: exportsWithContracts(
			[returned(UNDEFINED), "reset", "record", "recordDelta"],
			[
				numericResult("The histogram may expose floating-point or missing observations."),
				"percentile",
			],
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
					int32,
					"getRecvBufferSize",
					"getSendBufferSize",
					"getSendQueueSize",
					"getSendQueueCount",
				],
				[
					numericResult(
						"Returns the original Number passed to the socket option setter.",
					),
					"setTTL",
					"setMulticastTTL",
					"setRecvBufferSize",
					"setSendBufferSize",
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
		NodeFsReadStream: new Map([
			...nodeStreamMethods("NodeFsReadStream", true, false),
			...exportsWithContracts([returned(UNDEFINED), "_read"], [callback, "_destroy"]),
		]),
		NodeFsWriteStream: new Map([
			...nodeStreamMethods("NodeFsWriteStream", false, true),
			...exportsWithContracts([callback, "_write", "_final", "_destroy"]),
		]),
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
				[
					numericResult(
						"Returns an uncapped native message ticket when one is available.",
						NUMBER | UNDEFINED,
					),
					"postMessage",
				],
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
				[integerResult(COMPILER_INT32_RANGE, "fulfill", NUMBER | UNDEFINED), "terminate"],
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
			[
				numericResult(
					"The async IDs are uncapped or supplied through constructor options.",
				),
				"asyncId",
				"triggerAsyncId",
			],
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
		ConstructedDirent: fileTypePredicates,
		DirIterator: exportsWithContracts(
			[ownIteratorResult({ mask: OBJECT | UNDEFINED }, "fulfill"), "next"],
			[ownIteratorResult({ mask: UNDEFINED }, "fulfill"), "return"],
		),
		FileHandle: NODE_FILE_HANDLE_RESULTS.methods,
		Stats: fileTypePredicates,
		NumberStats: fileTypePredicates,
		BigIntStats: fileTypePredicates,
		FilesystemStats: exportsWithContracts(),
		MaligatorStat: exportsWithContracts(),
		FileHandleRead: exportsWithContracts(),
		FileHandleWrite: exportsWithContracts(),
		DirectoryEntries: exportsWithContracts(),
		DirectoryNames: exportsWithContracts(),
		DirectoryDirents: exportsWithContracts(),
		TemporaryDirectory: temporaryDirectoryMethods,
		TemporaryDirectoryBuffer: temporaryDirectoryMethods,
		TemporaryDirectoryText: temporaryDirectoryMethods,
		TemporaryDirectorySync: temporaryDirectorySyncMethods,
		TemporaryDirectorySyncBuffer: temporaryDirectorySyncMethods,
		TemporaryDirectorySyncText: temporaryDirectorySyncMethods,
		FsWatcher: new Map([
			...emitterMethods("FsWatcher"),
			...exportsWithContracts(
				[returned(UNDEFINED), "close"],
				[hostObject("FsWatcher"), "ref", "unref"],
			),
		]),
		FsStatWatcher: new Map([
			...emitterMethods("FsStatWatcher"),
			...exportsWithContracts([hostObject("FsStatWatcher"), "ref", "unref"]),
		]),
		FsGlobIterator: exportsWithContracts(
			[fulfilledHostObject("StreamReadResult"), "next", "return"],
			[hostObject("FsGlobIterator"), "[Symbol.asyncIterator]"],
		),
		FsWatchIterator: exportsWithContracts(
			[fulfilledHostObject("StreamReadResult"), "next", "return"],
			[hostObject("FsWatchIterator"), "[Symbol.asyncIterator]"],
		),
		Navigator: exportsWithContracts(),
		ByteLengthQueuingStrategy: exportsWithContracts([
			dynamic("Returns the supplied chunk's byteLength property without converting it."),
			"size",
		]),
		CompressionStream: exportsWithContracts(),
		CountQueuingStrategy: exportsWithContracts([
			integerResult(compilerIntegerRange(1, 1)),
			"size",
		]),
		DecompressionStream: exportsWithContracts(),
		AbortController: exportsWithContracts([returned(UNDEFINED), "abort"]),
		AbortSignal: new Map([
			...eventTargetMethods,
			["throwIfAborted", returned(UNDEFINED)],
		]),
		Blob: blob,
		Buffer: withInputs(
			exportsWithContracts(
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
				[integerResult(compilerIntegerRange(-1, 1)), "compare"],
				[integerResult(compilerIntegerRange(-1, 0xffff_ffff)), "indexOf", "lastIndexOf"],
				[
					uint32,
					"write",
					"copy",
					"utf8Write",
					"latin1Write",
					"asciiWrite",
					"hexWrite",
					"base64Write",
					"base64urlWrite",
					"ucs2Write",
				],
				[integerResult(compilerIntegerRange(0, 0xff)), "readUInt8", "readUint8"],
				[integerResult(compilerIntegerRange(-0x80, 0x7f)), "readInt8"],
				[
					integerResult(compilerIntegerRange(0, 0xffff)),
					"readUInt16LE",
					"readUint16LE",
					"readUInt16BE",
					"readUint16BE",
				],
				[
					integerResult(compilerIntegerRange(-0x8000, 0x7fff)),
					"readInt16LE",
					"readInt16BE",
				],
				[uint32, "readUInt32LE", "readUint32LE", "readUInt32BE", "readUint32BE"],
				[int32, "readInt32LE", "readInt32BE"],
				[
					bufferWidth("buffer-unsigned-width", compilerIntegerRange(0, 2 ** 48 - 1)),
					"readUIntLE",
					"readUintLE",
					"readUIntBE",
					"readUintBE",
				],
				[
					bufferWidth(
						"buffer-signed-width",
						compilerIntegerRange(-(2 ** 47), 2 ** 47 - 1),
					),
					"readIntLE",
					"readIntBE",
				],
				[
					numericResult("Decodes floating-point bytes, including NaN and negative zero."),
					"readFloatLE",
					"readFloatBE",
					"readDoubleLE",
					"readDoubleBE",
				],
				[
					integerResult(compilerIntegerRange(1, 0xffff_ffff)),
					"writeUInt8",
					"writeUint8",
					"writeInt8",
				],
				[
					integerResult(compilerIntegerRange(2, 0xffff_ffff)),
					"writeUInt16LE",
					"writeUint16LE",
					"writeUInt16BE",
					"writeUint16BE",
					"writeInt16LE",
					"writeInt16BE",
				],
				[
					integerResult(compilerIntegerRange(4, 0xffff_ffff)),
					"writeUInt32LE",
					"writeUint32LE",
					"writeUInt32BE",
					"writeUint32BE",
					"writeInt32LE",
					"writeInt32BE",
					"writeFloatLE",
					"writeFloatBE",
				],
				[
					integerResult(compilerIntegerRange(8, 0xffff_ffff)),
					"writeDoubleLE",
					"writeDoubleBE",
					"writeBigUInt64LE",
					"writeBigUint64LE",
					"writeBigUInt64BE",
					"writeBigUint64BE",
					"writeBigInt64LE",
					"writeBigInt64BE",
				],
				[
					bufferWidth("buffer-write-width", compilerIntegerRange(1, 0xffff_ffff)),
					"writeUIntLE",
					"writeUintLE",
					"writeUIntBE",
					"writeUintBE",
					"writeIntLE",
					"writeIntBE",
				],
			),
			[
				bufferFixedRead,
				"readUInt8",
				"readUint8",
				"readInt8",
				"readUInt16LE",
				"readUint16LE",
				"readUInt16BE",
				"readUint16BE",
				"readInt16LE",
				"readInt16BE",
				"readUInt32LE",
				"readUint32LE",
				"readUInt32BE",
				"readUint32BE",
				"readInt32LE",
				"readInt32BE",
				"readFloatLE",
				"readFloatBE",
				"readDoubleLE",
				"readDoubleBE",
				"readBigUInt64LE",
				"readBigUint64LE",
				"readBigUInt64BE",
				"readBigUint64BE",
				"readBigInt64LE",
				"readBigInt64BE",
			],
			[
				bufferVariableRead,
				"readUIntLE",
				"readUintLE",
				"readUIntBE",
				"readUintBE",
				"readIntLE",
				"readIntBE",
			],
			[
				bufferFixedWrite,
				"writeUInt8",
				"writeUint8",
				"writeInt8",
				"writeUInt16LE",
				"writeUint16LE",
				"writeUInt16BE",
				"writeUint16BE",
				"writeInt16LE",
				"writeInt16BE",
				"writeUInt32LE",
				"writeUint32LE",
				"writeUInt32BE",
				"writeUint32BE",
				"writeInt32LE",
				"writeInt32BE",
				"writeFloatLE",
				"writeFloatBE",
				"writeDoubleLE",
				"writeDoubleBE",
				"writeBigUInt64LE",
				"writeBigUint64LE",
				"writeBigUInt64BE",
				"writeBigUint64BE",
				"writeBigInt64LE",
				"writeBigInt64BE",
			],
			[
				bufferVariableWrite,
				"writeUIntLE",
				"writeUintLE",
				"writeUIntBE",
				"writeUintBE",
				"writeIntLE",
				"writeIntBE",
			],
			[
				validates(bufferReceiver),
				"toString",
				"toLocaleString",
				"toJSON",
				"swap16",
				"swap32",
				"swap64",
				"slice",
				"subarray",
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
			[denseArray({ mask: STRING | OBJECT, hostObject: "File" }), "getAll"],
			[hostObject("FormDataIterator"), "entries", "keys", "values", "[Symbol.iterator]"],
		),
		Headers: exportsWithContracts(
			[returned(UNDEFINED), "append", "delete", "set", "forEach"],
			[returned(BOOLEAN), "has"],
			[returned(STRING | NULL), "get"],
			[strings, "getSetCookie"],
			[hostObject("HeadersIterator"), "entries", "keys", "values", "[Symbol.iterator]"],
		),
		Request: new Map([...body, ["clone", hostObject("Request")]]),
		Response: body,
		ReadableStream: exportsWithContracts(
			[fulfilled(UNDEFINED), "cancel", "pipeTo"],
			[hostObject("ReadableStreamReader"), "getReader"],
			[returned(OBJECT), "pipeThrough"],
			[denseArray({ mask: OBJECT, hostObject: "ReadableStream" }, 2), "tee"],
			[hostObject("ReadableStreamIterator"), "values", "[Symbol.asyncIterator]"],
		),
		ReadableStreamDefaultReader: readableReaderMethods,
		ReadableStreamBYOBReader: readableReaderMethods,
		ReadableStreamReader: readableReaderMethods,
		ReadableStreamIterator: exportsWithContracts([fulfilled(OBJECT), "next", "return"]),
		StreamReadResult: exportsWithContracts(),
		StatementSync: withInputs(
			exportsWithContracts(
				[denseArray({ mask: OBJECT }), "all"],
				[returned(OBJECT | UNDEFINED), "get"],
				[
					ownRecord({
						changes: { mask: NUMBER | BIGINT },
						lastInsertRowid: { mask: NUMBER | BIGINT },
					}),
					"run",
				],
				[returned(UNDEFINED), "setReturnArrays", "setReadBigInts"],
			),
			[validates(input(0, BOOLEAN)), "setReturnArrays", "setReadBigInts"],
		),
		StringDecoder: exportsWithContracts([returned(STRING), "write", "end"]),
		TextDecoder: withInputs(exportsWithContracts([returned(STRING), "decode"]), [
			validates(input(0, OBJECT | UNDEFINED), input(1, OBJECT | NULL | UNDEFINED)),
			"decode",
		]),
		TextDecoderStream: exportsWithContracts(),
		TextEncoder: withInputs(
			exportsWithContracts(
				[returned(OBJECT, "Uint8Array"), "encode"],
				[
					ownRecord({
						read: { ...numberField, integerRange: compilerIntegerRange(0, 0x7fff_ffff) },
						written: { ...numberField, integerRange: COMPILER_UINT32_RANGE },
					}),
					"encodeInto",
				],
			),
			[validates(input(1, OBJECT)), "encodeInto"],
			[noInputFact("Converts the input to a string."), "encode"],
		),
		TextEncoderStream: exportsWithContracts(),
		TransformStream: exportsWithContracts(),
		URL: exportsWithContracts([returned(STRING), "toString", "toJSON"]),
		URLSearchParams: exportsWithContracts(
			[returned(STRING | NULL), "get"],
			[strings, "getAll"],
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
		URLSearchParamsIterator: exportsWithContracts([
			ownIteratorResult({ mask: OBJECT | STRING | UNDEFINED }),
			"next",
		]),
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
			[
				numericResult("Timer handles use an uncapped native identifier."),
				"[Symbol.toPrimitive]",
			],
		),
		Immediate: exportsWithContracts(
			[hostObject("Immediate"), "ref", "unref"],
			[returned(BOOLEAN), "hasRef"],
			[returned(UNDEFINED), "[Symbol.dispose]"],
		),
		FormDataIterator: exportsWithContracts([
			ownIteratorResult({ mask: OBJECT | STRING | UNDEFINED }),
			"next",
		]),
		HeadersIterator: exportsWithContracts([
			ownIteratorResult({ mask: OBJECT | STRING | UNDEFINED }),
			"next",
		]),
	},
	properties: {
		ReadableStreamDefaultController: exportsWithContracts([
			numericResult(
				"Subtracts a possibly fractional queue size from the high-water mark.",
				NUMBER | NULL,
			),
			"desiredSize",
		]),
		ReadableByteStreamController: exportsWithContracts(
			[
				numericResult(
					"Subtracts a possibly fractional queue size from the high-water mark.",
					NUMBER | NULL,
				),
				"desiredSize",
			],
			[hostObject("ReadableStreamBYOBRequest", undefined, OBJECT | NULL), "byobRequest"],
		),
		ReadableStreamBYOBRequest: exportsWithContracts([returned(OBJECT | NULL), "view"]),
		WritableStreamDefaultController: exportsWithContracts([
			returned(UNDEFINED),
			"signal",
		]),
		TransformStreamDefaultController: exportsWithContracts([
			numericResult(
				"Subtracts a possibly fractional queue size from the high-water mark.",
				NUMBER | NULL,
			),
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
			[numericResult("The origin is recorded in fractional milliseconds."), "timeOrigin"],
			[hostObject("PerformanceNodeTiming", undefined, OBJECT | UNDEFINED), "nodeTiming"],
		),
		PerformanceEntry: new Map([
			...performanceEntryProperties,
			["name", returned(STRING)],
		]),
		ObservedPerformanceEntry: new Map([
			...performanceEntryProperties,
			[
				"name",
				dynamic(
					"Function entries copy the callable's name property without converting it.",
				),
			],
		]),
		PerformanceNodeTiming: exportsWithContracts([
			numericResult("Timing fields allow fractional milliseconds."),
			"duration",
		]),
		EventLoopUtilization: exportsWithContracts([
			numericResult("Time measurements and their utilization ratio may be fractional."),
			"idle",
			"active",
			"utilization",
		]),
		NodeTestContext: exportsWithContracts(
			[returned(STRING), "name"],
			[hostObject("AbortSignal"), "signal"],
			[hostObject("NodeTestAssertions"), "assert"],
		),
		Histogram: exportsWithContracts([
			numericResult(
				"Histogram statistics can be fractional, nonfinite, or derived from uncapped counters.",
			),
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
				[
					integerResult(compilerIntegerRange(0, 0xffff), "return", NUMBER | UNDEFINED),
					"columns",
					"rows",
				],
			),
		]),
		NetBlockList: exportsWithContracts([strings, "rules"]),
		NetServer: exportsWithContracts([returned(BOOLEAN), "listening"]),
		TlsServer: exportsWithContracts([returned(BOOLEAN), "listening"]),
		NetSocket: socketProperties,
		TlsSocket: new Map([...socketProperties, ["encrypted", returned(BOOLEAN)]]),
		SocketAddress: exportsWithContracts(
			[returned(STRING), "address", "family"],
			[integerResult(compilerIntegerRange(0, 0xffff)), "port"],
		),
		HttpAgent: exportsWithContracts(
			[
				numericResult(
					"These are caller-configurable limits and may be nonfinite or fractional.",
				),
				"maxTotalSockets",
				"agentKeepAliveTimeoutBuffer",
			],
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
				[
					dynamicArrayContents(
						"These mutable arrays are published on the live child process.",
					),
					"spawnargs",
					"stdio",
				],
				[hostObject("NodeWritable", undefined, OBJECT | NULL), "stdin"],
				[hostObject("NodeReadable", undefined, OBJECT | NULL), "stdout", "stderr"],
			),
		]),
		SpawnSyncResult: exportsWithContracts(
			[int32, "pid"],
			[integerResult(COMPILER_INT32_RANGE, "return", NUMBER | NULL), "status"],
			[integerResult(COMPILER_INT32_RANGE, "return", STRING | NUMBER | NULL), "signal"],
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
			[int32, "status"],
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
			[numericResult("The cursor may reflect a caller-provided terminal width."), "rows"],
			[dynamic("Returns the public cursor value unchanged."), "cols"],
		),
		CompressionInfo: exportsWithContracts(
			[hostObject("Buffer", "Uint8Array"), "buffer"],
			[hostObject("ZlibStream"), "engine"],
		),
		NodeReadable: readableStateFields,
		NodeWritable: writableStateFields,
		NodeFsReadStream: new Map([
			...readableStateFields,
			...exportsWithContracts(
				[returned(STRING), "path"],
				[integerResult(COMPILER_INT32_RANGE, "return", NUMBER | NULL), "fd"],
			),
		]),
		NodeFsWriteStream: new Map([
			...writableStateFields,
			...exportsWithContracts(
				[returned(STRING | UNDEFINED), "path"],
				[integerResult(COMPILER_INT32_RANGE, "return", NUMBER | NULL), "fd"],
				[returned(BOOLEAN), "autoClose"],
				[numericResult("Total bytes written can exceed a safe integer."), "bytesWritten"],
				[numericResult("Preserves the provided stream mode."), "mode"],
				[
					numericResult(
						"The stream start offset can be missing or originate in options.",
						NUMBER | UNDEFINED,
					),
					"start",
				],
				[numericResult("The flags are caller supplied.", STRING | NUMBER), "flags"],
			),
		]),
		NodeDuplex: duplexStateFields,
		NodeTransform: duplexStateFields,
		NodePassThrough: duplexStateFields,
		ZlibStream: new Map([
			...duplexStateFields,
			...exportsWithContracts(
				[returned(BOOLEAN), "_closed"],
				[numericResult("Total bytes written can exceed a safe integer."), "bytesWritten"],
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
		NodeWorker: exportsWithContracts([int32, "threadId"]),
		MaligatorWorker: exportsWithContracts(
			[int32, "id"],
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
			[integerResult(compilerIntegerRange(1, 4096)), "parallelism"],
			[integerResult(compilerIntegerRange(16, 256)), "maxWorkers"],
		),
		WorkerExit: exportsWithContracts(
			[int32, "id", "code"],
			[returned(STRING), "reason"],
			[dynamic("Contains a worker-defined failure value when available."), "error"],
		),
		WorkerMessage: exportsWithContracts([
			dynamic("The queued message can be any supported cloneable value."),
			"message",
		]),
		WorkerUrl: exportsWithContracts([returned(STRING), "href"]),
		NativeHttpServer: exportsWithContracts([
			integerResult(compilerIntegerRange(0, 0xffff)),
			"port",
		]),
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
			[
				numericResult("The native byte count has no safe-integer check."),
				"symmetricKeySize",
			],
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
		Stats: statsFields(NUMBER | BIGINT | UNDEFINED),
		NumberStats: statsFields(NUMBER),
		BigIntStats: new Map([
			...statsFields(BIGINT),
			...exportsWithContracts([
				returned(BIGINT),
				"atimeNs",
				"mtimeNs",
				"ctimeNs",
				"birthtimeNs",
			]),
		]),
		FilesystemStats: exportsWithContracts([
			numericResult(
				"The filesystem returns platform-sized counters with no safe-integer limit.",
			),
			"type",
			"bsize",
			"blocks",
			"bfree",
			"bavail",
			"files",
			"ffree",
		]),
		MaligatorStat: exportsWithContracts(
			[integerResult(compilerIntegerRange(0, 7)), "type"],
			[int32, "mode"],
			[numericResult("Native file sizes have no safe-integer limit."), "size"],
			[numericResult("Native file times retain fractional milliseconds."), "mtimeMs"],
		),
		FileHandleRead: exportsWithContracts(
			[uint32, "bytesRead"],
			[returned(OBJECT), "buffer"],
		),
		FileHandleWrite: exportsWithContracts(
			[integerResult(byteCount), "bytesWritten"],
			[returned(STRING | OBJECT), "buffer"],
		),
		TemporaryDirectory: temporaryDirectoryPath,
		TemporaryDirectoryBuffer: temporaryDirectoryBufferPath,
		TemporaryDirectoryText: temporaryDirectoryTextPath,
		TemporaryDirectorySync: temporaryDirectoryPath,
		TemporaryDirectorySyncBuffer: temporaryDirectoryBufferPath,
		TemporaryDirectorySyncText: temporaryDirectoryTextPath,
		Dirent: exportsWithContracts([returned(STRING | UNDEFINED), "name", "parentPath"]),
		ConstructedDirent: exportsWithContracts([
			dynamic(
				"The constructor stores the supplied name and parent path without conversion.",
			),
			"name",
			"parentPath",
		]),
		Navigator: exportsWithContracts([
			numericResult(
				"The platform reports the processor count as a long without a JavaScript safe-integer check.",
			),
			"hardwareConcurrency",
		]),
		ByteLengthQueuingStrategy: exportsWithContracts(
			[
				numericResult("The supplied high-water mark may be fractional or infinite."),
				"highWaterMark",
			],
			[returned(OBJECT), "size"],
		),
		CompressionStream: transformStreamProperties,
		CountQueuingStrategy: exportsWithContracts(
			[
				numericResult("The supplied high-water mark may be fractional or infinite."),
				"highWaterMark",
			],
			[returned(OBJECT), "size"],
		),
		DecompressionStream: transformStreamProperties,
		AbortController: exportsWithContracts([hostObject("AbortSignal"), "signal"]),
		AbortSignal: exportsWithContracts(
			[returned(BOOLEAN), "aborted"],
			[dynamic("The abort reason can be any supplied JavaScript value."), "reason"],
		),
		Blob: blobProperties,
		Buffer: exportsWithContracts([returned(OBJECT), "parent"], [uint32, "offset"]),
		DatabaseSync: exportsWithContracts([returned(BOOLEAN), "isOpen", "isTransaction"]),
		DOMException: exportsWithContracts(
			[returned(STRING), "name", "message"],
			[integerResult(compilerIntegerRange(0, 25)), "code"],
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
				[numericResult("The event constructor preserves the supplied Number."), "code"],
				[returned(STRING), "reason"],
			),
		]),
		ErrorEvent: new Map([
			...eventProperties,
			...exportsWithContracts(
				[returned(STRING), "message", "filename"],
				[
					numericResult(
						"The event constructor stores the supplied numbers without integer conversion.",
					),
					"lineno",
					"colno",
				],
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
			[integerResult(compilerIntegerRange(0, 3)), "readyState"],
			[
				numericResult(
					"The send queue accumulates an uncapped double-precision byte count.",
				),
				"bufferedAmount",
			],
			[returned(STRING), "url", "extensions", "protocol", "binaryType"],
			[returned(OBJECT | NULL), "onopen", "onerror", "onclose", "onmessage"],
		),
		File: new Map([
			...blobProperties,
			...exportsWithContracts(
				[returned(STRING), "name"],
				[
					numericResult(
						"Truncating the supplied modification time can preserve negative zero or infinity.",
					),
					"lastModified",
				],
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
				[int32, "status"],
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
		URLSearchParams: exportsWithContracts([nonnegativeInt32, "size"]),
		WritableStream: exportsWithContracts([returned(BOOLEAN), "locked"]),
		WritableStreamDefaultWriter: exportsWithContracts(
			[fulfilled(UNDEFINED), "closed", "ready"],
			[
				numericResult(
					"Subtracts a possibly fractional queue size from the high-water mark.",
					NUMBER | NULL,
				),
				"desiredSize",
			],
		),
	},
} as const;

const statsDataFields = [
	"mode",
	"uid",
	"gid",
	"dev",
	"nlink",
	"rdev",
	"blksize",
	"ino",
	"size",
	"blocks",
	"atimeMs",
	"mtimeMs",
	"ctimeMs",
	"birthtimeMs",
] as const;
const namedRecordFields: Partial<Record<HostObjectKind, ReadonlyArray<string>>> = {
	BigIntStats: [...statsDataFields, "atimeNs", "mtimeNs", "ctimeNs", "birthtimeNs"],
	CompileCacheResult: ["status", "message"],
	CompressionInfo: ["buffer", "engine"],
	ExecBufferOutput: ["stdout", "stderr"],
	ExecOutput: ["stdout", "stderr"],
	ExecTextOutput: ["stdout", "stderr"],
	FilesystemStats: ["type", "bsize", "blocks", "bfree", "bavail", "files", "ffree"],
	MaligatorStat: ["type", "mode", "size", "mtimeMs"],
	NumberStats: statsDataFields,
	SourceMapSupport: ["enabled", "nodeModules", "generatedCode"],
	SpawnSyncResult: ["pid", "status", "signal", "output", "stdout", "stderr"],
	StreamReadResult: ["done", "value"],
	WorkerCapabilities: ["threads", "sharedMemory", "parallelism", "maxWorkers"],
};

export function hostNamedRecordContents(
	kind: HostObjectKind | undefined,
): HostInitialContents | undefined {
	return kind === undefined ? undefined : namedRecords.get(kind);
}

const namedRecords = new Map<HostObjectKind, HostInitialContents>();
for (const kind of Object.keys(namedRecordFields) as Array<HostObjectKind>) {
	const fields: Record<string, HostContentValue> = {};
	for (const key of namedRecordFields[kind]!) {
		const property = HOST_OBJECT_RESULTS.properties[kind]?.get(key);
		fields[key] = property?.kind === "return" ? property.value : { mask: TOP };
	}
	namedRecords.set(kind, { kind: "record", fields });
}
