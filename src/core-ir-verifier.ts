import { buildCoreControlFlow, coreTerminatorEdges } from "./core-ir-control-flow.ts";
import type {
	CoreBlock,
	CoreBlockId,
	CoreEdge,
	CoreEffectDomain,
	CoreFact,
	CoreFunction,
	CoreInstructionEffects,
	CoreInstructionId,
	CoreOpcodeRegistry,
	CoreTerminator,
	CoreValue,
	CoreValueId,
} from "./core-ir.ts";

export class CoreIrVerificationError extends Error {
	constructor(message: string) {
		super(`Core IR verification failed: ${message}`);
		this.name = "CoreIrVerificationError";
	}
}

function fail(message: string): never {
	throw new CoreIrVerificationError(message);
}

function checkArity(kind: string, count: number, minimum: number, maximum: number): void {
	if (count < minimum || count > maximum) {
		fail(`${kind} has ${count} operands, expected ${minimum}..${maximum}`);
	}
}

function isSubset<T>(candidate: ReadonlyArray<T>, baseline: ReadonlyArray<T>): boolean {
	const allowed = new Set(baseline);
	return candidate.every((value) => allowed.has(value));
}

function verifyEffectRefinement(
	instructionId: CoreInstructionId,
	refined: CoreInstructionEffects,
	baseline: CoreInstructionEffects,
): void {
	if (!isSubset<CoreEffectDomain>(refined.reads, baseline.reads)) {
		fail(`instruction @${instructionId} adds read effects in a refinement`);
	}
	if (!isSubset<CoreEffectDomain>(refined.writes, baseline.writes)) {
		fail(`instruction @${instructionId} adds write effects in a refinement`);
	}
	for (const flag of ["mayThrow", "maySuspend", "mayGc", "callsUserCode"] as const) {
		if (refined[flag] && !baseline[flag]) {
			fail(`instruction @${instructionId} adds ${flag} in a refinement`);
		}
	}
}

function terminatorUses(terminator: CoreTerminator): ReadonlyArray<CoreValueId> {
	switch (terminator.kind) {
		case "jump":
			return terminator.edge.arguments;
		case "branch":
			return [
				terminator.condition,
				...terminator.consequent.arguments,
				...terminator.alternate.arguments,
			];
		case "guard":
			return [
				terminator.condition,
				...terminator.success.arguments,
				...terminator.fallback.arguments,
			];
		case "switch":
			return [
				terminator.discriminant,
				...terminator.cases.flatMap(({ edge }) => edge.arguments),
				...terminator.default.arguments,
			];
		case "return":
		case "throw":
			return [terminator.value];
		case "unreachable":
			return [];
	}
}

interface ValueDefinitionLocation {
	readonly block: CoreBlockId;
	/** -1 for a block parameter, otherwise the instruction's in-block index. */
	readonly instructionIndex: number;
}

interface GuardLocation {
	readonly instruction: CoreInstructionId;
	readonly fact: CoreFact["id"];
	readonly block: CoreBlockId;
	readonly success: CoreBlockId;
}

function verifyEdge(
	edge: CoreEdge,
	from: CoreBlock,
	blocks: ReadonlyMap<CoreBlockId, CoreBlock>,
): void {
	const target = blocks.get(edge.block);
	if (target === undefined)
		fail(`block b${from.id} targets unknown block b${edge.block}`);
	if (target.parameters[0]?.role === "exception") {
		fail(`ordinary edge b${from.id} -> b${edge.block} targets an exception entry`);
	}
	if (edge.arguments.length !== target.parameters.length) {
		fail(
			`edge b${from.id} -> b${edge.block} passes ${edge.arguments.length} values to ${target.parameters.length} parameters`,
		);
	}
}

function requireDenseIds<T extends { readonly id: number }>(
	values: ReadonlyArray<T>,
	kind: string,
): void {
	for (let index = 0; index < values.length; index++) {
		if (values[index]?.id !== index) {
			fail(
				`${kind} ids must be dense and ordered; index ${index} has id ${values[index]?.id}`,
			);
		}
	}
}

function requireStableIds<T extends { readonly id: number }>(
	values: ReadonlyArray<T>,
	kind: string,
): void {
	let previous = -1;
	const seen = new Set<number>();
	for (const value of values) {
		if (!Number.isSafeInteger(value.id) || value.id < 0)
			fail(`invalid ${kind} id ${value.id}`);
		if (seen.has(value.id)) fail(`duplicate ${kind} id ${value.id}`);
		if (value.id <= previous)
			fail(`${kind} ids must stay in monotonically allocated order`);
		seen.add(value.id);
		previous = value.id;
	}
}

