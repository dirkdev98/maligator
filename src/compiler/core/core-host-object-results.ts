import { COMPILER_VALUE_KIND_OBJECT } from "../shared/compiler-value-kinds.ts";
import { EMBED_INSTALLER } from "../shared/embedded-asset.ts";
import {
	PLATFORM_OBJECT_RESULTS,
	PLATFORM_SOURCE_EXPORTS,
	PLATFORM_SOURCE_STATICS,
	CAPTURED_HOST_RESULTS,
	NODE_FILE_HANDLE_RESULTS,
	GLOBAL_HOST_CONSTRUCTORS,
	GLOBAL_HOST_ABSTRACT_CONSTRUCTORS,
	GLOBAL_HOST_FUNCTION_RESULTS,
	GLOBAL_HOST_NAMESPACE_RESULTS,
	GLOBAL_HOST_OBJECT_BRANDS,
	HOST_INDEXED_RESULTS,
	HOST_OBJECT_RESULTS,
	HOST_RESULT_CONTRACTS,
} from "../shared/host-result-contracts.ts";
import type {
	HostResultContract,
	HostObjectKind,
} from "../shared/host-result-contracts.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { coreNumericTypedArrayKind } from "./core-heap-brands.ts";
import {
	corePlatformSourceResult,
	coreHostDirectCallContract,
	coreHostCapturedSymbolKey,
	coreHostCapturedPromisifiedValue,
	coreHostGlobalName,
	coreHostArrayIndex,
	coreHostCompletion,
	coreHostPropertyName,
	coreHostResult,
	coreHostResultSlots,
	coreHostSlotName,
	coreHostSlotValue,
} from "./core-host-results.ts";
import type { CoreHostSlots } from "./core-host-results.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreProgramFlowTargetIndex } from "./core-program-flow.ts";
import {
	coreIntrinsicPromiseStaticCall,
	coreSuccessfulAwaitInput,
} from "./core-promise-facts.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

type GlobalHostConstructor = (typeof GLOBAL_HOST_CONSTRUCTORS)[number];
const GLOBAL_HOST_CONSTRUCTOR_NAMES = new Set<string>(GLOBAL_HOST_CONSTRUCTORS);
const PROTECTED_GLOBALS = new Set<string>([
	...GLOBAL_HOST_CONSTRUCTORS,
	...GLOBAL_HOST_ABSTRACT_CONSTRUCTORS.keys(),
	...GLOBAL_HOST_FUNCTION_RESULTS.keys(),
	...GLOBAL_HOST_NAMESPACE_RESULTS.keys(),
	...GLOBAL_HOST_OBJECT_BRANDS.keys(),
	"fetch",
	"globalThis",
	"__proto__",
]);
const HOST_OBJECT_SOURCE_NAMES = new RegExp(
	`\\b(?:${[...PROTECTED_GLOBALS].filter((name) => name !== "globalThis" && name !== "console" && name !== "__proto__").join("|")}|fs|maligator:(?:http|workers|test)|node:sqlite|(?:node:)?(?:stream|zlib|async_hooks|events|timers/promises|url|net|http|https|tls|dgram|child_process|readline|perf_hooks|diagnostics_channel|dns|tty|assert|vm|console|module|punycode|v8|test)|basename|StringDecoder|MIMEType|MIMEParams)\\b`,
);
for (const name of [
	"Object",
	"Reflect",
	"JSON",
	"Promise",
	"Array",
	"Symbol",
	"WeakMap",
	"Map",
	"Set",
	"Number",
	"Atomics",
])
	PROTECTED_GLOBALS.add(name);
