import {
	builtinOperations,
	exactBuiltinCallDescriptor,
	mathUnaryOperationKeys,
} from "./builtin-registry.ts";
import type {
	CompilerOptimizationDecision,
	OptimizationAblation,
	OptimizationDecisionReason,
	OptimizationMetrics,
	OptimizationPassDelta,
} from "./compiler-diagnostics.ts";
import {
	compilerGuardPlan,
	compilerFactIsWorldInvariant,
	knownFact,
	sourceSiteId,
} from "./compiler-facts.ts";
import { buildCoreControlFlow, coreTerminatorEdges } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { removeUnreachableCoreBlocks } from "./core-ir-normalize.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { verifyCoreFunction } from "./core-ir-verifier.ts";
import type {
	CoreBlock,
	CoreBlockId,
	CoreAttributeValue,
	CoreEdge,
	CoreFunction,
	CoreImmediate,
	CoreInstruction,
	CoreInstructionId,
	CoreProgram,
	CoreTerminator,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId, coreValueId } from "./core-ir.ts";

export interface CoreOptimizationOptions {
	readonly maxRounds?: number;
	readonly ablations?: ReadonlySet<OptimizationAblation>;
	/** Run Core's value simplifiers. Disable only while importing an already optimized graph. */
	readonly simplifyValues?: boolean;
}

const ALLOCATION_OPCODES = new Set([
	"createObject",
	"createObjectShaped",
	"createArray",
	"instantiateLiteralTemplate",
	"createFunction",
	"createArgumentsObject",
	"createRestArguments",
	"createModuleNamespace",
	"createTemplateObject",
	"createBigint",
]);

const DYNAMIC_CALL_OPCODES = new Set([
	"callSpread",
	"callSpreadIterable",
	"constructSpread",
	"constructSuper",
	"constructSuperExplicit",
]);

const BOXED_OPERATION_OPCODES = new Set([
	"binary",
	"unary",
	"toPropertyKey",
	"requireCoercible",
]);

const PROPERTY_HELPER_OPCODES = new Set([
	"loadProperty",
	"loadPropertyStatic",
	"storeProperty",
	"storePropertyStatic",
	"deleteProperty",
	"loadSuperProperty",
	"storeSuperProperty",
	"loadPrototype",
	"setPrototype",
	"loadGlobalProperty",
	"storeGlobalProperty",
	"copyDataProperties",
	"mergeDataProperties",
	"defineProperty",
]);

function attributeObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function coreAttribute(value: unknown, path: string): CoreAttributeValue {
	if (
		value === undefined ||
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((entry, index) => coreAttribute(entry, `${path}[${index}]`));
	}
	if (typeof value !== "object") {
		throw new Error(`Unsupported Core attribute ${path}: ${typeof value}`);
	}
	return coreAttributeObject(value as Readonly<Record<string, unknown>>, path);
}

function coreAttributeObject(
	value: Readonly<Record<string, unknown>>,
	path: string,
): Readonly<Record<string, CoreAttributeValue>> {
	const result: Record<string, CoreAttributeValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		result[key] = coreAttribute(entry, `${path}.${key}`);
	}
	return result;
}

function knownBuiltinIdentity(instruction: CoreInstruction): boolean {
	const call = attributeObject(instruction.attributes.knownBuiltinCall);
	const identity = attributeObject(call?.identity);
	return identity?.kind === "known";
}

function isDynamicCall(instruction: CoreInstruction): boolean {
	if (DYNAMIC_CALL_OPCODES.has(instruction.opcode)) return true;
	if (instruction.opcode === "construct") {
		return instruction.attributes.directFunctionIndex === undefined;
	}
	if (instruction.opcode !== "call") return false;
	return (
		instruction.attributes.directFunctionIndex === undefined &&
		instruction.attributes.directCallTargetFunctionIndex === undefined &&
		!knownBuiltinIdentity(instruction)
	);
}

function carriesWorldGuard(instruction: CoreInstruction): boolean {
	if (instruction.opcode === "guardFunctionIndex") return true;
	if (instruction.opcode !== "call") return false;
	const call = attributeObject(instruction.attributes.knownBuiltinCall);
	const identity = attributeObject(call?.identity);
	if (identity?.kind !== "known") return false;
	const proof = attributeObject(identity.proof);
	const dependencies = Array.isArray(proof?.dependencies) ? proof.dependencies : [];
	const obligations = Array.isArray(proof?.obligations) ? proof.obligations : [];
	return (
		dependencies.some((dependency) => {
			const kind = attributeObject(dependency)?.kind;
			return kind === "epoch" || kind === "guard";
		}) ||
		obligations.some((obligation) => attributeObject(obligation)?.kind === "fallback")
	);
}

/** Measure the residual Core program itself, never a reconstructed frontend graph. */
export function coreOptimizationMetrics(program: CoreProgram): OptimizationMetrics {
	const metrics = {
		allocationSites: 0,
		dynamicCalls: 0,
		boxedOperations: 0,
		propertyHelpers: 0,
		worldGuards: 0,
		safepoints: 0,
	};
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (ALLOCATION_OPCODES.has(instruction.opcode)) metrics.allocationSites++;
				if (isDynamicCall(instruction)) metrics.dynamicCalls++;
				if (BOXED_OPERATION_OPCODES.has(instruction.opcode)) metrics.boxedOperations++;
				if (PROPERTY_HELPER_OPCODES.has(instruction.opcode)) metrics.propertyHelpers++;
				if (carriesWorldGuard(instruction)) metrics.worldGuards++;
				if (coreOpcodeRegistry.require(instruction.opcode).effects.mayGc)
					metrics.safepoints++;
			}
		}
	}
	return metrics;
}

function metricDelta(
	before: OptimizationMetrics,
	after: OptimizationMetrics,
): OptimizationMetrics {
	return {
		allocationSites: after.allocationSites - before.allocationSites,
		dynamicCalls: after.dynamicCalls - before.dynamicCalls,
		boxedOperations: after.boxedOperations - before.boxedOperations,
		propertyHelpers: after.propertyHelpers - before.propertyHelpers,
		worldGuards: after.worldGuards - before.worldGuards,
		safepoints: after.safepoints - before.safepoints,
	};
}

function optimizationPassDelta(
	pass: Omit<OptimizationPassDelta, "before" | "after" | "delta">,
	before: OptimizationMetrics,
	after: OptimizationMetrics,
): OptimizationPassDelta {
	return { ...pass, before, after, delta: metricDelta(before, after) };
}

const BUILTIN_OPERATION_BY_KEY = new Map(
	builtinOperations.map((operation) => [operation.key, operation] as const),
);
const MATH_UNARY_OPERATIONS: ReadonlySet<string> = new Set(
	mathUnaryOperationKeys.map(([operation]) => operation),
);

function decodeString(program: CoreProgram, index: number): string | undefined {
	const units = program.stringConstants[index];
	return units === undefined ? undefined : String.fromCodePoint(...units);
}

function builtinSourceSite(
	program: CoreProgram,
	fn: CoreFunction,
	positionId: number | undefined,
	operation: string,
): ReturnType<typeof sourceSiteId> | undefined {
	if (positionId === undefined) return undefined;
	const position = program.sourcePositions[positionId];
	if (position === undefined) return undefined;
	const owner =
		position.inlinedFunctionIndex === undefined
			? fn
			: program.functions.find(
					(candidate) => candidate.functionIndex === position.inlinedFunctionIndex,
				);
	return owner === undefined
		? undefined
		: sourceSiteId(
				owner.metadata.sourcePath,
				position.line,
				position.column,
				`builtin-call:${operation}`,
			);
}

/**
 * Attach guarded builtin identity and semantics to an ordinary property call.
 * Static method names are globally unique in the registry. The loaded callee
 * remains an SSA input and the fact retains a fallback obligation, so mutable
 * worlds still perform the exact runtime identity check before specializing.
 */
const annotateKnownBuiltinCalls: CoreFunctionPass = {
	name: "annotate-known-builtin-calls",
	run(fn, analyses, program) {
		const compilation = program.compilation;
		if (compilation === undefined) return fn;
		const definitions = new Map<CoreValueId, CoreInstruction>();
		const canonical = coreCanonicalValues(fn, analyses.controlFlow(fn));
		const representations = new Map(
			fn.values.map(({ id, representation }) => [id, representation]),
		);
		const useCounts = new Map<CoreValueId, number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions.set(output, instruction);
				for (const input of instruction.inputs) {
					useCounts.set(input, (useCounts.get(input) ?? 0) + 1);
				}
			}
		}
		let changed = false;
		let guardOrdinal = 0;
		const removedInstructions = new Set<CoreInstructionId>();
		const removedValues = new Set<CoreValueId>();
		const numericOutputs = new Set<CoreValueId>();
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						instruction.opcode !== "call" ||
						instruction.attributes.knownBuiltinCall !== undefined ||
						instruction.inputs.length < 2
					) {
						return instruction;
					}
					const property = definitions.get(
						canonical.get(instruction.inputs[0]!) ?? instruction.inputs[0]!,
					);
					const stringIndex = property?.attributes.stringIndex;
					if (
						property?.opcode !== "loadPropertyStatic" ||
						property.inputs.length !== 1 ||
						(canonical.get(property.inputs[0]!) ?? property.inputs[0]) !==
							(canonical.get(instruction.inputs[1]!) ?? instruction.inputs[1]) ||
						typeof stringIndex !== "number"
					) {
						return instruction;
					}
					const key = decodeString(program, stringIndex);
					const descriptor =
						key === undefined ? undefined : BUILTIN_OPERATION_BY_KEY.get(key);
					if (descriptor === undefined) return instruction;
					const site = builtinSourceSite(
						program,
						fn,
						instruction.sourcePosition,
						descriptor.id,
					);
					const sharedIdentity = compilation.facts.builtinIdentities.get(descriptor.id);
					const identity =
						sharedIdentity?.kind === "known"
							? knownFact(sharedIdentity.value, {
									scope:
										site === undefined
											? { kind: "function" as const, id: fn.functionIndex }
											: { kind: "site" as const, id: site },
									dependencies: sharedIdentity.proof.dependencies,
									obligations: [
										...sharedIdentity.proof.obligations,
										{
											kind: "fallback" as const,
											id: `generic-call:${site ?? `${fn.functionIndex}:${guardOrdinal}`}`,
										},
									],
									origin: `guarded-builtin-site-analysis:${sharedIdentity.proof.origin}`,
								})
							: (sharedIdentity ?? {
									kind: "unknown" as const,
									reason: "not-analyzed" as const,
								});
					guardOrdinal++;
					changed = true;
					const knownBuiltinCall = {
						operation: descriptor.id,
						identity,
						semantics:
							identity.kind === "known"
								? knownFact(
										{
											effects: descriptor.effects,
											result: descriptor.result,
											lowerings: descriptor.lowerings,
										},
										{
											...identity.proof,
											origin: `builtin-registry-semantics:${descriptor.id}`,
										},
									)
								: identity,
						...(site === undefined ? {} : { sourceSite: site }),
					};
					const arguments_ = instruction.inputs.slice(2);
					const mathOpcode = MATH_UNARY_OPERATIONS.has(descriptor.id)
						? "mathUnaryNumber"
						: descriptor.id === "Math.min" || descriptor.id === "Math.max"
							? "mathBinaryNumber"
							: undefined;
					if (
						mathOpcode !== undefined &&
						compilerFactIsWorldInvariant(identity) &&
						descriptor.nativeNumberArity === arguments_.length &&
						arguments_.every((argument) => representations.get(argument) === "f64") &&
						instruction.outputs.length === 1
					) {
						if (
							property.outputs.length === 1 &&
							useCounts.get(property.outputs[0]!) === 1
						) {
							removedInstructions.add(property.id);
							for (const output of property.outputs) removedValues.add(output);
						}
						numericOutputs.add(instruction.outputs[0]!);
						return {
							...instruction,
							opcode: mathOpcode,
							inputs: arguments_,
							attributes: { operation: descriptor.id },
						};
					}
					const exact = exactBuiltinCallDescriptor(descriptor.id);
					const receiver = definitions.get(
						canonical.get(instruction.inputs[1]!) ?? instruction.inputs[1]!,
					);
					const exactReceiver =
						exact?.receiverProof === "primitive-string"
							? receiver?.opcode === "createString"
							: exact?.receiverProof === "intrinsic-object"
								? receiver?.opcode === "loadIntrinsic" &&
									receiver.attributes.intrinsic === descriptor.owner
								: false;
					if (
						exact !== undefined &&
						exactReceiver &&
						compilerFactIsWorldInvariant(identity) &&
						property.outputs.length === 1 &&
						useCounts.get(property.outputs[0]!) === 1
					) {
						removedInstructions.add(property.id);
						for (const output of property.outputs) removedValues.add(output);
						const forwardedArguments =
							exact.forwardedArgumentLimit === undefined
								? arguments_
								: arguments_.slice(0, exact.forwardedArgumentLimit);
						return {
							...instruction,
							opcode: "callBuiltin",
							inputs: [instruction.inputs[1]!, ...forwardedArguments],
							attributes: {
								operation: exact.id,
								knownBuiltinCall: coreAttribute(knownBuiltinCall, "knownBuiltinCall"),
							},
						};
					}
					return {
						...instruction,
						attributes: {
							...instruction.attributes,
							knownBuiltinCall: coreAttribute(knownBuiltinCall, "knownBuiltinCall"),
						},
					};
				}),
			}),
		);
		const filteredBlocks = blocks.map((block) => ({
			...block,
			instructions: block.instructions.filter(({ id }) => !removedInstructions.has(id)),
		}));
		return changed
			? {
					...fn,
					blocks: filteredBlocks,
					values: fn.values
						.filter(({ id }) => !removedValues.has(id))
						.map((value) =>
							numericOutputs.has(value.id) ? { ...value, representation: "f64" } : value,
						),
					mutationEpoch: fn.mutationEpoch + 1,
				}
			: fn;
	},
};

const MAX_INLINE_INSTRUCTIONS = 40;
const INLINE_DISQUALIFYING_OPCODES = new Set([
	"loadThis",
	"loadNewTarget",
	"loadCallee",
	"createFunction",
	"createArgumentsObject",
	"createRestArguments",
	"withEnter",
	"withExit",
	"withGet",
	"withResolveBase",
	"withSet",
	"yield",
	"await",
	"asyncStart",
	"generatorStart",
]);

interface LinearInlineTarget {
	readonly blocks: ReadonlyArray<CoreBlock>;
	readonly instructionCount: number;
}

interface InlineProgramResult {
	readonly program: CoreProgram;
	readonly changed: boolean;
}

function storageKey(instruction: CoreInstruction): string | undefined {
	if (instruction.opcode !== "loadCaptured" && instruction.opcode !== "storeCaptured") {
		return undefined;
	}
	const owner = instruction.attributes.functionIndex;
	const index = instruction.attributes.index;
	return typeof owner === "number" && typeof index === "number"
		? `${owner}:${index}`
		: undefined;
}

function functionDefinitions(fn: CoreFunction): Map<CoreValueId, CoreInstruction> {
	const definitions = new Map<CoreValueId, CoreInstruction>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const output of instruction.outputs) definitions.set(output, instruction);
		}
	}
	return definitions;
}

/** Canonical producer identity through moves and all-ordinary single-value phis. */
function coreCanonicalValues(
	fn: CoreFunction,
	cfg: CoreControlFlow,
): ReadonlyMap<CoreValueId, CoreValueId> {
	const canonical = new Map(fn.values.map(({ id }) => [id, id] as const));
	const root = (value: CoreValueId): CoreValueId => {
		let current = value;
		const seen = new Set<CoreValueId>();
		while (!seen.has(current)) {
			seen.add(current);
			const next = canonical.get(current);
			if (next === undefined || next === current) break;
			current = next;
		}
		return current;
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.opcode !== "move" ||
					instruction.inputs.length !== 1 ||
					instruction.outputs.length !== 1
				) {
					continue;
				}
				const output = instruction.outputs[0]!;
				const source = root(instruction.inputs[0]!);
				if (root(output) !== source) {
					canonical.set(output, source);
					changed = true;
				}
			}
			const incoming = cfg.predecessors[block.id]!;
			if (incoming.length === 0 || incoming.some(({ kind }) => kind !== "ordinary")) {
				continue;
			}
			for (const [index, parameter] of block.parameters.entries()) {
				const current = root(parameter.value);
				const externalSources = new Set<CoreValueId>();
				let complete = true;
				for (const edge of incoming) {
					const argument = edge.arguments[index];
					if (argument === undefined) {
						complete = false;
						break;
					}
					const source = root(argument);
					// A loop-carried copy cycle contributes no new value. Collapse the
					// cycle only when every value entering it from outside has one root.
					if (source !== current) externalSources.add(source);
				}
				if (complete && externalSources.size === 1) {
					const source = externalSources.values().next().value!;
					canonical.set(parameter.value, source);
					changed = true;
				}
			}
		}
	}
	return new Map([...canonical].map(([value]) => [value, root(value)]));
}

function capturedStoreValues(fn: CoreFunction): Map<string, CoreValueId> {
	const candidates = new Map<string, Array<CoreValueId>>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.opcode !== "storeCaptured" || instruction.inputs.length !== 1) {
				continue;
			}
			const key = storageKey(instruction);
			if (key === undefined) continue;
			const values = candidates.get(key) ?? [];
			values.push(instruction.inputs[0]!);
			candidates.set(key, values);
		}
	}
	return new Map(
		[...candidates].flatMap(([key, values]) =>
			values.length === 1 ? [[key, values[0]!] as const] : [],
		),
	);
}

function exactFunctionValue(
	value: CoreValueId,
	definitions: ReadonlyMap<CoreValueId, CoreInstruction>,
	stores: ReadonlyMap<string, CoreValueId>,
): number | undefined {
	const seen = new Set<CoreValueId>();
	let current = value;
	while (!seen.has(current)) {
		seen.add(current);
		const definition = definitions.get(current);
		if (definition === undefined) return undefined;
		if (definition.opcode === "createFunction") {
			const index = definition.attributes.functionIndex;
			return typeof index === "number" ? index : undefined;
		}
		if (definition.opcode === "move" && definition.inputs.length === 1) {
			current = definition.inputs[0]!;
			continue;
		}
		if (definition.opcode === "loadCaptured") {
			const key = storageKey(definition);
			const stored = key === undefined ? undefined : stores.get(key);
			if (stored === undefined) return undefined;
			current = stored;
			continue;
		}
		return undefined;
	}
	return undefined;
}

interface CoreDirectCallFacts {
	readonly functions: ReadonlyMap<string, number>;
}

function programValueKey(functionIndex: number, value: CoreValueId): string {
	return `${functionIndex}:${value}`;
}

/**
 * Resolve immutable function provenance through Core SSA and the frontend's
 * closed lexical/global slots. Reassignable global properties never
 * participate. TDZ sentinel stores are ignored only for lexical global slots.
 */
