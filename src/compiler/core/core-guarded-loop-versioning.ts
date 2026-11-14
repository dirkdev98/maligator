import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreFunctionIsCloneable } from "./core-function-clone.ts";
import { CORE_FUNCTION_HAS_BACKEDGES } from "./core-function-features.ts";
import {
	CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE,
	CORE_KNOWN_OWN_SLOT_ATTRIBUTE,
	coreUnscopedInstructionAttributes,
} from "./core-internal-attributes.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreTerminatorEdges,
	coreTerminatorInput,
} from "./core-ir-control-flow.ts";
import type { CoreControlFlow, CoreNaturalLoop } from "./core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreValueKindAnalysis } from "./core-ir-value-kinds.ts";
import { coreBlockId, coreInstructionId, coreRepresentationCanWiden } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreInstructionId,
	CoreInstructionAttributes,
	CoreRepresentation,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import type { CoreFunctionStore } from "./core-store.ts";

const GENERIC_TWIN = "guardedLoopGenericTwin";
const MAX_LOOP_INSTRUCTIONS = 192;
const MAX_LOOP_BLOCKS = 32;
const MAX_NUMBER_CHECKS = 16;
const MAX_LIVE_PARAMETERS = 256;

function inputs(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	return Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) => fn.kernel.operandAt(start + index),
	);
}

function outputs(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionResultStart(instruction);
	return Array.from(
		{ length: fn.kernel.instructionResultCount(instruction) },
		(_, index) => fn.kernel.resultAt(start + index),
	);
}

function parameters(fn: CoreFunctionStore, block: CoreBlockId): Array<CoreValueId> {
	const start = fn.kernel.blockParameterStart(block);
	return Array.from({ length: fn.kernel.blockParameterCount(block) }, (_, index) =>
		fn.kernel.blockParameterValue(start + index),
	);
}

function definitionBlock(fn: CoreFunctionStore, value: CoreValueId): CoreBlockId {
	const owner = fn.kernel.valueDefinitionOwner(value);
	return fn.kernel.valueDefinitionKind(value) === 1
		? fn.instructionBlock(coreInstructionId(owner))
		: coreBlockId(owner);
}

function mapTerminator(
	input: CoreTerminatorInput,
	value: (value: CoreValueId) => CoreValueId,
	edge: (edge: CoreEdge) => CoreEdge,
): CoreTerminatorInput {
	switch (input.kind) {
		case "jump":
			return { ...input, edge: edge(input.edge) };
		case "branch":
			return {
				...input,
				condition: value(input.condition),
				consequent: edge(input.consequent),
				alternate: edge(input.alternate),
			};
		case "switch":
			return {
				...input,
				discriminant: value(input.discriminant),
				cases: input.cases.map((entry) => ({ ...entry, edge: edge(entry.edge) })),
				default: edge(input.default),
			};
		case "return":
		case "throw":
			return { ...input, value: value(input.value) };
		case "unreachable":
			return input;
		case "guard":
			throw new Error("A guarded loop twin cannot copy a scoped guard fact");
	}
}

function terminatorOf(
	fn: CoreFunctionStore,
	block: CoreBlockId,
): CoreInstructionId | undefined {
	const last = fn.kernel.blockLastInstruction(block);
	return last >= 0 && fn.kernel.instructionOpcode(coreInstructionId(last)) < 0
		? coreInstructionId(last)
		: undefined;
}

function writeTerminator(
	editor: CoreEditor,
	block: CoreBlockId,
	input: CoreTerminatorInput,
): void {
	if (terminatorOf(editor.function, block) === undefined)
		editor.setTerminator(block, input);
	else editor.replaceTerminator(block, input);
}

interface Diamond {
	readonly block: CoreBlockId;
	readonly condition: CoreValueId;
	readonly fast: CoreEdge;
	readonly fallback: CoreEdge;
	readonly invariant: boolean;
	readonly fastOnTrue: boolean;
}