const PROTECTED_PROPERTIES = new Set([
	...PROTECTED_GLOBALS,
	"prototype",
	"promises",
	"posix",
	"win32",
	"ucs2",
	"startupSnapshot",
	"custom",
	"report",
	"stdout",
	"stderr",
	...[...CAPTURED_HOST_RESULTS.keys()].map((path) =>
		path.slice(path.lastIndexOf(".") + 1).replace(/<get>$/, ""),
	),
	...[...HOST_RESULT_CONTRACTS.values()].flatMap((exports) => [...exports.keys()]),
	...[...GLOBAL_HOST_NAMESPACE_RESULTS.values()].flatMap((exports) => [
		...exports.keys(),
	]),
	"then",
	"constructor",
	...Object.values(HOST_OBJECT_RESULTS.methods).flatMap((members) => [...members.keys()]),
	...Object.values(HOST_OBJECT_RESULTS.properties).flatMap((members) => [
		...members.keys(),
	]),
	...Object.values(HOST_OBJECT_RESULTS.statics).flatMap((members) => [...members.keys()]),
	...Object.values(HOST_OBJECT_RESULTS.staticProperties).flatMap((members) => [
		...members.keys(),
	]),
	...NODE_FILE_HANDLE_RESULTS.methods.keys(),
	...NODE_FILE_HANDLE_RESULTS.properties.keys(),
	...Object.values(PLATFORM_OBJECT_RESULTS).flatMap(({ methods, properties }) => [
		...methods.keys(),
		...properties.keys(),
	]),
	...[...PLATFORM_SOURCE_STATICS.values()].flatMap((functions) =>
		[...functions.values()].flatMap((methods) => [...methods.keys()]),
	),
]);
const MODULE_EVALUATORS = new Set([
	"__evaluateModule",
	"__evaluateModuleAsync",
	"__evaluateModuleSync",
]);
const REFLECTIVE_WRITERS = new Set([
	"assign",
	"defineProperty",
	"defineProperties",
	"setPrototypeOf",
	"deleteProperty",
	"set",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupSetter__",
]);
const NATIVE_OBJECT_WRITERS = new Set([
	"_extend",
	"inherits",
	"compileFunction",
	"createContext",
	"runInContext",
	"runInNewContext",
	"runInThisContext",
]);
const TLS_MUTATOR_ROUTES = new Set([
	"connect",
	"emit",
	"listeners",
	"rawListeners",
	"getEventListeners",
]);
const PRIMITIVE_PRODUCERS = new Set([
	"createBoolean",
	"createNumber",
	"createF64",
	"createString",
	"createBigInt",
	"createNull",
	"createUndefined",
]);
const HOST_CALLBACK_ARGUMENTS = new Map([
	["setTimeout", 0],
	["setInterval", 0],
	["setImmediate", 0],
	["queueMicrotask", 0],
	["nextTick", 0],
	["forEach", 0],
	["addEventListener", 1],
	["addListener", 1],
	["prependListener", 1],
	["prependOnceListener", 1],
	["on", 1],
	["once", 1],
]);
const STREAM_CALLBACKS = {
	ReadableStream: { start: 0, pull: 0 },
	WritableStream: { start: 0, write: 1 },
	TransformStream: { start: 0, transform: 1, flush: 0 },
};
const STREAM_CALLBACK_KEYS = new Set([
	"start",
	"pull",
	"cancel",
	"write",
	"close",
	"abort",
	"transform",
	"flush",
]);
const CALLBACK_RECEIVERS = [
	"ReadableStreamDefaultController",
	"ReadableByteStreamController",
	"WritableStreamDefaultController",
	"TransformStreamDefaultController",
	"PerformanceObserverEntryList",
	"NodeTestContext",
] as const;
const CALLBACK_RECEIVER_MEMBERS = new Set(
	CALLBACK_RECEIVERS.flatMap((kind) => [
		...HOST_OBJECT_RESULTS.methods[kind].keys(),
		...(HOST_OBJECT_RESULTS.properties[kind]?.keys() ?? []),
	]),
);
export type CoreHostCallbackReceivers = ReadonlyMap<
	CoreFunctionId,
	ReadonlyMap<CoreValueId, HostObjectKind>