function coreDirectCallFacts(program: CoreProgram): CoreDirectCallFacts {
	interface Store {
		readonly source: string;
	}
	const capturedStores = new Map<string, Array<Store>>();
	const globalStores = new Map<number, Array<Store>>();
	const functions = new Map<string, number>();
	const empty = new Set<string>();
	const addStore = <K>(map: Map<K, Array<Store>>, slot: K, source: string): void => {
		const stores = map.get(slot) ?? [];
		stores.push({ source });
		map.set(slot, stores);
	};
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) {
					const key = programValueKey(fn.functionIndex, output);
					if (instruction.opcode === "createFunction") {
						const target = instruction.attributes.functionIndex;
						if (typeof target === "number") functions.set(key, target);
					} else if (instruction.opcode === "createEmpty") {
						empty.add(key);
					}
				}
				if (instruction.inputs.length !== 1) continue;
				const source = programValueKey(fn.functionIndex, instruction.inputs[0]!);
				if (instruction.opcode === "storeGlobal") {
					const index = instruction.attributes.index;
					if (typeof index === "number") addStore(globalStores, index, source);
				} else if (instruction.opcode === "storeCaptured") {
					const owner = instruction.attributes.functionIndex;
					const index = instruction.attributes.index;
					if (typeof owner === "number" && typeof index === "number") {
						addStore(capturedStores, `${owner}:${index}`, source);
					}
				}
			}
		}
	}

	let changed = true;
	while (changed) {
		changed = false;
		const capturedFunctions = new Map<string, number>();
		for (const [slot, stores] of capturedStores) {
			if (stores.length !== 1) continue;
			const target = functions.get(stores[0]!.source);
			if (target !== undefined) capturedFunctions.set(slot, target);
		}
		const globalFunctions = new Map<number, number>();
		for (const [slot, stores] of globalStores) {
			const values = stores.filter(({ source }) => !empty.has(source));
			if (values.length !== 1) continue;
			const target = functions.get(values[0]!.source);
			if (target !== undefined) globalFunctions.set(slot, target);
		}

		for (const fn of program.functions) {
			const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry, { exceptions: false });
			for (const block of fn.blocks) {
				for (const instruction of block.instructions) {
					const output = instruction.outputs[0];
					if (output === undefined) continue;
					const destination = programValueKey(fn.functionIndex, output);
					const sourceValue = instruction.inputs[0];
					const source =
						sourceValue === undefined
							? undefined
							: programValueKey(fn.functionIndex, sourceValue);
					let target: number | undefined;
					if (instruction.opcode === "move" && source !== undefined) {
						target = functions.get(source);
						if (empty.has(source) && !empty.has(destination)) {
							empty.add(destination);
							changed = true;
						}
					} else if (instruction.opcode === "loadGlobal") {
						const index = instruction.attributes.index;
						if (typeof index === "number") {
							target = globalFunctions.get(index);
						}
					} else if (instruction.opcode === "loadCaptured") {
						const owner = instruction.attributes.functionIndex;
						const index = instruction.attributes.index;
						if (typeof owner === "number" && typeof index === "number") {
							const slot = `${owner}:${index}`;
							target = capturedFunctions.get(slot);
						}
					}
					if (target !== undefined && !functions.has(destination)) {
						functions.set(destination, target);
						changed = true;
					}
				}

				const incoming = cfg.predecessors[block.id]!;
				if (incoming.length === 0 || incoming.some(({ kind }) => kind !== "ordinary")) {
					continue;
				}
				for (const [index, parameter] of block.parameters.entries()) {
					const destination = programValueKey(fn.functionIndex, parameter.value);
					const sources = incoming.map((edge) =>
						programValueKey(fn.functionIndex, edge.arguments[index]!),
					);
					const target = functions.get(sources[0]!);
					if (
						target !== undefined &&
						sources.every((source) => functions.get(source) === target) &&
						!functions.has(destination)
					) {
						functions.set(destination, target);
						changed = true;
					}
				}
			}
		}
	}
	return { functions };
}

function annotateCoreDirectCallTargets(program: CoreProgram): InlineProgramResult {
	const facts = coreDirectCallFacts(program);
	const functionsByIndex = new Map(
		program.functions.map((fn) => [fn.functionIndex, fn] as const),
	);
	let changed = false;
	const functions = program.functions.map((fn): CoreFunction => {
		const definitions = functionDefinitions(fn);
		const moveRoot = (initial: CoreValueId): CoreValueId => {
			let value = initial;
			const seen = new Set<CoreValueId>();
			while (!seen.has(value)) {
				seen.add(value);
				const definition = definitions.get(value);
				if (definition?.opcode !== "move" || definition.inputs.length !== 1) break;
				value = definition.inputs[0]!;
			}
			return value;
		};
		let functionChanged = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (instruction.opcode !== "call" && instruction.opcode !== "construct") {
						return instruction;
					}
					const callee = instruction.inputs[0];
					if (callee === undefined) return instruction;
					const target = facts.functions.get(programValueKey(fn.functionIndex, callee));
					const targetFunction =
						target === undefined ? undefined : functionsByIndex.get(target);
					const attributes: Record<string, CoreAttributeValue> = {
						...instruction.attributes,
					};
					if (
						targetFunction !== undefined &&
						(instruction.opcode === "call" ||
							(!targetFunction.isGenerator &&
								!targetFunction.isAsync &&
								targetFunction.metadata.hasPrototype))
					) {
						attributes.directFunctionIndex = targetFunction.functionIndex;
					}
					if (instruction.opcode === "call" && instruction.inputs.length >= 2) {
						const calleeDefinition = definitions.get(moveRoot(callee));
						const receiver = calleeDefinition?.inputs[0];
						const thisValue = instruction.inputs[1]!;
						const staticKey =
							calleeDefinition?.opcode === "loadPropertyStatic" &&
							typeof calleeDefinition.attributes.stringIndex === "number"
								? decodeString(program, calleeDefinition.attributes.stringIndex)
								: calleeDefinition?.opcode === "loadProperty" &&
									  calleeDefinition.inputs[1] !== undefined
									? (() => {
											const key = definitions.get(moveRoot(calleeDefinition.inputs[1]));
											return key?.opcode === "createString" &&
												typeof key.attributes.stringIndex === "number"
												? decodeString(program, key.attributes.stringIndex)
												: undefined;
										})()
									: undefined;
						if (
							(calleeDefinition?.opcode === "loadPropertyStatic" ||
								calleeDefinition?.opcode === "loadProperty") &&
							staticKey === "call" &&
							receiver !== undefined &&
							moveRoot(receiver) === moveRoot(thisValue)
						) {
							const receiverKey = programValueKey(fn.functionIndex, thisValue);
							const receiverTarget =
								facts.functions.get(receiverKey) ??
								facts.functions.get(programValueKey(fn.functionIndex, receiver));
							// The runtime validates the loaded method against the realm's exact
							// %Function.prototype.call% object. A miss invokes the original
							// method with the original receiver and arguments, so no static
							// callable/provenance assumption is required for flattening.
							attributes.directFunctionCall = true;
							if (receiverTarget !== undefined && functionsByIndex.has(receiverTarget)) {
								attributes.directCallTargetFunctionIndex = receiverTarget;
							}
						}
					}
					if (stableAttributeValue(attributes) === stableAttributes(instruction)) {
						return instruction;
					}
					functionChanged = true;
					return { ...instruction, attributes };
				}),
			}),
		);
		if (!functionChanged) return fn;
		changed = true;
		return { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 };
	});
	return {
		program: changed ? { ...program, functions } : program,
		changed,
	};
}

function linearInlineTarget(target: CoreFunction): LinearInlineTarget | undefined {
	if (
		target.isGenerator ||
		target.isAsync ||
		target.metadata.capturedCount > 0 ||
		target.regions.length > 0
	) {
		return undefined;
	}
	const blocks: Array<CoreBlock> = [];
	const visited = new Set<CoreBlockId>();
	let block = target.blocks[target.entry];
	let instructionCount = 0;
	while (block !== undefined && !visited.has(block.id)) {
		visited.add(block.id);
		if (
			block.handler !== undefined ||
			block.parameters.some(({ role }) => role === "exception")
		) {
			return undefined;
		}
		for (const instruction of block.instructions) {
			if (
				INLINE_DISQUALIFYING_OPCODES.has(instruction.opcode) ||
				instruction.effectRefinement !== undefined
			) {
				return undefined;
			}
			instructionCount++;
			if (instructionCount > MAX_INLINE_INSTRUCTIONS) return undefined;
		}
		blocks.push(block);
		if (block.terminator.kind === "return") {
			return instructionCount === 0 ? undefined : { blocks, instructionCount };
		}
		if (block.terminator.kind !== "jump") return undefined;
		block = target.blocks[block.terminator.edge.block];
	}
	return undefined;
}

function targetShapeDeclineReason(target: CoreFunction): OptimizationDecisionReason {
	if (
		target.blocks.some(
			(block) =>
				block.handler !== undefined ||
				block.parameters.some(({ role }) => role === "exception"),
		)
	) {
		return "exception-region";
	}
	if (
		target.blocks.some((block) =>
			block.instructions.some(({ opcode }) => opcode === "createFunction"),
		)
	) {
		return "inner-closure";
	}
	return "relocation";
}

function targetAllocates(target: CoreFunction): boolean {
	return target.blocks.some((block) =>
		block.instructions.some(({ opcode }) => ALLOCATION_OPCODES.has(opcode)),
	);
}

function recordInlineDecision(
	decisions: Array<CompilerOptimizationDecision> | undefined,
	fn: CoreFunction,
	call: CoreInstruction,
	outcome: "applied" | "declined",
	reason: OptimizationDecisionReason | "inline",
): void {
	const positionId = call.sourcePosition;
	if (decisions === undefined || positionId === undefined) return;
	const code: CompilerOptimizationDecision["code"] =
		outcome === "applied"
			? `optimization.applied.${reason}`
			: `optimization.declined.${reason as OptimizationDecisionReason}`;
	if (
		decisions.some(
			(decision) =>
				decision.functionIndex === fn.functionIndex &&
				decision.positionId === positionId &&
				decision.code === code,
		)
	) {
		return;
	}
	decisions.push({
		functionIndex: fn.functionIndex,
		positionId,
		operation: "call",
		phase: "optimization",
		code,
		outcome,
		...(outcome === "declined" ? { reason: reason as OptimizationDecisionReason } : {}),
	});
}

function nextInstructionId(fn: CoreFunction): number {
	let next = 0;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions)
			next = Math.max(next, instruction.id + 1);
		next = Math.max(next, block.terminator.id + 1);
	}
	return next;
}

function inlineSourcePosition(
	positions: Array<CoreProgram["sourcePositions"][number]>,
	targetFunctionIndex: number,
	positionId: number | undefined,
	callerPositionId: number | undefined,
): number | undefined {
	if (positionId === undefined || callerPositionId === undefined) return positionId;
	const position = positions[positionId];
	if (position === undefined || position.inlinedFunctionIndex !== undefined) {
		return positionId;
	}
	return (
		positions.push({
			line: position.line,
			column: position.column,
			inlinedFunctionIndex: targetFunctionIndex,
			callerPosId: callerPositionId,
		}) - 1
	);
}

function inlineLinearCall(
	fn: CoreFunction,
	block: CoreBlock,
	call: CoreInstruction,
	target: CoreFunction,
	linear: LinearInlineTarget,
	positions: Array<CoreProgram["sourcePositions"][number]>,
): CoreFunction | undefined {
	if (call.outputs.length !== 1 || call.inputs.length < 2) return undefined;
	let instructionNumber = nextInstructionId(fn);
	let valueNumber = fn.values.reduce((next, value) => Math.max(next, value.id + 1), 0);
	const values = [...fn.values];
	const valueMap = new Map<CoreValueId, CoreValueId>();
	const cloned: Array<CoreInstruction> = [];
	const arguments_ = call.inputs.slice(2);
	for (const [index, parameter] of target.parameters.entries()) {
		const argument = arguments_[index];
		if (argument !== undefined) {
			valueMap.set(parameter, argument);
			continue;
		}
		const instructionId = coreInstructionId(instructionNumber++);
		const valueId = coreValueId(valueNumber++);
		cloned.push({
			id: instructionId,
			opcode: "createUndefined",
			inputs: [],
			outputs: [valueId],
			attributes: {},
			...(call.sourcePosition === undefined
				? {}
				: { sourcePosition: call.sourcePosition }),
		});
		values.push({
			id: valueId,
			representation: "boxed",
			definition: { kind: "instruction", instruction: instructionId, index: 0 },
		});
		valueMap.set(parameter, valueId);
	}
	const targetValues = new Map(target.values.map((value) => [value.id, value] as const));
	const resolveTarget = (value: CoreValueId): CoreValueId | undefined =>
		valueMap.get(value);
	let returnValue: CoreValueId | undefined;
	for (const [blockIndex, targetBlock] of linear.blocks.entries()) {
		if (blockIndex > 0) {
			const predecessor = linear.blocks[blockIndex - 1]!;
			if (predecessor.terminator.kind !== "jump") return undefined;
			for (const [index, parameter] of targetBlock.parameters.entries()) {
				const argument = predecessor.terminator.edge.arguments[index];
				const resolved = argument === undefined ? undefined : resolveTarget(argument);
				if (resolved === undefined) return undefined;
				valueMap.set(parameter.value, resolved);
			}
		}
		for (const instruction of targetBlock.instructions) {
			const inputs = instruction.inputs.map(resolveTarget);
			if (inputs.some((input) => input === undefined)) return undefined;
			const instructionId = coreInstructionId(instructionNumber++);
			const outputs = instruction.outputs.map((output, outputIndex) => {
				const source = targetValues.get(output);
				if (source === undefined) throw new Error(`Missing Core inline value ${output}`);
				const valueId = coreValueId(valueNumber++);
				values.push({
					id: valueId,
					representation: source.representation,
					definition: {
						kind: "instruction",
						instruction: instructionId,
						index: outputIndex,
					},
				});
				valueMap.set(output, valueId);
				return valueId;
			});
			cloned.push({
				...instruction,
				id: instructionId,
				inputs: inputs as Array<CoreValueId>,
				outputs,
				...(instruction.sourcePosition === undefined
					? {}
					: {
							sourcePosition: inlineSourcePosition(
								positions,
								target.functionIndex,
								instruction.sourcePosition,
								call.sourcePosition,
							),
						}),
			});
		}
		if (targetBlock.terminator.kind === "return") {
			returnValue = resolveTarget(targetBlock.terminator.value);
		}
	}
	if (returnValue === undefined) return undefined;
	const blocks = fn.blocks.map(
		(candidate): CoreBlock =>
			candidate.id === block.id
				? {
						...candidate,
						instructions: candidate.instructions.flatMap((instruction) =>
							instruction.id === call.id ? cloned : [instruction],
						),
					}
				: candidate,
	);
	return rewriteFunction(
		{ ...fn, values },
		blocks,
		new Map([[call.outputs[0]!, returnValue]]),
		new Set([call.id]),
	);
}

function inlineSimpleCoreFunctions(program: CoreProgram): InlineProgramResult {
	const compilation = program.compilation;
	const decisions =
		compilation?.optimizationDecisions === undefined
			? undefined
			: [...compilation.optimizationDecisions];
	const positions = program.sourcePositions.map((position) => ({ ...position }));
	let changed = false;
	const functions = program.functions.map((original) => {
		let fn = original;
		for (let expansion = 0; expansion < 8; expansion++) {
			const definitions = functionDefinitions(fn);
			const stores = capturedStoreValues(fn);
			const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);
			let next: CoreFunction | undefined;
			for (const block of fn.blocks) {
				for (const call of block.instructions) {
					if (call.opcode !== "call" || call.inputs.length < 2) continue;
					const targetIndex = exactFunctionValue(call.inputs[0]!, definitions, stores);
					if (targetIndex === undefined || targetIndex === fn.functionIndex) continue;
					const target = program.functions.find(
						(candidate) => candidate.functionIndex === targetIndex,
					);
					if (target === undefined) continue;
					const inLoop = cfg.loops.some((loop) => loop.blocks.has(block.id));
					if (inLoop && targetAllocates(target)) {
						recordInlineDecision(decisions, fn, call, "declined", "escape-cost-barrier");
						continue;
					}
					const linear = linearInlineTarget(target);
					if (linear === undefined) {
						recordInlineDecision(
							decisions,
							fn,
							call,
							"declined",
							targetShapeDeclineReason(target),
						);
						continue;
					}
					next = inlineLinearCall(fn, block, call, target, linear, positions);
					if (next !== undefined) {
						recordInlineDecision(decisions, fn, call, "applied", "inline");
						verifyCoreFunction(next, coreOpcodeRegistry);
					}
					break;
				}
				if (next !== undefined) break;
			}
			if (next === undefined) break;
			fn = next;
			changed = true;
		}
		return fn;
	});
	return {
		program: {
			...program,
			functions,
			sourcePositions: positions,
			...(compilation === undefined
				? {}
				: {
						compilation: {
							...compilation,
							...(decisions === undefined ? {} : { optimizationDecisions: decisions }),
						},
					}),
		},
		changed,
	};
}

function coreInstructionBlock(
	fn: CoreFunction,
	instructionId: CoreInstructionId,
): CoreBlockId | undefined {
	return fn.blocks.find((block) =>
		[...block.instructions, block.terminator].some(({ id }) => id === instructionId),
	)?.id;
}

function stackObjectRegion(
	fn: CoreFunction,
	allocation: CoreInstruction,
	analyses: CoreAnalysisManager,
): CoreFunction["regions"][number] | undefined {
	if (allocation.opcode !== "createObjectShaped" || allocation.outputs.length !== 1) {
		return undefined;
	}
	const keyStringIndices = allocation.attributes.keyStringIndices;
	if (
		!Array.isArray(keyStringIndices) ||
		!keyStringIndices.every((index) => typeof index === "number") ||
		new Set(keyStringIndices).size !== keyStringIndices.length
	) {
		return undefined;
	}
	const slotByStringIndex = new Map(
		keyStringIndices.map((stringIndex, slot) => [stringIndex, slot] as const),
	);
	const cfg = analyses.controlFlow(fn);
	const aliases = new Set<CoreValueId>([allocation.outputs[0]!]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.opcode === "move" &&
					instruction.inputs.length === 1 &&
					aliases.has(instruction.inputs[0]!) &&
					instruction.outputs.length === 1 &&
					!aliases.has(instruction.outputs[0]!)
				) {
					aliases.add(instruction.outputs[0]!);
					changed = true;
				}
			}
			const incoming = cfg.predecessors[block.id]!.filter(
				(edge) => edge.kind === "ordinary",
			);
			for (const [index, parameter] of block.parameters.entries()) {
				if (
					incoming.length > 0 &&
					incoming.every((edge) => {
						const argument = edge.arguments[index];
						return argument !== undefined && aliases.has(argument);
					}) &&
					!aliases.has(parameter.value)
				) {
					aliases.add(parameter.value);
					changed = true;
				}
			}
		}
	}

	const accesses: Array<{
		readonly instruction: CoreInstruction;
		readonly slot: number;
	}> = [];
	const materializations: Array<CoreTerminator & { readonly kind: "return" }> = [];
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const [position, input] of instruction.inputs.entries()) {
				if (!aliases.has(input)) continue;
				if (instruction.opcode === "move" && position === 0) continue;
				if (instruction.opcode === "throwIfTdz" && position === 0) continue;
				if (
					(instruction.opcode === "loadPropertyStatic" ||
						instruction.opcode === "storePropertyStatic") &&
					position === 0
				) {
					const stringIndex = instruction.attributes.stringIndex;
					const slot =
						typeof stringIndex === "number"
							? slotByStringIndex.get(stringIndex)
							: undefined;
					if (slot === undefined) return undefined;
					accesses.push({ instruction, slot });
					continue;
				}
				return undefined;
			}
		}
		if (block.handler?.arguments.some((value) => aliases.has(value)) === true) {
			return undefined;
		}
		const terminator = block.terminator;
		if (terminator.kind === "return" && aliases.has(terminator.value)) {
			materializations.push(terminator);
		} else if (
			(terminator.kind === "throw" && aliases.has(terminator.value)) ||
			((terminator.kind === "branch" || terminator.kind === "guard") &&
				aliases.has(terminator.condition)) ||
			(terminator.kind === "switch" && aliases.has(terminator.discriminant))
		) {
			return undefined;
		}
	}

	const claimedInstructions = [
		allocation.id,
		...accesses.map(({ instruction }) => instruction.id),
		...materializations.map(({ id }) => id),
	];
	if (new Set(claimedInstructions).size !== claimedInstructions.length) return undefined;
	const ordinaryBlocks = [
		...new Set(
			claimedInstructions.flatMap((instruction) => {
				const block = coreInstructionBlock(fn, instruction);
				return block === undefined ? [] : [block];
			}),
		),
	];
	if (ordinaryBlocks.length === 0) return undefined;
	const materializeObligations = materializations.map(({ id }) => ({
		kind: "materialize" as const,
		id: `stack-object-return:${fn.functionIndex}:${id}`,
	}));
	return {
		kind: "stack-object-plan",
		anchors: [allocation.id],
		claimedInstructions,
		ordinaryBlocks,
		exceptionalBlocks: [],
		data: coreAttributeObject(
			{
				license: {
					guard: {
						dependencies: [],
						obligations: [
							{
								kind: "fallback",
								id: `stack-object:${fn.functionIndex}:${allocation.id}`,
							},
							...materializeObligations,
						],
					},
					genericTwin: "retained",
					materialization: materializations.length === 0 ? "none" : "on-demand",
				},
				representation: "activation-local-fixed-shape-objects",
				cost: {
					score: Math.max(1, keyStringIndices.length),
					metadataOperations: claimedInstructions.length,
				},
				sites: [
					{
						allocation: { $coreInstruction: allocation.id },
						slotCount: keyStringIndices.length,
						accesses: accesses.map(({ instruction, slot }) => ({
							instruction: { $coreInstruction: instruction.id },
							slot,
						})),
						materializations: materializations.map(({ id }) => ({
							instruction: { $coreInstruction: id },
							kind: "return",
						})),
					},
				],
			},
			"stack-object-plan",
		),
	};
}

