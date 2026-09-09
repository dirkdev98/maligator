import { verifyBuiltinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import { exactBuiltinCallDescriptor } from "../shared/builtin-registry.ts";
import type { WorldFacts } from "../shared/compiler-facts.ts";
import { effectSummaryCovers } from "../shared/effect-summary.ts";
import { isKnownBuiltinError } from "../shared/known-builtin-errors.ts";
import { knownArgumentModes } from "../shared/known-operations.ts";
import { knownOperationIndex } from "../shared/known-operations.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import { isStringCollationPlan } from "../shared/string-collation-plan.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { buildCoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import {
	CORE_FACT_ALTERNATIVE_LIMIT,
	CORE_FACT_CLAIM_LIMIT,
	coreFactClaimIsSatisfiable,
} from "./core-ir-fact-implication.ts";
import type {
	CoreAttributeValue,
	CoreAttributeRelocation,
	CoreBlockId,
	CoreChangeSet,
	CoreFact,
	CoreFunctionId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreBlockId, coreFactId, coreInstructionId, coreValueId } from "./core-ir.ts";
import type { CoreOptimizationStage } from "./core-pass.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export type CoreVerificationStage =
	| CoreOptimizationStage
	| "construction"
	| "pre-optimization"
	| "final-region-selection"
	| "pre-target";

export interface CoreVerificationContext {
	readonly stage: CoreVerificationStage;
	readonly pass?: string;
	readonly functionIndex?: number;
}

export type CoreVerificationProfile = "boundary" | "per-pass";

function formatVerificationContext(context: CoreVerificationContext | undefined): string {
	if (context === undefined) return "";
	const parts = [`stage=${context.stage}`];
	if (context.pass !== undefined) parts.push(`pass=${context.pass}`);
	if (context.functionIndex !== undefined)
		parts.push(`function=${context.functionIndex}`);
	return ` [${parts.join(" ")}]`;
}

export class CoreIrVerificationError extends Error {
	readonly detail: string;
	readonly context: CoreVerificationContext | undefined;

	constructor(detail: string, context?: CoreVerificationContext) {
		super(`Core IR verification failed${formatVerificationContext(context)}: ${detail}`);
		this.name = "CoreIrVerificationError";
		this.detail = detail;
		this.context = context;
	}
}

function fail(message: string): never {
	throw new CoreIrVerificationError(message);
}

function withContext<T>(context: CoreVerificationContext | undefined, run: () => T): T {
	try {
		return run();
	} catch (error) {
		if (error instanceof CoreIrVerificationError) {
			if (error.context === undefined && context !== undefined) {
				throw new CoreIrVerificationError(error.detail, context);
			}
			throw error;
		}
		if (error instanceof Error && context !== undefined) {
			throw new CoreIrVerificationError(error.message, context);
		}
		throw error;
	}
}

function checkRange(name: string, start: number, count: number, capacity: number): void {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(count) ||
		start < 0 ||
		count < 0 ||
		start + count > capacity
	) {
		fail(`${name} range ${start}..${start + count} exceeds capacity ${capacity}`);
	}
}

function arityAccepts(
	arity: { readonly minimum: number; readonly maximum: number },
	count: number,
): boolean {
	return count >= arity.minimum && count <= arity.maximum;
}

function verifyAttributeValue(
	value: CoreAttributeValue,
	path: string,
	ancestors: ReadonlySet<object> = new Set(),
): void {
	if (
		value === undefined ||
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return;
	}
	const object = value as object;
	if (ancestors.has(object)) fail(`${path} contains cyclic attribute data`);
	const nextAncestors = new Set(ancestors).add(object);
	if (Array.isArray(value)) {
		for (const [index, entry] of (value as ReadonlyArray<CoreAttributeValue>).entries()) {
			verifyAttributeValue(entry, `${path}[${index}]`, nextAncestors);
		}
		return;
	}
	const prototype = Object.getPrototypeOf(value) as unknown;
	if (prototype !== Object.prototype && prototype !== null) {
		fail(`${path} has a non-data attribute object`);
	}
	for (const [key, entry] of Object.entries(value)) {
		verifyAttributeValue(entry, `${path}.${key}`, nextAncestors);
	}
}

function attributeAtPath(
	attributes: CoreAttributeValue,
	path: ReadonlyArray<string>,
): CoreAttributeValue {
	let value = attributes;
	for (const part of path) {
		if (value === undefined) return undefined;
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			fail(`attribute relocation ${path.join(".")} crosses non-object data`);
		}
		value = (value as Readonly<Record<string, CoreAttributeValue>>)[part];
	}
	return value;
}

function verifyAttributeRelocations(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	attributes: CoreAttributeValue,
	contracts: ReadonlyArray<CoreAttributeRelocation>,
): void {
	for (const contract of contracts) {
		const path = contract.path.join(".");
		const value = attributeAtPath(attributes, contract.path);
		if (value === undefined) continue;
		const ids = contract.cardinality === "many" ? value : [value];
		if (!Array.isArray(ids) || !ids.every(Number.isSafeInteger)) {
			fail(`instruction @${instruction} attribute ${path} has invalid local IDs`);
		}
		for (const rawId of ids) {
			const id = rawId as number;
			if (id < 0) {
				fail(`instruction @${instruction} attribute ${path} has invalid local ID ${id}`);
			}
			const live =
				contract.kind === "block"
					? fn.isBlockLive(coreBlockId(id))
					: contract.kind === "instruction"
						? fn.isInstructionLive(coreInstructionId(id))
						: contract.kind === "value"
							? fn.isValueLive(coreValueId(id))
							: fn.isFactLive(coreFactId(id));
			if (!live) {
				fail(
					`instruction @${instruction} attribute ${path} references deleted ${contract.kind} ${id}`,
				);
			}
		}
	}
}

function verifyEffectRefinement(
	instruction: CoreInstructionId,
	refined: CoreInstructionEffects,
	baseline: CoreInstructionEffects,
): void {
	for (const domain of refined.reads) {
		if (!baseline.reads.includes(domain)) {
			fail(`instruction @${instruction} adds read effect ${domain} in a refinement`);
		}
	}
	for (const domain of refined.writes) {
		if (!baseline.writes.includes(domain)) {
			fail(`instruction @${instruction} adds write effect ${domain} in a refinement`);
		}
	}
	for (const flag of ["mayThrow", "maySuspend", "mayGc", "callsUserCode"] as const) {
		if (refined[flag] && !baseline[flag]) {
			fail(`instruction @${instruction} adds ${flag} in a refinement`);
		}
	}
}

