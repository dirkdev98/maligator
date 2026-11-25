import {
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import {
	WEB_FETCH_CONSTRUCTORS,
	WEB_FETCH_RESULTS,
} from "../shared/host-result-contracts.ts";
import type {
	HostResultContract,
	WebFetchInstance,
} from "../shared/host-result-contracts.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreProgramFlowTargetIndex } from "./core-program-flow.ts";
import { coreSuccessfulAwaitInput } from "./core-promise-facts.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

type FetchConstructor = (typeof WEB_FETCH_CONSTRUCTORS)[number];
const FETCH_CONSTRUCTOR_NAMES = new Set<string>(WEB_FETCH_CONSTRUCTORS);
const PROTECTED_PROPERTIES = new Set([
	...WEB_FETCH_CONSTRUCTORS,
	"fetch",
	"console",
	"log",
	"prototype",
	"__proto__",
	"then",
	"constructor",
	...Object.values(WEB_FETCH_RESULTS.methods).flatMap((members) => [...members.keys()]),
	...Object.values(WEB_FETCH_RESULTS.properties).flatMap((members) => [
		...members.keys(),
	]),
	...Object.values(WEB_FETCH_RESULTS.statics).flatMap((members) => [...members.keys()]),
]);
const LOGGED: HostResultContract = {
	kind: "return",
	value: { mask: COMPILER_VALUE_KIND_UNDEFINED },
};
const MODULE_EVALUATORS = new Set([
	"__evaluateModule",
	"__evaluateModuleAsync",
	"__evaluateModuleSync",
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

function fetchConstructor(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
) {
	const name = globalName(program, fn, value);
	return name !== undefined && FETCH_CONSTRUCTOR_NAMES.has(name)
		? (name as FetchConstructor)
		: undefined;
}

function fetchReceiver(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	budget: number,
): WebFetchInstance | undefined {
	if (budget === 0) return undefined;
	const producer = definition(fn, value);
	if (producer === undefined) return undefined;
	if (fn.instructionOpcodeName(producer) !== "awaitFulfilled") {
		const result = coreWebFetchResult(program, fn, producer, budget);
		return result?.kind === "return" ? result.value.webInstance : undefined;
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
	const result = coreWebFetchResult(program, fn, call, budget);
	return result?.kind === "resolve" || result?.kind === "fulfill"
		? result.value.webInstance
		: undefined;
}

function propertyName(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
) {
	const opcode = fn.instructionOpcodeName(instruction);
	if (opcode === "loadPropertyStatic") {
		const index = fn.instructionAttributes(instruction).stringIndex;
		return typeof index === "number" ? program.stringConstantText(index) : undefined;
	}
	if (opcode === "loadProperty") {
		const key = definition(
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
		);
		if (key !== undefined && fn.instructionOpcodeName(key) === "loadPrimordial") {
			const index = fn.instructionAttributes(key).nodeIndex;
			if (
				typeof index === "number" &&
				getPrimordialCatalog().nodes[index]?.[0] === "%Symbol.iterator%"
			)
				return "[Symbol.iterator]";
		}
	}
	return undefined;
}

export function coreWebFetchResult(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
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
		const brand = fetchConstructor(program, fn, fn.kernel.operandAt(start));
		return brand === undefined
			? undefined
			: {
					kind: "return",
					value: { mask: COMPILER_VALUE_KIND_OBJECT, webInstance: brand },
				};
	}
	if (opcode === "loadPropertyStatic" || opcode === "loadProperty") {
		const name = propertyName(program, fn, instruction);
		if (name === undefined) return undefined;
		const brand = fetchReceiver(program, fn, fn.kernel.operandAt(start), budget - 1);
		return brand === undefined
			? undefined
			: WEB_FETCH_RESULTS.properties[brand]?.get(name);
	}
	const callee = fn.kernel.operandAt(start);
	if (globalName(program, fn, callee) === "fetch") return WEB_FETCH_RESULTS.fetch;
	const load = definition(fn, callee);
	if (load === undefined) return undefined;
	const method = propertyName(program, fn, load);
	if (method === undefined) return undefined;
	const receiver = fn.kernel.operandAt(start + 1);
	if (receiver !== fn.kernel.operandAt(fn.kernel.instructionOperandStart(load)))
		return undefined;
	if (method === "log" && globalName(program, fn, receiver) === "console") return LOGGED;
	const constructor = fetchConstructor(program, fn, receiver);
	if (constructor !== undefined)
		return WEB_FETCH_RESULTS.statics[constructor]?.get(method);
	const brand = fetchReceiver(program, fn, receiver, budget - 1);
	return brand === undefined ? undefined : WEB_FETCH_RESULTS.methods[brand].get(method);
}

/** Installed Web bindings are mutable. A closed source can establish that no
 * operation in the image changes the bindings or member lookups used here. */
export function coreWebFetchIdentityIsStable(
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
		data.hostInstallCandidates.length !== 0 ||
		(data.sourceBuiltinProviders?.length ?? 0) !== 0 ||
		!data.sourceFiles.some(({ contents }) =>
			/\b(?:fetch|Response|Request|Blob|File|FormData|Headers)\b/.test(contents),
		)
	)
		return false;
	for (const id of targets.graph.functions) {
		const fn = program.function(id);
		const sites = new Map(targets.outgoing(id).map((site) => [site.instruction, site]));
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			const attrs = fn.instructionAttributes(instruction);
			if (
				opcode === "storeGlobalProperty" ||
				opcode === "declareGlobalLexical" ||
				(opcode === "globalBindingQuery" && attrs.query === "delete") ||
				opcode === "storePropertyStatic"
			) {
				const key =
					opcode === "storePropertyStatic" ? attrs.stringIndex : attrs.nameStringIndex;
				if (
					typeof key !== "number" ||
					PROTECTED_PROPERTIES.has(program.stringConstantText(key))
				)
					return false;
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
						if (
							typeof index !== "number" ||
							PROTECTED_PROPERTIES.has(program.stringConstantText(index))
						)
							return false;
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
			if (coreWebFetchResult(program, fn, instruction) === undefined) return false;
		}
	}
	return true;
}
