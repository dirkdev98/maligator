import { effectSummaryCovers } from "../shared/effect-summary.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { buildCoreControlFlow, coreTerminatorEdges } from "./core-ir-control-flow.ts";
import type { CoreControlEdge } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import {
	CORE_FACT_ALTERNATIVE_LIMIT,
	CORE_FACT_CLAIM_LIMIT,
	coreFactClaimIsSatisfiable,
} from "./core-ir-fact-implication.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreChangeSet,
	CoreEdge,
	CoreFact,
	CoreFactId,
	CoreFunctionId,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreValueDefinition,
	CoreValueId,
} from "./core-ir.ts";
import { coreBlockId, coreFactId, coreInstructionId, coreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export type CoreVerificationStage =
	| "construction"
	| "pre-optimization"
	| "normalization"
	| "fixpoint"
	| "finalization"
	| "final-region-selection"
	| "pre-target";

export interface CoreVerificationContext {
	readonly stage: CoreVerificationStage;
	readonly pass?: string;
	readonly round?: number;
	readonly functionIndex?: number;
}

export type CoreVerificationProfile = "boundary" | "per-pass";

function formatVerificationContext(context: CoreVerificationContext | undefined): string {
	if (context === undefined) return "";
	const parts = [`stage=${context.stage}`];
	if (context.pass !== undefined) parts.push(`pass=${context.pass}`);
	if (context.round !== undefined) parts.push(`round=${context.round}`);
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
		if (!Number.isSafeInteger(slot) || slot < 0 || slot >= fn.parameters.length) {
			fail(`invalid mapped argument slot ${slot}`);
		}
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

function verifyBlockRows(fn: CoreFunctionStore): Set<CoreInstructionId> {
	const linked = new Set<CoreInstructionId>();
	for (let rawBlock = 0; rawBlock < fn.blockCapacity; rawBlock++) {
		const block = coreBlockId(rawBlock);
		const row = fn.blockLayout(rawBlock);
		checkRange(
			`block b${block} parameter`,
			row.parameterStart,
			row.parameterCount,
			fn.blockParameterCapacity,
		);
		if (!row.live) {
			if (row.firstInstruction >= 0 || row.lastInstruction >= 0) {
				fail(`deleted block b${block} retains linked instructions`);
			}
			continue;
		}
		let previous = -1;
		let current = row.firstInstruction;
		let terminators = 0;
		while (current >= 0) {
			if (current >= fn.instructionCapacity) {
				fail(`block b${block} links unknown instruction @${current}`);
			}
			const instruction = coreInstructionId(current);
			if (linked.has(instruction)) {
				fail(`instruction @${instruction} appears twice in block order`);
			}
			linked.add(instruction);
			const instructionRow = fn.instructionLayout(current);
			if (!instructionRow.live)
				fail(`block b${block} links deleted instruction @${current}`);
			if (instructionRow.block !== block) {
				fail(
					`instruction @${current} belongs to b${instructionRow.block}, not b${block}`,
				);
			}
			if (instructionRow.previous !== previous) {
				fail(`instruction @${current} has broken previous link`);
			}
			const kind = fn.instructionKind(instruction);
			if (kind !== "operation") terminators++;
			if (kind !== "operation" && instructionRow.next >= 0) {
				fail(`terminator @${current} is not last in b${block}`);
			}
			previous = current;
			current = instructionRow.next;
		}
		if (previous !== row.lastInstruction) fail(`block b${block} has broken last link`);
		if (row.firstInstruction < 0 || terminators !== 1) {
			fail(`block b${block} must contain exactly one terminator`);
		}
	}
	for (
		let rawInstruction = 0;
		rawInstruction < fn.instructionCapacity;
		rawInstruction++
	) {
		const instruction = coreInstructionId(rawInstruction);
		const row = fn.instructionLayout(rawInstruction);
		if (row.live !== linked.has(instruction)) {
			fail(`instruction @${instruction} live state disagrees with block order`);
		}
	}
	return linked;
}

function verifyInstructionRows(
	fn: CoreFunctionStore,
	program: CoreProgram,
): {
	readonly currentOperands: Set<number>;
	readonly liveUses: Map<number, Set<number>>;
} {
	const currentOperands = new Set<number>();
	const liveUses = new Map<number, Set<number>>();
	for (
		let rawInstruction = 0;
		rawInstruction < fn.instructionCapacity;
		rawInstruction++
	) {
		const instruction = coreInstructionId(rawInstruction);
		const row = fn.instructionLayout(rawInstruction);
		checkRange(
			`instruction @${instruction} operand`,
			row.operandStart,
			row.operandCount,
			fn.operandCapacity,
		);
		checkRange(
			`instruction @${instruction} result`,
			row.resultStart,
			row.resultCount,
			fn.resultCapacity,
		);
		if (row.sourcePosition < -1 || row.sourcePosition >= program.sourcePositions.length) {
			fail(
				`instruction @${instruction} has invalid source position ${row.sourcePosition}`,
			);
		}
		if (!row.live) {
			for (let index = 0; index < row.resultCount; index++) {
				const value = fn.resultRecord(row.resultStart + index);
				if (fn.isValueLive(value)) {
					fail(`deleted instruction @${instruction} retains live result %${value}`);
				}
			}
			continue;
		}
		if (!fn.isBlockLive(coreBlockId(row.block))) {
			fail(`instruction @${instruction} belongs to deleted block b${row.block}`);
		}
		if (row.opcode >= 0) {
			let descriptor;
			try {
				descriptor = program.registry.byId(fn.instructionOpcode(instruction));
			} catch {
				fail(`instruction @${instruction} has unknown opcode id ${row.opcode}`);
			}
			if (!arityAccepts(descriptor.inputs, row.operandCount)) {
				fail(`instruction @${instruction} ${descriptor.opcode} has invalid input arity`);
			}
			if (!arityAccepts(descriptor.outputs, row.resultCount)) {
				fail(`instruction @${instruction} ${descriptor.opcode} has invalid output arity`);
			}
			const attributes = fn.instructionAttributes(instruction);
			verifyAttributeValue(attributes, `instruction @${instruction} attributes`);
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
		} else {
			const payload = fn.terminatorPayload(instruction);
			if (payload.kind !== fn.instructionKind(instruction)) {
				fail(`terminator @${instruction} kind does not match its structural opcode`);
			}
		}
		for (let operand = 0; operand < row.operandCount; operand++) {
			const recordIndex = row.operandStart + operand;
			currentOperands.add(recordIndex);
			const record = fn.operandRecord(recordIndex);
			if (!fn.isValueLive(record.value)) {
				fail(
					`instruction @${instruction} operand ${operand} references deleted value %${record.value}`,
				);
			}
			const use = fn.useLayout(record.use);
			if (
				!use.live ||
				use.value !== record.value ||
				use.instruction !== instruction ||
				use.operand !== operand
			) {
				fail(
					`instruction @${instruction} operand ${operand} has an inconsistent use row`,
				);
			}
			const uses = liveUses.get(record.value) ?? new Set<number>();
			uses.add(record.use);
			liveUses.set(record.value, uses);
		}
		for (let result = 0; result < row.resultCount; result++) {
			const value = fn.resultRecord(row.resultStart + result);
			if (!fn.isValueLive(value)) {
				fail(`instruction @${instruction} result ${result} is deleted`);
			}
			const definition = fn.valueDefinition(value);
			if (
				definition.kind !== "instruction" ||
				definition.instruction !== instruction ||
				definition.index !== result
			) {
				fail(`instruction @${instruction} result ${result} has the wrong definition`);
			}
		}
	}
	for (let record = 0; record < fn.operandCapacity; record++) {
		const use = fn.useLayout(fn.operandRecord(record).use);
		if (use.live !== currentOperands.has(record)) {
			fail(`operand row ${record} has stale live-use state`);
		}
	}
	return { currentOperands, liveUses };
}

function definitionsEqual(
	left: CoreValueDefinition,
	right: CoreValueDefinition,
): boolean {
	return left.kind === right.kind &&
		left.kind === "block-parameter" &&
		right.kind === "block-parameter"
		? left.block === right.block && left.index === right.index
		: left.kind === "instruction" &&
				right.kind === "instruction" &&
				left.instruction === right.instruction &&
				left.index === right.index;
}

function verifyValueRows(
	fn: CoreFunctionStore,
	expectedUses: Map<number, Set<number>>,
): void {
	const useRowsInChains = new Set<number>();
	for (let rawValue = 0; rawValue < fn.valueCapacity; rawValue++) {
		const value = coreValueId(rawValue);
		const row = fn.valueLayout(rawValue);
		let current = row.firstUse;
		let liveCount = 0;
		const chain = new Set<number>();
		while (current >= 0) {
			if (current >= fn.useCapacity || chain.has(current)) {
				fail(`value %${value} has an invalid use-list chain`);
			}
			chain.add(current);
			useRowsInChains.add(current);
			const use = fn.useLayout(current);
			if (use.value !== value) fail(`value %${value} use-list contains another value`);
			if (use.live) {
				liveCount++;
				if (!expectedUses.get(value)?.has(current)) {
					fail(`value %${value} has a live use missing from operand storage`);
				}
			}
			current = use.next;
		}
		if (
			liveCount !== row.useCount ||
			liveCount !== (expectedUses.get(value)?.size ?? 0)
		) {
			fail(`value %${value} use count does not match its live uses`);
		}
		if (!row.live) {
			if (liveCount !== 0) fail(`deleted value %${value} retains live uses`);
			continue;
		}
		const publicDefinition = fn.valueDefinition(value);
		const rowDefinition: CoreValueDefinition =
			row.definitionKind === "block-parameter"
				? {
						kind: "block-parameter",
						block: coreBlockId(row.definitionOwner),
						index: row.definitionIndex,
					}
				: {
						kind: "instruction",
						instruction: coreInstructionId(row.definitionOwner),
						index: row.definitionIndex,
					};
		if (!definitionsEqual(publicDefinition, rowDefinition)) {
			fail(`value %${value} definition row is inconsistent`);
		}
		if (rowDefinition.kind === "block-parameter") {
			if (!fn.isBlockLive(rowDefinition.block)) {
				fail(`value %${value} is defined by deleted block b${rowDefinition.block}`);
			}
			const parameters = fn.blockParameters(rowDefinition.block);
			if (parameters[rowDefinition.index]?.value !== value) {
				fail(`value %${value} is not present at its block-parameter definition`);
			}
		} else {
			if (!fn.isInstructionLive(rowDefinition.instruction)) {
				fail(
					`value %${value} is defined by deleted instruction @${rowDefinition.instruction}`,
				);
			}
			if (
				fn.instructionResults(rowDefinition.instruction)[rowDefinition.index] !== value
			) {
				fail(`value %${value} is not present at its instruction definition`);
			}
		}
	}
	for (let use = 0; use < fn.useCapacity; use++) {
		if (!useRowsInChains.has(use)) fail(`use row ${use} is absent from its value chain`);
	}
}

function verifyBlockParameters(fn: CoreFunctionStore): void {
	for (const block of fn.blockIds()) {
		const row = fn.blockLayout(block);
		const parameters = fn.blockParameters(block);
		if (parameters.length !== row.parameterCount) {
			fail(`block b${block} parameter reader disagrees with its row`);
		}
		for (const [index, parameter] of parameters.entries()) {
			const record = row.parameterStart + index;
			if (
				fn.blockParameterValue(record) !== parameter.value ||
				fn.blockParameterRole(record) !== parameter.role ||
				fn.valueRepresentation(parameter.value) !== parameter.representation
			) {
				fail(`block b${block} parameter ${index} is inconsistent`);
			}
			const definition = fn.valueDefinition(parameter.value);
			if (
				definition.kind !== "block-parameter" ||
				definition.block !== block ||
				definition.index !== index
			) {
				fail(`block b${block} parameter ${index} has the wrong definition`);
			}
			if (parameter.role === "exception" && index !== 0) {
				fail(`block b${block} exception parameter is not first`);
			}
		}
	}
}

function verifyEdge(
	fn: CoreFunctionStore,
	from: CoreBlockId,
	edge: CoreEdge,
	kind: "ordinary" | "exceptional",
): void {
	if (!fn.isBlockLive(edge.block)) {
		fail(`block b${from} targets deleted or unknown block b${edge.block}`);
	}
	const parameters = fn.blockParameters(edge.block);
	const offset = kind === "exceptional" ? 1 : 0;
	if (kind === "ordinary" && parameters[0]?.role === "exception") {
		fail(`ordinary edge b${from} -> b${edge.block} targets an exception entry`);
	}
	if (kind === "exceptional" && parameters[0]?.role !== "exception") {
		fail(`exceptional edge b${from} -> b${edge.block} lacks an exception parameter`);
	}
	if (edge.arguments.length !== parameters.length - offset) {
		fail(
			`${kind} edge b${from} -> b${edge.block} passes ${edge.arguments.length} values to ${parameters.length - offset} parameters`,
		);
	}
	for (const [index, value] of edge.arguments.entries()) {
		if (!fn.isValueLive(value)) {
			fail(`${kind} edge b${from} -> b${edge.block} references deleted value %${value}`);
		}
		if (fn.valueRepresentation(value) !== parameters[index + offset]!.representation) {
			fail(`${kind} edge b${from} -> b${edge.block} changes value representation`);
		}
	}
}

function verifyControlFlow(fn: CoreFunctionStore, program: CoreProgram): CoreControlFlow {
	for (const block of fn.blockIds()) {
		const payload = fn.terminatorPayload(fn.blockTerminator(block));
		for (const edge of coreTerminatorEdges(payload))
			verifyEdge(fn, block, edge, "ordinary");
		const handler = fn.blockHandler(block);
		if (handler !== undefined) {
			verifyEdge(
				fn,
				block,
				{ block: handler.block, arguments: handler.arguments },
				"exceptional",
			);
		}
		if (payload.kind === "guard") {
			if (!fn.isFactLive(payload.fact)) {
				fail(`guard in b${block} references deleted fact !${payload.fact}`);
			}
			const fact = fn.fact(payload.fact);
			const instruction = fn.blockTerminator(block);
			if (
				fact.validity.kind !== "guard" ||
				fact.validity.instruction !== instruction ||
				!fact.obligations.some(
					(obligation) =>
						obligation.kind === "guard" && obligation.instruction === instruction,
				)
			) {
				fail(`guard fact !${payload.fact} is not anchored to @${instruction}`);
			}
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
		cfg.successors,
		cfg.reachable,
		(dominator, block) => cfg.dominates(dominator, block),
		(dominator, block) => cfg.instructionDominatesBlock(dominator, block),
	);
	return cfg;
}

function verifyDominance(
	fn: CoreFunctionStore,
	successors: ReadonlyArray<ReadonlyArray<CoreControlEdge>>,
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
		const definition = fn.valueDefinition(value);
		if (definition.kind === "block-parameter") {
			return definition.block === useBlock || dominates(definition.block, useBlock);
		}
		const definitionBlock = fn.instructionBlock(definition.instruction);
		return definitionBlock === useBlock
			? instructionOrder[definition.instruction]! < instructionOrder[instruction]!
			: instructionDominatesBlock(definitionBlock, useBlock);
	};
	for (const instruction of fn.instructionIds()) {
		if (!reachable.has(fn.instructionBlock(instruction))) continue;
		for (const value of fn.instructionOperands(instruction)) {
			if (!availableAtInstruction(value, instruction)) {
				const definition = fn.valueDefinition(value);
				const owner =
					definition.kind === "block-parameter"
						? `b${definition.block} parameter ${definition.index}`
						: `@${definition.instruction} in b${fn.instructionBlock(definition.instruction)}`;
				fail(
					`value %${value} from ${owner} does not dominate its use at @${instruction} in b${fn.instructionBlock(instruction)}`,
				);
			}
		}
	}
	for (const block of fn.blockIds()) {
		if (!reachable.has(block)) continue;
		const handler = fn.blockHandler(block);
		if (handler === undefined) continue;
		for (const value of handler.arguments) {
			const definition = fn.valueDefinition(value);
			const available =
				definition.kind === "block-parameter"
					? dominates(definition.block, block)
					: instructionDominatesBlock(fn.instructionBlock(definition.instruction), block);
			if (!available)
				fail(`value %${value} is unavailable on b${block}'s exception edge`);
		}
	}
	for (const outgoing of successors) {
		for (const edge of outgoing) {
			if (edge.kind !== "ordinary" || !reachable.has(edge.from)) continue;
			for (const value of edge.arguments) {
				const terminator = fn.blockTerminator(edge.from);
				if (!availableAtInstruction(value, terminator)) {
					fail(`value %${value} is unavailable on edge b${edge.from} -> b${edge.to}`);
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
			fn.terminatorPayload(instruction).kind !== "guard" ||
			(fn.terminatorPayload(instruction) as { readonly fact: CoreFactId }).fact !==
				fact.id
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
			const payload = fn.terminatorPayload(obligation.instruction);
			if (payload.kind !== "guard" || payload.fact !== fact.id) {
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
			const payload = fn.terminatorPayload(obligation.instruction);
			if (
				payload.kind !== "guard" ||
				!cfg.dominatesEdge(guardBlock, payload.success.block, useBlock)
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
	const entryParameters = fn.blockParameters(fn.entry);
	if (fn.parameters.length > entryParameters.length) {
		fail(`function parameter list exceeds entry block parameters`);
	}
	for (const [index, value] of fn.parameters.entries()) {
		if (entryParameters[index]?.value !== value) {
			fail(`function parameter ${index} is not entry parameter ${index}`);
		}
		if (
			entryParameters[index].role !== "value" ||
			entryParameters[index].representation !== "boxed"
		) {
			fail(`function parameter ${index} is not a boxed value`);
		}
	}
}

function verifyFunction(program: CoreProgram, functionId: CoreFunctionId): void {
	const fn = program.function(functionId);
	if (fn.id !== functionId) fail(`function row ${functionId} carries id ${fn.id}`);
	verifyMetadata(fn, program);
	verifyBlockRows(fn);
	const { liveUses } = verifyInstructionRows(fn, program);
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

function verifyCrossFunctionReferences(program: CoreProgram): void {
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const attributes = fn.instructionAttributes(instruction);
			const target = attributes.functionIndex;
			if (typeof target === "number") {
				if (!Number.isSafeInteger(target)) {
					fail(`instruction @${instruction} has non-integral function index ${target}`);
				}
				if (target >= program.functionCapacity) {
					fail(
						`instruction @${instruction} in function ${functionId} references function ${target}`,
					);
				}
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
	_compilationContext?: CoreCompilationContext,
): void {
	withContext(context, () => {
		verifyProgramTables(program);
		for (const functionId of program.functionIds()) {
			withContext(
				context === undefined ? undefined : { ...context, functionIndex: functionId },
				() => verifyFunction(program, functionId),
			);
		}
		verifyCrossFunctionReferences(program);
	});
}

export function verifyCoreChangeSet(
	program: CoreProgram,
	changes: CoreChangeSet,
	context?: CoreVerificationContext,
): void {
	verifyCoreFunction(program, changes.function, context);
	withContext(context, () => verifyCrossFunctionReferences(program));
}