function verifyMetadata(fn: CoreFunctionStore, program: CoreProgram): void {
	const metadata = fn.metadata;
	if (metadata.sourcePath.length === 0) fail("function source path is empty");
	for (const [name, value] of [
		["name string index", metadata.nameStringIndex],
		["length", metadata.length],
		["captured count", metadata.capturedCount],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 0) fail(`invalid ${name} ${value}`);
	}
	if (
		program.stringConstants.length > 0 &&
		metadata.nameStringIndex >= program.stringConstants.length
	) {
		fail(`function name string index ${metadata.nameStringIndex} is out of range`);
	}
	if (!metadata.mappedArguments && metadata.mappedArgumentSlots.length !== 0) {
		fail("unmapped function carries mapped argument slots");
	}
	const mapped = new Set<number>();
	for (const slot of metadata.mappedArgumentSlots) {
		if (!Number.isSafeInteger(slot) || slot < -1 || slot >= metadata.capturedCount) {
			fail(`invalid mapped argument slot ${slot}`);
		}
		if (slot === -1) continue;
		if (mapped.has(slot)) fail(`duplicate mapped argument slot ${slot}`);
		mapped.add(slot);
	}
	if (metadata.isDerivedConstructor && !metadata.isClassConstructor) {
		fail("derived constructor metadata requires a class constructor");
	}
	if (fn.bodyEntry !== undefined && !fn.isBlockLive(fn.bodyEntry)) {
		fail(`function body entry b${fn.bodyEntry} is deleted`);
	}
}

function verifyBlockRows(fn: CoreFunctionStore): void {
	const linked = new Uint8Array(fn.instructionCapacity);
	for (let rawBlock = 0; rawBlock < fn.blockCapacity; rawBlock++) {
		const block = coreBlockId(rawBlock);
		const parameterStart = fn.kernel.blockParameterStart(block);
		const parameterCount = fn.kernel.blockParameterCount(block);
		checkRange(
			`block b${block} parameter`,
			parameterStart,
			parameterCount,
			fn.blockParameterCapacity,
		);
		const firstInstruction = fn.kernel.blockFirstInstruction(block);
		const lastInstruction = fn.kernel.blockLastInstruction(block);
		if (fn.kernel.blockLive(block) === 0) {
			if (firstInstruction >= 0 || lastInstruction >= 0) {
				fail(`deleted block b${block} retains linked instructions`);
			}
			continue;
		}
		let previous = -1;
		let current = firstInstruction;
		let terminators = 0;
		while (current >= 0) {
			if (current >= fn.instructionCapacity) {
				fail(`block b${block} links unknown instruction @${current}`);
			}
			const instruction = coreInstructionId(current);
			if (linked[instruction] !== 0) {
				fail(`instruction @${instruction} appears twice in block order`);
			}
			linked[instruction] = 1;
			if (fn.kernel.instructionLive(instruction) === 0)
				fail(`block b${block} links deleted instruction @${current}`);
			const instructionBlock = fn.kernel.instructionBlock(instruction);
			if (instructionBlock !== block) {
				fail(`instruction @${current} belongs to b${instructionBlock}, not b${block}`);
			}
			if (fn.kernel.instructionPrevious(instruction) !== previous) {
				fail(`instruction @${current} has broken previous link`);
			}
			const kind = fn.instructionKind(instruction);
			if (kind !== "operation") terminators++;
			const next = fn.kernel.instructionNext(instruction);
			if (kind !== "operation" && next >= 0) {
				fail(`terminator @${current} is not last in b${block}`);
			}
			previous = current;
			current = next;
		}
		if (previous !== lastInstruction) fail(`block b${block} has broken last link`);
		if (firstInstruction < 0 || terminators !== 1) {
			fail(`block b${block} must contain exactly one terminator`);
		}
	}
	for (
		let rawInstruction = 0;
		rawInstruction < fn.instructionCapacity;
		rawInstruction++
	) {
		const instruction = coreInstructionId(rawInstruction);
		if ((fn.kernel.instructionLive(instruction) !== 0) !== (linked[instruction] !== 0)) {
			fail(`instruction @${instruction} live state disagrees with block order`);
		}
	}
}

interface OperandUseIndex {
	readonly valueCounts: Uint32Array;
	// Zero denotes an absent use; other entries encode the operand's value ID plus one.
	readonly valueByUse: Uint32Array;
}

