import { COMPILER_VALUE_KIND_OBJECT } from "../shared/compiler-value-kinds.ts";
import {
	DISK_HANDLE_RESULTS,
	NODE_FILE_HANDLE_RESULTS,
	GLOBAL_HOST_CONSTRUCTORS,
	GLOBAL_HOST_FUNCTION_RESULTS,
	GLOBAL_HOST_NAMESPACE_RESULTS,
	GLOBAL_HOST_OBJECT_BRANDS,
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
	coreDiskHandleResult,
	coreHostDirectCallContract,
	coreHostPropertyName,
	coreHostResult,
	coreHostResultSlots,
	coreHostSlotValue,
} from "./core-host-results.ts";
import type { CoreHostSlots } from "./core-host-results.ts";
import { coreFunctionId, coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreProgramFlowTargetIndex } from "./core-program-flow.ts";
import { coreSuccessfulAwaitInput } from "./core-promise-facts.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

type GlobalHostConstructor = (typeof GLOBAL_HOST_CONSTRUCTORS)[number];
const GLOBAL_HOST_CONSTRUCTOR_NAMES = new Set<string>(GLOBAL_HOST_CONSTRUCTORS);
const PROTECTED_GLOBALS = new Set<string>([
	...GLOBAL_HOST_CONSTRUCTORS,
	...GLOBAL_HOST_FUNCTION_RESULTS.keys(),
	...GLOBAL_HOST_NAMESPACE_RESULTS.keys(),
	...GLOBAL_HOST_OBJECT_BRANDS.keys(),
	"fetch",
	"globalThis",
	"__proto__",
]);
const HOST_OBJECT_SOURCE_NAMES = new RegExp(
	`\\b(?:${[...PROTECTED_GLOBALS].filter((name) => name !== "globalThis" && name !== "console" && name !== "__proto__").join("|")}|fs|node:sqlite|(?:node:)?(?:stream/web|async_hooks|events|timers/promises|url)|basename|StringDecoder|MIMEType|MIMEParams)\\b`,
);
const PROTECTED_PROPERTIES = new Set([
	...PROTECTED_GLOBALS,
	"prototype",
	"promises",
	"posix",
	"win32",
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
	...NODE_FILE_HANDLE_RESULTS.methods.keys(),
	...NODE_FILE_HANDLE_RESULTS.properties.keys(),
	...Object.values(DISK_HANDLE_RESULTS).flatMap(({ methods, properties }) => [
		...methods.keys(),
		...properties.keys(),
	]),
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
const SCANNED_HOST_INSTALLERS = new Set([
	"mal_host_install_node_fs",
	"mal_host_install_node_fs_promises",
	"mal_host_install_node_path",
	"mal_host_install_node_path_posix",
	"mal_host_install_node_path_win32",
	"mal_host_install_node_os",
	"mal_host_install_node_buffer",
	"mal_host_install_node_crypto",
	"mal_host_install_node_url",
	"mal_host_install_node_util",
	"mal_host_install_node_sys",
	"mal_host_install_node_sqlite",
	"mal_host_install_node_stream_web",
	"mal_host_install_node_string_decoder",
	"mal_host_install_node_timers",
	"mal_host_install_node_timers_promises",
	"mal_host_install_node_events",
	"mal_host_install_node_async_hooks",
	"mal_host_install_maligator_internal_fetch",
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

function globalName(program: CoreProgram, fn: CoreFunctionStore, value: CoreValueId) {
	const load = definition(fn, value);
	if (load === undefined) return undefined;
	const opcode = fn.instructionOpcodeName(load);
	const attributes = fn.instructionAttributes(load);
	if (opcode === "loadGlobalProperty")
		return typeof attributes.nameStringIndex === "number"
			? program.stringConstantText(attributes.nameStringIndex)
			: undefined;
	if (opcode !== "loadPropertyStatic" || typeof attributes.stringIndex !== "number")
		return undefined;
	const parent = definition(
		fn,
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)),
	);
	return parent !== undefined &&
		fn.instructionOpcodeName(parent) === "loadIntrinsic" &&
		fn.instructionAttributes(parent).intrinsic === "globalThis"
		? program.stringConstantText(attributes.stringIndex)
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
	const name = globalName(program, fn, value);
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
): HostObjectKind | undefined {
	if (budget === 0) return undefined;
	const producer = definition(fn, value);
	if (producer === undefined) return undefined;
	const global = globalName(program, fn, value);
	const globalBrand =
		global === undefined ? undefined : GLOBAL_HOST_OBJECT_BRANDS.get(global);
	if (globalBrand !== undefined) return globalBrand;
	const installed =
		slots === undefined ? undefined : coreHostSlotValue(program, fn, value, slots);
	if (installed?.installedObject === true) return installed.hostObject;
	if (fn.instructionOpcodeName(producer) !== "awaitFulfilled") {
		const result = producerContract(producer);
		return result?.kind === "return" ? result.value.hostObject : undefined;
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
	return result?.kind === "resolve" || result?.kind === "fulfill"
		? result.value.hostObject
		: undefined;

	function producerContract(producer: CoreInstructionId) {
		return (
			coreHostObjectResult(program, fn, producer, slots, budget) ??
			(slots === undefined
				? undefined
				: coreHostDirectCallContract(program, fn, producer, slots, 0, true))
		);
	}
}

export function coreHostObjectResult(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	slots?: CoreHostSlots,
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
		const brand = hostConstructor(program, fn, fn.kernel.operandAt(start), slots);
		return brand === undefined
			? undefined
			: {
					kind: "return",
					value: { mask: COMPILER_VALUE_KIND_OBJECT, hostObject: brand },
				};
	}
	if (opcode === "loadPropertyStatic" || opcode === "loadProperty") {
		const name = coreHostPropertyName(program, fn, instruction);
		if (name === undefined) return undefined;
		const brand = hostReceiver(
			program,
			fn,
			fn.kernel.operandAt(start),
			slots,
			budget - 1,
		);
		return brand === undefined
			? undefined
			: HOST_OBJECT_RESULTS.properties[brand]?.get(name);
	}
	const callee = fn.kernel.operandAt(start);
	const global = globalName(program, fn, callee);
	if (global === "fetch") return HOST_OBJECT_RESULTS.fetch;
	if (global !== undefined) return GLOBAL_HOST_FUNCTION_RESULTS.get(global);
	const load = definition(fn, callee);
	if (load === undefined) return undefined;
	const method = coreHostPropertyName(program, fn, load);
	if (method === undefined) return undefined;
	const receiver = fn.kernel.operandAt(start + 1);
	if (receiver !== fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)))
		return undefined;
	const globalReceiver = globalName(program, fn, receiver);
	const namespace =
		globalReceiver === undefined
			? undefined
			: GLOBAL_HOST_NAMESPACE_RESULTS.get(globalReceiver);
	if (namespace !== undefined) return namespace.get(method);
	const constructor = hostConstructor(program, fn, receiver, slots);
	if (constructor !== undefined)
		return HOST_OBJECT_RESULTS.statics[constructor]?.get(method);
	const brand = hostReceiver(program, fn, receiver, slots, budget - 1);
	return brand === undefined ? undefined : HOST_OBJECT_RESULTS.methods[brand].get(method);
}