const selectStackObjectRegions: CoreFunctionPass = {
	name: "select-stack-object-regions",
	ablation: "escape",
	run(fn, analyses) {
		const existingAllocations = new Set(
			fn.regions
				.filter(({ kind }) => kind === "stack-object-plan")
				.flatMap(({ anchors }) => anchors),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.opcode !== "createObjectShaped" ||
					existingAllocations.has(instruction.id)
				) {
					continue;
				}
				const region = stackObjectRegion(fn, instruction, analyses);
				if (region !== undefined) regions.push(region);
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

const MAX_FRESH_DENSE_INDEXED_RESERVE = 65_536;
const FRESH_DENSE_NUMERIC_OPERATORS = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"**",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);

function coreBlockParameters(
	fn: CoreFunction,
): ReadonlyMap<CoreValueId, { readonly block: CoreBlockId; readonly index: number }> {
	const result = new Map<
		CoreValueId,
		{ readonly block: CoreBlockId; readonly index: number }
	>();
	for (const block of fn.blocks) {
		for (const [index, parameter] of block.parameters.entries()) {
			result.set(parameter.value, { block: block.id, index });
		}
	}
	return result;
}

function exactIntegerValue(
	value: CoreValueId,
	definitions: ReadonlyMap<CoreValueId, CoreInstruction>,
): number | undefined {
	const seen = new Set<CoreValueId>();
	let current = value;
	while (!seen.has(current)) {
		seen.add(current);
		const definition = definitions.get(current);
		if (definition === undefined) return undefined;
		if (definition.opcode === "move" && definition.inputs.length === 1) {
			current = definition.inputs[0]!;
			continue;
		}
		if (definition.opcode !== "createNumber") return undefined;
		const number = definition.attributes.value;
		return typeof number === "number" && Number.isSafeInteger(number)
			? number
			: undefined;
	}
	return undefined;
}

/**
 * Prove a canonical exact fresh-Array indexed-fill loop and move only its
 * geometric storage allocation to the allocation site. The original stores,
 * checks, polls, and fallback behavior remain intact.
 */
const annotateFreshDenseIndexedReserves: CoreFunctionPass = {
	name: "annotate-fresh-dense-indexed-reserves",
	run(fn, analyses) {
		if (fn.isGenerator || fn.isAsync) return fn;
		const cfg = analyses.controlFlow(fn);
		const definitions = functionDefinitions(fn);
		const parameters = coreBlockParameters(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlockId; readonly index: number }
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block: block.id, index });
			}
		}

		const reserveLengths = new Map<CoreInstructionId, number>();
		for (const block of fn.blocks) {
			for (const allocation of block.instructions) {
				if (
					allocation.opcode !== "createArray" ||
					allocation.outputs.length !== 1 ||
					allocation.attributes.length !== 0 ||
					allocation.attributes.freshDenseReserveLength !== undefined
				) {
					continue;
				}
				const allocationValue = allocation.outputs[0]!;
				const allocationLocation = locations.get(allocation.id)!;
				const aliasMemo = new Map<CoreValueId, boolean>();
				const aliasVisiting = new Set<CoreValueId>();
				const isAllocationAlias = (value: CoreValueId): boolean => {
					if (value === allocationValue) return true;
					const memo = aliasMemo.get(value);
					if (memo !== undefined) return memo;
					if (aliasVisiting.has(value)) return true;
					aliasVisiting.add(value);
					const definition = definitions.get(value);
					const parameter = parameters.get(value);
					let result = false;
					if (definition?.opcode === "move" && definition.inputs.length === 1) {
						result = isAllocationAlias(definition.inputs[0]!);
					} else if (parameter !== undefined) {
						const incoming = cfg.predecessors[parameter.block]!.filter(
							(edge) => edge.kind === "ordinary",
						);
						result =
							incoming.length > 0 &&
							incoming.every((edge) => {
								const argument = edge.arguments[parameter.index];
								return argument !== undefined && isAllocationAlias(argument);
							});
					}
					aliasVisiting.delete(value);
					aliasMemo.set(value, result);
					return result;
				};

				for (const loop of cfg.loops) {
					if (
						loop.blocks.size !== 2 ||
						loop.blocks.has(block.id) ||
						!cfg.dominates(block.id, loop.header)
					) {
						continue;
					}
					const header = fn.blocks[loop.header]!;
					const backedge = cfg.predecessors[loop.header]!.find(
						(edge) => edge.kind === "ordinary" && edge.from === loop.backedge,
					);
					const entryEdges = cfg.predecessors[loop.header]!.filter(
						(edge) => edge.kind === "ordinary" && edge.from !== loop.backedge,
					);
					if (backedge === undefined || entryEdges.length !== 1) continue;
					const entryEdge = entryEdges[0]!;
					if (entryEdge.from !== block.id) continue;
					if (header.terminator.kind !== "branch") continue;
					const comparison = definitions.get(header.terminator.condition);
					if (
						comparison?.opcode !== "binary" ||
						comparison.attributes.operator !== "<" ||
						comparison.inputs.length !== 2
					) {
						continue;
					}
					const counter = comparison.inputs[0]!;
					const counterParameterIndex = header.parameters.findIndex(
						(parameter) => parameter.value === counter,
					);
					const bound = exactIntegerValue(comparison.inputs[1]!, definitions);
					if (
						counterParameterIndex < 0 ||
						bound === undefined ||
						bound <= 0 ||
						bound > MAX_FRESH_DENSE_INDEXED_RESERVE ||
						exactIntegerValue(
							entryEdge.arguments[counterParameterIndex]!,
							definitions,
						) !== 0
					) {
						continue;
					}
					const bodyEdge = header.terminator.consequent;
					const exitEdge = header.terminator.alternate;
					if (
						!loop.blocks.has(bodyEdge.block) ||
						loop.blocks.has(exitEdge.block) ||
						cfg.predecessors[exitEdge.block]!.filter(({ kind }) => kind === "ordinary")
							.length !== 1
					) {
						continue;
					}

					const counterFamily = new Set<CoreValueId>([counter]);
					let familyChanged = true;
					while (familyChanged) {
						familyChanged = false;
						for (const candidate of fn.blocks) {
							const incoming = cfg.predecessors[candidate.id]!.filter(
								(edge) => edge.kind === "ordinary",
							);
							for (const [index, parameter] of candidate.parameters.entries()) {
								if (
									!counterFamily.has(parameter.value) &&
									incoming.length > 0 &&
									incoming.every((edge) => {
										const argument = edge.arguments[index];
										return argument !== undefined && counterFamily.has(argument);
									})
								) {
									counterFamily.add(parameter.value);
									familyChanged = true;
								}
							}
						}
					}
					for (const [index, argument] of bodyEdge.arguments.entries()) {
						if (argument !== counter) continue;
						const parameter = fn.blocks[bodyEdge.block]!.parameters[index];
						if (parameter !== undefined) counterFamily.add(parameter.value);
					}

					const increment = definitions.get(backedge.arguments[counterParameterIndex]!);
					if (
						increment?.opcode !== "unary" ||
						increment.attributes.operator !== "increment" ||
						increment.inputs.length !== 1
					) {
						continue;
					}
					const numericSource = definitions.get(increment.inputs[0]!);
					const incrementInput =
						numericSource?.opcode === "unary" &&
						numericSource.attributes.operator === "tonumeric" &&
						numericSource.inputs.length === 1
							? numericSource.inputs[0]!
							: increment.inputs[0]!;
					if (!counterFamily.has(incrementInput)) continue;

					const stores = fn.blocks
						.filter((candidate) => loop.blocks.has(candidate.id))
						.flatMap((candidate) => candidate.instructions)
						.filter(
							(instruction) =>
								instruction.opcode === "storeProperty" &&
								instruction.inputs.length === 3 &&
								isAllocationAlias(instruction.inputs[0]!),
						);
					if (stores.length !== 1) continue;
					const store = stores[0]!;
					if (!counterFamily.has(store.inputs[1]!)) continue;

					const numericMemo = new Map<CoreValueId, boolean>();
					const proveNumeric = (value: CoreValueId): boolean => {
						if (counterFamily.has(value)) return true;
						const memo = numericMemo.get(value);
						if (memo !== undefined) return memo;
						numericMemo.set(value, false);
						const definition = definitions.get(value);
						if (definition === undefined) return false;
						let proven = false;
						if (definition.opcode === "createNumber") {
							proven = true;
						} else if (definition.opcode === "move" && definition.inputs.length === 1) {
							proven = proveNumeric(definition.inputs[0]!);
						} else if (
							definition.opcode === "unary" &&
							typeof definition.attributes.operator === "string" &&
							["+", "-", "~", "tonumeric"].includes(definition.attributes.operator) &&
							definition.inputs.length === 1
						) {
							proven = proveNumeric(definition.inputs[0]!);
						} else if (
							definition.opcode === "binary" &&
							typeof definition.attributes.operator === "string" &&
							FRESH_DENSE_NUMERIC_OPERATORS.has(definition.attributes.operator) &&
							definition.inputs.length === 2
						) {
							proven =
								proveNumeric(definition.inputs[0]!) &&
								proveNumeric(definition.inputs[1]!);
						}
						numericMemo.set(value, proven);
						return proven;
					};
					if (!proveNumeric(store.inputs[2]!)) continue;

					let safe = true;
					for (const candidate of fn.blocks) {
						for (const instruction of candidate.instructions) {
							for (const [position, input] of instruction.inputs.entries()) {
								if (!isAllocationAlias(input)) continue;
								if (
									(instruction.opcode === "move" && position === 0) ||
									(instruction.opcode === "throwIfTdz" && position === 0) ||
									(instruction === store && position === 0) ||
									cfg.dominates(exitEdge.block, candidate.id)
								) {
									continue;
								}
								safe = false;
							}
						}
					}
					if (!safe) continue;
					const allocationBlock = fn.blocks[allocationLocation.block]!;
					if (
						allocationBlock.instructions
							.slice(allocationLocation.index + 1)
							.some(
								(instruction) =>
									instruction.opcode !== "createNumber" && instruction.opcode !== "move",
							)
					) {
						continue;
					}
					reserveLengths.set(allocation.id, bound);
					break;
				}
			}
		}
		if (reserveLengths.size === 0) return fn;
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) => {
					const length = reserveLengths.get(instruction.id);
					return length === undefined
						? instruction
						: {
								...instruction,
								attributes: {
									...instruction.attributes,
									freshDenseReserveLength: length,
								},
							};
				}),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

const NATIVE_NUMERIC_FUSION_OPERATORS = new Set([
	"+",
	"-",
	"*",
	"/",
	"%",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
]);
const NATIVE_NUMERIC_FUSION_FINISH_OPERATORS = new Set([
	...NATIVE_NUMERIC_FUSION_OPERATORS,
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
]);

const selectNumericFusionRegions: CoreFunctionPass = {
	name: "select-numeric-fusion-regions",
	run(fn) {
		if (fn.isGenerator || fn.isAsync) return fn;
		const claimed = new Set(fn.regions.flatMap((region) => region.claimedInstructions));
		const uses = new Map<
			CoreValueId,
			Array<{
				readonly instruction: CoreInstruction;
				readonly position: number;
				readonly block: CoreBlockId;
				readonly index: number;
			}>
		>();
		const nonInstructionUses = new Set<CoreValueId>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				for (const [position, input] of instruction.inputs.entries()) {
					const entries = uses.get(input) ?? [];
					entries.push({ instruction, position, block: block.id, index });
					uses.set(input, entries);
				}
			}
			if (block.handler !== undefined) {
				for (const value of block.handler.arguments) nonInstructionUses.add(value);
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const value of edge.arguments) nonInstructionUses.add(value);
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					nonInstructionUses.add(block.terminator.condition);
					break;
				case "switch":
					nonInstructionUses.add(block.terminator.discriminant);
					break;
				case "return":
				case "throw":
					nonInstructionUses.add(block.terminator.value);
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}

		const participating = new Set<CoreInstructionId>();
		const pairs: Array<{
			readonly first: CoreInstruction;
			readonly finish: CoreInstruction;
			readonly firstUsePosition: 1 | 2;
			readonly block: CoreBlockId;
		}> = [];
		for (const block of fn.blocks) {
			for (const [firstIndex, first] of block.instructions.entries()) {
				if (
					first.opcode !== "binary" ||
					typeof first.attributes.operator !== "string" ||
					!NATIVE_NUMERIC_FUSION_OPERATORS.has(first.attributes.operator) ||
					first.outputs.length !== 1 ||
					participating.has(first.id) ||
					claimed.has(first.id)
				) {
					continue;
				}
				const output = first.outputs[0]!;
				const outputUses = uses.get(output);
				if (outputUses?.length !== 1 || nonInstructionUses.has(output)) continue;
				const use = outputUses[0]!;
				const finish = use.instruction;
				if (
					finish.opcode !== "binary" ||
					(use.position !== 0 && use.position !== 1) ||
					typeof finish.attributes.operator !== "string" ||
					!NATIVE_NUMERIC_FUSION_FINISH_OPERATORS.has(finish.attributes.operator) ||
					use.block !== block.id ||
					use.index <= firstIndex ||
					participating.has(finish.id) ||
					claimed.has(finish.id)
				) {
					continue;
				}
				pairs.push({
					first,
					finish,
					firstUsePosition: use.position === 0 ? 1 : 2,
					block: block.id,
				});
				participating.add(first.id);
				participating.add(finish.id);
				if (pairs.length >= 32) break;
			}
			if (pairs.length >= 32) break;
		}
		const firstPair = pairs[0];
		if (firstPair === undefined) return fn;
		const claimedInstructions = pairs.flatMap(({ first, finish }) => [
			first.id,
			finish.id,
		]);
		const region: CoreFunction["regions"][number] = {
			kind: "numeric-fusion",
			anchors: [firstPair.first.id, firstPair.finish.id],
			claimedInstructions,
			ordinaryBlocks: [...new Set(pairs.map(({ block }) => block))],
			exceptionalBlocks: [],
			data: coreAttributeObject(
				{
					license: {
						guard: "structural",
						genericTwin: "retained",
						materialization: "none",
					},
					representation: "binary-pairs-f64",
					composition: "overlay",
					cost: {
						score: pairs.length,
						metadataOperations: claimedInstructions.length,
					},
					runtimeGuard: "number-operands",
					pairs: pairs.map(({ first, finish, firstUsePosition }) => ({
						first: { $coreInstruction: first.id },
						finish: { $coreInstruction: finish.id },
						firstUsePosition,
					})),
				},
				"numeric-fusion",
			),
		};
		return {
			...fn,
			regions: [...fn.regions, region],
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

interface CoreKnownBuiltinProof {
	readonly proof: {
		readonly dependencies: ReadonlyArray<unknown>;
		readonly obligations: ReadonlyArray<unknown>;
	};
	readonly sourceSite?: string;
}

function unknownArray(value: unknown): ReadonlyArray<unknown> | undefined {
	return Array.isArray(value) ? (value as ReadonlyArray<unknown>) : undefined;
}

function coreKnownBuiltinProof(
	instruction: CoreInstruction,
	operation: string,
	options: {
		readonly lowering?: string;
		readonly result?: string;
	} = {},
): CoreKnownBuiltinProof | undefined {
	const call = attributeObject(instruction.attributes.knownBuiltinCall);
	if (call?.operation !== operation) return undefined;
	const identity = attributeObject(call.identity);
	const semantics = attributeObject(call.semantics);
	const semanticValue = attributeObject(semantics?.value);
	const identityProof = attributeObject(identity?.proof);
	const semanticsProof = attributeObject(semantics?.proof);
	const identityDependencies = unknownArray(identityProof?.dependencies);
	const identityObligations = unknownArray(identityProof?.obligations);
	const semanticsDependencies = unknownArray(semanticsProof?.dependencies);
	const semanticsObligations = unknownArray(semanticsProof?.obligations);
	const lowerings = unknownArray(semanticValue?.lowerings);
	if (
		identity?.kind !== "known" ||
		semantics?.kind !== "known" ||
		identityDependencies === undefined ||
		identityObligations === undefined ||
		semanticsDependencies === undefined ||
		semanticsObligations === undefined ||
		![...identityObligations, ...semanticsObligations].some(
			(obligation) => attributeObject(obligation)?.kind === "fallback",
		) ||
		(options.lowering !== undefined &&
			(lowerings === undefined || !lowerings.includes(options.lowering))) ||
		(options.result !== undefined && semanticValue?.result !== options.result)
	) {
		return undefined;
	}
	const dependencies = new Map<string, unknown>();
	const obligations = new Map<string, unknown>();
	for (const dependency of [...identityDependencies, ...semanticsDependencies]) {
		dependencies.set(stableAttributeValue(dependency), dependency);
	}
	for (const obligation of [...identityObligations, ...semanticsObligations]) {
		obligations.set(stableAttributeValue(obligation), obligation);
	}
	return {
		proof: {
			dependencies: [...dependencies.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([, dependency]) => dependency),
			obligations: [...obligations.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([, obligation]) => obligation),
		},
		...(typeof call.sourceSite === "string" ? { sourceSite: call.sourceSite } : {}),
	};
}

function coreProofIsWorldInvariant(proof: CoreKnownBuiltinProof["proof"]): boolean {
	return (
		proof.dependencies.length > 0 &&
		proof.dependencies.every(
			(dependency) => attributeObject(dependency)?.kind === "world",
		)
	);
}

function mergeCoreBuiltinProofs(
	proofs: ReadonlyArray<CoreKnownBuiltinProof["proof"]>,
): CoreKnownBuiltinProof["proof"] {
	const dependencies = new Map<string, unknown>();
	const obligations = new Map<string, unknown>();
	for (const proof of proofs) {
		for (const dependency of proof.dependencies) {
			dependencies.set(stableAttributeValue(dependency), dependency);
		}
		for (const obligation of proof.obligations) {
			obligations.set(stableAttributeValue(obligation), obligation);
		}
	}
	return {
		dependencies: [...dependencies.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, dependency]) => dependency),
		obligations: [...obligations.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, obligation]) => obligation),
	};
}