function verifyInstructionRows(
	fn: CoreFunctionStore,
	program: CoreProgram,
	world?: WorldFacts,
): OperandUseIndex {
	const currentOperands = new Uint8Array(fn.operandCapacity);
	const valueCounts = new Uint32Array(fn.valueCapacity);
	const valueByUse = new Uint32Array(fn.useCapacity);
	for (
		let rawInstruction = 0;
		rawInstruction < fn.instructionCapacity;
		rawInstruction++
	) {
		const instruction = coreInstructionId(rawInstruction);
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCount = fn.kernel.instructionOperandCount(instruction);
		const resultStart = fn.kernel.instructionResultStart(instruction);
		const resultCount = fn.kernel.instructionResultCount(instruction);
		checkRange(
			`instruction @${instruction} operand`,
			operandStart,
			operandCount,
			fn.operandCapacity,
		);
		checkRange(
			`instruction @${instruction} result`,
			resultStart,
			resultCount,
			fn.resultCapacity,
		);
		const sourcePosition = fn.kernel.instructionSourcePosition(instruction);
		if (sourcePosition < -1 || sourcePosition >= program.sourcePositions.length) {
			fail(`instruction @${instruction} has invalid source position ${sourcePosition}`);
		}
		if (fn.kernel.instructionLive(instruction) === 0) {
			for (let index = 0; index < resultCount; index++) {
				const value = fn.kernel.resultAt(resultStart + index);
				if (fn.isValueLive(value)) {
					fail(`deleted instruction @${instruction} retains live result %${value}`);
				}
			}
			continue;
		}
		const instructionBlock = fn.kernel.instructionBlock(instruction);
		if (fn.kernel.blockLive(coreBlockId(instructionBlock)) === 0) {
			fail(`instruction @${instruction} belongs to deleted block b${instructionBlock}`);
		}
		const opcode = fn.kernel.instructionOpcode(instruction);
		if (opcode >= 0) {
			if (
				fn.kernel.terminatorEdgeCount(instruction) !== 0 ||
				fn.kernel.terminatorFact(instruction) !== undefined
			) {
				fail(`operation @${instruction} carries terminator metadata`);
			}
			let descriptor;
			try {
				descriptor = program.registry.byId(fn.instructionOpcode(instruction));
			} catch {
				fail(`instruction @${instruction} has unknown opcode id ${opcode}`);
			}
			if (!arityAccepts(descriptor.inputs, operandCount)) {
				fail(`instruction @${instruction} ${descriptor.opcode} has invalid input arity`);
			}
			if (!arityAccepts(descriptor.outputs, resultCount)) {
				fail(`instruction @${instruction} ${descriptor.opcode} has invalid output arity`);
			}
			const attributes = fn.instructionAttributes(instruction);
			if (
				attributes.primitiveStringLength !== undefined &&
				(descriptor.opcode !== "loadPropertyStatic" ||
					attributes.primitiveStringLength !== true ||
					String.fromCharCode(
						...(program.stringConstants[attributes.stringIndex as number] ?? []),
					) !== "length")
			)
				fail("Invalid primitive String length hint");
			if (descriptor.opcode === "loadPrimordial") {
				const node = getPrimordialCatalog().nodes[attributes.nodeIndex as number];
				if (node === undefined || (node[2] & 9) === 0)
					fail("Invalid primordial identity");
				verifyBuiltinWorldAssumptions(attributes.worldAssumptions, node[0], world);
			} else if (descriptor.opcode === "builtinError") {
				if (!isKnownBuiltinError(attributes.error))
					fail("Invalid builtin error identity");
			} else if (descriptor.opcode === "callKnown") {
				if (
					typeof attributes.operation !== "string" ||
					knownOperationIndex(attributes.operation) === undefined
				)
					fail("Invalid known operation identity");
				verifyBuiltinWorldAssumptions(
					attributes.worldAssumptions,
					attributes.operation,
					world,
				);
				if (
					attributes.argumentMode !== undefined &&
					(!knownArgumentModes.some((mode) => mode === attributes.argumentMode) ||
						operandCount < 2)
				)
					fail("Invalid known-operation argument list");
				if (
					attributes.stringCollationPlan !== undefined &&
					(attributes.operation !== "String.prototype.localeCompare" ||
						attributes.construct ||
						attributes.argumentMode !== undefined ||
						!isStringCollationPlan(attributes.stringCollationPlan))
				)
					fail("Invalid string collation plan");
				if (
					attributes.specialized !== undefined &&
					(attributes.specialized !== attributes.operation ||
						exactBuiltinCallDescriptor(attributes.operation) === undefined ||
						attributes.construct ||
						attributes.argumentMode !== undefined)
				)
					fail("Invalid known-operation specialization");
			} else if (["mathUnaryNumber", "mathBinaryNumber"].includes(descriptor.opcode)) {
				if (typeof attributes.operation !== "string")
					fail("Missing exact operation identity");
				verifyBuiltinWorldAssumptions(
					attributes.worldAssumptions,
					attributes.operation,
					world,
				);
			}
			verifyAttributeValue(attributes, `instruction @${instruction} attributes`);
			verifyAttributeRelocations(
				fn,
				instruction,
				attributes,
				descriptor.attributeRelocations,
			);
			for (const [key, value] of Object.entries(attributes)) {
				if (
					typeof value === "number" &&
					/(?:^|String)Index$/.test(key) &&
					(!Number.isSafeInteger(value) ||
						value < 0 ||
						value >= program.stringConstants.length)
				) {
					fail(`instruction @${instruction} has invalid ${key} ${value}`);
				}
			}
			const refinement = fn.instructionEffectRefinement(instruction);
			if (refinement !== undefined) {
				if (!fn.isFactLive(refinement.proof)) {
					fail(
						`instruction @${instruction} references deleted fact !${refinement.proof}`,
					);
				}
				verifyEffectRefinement(instruction, refinement.effects, descriptor.effects);
			}
		} else fn.instructionKind(instruction);
		for (let operand = 0; operand < operandCount; operand++) {
			const recordIndex = operandStart + operand;
			currentOperands[recordIndex] = 1;
			const value = fn.kernel.operandAt(recordIndex);
			const useId = fn.kernel.operandUseAt(recordIndex);
			if (fn.kernel.valueLive(value) === 0) {
				fail(
					`instruction @${instruction} operand ${operand} references deleted value %${value}`,
				);
			}
			if (
				fn.kernel.useLive(useId) === 0 ||
				fn.kernel.useValue(useId) !== value ||
				fn.kernel.useInstruction(useId) !== instruction ||
				fn.kernel.useOperand(useId) !== operand
			) {
				fail(
					`instruction @${instruction} operand ${operand} has an inconsistent use row`,
				);
			}
			if (valueByUse[useId] === 0) valueCounts[value] = valueCounts[value]! + 1;
			valueByUse[useId] = value + 1;
		}
		for (let result = 0; result < resultCount; result++) {
			const value = fn.kernel.resultAt(resultStart + result);
			if (fn.kernel.valueLive(value) === 0) {
				fail(`instruction @${instruction} result ${result} is deleted`);
			}
			if (
				fn.kernel.valueDefinitionKind(value) !== 1 ||
				fn.kernel.valueDefinitionOwner(value) !== instruction ||
				fn.kernel.valueDefinitionIndex(value) !== result
			) {
				fail(`instruction @${instruction} result ${result} has the wrong definition`);
			}
		}
	}
	for (let record = 0; record < fn.operandCapacity; record++) {
		const useId = fn.kernel.operandUseAt(record);
		if (useId < 0) {
			if (currentOperands[record] !== 0) fail(`live operand row ${record} has no use`);
			continue;
		}
		if ((fn.kernel.useLive(useId) !== 0) !== (currentOperands[record] !== 0)) {
			fail(`operand row ${record} has stale live-use state`);
		}
	}
	return { valueCounts, valueByUse };
}