/** Installed Web bindings are mutable. A closed source can establish that no
 * operation in the image changes the bindings or member lookups used here. */
export function coreHostMemberIdentitiesAreStable(
	program: CoreProgram,
	context: CoreCompilationContext,
	targets: CoreProgramFlowTargetIndex,
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
		(data.sourceBuiltinProviders?.length ?? 0) !== 0 ||
		!data.sourceFiles.some(({ contents }) => HOST_OBJECT_SOURCE_NAMES.test(contents))
	)
		return false;
	const slots = coreHostResultSlots(context);
	for (const id of targets.graph.functions) {
		const fn = program.function(id);
		const sites = new Map(targets.outgoing(id).map((site) => [site.instruction, site]));
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			// Packaged filesystem code initializes private prototypes. An inlined
			// application's operation still needs its own mutation proof.
			if (fn.metadata.canonicalPlatformSource === "maligator:fs") {
				const position = fn.instructionSourcePosition(instruction);
				const inlined =
					position === undefined
						? undefined
						: program.sourcePositionAt(position)?.inlinedFunctionIndex;
				if (inlined === undefined) continue;
				const origin = coreFunctionId(inlined);
				if (
					program.hasFunction(origin) &&
					program.function(origin).metadata.canonicalPlatformSource === "maligator:fs"
				)
					continue;
			}
			const opcode = fn.instructionOpcodeName(instruction);
			const attrs = fn.instructionAttributes(instruction);
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
					if (
						keyProducer === undefined ||
						(fn.instructionOpcodeName(keyProducer) !== "createNumber" &&
							fn.instructionOpcodeName(keyProducer) !== "createF64")
					)
						return false;
				} else if (REFLECTIVE_WRITERS.has(key)) {
					// Host callbacks can invoke a native writer without a source call site.
					const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
					if (fn.kernel.valueHandlerUseCount(value) !== 0) return false;
					for (
						let use = fn.kernel.valueFirstUse(value);
						use >= 0;
						use = fn.kernel.useNext(use)
					) {
						if (fn.kernel.useLive(use) === 0) continue;
						const consumer = fn.kernel.useInstruction(use);
						if (
							fn.kernel.useOperand(use) !== 0 ||
							fn.instructionKind(consumer) !== "operation" ||
							fn.instructionOpcodeName(consumer) !== "call"
						)
							return false;
					}
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
			const callee = sites.get(instruction)?.targets;
			if (
				callee !== undefined &&
				!callee.opaque &&
				!callee.anyScript &&
				callee.functions.length > 0
			)
				continue;
			if (opcode === "call") {
				const producer = definition(
					fn,
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
				);
				if (
					producer !== undefined &&
					fn.instructionOpcodeName(producer) === "loadIntrinsic"
				) {
					const name = fn.instructionAttributes(producer).intrinsic;
					if (typeof name === "string" && MODULE_EVALUATORS.has(name)) continue;
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
			if (
				coreHostObjectResult(program, fn, instruction, slots) === undefined &&
				coreDiskHandleResult(program, fn, instruction, targets, context) === undefined &&
				coreHostResult(program, fn, instruction, slots, true, true) === undefined
			)
				return false;
		}
	}
	return true;
}