/**
 * Certify the canonical `i < text.length` loop relation for String#charCodeAt.
 * The backend still retains the ordinary Get/Call twin and uses this fact only
 * after its primitive-string, builtin-identity, and numeric-representation guards.
 */
const annotateBoundedStringCharCodeAtPositions: CoreFunctionPass = {
	name: "annotate-bounded-string-char-code-at-positions",
	run(fn, analyses, program) {
		const cfg = analyses.controlFlow(fn);
		const canonical = coreCanonicalValues(fn, cfg);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = functionDefinitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
			}
		}
		const boundedCalls = new Set<CoreInstructionId>();
		const primitiveLengths = new Set<CoreInstructionId>();
		for (const loop of cfg.loops) {
			const header = fn.blocks[loop.header]!;
			const branch = header.terminator;
			if (
				branch.kind !== "branch" ||
				!loop.blocks.has(branch.consequent.block) ||
				loop.blocks.has(branch.alternate.block) ||
				header.handler !== undefined
			) {
				continue;
			}
			const bodyIncoming = cfg.predecessors[branch.consequent.block]!.filter(
				({ kind }) => kind === "ordinary",
			);
			if (bodyIncoming.length !== 1 || bodyIncoming[0]!.from !== header.id) continue;
			const comparison = definitions.get(root(branch.condition));
			if (
				comparison?.opcode !== "binary" ||
				comparison.attributes.operator !== "<" ||
				comparison.inputs.length !== 2 ||
				locations.get(comparison.id)?.block.id !== header.id
			) {
				continue;
			}
			const position = comparison.inputs[0]!;
			const length = definitions.get(root(comparison.inputs[1]!));
			if (
				length?.opcode !== "loadPropertyStatic" ||
				length.inputs.length !== 1 ||
				length.outputs.length !== 1 ||
				typeof length.attributes.stringIndex !== "number" ||
				decodeString(program, length.attributes.stringIndex) !== "length" ||
				locations.get(length.id)?.block.id !== header.id ||
				locations.get(length.id)!.index >= locations.get(comparison.id)!.index
			) {
				continue;
			}
			const positionParameter = header.parameters.findIndex(
				(parameter) => root(parameter.value) === root(position),
			);
			if (positionParameter < 0) continue;
			const incoming = cfg.predecessors[header.id]!.filter(
				({ kind }) => kind === "ordinary",
			);
			const outside = incoming.filter(({ from }) => !loop.blocks.has(from));
			const inside = incoming.filter(({ from }) => loop.blocks.has(from));
			if (
				outside.length !== 1 ||
				inside.length !== 1 ||
				inside[0]!.from !== loop.backedge
			) {
				continue;
			}
			const initial = outside[0]!.arguments[positionParameter];
			const updated = inside[0]!.arguments[positionParameter];
			if (initial === undefined || updated === undefined) continue;
			const zero = definitions.get(root(initial));
			const increment = definitions.get(root(updated));
			if (
				zero?.opcode !== "createNumber" ||
				!Object.is(zero.attributes.value, 0) ||
				loop.blocks.has(locations.get(zero.id)!.block.id) ||
				increment?.opcode !== "unary" ||
				increment.attributes.operator !== "increment" ||
				increment.inputs.length !== 1 ||
				locations.get(increment.id)?.block.id !== loop.backedge
			) {
				continue;
			}
			const numeric = definitions.get(root(increment.inputs[0]!));
			const incrementSource =
				numeric?.opcode === "unary" &&
				numeric.attributes.operator === "tonumeric" &&
				numeric.inputs.length === 1
					? numeric.inputs[0]
					: increment.inputs[0];
			if (root(incrementSource!) !== root(position)) continue;
			const receiver = root(length.inputs[0]!);
			for (const blockId of loop.blocks) {
				const block = fn.blocks[blockId]!;
				if (block.handler !== undefined) continue;
				for (const call of block.instructions) {
					if (
						call.opcode !== "call" ||
						call.inputs.length !== 3 ||
						root(call.inputs[1]!) !== receiver ||
						root(call.inputs[2]!) !== root(position) ||
						coreKnownBuiltinProof(call, "String.prototype.charCodeAt") === undefined ||
						!cfg.dominates(branch.consequent.block, block.id)
					) {
						continue;
					}
					const callLocation = locations.get(call.id)!;
					const incrementLocation = locations.get(increment.id)!;
					if (
						callLocation.block.id === incrementLocation.block.id &&
						callLocation.index >= incrementLocation.index
					) {
						continue;
					}
					boundedCalls.add(call.id);
					primitiveLengths.add(length.id);
				}
			}
		}
		if (boundedCalls.size === 0) return fn;
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) =>
					boundedCalls.has(instruction.id)
						? {
								...instruction,
								attributes: {
									...instruction.attributes,
									directStringCharCodeAtPosition: "inBounds",
								},
							}
						: primitiveLengths.has(instruction.id)
							? {
									...instruction,
									attributes: {
										...instruction.attributes,
										primitiveStringLength: true,
									},
								}
							: instruction,
				),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