function verifyValueRows(fn: CoreFunctionStore, expectedUses: OperandUseIndex): void {
	const useRowsInChains = new Uint32Array(fn.useCapacity);
	for (let rawValue = 0; rawValue < fn.valueCapacity; rawValue++) {
		const value = coreValueId(rawValue);
		let current = fn.kernel.valueFirstUse(value);
		let liveCount = 0;
		let previous = -1;
		while (current >= 0) {
			if (current >= fn.useCapacity || useRowsInChains[current] === value + 1) {
				fail(`value %${value} has an invalid use-list chain`);
			}
			useRowsInChains[current] = value + 1;
			if (fn.kernel.useValue(current) !== value)
				fail(`value %${value} use-list contains another value`);
			if (fn.kernel.useLive(current) === 0)
				fail(`value %${value} use-list contains a dead use`);
			if (fn.kernel.usePrevious(current) !== previous) {
				fail(`value %${value} has an inconsistent previous-use link`);
			}
			liveCount++;
			if (expectedUses.valueByUse[current] !== value + 1) {
				fail(`value %${value} has a live use missing from operand storage`);
			}
			previous = current;
			current = fn.kernel.useNext(current);
		}
		if (
			liveCount !== fn.kernel.valueUseCount(value) ||
			liveCount !== expectedUses.valueCounts[value]
		) {
			fail(`value %${value} use count does not match its live uses`);
		}
		if (fn.kernel.valueLive(value) === 0) {
			if (liveCount !== 0) fail(`deleted value %${value} retains live uses`);
			continue;
		}
		const definitionKind = fn.kernel.valueDefinitionKind(value);
		const definitionOwner = fn.kernel.valueDefinitionOwner(value);
		const definitionIndex = fn.kernel.valueDefinitionIndex(value);
		if (definitionKind === 0) {
			const block = coreBlockId(definitionOwner);
			if (fn.kernel.blockLive(block) === 0) {
				fail(`value %${value} is defined by deleted block b${block}`);
			}
			if (
				definitionIndex < 0 ||
				definitionIndex >= fn.kernel.blockParameterCount(block) ||
				fn.kernel.blockParameterValue(
					fn.kernel.blockParameterStart(block) + definitionIndex,
				) !== value
			) {
				fail(`value %${value} is not present at its block-parameter definition`);
			}
		} else if (definitionKind === 1) {
			const instruction = coreInstructionId(definitionOwner);
			if (fn.kernel.instructionLive(instruction) === 0) {
				fail(`value %${value} is defined by deleted instruction @${instruction}`);
			}
			if (
				definitionIndex < 0 ||
				definitionIndex >= fn.kernel.instructionResultCount(instruction) ||
				fn.kernel.resultAt(
					fn.kernel.instructionResultStart(instruction) + definitionIndex,
				) !== value
			) {
				fail(`value %${value} is not present at its instruction definition`);
			}
		} else fail(`value %${value} has invalid definition kind ${definitionKind}`);
	}
	for (let use = 0; use < fn.useCapacity; use++) {
		if (fn.kernel.useLive(use) !== 0 && useRowsInChains[use] === 0) {
			fail(`live use row ${use} is absent from its value chain`);
		}
		if (
			fn.kernel.useLive(use) === 0 &&
			(fn.kernel.usePrevious(use) >= 0 || fn.kernel.useNext(use) >= 0)
		) {
			fail(`dead use row ${use} remains linked`);
		}
	}
}

function verifyBlockParameters(fn: CoreFunctionStore): void {
	for (let rawBlock = 0; rawBlock < fn.blockCapacity; rawBlock++) {
		const block = coreBlockId(rawBlock);
		if (fn.kernel.blockLive(block) === 0) continue;
		const start = fn.kernel.blockParameterStart(block);
		const count = fn.kernel.blockParameterCount(block);
		for (let index = 0; index < count; index++) {
			const record = start + index;
			const value = fn.kernel.blockParameterValue(record);
			if (
				fn.kernel.valueDefinitionKind(value) !== 0 ||
				fn.kernel.valueDefinitionOwner(value) !== block ||
				fn.kernel.valueDefinitionIndex(value) !== index
			) {
				fail(`block b${block} parameter ${index} has the wrong definition`);
			}
			const role = fn.kernel.blockParameterRole(record);
			if (role !== 0 && role !== 1) {
				fail(`block b${block} parameter ${index} has invalid role ${role}`);
			}
			if (role === 1 && index !== 0) {
				fail(`block b${block} exception parameter is not first`);
			}
		}
	}
}

function verifyEdge(
	fn: CoreFunctionStore,
	from: CoreBlockId,
	target: CoreBlockId,
	argumentStart: number,
	argumentCount: number,
	kind: "ordinary" | "exceptional",
): void {
	if (fn.kernel.blockLive(target) === 0) {
		fail(`block b${from} targets deleted or unknown block b${target}`);
	}
	const parameterStart = fn.kernel.blockParameterStart(target);
	const parameterCount = fn.kernel.blockParameterCount(target);
	const offset = kind === "exceptional" ? 1 : 0;
	const firstRole =
		parameterCount === 0 ? undefined : fn.kernel.blockParameterRole(parameterStart);
	if (kind === "ordinary" && firstRole === 1) {
		fail(`ordinary edge b${from} -> b${target} targets an exception entry`);
	}
	if (kind === "exceptional" && firstRole !== 1) {
		fail(`exceptional edge b${from} -> b${target} lacks an exception parameter`);
	}
	if (argumentCount !== parameterCount - offset) {
		fail(
			`${kind} edge b${from} -> b${target} passes ${argumentCount} values to ${parameterCount - offset} parameters`,
		);
	}
	for (let index = 0; index < argumentCount; index++) {
		const value =
			kind === "ordinary"
				? fn.kernel.operandAt(argumentStart + index)
				: fn.kernel.handlerArgumentAt(argumentStart + index);
		if (fn.kernel.valueLive(value) === 0) {
			fail(`${kind} edge b${from} -> b${target} references deleted value %${value}`);
		}
		const parameter = fn.kernel.blockParameterValue(parameterStart + index + offset);
		if (
			fn.kernel.valueRepresentation(value) !== fn.kernel.valueRepresentation(parameter)
		) {
			fail(
				`${kind} edge b${from} -> b${target} changes value representation: %${value} (${fn.valueRepresentation(value)}) -> %${parameter} (${fn.valueRepresentation(parameter)})`,
			);
		}
	}
}