interface LoopPlan {
	readonly loop: CoreNaturalLoop;
	readonly exit: CoreBlockId;
	readonly diamonds: ReadonlyArray<Diamond>;
	readonly numeric: ReadonlySet<CoreValueId>;
	readonly boundaries: ReadonlyMap<CoreInstructionId, CoreValueId>;
}

// The backend already guards invariant binding loads once for a scalar loop.
function hasOnlyInvariantBindings(
	fn: CoreFunctionStore,
	loop: CoreNaturalLoop,
	fallbacks: ReadonlyMap<CoreBlockId, Diamond>,
	boundaries: ReadonlyMap<CoreInstructionId, CoreValueId>,
): boolean {
	const bindings = new Set([
		"loadGlobal",
		"loadCaptured",
		"loadIntrinsic",
		"loadThis",
		"loadCallee",
	]);
	const scalar = new Set([
		"createNumber",
		"createI32",
		"createF64",
		"createBoolean",
		"createString",
		"createUndefined",
		"createNull",
		"binary",
		"unary",
		"move",
		"typeofCompare",
		"throwIfTdz",
		"requireCoercible",
		"guardFunctionIndex",
		"guardBoundFunction",
		"guardBaseConstructorLayout",
	]);
	for (const block of loop.blocks) {
		if (fallbacks.has(block)) continue;
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction);
			if (
				!bindings.has(opcode) &&
				!scalar.has(opcode) &&
				opcode !== "loadPropertyStatic" &&
				opcode !== "loadBoundFunctionSlot"
			)
				return false;
		}
	}
	const visited = new Set<CoreValueId>();
	const invariant = (value: CoreValueId): boolean => {
		if (!loop.blocks.has(definitionBlock(fn, value))) return true;
		if (fn.kernel.valueDefinitionKind(value) !== 1 || visited.has(value)) return false;
		visited.add(value);
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(instruction);
		const answer =
			bindings.has(opcode) ||
			((scalar.has(opcode) ||
				opcode === "loadPropertyStatic" ||
				opcode === "loadBoundFunctionSlot") &&
				inputs(fn, instruction).every(invariant));
		visited.delete(value);
		return answer;
	};
	return [...boundaries.values()].every(invariant);
}

