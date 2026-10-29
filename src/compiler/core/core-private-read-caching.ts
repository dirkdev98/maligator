import { CoreEditor } from "./core-editor.ts";
import { CORE_FUNCTION_HAS_BACKEDGES } from "./core-function-features.ts";
import {
	CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreTerminatorInput,
	mapCoreTerminatorEdges,
} from "./core-ir-control-flow.ts";
import type { CoreNaturalLoop } from "./core-ir-control-flow.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreBlockId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { corePrivateFieldFacts } from "./core-private-field-facts.ts";
import type { CoreFunctionStore } from "./core-store.ts";

// Allocations made inside a loop cannot be an object that existed before it.
const FRESH_RECEIVERS: ReadonlySet<string> = new Set([
	"createBaseConstructReceiver",
	"createObject",
	"createObjectShaped",
]);

// Operations that can give a captured private-name load another name to read.
const NAME_SLOT_WRITERS: ReadonlySet<string> = new Set([
	"createPrivateNames",
	"envCopy",
	"envPop",
	"envPush",
]);

const THIS_WRITERS: ReadonlySet<string> = new Set([
	"constructSuper",
	"constructSuperExplicit",
	"setThis",
]);

function operand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId {
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function definitionBlock(fn: CoreFunctionStore, value: CoreValueId): CoreBlockId {
	const owner = fn.kernel.valueDefinitionOwner(value);
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreBlockId(fn.kernel.instructionBlock(coreInstructionId(owner)))
		: coreBlockId(owner);
}

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	for (let depth = 0; depth < 16; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionOpcodeName(instruction) !== "move") return instruction;
		value = operand(fn, instruction, 0);
	}
	return undefined;
}

function hasUncachedPrivateRead(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds())
		if (
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "loadPrivate" &&
			fn.kernel.instructionOperandCount(instruction) === 2
		)
			return true;
	return false;
}

interface CachedLoop {
	readonly loop: CoreNaturalLoop;
	/** Each read's slot among the receiver and field pairs the loop carries. */
	readonly reads: Map<CoreInstructionId, number>;
	readonly slots: Map<string, number>;
}

/**
 * Carries a stable private field's value around a loop once a read inside it
 * has succeeded, so later reads of the same receiver and field reuse it. A
 * construction-only field that a non-suspending activation has read keeps that
 * value until the activation itself stores into it, so only stores inside the
 * loop can make the carried value stale.
 */
