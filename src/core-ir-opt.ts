import { builtinOperations } from "./builtin-registry.ts";
import type {
	CompilerOptimizationDecision,
	OptimizationAblation,
	OptimizationDecisionReason,
	OptimizationMetrics,
	OptimizationPassDelta,
} from "./compiler-diagnostics.ts";
import { knownFact, sourceSiteId } from "./compiler-facts.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import { verifyCoreFunction } from "./core-ir-verifier.ts";
import type {
	CoreBlock,
	CoreBlockId,
	CoreAttributeValue,
	CoreEdge,
	CoreFact,
	CoreFunction,
	CoreImmediate,
	CoreInstruction,
	CoreInstructionId,
	CoreProgram,
	CoreTerminator,
	CoreValueId,
} from "./core-ir.ts";
import { coreBlockId, coreInstructionId, coreValueId } from "./core-ir.ts";

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
	run(fn, _analyses, program) {
		const compilation = program.compilation;
		if (compilation === undefined) return fn;
		const definitions = new Map<CoreValueId, CoreInstruction>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				for (const output of instruction.outputs) definitions.set(output, instruction);
			}
		}
		let changed = false;
		let guardOrdinal = 0;
		const blocks = fn.blocks.map(
			(block): CoreBlock => ({
				...block,
				instructions: block.instructions.map((instruction) => {
					if (
						instruction.opcode !== "call" ||
						instruction.attributes.knownBuiltinCall !== undefined ||
						instruction.inputs.length < 2
					) {
						return instruction;
					}
					const property = definitions.get(instruction.inputs[0]!);
					const stringIndex = property?.attributes.stringIndex;
					if (
						property?.opcode !== "loadPropertyStatic" ||
						property.inputs.length !== 1 ||
						property.inputs[0] !== instruction.inputs[1] ||
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
					return {
						...instruction,
						attributes: {
							...instruction.attributes,
							knownBuiltinCall: coreAttribute(
								{
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
								},
								"knownBuiltinCall",
							),
						},
					};
				}),
			}),
		);
		return changed ? { ...fn, blocks, mutationEpoch: fn.mutationEpoch + 1 } : fn;
	},
};

const MAX_INLINE_INSTRUCTIONS = 40;
const INLINE_DISQUALIFYING_OPCODES = new Set([
	"loadThis",
	"loadNewTarget",
	"loadCallee",
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

function linearInlineTarget(target: CoreFunction): LinearInlineTarget | undefined {
	if (target.isGenerator || target.isAsync || target.regions.length > 0) return undefined;
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
					materialization: "on-demand",
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

/** Fold an exact string SSA value into the property operation's attributes. */
const foldStaticPropertyKeys: CoreFunctionPass = {
	name: "fold-static-property-keys",
	ablation: "static-properties",
	run(fn) {
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
					const stringIndex = strings.get(instruction.inputs[1]!);
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

function remapEdge(
	edge: CoreEdge,
	blocks: ReadonlyMap<CoreBlockId, CoreBlockId>,
): CoreEdge {
	const block = blocks.get(edge.block);
	if (block === undefined)
		throw new Error(`Cannot retain edge to removed Core block ${edge.block}`);
	return { ...edge, block };
}

function remapBlockTerminator(
	terminator: CoreTerminator,
	blocks: ReadonlyMap<CoreBlockId, CoreBlockId>,
): CoreTerminator {
	switch (terminator.kind) {
		case "jump":
			return { ...terminator, edge: remapEdge(terminator.edge, blocks) };
		case "branch":
			return {
				...terminator,
				consequent: remapEdge(terminator.consequent, blocks),
				alternate: remapEdge(terminator.alternate, blocks),
			};
		case "guard":
			return {
				...terminator,
				success: remapEdge(terminator.success, blocks),
				fallback: remapEdge(terminator.fallback, blocks),
			};
		case "switch":
			return {
				...terminator,
				cases: terminator.cases.map((entry) => ({
					...entry,
					edge: remapEdge(entry.edge, blocks),
				})),
				default: remapEdge(terminator.default, blocks),
			};
		case "return":
		case "throw":
		case "unreachable":
			return terminator;
	}
}

function factSurvivesBlockRemoval(
	fact: CoreFact,
	liveInstructions: ReadonlySet<number>,
): boolean {
	if (
		fact.validity.kind === "guard" &&
		!liveInstructions.has(fact.validity.instruction)
	) {
		return false;
	}
	return fact.obligations.every(
		(obligation) =>
			obligation.kind !== "guard" || liveInstructions.has(obligation.instruction),
	);
}

function removeUnreachableBlocks(fn: CoreFunction): CoreFunction {
	const cfg = buildCoreControlFlow(fn, coreOpcodeRegistry);
	if (cfg.reachable.size === fn.blocks.length) return fn;
	const blockIds = new Map<CoreBlockId, CoreBlockId>();
	for (const block of fn.blocks) {
		if (cfg.reachable.has(block.id)) blockIds.set(block.id, coreBlockId(blockIds.size));
	}
	const liveInstructions = new Set<number>();
	for (const block of fn.blocks) {
		if (!cfg.reachable.has(block.id)) continue;
		for (const instruction of block.instructions) liveInstructions.add(instruction.id);
		liveInstructions.add(block.terminator.id);
	}
	const blocks = fn.blocks
		.filter((block) => cfg.reachable.has(block.id))
		.map((block): CoreBlock => {
			const id = blockIds.get(block.id)!;
			const handlerTarget =
				block.handler === undefined ? undefined : blockIds.get(block.handler.block);
			return {
				...block,
				id,
				terminator: remapBlockTerminator(block.terminator, blockIds),
				...(handlerTarget === undefined
					? { handler: undefined }
					: { handler: { ...block.handler!, block: handlerTarget } }),
			};
		});
	const values = fn.values
		.filter((value) =>
			value.definition.kind === "block-parameter"
				? blockIds.has(value.definition.block)
				: liveInstructions.has(value.definition.instruction),
		)
		.map((value) =>
			value.definition.kind !== "block-parameter"
				? value
				: {
						...value,
						definition: {
							...value.definition,
							block: blockIds.get(value.definition.block)!,
						},
					},
		);
	const entry = blockIds.get(fn.entry);
	if (entry === undefined) throw new Error("Core entry block became unreachable");
	const bodyEntry = fn.bodyEntry === undefined ? undefined : blockIds.get(fn.bodyEntry);
	return {
		...fn,
		entry,
		...(bodyEntry === undefined ? { bodyEntry: undefined } : { bodyEntry }),
		blocks,
		values,
		facts: fn.facts.filter((fact) => factSurvivesBlockRemoval(fact, liveInstructions)),
		mutationEpoch: fn.mutationEpoch + 1,
	};
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
		return removeUnreachableBlocks({
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
					coreOpcodeRegistry.require(instruction.opcode).discardable
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
			return removeUnreachableBlocks({
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
	foldExactObjectObservations,
	selectStackObjectRegions,
	foldPrimitiveConstants,
	simplifyControlFlow,
	combineLinearBlocks,
	foldStaticPropertyKeys,
	copyAndValueNumber,
	deadInstructionElimination,
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
	const workingProgram = inlineResult.program;
	let changed = inlineResult.changed;
	let functions = [...workingProgram.functions];
	for (const fn of functions) {
		traces.push({
			name: "inline-small-functions",
			round: 0,
			changed: fn !== program.functions[fn.functionIndex],
		});
	}
	if (inlineBefore !== undefined) {
		const inlineAfter = coreOptimizationMetrics(workingProgram);
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