function verifyControlFlow(fn: CoreFunctionStore, program: CoreProgram): CoreControlFlow {
	const indexedHandlers = new Uint8Array(fn.blockCapacity);
	const handlerArgumentOwners = new Int32Array(fn.handlerArgumentCapacity);
	handlerArgumentOwners.fill(-1);
	for (let index = 0; index < fn.handlerBlockCount; index++) {
		const block = fn.handlerBlockAt(index);
		if (fn.kernel.blockLive(block) === 0) {
			fail(`handler index references deleted block b${block}`);
		}
		if (indexedHandlers[block] !== 0) {
			fail(`handler index repeats block b${block}`);
		}
		if (fn.kernel.blockHandlerBlock(block) === undefined) {
			fail(`handler index references block b${block} without a handler`);
		}
		indexedHandlers[block] = 1;
	}
	for (const block of fn.blockIds()) {
		const instruction = fn.blockTerminator(block);
		const kind = fn.instructionKind(instruction);
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCount = fn.kernel.instructionOperandCount(instruction);
		const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
		const edgeCount = fn.kernel.terminatorEdgeCount(instruction);
		checkRange(
			`terminator @${instruction} edge`,
			edgeStart,
			edgeCount,
			fn.terminatorEdgeCapacity,
		);
		const requiredEdges =
			kind === "jump"
				? 1
				: kind === "branch" || kind === "guard"
					? 2
					: kind === "switch"
						? Math.max(1, edgeCount)
						: 0;
		if (edgeCount !== requiredEdges) {
			fail(`terminator @${instruction} has invalid edge count ${edgeCount}`);
		}
		const leadingOperands =
			kind === "branch" || kind === "guard" || kind === "switch" ? 1 : 0;
		let cursor = operandStart + leadingOperands;
		for (let offset = 0; offset < edgeCount; offset++) {
			const edge = edgeStart + offset;
			const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
			const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edge);
			if (argumentStart !== cursor) {
				fail(`terminator @${instruction} has a non-contiguous edge argument range`);
			}
			const caseValue = fn.kernel.terminatorEdgeCaseValue(edge);
			if ((kind === "switch" && offset < edgeCount - 1) !== (caseValue !== undefined)) {
				fail(`terminator @${instruction} has inconsistent switch case metadata`);
			}
			verifyEdge(
				fn,
				block,
				fn.kernel.terminatorEdgeBlock(edge),
				argumentStart,
				argumentCount,
				"ordinary",
			);
			cursor += argumentCount;
		}
		const requiredOperands =
			kind === "return" || kind === "throw" ? 1 : cursor - operandStart;
		if (operandCount !== requiredOperands) {
			fail(`terminator @${instruction} has invalid operand count ${operandCount}`);
		}
		if (kind !== "guard" && fn.kernel.terminatorFact(instruction) !== undefined) {
			fail(`terminator @${instruction} carries an unexpected guard fact`);
		}
		const handler = fn.kernel.blockHandlerBlock(block);
		if ((handler === undefined) === (indexedHandlers[block] !== 0)) {
			fail(`block b${block} handler index is inconsistent`);
		}
		if (handler !== undefined) {
			const argumentStart = fn.kernel.blockHandlerArgumentStart(block);
			const argumentCount = fn.kernel.blockHandlerArgumentCount(block);
			checkRange(
				`block b${block} handler argument`,
				argumentStart,
				argumentCount,
				fn.handlerArgumentCapacity,
			);
			for (let offset = 0; offset < argumentCount; offset++) {
				const use = argumentStart + offset;
				if (handlerArgumentOwners[use] !== -1) {
					fail(`handler argument use ${use} belongs to multiple blocks`);
				}
				handlerArgumentOwners[use] = block;
			}
			verifyEdge(fn, block, handler, argumentStart, argumentCount, "exceptional");
		} else if (fn.kernel.blockHandlerArgumentCount(block) !== 0) {
			fail(`block b${block} has handler arguments without a handler`);
		}
		if (kind === "guard") {
			const factId = fn.kernel.terminatorFact(instruction);
			if (factId === undefined || !fn.isFactLive(factId)) {
				fail(`guard in b${block} references deleted fact !${String(factId)}`);
			}
			const fact = fn.fact(factId);
			if (
				fact.validity.kind !== "guard" ||
				fact.validity.instruction !== instruction ||
				!fact.obligations.some(
					(obligation) =>
						obligation.kind === "guard" && obligation.instruction === instruction,
				)
			) {
				fail(`guard fact !${factId} is not anchored to @${instruction}`);
			}
		}
	}
	const indexedHandlerUses = new Uint8Array(fn.handlerArgumentCapacity);
	for (const value of fn.valueIds()) {
		let previous = -1;
		let count = 0;
		for (
			let use = fn.kernel.valueFirstHandlerUse(value);
			use >= 0;
			use = fn.kernel.handlerArgumentNextUse(use)
		) {
			if (use >= fn.handlerArgumentCapacity || indexedHandlerUses[use] !== 0) {
				fail(`handler argument use list for %${value} is invalid at ${use}`);
			}
			const block = handlerArgumentOwners[use] ?? -1;
			if (block < 0 || fn.kernel.handlerArgumentBlock(use) !== block) {
				fail(`handler argument use ${use} has an invalid owning block`);
			}
			if (fn.kernel.handlerArgumentAt(use) !== value) {
				fail(`handler argument use ${use} is linked to the wrong value`);
			}
			if (fn.kernel.handlerArgumentPreviousUse(use) !== previous) {
				fail(`handler argument use ${use} has an invalid previous link`);
			}
			indexedHandlerUses[use] = 1;
			previous = use;
			count++;
		}
		if (count !== fn.kernel.valueHandlerUseCount(value)) {
			fail(`handler argument use count for %${value} is inconsistent`);
		}
	}
	for (let use = 0; use < handlerArgumentOwners.length; use++) {
		if (handlerArgumentOwners[use]! >= 0 && indexedHandlerUses[use] === 0) {
			fail(`handler argument use ${use} is missing from its value index`);
		}
	}
	const cfg = buildCoreControlFlow(program, fn.id);
	for (const block of fn.blockIds()) {
		for (const edge of cfg.successors[block] ?? []) {
			if (!(cfg.predecessors[edge.to] ?? []).includes(edge)) {
				fail(`CFG predecessor index omits b${edge.from} -> b${edge.to}`);
			}
		}
		for (const edge of cfg.predecessors[block] ?? []) {
			if (!(cfg.successors[edge.from] ?? []).includes(edge)) {
				fail(`CFG successor index omits b${edge.from} -> b${edge.to}`);
			}
		}
	}
	verifyDominance(
		fn,
		cfg.reachable,
		(dominator, block) => cfg.dominates(dominator, block),
		(dominator, block) => cfg.instructionDominatesBlock(dominator, block),
	);
	return cfg;
}