>;
type PlatformResult = (instruction: CoreInstructionId) => HostResultContract | undefined;
export function sameCallbackReceivers(
	left: CoreHostCallbackReceivers | undefined,
	right: CoreHostCallbackReceivers | undefined,
): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined || left.size !== right.size) return false;
	for (const [id, parameters] of left) {
		const update = right.get(id);
		if (update?.size !== parameters.size) return false;
		for (const [value, kind] of parameters) {
			if (update.get(value) !== kind) return false;
		}
	}
	return true;
}
const SCANNED_HOST_INSTALLERS = new Set([
	EMBED_INSTALLER,
	"mal_host_install_node_fs",
	"mal_host_install_node_fs_read_file",
	"mal_host_install_node_fs_read_stream",
	"mal_host_install_node_fs_named",
	"mal_host_install_node_fs_promises",
	"mal_host_install_node_path",
	"mal_host_install_node_path_posix",
	"mal_host_install_node_path_win32",
	"mal_host_install_node_os",
	"mal_host_install_node_buffer",
	"mal_host_install_node_crypto",
	"mal_host_install_node_crypto_digests",
	"mal_host_install_node_url",
	"mal_host_install_node_util",
	"mal_host_install_node_util_types",
	"mal_host_install_node_sys",
	"mal_host_install_node_sqlite",
	"mal_host_install_node_stream_web",
	"mal_host_install_node_stream",
	"mal_host_install_node_stream_promises",
	"mal_host_install_node_stream_consumers",
	"mal_host_install_node_zlib",
	"mal_host_install_node_zlib_decoders",
	"mal_host_install_node_net",
	"mal_host_install_node_http",
	"mal_host_install_node_http_without_websocket",
	"mal_host_install_node_http_server",
	"mal_host_install_node_https",
	"mal_host_install_node_tls",
	"mal_host_install_node_dgram",
	"mal_host_install_node_child_process",
	"mal_host_install_node_readline",
	"mal_host_install_node_readline_promises",
	"mal_host_install_node_perf_hooks",
	"mal_host_install_node_diagnostics_channel",
	"mal_host_install_node_dns",
	"mal_host_install_node_dns_promises",
	"mal_host_install_node_tty",
	"mal_host_install_node_assert",
	"mal_host_install_node_assert_strict",
	"mal_host_install_node_vm",
	"mal_host_install_node_console",
	"mal_host_install_node_module",
	"mal_host_install_node_punycode",
	"mal_host_install_node_v8",
	"mal_host_install_node_constants",
	"mal_host_install_node_domain",
	"mal_host_install_node_cluster",
	"mal_host_install_node_http2",
	"mal_host_install_node_inspector",
	"mal_host_install_node_querystring",
	"mal_host_install_maligator_application",
	"mal_host_install_maligator_process",
	"mal_host_install_process",
	"mal_host_install_node_string_decoder",
	"mal_host_install_node_timers",
	"mal_host_install_node_timers_promises",
	"mal_host_install_node_events",
	"mal_host_install_node_async_hooks",
	"mal_host_install_node_worker_threads",
	"mal_host_install_maligator_internal_fetch",
	"mal_host_install_maligator_internal_http",
	"mal_host_install_maligator_internal_workers",
	"mal_host_install_maligator_internal_fs",
	"mal_host_install_maligator_internal_fs_descriptor",
	"mal_host_install_maligator_internal_fs_stream",
	"mal_host_install_maligator_internal_fs_watch",
]);