export const cacheStablePrivateReads: CoreFunctionPass = {
	name: "cache-stable-private-reads",
	stage: "control-flow",
	requiredFunctionFeatures: CORE_FUNCTION_HAS_BACKEDGES,
	requiredFunctionOpcodesAny: ["loadPrivate"],
	admission: {
		predicate: "construction-only private field read inside a loop",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			return (
				corePrivateFieldFacts(program) !== undefined &&
				!fn.isGenerator &&
				!fn.isAsync &&
				hasUncachedPrivateRead(fn)
			);
		},
	},
	requiredAnalyses: [
		CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
		CORE_CANONICAL_VALUE_ROOTS_ANALYSIS,
	],
	wakesOn: ["body", "cfg", "exceptionFlow"],
	changes: { cfg: true, calls: false, facts: false, representations: false },
	budget: CORE_O2_PASS_BUDGETS["cfg-loop-licm-pre"],
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		const facts = corePrivateFieldFacts(program);
		if (facts === undefined || fn.isGenerator || fn.isAsync) return undefined;
		const cfg = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
		const roots = context.analysis(CORE_CANONICAL_VALUE_ROOTS_ANALYSIS);
		const stores: Array<{
			readonly block: CoreBlockId;
			readonly field: string;
			readonly receiver: CoreValueId;
		}> = [];
		const nameWriters: Array<CoreBlockId> = [];
		let thisWriters = false;
		const reads: Array<CoreInstructionId> = [];
		for (const instruction of fn.instructionIds()) {
			const header = fn.instructionHeader(instruction);
			if (typeof header === "string") continue;
			const opcode = header.opcode;
			if (opcode === "storePrivate") {
				const field = facts.keys.key(fn, operand(fn, instruction, 1));
				if (field === undefined) return undefined;
				stores.push({
					block: fn.instructionBlock(instruction),
					field,
					receiver: operand(fn, instruction, 0),
				});
			} else if (NAME_SLOT_WRITERS.has(opcode))
				nameWriters.push(fn.instructionBlock(instruction));
			else if (THIS_WRITERS.has(opcode)) thisWriters = true;
			else if (
				opcode === "loadPrivate" &&
				fn.kernel.instructionOperandCount(instruction) === 2 &&
				cfg.reachable.has(fn.instructionBlock(instruction))
			)
				reads.push(instruction);
		}
		// The cache travels on ordinary edges, so a handler inside the loop would lose it.
		const loops = cfg.loops
			.filter(
				(loop) =>
					loop.canonical &&
					loop.preheader !== undefined &&
					![...loop.blocks].some((block) =>
						(cfg.predecessors[block] ?? []).some(({ kind }) => kind === "exceptional"),
					),
			)
			.sort((left, right) => left.depth - right.depth);
		const storesField = (loop: CoreNaturalLoop, field: string): boolean =>
			stores.some((store) => {
				if (store.field !== field || !loop.blocks.has(store.block)) return false;
				const allocation = definition(fn, store.receiver);
				return (
					allocation === undefined ||
					!FRESH_RECEIVERS.has(fn.instructionOpcodeName(allocation)) ||
					!loop.blocks.has(fn.instructionBlock(allocation))
				);
			});
		const invariant = (loop: CoreNaturalLoop, value: CoreValueId): boolean =>
			!loop.blocks.has(definitionBlock(fn, value));
		// Only a derived constructor or an arrow function's activation can see `this` change.
		const fixedThis =
			!fn.metadata.isDerivedConstructor && !fn.metadata.lexicalThis && !thisWriters;
		const receiverIdentity = (
			loop: CoreNaturalLoop,
			value: CoreValueId,
		): string | undefined => {
			const root = roots.get(value) ?? value;
			if (invariant(loop, root)) return `value:${root}`;
			const load = definition(fn, value);
			return fixedThis &&
				load !== undefined &&
				fn.instructionOpcodeName(load) === "loadThis"
				? "this"
				: undefined;
		};
		// Once initialized, a key slot holds one name per environment.
		const keyIdentity = (
			loop: CoreNaturalLoop,
			value: CoreValueId,
			field: string,
		): string | undefined => {
			const root = roots.get(value) ?? value;
			if (invariant(loop, root)) return `value:${root}`;
			const load = definition(fn, value);
			return load !== undefined &&
				(fn.instructionOpcodeName(load) === "loadGlobal" ||
					!nameWriters.some((block) => loop.blocks.has(block)))
				? field
				: undefined;
		};
		const cached = new Map<CoreBlockId, CachedLoop>();
		let estimatedEdits = 0;
		for (const read of reads) {
			const keyValue = operand(fn, read, 1);
			const field = facts.keys.key(fn, keyValue);
			if (field === undefined || facts.field(fn, keyValue)?.constructionOnly !== true)
				continue;
			const block = fn.instructionBlock(read);
			for (const loop of loops) {
				if (!loop.blocks.has(block) || storesField(loop, field)) continue;
				const receiver = receiverIdentity(loop, operand(fn, read, 0));
				const key =
					receiver === undefined ? undefined : keyIdentity(loop, keyValue, field);
				if (key === undefined) continue;
				let entry = cached.get(loop.header);
				// Parameters and a terminator per loop block, plus each read and its boxing.
				const edits = (entry === undefined ? 2 * loop.blocks.size + 2 : 0) + 2;
				if (estimatedEdits + edits > context.remainingEdits) break;
				estimatedEdits += edits;
				if (entry === undefined) {
					entry = { loop, reads: new Map(), slots: new Map() };
					cached.set(loop.header, entry);
				}
				const identity = `${receiver}|${key}`;
				let slot = entry.slots.get(identity);
				if (slot === undefined) entry.slots.set(identity, (slot = entry.slots.size));
				entry.reads.set(read, slot);
				break;
			}
		}
		if (cached.size === 0) return undefined;
		const editor = CoreEditor.open(program, item.function);
		for (const { loop, reads: loopReads, slots } of cached.values()) {
			const preheader = loop.preheader!;
			const empty = editor.insertInstruction(
				preheader,
				fn.blockTerminator(preheader),
				"createEmpty",
				[],
			).outputs[0]!;
			const order = cfg.reversePostorder.filter((block) => loop.blocks.has(block));
			// A block with one predecessor inside the loop sees that block's outgoing cache.
			const merges = new Set(
				order.filter(
					(block) => block === loop.header || (cfg.predecessors[block] ?? []).length > 1,
				),
			);
			const outgoing = new Map<CoreBlockId, ReadonlyArray<CoreValueId>>();
			for (const block of order) {
				const state = merges.has(block)
					? [
							...editor.appendBlockParameters(
								block,
								Array.from(slots, () => ({ representation: "boxed" as const })),
							),
						]
					: [...outgoing.get(cfg.predecessors[block]![0]!.from)!];
				for (const instruction of [...fn.bodyInstructionIds(block)]) {
					const slot = loopReads.get(instruction);
					if (slot === undefined) continue;
					const result = fn.kernel.resultAt(
						fn.kernel.instructionResultStart(instruction),
					);
					const next = fn.instructionNext(instruction) ?? fn.blockTerminator(block);
					editor.replaceInstruction(
						instruction,
						"loadPrivate",
						[operand(fn, instruction, 0), operand(fn, instruction, 1), state[slot]!],
						{
							attributes: fn.instructionAttributes(instruction),
							sourcePosition: fn.instructionSourcePosition(instruction),
							effectRefinement: fn.instructionEffectRefinement(instruction),
						},
					);
					state[slot] =
						fn.valueRepresentation(result) === "boxed"
							? result
							: editor.insertInstruction(block, next, "move", [result], {
									outputRepresentations: ["boxed"],
								}).outputs[0]!;
				}
				outgoing.set(block, state);
			}
			const passCache = (block: CoreBlockId, cache: ReadonlyArray<CoreValueId>) =>
				editor.replaceTerminator(
					block,
					mapCoreTerminatorEdges(
						coreTerminatorInput(fn, fn.blockTerminator(block)),
						(edge) =>
							merges.has(edge.block)
								? { ...edge, arguments: [...edge.arguments, ...cache] }
								: edge,
					),
				);
			passCache(
				preheader,
				Array.from(slots, () => empty),
			);
			for (const block of order) passCache(block, outgoing.get(block)!);
		}
		return editor.commit();
	},
};