function verifyDominance(
	fn: CoreFunctionStore,
	reachable: ReadonlySet<CoreBlockId>,
	dominates: (dominator: CoreBlockId, block: CoreBlockId) => boolean,
	instructionDominatesBlock: (dominator: CoreBlockId, block: CoreBlockId) => boolean,
): void {
	const instructionOrder = new Int32Array(fn.instructionCapacity);
	for (const block of fn.blockIds()) {
		let index = 0;
		for (const instruction of fn.instructionIds(block))
			instructionOrder[instruction] = index++;
	}
	const availableAtInstruction = (
		value: CoreValueId,
		instruction: CoreInstructionId,
	): boolean => {
		const useBlock = fn.instructionBlock(instruction);
		const owner = fn.kernel.valueDefinitionOwner(value);
		if (fn.kernel.valueDefinitionKind(value) === 0) {
			const block = coreBlockId(owner);
			return block === useBlock || dominates(block, useBlock);
		}
		const definitionInstruction = coreInstructionId(owner);
		const definitionBlock = fn.instructionBlock(definitionInstruction);
		return definitionBlock === useBlock
			? instructionOrder[definitionInstruction]! < instructionOrder[instruction]!
			: instructionDominatesBlock(definitionBlock, useBlock);
	};
	for (const instruction of fn.instructionIds()) {
		if (!reachable.has(fn.instructionBlock(instruction))) continue;
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operandCount = fn.kernel.instructionOperandCount(instruction);
		for (let offset = 0; offset < operandCount; offset++) {
			const value = fn.kernel.operandAt(operandStart + offset);
			if (!availableAtInstruction(value, instruction)) {
				const definitionOwner = fn.kernel.valueDefinitionOwner(value);
				const owner =
					fn.kernel.valueDefinitionKind(value) === 0
						? `b${definitionOwner} parameter ${fn.kernel.valueDefinitionIndex(value)}`
						: `@${definitionOwner} in b${fn.instructionBlock(coreInstructionId(definitionOwner))}`;
				fail(
					`value %${value} from ${owner} does not dominate its use at @${instruction} in b${fn.instructionBlock(instruction)}`,
				);
			}
		}
	}
	for (const block of fn.blockIds()) {
		if (!reachable.has(block)) continue;
		const handler = fn.kernel.blockHandlerBlock(block);
		if (handler === undefined) continue;
		const argumentStart = fn.kernel.blockHandlerArgumentStart(block);
		const argumentCount = fn.kernel.blockHandlerArgumentCount(block);
		for (let offset = 0; offset < argumentCount; offset++) {
			const value = fn.kernel.handlerArgumentAt(argumentStart + offset);
			const owner = fn.kernel.valueDefinitionOwner(value);
			const available =
				fn.kernel.valueDefinitionKind(value) === 0
					? dominates(coreBlockId(owner), block)
					: instructionDominatesBlock(
							fn.instructionBlock(coreInstructionId(owner)),
							block,
						);
			if (!available)
				fail(`value %${value} is unavailable on b${block}'s exception edge`);
		}
	}
	for (const block of fn.blockIds()) {
		if (!reachable.has(block)) continue;
		const terminator = fn.blockTerminator(block);
		const edgeStart = fn.kernel.terminatorEdgeStart(terminator);
		const edgeCount = fn.kernel.terminatorEdgeCount(terminator);
		for (let edgeOffset = 0; edgeOffset < edgeCount; edgeOffset++) {
			const edge = edgeStart + edgeOffset;
			const argumentStart = fn.kernel.terminatorEdgeArgumentStart(edge);
			const argumentCount = fn.kernel.terminatorEdgeArgumentCount(edge);
			for (let offset = 0; offset < argumentCount; offset++) {
				const value = fn.kernel.operandAt(argumentStart + offset);
				if (!availableAtInstruction(value, terminator)) {
					fail(
						`value %${value} is unavailable on edge b${block} -> b${fn.kernel.terminatorEdgeBlock(edge)}`,
					);
				}
			}
		}
	}
}

function verifyFactReference(fn: CoreFunctionStore, fact: CoreFact): void {
	const requireInstruction = (instruction: CoreInstructionId, label: string): void => {
		if (!fn.isInstructionLive(instruction)) {
			fail(`fact !${fact.id} ${label} references deleted instruction @${instruction}`);
		}
	};
	for (const claim of fact.claims) {
		if ("subject" in claim && !fn.isValueLive(claim.subject)) {
			fail(`fact !${fact.id} references deleted value %${claim.subject}`);
		}
		if (
			claim.kind === "effect" &&
			(claim.instruction < 0 || claim.instruction >= fn.instructionCapacity)
		) {
			fail(`fact !${fact.id} references unknown instruction @${claim.instruction}`);
		}
	}
	if (fact.validity.kind === "guard") {
		requireInstruction(fact.validity.instruction, "validity");
		const instruction = fact.validity.instruction;
		if (
			fn.instructionKind(instruction) !== "guard" ||
			fn.kernel.terminatorFact(instruction) !== fact.id
		) {
			fail(`fact !${fact.id} guard validity is not owned by @${instruction}`);
		}
	}
	for (const obligation of fact.obligations) {
		if (obligation.kind === "guard") {
			requireInstruction(obligation.instruction, "obligation");
			if (fn.instructionKind(obligation.instruction) !== "guard") {
				fail(`fact !${fact.id} has an invalid guard obligation`);
			}
			if (fn.kernel.terminatorFact(obligation.instruction) !== fact.id) {
				fail(`fact !${fact.id} has an invalid guard obligation`);
			}
		} else if (obligation.id.length === 0) {
			fail(`fact !${fact.id} has an empty ${obligation.kind} obligation`);
		}
	}
}