function definition(fn: CoreFunctionStore, value: CoreValueId) {
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

function hostConstructor(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	slots: CoreHostSlots | undefined,
): HostObjectKind | undefined {
	const captured =
		slots === undefined
			? undefined
			: coreHostSlotValue(program, fn, value, slots)?.hostConstructor;
	if (captured !== undefined) return captured;
	const name = coreHostGlobalName(program, fn, value);
	return name !== undefined && GLOBAL_HOST_CONSTRUCTOR_NAMES.has(name)
		? (name as GlobalHostConstructor)
		: undefined;
}

function hostReceiver(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	slots: CoreHostSlots | undefined,
	budget: number,
	parameters: ReadonlyMap<CoreValueId, HostObjectKind> | undefined,
	platformResult: PlatformResult | undefined,
): HostObjectKind | undefined {
	if (budget === 0) return undefined;
	const parameter = parameters?.get(value);
	if (parameter !== undefined) return parameter;
	const producer = definition(fn, value);
	if (producer === undefined) return undefined;
	const global = coreHostGlobalName(program, fn, value);
	const globalBrand =
		global === undefined ? undefined : GLOBAL_HOST_OBJECT_BRANDS.get(global);
	if (globalBrand !== undefined) return globalBrand;
	const installed =
		slots === undefined ? undefined : coreHostSlotValue(program, fn, value, slots);
	if (installed?.installedObject === true) return installed.hostObject;
	if (fn.instructionOpcodeName(producer) !== "awaitFulfilled") {
		const result = producerContract(producer);
		return result?.kind === "return"
			? coreHostCompletion(program, fn, producer, result, true)?.immediate.hostObject
			: undefined;
	}
	const promise = coreSuccessfulAwaitInput(fn, producer);
	if (
		promise === undefined ||
		fn.valueUseCount(promise) !== 1 ||
		fn.kernel.valueHandlerUseCount(promise) !== 0
	)
		return undefined;
	const call = definition(fn, promise);
	if (call === undefined) return undefined;
	const result = producerContract(call);
	return coreHostCompletion(program, fn, call, result, true)?.fulfilled?.hostObject;

	function producerContract(producer: CoreInstructionId) {
		return (
			coreHostObjectResult(
				program,
				fn,
				producer,
				slots,
				parameters,
				platformResult,
				budget,
			) ??
			(slots === undefined
				? undefined
				: coreHostDirectCallContract(program, fn, producer, slots, 0, true)) ??
			platformResult?.(producer)
		);
	}
}

export function coreHostObjectResult(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	slots?: CoreHostSlots,
	parameters?: ReadonlyMap<CoreValueId, HostObjectKind>,
	platformResult?: PlatformResult,
	budget = 8,
): HostResultContract | undefined {
	if (budget === 0) return undefined;
	const opcode = fn.instructionOpcodeName(instruction);
	if (
		opcode !== "construct" &&
		opcode !== "call" &&
		opcode !== "loadPropertyStatic" &&
		opcode !== "loadProperty"
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	if (opcode === "construct") {
		const callee = fn.kernel.operandAt(start);
		const brand = hostConstructor(program, fn, callee, slots);
		return brand === undefined
			? GLOBAL_HOST_ABSTRACT_CONSTRUCTORS.get(
					coreHostGlobalName(program, fn, callee) ?? "",
				)
			: {
					kind: "return",
					value: { mask: COMPILER_VALUE_KIND_OBJECT, hostObject: brand },
				};
	}
	if (opcode === "loadPropertyStatic" || opcode === "loadProperty") {
		const name = coreHostPropertyName(program, fn, instruction);
		const receiver = fn.kernel.operandAt(start);
		if (name !== undefined) {
			const constructor = hostConstructor(program, fn, receiver, slots);
			if (constructor !== undefined)
				return HOST_OBJECT_RESULTS.staticProperties[constructor]?.get(name);
		}
		const brand = hostReceiver(
			program,
			fn,
			receiver,
			slots,
			budget - 1,
			parameters,
			platformResult,
		);
		if (brand === undefined) return undefined;
		const element = HOST_INDEXED_RESULTS.get(brand);
		if (
			element !== undefined &&
			fn.valueUseCount(receiver) === 1 &&
			fn.kernel.valueHandlerUseCount(receiver) === 0 &&
			coreHostArrayIndex(program, fn, instruction)
		)
			return element;
		return name === undefined
			? undefined
			: HOST_OBJECT_RESULTS.properties[brand]?.get(name);
	}
	const callee = fn.kernel.operandAt(start);
	const global = coreHostGlobalName(program, fn, callee);
	if (global === "fetch") return HOST_OBJECT_RESULTS.fetch;
	if (global !== undefined)
		return (
			GLOBAL_HOST_FUNCTION_RESULTS.get(global) ??
			GLOBAL_HOST_ABSTRACT_CONSTRUCTORS.get(global)
		);
	const load = definition(fn, callee);
	if (load === undefined) return undefined;
	const method = coreHostPropertyName(program, fn, load);
	if (method === undefined) return undefined;
	const receiver = fn.kernel.operandAt(start + 1);
	if (receiver !== fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)))
		return undefined;
	const globalReceiver = coreHostGlobalName(program, fn, receiver);
	const namespace =
		globalReceiver === undefined
			? undefined
			: GLOBAL_HOST_NAMESPACE_RESULTS.get(globalReceiver);
	if (namespace !== undefined) return namespace.get(method);
	const constructor = hostConstructor(program, fn, receiver, slots);
	if (constructor !== undefined)
		return HOST_OBJECT_RESULTS.statics[constructor]?.get(method);
	const brand = hostReceiver(
		program,
		fn,
		receiver,
		slots,
		budget - 1,
		parameters,
		platformResult,
	);
	return brand === undefined ? undefined : HOST_OBJECT_RESULTS.methods[brand].get(method);
}

export function coreHostCallbackMemberCandidate(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const opcode = fn.instructionOpcodeName(instruction);
	const start = fn.kernel.instructionOperandStart(instruction);
	const load =
		opcode === "call"
			? definition(fn, fn.kernel.operandAt(start))
			: opcode === "loadProperty" || opcode === "loadPropertyStatic"
				? instruction
				: undefined;
	if (load === undefined) return false;
	const name = coreHostPropertyName(program, fn, load);
	if (name === undefined || !CALLBACK_RECEIVER_MEMBERS.has(name)) return false;
	const receiver = fn.kernel.operandAt(fn.kernel.instructionOperandStart(load));
	for (let index = 0; index < fn.parameterCount; index++) {
		if (receiver === fn.kernel.functionParameter(index)) return true;
	}
	return false;
}