/** Select closed capture projections from an exact `RegExp.prototype.exec`. */
const selectRegExpExecProjectionRegions: CoreFunctionPass = {
	name: "select-regexp-exec-projection-regions",
	run(fn, analyses, program) {
		if (fn.regions.filter(({ kind }) => kind === "regexp-exec-projection").length >= 8) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const canonical = coreCanonicalValues(fn, cfg);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = functionDefinitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		const uses = new Map<
			CoreValueId,
			Array<{ readonly instruction: CoreInstruction; readonly position: number }>
		>();
		const escapingValues = new Set<CoreValueId>();
		const markEscape = (value: CoreValueId) => escapingValues.add(root(value));
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const key = root(input);
					const entries = uses.get(key) ?? [];
					entries.push({ instruction, position });
					uses.set(key, entries);
				}
			}
			if (block.handler !== undefined) {
				for (const value of block.handler.arguments) markEscape(value);
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				const target = fn.blocks[edge.block]!;
				for (const [index, argument] of edge.arguments.entries()) {
					const parameter = target.parameters[index];
					if (parameter === undefined || root(parameter.value) !== root(argument)) {
						markEscape(argument);
					}
				}
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					markEscape(block.terminator.condition);
					break;
				case "switch":
					markEscape(block.terminator.discriminant);
					break;
				case "return":
				case "throw":
					markEscape(block.terminator.value);
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}
		const instructionDominates = (
			producer: CoreInstruction,
			consumer: CoreInstruction,
		): boolean => {
			const producerLocation = locations.get(producer.id);
			const consumerLocation = locations.get(consumer.id);
			if (producerLocation === undefined || consumerLocation === undefined) return false;
			return producerLocation.block.id === consumerLocation.block.id
				? producerLocation.index < consumerLocation.index
				: cfg.dominates(producerLocation.block.id, consumerLocation.block.id);
		};
		const staticProperty = (
			instruction: CoreInstruction | undefined,
			name: string,
		): instruction is CoreInstruction =>
			instruction?.opcode === "loadPropertyStatic" &&
			typeof instruction.attributes.stringIndex === "number" &&
			decodeString(program, instruction.attributes.stringIndex) === name;
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const call of block.instructions) {
				if (
					call.opcode !== "call" ||
					call.inputs.length !== 3 ||
					call.outputs.length !== 1
				) {
					continue;
				}
				const builtin = coreKnownBuiltinProof(call, "RegExp.prototype.exec", {
					lowering: "capture-projection",
					result: "regexp-match-or-null",
				});
				if (builtin === undefined) continue;
				const property = definitions.get(root(call.inputs[0]!));
				if (
					!staticProperty(property, "exec") ||
					property.inputs.length !== 1 ||
					property.outputs.length !== 1 ||
					root(property.inputs[0]!) !== root(call.inputs[1]!) ||
					!instructionDominates(property, call)
				) {
					continue;
				}
				const propertyUses = uses.get(root(property.outputs[0]!));
				if (
					propertyUses?.length !== 1 ||
					propertyUses[0]?.instruction !== call ||
					propertyUses[0].position !== 0
				) {
					continue;
				}
				const result = root(call.outputs[0]!);
				if (escapingValues.has(result)) continue;
				const resultValues = fn.values
					.map(({ id }) => id)
					.filter((value) => root(value) === result);
				const nullChecks: Array<{
					readonly comparison: CoreInstruction;
					readonly nullValue: CoreInstruction;
				}> = [];
				const loads: Array<{
					readonly instruction: CoreInstruction;
					readonly key: CoreInstruction;
					readonly captureIndex: number;
					consumer?:
						| { readonly kind: "length"; readonly property: CoreInstruction }
						| {
								readonly kind: "charCodeAtZero";
								readonly property: CoreInstruction;
								readonly call: CoreInstruction;
								readonly zero?: CoreInstruction;
						  }
						| {
								readonly kind: "number";
								readonly intrinsic: CoreInstruction;
								readonly call: CoreInstruction;
						  }
						| {
								readonly kind: "asciiCaseLength";
								readonly upperProperty: CoreInstruction;
								readonly upperCall: CoreInstruction;
								readonly lowerProperty: CoreInstruction;
								readonly lowerCall: CoreInstruction;
								readonly resultMoves: ReadonlyArray<CoreInstruction>;
								readonly lengthProperty: CoreInstruction;
						  };
				}> = [];
				const captureIndices = new Set<number>();
				let safe = true;
				for (const use of uses.get(result) ?? []) {
					const consumer = use.instruction;
					if (
						consumer.opcode === "move" &&
						use.position === 0 &&
						consumer.outputs.length === 1 &&
						root(consumer.outputs[0]!) === result
					) {
						continue;
					}
					if (
						consumer.opcode === "binary" &&
						(consumer.attributes.operator === "===" ||
							consumer.attributes.operator === "!==")
					) {
						const other = consumer.inputs[use.position === 0 ? 1 : 0];
						const nullValue =
							other === undefined ? undefined : definitions.get(root(other));
						if (
							nullValue?.opcode === "createNull" &&
							instructionDominates(nullValue, consumer)
						) {
							nullChecks.push({ comparison: consumer, nullValue });
							continue;
						}
					}
					if (
						consumer.opcode === "loadProperty" &&
						use.position === 0 &&
						consumer.inputs.length === 2 &&
						consumer.outputs.length === 1 &&
						instructionDominates(call, consumer)
					) {
						const key = definitions.get(root(consumer.inputs[1]!));
						const captureIndex = key?.attributes.value;
						if (
							key?.opcode === "createNumber" &&
							typeof captureIndex === "number" &&
							Number.isInteger(captureIndex) &&
							captureIndex > 0 &&
							captureIndex <= 0xffff &&
							!captureIndices.has(captureIndex) &&
							instructionDominates(key, consumer)
						) {
							loads.push({ instruction: consumer, key, captureIndex });
							captureIndices.add(captureIndex);
							continue;
						}
					}
					safe = false;
					break;
				}
				if (!safe || loads.length === 0 || loads.length > 8) continue;

				for (const load of loads) {
					const capture = root(load.instruction.outputs[0]!);
					const captureUses = uses.get(capture) ?? [];
					if (captureUses.length === 1) {
						const consumer = captureUses[0]!.instruction;
						if (
							captureUses[0]!.position === 0 &&
							staticProperty(consumer, "length") &&
							consumer.inputs.length === 1
						) {
							load.consumer = { kind: "length", property: consumer };
							continue;
						}
						if (
							consumer.opcode === "call" &&
							captureUses[0]!.position === 2 &&
							consumer.inputs.length === 3
						) {
							const intrinsic = definitions.get(root(consumer.inputs[0]!));
							if (
								intrinsic?.opcode === "loadIntrinsic" &&
								intrinsic.attributes.intrinsic === "Number" &&
								instructionDominates(intrinsic, consumer)
							) {
								load.consumer = { kind: "number", intrinsic, call: consumer };
								continue;
							}
						}
					}
					if (captureUses.length !== 2) continue;
					const upperPropertyUse = captureUses.find(
						({ instruction, position }) =>
							position === 0 && staticProperty(instruction, "toUpperCase"),
					);
					const upperCallUse = captureUses.find(
						({ instruction, position }) =>
							instruction.opcode === "call" && position === 1,
					);
					const upperProperty = upperPropertyUse?.instruction;
					const upperCall = upperCallUse?.instruction;
					if (
						upperProperty !== undefined &&
						upperCall?.opcode === "call" &&
						upperCall.inputs.length === 2 &&
						root(upperCall.inputs[0]!) === root(upperProperty.outputs[0]!) &&
						(uses.get(root(upperProperty.outputs[0]!))?.length ?? 0) === 1
					) {
						const upperResult = root(upperCall.outputs[0]!);
						const upperUses = uses.get(upperResult) ?? [];
						const lowerPropertyUse = upperUses.find(
							({ instruction, position }) =>
								position === 0 && staticProperty(instruction, "toLowerCase"),
						);
						const lowerCallUse = upperUses.find(
							({ instruction, position }) =>
								instruction.opcode === "call" && position === 1,
						);
						const lowerProperty = lowerPropertyUse?.instruction;
						const lowerCall = lowerCallUse?.instruction;
						if (
							upperUses.length === 2 &&
							lowerProperty !== undefined &&
							lowerCall?.opcode === "call" &&
							lowerCall.inputs.length === 2 &&
							root(lowerCall.inputs[0]!) === root(lowerProperty.outputs[0]!) &&
							(uses.get(root(lowerProperty.outputs[0]!))?.length ?? 0) === 1
						) {
							const lowerUses = uses.get(root(lowerCall.outputs[0]!)) ?? [];
							const lengthProperty = lowerUses[0]?.instruction;
							if (
								lowerUses.length === 1 &&
								lowerUses[0]?.position === 0 &&
								staticProperty(lengthProperty, "length")
							) {
								load.consumer = {
									kind: "asciiCaseLength",
									upperProperty,
									upperCall,
									lowerProperty,
									lowerCall,
									resultMoves: [],
									lengthProperty,
								};
								continue;
							}
						}
					}
					const propertyUse = captureUses.find(
						({ instruction, position }) =>
							position === 0 && staticProperty(instruction, "charCodeAt"),
					);
					const callUse = captureUses.find(
						({ instruction, position }) =>
							instruction.opcode === "call" && position === 1,
					);
					const charProperty = propertyUse?.instruction;
					const charCall = callUse?.instruction;
					if (
						charProperty === undefined ||
						charCall?.opcode !== "call" ||
						charCall.inputs.length !== 3 ||
						root(charCall.inputs[0]!) !== root(charProperty.outputs[0]!) ||
						(uses.get(root(charProperty.outputs[0]!))?.length ?? 0) !== 1
					) {
						continue;
					}
					const zero = definitions.get(root(charCall.inputs[2]!));
					if (zero?.opcode === "createNumber" && Object.is(zero.attributes.value, 0)) {
						load.consumer = {
							kind: "charCodeAtZero",
							property: charProperty,
							call: charCall,
							zero,
						};
					}
				}

				let lockedLiteral:
					| {
							readonly constructorIntrinsic: CoreInstruction;
							readonly construct: CoreInstruction;
					  }
					| undefined;
				const construct = definitions.get(root(call.inputs[1]!));
				if (
					coreProofIsWorldInvariant(builtin.proof) &&
					construct?.opcode === "construct" &&
					construct.outputs.length === 1
				) {
					const receiverUses = uses.get(root(construct.outputs[0]!)) ?? [];
					const constructorIntrinsic = definitions.get(root(construct.inputs[0]!));
					if (
						receiverUses.length === 2 &&
						receiverUses.every(
							({ instruction }) => instruction === property || instruction === call,
						) &&
						constructorIntrinsic?.opcode === "loadIntrinsic" &&
						constructorIntrinsic.attributes.intrinsic === "RegExp" &&
						instructionDominates(constructorIntrinsic, construct) &&
						instructionDominates(construct, call)
					) {
						lockedLiteral = { constructorIntrinsic, construct };
					}
				}

				const claimed = new Set<CoreInstruction>([property, call]);
				for (const { comparison, nullValue } of nullChecks) {
					claimed.add(comparison);
					claimed.add(nullValue);
				}
				for (const load of loads) {
					claimed.add(load.key);
					claimed.add(load.instruction);
					const consumer = load.consumer;
					if (consumer?.kind === "length") claimed.add(consumer.property);
					else if (consumer?.kind === "number") {
						claimed.add(consumer.intrinsic);
						claimed.add(consumer.call);
					} else if (consumer?.kind === "charCodeAtZero") {
						claimed.add(consumer.property);
						claimed.add(consumer.call);
						if (consumer.zero !== undefined) claimed.add(consumer.zero);
					} else if (consumer?.kind === "asciiCaseLength") {
						claimed.add(consumer.upperProperty);
						claimed.add(consumer.upperCall);
						claimed.add(consumer.lowerProperty);
						claimed.add(consumer.lowerCall);
						for (const move of consumer.resultMoves) claimed.add(move);
						claimed.add(consumer.lengthProperty);
					}
				}
				if (lockedLiteral !== undefined) {
					claimed.add(lockedLiteral.constructorIntrinsic);
					claimed.add(lockedLiteral.construct);
				}
				const claimedInstructions = [...claimed].map(({ id }) => id);
				const ordinaryBlocks = [
					...new Set([...claimed].map(({ id }) => locations.get(id)!.block.id)),
				];
				if (
					claimedInstructions.length > 96 ||
					claimedInstructions.some((id) => occupied.has(id)) ||
					[...claimed].some(({ id }) => locations.get(id)?.block.handler !== undefined)
				) {
					continue;
				}
				const obligations = [
					...builtin.proof.obligations,
					{
						kind: "materialize",
						id: `regexp-exec-projection:${builtin.sourceSite ?? fn.functionIndex}`,
					},
				];
				regions.push({
					kind: "regexp-exec-projection",
					anchors: [call.id, loads[0]!.instruction.id],
					claimedInstructions,
					ordinaryBlocks,
					exceptionalBlocks: [],
					data: coreAttributeObject(
						{
							license: {
								guard: { dependencies: builtin.proof.dependencies, obligations },
								genericTwin: "retained",
								materialization: "whole-region",
							},
							representation: "regexp-capture-spans",
							cost: {
								score: loads.length * 12 + nullChecks.length * 2,
								metadataOperations: claimedInstructions.length,
							},
							property: { $coreInstruction: property.id },
							resultRegisters: resultValues.map((value) => ({ $coreValue: value })),
							nullChecks: nullChecks.map(({ comparison, nullValue }) => ({
								comparison: { $coreInstruction: comparison.id },
								nullValue: { $coreInstruction: nullValue.id },
							})),
							...(lockedLiteral === undefined
								? {}
								: {
										lockedLiteral: {
											constructorIntrinsic: {
												$coreInstruction: lockedLiteral.constructorIntrinsic.id,
											},
											construct: { $coreInstruction: lockedLiteral.construct.id },
										},
									}),
							lastIndexEffect: "retained-call-twin",
							loads: loads.map((load) => ({
								instruction: { $coreInstruction: load.instruction.id },
								key: { $coreInstruction: load.key.id },
								captureIndex: load.captureIndex,
								...(load.consumer === undefined
									? {}
									: {
											consumer:
												load.consumer.kind === "length"
													? {
															kind: "length",
															property: {
																$coreInstruction: load.consumer.property.id,
															},
														}
													: load.consumer.kind === "number"
														? {
																kind: "number",
																intrinsic: {
																	$coreInstruction: load.consumer.intrinsic.id,
																},
																call: { $coreInstruction: load.consumer.call.id },
															}
														: load.consumer.kind === "charCodeAtZero"
															? {
																	kind: "charCodeAtZero",
																	property: {
																		$coreInstruction: load.consumer.property.id,
																	},
																	call: { $coreInstruction: load.consumer.call.id },
																	...(load.consumer.zero === undefined
																		? {}
																		: {
																				zero: {
																					$coreInstruction: load.consumer.zero.id,
																				},
																			}),
																}
															: {
																	kind: "asciiCaseLength",
																	upperProperty: {
																		$coreInstruction: load.consumer.upperProperty.id,
																	},
																	upperCall: {
																		$coreInstruction: load.consumer.upperCall.id,
																	},
																	lowerProperty: {
																		$coreInstruction: load.consumer.lowerProperty.id,
																	},
																	lowerCall: {
																		$coreInstruction: load.consumer.lowerCall.id,
																	},
																	resultMoves: load.consumer.resultMoves.map(
																		({ id }) => ({
																			$coreInstruction: id,
																		}),
																	),
																	lengthProperty: {
																		$coreInstruction: load.consumer.lengthProperty.id,
																	},
																},
										}),
							})),
						},
						"regexp-exec-projection",
					),
				});
				for (const id of claimedInstructions) occupied.add(id);
				if (regions.filter(({ kind }) => kind === "regexp-exec-projection").length >= 8) {
					break;
				}
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

/** Select closed constant captures from one exact RegExp iterator step. */
const selectRegExpIteratorProjectionRegions: CoreFunctionPass = {
	name: "select-regexp-iterator-projection-regions",
	run(fn, analyses, program) {
		const protector = program.compilation?.facts.protectors.get("watched-methods");
		const guard = compilerGuardPlan(
			[protector],
			[
				{
					kind: "fallback",
					id: `regexp-iterator-projection:${fn.functionIndex}`,
				},
				{
					kind: "materialize",
					id: `regexp-iterator-projection:${fn.functionIndex}`,
				},
			],
		);
		if (
			guard === undefined ||
			fn.regions.filter(({ kind }) => kind === "regexp-iterator-projection").length >= 8
		) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const canonical = coreCanonicalValues(fn, cfg);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = functionDefinitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		const uses = new Map<
			CoreValueId,
			Array<{ readonly instruction: CoreInstruction; readonly position: number }>
		>();
		const terminatorUses = new Set<CoreValueId>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const key = root(input);
					const entries = uses.get(key) ?? [];
					entries.push({ instruction, position });
					uses.set(key, entries);
				}
			}
			locations.set(block.terminator.id, {
				block,
				index: block.instructions.length,
			});
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					terminatorUses.add(root(block.terminator.condition));
					break;
				case "switch":
					terminatorUses.add(root(block.terminator.discriminant));
					break;
				case "return":
				case "throw":
					terminatorUses.add(root(block.terminator.value));
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}
		const instructionDominates = (
			producer: CoreInstruction,
			consumer: CoreInstruction,
		): boolean => {
			const producerLocation = locations.get(producer.id);
			const consumerLocation = locations.get(consumer.id);
			if (producerLocation === undefined || consumerLocation === undefined) return false;
			return producerLocation.block.id === consumerLocation.block.id
				? producerLocation.index < consumerLocation.index
				: cfg.dominates(producerLocation.block.id, consumerLocation.block.id);
		};
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			const step = block.instructions.at(-1);
			const doneBranch = block.terminator;
			if (
				step?.opcode !== "iteratorStep" ||
				step.inputs.length !== 2 ||
				step.outputs.length !== 2 ||
				doneBranch.kind !== "branch" ||
				root(doneBranch.condition) !== root(step.outputs[1]!) ||
				doneBranch.consequent.block === block.id
			) {
				continue;
			}
			const result = root(step.outputs[0]!);
			if (terminatorUses.has(result)) continue;
			const resultValues = fn.values
				.map(({ id }) => id)
				.filter((value) => root(value) === result);
			const loads: Array<{
				readonly instruction: CoreInstruction;
				readonly key: CoreInstruction;
				readonly captureIndex: number;
				readonly numberIntrinsic: CoreInstruction;
				readonly numberCall: CoreInstruction;
			}> = [];
			const captureIndices = new Set<number>();
			let safe = true;
			for (const use of uses.get(result) ?? []) {
				const capture = use.instruction;
				if (
					capture.opcode === "move" &&
					use.position === 0 &&
					capture.outputs.length === 1 &&
					root(capture.outputs[0]!) === result
				) {
					continue;
				}
				if (
					capture.opcode !== "loadProperty" ||
					use.position !== 0 ||
					capture.inputs.length !== 2 ||
					capture.outputs.length !== 1 ||
					!instructionDominates(step, capture)
				) {
					safe = false;
					break;
				}
				const key = definitions.get(root(capture.inputs[1]!));
				const captureIndex = key?.attributes.value;
				const captureUses = uses.get(root(capture.outputs[0]!)) ?? [];
				const numberUse = captureUses[0];
				const numberCall = numberUse?.instruction;
				const numberIntrinsic =
					numberCall?.opcode === "call"
						? definitions.get(root(numberCall.inputs[0]!))
						: undefined;
				if (
					key?.opcode !== "createNumber" ||
					typeof captureIndex !== "number" ||
					!Number.isInteger(captureIndex) ||
					captureIndex <= 0 ||
					captureIndex > 0xffff ||
					captureIndices.has(captureIndex) ||
					captureUses.length !== 1 ||
					numberUse?.position !== 2 ||
					numberCall?.opcode !== "call" ||
					numberCall.inputs.length !== 3 ||
					root(numberCall.inputs[2]!) !== root(capture.outputs[0]!) ||
					numberIntrinsic?.opcode !== "loadIntrinsic" ||
					numberIntrinsic.attributes.intrinsic !== "Number" ||
					!instructionDominates(key, capture) ||
					!instructionDominates(numberIntrinsic, numberCall)
				) {
					safe = false;
					break;
				}
				captureIndices.add(captureIndex);
				loads.push({
					instruction: capture,
					key,
					captureIndex,
					numberIntrinsic,
					numberCall,
				});
			}
			if (!safe || loads.length === 0 || loads.length > 8) continue;
			const claimed = new Set<CoreInstruction>([step]);
			for (const load of loads) {
				claimed.add(load.key);
				claimed.add(load.instruction);
				claimed.add(load.numberIntrinsic);
				claimed.add(load.numberCall);
			}
			const claimedInstructions = [...claimed].map(({ id }) => id);
			claimedInstructions.splice(1, 0, doneBranch.id);
			const ordinaryBlocks = [
				...new Set(claimedInstructions.map((id) => locations.get(id)!.block.id)),
			];
			const exceptionalBlocks = [
				...new Set(
					claimedInstructions.flatMap((id) => {
						const handler = locations.get(id)?.block.handler;
						return handler === undefined ? [] : [handler.block];
					}),
				),
			];
			if (
				claimedInstructions.some((id) => occupied.has(id)) ||
				exceptionalBlocks.some((handler) => ordinaryBlocks.includes(handler))
			) {
				continue;
			}
			regions.push({
				kind: "regexp-iterator-projection",
				anchors: [step.id, doneBranch.id, loads[0]!.instruction.id],
				claimedInstructions,
				ordinaryBlocks,
				exceptionalBlocks,
				data: coreAttributeObject(
					{
						license: {
							guard,
							genericTwin: "retained",
							materialization: "on-demand",
						},
						representation: "regexp-iterator-capture-spans",
						cost: {
							score: loads.length * 16,
							metadataOperations: claimedInstructions.length,
						},
						doneBranch: { $coreInstruction: doneBranch.id },
						exitBlock: { $coreBlock: doneBranch.consequent.block },
						resultRegisters: resultValues.map((value) => ({ $coreValue: value })),
						statefulEffect: "iterator-last-index-retained-step",
						runtimeGuard: "exact-brand-next-realm-regexp",
						loads: loads.map((load) => ({
							instruction: { $coreInstruction: load.instruction.id },
							key: { $coreInstruction: load.key.id },
							captureIndex: load.captureIndex,
							numberIntrinsic: { $coreInstruction: load.numberIntrinsic.id },
							numberCall: { $coreInstruction: load.numberCall.id },
						})),
					},
					"regexp-iterator-projection",
				),
			});
			for (const id of claimedInstructions) occupied.add(id);
			if (
				regions.filter(({ kind }) => kind === "regexp-iterator-projection").length >= 8
			) {
				break;
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

/** Select one-shot indexed consumers of an exact `String.prototype.split`. */
const selectStringSplitCursorRegions: CoreFunctionPass = {
	name: "select-string-split-cursor-regions",
	run(fn, analyses, program) {
		if (fn.regions.filter(({ kind }) => kind === "string-split-cursor").length >= 8) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const canonical = coreCanonicalValues(fn, cfg);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = functionDefinitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		const uses = new Map<
			CoreValueId,
			Array<{ readonly instruction: CoreInstruction; readonly position: number }>
		>();
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const entries = uses.get(root(input)) ?? [];
					entries.push({ instruction, position });
					uses.set(root(input), entries);
				}
			}
			locations.set(block.terminator.id, {
				block,
				index: block.instructions.length,
			});
		}
		const instructionDominates = (
			producer: CoreInstruction,
			consumer: CoreInstruction,
		): boolean => {
			const producerLocation = locations.get(producer.id);
			const consumerLocation = locations.get(consumer.id);
			if (producerLocation === undefined || consumerLocation === undefined) return false;
			return producerLocation.block.id === consumerLocation.block.id
				? producerLocation.index < consumerLocation.index
				: cfg.dominates(producerLocation.block.id, consumerLocation.block.id);
		};
		const exactUses = (
			value: CoreValueId,
			expected: ReadonlyArray<{
				readonly instruction: CoreInstruction;
				readonly position: number;
			}>,
		): boolean => {
			const actual = uses.get(root(value)) ?? [];
			return (
				actual.length === expected.length &&
				expected.every(({ instruction, position }) =>
					actual.some(
						(use) => use.instruction === instruction && use.position === position,
					),
				)
			);
		};
		const canReachWithout = (
			from: CoreBlockId,
			to: CoreBlockId,
			blocked: CoreBlockId,
		): boolean => {
			if (from === blocked) return false;
			const seen = new Set<CoreBlockId>([blocked]);
			const pending = [from];
			while (pending.length > 0) {
				const block = pending.pop()!;
				if (block === to) return true;
				if (seen.has(block)) continue;
				seen.add(block);
				for (const edge of cfg.successors[block]!) {
					if (edge.kind === "ordinary" && !seen.has(edge.to)) pending.push(edge.to);
				}
			}
			return false;
		};
		const staticProperty = (
			instruction: CoreInstruction | undefined,
			name: string,
		): instruction is CoreInstruction =>
			instruction?.opcode === "loadPropertyStatic" &&
			typeof instruction.attributes.stringIndex === "number" &&
			decodeString(program, instruction.attributes.stringIndex) === name;
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const handlerTargets = new Set(
			fn.blocks.flatMap(({ handler }) => (handler === undefined ? [] : [handler.block])),
		);
		const regions = [...fn.regions];
		for (const loop of cfg.loops) {
			const header = fn.blocks[loop.header]!;
			const backedgeBlock = fn.blocks[loop.backedge]!;
			const branch = header.terminator;
			if (
				branch.kind !== "branch" ||
				backedgeBlock.terminator.kind !== "jump" ||
				backedgeBlock.terminator.edge.block !== header.id ||
				branch.consequent.block !== backedgeBlock.id ||
				loop.blocks.size !== 2 ||
				!loop.blocks.has(header.id) ||
				!loop.blocks.has(backedgeBlock.id)
			) {
				continue;
			}
			const containedLoops = cfg.loops.filter(
				(candidate) =>
					loop.blocks.has(candidate.header) && loop.blocks.has(candidate.backedge),
			);
			const headerPredecessors = cfg.predecessors[header.id]!.filter(
				({ kind }) => kind === "ordinary",
			);
			const insidePredecessors = headerPredecessors.filter(({ from }) =>
				loop.blocks.has(from),
			);
			const outsidePredecessors = headerPredecessors.filter(
				({ from }) => !loop.blocks.has(from),
			);
			if (
				containedLoops.length !== 1 ||
				insidePredecessors.length !== 1 ||
				insidePredecessors[0]!.from !== backedgeBlock.id ||
				outsidePredecessors.length !== 1
			) {
				continue;
			}
			let exactLoopControl = true;
			for (const blockId of loop.blocks) {
				for (const edge of cfg.predecessors[blockId]!) {
					if (
						edge.kind !== "ordinary" ||
						(!loop.blocks.has(edge.from) && blockId !== header.id)
					) {
						exactLoopControl = false;
					}
				}
				for (const edge of cfg.successors[blockId]!) {
					if (
						edge.kind !== "ordinary" ||
						(!loop.blocks.has(edge.to) &&
							(blockId !== header.id || edge.to !== branch.alternate.block))
					) {
						exactLoopControl = false;
					}
				}
			}
			if (!exactLoopControl) continue;

			const compare = definitions.get(root(branch.condition));
			if (
				compare?.opcode !== "binary" ||
				compare.attributes.operator !== "<" ||
				compare.inputs.length !== 2 ||
				compare.outputs.length !== 1 ||
				header.instructions.at(-1) !== compare
			) {
				continue;
			}
			const index = compare.inputs[0]!;
			const length = definitions.get(root(compare.inputs[1]!));
			if (
				!staticProperty(length, "length") ||
				length.inputs.length !== 1 ||
				length.outputs.length !== 1 ||
				header.instructions.at(-2) !== length
			) {
				continue;
			}
			const splitResult = root(length.inputs[0]!);
			const splitCall = definitions.get(splitResult);
			if (
				(splitCall?.opcode !== "call" && splitCall?.opcode !== "callBuiltin") ||
				splitCall.outputs.length !== 1
			) {
				continue;
			}
			const dynamicSplit = splitCall.opcode === "call";
			if (splitCall.inputs.length !== (dynamicSplit ? 3 : 2)) continue;
			const splitProof = coreKnownBuiltinProof(splitCall, "String.prototype.split", {
				lowering: "closed-string-split",
				result: "array-of-strings",
			});
			if (splitProof === undefined) continue;
			const splitProperty = dynamicSplit
				? definitions.get(root(splitCall.inputs[0]!))
				: undefined;
			const receiver = splitCall.inputs[dynamicSplit ? 1 : 0]!;
			if (
				(dynamicSplit &&
					(!staticProperty(splitProperty, "split") ||
						splitProperty.inputs.length !== 1 ||
						splitProperty.outputs.length !== 1 ||
						root(splitProperty.inputs[0]!) !== root(receiver) ||
						!instructionDominates(splitProperty, splitCall) ||
						!exactUses(splitProperty.outputs[0]!, [
							{ instruction: splitCall, position: 0 },
						]))) ||
				!cfg.dominates(locations.get(splitCall.id)!.block.id, header.id)
			) {
				continue;
			}

			const element = backedgeBlock.instructions[0];
			const trimProperty = backedgeBlock.instructions[1];
			const trimCall = backedgeBlock.instructions[2];
			if (
				element?.opcode !== "loadProperty" ||
				element.inputs.length !== 2 ||
				element.outputs.length !== 1 ||
				root(element.inputs[0]!) !== splitResult ||
				root(element.inputs[1]!) !== root(index) ||
				!staticProperty(trimProperty, "trim") ||
				trimProperty.inputs.length !== 1 ||
				trimProperty.outputs.length !== 1 ||
				root(trimProperty.inputs[0]!) !== root(element.outputs[0]!) ||
				trimCall?.opcode !== "call" ||
				trimCall.inputs.length !== 2 ||
				trimCall.outputs.length !== 1 ||
				root(trimCall.inputs[0]!) !== root(trimProperty.outputs[0]!) ||
				root(trimCall.inputs[1]!) !== root(element.outputs[0]!)
			) {
				continue;
			}
			const trimProof = coreKnownBuiltinProof(trimCall, "String.prototype.trim", {
				lowering: "split-cursor-span",
				result: "string",
			});
			if (trimProof === undefined) continue;

			const indexParameter = header.parameters.findIndex(
				(parameter) => root(parameter.value) === root(index),
			);
			if (indexParameter < 0) continue;
			const initialIndex = outsidePredecessors[0]!.arguments[indexParameter];
			const nextIndex = insidePredecessors[0]!.arguments[indexParameter];
			if (initialIndex === undefined || nextIndex === undefined) continue;
			const zero = definitions.get(root(initialIndex));
			const increment = definitions.get(root(nextIndex));
			if (
				zero?.opcode !== "createNumber" ||
				!Object.is(zero.attributes.value, 0) ||
				loop.blocks.has(locations.get(zero.id)!.block.id) ||
				!cfg.dominates(locations.get(zero.id)!.block.id, header.id) ||
				increment?.opcode !== "unary" ||
				increment.attributes.operator !== "increment" ||
				increment.inputs.length !== 1 ||
				increment.outputs.length !== 1 ||
				backedgeBlock.instructions.at(-1) !== increment
			) {
				continue;
			}
			const incrementInput = definitions.get(root(increment.inputs[0]!));
			const indexAdvanceInput =
				incrementInput?.opcode === "unary" &&
				incrementInput.attributes.operator === "tonumeric" &&
				incrementInput.inputs.length === 1
					? incrementInput.inputs[0]
					: increment.inputs[0];
			if (root(indexAdvanceInput!) !== root(index)) continue;

			const primitiveStringLengths: Array<CoreInstruction> = [];
			let trimResultSafe = true;
			for (const use of uses.get(root(trimCall.outputs[0]!)) ?? []) {
				if (
					use.position === 0 &&
					staticProperty(use.instruction, "length") &&
					instructionDominates(trimCall, use.instruction)
				) {
					primitiveStringLengths.push(use.instruction);
				} else {
					trimResultSafe = false;
				}
			}
			if (
				!trimResultSafe ||
				primitiveStringLengths.length > 64 ||
				!exactUses(splitCall.outputs[0]!, [
					{ instruction: length, position: 0 },
					{ instruction: element, position: 0 },
				]) ||
				!exactUses(index, [
					{ instruction: compare, position: 0 },
					{ instruction: element, position: 1 },
					{ instruction: incrementInput ?? increment, position: 0 },
				]) ||
				!exactUses(element.outputs[0]!, [
					{ instruction: trimProperty, position: 0 },
					{ instruction: trimCall, position: 1 },
				]) ||
				!exactUses(trimProperty.outputs[0]!, [{ instruction: trimCall, position: 0 }])
			) {
				continue;
			}

			const callBlock = locations.get(splitCall.id)!.block.id;
			if (canReachWithout(branch.alternate.block, header.id, callBlock)) continue;
			const ordinaryBlocks = [
				...new Set([
					...(splitProperty === undefined
						? []
						: [locations.get(splitProperty.id)!.block.id]),
					callBlock,
					...loop.blocks,
				]),
			];
			if (
				ordinaryBlocks.some(
					(blockId) =>
						fn.blocks[blockId]!.handler !== undefined || handlerTargets.has(blockId),
				)
			) {
				continue;
			}
			const proof = mergeCoreBuiltinProofs([splitProof.proof, trimProof.proof]);
			const materialization = {
				kind: "materialize",
				id: `string-split-cursor:${splitProof.sourceSite ?? fn.functionIndex}`,
			};
			const obligations = [...proof.obligations, materialization];
			if (
				!obligations.some(
					(obligation) => attributeObject(obligation)?.kind === "fallback",
				)
			) {
				continue;
			}
			const claimed = [
				...(splitProperty === undefined ? [] : [splitProperty]),
				splitCall,
				length,
				compare,
				branch,
				element,
				trimProperty,
				trimCall,
				...primitiveStringLengths,
				increment,
				backedgeBlock.terminator,
			];
			if (
				new Set(claimed.map(({ id }) => id)).size !== claimed.length ||
				claimed.some(({ id }) => occupied.has(id))
			) {
				continue;
			}
			const claimedInstructions = claimed.map(({ id }) => id);
			const resultValues = fn.values
				.map(({ id }) => id)
				.filter((value) => root(value) === splitResult);
			regions.push({
				kind: "string-split-cursor",
				anchors: [splitCall.id, branch.id, length.id, backedgeBlock.terminator.id],
				claimedInstructions,
				ordinaryBlocks,
				exceptionalBlocks: [],
				data: coreAttributeObject(
					{
						license: {
							guard: { dependencies: proof.dependencies, obligations },
							genericTwin: "retained",
							materialization: "on-demand",
						},
						representation: "split-cursor-spans",
						cost: {
							score: 4 + primitiveStringLengths.length,
							metadataOperations: claimedInstructions.length,
						},
						...(splitProperty === undefined
							? {}
							: { property: { $coreInstruction: splitProperty.id } }),
						compare: { $coreInstruction: compare.id },
						element: { $coreInstruction: element.id },
						trimProperty: { $coreInstruction: trimProperty.id },
						trimCall: { $coreInstruction: trimCall.id },
						increment: { $coreInstruction: increment.id },
						resultRegisters: resultValues.map((value) => ({ $coreValue: value })),
						primitiveStringLengths: primitiveStringLengths.map(({ id }) => ({
							$coreInstruction: id,
						})),
						exitBlock: { $coreBlock: branch.alternate.block },
					},
					"string-split-cursor",
				),
			});
			for (const { id } of claimed) occupied.add(id);
			if (regions.filter(({ kind }) => kind === "string-split-cursor").length >= 8) {
				break;
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

/** Select a non-escaping exact `String.prototype.split` projection. */
const selectStringSplitProjectionRegions: CoreFunctionPass = {
	name: "select-string-split-projection-regions",
	run(fn, analyses, program) {
		if (fn.regions.filter(({ kind }) => kind === "string-split-projection").length >= 8) {
			return fn;
		}
		const cfg = analyses.controlFlow(fn);
		const canonical = coreCanonicalValues(fn, cfg);
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const definitions = functionDefinitions(fn);
		const locations = new Map<
			CoreInstructionId,
			{ readonly block: CoreBlock; readonly index: number }
		>();
		const uses = new Map<
			CoreValueId,
			Array<{
				readonly instruction: CoreInstruction;
				readonly position: number;
			}>
		>();
		const nonInstructionUses = new Set<CoreValueId>();
		const handlerTargets = new Set(
			fn.blocks.flatMap(({ handler }) => (handler === undefined ? [] : [handler.block])),
		);
		const addNonInstructionUse = (value: CoreValueId) => {
			nonInstructionUses.add(root(value));
		};
		for (const block of fn.blocks) {
			for (const [index, instruction] of block.instructions.entries()) {
				locations.set(instruction.id, { block, index });
				for (const [position, input] of instruction.inputs.entries()) {
					const key = root(input);
					const entries = uses.get(key) ?? [];
					entries.push({ instruction, position });
					uses.set(key, entries);
				}
			}
			if (block.handler !== undefined) {
				for (const value of block.handler.arguments) addNonInstructionUse(value);
			}
			for (const edge of coreTerminatorEdges(block.terminator)) {
				for (const value of edge.arguments) addNonInstructionUse(value);
			}
			switch (block.terminator.kind) {
				case "branch":
				case "guard":
					addNonInstructionUse(block.terminator.condition);
					break;
				case "switch":
					addNonInstructionUse(block.terminator.discriminant);
					break;
				case "return":
				case "throw":
					addNonInstructionUse(block.terminator.value);
					break;
				case "jump":
				case "unreachable":
					break;
			}
		}
		const instructionDominates = (
			producer: CoreInstruction,
			consumer: CoreInstruction,
		): boolean => {
			const producerLocation = locations.get(producer.id);
			const consumerLocation = locations.get(consumer.id);
			if (producerLocation === undefined || consumerLocation === undefined) return false;
			return producerLocation.block.id === consumerLocation.block.id
				? producerLocation.index < consumerLocation.index
				: cfg.dominates(producerLocation.block.id, consumerLocation.block.id);
		};
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const call of block.instructions) {
				const dynamic = call.opcode === "call";
				if (
					(!dynamic && call.opcode !== "callBuiltin") ||
					call.inputs.length !== (dynamic ? 3 : 2) ||
					call.outputs.length !== 1
				) {
					continue;
				}
				const builtin = coreKnownBuiltinProof(call, "String.prototype.split", {
					lowering: "projected-string-split",
					result: "array-of-strings",
				});
				if (builtin === undefined) continue;
				const property = dynamic ? definitions.get(root(call.inputs[0]!)) : undefined;
				const receiver = call.inputs[dynamic ? 1 : 0]!;
				const separator = definitions.get(root(call.inputs[dynamic ? 2 : 1]!));
				const separatorStringIndex = separator?.attributes.stringIndex;
				if (
					(dynamic &&
						(property?.opcode !== "loadPropertyStatic" ||
							property.inputs.length !== 1 ||
							property.outputs.length !== 1 ||
							root(property.inputs[0]!) !== root(receiver) ||
							typeof property.attributes.stringIndex !== "number" ||
							decodeString(program, property.attributes.stringIndex) !== "split" ||
							!instructionDominates(property, call))) ||
					separator?.opcode !== "createString" ||
					typeof separatorStringIndex !== "number" ||
					(decodeString(program, separatorStringIndex)?.length ?? 0) === 0 ||
					!instructionDominates(separator, call)
				) {
					continue;
				}
				if (property !== undefined) {
					const propertyUses = uses.get(root(property.outputs[0]!));
					if (
						propertyUses?.length !== 1 ||
						propertyUses[0]?.instruction !== call ||
						propertyUses[0].position !== 0
					) {
						continue;
					}
				}

				const result = root(call.outputs[0]!);
				if (nonInstructionUses.has(result)) continue;
				const loads: Array<{
					readonly instruction: CoreInstruction;
					readonly kind: "element" | "length";
					readonly index?: number;
				}> = [];
				const projectedIndices = new Set<number>();
				let lengthSeen = false;
				let safe = true;
				for (const use of uses.get(result) ?? []) {
					const consumer = use.instruction;
					if (
						consumer.opcode === "move" &&
						use.position === 0 &&
						consumer.outputs.length === 1 &&
						root(consumer.outputs[0]!) === result
					) {
						continue;
					}
					if (
						consumer.opcode === "loadPropertyStatic" &&
						use.position === 0 &&
						consumer.outputs.length === 1 &&
						typeof consumer.attributes.stringIndex === "number" &&
						decodeString(program, consumer.attributes.stringIndex) === "length" &&
						!lengthSeen &&
						instructionDominates(call, consumer)
					) {
						loads.push({ instruction: consumer, kind: "length" });
						lengthSeen = true;
						continue;
					}
					if (
						consumer.opcode === "loadProperty" &&
						use.position === 0 &&
						consumer.inputs.length === 2 &&
						consumer.outputs.length === 1 &&
						instructionDominates(call, consumer)
					) {
						const key = definitions.get(root(consumer.inputs[1]!));
						const index = key?.attributes.value;
						if (
							key?.opcode === "createNumber" &&
							typeof index === "number" &&
							Number.isInteger(index) &&
							index >= 0 &&
							index <= 0xffff &&
							!projectedIndices.has(index) &&
							instructionDominates(key, consumer)
						) {
							loads.push({ instruction: consumer, kind: "element", index });
							projectedIndices.add(index);
							continue;
						}
					}
					safe = false;
					break;
				}
				if (!safe || projectedIndices.size === 0 || projectedIndices.size > 8) continue;
				const order = (instruction: CoreInstruction): number => {
					const location = locations.get(instruction.id)!;
					return location.block.id * 0x1_0000 + location.index;
				};
				loads.sort((left, right) => order(left.instruction) - order(right.instruction));
				const claimed = [
					...(property === undefined ? [] : [property]),
					call,
					...loads.map(({ instruction }) => instruction),
				];
				const ordinaryBlocks = [
					...new Set(claimed.map(({ id }) => locations.get(id)!.block.id)),
				];
				if (
					new Set(claimed.map(({ id }) => id)).size !== claimed.length ||
					claimed.some(({ id }) => occupied.has(id)) ||
					claimed.some(({ id }) => locations.get(id)?.block.handler !== undefined) ||
					ordinaryBlocks.some((id) => handlerTargets.has(id))
				) {
					continue;
				}
				const obligations = [
					...builtin.proof.obligations,
					{
						kind: "materialize",
						id: `string-split-projection:${builtin.sourceSite ?? fn.functionIndex}`,
					},
				];
				const claimedInstructions = claimed.map(({ id }) => id);
				const resultValues = fn.values
					.map(({ id }) => id)
					.filter((value) => root(value) === result);
				regions.push({
					kind: "string-split-projection",
					anchors: [call.id, loads[0]!.instruction.id],
					claimedInstructions,
					ordinaryBlocks,
					exceptionalBlocks: [],
					data: coreAttributeObject(
						{
							license: {
								guard: {
									dependencies: builtin.proof.dependencies,
									obligations,
								},
								genericTwin: "retained",
								materialization: "whole-region",
							},
							representation: "projected-elements",
							cost: {
								score: projectedIndices.size * 8 + loads.length,
								metadataOperations: claimedInstructions.length,
							},
							...(property === undefined
								? {}
								: { property: { $coreInstruction: property.id } }),
							separatorStringIndex,
							resultRegisters: resultValues.map((value) => ({ $coreValue: value })),
							loads: loads.map((load) => ({
								instruction: { $coreInstruction: load.instruction.id },
								kind: load.kind,
								...(load.index === undefined ? {} : { index: load.index }),
							})),
						},
						"string-split-projection",
					),
				});
				for (const { id } of claimed) occupied.add(id);
				if (
					regions.filter(({ kind }) => kind === "string-split-projection").length >= 8
				) {
					break;
				}
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

/** Select exact `String.prototype.slice` -> `%Number%` span conversion. */
const selectStringSliceNumberRegions: CoreFunctionPass = {
	name: "select-string-slice-number-regions",
	run(fn, analyses, program) {
		if (fn.regions.filter(({ kind }) => kind === "string-slice-number").length >= 8) {
			return fn;
		}
		const definitions = functionDefinitions(fn);
		const canonical = coreCanonicalValues(fn, analyses.controlFlow(fn));
		const root = (value: CoreValueId): CoreValueId => canonical.get(value) ?? value;
		const uses = new Map<
			CoreValueId,
			Array<{ readonly instruction: CoreInstruction; readonly position: number }>
		>();
		const blocksByInstruction = new Map<CoreInstructionId, CoreBlock>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				blocksByInstruction.set(instruction.id, block);
				for (const [position, input] of instruction.inputs.entries()) {
					const key = root(input);
					const entries = uses.get(key) ?? [];
					entries.push({ instruction, position });
					uses.set(key, entries);
				}
			}
		}
		const occupied = new Set(
			fn.regions
				.filter(({ kind }) => kind !== "numeric-fusion")
				.flatMap(({ claimedInstructions }) => claimedInstructions),
		);
		const regions = [...fn.regions];
		for (const block of fn.blocks) {
			for (const sliceCall of block.instructions) {
				if (
					sliceCall.opcode !== "call" ||
					sliceCall.inputs.length !== 3 ||
					sliceCall.outputs.length !== 1
				) {
					continue;
				}
				const builtin = coreKnownBuiltinProof(sliceCall, "String.prototype.slice", {
					lowering: "number-consumer-fusion",
					result: "string",
				});
				if (builtin === undefined) continue;
				const property = definitions.get(root(sliceCall.inputs[0]!));
				if (
					property?.opcode !== "loadPropertyStatic" ||
					property.inputs.length !== 1 ||
					root(property.inputs[0]!) !== root(sliceCall.inputs[1]!) ||
					typeof property.attributes.stringIndex !== "number" ||
					decodeString(program, property.attributes.stringIndex) !== "slice" ||
					property.outputs.length !== 1
				) {
					continue;
				}
				const propertyUses = uses.get(root(property.outputs[0]!));
				const sliceUses = uses.get(root(sliceCall.outputs[0]!));
				if (
					propertyUses?.length !== 1 ||
					propertyUses[0]?.instruction !== sliceCall ||
					propertyUses[0].position !== 0 ||
					sliceUses?.length !== 1 ||
					sliceUses[0]?.position !== 2
				) {
					continue;
				}
				const numberCall = sliceUses[0].instruction;
				if (
					numberCall.opcode !== "call" ||
					numberCall.inputs.length !== 3 ||
					root(numberCall.inputs[2]!) !== root(sliceCall.outputs[0]!)
				) {
					continue;
				}
				const numberIntrinsic = definitions.get(root(numberCall.inputs[0]!));
				if (
					numberIntrinsic?.opcode !== "loadIntrinsic" ||
					numberIntrinsic.attributes.intrinsic !== "Number"
				) {
					continue;
				}
				const start = definitions.get(root(sliceCall.inputs[2]!));
				if (
					start === undefined ||
					(start.opcode !== "createNumber" && start.opcode !== "createF64")
				) {
					continue;
				}
				const sliceStart = start.attributes.value;
				if (typeof sliceStart !== "number" || !Number.isFinite(sliceStart)) continue;

				const claimed = [property, sliceCall, start, numberIntrinsic, numberCall];
				if (
					new Set(claimed.map(({ id }) => id)).size !== claimed.length ||
					claimed.some(({ id }) => occupied.has(id))
				) {
					continue;
				}
				const ordinaryBlocks = [
					...new Set(claimed.map(({ id }) => blocksByInstruction.get(id)!.id)),
				];
				const exceptionalBlocks = [
					...new Set(
						claimed.flatMap(({ id }) => {
							const handler = blocksByInstruction.get(id)?.handler;
							return handler === undefined ? [] : [handler.block];
						}),
					),
				];
				if (exceptionalBlocks.some((handler) => ordinaryBlocks.includes(handler))) {
					continue;
				}
				const claimedInstructions = claimed.map(({ id }) => id);
				regions.push({
					kind: "string-slice-number",
					anchors: [sliceCall.id, numberCall.id],
					claimedInstructions,
					ordinaryBlocks,
					exceptionalBlocks,
					data: coreAttributeObject(
						{
							license: {
								guard: builtin.proof,
								genericTwin: "retained",
								materialization: "none",
							},
							representation: "primitive-string-span-number",
							cost: { score: 16, metadataOperations: claimedInstructions.length },
							property: { $coreInstruction: property.id },
							sliceStartInstruction: { $coreInstruction: start.id },
							numberIntrinsic: { $coreInstruction: numberIntrinsic.id },
							numberCall: { $coreInstruction: numberCall.id },
							sliceStart,
						},
						"string-slice-number",
					),
				});
				for (const { id } of claimed) occupied.add(id);
				if (regions.filter(({ kind }) => kind === "string-slice-number").length >= 8) {
					break;
				}
			}
		}
		return regions.length === fn.regions.length
			? fn
			: { ...fn, regions, mutationEpoch: fn.mutationEpoch + 1 };
	},
};

function origin(
	value: CoreValueId,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreValueId {
	return environment.get(value) ?? value;
}

function enterEdge(
	fn: CoreFunction,
	edge: CoreEdge,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): {
	readonly block: CoreBlock;
	readonly environment: ReadonlyMap<CoreValueId, CoreValueId>;
} {
	const block = fn.blocks[edge.block];
	if (block === undefined) throw new Error(`Unknown Core edge target ${edge.block}`);
	const next = new Map<CoreValueId, CoreValueId>();
	for (const [index, parameter] of block.parameters.entries()) {
		next.set(parameter.value, origin(edge.arguments[index]!, environment));
	}
	return { block, environment: next };
}

function exactNumberTest(
	block: CoreBlock,
	condition: CoreValueId,
	subject: CoreValueId,
	value: number,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
	instructions: ReadonlyArray<CoreInstruction>,
): boolean {
	if (instructions.length !== 2) return false;
	const [constant, compare] = instructions;
	return (
		constant?.opcode === "createNumber" &&
		instructionAttribute(constant, "value") === value &&
		constant.outputs.length === 1 &&
		compare?.opcode === "binary" &&
		instructionAttribute(compare, "operator") === "===" &&
		compare.outputs.length === 1 &&
		compare.outputs[0] === condition &&
		compare.inputs.length === 2 &&
		origin(compare.inputs[0]!, environment) === subject &&
		compare.inputs[1] === constant.outputs[0] &&
		block.terminator.kind === "branch"
	);
}

function edgeTerminatesWith(
	fn: CoreFunction,
	edge: CoreEdge,
	kind: "return" | "throw",
	value: CoreValueId,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): boolean {
	const target = enterEdge(fn, edge, environment);
	return (
		target.block.instructions.length === 0 &&
		target.block.terminator.kind === kind &&
		origin(target.block.terminator.value, target.environment) === value
	);
}

function edgeReturnsUndefined(
	fn: CoreFunction,
	edge: CoreEdge,
	environment: ReadonlyMap<CoreValueId, CoreValueId>,
): boolean {
	let state = enterEdge(fn, edge, environment);
	const visited = new Set<CoreBlockId>();
	while (
		state.block.instructions.length === 0 &&
		state.block.terminator.kind === "jump"
	) {
		if (visited.has(state.block.id)) return false;
		visited.add(state.block.id);
		state = enterEdge(fn, state.block.terminator.edge, state.environment);
	}
	const [created] = state.block.instructions;
	return (
		state.block.instructions.length === 1 &&
		created?.opcode === "createUndefined" &&
		created.outputs.length === 1 &&
		state.block.terminator.kind === "return" &&
		state.block.terminator.value === created.outputs[0]
	);
}

/**
 * Prove the canonical synchronous-generator tail protocol in explicit CFG form.
 * The proof is intentionally exact: any cleanup, handler, additional use, or
 * observable continuation makes the yield resumable.
 */
const annotateTerminalYieldSites: CoreFunctionPass = {
	name: "annotate-terminal-yield-sites",
	run(fn) {
		if (
			!fn.isGenerator ||
			fn.isAsync ||
			fn.blocks.some(
				(block) =>
					block.handler !== undefined ||
					block.parameters.some(({ role }) => role === "exception"),
			)
		) {
			return fn;
		}
		const terminal = new Set<number>();
		for (const block of fn.blocks) {
			if (block.terminator.kind !== "branch") continue;
			for (const [index, instruction] of block.instructions.entries()) {
				if (
					instruction.opcode !== "yield" ||
					instruction.outputs.length !== 2 ||
					instruction.inputs.length !== 1
				) {
					continue;
				}
				const [yieldedValue, resumeMode] = instruction.outputs;
				const rootEnvironment = new Map<CoreValueId, CoreValueId>();
				if (
					!exactNumberTest(
						block,
						block.terminator.condition,
						resumeMode!,
						1,
						rootEnvironment,
						block.instructions.slice(index + 1),
					) ||
					!edgeTerminatesWith(
						fn,
						block.terminator.consequent,
						"throw",
						yieldedValue!,
						rootEnvironment,
					)
				) {
					continue;
				}
				const resumed = enterEdge(fn, block.terminator.alternate, rootEnvironment);
				if (resumed.block.terminator.kind !== "branch") continue;
				if (
					!exactNumberTest(
						resumed.block,
						resumed.block.terminator.condition,
						resumeMode!,
						2,
						resumed.environment,
						resumed.block.instructions,
					) ||
					!edgeTerminatesWith(
						fn,
						resumed.block.terminator.consequent,
						"return",
						yieldedValue!,
						resumed.environment,
					) ||
					!edgeReturnsUndefined(
						fn,
						resumed.block.terminator.alternate,
						resumed.environment,
					)
				) {
					continue;
				}
				if (instructionAttribute(instruction, "terminal") !== true) {
					terminal.add(instruction.id);
				}
			}
		}
		if (terminal.size === 0) return fn;
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.map((instruction) => {
					if (!terminal.has(instruction.id)) return instruction;
					return {
						...instruction,
						attributes: { ...instruction.attributes, terminal: true },
					};
				}),
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

function exactStringConstantIndex(
	program: CoreProgram,
	value: string,
): number | undefined {
	const index = program.stringConstants.findIndex(
		(units) =>
			units.length === value.length &&
			units.every((unit, offset) => unit === value.charCodeAt(offset)),
	);
	return index < 0 ? undefined : index;
}

/**
 * Preserve object identity as an SSA fact instead of rediscovering it in every
 * escape optimization. A fresh ordinary object has stable `typeof` and identity
 * semantics even when its allocation must remain observable for OOM behavior.
 */
const foldExactObjectObservations: CoreFunctionPass = {
	name: "fold-exact-object-observations",
	ablation: "constant-folding",
	run(fn, analyses, program) {
		const origins = new Map<CoreValueId, CoreInstructionId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					(instruction.opcode === "createObject" ||
						instruction.opcode === "createObjectShaped") &&
					instruction.outputs.length === 1
				) {
					origins.set(instruction.outputs[0]!, instruction.id);
				}
			}
		}
		const cfg = analyses.controlFlow(fn);
		let propagated = true;
		while (propagated) {
			propagated = false;
			for (const block of fn.blocks) {
				for (const instruction of block.instructions) {
					if (
						instruction.opcode !== "move" ||
						instruction.inputs.length !== 1 ||
						instruction.outputs.length !== 1
					) {
						continue;
					}
					const allocation = origins.get(instruction.inputs[0]!);
					if (allocation !== undefined && !origins.has(instruction.outputs[0]!)) {
						origins.set(instruction.outputs[0]!, allocation);
						propagated = true;
					}
				}
				const incoming = cfg.predecessors[block.id]!;
				if (incoming.length === 0 || incoming.some(({ kind }) => kind !== "ordinary")) {
					continue;
				}
				for (const [index, parameter] of block.parameters.entries()) {
					if (origins.has(parameter.value)) continue;
					const first = origins.get(incoming[0]!.arguments[index]!);
					if (
						first !== undefined &&
						incoming.every((edge) => origins.get(edge.arguments[index]!) === first)
					) {
						origins.set(parameter.value, first);
						propagated = true;
					}
				}
			}
		}

		const objectStringIndex = exactStringConstantIndex(program, "object");
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						instruction.opcode === "typeofCompare" &&
						instruction.inputs.length === 1 &&
						origins.has(instruction.inputs[0]!)
					) {
						const expected = instructionAttribute(instruction, "expected");
						const negated = instructionAttribute(instruction, "negated") === true;
						changed = true;
						return {
							...instruction,
							opcode: "createBoolean",
							inputs: [],
							attributes: { value: (expected === "object") !== negated },
						};
					}
					if (
						objectStringIndex !== undefined &&
						instruction.opcode === "unary" &&
						instructionAttribute(instruction, "operator") === "typeof" &&
						instruction.inputs.length === 1 &&
						origins.has(instruction.inputs[0]!)
					) {
						changed = true;
						return {
							...instruction,
							opcode: "createString",
							inputs: [],
							attributes: { stringIndex: objectStringIndex },
						};
					}
					if (instruction.opcode !== "binary" || instruction.inputs.length !== 2) {
						return instruction;
					}
					const operator = instructionAttribute(instruction, "operator");
					if (
						operator !== "===" &&
						operator !== "!==" &&
						operator !== "==" &&
						operator !== "!="
					) {
						return instruction;
					}
					const left = origins.get(instruction.inputs[0]!);
					const right = origins.get(instruction.inputs[1]!);
					if (left === undefined || right === undefined) return instruction;
					const equal = left === right;
					changed = true;
					return {
						...instruction,
						opcode: "createBoolean",
						inputs: [],
						attributes: {
							value: operator === "!==" || operator === "!=" ? !equal : equal,
						},
					};
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

const MAY_PRODUCE_EMPTY_OPCODES = new Set([
	"createEmpty",
	"loadCaptured",
	"loadGlobal",
	"loadLocal",
]);

/**
 * Empty is an internal TDZ sentinel, not a JavaScript value. Core SSA makes its
 * provenance explicit, so remove a check only when no incoming definition can
 * carry that sentinel. Cyclic phis start non-empty and become maybe-empty only
 * when a real Empty-producing source reaches the cycle.
 */
const eliminateRedundantTdzChecks: CoreFunctionPass = {
	name: "eliminate-redundant-tdz-checks",
	run(fn, analyses) {
		const cfg = analyses.controlFlow(fn);
		const maybeEmpty = new Set<CoreValueId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					MAY_PRODUCE_EMPTY_OPCODES.has(instruction.opcode) ||
					(instruction.opcode === "loadThis" && fn.metadata.isDerivedConstructor)
				) {
					for (const output of instruction.outputs) maybeEmpty.add(output);
				}
			}
		}

		let changed = true;
		while (changed) {
			changed = false;
			for (const block of fn.blocks) {
				for (const instruction of block.instructions) {
					if (
						(instruction.opcode === "move" || instruction.opcode === "setThis") &&
						instruction.inputs.some((input) => maybeEmpty.has(input))
					) {
						for (const output of instruction.outputs) {
							if (!maybeEmpty.has(output)) {
								maybeEmpty.add(output);
								changed = true;
							}
						}
					}
				}
				const incoming = cfg.predecessors[block.id]!;
				for (const [index, parameter] of block.parameters.entries()) {
					if (parameter.role === "exception" || maybeEmpty.has(parameter.value)) {
						continue;
					}
					const canBeEmpty = incoming.some((edge) => {
						const argumentIndex =
							edge.kind === "exceptional" && block.parameters[0]?.role === "exception"
								? index - 1
								: index;
						const argument =
							argumentIndex < 0 ? undefined : edge.arguments[argumentIndex];
						return argument === undefined || maybeEmpty.has(argument);
					});
					if (canBeEmpty) {
						maybeEmpty.add(parameter.value);
						changed = true;
					}
				}
			}
		}

		let removed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.filter((instruction) => {
					if (
						instruction.opcode === "throwIfTdz" &&
						instruction.inputs.length === 1 &&
						!maybeEmpty.has(instruction.inputs[0]!)
					) {
						removed = true;
						return false;
					}
					return true;
				}),
			}),
		);
		if (!removed) return fn;
		// A TDZ check can be the last throwing instruction covered by a handler.
		// Removing it also removes Core's exceptional edge, so immediately restore
		// the verifier invariant that every retained block is reachable.
		return removeUnreachableCoreBlocks({
			...fn,
			blocks,
			mutationEpoch: fn.mutationEpoch + 1,
		});
	},
};