function planLoop(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	kinds: CoreValueKindAnalysis,
	loop: CoreNaturalLoop,
): LoopPlan | undefined {
	if (
		!loop.canonical ||
		loop.preheader === undefined ||
		loop.blocks.size > MAX_LOOP_BLOCKS ||
		cfg.loops.some((other) => other.parentHeader === loop.header)
	)
		return undefined;
	const exits = new Set(loop.exits.map((edge) => edge.to));
	if (exits.size !== 1) return undefined;
	const exit = [...exits][0]!;
	if (cfg.predecessors[exit]!.some((edge) => !loop.blocks.has(edge.from)))
		return undefined;
	let size = 0;
	let operands = 0;
	const candidates = new Map<CoreBlockId, Diamond>();
	for (const block of loop.blocks) {
		const body = [...fn.bodyInstructionIds(block)];
		size += body.length + 1;
		operands += body.reduce(
			(total, instruction) =>
				total +
				fn.kernel.instructionOperandCount(instruction) +
				fn.kernel.instructionResultCount(instruction),
			0,
		);
		if (
			size > MAX_LOOP_INSTRUCTIONS ||
			operands > 1024 ||
			fn.kernel.blockHandlerBlock(block) !== undefined
		)
			return undefined;
		const end = coreTerminatorInput(fn, fn.blockTerminator(block));
		if (end.kind === "guard" || end.kind === "return" || end.kind === "throw")
			return undefined;
		if (end.kind !== "branch") continue;
		for (const [fallback, fast] of [
			[end.alternate, end.consequent],
			[end.consequent, end.alternate],
		] as const) {
			if (!loop.blocks.has(fallback.block) || !loop.blocks.has(fast.block)) continue;
			const incoming = cfg.predecessors[fallback.block]!;
			if (incoming.length !== 1 || incoming[0]!.from !== block) continue;
			const fallbackEnd = coreTerminatorInput(fn, fn.blockTerminator(fallback.block));
			if (fallbackEnd.kind !== "jump" || !loop.blocks.has(fallbackEnd.edge.block))
				continue;
			const calls = [...fn.bodyInstructionIds(fallback.block)].filter(
				(instruction) =>
					fn.instructionAttributes(instruction)[
						CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
					] === true && fn.instructionAttributes(instruction)[GENERIC_TWIN] !== true,
			);
			if (calls.length !== 1) continue;
			candidates.set(fallback.block, {
				block,
				condition: end.condition,
				fast,
				fallback,
				invariant:
					!loop.blocks.has(definitionBlock(fn, end.condition)) &&
					cfg.dominates(definitionBlock(fn, end.condition), loop.preheader),
				fastOnTrue: end.consequent.block === fast.block,
			});
		}
	}
	if (candidates.size === 0) return undefined;
	const numeric = new Set<CoreValueId>();
	const boundaries = new Map<CoreInstructionId, CoreValueId>();
	const selected = new Set<Diamond>();
	const trace = (value: CoreValueId): boolean => {
		if (kinds.kindMask(value) === COMPILER_VALUE_KIND_NUMBER) return true;
		if (numeric.has(value)) return true;
		if ((kinds.kindMask(value) & COMPILER_VALUE_KIND_NUMBER) === 0) return false;
		const block = definitionBlock(fn, value);
		if (!loop.blocks.has(block)) return false;
		numeric.add(value);
		if (fn.kernel.valueDefinitionKind(value) !== 1) {
			const index = parameters(fn, block).indexOf(value);
			if (index < 0) return false;
			for (const edge of cfg.predecessors[block]!) {
				const diamond = candidates.get(edge.from);
				if (diamond !== undefined) {
					selected.add(diamond);
					continue;
				}
				if (
					edge.kind !== "ordinary" ||
					edge.arguments[index] === undefined ||
					!trace(edge.arguments[index])
				)
					return false;
			}
			return true;
		}
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(instruction);
		if (
			opcode === "move" ||
			(opcode === "binary" && fn.instructionAttributes(instruction).operator === "+")
		)
			return inputs(fn, instruction).every(trace);
		if (outputs(fn, instruction).length !== 1 || boundaries.size >= MAX_NUMBER_CHECKS)
			return false;
		boundaries.set(instruction, value);
		return true;
	};
	let found = false;
	for (const value of parameters(fn, loop.header)) {
		if (
			fn.valueRepresentation(value) !== "boxed" ||
			kinds.kindMask(value) === COMPILER_VALUE_KIND_NUMBER
		)
			continue;
		if (!trace(value)) return undefined;
		found = true;
	}
	if (
		!found ||
		selected.size === 0 ||
		hasOnlyInvariantBindings(fn, loop, candidates, boundaries)
	)
		return undefined;
	return { loop, exit, diamonds: [...selected], numeric, boundaries };
}

interface Segment {
	readonly source: CoreBlockId;
	readonly parameters: ReadonlyArray<CoreValueId>;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly live: Set<CoreValueId>;
	readonly uses: Set<CoreValueId>;
	readonly definitions: ReadonlySet<CoreValueId>;
	readonly end?: CoreTerminatorInput;
	next?: Segment;
	copy?: CoreBlockId;
	fast?: CoreBlockId;
}

/*
 * A bailout enters the generic copy after the work already performed. Its block
 * parameters carry every live SSA value, including definitions earlier in the
 * iteration, so neither a getter nor a call is replayed.
 */