function verifyFacts(fn: CoreFunctionStore): void {
	for (let rawFact = 0; rawFact < fn.factCapacity; rawFact++) {
		const fact = coreFactId(rawFact);
		if (!fn.isFactLive(fact)) continue;
		const record = fn.fact(fact);
		if (record.id !== fact) fail(`fact row ${rawFact} carries id !${record.id}`);
		if (record.kind.length === 0 || record.origin.length === 0) {
			fail(`fact !${fact} has empty provenance metadata`);
		}
		verifyFactReference(fn, record);
		if (record.claims.length > CORE_FACT_CLAIM_LIMIT) {
			fail(`fact !${fact} has too many semantic claims`);
		}
		for (const [claimIndex, claim] of record.claims.entries()) {
			const where = `fact !${fact} claim ${claimIndex}`;
			switch (claim.kind) {
				case "identity":
					if (
						claim.identities.length === 0 ||
						claim.identities.length > CORE_FACT_ALTERNATIVE_LIMIT
					) {
						fail(`${where} has an invalid finite identity set`);
					}
					break;
				case "shape":
					if (
						claim.shapes.length === 0 ||
						claim.shapes.length > CORE_FACT_ALTERNATIVE_LIMIT ||
						claim.shapes.some((shape) => shape.length === 0)
					) {
						fail(`${where} has an invalid finite shape set`);
					}
					break;
				case "range":
					if (
						(claim.minimum !== null && Number.isNaN(claim.minimum)) ||
						(claim.maximum !== null && Number.isNaN(claim.maximum)) ||
						!coreFactClaimIsSatisfiable(claim)
					) {
						fail(`${where} has an invalid numeric interval`);
					}
					break;
				case "effect":
					break;
			}
		}
		const guardObligations = record.obligations.filter(
			(obligation) => obligation.kind === "guard",
		);
		if (record.validity.kind === "asserted" && guardObligations.length === 0) {
			fail(`asserted fact !${fact} is invalid without a guard obligation`);
		}
		if (
			record.validity.kind === "epoch" &&
			guardObligations.length === 0 &&
			!record.obligations.some(({ kind }) => kind === "fallback")
		) {
			fail(`epoch fact !${fact} has neither a guard nor a fallback`);
		}
	}
}

function verifyFactUses(fn: CoreFunctionStore, cfg: CoreControlFlow): void {
	for (const instruction of fn.instructionIds()) {
		if (fn.instructionKind(instruction) !== "operation") continue;
		const refinement = fn.instructionEffectRefinement(instruction);
		if (refinement === undefined) continue;
		const fact = fn.fact(refinement.proof);
		if (
			fact.claims.length > 0 &&
			!fact.claims.some(
				(claim) =>
					claim.kind === "effect" &&
					claim.instruction === instruction &&
					effectSummaryCovers(refinement.effects, claim.effects),
			)
		) {
			fail(`fact !${fact.id} does not license the effect refinement on @${instruction}`);
		}
		const guardObligations = fact.obligations.filter(
			(obligation) => obligation.kind === "guard",
		);
		if (
			(fact.validity.kind === "asserted" || fact.validity.kind === "epoch") &&
			guardObligations.length === 0
		) {
			fail(
				`${fact.validity.kind} fact !${fact.id} refines @${instruction} without a guard`,
			);
		}
		const useBlock = fn.instructionBlock(instruction);
		for (const obligation of guardObligations) {
			const guardBlock = fn.instructionBlock(obligation.instruction);
			const successEdge = fn.kernel.terminatorEdgeStart(obligation.instruction);
			if (
				fn.instructionKind(obligation.instruction) !== "guard" ||
				!cfg.dominatesEdge(
					guardBlock,
					fn.kernel.terminatorEdgeBlock(successEdge),
					useBlock,
				)
			) {
				fail(
					`guard @${obligation.instruction} for fact !${fact.id} does not dominate @${instruction} through its success edge`,
				);
			}
		}
	}
}

function verifyFunctionParameters(fn: CoreFunctionStore): void {
	if (!fn.isBlockLive(fn.entry)) fail(`function entry b${fn.entry} is deleted`);
	const start = fn.kernel.blockParameterStart(fn.entry);
	const count = fn.kernel.blockParameterCount(fn.entry);
	if (fn.parameterCount > count) {
		fail(`function parameter list exceeds entry block parameters`);
	}
	for (let index = 0; index < fn.parameterCount; index++) {
		const value = fn.kernel.functionParameter(index);
		if (fn.kernel.blockParameterValue(start + index) !== value) {
			fail(`function parameter ${index} is not entry parameter ${index}`);
		}
		if (
			fn.kernel.blockParameterRole(start + index) !== 0 ||
			fn.kernel.valueRepresentation(value) !== 0
		) {
			fail(`function parameter ${index} is not a boxed value`);
		}
	}
}

function verifyFunction(
	program: CoreProgram,
	functionId: CoreFunctionId,
	world?: WorldFacts,
): void {
	const fn = program.function(functionId);
	if (fn.id !== functionId) fail(`function row ${functionId} carries id ${fn.id}`);
	verifyMetadata(fn, program);
	verifyBlockRows(fn);
	const liveUses = verifyInstructionRows(fn, program, world);
	verifyValueRows(fn, liveUses);
	verifyBlockParameters(fn);
	verifyFunctionParameters(fn);
	verifyFacts(fn);
	const cfg = verifyControlFlow(fn, program);
	verifyFactUses(fn, cfg);
}