const TYPEOF_RESULTS = new Set([
	"undefined",
	"object",
	"boolean",
	"number",
	"string",
	"symbol",
	"bigint",
	"function",
]);

/** Collapse the allocating `typeof` string corridor into Core's exact predicate. */
const foldTypeofComparisons: CoreFunctionPass = {
	name: "fold-typeof-comparisons",
	ablation: "constant-folding",
	run(fn, _analyses, program) {
		const definitions = new Map<CoreValueId, CoreInstruction>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions.set(output, instruction);
			}
		}
		const stringValue = (instruction: CoreInstruction): string | undefined => {
			if (instruction.opcode !== "createString") return undefined;
			const index = instructionAttribute(instruction, "stringIndex");
			if (typeof index !== "number") return undefined;
			const units = program.stringConstants[index];
			return units === undefined ? undefined : String.fromCharCode(...units);
		};
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (instruction.opcode !== "binary" || instruction.inputs.length !== 2) {
						return instruction;
					}
					const operator = instructionAttribute(instruction, "operator");
					if (
						operator !== "===" &&
						operator !== "!==" &&
						operator !== "==" &&
						operator !== "!="
					) {
						return instruction;
					}
					const left = definitions.get(instruction.inputs[0]!);
					const right = definitions.get(instruction.inputs[1]!);
					const unary =
						left?.opcode === "unary" &&
						instructionAttribute(left, "operator") === "typeof"
							? left
							: right?.opcode === "unary" &&
								  instructionAttribute(right, "operator") === "typeof"
								? right
								: undefined;
					const constant = unary === left ? right : unary === right ? left : undefined;
					const expected = constant === undefined ? undefined : stringValue(constant);
					if (
						unary === undefined ||
						unary.inputs.length !== 1 ||
						expected === undefined ||
						!TYPEOF_RESULTS.has(expected)
					) {
						return instruction;
					}
					changed = true;
					return {
						...instruction,
						opcode: "typeofCompare",
						inputs: [unary.inputs[0]!],
						attributes: {
							expected,
							negated: operator === "!==" || operator === "!=",
						},
					};
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