function versionLoop(
	fn: CoreFunctionStore,
	plan: LoopPlan,
	open: () => CoreEditor,
): CoreEditor | undefined {
	const { loop } = plan;
	const originalBlocks = new Set(fn.blockIds());
	const representations = new Map<CoreValueId, CoreRepresentation>();
	const remember = (value: CoreValueId) =>
		representations.set(value, fn.valueRepresentation(value));
	const liveOut = new Set<CoreValueId>();
	for (const block of loop.blocks) {
		for (const value of parameters(fn, block)) remember(value);
		for (const instruction of fn.bodyInstructionIds(block))
			for (const value of outputs(fn, instruction)) remember(value);
	}
	for (const value of representations.keys()) {
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (
				fn.kernel.useLive(use) !== 0 &&
				!loop.blocks.has(
					fn.instructionBlock(coreInstructionId(fn.kernel.useInstruction(use))),
				)
			)
				liveOut.add(value);
		}
	}
	const outgoing = [...liveOut].sort((a, b) => a - b);
	const exitParameters = parameters(fn, plan.exit);

	const first = new Map<CoreBlockId, Segment>();
	const segments: Array<Segment> = [];
	const after = new Map<CoreInstructionId, Segment>();
	for (const block of loop.blocks) {
		const body = [...fn.bodyInstructionIds(block)];
		let start = 0;
		let previous: Segment | undefined;
		const cuts = [
			...body.flatMap((instruction, index) =>
				plan.boundaries.has(instruction) ? [index + 1] : [],
			),
			body.length,
		];
		for (const [index, stop] of cuts.entries()) {
			if (index > 0 && stop === cuts[index - 1] && stop !== body.length) continue;
			const copied = body.slice(start, stop);
			const blockParameters = previous === undefined ? parameters(fn, block) : [];
			const definitions = new Set([
				...blockParameters,
				...copied.flatMap((instruction) => outputs(fn, instruction)),
			]);
			const uses = new Set<CoreValueId>();
			const defined = new Set(blockParameters);
			for (const instruction of copied) {
				for (const value of inputs(fn, instruction))
					if (!defined.has(value) && representations.has(value)) uses.add(value);
				for (const value of outputs(fn, instruction)) defined.add(value);
			}
			const last = index === cuts.length - 1;
			const end = last ? coreTerminatorInput(fn, fn.blockTerminator(block)) : undefined;
			if (last) {
				for (const value of inputs(fn, fn.blockTerminator(block)))
					if (!defined.has(value) && representations.has(value)) uses.add(value);
				if (coreTerminatorEdges(end!).some((edge) => !loop.blocks.has(edge.block)))
					for (const value of outgoing) if (!defined.has(value)) uses.add(value);
			}
			const segment: Segment = {
				source: block,
				parameters: blockParameters,
				instructions: copied,
				definitions,
				uses,
				live: new Set(uses),
				...(end === undefined ? {} : { end }),
			};
			if (previous === undefined) first.set(block, segment);
			else {
				previous.next = segment;
				after.set(previous.instructions.at(-1)!, segment);
			}
			segments.push(segment);
			previous = segment;
			start = stop;
		}
	}
	for (let changed = true; changed;) {
		changed = false;
		for (const segment of segments.toReversed()) {
			const successors =
				segment.next === undefined
					? coreTerminatorEdges(segment.end!).flatMap(
							(edge) => first.get(edge.block) ?? [],
						)
					: [segment.next];
			for (const successor of successors)
				for (const value of successor.live)
					if (!segment.definitions.has(value) && !segment.live.has(value)) {
						segment.live.add(value);
						changed = true;
					}
		}
	}
	const liveParameters = segments.reduce(
		(count, segment) => count + segment.live.size,
		0,
	);
	if (liveParameters > MAX_LIVE_PARAMETERS) return undefined;
	const editor = open();
	const exitJoin = editor.createBlock(
		[...exitParameters, ...outgoing].map((value) => ({
			representation: fn.valueRepresentation(value),
		})),
	);
	const joined = parameters(fn, exitJoin);
	const outside = new Map(
		outgoing.map((value, index) => [value, joined[exitParameters.length + index]!]),
	);
	for (const block of originalBlocks) {
		if (loop.blocks.has(block)) continue;
		for (const instruction of fn.bodyInstructionIds(block)) {
			const old = inputs(fn, instruction);
			if (old.some((value) => outside.has(value)))
				editor.replaceOperands(
					instruction,
					old.map((value) => outside.get(value) ?? value),
				);
		}
		const terminator = fn.blockTerminator(block);
		if (inputs(fn, terminator).some((value) => outside.has(value)))
			writeTerminator(
				editor,
				block,
				mapTerminator(
					coreTerminatorInput(fn, terminator),
					(value) => outside.get(value) ?? value,
					(edge) => ({
						...edge,
						arguments: edge.arguments.map((value) => outside.get(value) ?? value),
					}),
				),
			);
	}
	writeTerminator(editor, exitJoin, {
		kind: "jump",
		edge: { block: plan.exit, arguments: joined.slice(0, exitParameters.length) },
	});
	for (const segment of segments)
		segment.copy = editor.createBlock(
			[...segment.parameters, ...segment.live].map((value) => ({
				representation: representations.get(value)!,
			})),
		);
	const cloneAttributes = (instruction: CoreInstructionId) => {
		const attributes: Record<string, CoreInstructionAttributes[string]> = {
			...coreUnscopedInstructionAttributes(fn.instructionAttributes(instruction)),
			...(fn.instructionAttributes(instruction)[
				CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
			] === true
				? { [GENERIC_TWIN]: true }
				: {}),
		};
		delete attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE];
		return attributes;
	};
	for (const segment of segments) {
		const values = new Map(
			[...segment.parameters, ...segment.live].map((value, index) => [
				value,
				parameters(fn, segment.copy!)[index]!,
			]),
		);
		const map = (value: CoreValueId): CoreValueId => {
			if (!representations.has(value)) return value;
			const mapped = values.get(value);
			if (mapped === undefined)
				throw new Error(`Guarded loop copy lost live value ${value}`);
			return mapped;
		};
		for (const instruction of segment.instructions) {
			const result = outputs(fn, instruction);
			const created = editor.appendInstruction(
				segment.copy!,
				fn.instructionOpcodeName(instruction),
				inputs(fn, instruction).map(map),
				{
					attributes: cloneAttributes(instruction),
					sourcePosition: fn.instructionSourcePosition(instruction),
					outputCount: result.length,
					outputRepresentations: result.map((value) => representations.get(value)!),
				},
			);
			result.forEach((value, index) => values.set(value, created.outputs[index]!));
		}
		const edge = (edge: CoreEdge): CoreEdge => {
			const target = first.get(edge.block);
			return target === undefined
				? { block: exitJoin, arguments: [...edge.arguments, ...outgoing].map(map) }
				: {
						block: target.copy!,
						arguments: [...edge.arguments, ...target.live].map(map),
					};
		};
		writeTerminator(
			editor,
			segment.copy!,
			segment.next === undefined
				? mapTerminator(segment.end!, map, edge)
				: {
						kind: "jump",
						edge: {
							block: segment.next.copy!,
							arguments: [...segment.next.live].map(map),
						},
					},
		);
	}

	for (const segment of segments)
		segment.fast =
			segment === first.get(segment.source) ? segment.source : editor.createBlock();
	for (const segment of segments) {
		for (const instruction of segment.instructions)
			if (fn.instructionBlock(instruction) !== segment.fast)
				editor.moveInstruction(instruction, segment.fast!);
		if (segment.end !== undefined) {
			const current = fn.blockTerminator(segment.source);
			if (segment.fast !== segment.source) editor.removeInstruction(current);
			writeTerminator(editor, segment.fast!, segment.end);
		}
	}
	const scalar = new Map<CoreValueId, CoreValueId>();
	for (const value of plan.numeric) {
		if (
			fn.kernel.valueDefinitionKind(value) !== 1 ||
			!plan.boundaries.has(coreInstructionId(fn.kernel.valueDefinitionOwner(value)))
		) {
			editor.setValueRepresentation(value, "f64");
			scalar.set(value, value);
		}
	}
	const bridgeEdge = (edge: CoreEdge): CoreEdge => {
		const target = parameters(fn, edge.block);
		if (
			edge.arguments.every(
				(value, index) =>
					fn.valueRepresentation(value) === fn.valueRepresentation(target[index]!),
			)
		)
			return edge;
		const bridge = editor.createBlock();
		const arguments_ = edge.arguments.map((value, index) => {
			const representation = fn.valueRepresentation(target[index]!);
			if (fn.valueRepresentation(value) === representation) return value;
			if (!coreRepresentationCanWiden(fn.valueRepresentation(value), representation))
				throw new Error("Guarded loop bailout would narrow a value");
			return editor.appendInstruction(bridge, "move", [value], {
				outputRepresentations: [representation],
			}).outputs[0]!;
		});
		writeTerminator(editor, bridge, {
			kind: "jump",
			edge: { block: edge.block, arguments: arguments_ },
		});
		return { block: bridge, arguments: [] };
	};

	for (const [instruction, value] of plan.boundaries) {
		const next = after.get(instruction)!;
		const from = fn.instructionBlock(instruction);
		const condition = editor.appendInstruction(from, "typeofCompare", [value], {
			attributes: { expected: "number", negated: false },
			outputRepresentations: ["boolean"],
		}).outputs[0]!;
		const number = editor.insertInstruction(
			next.fast!,
			next.instructions[0],
			"unary",
			[value],
			{ attributes: { operator: "+" }, outputRepresentations: ["f64"] },
		).outputs[0]!;
		scalar.set(value, number);
		writeTerminator(editor, from, {
			kind: "branch",
			condition,
			consequent: { block: next.fast!, arguments: [] },
			alternate: bridgeEdge({ block: next.copy!, arguments: [...next.live] }),
		});
	}
	const numberAt = (
		value: CoreValueId,
		block: CoreBlockId,
		before: CoreInstructionId | undefined,
	): CoreValueId => {
		const mapped = scalar.get(value) ?? value;
		if (
			fn.valueRepresentation(mapped) === "f64" ||
			fn.valueRepresentation(mapped) === "i32"
		)
			return mapped;
		return editor.insertInstruction(block, before, "unary", [mapped], {
			attributes: { operator: "+" },
			outputRepresentations: ["f64"],
		}).outputs[0]!;
	};
	for (const value of plan.numeric) {
		if (
			fn.kernel.valueDefinitionKind(value) !== 1 ||
			plan.boundaries.has(coreInstructionId(fn.kernel.valueDefinitionOwner(value)))
		)
			continue;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(instruction);
		const block = fn.instructionBlock(instruction);
		editor.replaceInstruction(
			instruction,
			opcode === "move" ? "unary" : opcode,
			inputs(fn, instruction).map((value) => numberAt(value, block, instruction)),
			{
				attributes:
					opcode === "move" ? { operator: "+" } : fn.instructionAttributes(instruction),
				sourcePosition: fn.instructionSourcePosition(instruction),
			},
		);
		editor.setValueRepresentation(value, "f64");
		scalar.set(value, value);
	}
	const removed = new Set(plan.diamonds.map((diamond) => diamond.fallback.block));
	for (const segment of segments) {
		if (removed.has(segment.source) || segment.end === undefined) continue;
		const block = segment.fast!;
		const terminator = fn.blockTerminator(block);
		const original = coreTerminatorInput(fn, terminator);
		const diamond = plan.diamonds.find((entry) => entry.block === segment.source);
		const edge = (edge: CoreEdge): CoreEdge => {
			if (diamond !== undefined && edge.block === diamond.fallback.block) {
				const target = first.get(edge.block)!;
				return bridgeEdge({
					block: target.copy!,
					arguments: [...edge.arguments, ...target.live].map(
						(value) => scalar.get(value) ?? value,
					),
				});
			}
			if (edge.block === plan.exit)
				return bridgeEdge({
					block: exitJoin,
					arguments: [...edge.arguments, ...outgoing].map(
						(value) => scalar.get(value) ?? value,
					),
				});
			return bridgeEdge({
				block: edge.block,
				arguments: edge.arguments.map((value, index) =>
					plan.numeric.has(parameters(fn, edge.block)[index]!)
						? numberAt(value, block, terminator)
						: value,
				),
			});
		};
		writeTerminator(
			editor,
			block,
			diamond?.invariant
				? { kind: "jump", edge: edge(diamond.fast) }
				: mapTerminator(original, (value) => value, edge),
		);
	}
	const preheader = loop.preheader!;
	const entry = coreTerminatorInput(fn, fn.blockTerminator(preheader));
	if (entry.kind !== "jump" || entry.edge.block !== loop.header)
		throw new Error("Guarded loop lost its canonical preheader");
	let guardBlock = preheader;
	for (const diamond of plan.diamonds.filter((diamond) => diamond.invariant)) {
		const next = editor.createBlock();
		const target = first.get(loop.header)!;
		const fast = { block: next, arguments: [] };
		const generic = {
			block: target.copy!,
			arguments: [...entry.edge.arguments, ...target.live],
		};
		writeTerminator(editor, guardBlock, {
			kind: "branch",
			condition: diamond.condition,
			consequent: diamond.fastOnTrue ? fast : bridgeEdge(generic),
			alternate: diamond.fastOnTrue ? bridgeEdge(generic) : fast,
		});
		guardBlock = next;
	}
	writeTerminator(editor, guardBlock, {
		kind: "jump",
		edge: {
			block: loop.header,
			arguments: entry.edge.arguments.map((value, index) =>
				plan.numeric.has(parameters(fn, loop.header)[index]!)
					? numberAt(value, guardBlock, terminatorOf(fn, guardBlock))
					: value,
			),
		},
	});
	for (const block of removed) editor.removeBlock(block);
	return editor;
}