function verifyProgramTables(program: CoreProgram): void {
	if (!Number.isSafeInteger(program.globalCount) || program.globalCount < 0) {
		fail(`invalid global count ${program.globalCount}`);
	}
	for (const [stringIndex, units] of program.stringConstants.entries()) {
		for (const unit of units) {
			if (!Number.isSafeInteger(unit) || unit < 0 || unit > 0xffff) {
				fail(`string constant ${stringIndex} contains invalid code unit ${unit}`);
			}
		}
	}
	for (const [positionId, position] of program.sourcePositions.entries()) {
		if (
			!Number.isSafeInteger(position.line) ||
			position.line < 1 ||
			!Number.isSafeInteger(position.column) ||
			position.column < 0
		) {
			fail(`source position ${positionId} is invalid`);
		}
		if (
			position.callerPosId !== undefined &&
			(!Number.isSafeInteger(position.callerPosId) ||
				position.callerPosId < 0 ||
				position.callerPosId >= program.sourcePositions.length)
		) {
			fail(`source position ${positionId} has invalid caller ${position.callerPosId}`);
		}
		if (
			position.inlinedFunctionIndex !== undefined &&
			(!Number.isSafeInteger(position.inlinedFunctionIndex) ||
				position.inlinedFunctionIndex < 0 ||
				position.inlinedFunctionIndex >= program.functionCapacity)
		) {
			fail(
				`source position ${positionId} has invalid inline function ${position.inlinedFunctionIndex}`,
			);
		}
	}
}

const FUNCTION_INDEX_ATTRIBUTES = [
	"functionIndex",
	"directFunctionIndex",
	"directCallTargetFunctionIndex",
	"directCallbackFunctionIndex",
] as const;

function verifyFunctionReference(
	program: CoreProgram,
	functionId: CoreFunctionId,
	instruction: CoreInstructionId,
	label: string,
	target: unknown,
	allowNegative: boolean,
): void {
	if (typeof target !== "number" || !Number.isSafeInteger(target)) {
		fail(`instruction @${instruction} has non-integral ${label} ${String(target)}`);
	}
	if (target < 0 && allowNegative) return;
	requireExistingFunction(
		program,
		target,
		`instruction @${instruction} in function ${functionId}`,
	);
}

function requireExistingFunction(
	program: CoreProgram,
	target: number,
	owner: string,
): void {
	if (target < 0 || target >= program.functionCapacity) {
		fail(`${owner} references function ${target}`);
	}
	try {
		program.function(target as CoreFunctionId);
	} catch {
		fail(`${owner} references deleted function ${target}`);
	}
}

function verifyCrossFunctionReferences(
	program: CoreProgram,
	functionIds: Iterable<CoreFunctionId> = program.functionIds(),
): void {
	for (const functionId of functionIds) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const attributes = fn.instructionAttributes(instruction);
			const opcode = fn.instructionOpcodeName(instruction);
			for (const attribute of FUNCTION_INDEX_ATTRIBUTES) {
				const target = attributes[attribute];
				if (target === undefined) continue;
				verifyFunctionReference(
					program,
					functionId,
					instruction,
					attribute,
					target,
					attribute === "functionIndex" &&
						(opcode === "loadCaptured" || opcode === "storeCaptured"),
				);
			}
			const guarded = attributes.guardedFunctionIndices;
			if (guarded !== undefined) {
				if (!Array.isArray(guarded)) {
					fail(`instruction @${instruction} has invalid guarded function indices`);
				}
				for (const target of guarded) {
					verifyFunctionReference(
						program,
						functionId,
						instruction,
						"guarded function index",
						target,
						false,
					);
				}
			}
		}
	}
}

function verifyCompilationContext(
	program: CoreProgram,
	context: CoreCompilationContext,
): void {
	for (const functionId of context.data.cjsModuleFunctionIndices) {
		if (!Number.isSafeInteger(functionId)) {
			fail(`compilation context has non-integral CJS module function ${functionId}`);
		}
		requireExistingFunction(program, functionId, "compilation context CJS module");
	}
	for (const slot of context.data.singleAssignmentGlobalSlots) {
		if (!Number.isSafeInteger(slot) || slot < 0 || slot >= program.globalCount) {
			fail(`compilation context references invalid global slot ${slot}`);
		}
	}
	for (const { owner, index } of context.data.singleAssignmentCapturedSlots) {
		if (!Number.isSafeInteger(owner)) {
			fail(`compilation context has non-integral captured owner ${owner}`);
		}
		if (owner >= 0) {
			requireExistingFunction(program, owner, "compilation context captured slot");
		}
		if (!Number.isSafeInteger(index) || index < 0) {
			fail(`compilation context references invalid captured slot ${owner}:${index}`);
		}
	}
	for (const candidate of context.data.hostInstallCandidates) {
		for (const { slot } of candidate.exports) {
			if (!Number.isSafeInteger(slot) || slot < 0 || slot >= program.globalCount) {
				fail(
					`host installer ${candidate.installer} references invalid global slot ${slot}`,
				);
			}
		}
	}
}

export function verifyCoreFunction(
	program: CoreProgram,
	functionId: CoreFunctionId,
	context?: CoreVerificationContext,
): void {
	withContext(
		context === undefined ? undefined : { ...context, functionIndex: functionId },
		() => verifyFunction(program, functionId),
	);
}

export function verifyCoreProgram(
	program: CoreProgram,
	context?: CoreVerificationContext,
	compilationContext?: CoreCompilationContext,
): void {
	withContext(context, () => {
		verifyProgramTables(program);
		for (const functionId of program.functionIds()) {
			withContext(
				context === undefined ? undefined : { ...context, functionIndex: functionId },
				() => verifyFunction(program, functionId, compilationContext?.facts.world),
			);
		}
		verifyCrossFunctionReferences(program);
		if (compilationContext !== undefined) {
			verifyCompilationContext(program, compilationContext);
		}
	});
}

export function verifyCoreChangeSet(
	program: CoreProgram,
	changes: CoreChangeSet,
	context?: CoreVerificationContext,
): void {
	verifyCoreFunction(program, changes.function, context);
	withContext(context, () => verifyCrossFunctionReferences(program, [changes.function]));
}