export function coreHostCallbackReceivers(
	program: CoreProgram,
	context: CoreCompilationContext,
	targets: CoreProgramFlowTargetIndex,
	slots: CoreHostSlots | undefined,
): CoreHostCallbackReceivers {
	const receivers = new Map<CoreFunctionId, ReadonlyMap<CoreValueId, HostObjectKind>>();
	const nodeTest = context.data.sourceBuiltinProviders?.some(
		({ id }) => id === "node:test",
	);
	if (
		!nodeTest &&
		!context.data.sourceFiles.some(({ contents }) =>
			/\b(?:ReadableStream|WritableStream|TransformStream|stream\/web|PerformanceObserver|perf_hooks)\b/.test(
				contents,
			),
		)
	)
		return receivers;
	const created = new Map<CoreFunctionId, number>();
	const called = new Set<CoreFunctionId>();
	const calledOutsideNodeTest = new Set<CoreFunctionId>();
	for (const id of targets.graph.functions) {
		const fn = program.function(id);
		for (const site of targets.outgoing(id)) {
			for (const target of site.targets.functions) {
				called.add(target);
				if (nodeTest && fn.metadata.canonicalPlatformSource !== "node:test")
					calledOutsideNodeTest.add(target);
			}
		}
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "createFunction") {
				const index = fn.instructionAttributes(instruction).functionIndex;
				if (typeof index === "number") {
					const target = coreFunctionId(index);
					created.set(target, (created.get(target) ?? 0) + 1);
				}
			}
			if (
				nodeTest &&
				opcode === "call" &&
				fn.instructionAttributes(instruction).argumentMode === undefined
			) {
				const contract = corePlatformSourceResult(
					program,
					fn,
					instruction,
					targets,
					context,
				);
				if (contract?.kind === "resolve" && contract.testContextArguments !== undefined) {
					const start = fn.kernel.instructionOperandStart(instruction) + 2;
					const count = fn.kernel.instructionOperandCount(instruction) - 2;
					for (const index of contract.testContextArguments) {
						if (index >= count) break;
						const callback = privateCallback(fn, fn.kernel.operandAt(start + index));
						if (callback !== undefined && callback.parameterCount !== 0)
							receivers.set(
								callback.id,
								new Map([[callback.kernel.functionParameter(0), "NodeTestContext"]]),
							);
					}
				}
			}
			if (opcode !== "construct" || fn.kernel.instructionOperandCount(instruction) < 2)
				continue;
			const start = fn.kernel.instructionOperandStart(instruction);
			const kind = hostConstructor(program, fn, fn.kernel.operandAt(start), slots);
			if (kind === "PerformanceObserver") {
				const callback = privateCallback(fn, fn.kernel.operandAt(start + 1));
				if (callback !== undefined && callback.parameterCount > 0)
					receivers.set(
						callback.id,
						new Map([
							[callback.kernel.functionParameter(0), "PerformanceObserverEntryList"],
						]),
					);
				continue;
			}
			if (
				kind !== "ReadableStream" &&
				kind !== "WritableStream" &&
				kind !== "TransformStream"
			)
				continue;
			// The callback can only run with a native controller if the runtime is
			// the only observer of the options and of the original callable.
			const options = privateDefinition(
				fn,
				fn.kernel.operandAt(start + 1),
				"createObjectShaped",
			);
			if (options === undefined) continue;
			const keys = fn.instructionAttributes(options).keyStringIndices;
			if (!Array.isArray(keys) || new Set(keys).size !== keys.length) continue;
			const opts = new Map(
				keys.map((key: number, i) => [
					program.stringConstantText(key),
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(options) + i),
				]),
			);
			const callbacks = new Map<string, CoreFunctionStore>();
			for (const [key, value] of opts) {
				if (key === "type") continue;
				const callback = privateCallback(fn, value);
				if (!STREAM_CALLBACK_KEYS.has(key) || callback === undefined) break;
				// The host passes the literal as `this`. A hook that can recover
				// that object can retrieve and invoke its own or another hook.
				if (
					[...callback.instructionIds()].some((id) => {
						if (callback.instructionKind(id) !== "operation") return false;
						const op = callback.instructionOpcodeName(id);
						return op === "loadThis" || op === "loadCallee";
					})
				)
					break;
				callbacks.set(key, callback);
			}
			if (callbacks.size !== opts.size - Number(opts.has("type"))) continue;
			let controller: HostObjectKind;
			if (kind === "ReadableStream") {
				const type = opts.get("type");
				if (type === undefined) controller = "ReadableStreamDefaultController";
				else {
					const constant = definition(fn, type);
					if (
						constant === undefined ||
						fn.instructionOpcodeName(constant) !== "createString"
					)
						continue;
					const index = fn.instructionAttributes(constant).stringIndex;
					if (typeof index !== "number" || program.stringConstantText(index) !== "bytes")
						continue;
					controller = "ReadableByteStreamController";
				}
			} else if (kind === "WritableStream")
				controller = "WritableStreamDefaultController";
			else controller = "TransformStreamDefaultController";
			for (const [key, index] of Object.entries(STREAM_CALLBACKS[kind])) {
				const callback = callbacks.get(key);
				if (callback !== undefined && callback.parameterCount > index)
					receivers.set(
						callback.id,
						new Map([[callback.kernel.functionParameter(index), controller]]),
					);
			}
		}
	}
	for (const target of receivers.keys()) {
		const brand = receivers.get(target)?.values().next().value;
		if (
			created.get(target) !== 1 ||
			(brand === "NodeTestContext" ? calledOutsideNodeTest : called).has(target)
		)
			receivers.delete(target);
	}
	return receivers;

	function privateCallback(fn: CoreFunctionStore, value: CoreValueId) {
		const closure = privateDefinition(fn, value, "createFunction");
		if (closure === undefined) return undefined;
		const index = fn.instructionAttributes(closure).functionIndex;
		return typeof index === "number" && program.hasFunction(coreFunctionId(index))
			? program.function(coreFunctionId(index))
			: undefined;
	}
}