/** Throws CoreIrVerificationError when any canonical middle-end invariant is broken. */
export function verifyCoreFunction(fn: CoreFunction, registry: CoreOpcodeRegistry): void {
	if (!Number.isSafeInteger(fn.functionIndex) || fn.functionIndex < 0) {
		fail(`invalid function index ${fn.functionIndex}`);
	}
	requireDenseIds(fn.blocks, "block");
	requireStableIds(fn.values, "value");
	requireStableIds(fn.facts, "fact");
	const blocks = new Map(fn.blocks.map((block) => [block.id, block]));
	if (!blocks.has(fn.entry)) fail(`unknown entry block b${fn.entry}`);

	const instructionIds = new Set<CoreInstructionId>();
	const definitions = new Map<CoreValueId, ValueDefinitionLocation>();
	const values = new Map<CoreValueId, CoreValue>(
		fn.values.map((value) => [value.id, value]),
	);
	const facts = new Map(fn.facts.map((fact) => [fact.id, fact]));
	const guards = new Map<CoreInstructionId, GuardLocation>();

	for (const block of fn.blocks) {
		let exceptionParameters = 0;
		for (const [index, parameter] of block.parameters.entries()) {
			if (parameter.role === "exception") exceptionParameters++;
			if (parameter.role === "exception" && index !== 0) {
				fail(`exception parameter in b${block.id} must be first`);
			}
			const value = values.get(parameter.value);
			if (
				value === undefined ||
				value.definition.kind !== "block-parameter" ||
				value.definition.block !== block.id ||
				value.definition.index !== index
			) {
				fail(`parameter ${parameter.value} in b${block.id} has a mismatched definition`);
			}
			if (value.representation !== parameter.representation) {
				fail(
					`parameter ${parameter.value} in b${block.id} has a mismatched representation`,
				);
			}
			definitions.set(parameter.value, { block: block.id, instructionIndex: -1 });
		}
		if (exceptionParameters > 1)
			fail(`block b${block.id} has multiple exception parameters`);

		for (const [instructionIndex, instruction] of block.instructions.entries()) {
			if (instructionIds.has(instruction.id))
				fail(`duplicate instruction id @${instruction.id}`);
			instructionIds.add(instruction.id);
			const descriptor = registry.get(instruction.opcode);
			if (descriptor === undefined)
				fail(`instruction @${instruction.id} has unknown opcode ${instruction.opcode}`);
			checkArity(
				`instruction @${instruction.id} input`,
				instruction.inputs.length,
				descriptor.inputs.minimum,
				descriptor.inputs.maximum,
			);
			checkArity(
				`instruction @${instruction.id} output`,
				instruction.outputs.length,
				descriptor.outputs.minimum,
				descriptor.outputs.maximum,
			);
			for (const [outputIndex, output] of instruction.outputs.entries()) {
				const value = values.get(output);
				if (
					value === undefined ||
					value.definition.kind !== "instruction" ||
					value.definition.instruction !== instruction.id ||
					value.definition.index !== outputIndex
				) {
					fail(`output ${output} of @${instruction.id} has a mismatched definition`);
				}
				if (definitions.has(output)) fail(`value ${output} has multiple definitions`);
				definitions.set(output, { block: block.id, instructionIndex });
			}
			if (instruction.effectRefinement !== undefined) {
				const proof = facts.get(instruction.effectRefinement.proof);
				if (proof === undefined) {
					fail(
						`instruction @${instruction.id} references unknown fact ${instruction.effectRefinement.proof}`,
					);
				}
				verifyEffectRefinement(
					instruction.id,
					instruction.effectRefinement.effects,
					descriptor.effects,
				);
				if (
					proof.validity.kind === "asserted" &&
					!proof.obligations.some(({ kind }) => kind === "guard")
				) {
					fail(`asserted fact ${proof.id} refines @${instruction.id} without a guard`);
				}
			}
		}
		if (instructionIds.has(block.terminator.id)) {
			fail(`duplicate instruction id @${block.terminator.id}`);
		}
		instructionIds.add(block.terminator.id);
		if (block.terminator.kind === "guard") {
			if (!facts.has(block.terminator.fact)) {
				fail(
					`guard @${block.terminator.id} references unknown fact ${block.terminator.fact}`,
				);
			}
			guards.set(block.terminator.id, {
				instruction: block.terminator.id,
				fact: block.terminator.fact,
				block: block.id,
				success: block.terminator.success.block,
			});
		}
		for (const edge of coreTerminatorEdges(block.terminator))
			verifyEdge(edge, block, blocks);

		if (block.handler !== undefined) {
			const handler = blocks.get(block.handler.block);
			if (handler === undefined)
				fail(`block b${block.id} has unknown handler b${block.handler.block}`);
			if (handler.parameters[0]?.role !== "exception") {
				fail(`handler b${block.handler.block} must start with an exception parameter`);
			}
			if (block.handler.arguments.length + 1 !== handler.parameters.length) {
				fail(
					`exception edge b${block.id} -> b${block.handler.block} passes ${block.handler.arguments.length} values to ${handler.parameters.length - 1} explicit parameters`,
				);
			}
		}
	}

	if (definitions.size !== fn.values.length) {
		const missing = fn.values.find(({ id }) => !definitions.has(id));
		fail(`value ${missing?.id} has no definition`);
	}

	const cfg = buildCoreControlFlow(fn, registry);
	if (cfg.reachable.size !== fn.blocks.length) {
		const unreachable = fn.blocks.find(({ id }) => !cfg.reachable.has(id));
		fail(`block b${unreachable?.id} is unreachable`);
	}

	for (const fact of fn.facts) {
		const guardObligations = fact.obligations.filter(
			(
				obligation,
			): obligation is Extract<(typeof fact.obligations)[number], { kind: "guard" }> =>
				obligation.kind === "guard",
		);
		if (fact.validity.kind === "asserted" && guardObligations.length === 0) {
			fail(`asserted fact ${fact.id} has no guard obligation`);
		}
		if (
			fact.validity.kind === "epoch" &&
			guardObligations.length === 0 &&
			!fact.obligations.some(({ kind }) => kind === "fallback")
		) {
			fail(`epoch fact ${fact.id} has neither a guard nor a fallback`);
		}
		if (fact.validity.kind === "guard") {
			const guard = guards.get(fact.validity.instruction);
			if (guard === undefined || guard.fact !== fact.id) {
				fail(`fact ${fact.id} names a guard that does not establish it`);
			}
		}
		for (const obligation of fact.obligations) {
			if (obligation.kind === "guard") {
				const guard = guards.get(obligation.instruction);
				if (guard === undefined || guard.fact !== fact.id) {
					fail(`fact ${fact.id} has an invalid guard obligation`);
				}
			} else if (obligation.id.length === 0) {
				fail(`fact ${fact.id} has an empty ${obligation.kind} obligation`);
			}
		}
	}

	const verifyFactAvailable = (
		fact: CoreFact,
		block: CoreBlock,
		instructionId: CoreInstructionId,
	): void => {
		const guardObligations = fact.obligations.filter(
			(
				obligation,
			): obligation is Extract<(typeof fact.obligations)[number], { kind: "guard" }> =>
				obligation.kind === "guard",
		);
		if (
			(fact.validity.kind === "asserted" || fact.validity.kind === "epoch") &&
			guardObligations.length === 0
		) {
			fail(`fact ${fact.id} cannot refine @${instructionId} without a guard`);
		}
		for (const obligation of guardObligations) {
			const guard = guards.get(obligation.instruction)!;
			if (!cfg.dominates(guard.success, block.id)) {
				fail(
					`guard @${guard.instruction} for fact ${fact.id} does not dominate @${instructionId}`,
				);
			}
		}
	};

	const verifyUse = (
		valueId: CoreValueId,
		block: CoreBlock,
		instructionIndex: number,
		context: string,
	): void => {
		const definition = definitions.get(valueId);
		if (definition === undefined) fail(`${context} uses unknown value ${valueId}`);
		if (definition.block === block.id) {
			if (definition.instructionIndex >= instructionIndex) {
				fail(`${context} uses ${valueId} before its definition in b${block.id}`);
			}
			return;
		}
		if (!cfg.dominates(definition.block, block.id)) {
			fail(`${context} uses ${valueId}, which does not dominate b${block.id}`);
		}
	};

	for (const block of fn.blocks) {
		for (const [instructionIndex, instruction] of block.instructions.entries()) {
			for (const input of instruction.inputs) {
				verifyUse(input, block, instructionIndex, `instruction @${instruction.id}`);
			}
			if (instruction.effectRefinement !== undefined) {
				verifyFactAvailable(
					facts.get(instruction.effectRefinement.proof)!,
					block,
					instruction.id,
				);
			}
		}
		for (const value of terminatorUses(block.terminator)) {
			verifyUse(
				value,
				block,
				block.instructions.length,
				`terminator @${block.terminator.id}`,
			);
		}
		if (block.handler !== undefined) {
			for (const argument of block.handler.arguments) {
				const definition = definitions.get(argument);
				if (definition === undefined)
					fail(`handler edge from b${block.id} uses unknown value ${argument}`);
				if (
					definition.block === block.id
						? definition.instructionIndex !== -1
						: !cfg.dominates(definition.block, block.id)
				) {
					fail(
						`handler edge from b${block.id} uses ${argument}, which is not available at block entry`,
					);
				}
			}
		}
	}
}