/** Fold an exact string SSA value into the property operation's attributes. */
const foldStaticPropertyKeys: CoreFunctionPass = {
	name: "fold-static-property-keys",
	ablation: "static-properties",
	run(fn, analyses) {
		const canonical = coreCanonicalValues(fn, analyses.controlFlow(fn));
		const strings = new Map<CoreValueId, number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const stringIndex = instructionAttribute(instruction, "stringIndex");
				if (
					instruction.opcode === "createString" &&
					instruction.outputs.length === 1 &&
					typeof stringIndex === "number"
				) {
					strings.set(instruction.outputs[0]!, stringIndex);
				}
			}
		}
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction): CoreInstruction => {
					if (
						(instruction.opcode !== "loadProperty" &&
							instruction.opcode !== "storeProperty") ||
						instruction.inputs.length < 2
					) {
						return instruction;
					}
					const key = instruction.inputs[1]!;
					const stringIndex = strings.get(canonical.get(key) ?? key);
					if (stringIndex === undefined) return instruction;
					changed = true;
					return {
						...instruction,
						opcode:
							instruction.opcode === "loadProperty"
								? "loadPropertyStatic"
								: "storePropertyStatic",
						inputs: instruction.inputs.filter((_, index) => index !== 1),
						attributes: { ...instruction.attributes, stringIndex },
					};
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

export interface CoreOptimizationResult {
	readonly program: CoreProgram;
	readonly changed: boolean;
	readonly passes: ReadonlyArray<{
		readonly name: string;
		readonly round: number;
		readonly changed: boolean;
	}>;
}

interface CoreFunctionPass {
	readonly name: string;
	readonly ablation?: OptimizationAblation;
	/** Block identity is part of a region certificate until CFG regions migrate. */
	readonly changesControlFlow?: boolean;
	run(
		fn: CoreFunction,
		analyses: CoreAnalysisManager,
		program: CoreProgram,
	): CoreFunction;
}

function instructionAttribute(instruction: CoreInstruction, name: string): unknown {
	return instruction.attributes[name];
}

/** Per-function analysis cache keyed by the immutable function snapshot. */
export class CoreAnalysisManager {
	readonly #controlFlow = new WeakMap<CoreFunction, CoreControlFlow>();

	controlFlow(fn: CoreFunction): CoreControlFlow {
		let analysis = this.#controlFlow.get(fn);
		if (analysis === undefined) {
			analysis = buildCoreControlFlow(fn, coreOpcodeRegistry);
			this.#controlFlow.set(fn, analysis);
		}
		return analysis;
	}
}

function resolveValue(
	value: CoreValueId,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreValueId {
	let current = value;
	const seen = new Set<CoreValueId>();
	while (replacements.has(current)) {
		if (seen.has(current)) throw new Error(`Cyclic Core value replacement at ${current}`);
		seen.add(current);
		current = replacements.get(current)!;
	}
	return current;
}

function rewriteEdge(
	edge: CoreEdge,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreEdge {
	return {
		...edge,
		arguments: edge.arguments.map((value) => resolveValue(value, replacements)),
	};
}

function rewriteTerminator(
	terminator: CoreTerminator,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
): CoreTerminator {
	switch (terminator.kind) {
		case "jump":
			return { ...terminator, edge: rewriteEdge(terminator.edge, replacements) };
		case "branch":
			return {
				...terminator,
				condition: resolveValue(terminator.condition, replacements),
				consequent: rewriteEdge(terminator.consequent, replacements),
				alternate: rewriteEdge(terminator.alternate, replacements),
			};
		case "guard":
			return {
				...terminator,
				condition: resolveValue(terminator.condition, replacements),
				success: rewriteEdge(terminator.success, replacements),
				fallback: rewriteEdge(terminator.fallback, replacements),
			};
		case "switch":
			return {
				...terminator,
				discriminant: resolveValue(terminator.discriminant, replacements),
				cases: terminator.cases.map((entry) => ({
					...entry,
					edge: rewriteEdge(entry.edge, replacements),
				})),
				default: rewriteEdge(terminator.default, replacements),
			};
		case "return":
		case "throw":
			return { ...terminator, value: resolveValue(terminator.value, replacements) };
		case "unreachable":
			return terminator;
	}
}

function rewriteFunction(
	fn: CoreFunction,
	blocks: ReadonlyArray<CoreBlock>,
	replacements: ReadonlyMap<CoreValueId, CoreValueId>,
	removedInstructions: ReadonlySet<number>,
): CoreFunction {
	const removedValues = new Set(replacements.keys());
	return {
		...fn,
		blocks: blocks.map((block) => ({
			...block,
			instructions: block.instructions
				.filter(({ id }) => !removedInstructions.has(id))
				.map((instruction) => ({
					...instruction,
					inputs: instruction.inputs.map((value) => resolveValue(value, replacements)),
				})),
			terminator: rewriteTerminator(block.terminator, replacements),
			...(block.handler === undefined
				? {}
				: {
						handler: {
							...block.handler,
							arguments: block.handler.arguments.map((value) =>
								resolveValue(value, replacements),
							),
						},
					}),
		})),
		values: fn.values.filter(({ id }) => !removedValues.has(id)),
		mutationEpoch: fn.mutationEpoch + 1,
	};
}

function stableAttributeValue(value: unknown): string {
	if (value === undefined) return "u";
	if (value === null) return "n";
	if (typeof value === "boolean") return value ? "b1" : "b0";
	if (typeof value === "number") {
		if (Number.isNaN(value)) return "dNaN";
		if (Object.is(value, -0)) return "d-0";
		if (value === Number.POSITIVE_INFINITY) return "d+Inf";
		if (value === Number.NEGATIVE_INFINITY) return "d-Inf";
		return `d${value}`;
	}
	if (typeof value === "string") return `s${JSON.stringify(value)}`;
	if (Array.isArray(value)) {
		const arrayValue: ReadonlyArray<unknown> = value;
		return `[${arrayValue.map(stableAttributeValue).join(",")}]`;
	}
	if (typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableAttributeValue(entry)}`)
			.join(",")}}`;
	}
	throw new Error(`Unsupported Core attribute key value ${typeof value}`);
}

function stableAttributes(instruction: CoreInstruction): string {
	return stableAttributeValue(instruction.attributes);
}

function constantImmediate(instruction: CoreInstruction): CoreImmediate | undefined {
	switch (instruction.opcode) {
		case "createUndefined":
			return { kind: "undefined" };
		case "createNull":
			return { kind: "null" };
		case "createBoolean":
			return typeof instructionAttribute(instruction, "value") === "boolean"
				? {
						kind: "boolean",
						value: instructionAttribute(instruction, "value") as boolean,
					}
				: undefined;
		case "createNumber":
		case "createF64":
			return typeof instructionAttribute(instruction, "value") === "number"
				? {
						kind: "number",
						value: instructionAttribute(instruction, "value") as number,
					}
				: undefined;
		case "createString":
			return typeof instructionAttribute(instruction, "stringIndex") === "number"
				? {
						kind: "string",
						index: instructionAttribute(instruction, "stringIndex") as number,
					}
				: undefined;
		default:
			return undefined;
	}
}

function primitiveTruthy(value: CoreImmediate): boolean | undefined {
	switch (value.kind) {
		case "undefined":
		case "null":
			return false;
		case "boolean":
			return value.value;
		case "number":
			return value.value !== 0 && !Number.isNaN(value.value);
		case "string":
			return undefined;
	}
}

function primitiveNumber(value: CoreImmediate): number | undefined {
	switch (value.kind) {
		case "undefined":
			return Number.NaN;
		case "null":
			return 0;
		case "boolean":
			return value.value ? 1 : 0;
		case "number":
			return value.value;
		case "string":
			return undefined;
	}
}

function foldUnaryPrimitive(
	operator: unknown,
	operand: CoreImmediate,
): CoreImmediate | undefined {
	switch (operator) {
		case "!": {
			const truthy = primitiveTruthy(operand);
			return truthy === undefined ? undefined : { kind: "boolean", value: !truthy };
		}
		case "+":
		case "-":
		case "~": {
			const numeric = primitiveNumber(operand);
			if (numeric === undefined) return undefined;
			return {
				kind: "number",
				value: operator === "+" ? numeric : operator === "-" ? -numeric : ~numeric,
			};
		}
		default:
			return undefined;
	}
}

function foldNumericBinary(
	operator: unknown,
	left: number,
	right: number,
): CoreImmediate | undefined {
	switch (operator) {
		case "+":
			return { kind: "number", value: left + right };
		case "-":
			return { kind: "number", value: left - right };
		case "*":
			return { kind: "number", value: left * right };
		case "/":
			return { kind: "number", value: left / right };
		case "%":
			return { kind: "number", value: left % right };
		case "&":
			return { kind: "number", value: left & right };
		case "|":
			return { kind: "number", value: left | right };
		case "^":
			return { kind: "number", value: left ^ right };
		case "<<":
			return { kind: "number", value: left << right };
		case ">>":
			return { kind: "number", value: left >> right };
		case ">>>":
			return { kind: "number", value: left >>> right };
		case "<":
			return { kind: "boolean", value: left < right };
		case "<=":
			return { kind: "boolean", value: left <= right };
		case ">":
			return { kind: "boolean", value: left > right };
		case ">=":
			return { kind: "boolean", value: left >= right };
		case "==":
		case "===":
			return { kind: "boolean", value: left === right };
		case "!=":
		case "!==":
			return { kind: "boolean", value: left !== right };
		default:
			// Exponentiation remains runtime-evaluated so host/self-host compilers
			// cannot disagree on serialized transcendental f64 bits.
			return undefined;
	}
}

function foldPrimitiveBinary(
	operator: unknown,
	left: CoreImmediate,
	right: CoreImmediate,
): CoreImmediate | undefined {
	if (left.kind === "number" && right.kind === "number") {
		return foldNumericBinary(operator, left.value, right.value);
	}
	if (
		operator !== "===" &&
		operator !== "!==" &&
		operator !== "==" &&
		operator !== "!="
	) {
		return undefined;
	}
	const loose = operator === "==" || operator === "!=";
	let equal = false;
	if (left.kind === right.kind) {
		equal = immediateStrictEquals(left, right);
	} else if (loose) {
		if (
			(left.kind === "null" && right.kind === "undefined") ||
			(left.kind === "undefined" && right.kind === "null")
		) {
			equal = true;
		} else {
			const leftNumber = primitiveNumber(left);
			const rightNumber = primitiveNumber(right);
			equal =
				leftNumber !== undefined &&
				rightNumber !== undefined &&
				leftNumber === rightNumber;
		}
	}
	return {
		kind: "boolean",
		value: operator === "!==" || operator === "!=" ? !equal : equal,
	};
}

function foldedInstruction(
	instruction: CoreInstruction,
	value: CoreImmediate,
):
	| {
			readonly instruction: CoreInstruction;
			readonly representation: "boxed" | "f64" | "boolean";
	  }
	| undefined {
	const common = {
		...instruction,
		inputs: [],
	};
	switch (value.kind) {
		case "undefined":
			return {
				instruction: { ...common, opcode: "createUndefined", attributes: {} },
				representation: "boxed",
			};
		case "null":
			return {
				instruction: { ...common, opcode: "createNull", attributes: {} },
				representation: "boxed",
			};
		case "boolean":
			return {
				instruction: {
					...common,
					opcode: "createBoolean",
					attributes: { value: value.value },
				},
				representation: "boolean",
			};
		case "number":
			return {
				instruction: {
					...common,
					opcode: "createF64",
					attributes: { value: value.value },
				},
				representation: "f64",
			};
		case "string":
			return undefined;
	}
}

const foldPrimitiveConstants: CoreFunctionPass = {
	name: "fold-primitive-constants",
	ablation: "constant-folding",
	run(fn) {
		const constants = new Map<CoreValueId, CoreImmediate>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.outputs.length !== 1) continue;
				const value = constantImmediate(instruction);
				if (value !== undefined) constants.set(instruction.outputs[0]!, value);
			}
		}
		const representations = new Map<CoreValueId, "boxed" | "f64" | "boolean">();
		let changed = false;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction) => {
					if (instruction.outputs.length !== 1) return instruction;
					let result: CoreImmediate | undefined;
					if (instruction.opcode === "unary" && instruction.inputs.length === 1) {
						const operand = constants.get(instruction.inputs[0]!);
						if (operand !== undefined) {
							result = foldUnaryPrimitive(
								instructionAttribute(instruction, "operator"),
								operand,
							);
						}
					} else if (instruction.opcode === "binary" && instruction.inputs.length === 2) {
						const left = constants.get(instruction.inputs[0]!);
						const right = constants.get(instruction.inputs[1]!);
						if (left !== undefined && right !== undefined) {
							result = foldPrimitiveBinary(
								instructionAttribute(instruction, "operator"),
								left,
								right,
							);
						}
					}
					if (result === undefined) return instruction;
					const replacement = foldedInstruction(instruction, result);
					if (replacement === undefined) return instruction;
					changed = true;
					constants.set(instruction.outputs[0]!, result);
					representations.set(instruction.outputs[0]!, replacement.representation);
					return replacement.instruction;
				}),
			}),
		);
		if (!changed) return fn;
		return {
			...fn,
			blocks,
			values: fn.values.map((value) => {
				const representation = representations.get(value.id);
				return representation === undefined ? value : { ...value, representation };
			}),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

function immediateTruthiness(value: CoreImmediate): boolean | undefined {
	switch (value.kind) {
		case "undefined":
		case "null":
			return false;
		case "boolean":
			return value.value;
		case "number":
			return value.value !== 0 && !Number.isNaN(value.value);
		case "string":
			// The canonical string table does not yet expose contents to Core.
			return undefined;
	}
}

function immediateStrictEquals(left: CoreImmediate, right: CoreImmediate): boolean {
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case "undefined":
		case "null":
			return true;
		case "boolean":
			return left.value === (right as Extract<CoreImmediate, { kind: "boolean" }>).value;
		case "number":
			return left.value === (right as Extract<CoreImmediate, { kind: "number" }>).value;
		case "string":
			return left.index === (right as Extract<CoreImmediate, { kind: "string" }>).index;
	}
}