function privateDefinition(fn: CoreFunctionStore, value: CoreValueId, opcode: string) {
	if (fn.valueUseCount(value) !== 1 || fn.kernel.valueHandlerUseCount(value) !== 0)
		return undefined;
	const instruction = definition(fn, value);
	return instruction !== undefined && fn.instructionOpcodeName(instruction) === opcode
		? instruction
		: undefined;
}

/** Installed Web bindings are mutable. A closed source can establish that no
 * operation in the image changes the bindings or member lookups used here. */
export function coreHostMemberIdentitiesAreStable(
	program: CoreProgram,
	context: CoreCompilationContext,
	targets: CoreProgramFlowTargetIndex,
	parameters: CoreHostCallbackReceivers,
): boolean {
	const { data, facts } = context;
	if (
		!targets.sourceClosed ||
		facts.world.primordialPolicy !== "locked" ||
		facts.world.eval !== "disabled" ||
		facts.world.realms ||
		data.inheritsHostComponents ||
		data.moduleLinks !== undefined ||
		data.hostInstallCandidates.some(
			({ installer }) => !SCANNED_HOST_INSTALLERS.has(installer),
		) ||
		data.sourceBuiltinProviders?.some(
			({ functionIndex, id }) =>
				!program.hasFunction(coreFunctionId(functionIndex)) ||
				program.function(coreFunctionId(functionIndex)).metadata
					.canonicalPlatformSource !== id ||
				!PLATFORM_SOURCE_EXPORTS.has(id),
		) ||
		(!data.hostInstallCandidates.some(({ exports }) => exports.length !== 0) &&
			!data.sourceFiles.some(({ contents }) => HOST_OBJECT_SOURCE_NAMES.test(contents)))
	)
		return false;
	const slots = coreHostResultSlots(context);
	const hasTls = data.hostInstallCandidates.some(
		({ installer }) => installer === "mal_host_install_node_tls",
	);
	for (const id of targets.graph.functions) {
		const fn = program.function(id);
		const sites = new Map(targets.outgoing(id).map((site) => [site.instruction, site]));
		const platformResult = (instruction: CoreInstructionId) =>
			corePlatformSourceResult(program, fn, instruction, targets, context);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			// Packaged platform routines initialize private state. A copy of an
			// application operation still needs its own mutation proof.
			const platform = fn.metadata.canonicalPlatformSource;
			if (platform !== undefined && PLATFORM_SOURCE_EXPORTS.has(platform)) {
				const position = fn.instructionSourcePosition(instruction);
				const inlined =
					position === undefined
						? undefined
						: program.sourcePositionAt(position)?.inlinedFunctionIndex;
				if (inlined === undefined) continue;
				const origin = coreFunctionId(inlined);
				if (
					program.hasFunction(origin) &&
					program.function(origin).metadata.canonicalPlatformSource === platform
				)
					continue;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			const attrs = fn.instructionAttributes(instruction);
			if (
				opcode === "loadGlobal" &&
				NATIVE_OBJECT_WRITERS.has(coreHostSlotName(fn, instruction, slots) ?? "")
			)
				return false;
			if (
				hasTls &&
				opcode === "loadGlobal" &&
				TLS_MUTATOR_ROUTES.has(coreHostSlotName(fn, instruction, slots) ?? "") &&
				!usedOnlyAsCallee(fn, instruction)
			)
				return false;
			if (
				opcode === "loadGlobal" &&
				coreHostSlotName(fn, instruction, slots) === "promisify" &&
				!usedOnlyAsCallee(fn, instruction, program)
			)
				return false;
			if (opcode === "loadPrimordial" && typeof attrs.nodeIndex === "number") {
				const name = getPrimordialCatalog().nodes[attrs.nodeIndex]?.[0];
				if (
					name !== undefined &&
					(name.startsWith("Object.") || name.startsWith("Reflect.")) &&
					REFLECTIVE_WRITERS.has(name.slice(name.lastIndexOf(".") + 1))
				)
					return false;
			}
			if (opcode === "loadProperty" || opcode === "loadPropertyStatic") {
				const key = coreHostPropertyName(program, fn, instruction);
				if (key === undefined) {
					const keyProducer =
						opcode === "loadProperty"
							? definition(
									fn,
									fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
								)
							: undefined;
					const keyOpcode =
						keyProducer === undefined ? undefined : fn.instructionOpcodeName(keyProducer);
					if (
						keyOpcode !== "createNumber" &&
						keyOpcode !== "createF64" &&
						coreHostCapturedSymbolKey(program, fn, instruction, slots) === undefined
					)
						return false;
				} else if (NATIVE_OBJECT_WRITERS.has(key)) return false;
				else if (
					REFLECTIVE_WRITERS.has(key) ||
					key === "promisify" ||
					(hasTls && TLS_MUTATOR_ROUTES.has(key))
				) {
					// Host callbacks can invoke a native writer without a source call site.
					if (
						!usedOnlyAsCallee(fn, instruction, key === "promisify" ? program : undefined)
					)
						return false;
				}
			}
			const protectedKey = (index: unknown, implicitGlobal = false) => {
				if (typeof index !== "number") return true;
				const start = fn.kernel.instructionOperandStart(instruction);
				const receiver = implicitGlobal
					? undefined
					: definition(fn, fn.kernel.operandAt(start));
				const global =
					implicitGlobal ||
					(receiver !== undefined &&
						fn.instructionOpcodeName(receiver) === "loadIntrinsic" &&
						fn.instructionAttributes(receiver).intrinsic === "globalThis");
				return (global ? PROTECTED_GLOBALS : PROTECTED_PROPERTIES).has(
					program.stringConstantText(index),
				);
			};
			if (
				opcode === "storeGlobalProperty" ||
				opcode === "declareGlobalLexical" ||
				(opcode === "globalBindingQuery" && attrs.query === "delete") ||
				opcode === "storePropertyStatic"
			) {
				const key =
					opcode === "storePropertyStatic" ? attrs.stringIndex : attrs.nameStringIndex;
				if (protectedKey(key, opcode !== "storePropertyStatic")) return false;
			} else if (opcode === "storeProperty" || opcode === "defineProperty") {
				const key = definition(
					fn,
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
				);
				if (key === undefined) return false;
				const keyOpcode = fn.instructionOpcodeName(key);
				switch (keyOpcode) {
					case "createNumber":
					case "createF64":
						break;
					case "createString": {
						const index = fn.instructionAttributes(key).stringIndex;
						if (protectedKey(index)) return false;
						break;
					}
					default:
						return false;
				}
			} else if (
				opcode === "setPrototype" ||
				opcode === "storeSuperProperty" ||
				opcode === "defineAccessor" ||
				opcode === "deleteProperty" ||
				opcode === "mergeDataProperties" ||
				opcode === "withEnter" ||
				opcode === "initGlobalVars"
			)
				return false;
			if (
				opcode !== "callKnown" &&
				fn.registry.byId(fn.instructionOpcode(instruction)).callTransfer === undefined
			)
				continue;
			const site = sites.get(instruction);
			const callee = site?.targets;
			if (
				callee !== undefined &&
				!callee.opaque &&
				!callee.anyScript &&
				callee.functions.length > 0
			)
				continue;
			if (opcode === "call") {
				const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
				const producer = definition(fn, value);
				if (
					producer !== undefined &&
					fn.instructionOpcodeName(producer) === "loadIntrinsic"
				) {
					const name = fn.instructionAttributes(producer).intrinsic;
					if (typeof name === "string" && MODULE_EVALUATORS.has(name)) continue;
				}
				const name =
					coreHostGlobalName(program, fn, value) ??
					(producer === undefined
						? undefined
						: (coreHostSlotName(fn, producer, slots) ??
							coreHostPropertyName(program, fn, producer)));
				const callbackIndex =
					name === undefined ? undefined : HOST_CALLBACK_ARGUMENTS.get(name);
				if (callbackIndex !== undefined) {
					const argument = (site?.arguments ?? site?.argumentPrefix)?.[callbackIndex];
					if (argument !== undefined) {
						const callback = targets.targets?.(id, argument);
						if (callback === undefined || callback.opaque || callback.anyScript)
							return false;
					} else if (site?.arguments === undefined) return false;
				}
				if (
					name === "promisify" &&
					coreHostCapturedPromisifiedValue(program, fn, instruction, slots) === undefined
				)
					return false;
				if (hasTls && name !== undefined && TLS_MUTATOR_ROUTES.has(name)) {
					if (
						name !== "connect" ||
						coreHostResult(program, fn, instruction, slots, true, true)?.immediate
							.hostObject !== "TlsSocket"
					)
						return false;
				}
			}
			if (
				opcode === "construct" &&
				fn.kernel.instructionOperandCount(instruction) === 1
			) {
				const producer = definition(
					fn,
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
				);
				if (
					producer !== undefined &&
					fn.instructionOpcodeName(producer) === "loadPrimordial"
				) {
					const { nodeIndex } = fn.instructionAttributes(producer);
					const name =
						typeof nodeIndex === "number"
							? getPrimordialCatalog().nodes[nodeIndex]?.[0]
							: undefined;
					if (coreNumericTypedArrayKind(name) !== undefined || name === "ArrayBuffer")
						continue;
				}
			}
			if (
				opcode === "callKnown" &&
				attrs.construct === true &&
				attrs.knownBuiltinCall !== undefined &&
				fn.kernel.instructionOperandCount(instruction) === 1 &&
				(coreNumericTypedArrayKind(attrs.operation) !== undefined ||
					attrs.operation === "ArrayBuffer")
			)
				continue;
			const promise = coreIntrinsicPromiseStaticCall(fn, instruction);
			if (promise?.operation === "Promise.reject") continue;
			if (promise?.operation === "Promise.resolve") {
				const value = promise.firstArgument;
				const source = value === undefined ? undefined : definition(fn, value);
				if (
					value === undefined ||
					(source !== undefined &&
						PRIMITIVE_PRODUCERS.has(fn.instructionOpcodeName(source)))
				)
					continue;
			}
			if (
				coreHostObjectResult(
					program,
					fn,
					instruction,
					slots,
					parameters.get(id),
					platformResult,
				) === undefined &&
				platformResult(instruction) === undefined &&
				coreHostResult(program, fn, instruction, slots, true, true) === undefined
			)
				return false;
		}
	}
	return true;
}
function usedOnlyAsCallee(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	symbolOwner?: CoreProgram,
): boolean {
	const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
	if (fn.kernel.valueHandlerUseCount(value) !== 0) return false;
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		const consumer = fn.kernel.useInstruction(use);
		if (
			symbolOwner !== undefined &&
			fn.kernel.useOperand(use) === 0 &&
			fn.instructionKind(consumer) === "operation" &&
			coreHostPropertyName(symbolOwner, fn, consumer) === "custom"
		)
			continue;
		if (
			fn.kernel.useOperand(use) !== 0 ||
			fn.instructionKind(consumer) !== "operation" ||
			fn.instructionOpcodeName(consumer) !== "call"
		)
			return false;
	}
	return true;
}