/** Keep a guarded call's generic completion outside a speculative Number recurrence. */
export const versionGuardedNumericLoops: CoreFunctionPass = {
	name: "guarded-numeric-loop-versioning",
	stage: "control-flow",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_BACKEDGES,
	requiredFunctionOpcodesAny: ["call"],
	admission: {
		predicate: "bounded guarded fallback in a full compilation",
		hasOpportunity({ program, function: functionId, compilationContext }) {
			if (compilationContext.facts.compilationMode !== "full") return false;
			const fn = program.function(functionId);
			if (
				fn.instructionCapacity > 4096 ||
				fn.valueCapacity > 8192 ||
				!coreFunctionIsCloneable(fn)
			)
				return false;
			let fallback = false;
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const attributes = fn.instructionAttributes(instruction);
				if (attributes[GENERIC_TWIN] === true) return false;
				fallback ||= attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true;
			}
			return fallback;
		},
	},
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "representations"],
	changes: { cfg: true, calls: true, facts: true, representations: true },
	budget: CORE_O2_PASS_BUDGETS["cfg-loop-licm-pre"],
	run(context) {
		const fn = context.program.function(context.item.function);
		const cfg = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).ordinary();
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		for (const loop of cfg.loops) {
			const plan = planLoop(fn, cfg, kinds, loop);
			if (plan === undefined || context.remainingEdits < 4096) continue;
			const editor = versionLoop(fn, plan, () => CoreEditor.open(context.program, fn.id));
			if (editor !== undefined) return editor.commit();
		}
		return undefined;
	},
};