/** Resolve primitive branches and switches, then restore Core's dense reachable CFG. */
const simplifyControlFlow: CoreFunctionPass = {
	name: "simplify-control-flow",
	changesControlFlow: true,
	run(fn) {
		const constants = new Map<CoreValueId, CoreImmediate>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.outputs.length !== 1) continue;
				const value = constantImmediate(instruction);
				if (value !== undefined) constants.set(instruction.outputs[0]!, value);
			}
		}
		let changed = false;
		const blocks = fn.blocks.map((block): CoreBlock => {
			const terminator = block.terminator;
			if (terminator.kind === "branch") {
				const condition = constants.get(terminator.condition);
				const truthy =
					condition === undefined ? undefined : immediateTruthiness(condition);
				if (truthy === undefined) return block;
				changed = true;
				return {
					...block,
					terminator: {
						kind: "jump",
						id: terminator.id,
						edge: truthy ? terminator.consequent : terminator.alternate,
						...(terminator.sourcePosition === undefined
							? {}
							: { sourcePosition: terminator.sourcePosition }),
					},
				};
			}
			if (terminator.kind === "switch") {
				const discriminant = constants.get(terminator.discriminant);
				if (discriminant === undefined) return block;
				const matched = terminator.cases.find(({ value }) =>
					immediateStrictEquals(discriminant, value),
				);
				changed = true;
				return {
					...block,
					terminator: {
						kind: "jump",
						id: terminator.id,
						edge: matched?.edge ?? terminator.default,
						...(terminator.sourcePosition === undefined
							? {}
							: { sourcePosition: terminator.sourcePosition }),
					},
				};
			}
			return block;
		});
		if (!changed) return fn;
		return removeUnreachableCoreBlocks({
			...fn,
			blocks,
			mutationEpoch: fn.mutationEpoch + 1,
		});
	},
};

const VALUE_NUMBERED_OPCODES = new Set([
	"createBigint",
	"createBoolean",
	"createEmpty",
	"createF64",
	"createNull",
	"createNumber",
	"createString",
	"createUndefined",
	"mathBinaryNumber",
	"mathUnaryNumber",
]);

const copyAndValueNumber: CoreFunctionPass = {
	name: "copy-and-value-number",
	ablation: "constant-folding",
	run(fn) {
		const replacements = new Map<CoreValueId, CoreValueId>();
		const removedInstructions = new Set<number>();
		const blocks = fn.blocks.map((block): CoreBlock => {
			const available = new Map<string, ReadonlyArray<CoreValueId>>();
			const instructions: Array<CoreInstruction> = [];
			for (const original of block.instructions) {
				const instruction: CoreInstruction = {
					...original,
					inputs: original.inputs.map((value) => resolveValue(value, replacements)),
				};
				if (
					instruction.opcode === "move" &&
					instruction.inputs.length === 1 &&
					instruction.outputs.length === 1
				) {
					replacements.set(instruction.outputs[0]!, instruction.inputs[0]!);
					removedInstructions.add(instruction.id);
					continue;
				}
				if (VALUE_NUMBERED_OPCODES.has(instruction.opcode)) {
					const key = `${instruction.opcode}\0${instruction.inputs.join(",")}\0${stableAttributes(instruction)}`;
					const previous = available.get(key);
					if (previous !== undefined && previous.length === instruction.outputs.length) {
						for (const [index, output] of instruction.outputs.entries()) {
							replacements.set(output, previous[index]!);
						}
						removedInstructions.add(instruction.id);
						continue;
					}
					available.set(key, instruction.outputs);
				}
				instructions.push(instruction);
			}
			return { ...block, instructions };
		});
		if (removedInstructions.size === 0) return fn;
		return rewriteFunction(fn, blocks, replacements, removedInstructions);
	},
};

function collectUses(fn: CoreFunction): Set<CoreValueId> {
	const uses = new Set<CoreValueId>();
	const addEdge = (edge: CoreEdge) => {
		for (const value of edge.arguments) uses.add(value);
	};
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) uses.add(input);
		}
		if (block.handler !== undefined) {
			for (const value of block.handler.arguments) uses.add(value);
		}
		switch (block.terminator.kind) {
			case "jump":
				addEdge(block.terminator.edge);
				break;
			case "branch":
				uses.add(block.terminator.condition);
				addEdge(block.terminator.consequent);
				addEdge(block.terminator.alternate);
				break;
			case "guard":
				uses.add(block.terminator.condition);
				addEdge(block.terminator.success);
				addEdge(block.terminator.fallback);
				break;
			case "switch":
				uses.add(block.terminator.discriminant);
				for (const { edge } of block.terminator.cases) addEdge(edge);
				addEdge(block.terminator.default);
				break;
			case "return":
			case "throw":
				uses.add(block.terminator.value);
				break;
			case "unreachable":
				break;
		}
	}
	return uses;
}

const deadInstructionElimination: CoreFunctionPass = {
	name: "dead-instruction-elimination",
	run(fn) {
		const uses = collectUses(fn);
		const removedInstructions = new Set<number>();
		const removedValues = new Map<CoreValueId, CoreValueId>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.outputs.length > 0 &&
					instruction.outputs.every((output) => !uses.has(output)) &&
					(coreOpcodeRegistry.require(instruction.opcode).discardable ||
						(instruction.opcode === "unary" &&
							instructionAttribute(instruction, "operator") === "typeof"))
				) {
					removedInstructions.add(instruction.id);
					for (const output of instruction.outputs) removedValues.set(output, output);
				}
			}
		}
		if (removedInstructions.size === 0) return fn;
		const removed = new Set(removedValues.keys());
		return {
			...fn,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions.filter(({ id }) => !removedInstructions.has(id)),
			})),
			values: fn.values.filter(({ id }) => !removed.has(id)),
			mutationEpoch: fn.mutationEpoch + 1,
		};
	},
};

/** Merge one dominance-safe linear edge at a time, substituting block arguments. */
const combineLinearBlocks: CoreFunctionPass = {
	name: "combine-linear-blocks",
	changesControlFlow: true,
	run(fn, analyses) {
		const cfg = analyses.controlFlow(fn);
		for (const predecessor of fn.blocks) {
			if (predecessor.handler !== undefined || predecessor.terminator.kind !== "jump") {
				continue;
			}
			const targetId = predecessor.terminator.edge.block;
			if (
				targetId === predecessor.id ||
				targetId === fn.entry ||
				targetId === fn.bodyEntry
			) {
				continue;
			}
			const target = fn.blocks[targetId];
			if (target === undefined || target.handler !== undefined) continue;
			const incoming = cfg.predecessors[targetId]!;
			if (
				incoming.length !== 1 ||
				incoming[0]!.kind !== "ordinary" ||
				incoming[0]!.from !== predecessor.id
			) {
				continue;
			}
			const replacements = new Map<CoreValueId, CoreValueId>();
			for (const [index, parameter] of target.parameters.entries()) {
				replacements.set(parameter.value, predecessor.terminator.edge.arguments[index]!);
			}
			const merged: CoreBlock = {
				...predecessor,
				instructions: [
					...predecessor.instructions,
					...target.instructions.map((instruction) => ({
						...instruction,
						inputs: instruction.inputs.map((value) => resolveValue(value, replacements)),
					})),
				],
				terminator: rewriteTerminator(target.terminator, replacements),
			};
			const blocks = fn.blocks.map((block) =>
				block.id === predecessor.id ? merged : block,
			);
			return removeUnreachableCoreBlocks({
				...fn,
				blocks,
				mutationEpoch: fn.mutationEpoch + 1,
			});
		}
		return fn;
	},
};

const CORE_PASSES: ReadonlyArray<CoreFunctionPass> = [
	annotateTerminalYieldSites,
	annotateKnownBuiltinCalls,
	foldTypeofComparisons,
	foldExactObjectObservations,
	eliminateRedundantTdzChecks,
	foldPrimitiveConstants,
	simplifyControlFlow,
	combineLinearBlocks,
	foldStaticPropertyKeys,
	copyAndValueNumber,
	deadInstructionElimination,
];

const CORE_FINALIZATION_PASSES: ReadonlyArray<CoreFunctionPass> = [
	annotateFreshDenseIndexedReserves,
	annotateBoundedStringCharCodeAtPositions,
	selectStackObjectRegions,
	selectRegExpExecProjectionRegions,
	selectRegExpIteratorProjectionRegions,
	selectStringSplitCursorRegions,
	selectStringSplitProjectionRegions,
	selectStringSliceNumberRegions,
	selectNumericFusionRegions,
];

function claimedInstructionSnapshots(fn: CoreFunction): ReadonlyMap<number, string> {
	const claimed = new Set(
		fn.regions.flatMap(({ claimedInstructions }) => claimedInstructions),
	);
	if (claimed.size === 0) return new Map();
	const snapshots = new Map<number, string>();
	for (const block of fn.blocks) {
		for (const instruction of [...block.instructions, block.terminator]) {
			if (!claimed.has(instruction.id)) continue;
			snapshots.set(instruction.id, `${block.id}\0${stableAttributeValue(instruction)}`);
		}
	}
	return snapshots;
}

function preservesClaimedInstructions(
	before: ReadonlyMap<number, string>,
	fn: CoreFunction,
): boolean {
	if (before.size === 0) return true;
	const after = claimedInstructionSnapshots(fn);
	if (after.size !== before.size) return false;
	for (const [instruction, snapshot] of before) {
		if (after.get(instruction) !== snapshot) return false;
	}
	return true;
}

export function executeCoreOptimizations(
	program: CoreProgram,
	options: CoreOptimizationOptions = {},
): CoreOptimizationResult {
	const maxRounds = options.maxRounds ?? 8;
	if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) {
		throw new Error(`Invalid Core optimization round limit ${maxRounds}`);
	}
	const analyses = new CoreAnalysisManager();
	const traces: Array<{ name: string; round: number; changed: boolean }> = [];
	const optimizationTrace: Array<OptimizationPassDelta> = [];
	const collectOptimizationTrace = program.compilation?.optimizationTrace !== undefined;
	const inlineBefore = collectOptimizationTrace
		? coreOptimizationMetrics(program)
		: undefined;
	const inlineAblated = options.ablations?.has("inlining") === true;
	const inlineResult = inlineAblated
		? { program, changed: false }
		: inlineSimpleCoreFunctions(program);
	const directBefore = collectOptimizationTrace
		? coreOptimizationMetrics(inlineResult.program)
		: undefined;
	const directResult = annotateCoreDirectCallTargets(inlineResult.program);
	const workingProgram = directResult.program;
	let changed = inlineResult.changed || directResult.changed;
	let functions = [...workingProgram.functions];
	for (const fn of inlineResult.program.functions) {
		traces.push({
			name: "inline-small-functions",
			round: 0,
			changed: fn !== program.functions[fn.functionIndex],
		});
	}
	for (const fn of functions) {
		traces.push({
			name: "annotate-direct-call-targets",
			round: 0,
			changed: fn !== inlineResult.program.functions[fn.functionIndex],
		});
	}
	if (inlineBefore !== undefined) {
		const inlineAfter = coreOptimizationMetrics(inlineResult.program);
		optimizationTrace.push(
			optimizationPassDelta(
				{
					pass: "inline-small-functions",
					stage: "normalization",
					status: inlineAblated ? "ablated" : "executed",
					changed: inlineResult.changed,
					ablation: "inlining",
				},
				inlineBefore,
				inlineAfter,
			),
		);
	}
	if (directBefore !== undefined) {
		const directAfter = coreOptimizationMetrics(workingProgram);
		optimizationTrace.push(
			optimizationPassDelta(
				{
					pass: "annotate-direct-call-targets",
					stage: "normalization",
					status: "executed",
					changed: directResult.changed,
				},
				directBefore,
				directAfter,
			),
		);
	}
	for (let round = 0; round < maxRounds; round++) {
		let roundChanged = false;
		for (const pass of CORE_PASSES) {
			const featureGated =
				options.simplifyValues === false &&
				(pass === copyAndValueNumber || pass === deadInstructionElimination);
			const ablated =
				pass.ablation !== undefined && options.ablations?.has(pass.ablation) === true;
			const beforeProgram = { ...workingProgram, functions };
			const before = collectOptimizationTrace
				? coreOptimizationMetrics(beforeProgram)
				: undefined;
			if (featureGated) {
				for (const _fn of functions) {
					traces.push({ name: pass.name, round, changed: false });
				}
				if (before !== undefined) {
					optimizationTrace.push(
						optimizationPassDelta(
							{
								pass: pass.name,
								stage: "fixpoint",
								round,
								status: "feature-gated",
								changed: false,
							},
							before,
							before,
						),
					);
				}
				continue;
			}
			if (ablated) {
				for (const _fn of functions) {
					traces.push({ name: pass.name, round, changed: false });
				}
				if (before !== undefined) {
					optimizationTrace.push(
						optimizationPassDelta(
							{
								pass: pass.name,
								stage: "fixpoint",
								round,
								status: "ablated",
								changed: false,
								ablation: pass.ablation,
							},
							before,
							before,
						),
					);
				}
				continue;
			}
			let passChanged = false;
			functions = functions.map((fn) => {
				if (fn.regions.length > 0 && pass.changesControlFlow === true) {
					traces.push({ name: pass.name, round, changed: false });
					return fn;
				}
				const claimed = claimedInstructionSnapshots(fn);
				const candidate = pass.run(fn, analyses, beforeProgram);
				const next = preservesClaimedInstructions(claimed, candidate) ? candidate : fn;
				const functionChanged = next !== fn;
				traces.push({ name: pass.name, round, changed: functionChanged });
				if (functionChanged) {
					verifyCoreFunction(next, coreOpcodeRegistry);
					passChanged = true;
					roundChanged = true;
					changed = true;
				}
				return next;
			});
			if (before !== undefined) {
				const after = coreOptimizationMetrics({ ...workingProgram, functions });
				optimizationTrace.push(
					optimizationPassDelta(
						{
							pass: pass.name,
							stage: "fixpoint",
							round,
							status: "executed",
							changed: passChanged,
							...(pass.ablation === undefined ? {} : { ablation: pass.ablation }),
						},
						before,
						after,
					),
				);
			}
		}
		if (!roundChanged) break;
	}
	for (const pass of CORE_FINALIZATION_PASSES) {
		const beforeProgram = { ...workingProgram, functions };
		const before = collectOptimizationTrace
			? coreOptimizationMetrics(beforeProgram)
			: undefined;
		const ablated =
			pass.ablation !== undefined && options.ablations?.has(pass.ablation) === true;
		let passChanged = false;
		if (!ablated) {
			functions = functions.map((fn) => {
				const candidate = pass.run(fn, analyses, beforeProgram);
				const functionChanged = candidate !== fn;
				traces.push({ name: pass.name, round: maxRounds, changed: functionChanged });
				if (functionChanged) {
					verifyCoreFunction(candidate, coreOpcodeRegistry);
					passChanged = true;
					changed = true;
				}
				return candidate;
			});
		} else {
			for (const _fn of functions) {
				traces.push({ name: pass.name, round: maxRounds, changed: false });
			}
		}
		if (before !== undefined) {
			const after = coreOptimizationMetrics({ ...workingProgram, functions });
			optimizationTrace.push(
				optimizationPassDelta(
					{
						pass: pass.name,
						stage: "finalization",
						status: ablated ? "ablated" : "executed",
						changed: passChanged,
						...(pass.ablation === undefined ? {} : { ablation: pass.ablation }),
					},
					before,
					after,
				),
			);
		}
	}
	return {
		program: {
			...workingProgram,
			functions,
			...(workingProgram.compilation === undefined
				? {}
				: {
						compilation: {
							...workingProgram.compilation,
							...(collectOptimizationTrace ? { optimizationTrace } : {}),
						},
					}),
		},
		changed,
		passes: traces,
	};
}
