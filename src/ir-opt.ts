import {
	annotateDirectArrayPushSites,
	annotateDirectCallTargets,
	annotateDirectCollectionSites,
	annotateDirectStringCharCodeAtSites,
	decodeStringConstant,
	optEliminateCapturedSlots,
	optEmptyDeadFunctions,
	optInlineCalls,
	optInlineHofCallbacks,
	optInlineMethod,
	optInlineSpeculative,
} from "./inline.ts";
import type { CapturedSlotOptimizationFacts } from "./inline.ts";
import {
	buildIRRegisterIndex,
	definedRegisters,
	destinationCount,
} from "./ir-register-index.ts";
import { debugIntermediateProgram, getOrCreateStringConstant } from "./ir.ts";
import type {
	IntermediateProgram,
	IRFunction,
	IRImmediateValue,
	IRInstruction,
	IRTypeofResult,
} from "./ir.ts";
import { findBackEdges, isSafepoint } from "./liveness.ts";
import { definedRegister, inferVirtualReps } from "./register-alloc.ts";
import { debugEnabled, isNil } from "./utils.ts";

/**
 * IR instruction kinds with no side effects beyond writing their destination
 * register: they read operands and globals/slots, never run user code, never
 * throw, and never mutate observable state. One whose destination is never read
 * is dead and can be dropped. Deliberately conservative — `binary`/`unary` can
 * run a `valueOf`/`toString` or throw, property/call/store ops have effects, so
 * none of those appear here.
 */
const SIDE_EFFECT_FREE_OPS = new Set<IRInstruction["type"]>([
	"createNumber",
	"createF64",
	"createBoolean",
	"createString",
	"createBigint",
	"createUndefined",
	"createNull",
	"createEmpty",
	// Allocates a closure object but has no other observable effect, so an unused
	// one (e.g. a closure all of whose calls were inlined) is dead and removable —
	// this is what lets inlining eliminate the closure allocation. Capturing
	// declarations keep it alive through their storeCaptured (a non-listed effect).
	"createFunction",
	"move",
	"loadLocal",
	"loadGlobal",
	"loadCaptured",
	"loadIntrinsic",
	"loadThis",
	"loadNewTarget",
	"typeofCompare",
]);

interface OptimizationFeatures {
	call: boolean;
	object: boolean;
	property: boolean;
	typeofComparisonFunctions: ReadonlySet<IRFunction>;
	capturedSlots: CapturedSlotOptimizationFacts;
}

/** Cheap feature summary used to avoid building irrelevant per-function analyses. */
function optimizationFeatures(program: IntermediateProgram): OptimizationFeatures {
	const typeofComparisonFunctions = new Set<IRFunction>();
	const capturedAccessFunctions = new Set<IRFunction>();
	const capturedStoreOwnerFunctions = new Set<IRFunction>();
	const capturedEnvironmentFunctions = new Set<IRFunction>();
	const environmentReferenceCounts = new Map<number, number>();
	const features: OptimizationFeatures = {
		call: false,
		object: false,
		property: false,
		typeofComparisonFunctions,
		capturedSlots: {
			accessFunctions: capturedAccessFunctions,
			storeOwnerFunctions: capturedStoreOwnerFunctions,
			environmentFunctions: capturedEnvironmentFunctions,
			environmentReferenceCounts,
		},
	};
	for (const fn of program.functions) {
		let hasTypeof = false;
		let hasEquality = false;
		let hasString = false;
		if (fn.nextCapturedIndex > 0) {
			capturedEnvironmentFunctions.add(fn);
		}
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				switch (instruction.type) {
					case "call":
					case "construct":
						features.call = true;
						break;
					case "createObject":
					case "createObjectShaped":
						features.object = true;
						break;
					case "loadProperty":
					case "storeProperty":
						features.property = true;
						break;
					case "unary":
						hasTypeof ||= instruction.operator === "typeof";
						break;
					case "binary":
						hasEquality ||=
							instruction.operator === "===" ||
							instruction.operator === "!==" ||
							instruction.operator === "==" ||
							instruction.operator === "!=";
						break;
					case "createString":
						hasString = true;
						break;
					case "loadCaptured":
					case "storeCaptured": {
						if (instruction.functionIndex !== undefined) {
							environmentReferenceCounts.set(
								instruction.functionIndex,
								(environmentReferenceCounts.get(instruction.functionIndex) ?? 0) + 1,
							);
						}
						if (
							instruction.functionIndex === undefined ||
							instruction.index === undefined
						) {
							break;
						}
						capturedAccessFunctions.add(fn);
						if (
							instruction.type === "storeCaptured" &&
							instruction.functionIndex === fn.functionIndex
						) {
							capturedStoreOwnerFunctions.add(fn);
						}
						break;
					}
					case "createPrivateNames": {
						environmentReferenceCounts.set(
							instruction.functionIndex,
							(environmentReferenceCounts.get(instruction.functionIndex) ?? 0) + 1,
						);
						break;
					}
				}
			}
		}
		if (hasTypeof && hasEquality && hasString) {
			typeofComparisonFunctions.add(fn);
		}
	}
	return features;
}

const optimizationIndexBuildCounts = {
	typeofComparisons: 0,
	capturedSlots: 0,
};

/** Execute the ordered IR optimization pipeline. */
export function executeIROptimizations(program: IntermediateProgram) {
	// Eliminate provably-redundant temporal-dead-zone checks before the main
	// fixpoint. It needs to see the original `loadLocal`/`storeLocal` form
	// (optLocalsToRegister below rewrites those into `move`s), so it runs once
	// up front against the pristine IR.
	optEliminateRedundantTdzChecks(program);

	const passes: Array<{
		run: (program: IntermediateProgram, features: OptimizationFeatures) => boolean;
		requires?: "call" | "object" | "property";
		refreshFeatures?: boolean;
	}> = [
		{ run: optDropInstructionsAfterJumpsOrReturns },
		{ run: optDropUnreferencedBlocks },
		{ run: optLocalsToRegister },
		{ run: optCopyPropagation },
		{ run: optEliminateRedundantNumericCoercions },
		{ run: optForwardSingleUsePrimitiveResults },
		{ run: optValueNumberIsEmptyChecks },
		// A fused predicate must execute where the original typeof did: moving the
		// observation to its later comparison could see a reassigned source.
		{
			run: (program, features) => {
				optimizationIndexBuildCounts.typeofComparisons +=
					features.typeofComparisonFunctions.size;
				return optFuseTypeofComparisons(program, features.typeofComparisonFunctions);
			},
		},
		// Consume exact primitive/object/callable facts after typeof fusion. A
		// comparison whose operand can only have (or can never have) the requested
		// canonical typeof result becomes a constant boolean; the existing primitive
		// folder then removes any newly constant branch in this same round.
		{
			run: (program, features) =>
				optFoldStaticTypeofComparisons(program, features.typeofComparisonFunctions),
		},
		// Refine the tested value on the true/false successors of a canonical
		// typeof branch. This first path-sensitive slice consumes only stable SSA
		// values (parameters without writes or unique definitions/move aliases), so
		// no kill set or effect model is required yet.
		{
			run: (program, features) =>
				optRefineStaticTypeofBranches(program, features.typeofComparisonFunctions),
		},
		// Fold only primitive operations whose exact JavaScript result can be
		// computed without coercing an object or running user code. Constant jump
		// cleanup then exposes dead blocks to the existing CFG passes.
		{ run: optFoldPrimitiveConstants },
		// Reuse a fresh object-rest result as a leading object-spread target when its
		// identity is otherwise unobserved. This removes the redundant empty result
		// allocation and CopyDataProperties traversal without moving source effects.
		{ run: optFuseObjectRestLeadingSpread, requires: "object" },
		// Preserve partial-escape facts for the inliner cost check below. The final
		// residual annotation is rebuilt after the fixpoint; this early analysis only
		// prevents a hot-loop inline from replacing rare materialization with one heap
		// allocation per iteration.
		{
			run: (program) => {
				annotateStackObjectSites(program);
				return false;
			},
			requires: "object",
		},
		// Rewrite `arr.forEach(cb)` into a guarded inlined loop whose `cb(...)` is a
		// direct call. Runs before optInlineCalls so that direct call is folded in the
		// same fixpoint round → the per-call closure + its captured env are eliminated.
		{ run: optInlineHofCallbacks, requires: "call" },
		// Runs after copy propagation so a call's callee resolves to its function
		// value through the move chain; before scalar replacement (inlining exposes
		// cross-call object flow) and DCE (which drops the now-unused closure's
		// createFunction → no closure/env allocation).
		{ run: optInlineCalls, requires: "call" },
		// Speculative (guarded) inlining of reassignable-global direct calls (script-mode
		// top-level functions). Runs after the static inliner so only genuinely-dynamic
		// callees reach it; its deopt path is a normal call, folded no further.
		{ run: optInlineSpeculative, requires: "call" },
		// Loaded-callee-guarded method inlining: `obj.m()` where m resolves to a small
		// known target set. The loadProperty callee is already proto-resolved; exact
		// function-index guards select an inlined body with this = receiver. Deopt = call.
		{ run: optInlineMethod, requires: "call" },
		// Runs after copy propagation so a record's reads reference its allocation
		// register directly (not a local copy), and before DCE so the freed key
		// constants and unread values are cleaned up the same round.
		{ run: optScalarReplaceObjectLiterals, requires: "object" },
		// The mutable generalization: a non-escaping object that IS written
		// (storeProperty) becomes per-key registers (T7.4). Handled separately from
		// the immutable pass above, which only fires on never-written records.
		{ run: optScalarReplaceMutableObjects, requires: "object" },
		{ run: optValueNumberNumericSubtractions },
		// Empty functions made unreachable by inlining (their createFunction was
		// DCE'd) — reclaims dead bodies and unblocks env elimination below.
		{ run: optEmptyDeadFunctions },
		// After inlining consolidates a closure's captured reads into its definer,
		// internalize single-store immutable slots to direct register access and drop
		// the now-unused env — completing closure+env elimination for capturing
		// closures. Before DCE so the dropped stores / freed closures are cleaned up.
		{
			// Inlining and dead-function cleanup above can move or remove captured
			// accesses, so refresh before using sparse candidates from this round.
			refreshFeatures: true,
			run: (program, features) => {
				const facts = features.capturedSlots;
				if (
					facts.storeOwnerFunctions.size === 0 &&
					facts.environmentFunctions.size === 0
				) {
					return false;
				}
				optimizationIndexBuildCounts.capturedSlots += facts.storeOwnerFunctions.size;
				return optEliminateCapturedSlots(program, facts);
			},
		},
		{ run: optDeadInstructionElimination },
		{ run: optCombineLinearBlocks },
		{ run: optPatchJumpsToDirectJumpBlocks },
	];

	// Run all passes until a full round no longer changes the program. The cap is a safety net
	// against passes that endlessly flip-flop the IR.
	const maxRounds = 20;
	for (let round = 0; round < maxRounds; ++round) {
		let changed = false;
		let features = optimizationFeatures(program);
		for (const pass of passes) {
			if (pass.refreshFeatures) features = optimizationFeatures(program);
			if (pass.requires !== undefined && !features[pass.requires]) continue;
			changed = pass.run(program, features) || changed;
		}

		if (!changed) {
			break;
		}
	}

	// Generic sharing deliberately runs after the transform fixpoint: canonical
	// constant producers remain visible to every specialized fusion first.
	optCommonPrimitiveConstants(program);
	optCopyPropagation(program);
	optDeadInstructionElimination(program);

	// This is intentionally outside the transform fixpoint: it classifies the
	// residual identity-observed objects left after scalar replacement, and keys
	// the proof to the exact allocation instruction before register reuse.
	const residualFeatures = optimizationFeatures(program);
	if (residualFeatures.call && residualFeatures.property)
		annotateDirectArrayPushSites(program);
	if (residualFeatures.call && residualFeatures.property && residualFeatures.object)
		annotateCardinalityOnlyArrayRegions(program);
	if (residualFeatures.object) annotateStackObjectSites(program);
	if (residualFeatures.property) optStaticPropertyKeys(program);
	if (residualFeatures.call && residualFeatures.property)
		annotateDirectStringCharCodeAtSites(program);
	if (residualFeatures.call && residualFeatures.property)
		annotateDirectCollectionSites(program);
	if (residualFeatures.call) annotateDirectCallTargets(program);
	if (residualFeatures.call) optImmediateCallOperands(program);
	optDeadInstructionElimination(program);
	annotateFiniteStringConcats(program);
	annotateNativeNumericFusions(program);
	annotateTerminalYieldSites(program);

	if (debugEnabled) debugIntermediateProgram(program);
}

/**
 * Correctness-preserving development pipeline.
 *
 * Development images need local-slot lowering before VM lowering. A single
 * linear cleanup pass also removes the bulk of redundant moves and dead IR
 * without running a whole-program fixpoint. Shipped binaries continue through
 * the production pipeline above.
 */
export function executeIRDevelopmentOptimizations(program: IntermediateProgram): void {
	// Keep only normalization required by lowering and resumable execution. The
	// production passes below reduce output by about 20%, but on representative
	// dependency graphs their repeated Map/Set scans cost substantially more than
	// the larger development wire costs to lower, serialize, load, and execute.
	optDropInstructionsAfterJumpsOrReturns(program);
	optDropUnreferencedBlocks(program);
	optLocalsToRegister(program);
	annotateTerminalYieldSites(program);

	if (debugEnabled) debugIntermediateProgram(program);
}

function optEliminateRedundantNumericCoercions(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		const reps = inferVirtualReps(fn);
		for (const block of fn.blocks) {
			block.instructions = block.instructions.map((instruction) => {
				if (
					instruction.type !== "unary" ||
					instruction.operator !== "tonumeric" ||
					reps.get(instruction.registers[1]) !== "number"
				) {
					return instruction;
				}
				changed = true;
				return { type: "move", registers: [...instruction.registers] };
			});
		}
	}
	return changed;
}

const RETARGETABLE_PRIMITIVE_PRODUCERS = new Set<IRInstruction["type"]>([
	"createNumber",
	"createF64",
	"createBoolean",
	"createUndefined",
	"createNull",
	"createEmpty",
]);

const NATIVE_NUMERIC_UNARY_OPERATORS = new Set(["-", "+", "~", "increment", "decrement"]);
const NONTHROWING_NATIVE_BINARY_OPERATORS = new Set([
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
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
]);

function optForwardSingleUsePrimitiveResults(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		const reps = inferVirtualReps(fn);
		const registerIndex = buildIRRegisterIndex(fn);
		for (const block of fn.blocks) {
			const next: Array<IRInstruction> = [];
			for (let i = 0; i < block.instructions.length; i++) {
				const producer = block.instructions[i]!;
				const move = block.instructions[i + 1];
				if (
					move?.type !== "move" ||
					!("registers" in producer) ||
					destinationCount(producer) !== 1
				) {
					next.push(producer);
					continue;
				}
				const temporary = producer.registers[0]!;
				const uses = registerIndex.uses.get(temporary) ?? [];
				const nativeUnary =
					producer.type === "unary" &&
					NATIVE_NUMERIC_UNARY_OPERATORS.has(producer.operator) &&
					reps.get(producer.registers[1]) === "number";
				const nativeBinary =
					producer.type === "binary" &&
					NONTHROWING_NATIVE_BINARY_OPERATORS.has(producer.operator) &&
					reps.get(producer.registers[1]) === "number" &&
					reps.get(producer.registers[2]) === "number";
				if (
					move.registers[1] !== temporary ||
					uses.length !== 1 ||
					uses[0]!.instruction !== move ||
					uses[0]!.position !== 1 ||
					(!RETARGETABLE_PRIMITIVE_PRODUCERS.has(producer.type) &&
						!nativeUnary &&
						!nativeBinary)
				) {
					next.push(producer);
					continue;
				}
				producer.registers[0] = move.registers[0];
				next.push(producer);
				i++;
				changed = true;
			}
			block.instructions = next;
		}
	}
	return changed;
}

function primitiveConstantKey(instruction: IRInstruction): string | undefined {
	switch (instruction.type) {
		case "createNumber":
		case "createF64":
			return `${instruction.type}:${Object.is(instruction.value, -0) ? "-0" : String(instruction.value)}`;
		case "createBoolean":
			return `boolean:${instruction.value}`;
		case "createUndefined":
		case "createNull":
		case "createEmpty":
			return instruction.type;
		case "createString":
			return `string:${instruction.stringIndex}`;
		default:
			return undefined;
	}
}

function optValueNumberIsEmptyChecks(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			const available = new Map<string, { result: number; source: number }>();
			block.instructions = block.instructions.map((instruction) => {
				const definition = definedRegister(instruction);
				if (definition !== null) {
					for (const [key, predicate] of available) {
						if (predicate.result === definition || predicate.source === definition) {
							available.delete(key);
						}
					}
				}
				if (instruction.type !== "isEmpty") return instruction;
				const source = instruction.registers[1];
				const key = `empty:${source}`;
				const existing = available.get(key);
				available.set(key, { result: instruction.registers[0], source });
				if (existing === undefined) return instruction;
				changed = true;
				return { type: "move", registers: [instruction.registers[0], existing.result] };
			});
		}
	}
	return changed;
}

function optCommonPrimitiveConstants(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		const definitions = buildIRRegisterIndex(fn).definitions;
		for (const block of fn.blocks) {
			const available = new Map<string, number>();
			block.instructions = block.instructions.map((instruction) => {
				if (instruction.type === "yield" || instruction.type === "await") {
					available.clear();
					return instruction;
				}
				const definition = definedRegister(instruction);
				const key = primitiveConstantKey(instruction);
				if (key === undefined || definition === null) return instruction;
				const existing = available.get(key);
				if (existing === undefined) {
					if (definitions.get(definition)?.length === 1) available.set(key, definition);
					return instruction;
				}
				changed = true;
				return { type: "move", registers: [definition, existing] };
			});
		}
	}
	return changed;
}

function optValueNumberNumericSubtractions(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		const reps = inferVirtualReps(fn);
		for (const block of fn.blocks) {
			const available = new Map<
				string,
				{ result: number; left: number; right: number }
			>();
			block.instructions = block.instructions.map((instruction) => {
				const definition = definedRegister(instruction);
				if (definition !== null) {
					for (const [key, expression] of available) {
						if (
							expression.result === definition ||
							expression.left === definition ||
							expression.right === definition
						) {
							available.delete(key);
						}
					}
				}
				if (
					instruction.type !== "binary" ||
					instruction.operator !== "-" ||
					reps.get(instruction.registers[1]) !== "number" ||
					reps.get(instruction.registers[2]) !== "number"
				) {
					return instruction;
				}
				const key = `${instruction.registers[1]}:${instruction.registers[2]}`;
				const existing = available.get(key);
				available.set(key, {
					result: instruction.registers[0],
					left: instruction.registers[1],
					right: instruction.registers[2],
				});
				if (existing === undefined) return instruction;
				changed = true;
				return { type: "move", registers: [instruction.registers[0], existing.result] };
			});
		}
	}
	return changed;
}

function optFuseObjectRestLeadingSpread(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		const index = buildIRRegisterIndex(fn, { locations: true });
		const drops = new Set<IRInstruction>();
		for (const block of fn.blocks) {
			for (const merge of block.instructions) {
				if (merge.type !== "mergeDataProperties") continue;
				const target = merge.registers[0];
				const source = merge.registers[1];
				const create = index.uniqueDefinitions.get(target);
				const copy = index.uniqueDefinitions.get(source);
				if (create?.type !== "createObject" || copy?.type !== "copyDataProperties") {
					continue;
				}
				const sourceUses = index.uses.get(source) ?? [];
				if (
					sourceUses.length !== 1 ||
					sourceUses[0]!.instruction !== merge ||
					sourceUses[0]!.position !== 1
				) {
					continue;
				}
				const createLocation = index.locations!.get(create)!;
				const mergeLocation = index.locations!.get(merge)!;
				if (
					createLocation.blockIndex !== mergeLocation.blockIndex ||
					createLocation.instructionIndex >= mergeLocation.instructionIndex
				) {
					continue;
				}
				const between = block.instructions.slice(
					createLocation.instructionIndex + 1,
					mergeLocation.instructionIndex,
				);
				if (between.some((instruction) => instruction.type !== "sourcePos")) continue;

				copy.registers[0] = target;
				drops.add(create);
				drops.add(merge);
				changed = true;
			}
		}
		if (drops.size > 0) {
			for (const block of fn.blocks) {
				block.instructions = block.instructions.filter(
					(instruction) => !drops.has(instruction),
				);
			}
		}
	}
	return changed;
}

const NATIVE_NUMERIC_FUSION_OPERATORS = new Set<
	Extract<IRInstruction, { type: "binary" }>["operator"]
>(["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", ">>>"]);
const NATIVE_NUMERIC_FUSION_FINISH_OPERATORS = new Set<
	Extract<IRInstruction, { type: "binary" }>["operator"]
>([...NATIVE_NUMERIC_FUSION_OPERATORS, "<", "<=", ">", ">=", "==", "!=", "===", "!=="]);

/** Mark pairs where a number-producing binary result has exactly one use in a
 * later binary in the same block. The native backend keeps the first numeric
 * result as an f64 while still executing both operations at their original
 * observable positions; non-number operands retain the boxed path. */
export function annotateNativeNumericFusions(program: IntermediateProgram): void {
	let nextId = 0;
	for (const fn of program.functions) {
		if (fn.isGenerator || fn.isAsync) continue;
		const index = buildIRRegisterIndex(fn, { locations: true });
		const participating = new Set<IRInstruction>();
		for (const block of fn.blocks) {
			for (const first of block.instructions) {
				if (
					first.type !== "binary" ||
					!NATIVE_NUMERIC_FUSION_OPERATORS.has(first.operator) ||
					participating.has(first)
				) {
					continue;
				}
				const destination = first.registers[0];
				if (index.uniqueDefinitions.get(destination) !== first) continue;
				const uses = index.uses.get(destination);
				if (uses?.length !== 1) continue;
				const use = uses[0]!;
				const finish = use.instruction;
				if (
					finish.type !== "binary" ||
					finish.nativeFiniteString !== undefined ||
					(use.position !== 1 && use.position !== 2) ||
					!NATIVE_NUMERIC_FUSION_FINISH_OPERATORS.has(finish.operator) ||
					participating.has(finish)
				) {
					continue;
				}
				const firstLocation = index.locations?.get(first);
				const finishLocation = index.locations?.get(finish);
				if (
					firstLocation === undefined ||
					finishLocation === undefined ||
					firstLocation.blockIndex !== finishLocation.blockIndex ||
					firstLocation.instructionIndex >= finishLocation.instructionIndex
				) {
					continue;
				}

				const id = nextId++;
				first.nativeNumericFusion = { role: "start", id };
				finish.nativeNumericFusion = { role: "finish", id, first };
				participating.add(first);
				participating.add(finish);
			}
		}
	}
}

interface FiniteIntegerRange {
	minimum: number;
	maximum: number;
}

const MAX_FINITE_STRING_VALUES = 32;
const MAX_FINITE_STRING_CONSTANTS = 512;
const MAX_FINITE_STRING_CODE_UNITS = 16 * 1024 * 1024;
const MAX_FINITE_STRING_PREFIX_CODE_UNITS = 64;
const MAX_FINITE_STRING_INTEGER = 0x7fff_ffff;

function exactIntegerConstant(
	instruction: IRInstruction | undefined,
): number | undefined {
	if (
		(instruction?.type !== "createNumber" && instruction?.type !== "createF64") ||
		!Number.isSafeInteger(instruction.value)
	) {
		return undefined;
	}
	return instruction.value;
}

const FINITE_CONSTRUCTION_NUMERIC_OPERATORS = new Set([
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

/**
 * Recognize the first deliberately narrow construction region: a fresh `{}` is
 * filled exactly once by a one-block canonical finite-selector loop, remains
 * unobservable until the loop's unique exit, and computes each value with only
 * numeric operations. Native code can guard the stable unknown leaves as
 * Numbers and ask the runtime for a prototype-dependency-backed final shape.
 * The interpreter and every rejected guard keep the original empty-object loop.
 */
function annotateFiniteObjectConstructionsInFunction(fn: IRFunction): void {
	if (
		fn.isGenerator ||
		fn.isAsync ||
		functionUsesWith(fn) ||
		fn.semanticFile.hasDirectEval.size > 0 ||
		fn.blocks.some((block) =>
			block.instructions.some(
				(instruction) =>
					instruction.type === "tryBegin" ||
					instruction.type === "tryEnd" ||
					instruction.type === "catch",
			),
		)
	) {
		return;
	}

	const index = buildIRRegisterIndex(fn, { locations: true });
	const locations = index.locations!;
	const incoming = fn.blocks.map(() => new Set<number>());
	const successors = fn.blocks.map((block, blockIndex) => {
		const result = new Set<number>();
		for (const instruction of block.instructions) {
			if (instruction.type !== "jump" && instruction.type !== "jumpIf") continue;
			for (const target of instruction.blocks) {
				if (target >= 0 && target < fn.blocks.length) {
					result.add(target);
					incoming[target]!.add(blockIndex);
				}
			}
		}
		const last = block.instructions[block.instructions.length - 1];
		if (
			last?.type !== "jump" &&
			last?.type !== "return" &&
			last?.type !== "throw" &&
			blockIndex + 1 < fn.blocks.length
		) {
			result.add(blockIndex + 1);
			incoming[blockIndex + 1]!.add(blockIndex);
		}
		return result;
	});

	for (const block of fn.blocks) {
		for (const store of block.instructions) {
			if (store.type !== "storeProperty" || store.nativeFiniteKey === undefined) {
				continue;
			}
			const finite = store.nativeFiniteKey;
			const storeLocation = locations.get(store);
			const sourceLocation = locations.get(finite.source);
			if (
				storeLocation === undefined ||
				sourceLocation === undefined ||
				storeLocation.blockIndex !== sourceLocation.blockIndex
			) {
				continue;
			}
			const bodyIndex = storeLocation.blockIndex;
			const headerIncoming = [...incoming[bodyIndex]!];
			if (headerIncoming.length !== 1) continue;
			const headerIndex = headerIncoming[0]!;
			const header = fn.blocks[headerIndex]!;
			const ordinal = finite.source.registers[2];
			const branches = header.instructions.filter(
				(instruction) => instruction.type === "jumpIf",
			);
			const exits = header.instructions.filter(
				(instruction) => instruction.type === "jump",
			);
			if (
				branches.length !== 1 ||
				branches[0]!.blocks[0] !== bodyIndex ||
				exits.length !== 1
			) {
				continue;
			}
			const exitIndex = exits[0]!.blocks[0];
			if (
				exitIndex === undefined ||
				incoming[exitIndex]?.size !== 1 ||
				!incoming[exitIndex].has(headerIndex)
			) {
				continue;
			}

			const comparison = index.uniqueDefinitions.get(branches[0]!.registers[0]);
			if (
				comparison?.type !== "binary" ||
				comparison.operator !== "<" ||
				comparison.registers[1] !== ordinal
			) {
				continue;
			}
			const boundDefinition = index.uniqueDefinitions.get(comparison.registers[2]);
			if (
				header.instructions.some(
					(instruction) =>
						instruction.type !== "sourcePos" &&
						instruction !== comparison &&
						instruction !== boundDefinition &&
						instruction !== branches[0] &&
						instruction !== exits[0],
				)
			) {
				continue;
			}
			const bound = exactIntegerConstant(boundDefinition);
			const ordinalDefinitions = index.definitions.get(ordinal) ?? [];
			const starts = ordinalDefinitions.filter(
				({ instruction }) =>
					instruction.type === "createNumber" || instruction.type === "createF64",
			);
			if (bound === undefined || starts.length !== 1) continue;
			const start = exactIntegerConstant(starts[0]!.instruction);
			const startLocation = locations.get(starts[0]!.instruction);
			if (
				start === undefined ||
				start !== finite.minimum ||
				bound - start !== finite.stringIndices.length ||
				startLocation === undefined
			) {
				continue;
			}
			const predecessorIndex = startLocation.blockIndex;
			if (
				incoming[headerIndex]!.size !== 2 ||
				!incoming[headerIndex]!.has(predecessorIndex) ||
				!incoming[headerIndex]!.has(bodyIndex)
			) {
				continue;
			}
			const predecessorControls = fn.blocks[predecessorIndex]!.instructions.filter(
				(instruction) => instruction.type === "jump" || instruction.type === "jumpIf",
			);
			const bodyControls = fn.blocks[bodyIndex]!.instructions.filter(
				(instruction) =>
					instruction.type === "jump" ||
					instruction.type === "jumpIf" ||
					instruction.type === "return" ||
					instruction.type === "throw",
			);
			if (
				predecessorControls.length !== 1 ||
				predecessorControls[0]!.type !== "jump" ||
				predecessorControls[0]!.blocks[0] !== headerIndex ||
				bodyControls.length !== 1 ||
				bodyControls[0]!.type !== "jump" ||
				bodyControls[0]!.blocks[0] !== headerIndex
			) {
				continue;
			}

			const increments = ordinalDefinitions.filter(
				({ instruction }) =>
					instruction.type === "unary" &&
					instruction.operator === "increment" &&
					instruction.registers[0] === ordinal &&
					instruction.registers[1] === ordinal,
			);
			if (ordinalDefinitions.length !== 2 || increments.length !== 1) continue;
			const incrementLocation = locations.get(increments[0]!.instruction);
			if (
				incrementLocation?.blockIndex !== bodyIndex ||
				incrementLocation.instructionIndex <= storeLocation.instructionIndex
			) {
				continue;
			}

			// Follow single-definition aliases back to the fresh allocation.
			let rootRegister = store.registers[0];
			const backwards = new Set<number>();
			while (!backwards.has(rootRegister)) {
				backwards.add(rootRegister);
				const definition = index.uniqueDefinitions.get(rootRegister);
				if (definition?.type !== "move") break;
				rootRegister = definition.registers[1];
			}
			const allocation = index.uniqueDefinitions.get(rootRegister);
			if (
				allocation?.type !== "createObject" ||
				allocation.stackObject ||
				allocation.nativeFiniteConstruction !== undefined
			) {
				continue;
			}
			const allocationLocation = locations.get(allocation);
			if (allocationLocation?.blockIndex !== predecessorIndex) continue;

			const afterExit = new Set<number>();
			const reach = [exitIndex];
			while (reach.length > 0) {
				const current = reach.pop()!;
				if (afterExit.has(current)) continue;
				afterExit.add(current);
				for (const successor of successors[current]!) reach.push(successor);
			}

			// Build the complete alias closure and ensure the object cannot be
			// observed before the loop has completed.
			const aliases = new Set<number>([allocation.registers[0]]);
			const aliasWorklist = [allocation.registers[0]];
			let valid = true;
			while (valid && aliasWorklist.length > 0) {
				const alias = aliasWorklist.pop()!;
				for (const use of index.uses.get(alias) ?? []) {
					if (use.instruction.type === "move" && use.position === 1) {
						const target = use.instruction.registers[0];
						if (index.uniqueDefinitions.get(target) !== use.instruction) {
							valid = false;
							break;
						}
						if (!aliases.has(target)) {
							aliases.add(target);
							aliasWorklist.push(target);
						}
						continue;
					}
					if (use.instruction === store && use.position === 0) continue;
					const useLocation = locations.get(use.instruction);
					if (useLocation === undefined || !afterExit.has(useLocation.blockIndex)) {
						valid = false;
						break;
					}
				}
			}
			if (!valid || !aliases.has(store.registers[0])) continue;

			const dependencyInstructions = new Set<IRInstruction>();
			const guards = new Set<number>();
			const numericMemo = new Map<number, boolean>();
			const proveNumeric = (register: number): boolean => {
				if (register === ordinal) return true;
				const memo = numericMemo.get(register);
				if (memo !== undefined) return memo;
				numericMemo.set(register, false);
				const definition = index.uniqueDefinitions.get(register);
				const definitionLocation =
					definition === undefined ? undefined : locations.get(definition);
				const availableBeforeAllocation =
					definition === undefined ||
					(definitionLocation?.blockIndex === predecessorIndex &&
						definitionLocation.instructionIndex < allocationLocation.instructionIndex);
				if (availableBeforeAllocation) {
					if ((index.definitions.get(register)?.length ?? 0) <= 1) {
						guards.add(register);
						numericMemo.set(register, true);
						return true;
					}
					return false;
				}
				if (definitionLocation?.blockIndex !== bodyIndex || definition === undefined) {
					return false;
				}
				dependencyInstructions.add(definition);
				let result = false;
				if (definition.type === "createNumber" || definition.type === "createF64") {
					result = true;
				} else if (definition.type === "move") {
					result = proveNumeric(definition.registers[1]);
				} else if (
					definition.type === "unary" &&
					(definition.operator === "increment" ||
						definition.operator === "decrement" ||
						definition.operator === "+" ||
						definition.operator === "-")
				) {
					result = proveNumeric(definition.registers[1]);
				} else if (
					definition.type === "binary" &&
					FINITE_CONSTRUCTION_NUMERIC_OPERATORS.has(definition.operator)
				) {
					result =
						proveNumeric(definition.registers[1]) &&
						proveNumeric(definition.registers[2]);
				}
				numericMemo.set(register, result);
				return result;
			};
			if (!proveNumeric(store.registers[2]) || guards.size > 4) continue;

			dependencyInstructions.add(finite.source);
			const prefix = index.uniqueDefinitions.get(finite.source.registers[1]);
			if (prefix !== undefined) dependencyInstructions.add(prefix);
			const bodyInstructions = fn.blocks[bodyIndex]!.instructions;
			if (
				bodyInstructions.some((instruction) => {
					if (instruction.type === "sourcePos") return false;
					if (instruction === store || instruction === increments[0]!.instruction) {
						return false;
					}
					if (instruction === bodyControls[0]) return false;
					return !dependencyInstructions.has(instruction);
				})
			) {
				continue;
			}

			const harmlessBeforeLoop = new Set([
				"sourcePos",
				"move",
				"createNumber",
				"createF64",
				"createBoolean",
				"createString",
				"createUndefined",
				"createNull",
				"createEmpty",
				"jump",
			]);
			if (
				fn.blocks[predecessorIndex]!.instructions.slice(
					allocationLocation.instructionIndex + 1,
				).some((instruction) => !harmlessBeforeLoop.has(instruction.type))
			) {
				continue;
			}

			allocation.registers.push(...[...guards].sort((a, b) => a - b));
			allocation.nativeFiniteConstruction = {
				source: store,
				keyStringIndices: [...finite.stringIndices],
			};
		}
	}
}

/**
 * Prove the canonical compiler loop-counter shape and attach finite string
 * universes to `literal + integer` operations in the true body block. The proof
 * is intentionally narrow: one non-negative integer initializer, only self
 * increments thereafter, an integer `< bound` header, and no alternate entry to
 * that header. Derived `%` and small-mask `&` values remain finite as well.
 *
 * The result is native-code metadata, not a semantic rewrite. The interpreter
 * continues to execute ordinary `+`; compiled output can select an immortal
 * precomputed string because both operands and the complete value range are
 * statically proven. Any shape outside this exact loop form remains generic.
 */
export function annotateFiniteStringConcats(program: IntermediateProgram): void {
	const initialStringCount = program.stringConstants.length;
	for (const fn of program.functions) {
		if (fn.isGenerator || fn.isAsync) continue;
		const index = buildIRRegisterIndex(fn, { locations: true });
		const { backEdges } = findBackEdges(fn);
		if (backEdges.length === 0) continue;

		const incoming = fn.blocks.map(() => new Set<number>());
		for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
			for (const instruction of fn.blocks[blockIndex]!.instructions) {
				if (instruction.type !== "jump" && instruction.type !== "jumpIf") continue;
				for (const target of instruction.blocks) incoming[target]?.add(blockIndex);
			}
		}

		const entryRanges = new Map<number, Map<number, FiniteIntegerRange>>();
		for (let header = 0; header < fn.blocks.length; header++) {
			if (header === 0) continue;
			const loopBackEdges = backEdges.filter((edge) => edge.to === header);
			if (loopBackEdges.length === 0) continue;
			const instructions = fn.blocks[header]!.instructions;
			for (const branch of instructions) {
				if (branch.type !== "jumpIf" || branch.blocks.length !== 1) continue;
				const comparison = index.uniqueDefinitions.get(branch.registers[0]);
				if (comparison?.type !== "binary" || comparison.operator !== "<") continue;
				const counter = comparison.registers[1];
				const bound = exactIntegerConstant(
					index.uniqueDefinitions.get(comparison.registers[2]),
				);
				if (bound === undefined) continue;

				const definitions = index.definitions.get(counter) ?? [];
				const starts = definitions.filter(
					({ instruction }) =>
						instruction.type === "createNumber" || instruction.type === "createF64",
				);
				if (starts.length !== 1) continue;
				const start = exactIntegerConstant(starts[0]!.instruction);
				if (
					start === undefined ||
					start < 0 ||
					start > MAX_FINITE_STRING_INTEGER ||
					bound <= start ||
					bound - 1 > MAX_FINITE_STRING_INTEGER
				) {
					continue;
				}
				if (bound - start > MAX_FINITE_STRING_VALUES) continue;
				if (
					definitions.some(({ instruction }) => {
						if (instruction === starts[0]!.instruction) return false;
						return !(
							instruction.type === "unary" &&
							instruction.operator === "increment" &&
							instruction.registers[0] === counter &&
							instruction.registers[1] === counter
						);
					})
				) {
					continue;
				}

				const startLocation = index.locations?.get(starts[0]!.instruction);
				if (startLocation === undefined) continue;
				const predecessor = startLocation.blockIndex;
				const trueBackEdges = loopBackEdges.filter((edge) => edge.from !== predecessor);
				if (trueBackEdges.length === 0) continue;
				const allowedIncoming = new Set<number>([
					predecessor,
					...trueBackEdges.map((edge) => edge.from),
				]);
				const actualIncoming = incoming[header]!;
				if (
					actualIncoming.size !== allowedIncoming.size ||
					[...actualIncoming].some((blockIndex) => !allowedIncoming.has(blockIndex))
				) {
					continue;
				}
				if (
					!fn.blocks[predecessor]!.instructions.some(
						(instruction) =>
							instruction.type === "jump" && instruction.blocks.includes(header),
					)
				) {
					continue;
				}

				const target = branch.blocks[0];
				if (incoming[target]?.size !== 1 || !incoming[target].has(header)) continue;
				const ranges = entryRanges.get(target) ?? new Map<number, FiniteIntegerRange>();
				const existing = ranges.get(counter);
				const proven = { minimum: start, maximum: bound - 1 };
				if (existing === undefined) {
					ranges.set(counter, proven);
				} else {
					ranges.set(counter, {
						minimum: Math.max(existing.minimum, proven.minimum),
						maximum: Math.min(existing.maximum, proven.maximum),
					});
				}
				entryRanges.set(target, ranges);
			}
		}

		for (const [blockIndex, initialRanges] of entryRanges) {
			const ranges = new Map(initialRanges);
			for (const instruction of fn.blocks[blockIndex]!.instructions) {
				if (instruction.type === "binary" && instruction.operator === "+") {
					const leftDefinition = index.uniqueDefinitions.get(instruction.registers[1]);
					const right = instruction.registers[2];
					const range = ranges.get(right);
					if (
						leftDefinition?.type === "createString" &&
						program.stringConstants[leftDefinition.stringIndex]!.length <=
							MAX_FINITE_STRING_PREFIX_CODE_UNITS &&
						range !== undefined &&
						range.minimum <= range.maximum &&
						range.maximum - range.minimum + 1 <= MAX_FINITE_STRING_VALUES
					) {
						const prefix = decodeStringConstant(program, leftDefinition.stringIndex);
						const values = Array.from(
							{ length: range.maximum - range.minimum + 1 },
							(_, offset) => prefix + String(range.minimum + offset),
						);
						if (values.some((value) => value.length > MAX_FINITE_STRING_CODE_UNITS)) {
							continue;
						}
						const newCount = values.filter(
							(value) => !program.stringConstantToIndex.has(value),
						).length;
						if (
							program.stringConstants.length - initialStringCount + newCount <=
							MAX_FINITE_STRING_CONSTANTS
						) {
							const finite = {
								minimum: range.minimum,
								stringIndices: values.map((value) =>
									getOrCreateStringConstant(program, value),
								),
							};
							instruction.nativeFiniteString = finite;
							if (finite.stringIndices.length <= 8) {
								for (const use of index.uses.get(instruction.registers[0]) ?? []) {
									const sourceLocation = index.locations?.get(instruction);
									const useLocation = index.locations?.get(use.instruction);
									const ordinalUnchanged =
										sourceLocation !== undefined &&
										useLocation !== undefined &&
										sourceLocation.blockIndex === useLocation.blockIndex &&
										sourceLocation.instructionIndex < useLocation.instructionIndex &&
										!fn.blocks[sourceLocation.blockIndex]!.instructions.slice(
											sourceLocation.instructionIndex + 1,
											useLocation.instructionIndex,
										).some((between) => definedRegisters(between).includes(right));
									if (
										ordinalUnchanged &&
										((use.position === 2 && use.instruction.type === "loadProperty") ||
											(use.position === 1 && use.instruction.type === "storeProperty"))
									) {
										use.instruction.nativeFiniteKey = {
											minimum: finite.minimum,
											source: instruction,
											stringIndices: [...finite.stringIndices],
										};
									}
								}
							}
						}
					}
				}

				if (!("registers" in instruction)) continue;
				for (const destination of definedRegisters(instruction))
					ranges.delete(destination);
				const destination = definedRegister(instruction);
				if (destination === null) continue;
				let produced: FiniteIntegerRange | undefined;
				switch (instruction.type) {
					case "createNumber":
					case "createF64":
						if (Number.isSafeInteger(instruction.value)) {
							produced = { minimum: instruction.value, maximum: instruction.value };
						}
						break;
					case "move":
						produced = ranges.get(instruction.registers[1]);
						break;
					case "unary": {
						const source = ranges.get(instruction.registers[1]);
						if (source !== undefined && instruction.operator === "increment") {
							produced = {
								minimum: source.minimum + 1,
								maximum: source.maximum + 1,
							};
						} else if (source !== undefined && instruction.operator === "decrement") {
							produced = {
								minimum: source.minimum - 1,
								maximum: source.maximum - 1,
							};
						}
						break;
					}
					case "binary": {
						const left = ranges.get(instruction.registers[1]);
						const constant = exactIntegerConstant(
							index.uniqueDefinitions.get(instruction.registers[2]),
						);
						if (
							instruction.operator === "%" &&
							left !== undefined &&
							left.minimum >= 0 &&
							constant !== undefined &&
							constant > 0
						) {
							produced = {
								minimum: 0,
								maximum: Math.min(left.maximum, constant - 1),
							};
						} else if (
							instruction.operator === "&" &&
							constant !== undefined &&
							constant >= 0 &&
							constant < MAX_FINITE_STRING_VALUES
						) {
							produced = { minimum: 0, maximum: constant };
						}
						break;
					}
				}
				if (
					produced !== undefined &&
					Number.isSafeInteger(produced.minimum) &&
					Number.isSafeInteger(produced.maximum)
				) {
					ranges.set(destination, produced);
				}
			}
		}
		annotateFiniteObjectConstructionsInFunction(fn);
	}
}

/**
 * Mark only the canonical tail-yield shape emitted by compileYieldExpression.
 * The exact shape is the proof: throw(value), return(value), and an ordinary
 * next path that returns undefined without executing code. Any exception region,
 * extra register use, async/delegated yield, or cleanup changes that shape and is
 * conservatively rejected.
 */
export function annotateTerminalYieldSites(program: IntermediateProgram): void {
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type === "yield") delete instruction.terminal;
			}
		}
		if (!fn.isGenerator || fn.isAsync) continue;
		if (
			fn.blocks.some((block) =>
				block.instructions.some(
					(instruction) =>
						instruction.type === "tryBegin" ||
						instruction.type === "tryEnd" ||
						instruction.type === "catch",
				),
			)
		) {
			continue;
		}

		const registerIndex = buildIRRegisterIndex(fn);
		for (const block of fn.blocks) {
			for (let index = 0; index < block.instructions.length; index++) {
				const yieldInstruction = block.instructions[index];
				if (yieldInstruction?.type !== "yield") continue;
				const [valueDst, modeDst] = yieldInstruction.registers;
				const dispatch = block.instructions.slice(index + 1);
				if (dispatch.length !== 7) continue;
				const [
					throwConst,
					throwCompare,
					throwJump,
					returnConst,
					returnCompare,
					returnJump,
					nextJump,
				] = dispatch;
				if (
					throwConst?.type !== "createNumber" ||
					throwConst.value !== 1 ||
					throwCompare?.type !== "binary" ||
					throwCompare.operator !== "===" ||
					throwCompare.registers[1] !== modeDst ||
					throwCompare.registers[2] !== throwConst.registers[0] ||
					throwJump?.type !== "jumpIf" ||
					throwJump.registers[0] !== throwCompare.registers[0] ||
					returnConst?.type !== "createNumber" ||
					returnConst.value !== 2 ||
					returnCompare?.type !== "binary" ||
					returnCompare.operator !== "===" ||
					returnCompare.registers[1] !== modeDst ||
					returnCompare.registers[2] !== returnConst.registers[0] ||
					returnJump?.type !== "jumpIf" ||
					returnJump.registers[0] !== returnCompare.registers[0] ||
					nextJump?.type !== "jump"
				) {
					continue;
				}

				const throwBlock = fn.blocks[throwJump.blocks[0]];
				const returnBlock = fn.blocks[returnJump.blocks[0]];
				const nextBlock = fn.blocks[nextJump.blocks[0]];
				const nextInstructions = nextBlock?.instructions.filter(
					(instruction) => instruction.type !== "sourcePos",
				);
				if (
					throwBlock?.instructions.length !== 1 ||
					throwBlock.instructions[0]?.type !== "throw" ||
					throwBlock.instructions[0].registers[0] !== valueDst ||
					returnBlock?.instructions.length !== 1 ||
					returnBlock.instructions[0]?.type !== "return" ||
					returnBlock.instructions[0].registers[0] !== valueDst ||
					nextInstructions?.length !== 2 ||
					nextInstructions[0]?.type !== "createUndefined" ||
					nextInstructions[1]?.type !== "return" ||
					nextInstructions[1].registers[0] !== nextInstructions[0].registers[0]
				) {
					continue;
				}

				const valueUses = registerIndex.uses.get(valueDst) ?? [];
				const modeUses = registerIndex.uses.get(modeDst) ?? [];
				if (
					valueUses.length !== 2 ||
					!valueUses.every(
						(use) =>
							use.instruction === throwBlock.instructions[0] ||
							use.instruction === returnBlock.instructions[0],
					) ||
					modeUses.length !== 2 ||
					!modeUses.every(
						(use) =>
							use.instruction === throwCompare || use.instruction === returnCompare,
					)
				) {
					continue;
				}

				yieldInstruction.terminal = true;
			}
		}
	}
}

const MAX_IMMEDIATE_I28 = 0x07ff_ffff;
const MIN_IMMEDIATE_I28 = -0x0800_0000;
const MAX_IMMEDIATE_CONSTANT_INDEX = 0x0fff_ffff;

function immediateValue(
	instruction: IRInstruction | undefined,
): IRImmediateValue | undefined {
	if (instruction === undefined) return undefined;
	switch (instruction.type) {
		case "createUndefined":
			return { kind: "undefined" };
		case "createNull":
			return { kind: "null" };
		case "createBoolean":
			return { kind: "boolean", value: instruction.value };
		case "createNumber":
		case "createF64":
			return Number.isInteger(instruction.value) &&
				!Object.is(instruction.value, -0) &&
				instruction.value >= MIN_IMMEDIATE_I28 &&
				instruction.value <= MAX_IMMEDIATE_I28
				? { kind: "number", value: instruction.value }
				: undefined;
		case "createString":
			return instruction.stringIndex <= MAX_IMMEDIATE_CONSTANT_INDEX
				? { kind: "string", index: instruction.stringIndex }
				: undefined;
		default:
			return undefined;
	}
}

/**
 * Embed exact scalar/string constants directly in ordinary call and construct
 * operands. The parallel register entry becomes -1, so existing liveness and
 * allocation code naturally ignores it and DCE removes an otherwise-unused
 * producer. Multiply-defined registers are excluded because their value is
 * control-flow dependent.
 */
function optImmediateCallOperands(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		const definitions = buildIRRegisterIndex(fn).uniqueDefinitions;
		const replacements: Array<{
			instruction: Extract<IRInstruction, { type: "call" | "construct" }>;
			position: number;
			value: IRImmediateValue;
		}> = [];

		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type !== "call" && instruction.type !== "construct") continue;
				for (let i = 1; i < instruction.registers.length; i++) {
					const register = instruction.registers[i]!;
					const value = immediateValue(definitions.get(register));
					if (value === undefined) continue;
					replacements.push({ instruction, position: i, value });
				}
			}
		}
		for (const { instruction, position, value } of replacements) {
			instruction.immediateValues ??= [];
			instruction.immediateValues[position] = value;
			instruction.registers[position] = -1;
			changed = true;
		}
	}
	return changed;
}

/**
 * Mark a bounded fresh array whose complete observable contract is one direct
 * `push(record)` site plus post-loop `length` or indexed-own-field reads. Native
 * code may keep only rooted row-major record history and materialize the real
 * array/records if a live protector, index, or `%Array.prototype.push%` guard
 * rejects. The interpreter ignores the annotations and executes the original
 * array program.
 */
function annotateCardinalityOnlyArrayRegions(program: IntermediateProgram): void {
	for (const fn of program.functions) {
		if (
			fn.isGenerator ||
			fn.isAsync ||
			functionUsesWith(fn) ||
			fn.semanticFile.hasDirectEval.size > 0
		) {
			continue;
		}
		const registerIndex = buildIRRegisterIndex(fn, { locations: true });
		const locations = registerIndex.locations!;
		const definitions = registerIndex.uniqueDefinitions;
		const usesOf = registerIndex.uses;
		const incoming = fn.blocks.map(() => new Set<number>());
		const successors = fn.blocks.map((block, blockIndex) => {
			const result = new Set<number>();
			for (const instruction of block.instructions) {
				if (instruction.type !== "jump" && instruction.type !== "jumpIf") continue;
				for (const target of instruction.blocks) {
					if (target >= 0 && target < fn.blocks.length) {
						result.add(target);
						incoming[target]!.add(blockIndex);
					}
				}
			}
			const last = block.instructions[block.instructions.length - 1];
			if (
				last?.type !== "jump" &&
				last?.type !== "return" &&
				last?.type !== "throw" &&
				blockIndex + 1 < fn.blocks.length
			) {
				result.add(blockIndex + 1);
				incoming[blockIndex + 1]!.add(blockIndex);
			}
			return result;
		});
		let nextRegionId = 0;

		for (const block of fn.blocks) {
			for (const allocation of block.instructions) {
				if (
					allocation.type !== "createArray" ||
					allocation.length !== 0 ||
					definitions.get(allocation.registers[0]) !== allocation
				) {
					continue;
				}

				const aliases = new Set<number>([allocation.registers[0]]);
				const worklist = [allocation.registers[0]];
				const pushLoads: Array<Extract<IRInstruction, { type: "loadProperty" }>> = [];
				const lengthLoads: Array<Extract<IRInstruction, { type: "loadProperty" }>> = [];
				const indexedLoads: Array<{
					element: Extract<IRInstruction, { type: "loadProperty" }>;
					field: Extract<IRInstruction, { type: "loadProperty" }>;
					fieldName: string;
				}> = [];
				const pushCalls = new Set<Extract<IRInstruction, { type: "call" }>>();
				let safe = true;
				while (safe && worklist.length > 0) {
					const alias = worklist.pop()!;
					for (const use of usesOf.get(alias) ?? []) {
						if (use.instruction.type === "move" && use.position === 1) {
							const target = use.instruction.registers[0];
							if (definitions.get(target) !== use.instruction) {
								safe = false;
								break;
							}
							if (!aliases.has(target)) {
								aliases.add(target);
								worklist.push(target);
							}
							continue;
						}
						if (
							use.instruction.type === "call" &&
							use.position === 2 &&
							use.instruction.directArrayPush &&
							use.instruction.registers.length === 4
						) {
							pushCalls.add(use.instruction);
							continue;
						}
						if (use.instruction.type !== "loadProperty" || use.position !== 1) {
							safe = false;
							break;
						}
						const key = definitions.get(use.instruction.registers[2]);
						if (key?.type !== "createString") {
							const resultUses = usesOf.get(use.instruction.registers[0]) ?? [];
							if (
								resultUses.length !== 1 ||
								resultUses[0]!.position !== 1 ||
								resultUses[0]!.instruction.type !== "loadProperty"
							) {
								safe = false;
								break;
							}
							const field = resultUses[0]!.instruction;
							const fieldKey = definitions.get(field.registers[2]);
							const elementLocation = locations.get(use.instruction);
							const fieldLocation = locations.get(field);
							if (
								fieldKey?.type !== "createString" ||
								elementLocation === undefined ||
								fieldLocation === undefined ||
								elementLocation.blockIndex !== fieldLocation.blockIndex ||
								elementLocation.instructionIndex >= fieldLocation.instructionIndex
							) {
								safe = false;
								break;
							}
							const intervening = fn.blocks[
								elementLocation.blockIndex
							]!.instructions.slice(
								elementLocation.instructionIndex + 1,
								fieldLocation.instructionIndex,
							);
							if (
								intervening.some(
									(instruction) =>
										instruction.type !== "sourcePos" &&
										instruction.type !== "createString",
								)
							) {
								safe = false;
								break;
							}
							indexedLoads.push({
								element: use.instruction,
								field,
								fieldName: decodeStringConstant(program, fieldKey.stringIndex),
							});
							continue;
						}
						const name = decodeStringConstant(program, key.stringIndex);
						if (name === "length") {
							lengthLoads.push(use.instruction);
							continue;
						}
						if (name !== "push") {
							safe = false;
							break;
						}
						const calleeUses = usesOf.get(use.instruction.registers[0]) ?? [];
						if (
							calleeUses.length !== 1 ||
							calleeUses[0]!.position !== 1 ||
							calleeUses[0]!.instruction.type !== "call"
						) {
							safe = false;
							break;
						}
						const call = calleeUses[0]!.instruction;
						if (
							!call.directArrayPush ||
							call.registers.length !== 4 ||
							!aliases.has(call.registers[2]) ||
							call.registers[3]! < 0
						) {
							safe = false;
							break;
						}
						pushLoads.push(use.instruction);
						pushCalls.add(call);
					}
				}
				if (
					!safe ||
					pushCalls.size !== 1 ||
					(lengthLoads.length === 0 && indexedLoads.length === 0) ||
					indexedLoads.length > 1
				)
					continue;
				const pushCall = [...pushCalls][0]!;
				const constructionReceiverRegisters = new Set<number>([
					pushCall.registers[2],
					...pushLoads.map((load) => load.registers[1]),
				]);
				if (constructionReceiverRegisters.size !== 1) continue;
				const constructionReceiver = [...constructionReceiverRegisters][0]!;
				const callLocation = locations.get(pushCall);
				if (callLocation === undefined) continue;
				const bodyIndex = callLocation.blockIndex;
				const bodyControls = fn.blocks[bodyIndex]!.instructions.filter(
					(instruction) =>
						instruction.type === "jump" ||
						instruction.type === "jumpIf" ||
						instruction.type === "return" ||
						instruction.type === "throw",
				);
				if (bodyControls.length !== 1 || bodyControls[0]!.type !== "jump") continue;
				const headerIndex = bodyControls[0]!.blocks[0];
				if (
					headerIndex === undefined ||
					incoming[bodyIndex]!.size !== 1 ||
					!incoming[bodyIndex]!.has(headerIndex)
				) {
					continue;
				}
				const header = fn.blocks[headerIndex]!;
				const branches = header.instructions.filter(
					(instruction) => instruction.type === "jumpIf",
				);
				const exits = header.instructions.filter(
					(instruction) => instruction.type === "jump",
				);
				if (
					branches.length !== 1 ||
					branches[0]!.blocks[0] !== bodyIndex ||
					exits.length !== 1
				) {
					continue;
				}
				const comparison = definitions.get(branches[0]!.registers[0]);
				if (comparison?.type !== "binary" || comparison.operator !== "<") continue;
				const counter = comparison.registers[1];
				const bound = exactIntegerConstant(definitions.get(comparison.registers[2]));
				const counterDefinitions = registerIndex.definitions.get(counter) ?? [];
				const starts = counterDefinitions.filter(
					({ instruction }) =>
						instruction.type === "createNumber" || instruction.type === "createF64",
				);
				const increments = counterDefinitions.filter(
					({ instruction }) =>
						instruction.type === "unary" &&
						instruction.operator === "increment" &&
						instruction.registers[0] === counter &&
						instruction.registers[1] === counter,
				);
				if (
					bound === undefined ||
					starts.length !== 1 ||
					increments.length !== 1 ||
					counterDefinitions.length !== 2
				) {
					continue;
				}
				const start = exactIntegerConstant(starts[0]!.instruction);
				const startLocation = locations.get(starts[0]!.instruction);
				const allocationLocation = locations.get(allocation);
				if (
					start === undefined ||
					start < 0 ||
					bound <= start ||
					bound - start > 32 ||
					startLocation === undefined ||
					allocationLocation === undefined ||
					startLocation.blockIndex !== allocationLocation.blockIndex ||
					allocationLocation.instructionIndex >= startLocation.instructionIndex ||
					incoming[headerIndex]!.size !== 2 ||
					!incoming[headerIndex]!.has(startLocation.blockIndex) ||
					!incoming[headerIndex]!.has(bodyIndex)
				) {
					continue;
				}
				const exitIndex = exits[0]!.blocks[0];
				if (exitIndex === undefined) continue;
				const afterExit = new Set<number>();
				const reach = [exitIndex];
				while (reach.length > 0) {
					const current = reach.pop()!;
					if (afterExit.has(current)) continue;
					afterExit.add(current);
					for (const successor of successors[current]!) reach.push(successor);
				}
				const consumerReceivers = [
					...lengthLoads.map((load) => load.registers[1]),
					...indexedLoads.map(({ element }) => element.registers[1]),
				];
				if (
					consumerReceivers.some((register) => {
						if (register === constructionReceiver) return false;
						const definition = definitions.get(register);
						const location =
							definition === undefined ? undefined : locations.get(definition);
						return (
							definition?.type !== "move" ||
							location === undefined ||
							location.blockIndex !== exitIndex
						);
					})
				)
					continue;
				if (
					lengthLoads.some((load) => {
						const location = locations.get(load);
						return location === undefined || !afterExit.has(location.blockIndex);
					}) ||
					indexedLoads.some(({ element, field }) => {
						const elementLocation = locations.get(element);
						const fieldLocation = locations.get(field);
						return (
							elementLocation === undefined ||
							fieldLocation === undefined ||
							!afterExit.has(elementLocation.blockIndex) ||
							!afterExit.has(fieldLocation.blockIndex)
						);
					}) ||
					pushLoads.some((load) => locations.get(load)?.blockIndex !== bodyIndex)
				) {
					continue;
				}

				let elementRegister = pushCall.registers[3]!;
				const seenElements = new Set<number>();
				while (!seenElements.has(elementRegister)) {
					seenElements.add(elementRegister);
					const definition = definitions.get(elementRegister);
					if (definition?.type !== "move") break;
					elementRegister = definition.registers[1];
				}
				const element = definitions.get(elementRegister);
				if (
					element?.type !== "createObjectShaped" ||
					pushCall.registers[3] !== element.registers[0] ||
					element.keyStringIndices.length === 0 ||
					element.keyStringIndices.length > 8 ||
					locations.get(element)?.blockIndex !== bodyIndex ||
					(usesOf.get(element.registers[0]) ?? []).some(
						({ instruction }) =>
							instruction.type === "move" || instruction.type === "storeProperty",
					)
				) {
					continue;
				}
				const indexedFieldSlots = indexedLoads.map(({ fieldName }) =>
					element.keyStringIndices.findIndex(
						(index) => decodeStringConstant(program, index) === fieldName,
					),
				);
				if (indexedFieldSlots.some((slot) => slot < 0)) continue;

				allocation.nativeCardinalityRegion = {
					id: nextRegionId++,
					maximumLength: bound - start,
				};
				for (const load of pushLoads) {
					load.nativeCardinalityAccess = { role: "push", allocation };
				}
				for (const load of lengthLoads) {
					load.nativeCardinalityAccess = { role: "length", allocation };
				}
				for (let index = 0; index < indexedLoads.length; index++) {
					indexedLoads[index]!.element.nativeCardinalityAccess = {
						role: "element",
						allocation,
					};
					indexedLoads[index]!.field.nativeCardinalityAccess = {
						role: "field",
						allocation,
						fieldSlot: indexedFieldSlots[index],
					};
				}
				pushCall.nativeCardinalityPush = { allocation };
			}
		}
	}
}

/**
 * Fold constant-string property keys into dedicated operations after all passes
 * that reason about the generic load/store shape have finished. DCE then removes
 * key-producing createString instructions that have no other consumers.
 */
function optStaticPropertyKeys(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		const definitions = buildIRRegisterIndex(fn).uniqueDefinitions;
		const replacements: Array<{
			block: IRFunction["blocks"][number];
			index: number;
			instruction: IRInstruction;
		}> = [];

		for (const block of fn.blocks) {
			for (let i = 0; i < block.instructions.length; i++) {
				const instruction = block.instructions[i]!;
				if (instruction.type !== "loadProperty" && instruction.type !== "storeProperty") {
					continue;
				}
				const keyPosition = instruction.type === "loadProperty" ? 2 : 1;
				const keyRegister = instruction.registers[keyPosition];
				const key = definitions.get(keyRegister);
				if (key?.type !== "createString") continue;
				const replacement: IRInstruction =
					instruction.type === "loadProperty"
						? {
								type: "loadPropertyStatic",
								registers: [instruction.registers[0], instruction.registers[1]],
								stringIndex: key.stringIndex,
								stackObjectSiteId: instruction.stackObjectSiteId,
								stackObjectSlot: instruction.stackObjectSlot,
								stackObjectInheritedSiteId: instruction.stackObjectInheritedSiteId,
								nativeCardinalityAccess: instruction.nativeCardinalityAccess,
							}
						: {
								type: "storePropertyStatic",
								registers: [instruction.registers[0], instruction.registers[2]],
								stringIndex: key.stringIndex,
								stackObjectSiteId: instruction.stackObjectSiteId,
								stackObjectSlot: instruction.stackObjectSlot,
							};
				replacements.push({ block, index: i, instruction: replacement });
			}
		}
		for (const replacement of replacements) {
			replacement.block.instructions[replacement.index] = replacement.instruction;
			changed = true;
		}
	}
	return changed;
}

/**
 * Prove native stack objects: closed, fixed-shape ordinary objects whose
 * identity/type/prototype may be observed. Stage 1 also permits direct
 * conditional returns that are materialized before leaving the activation.
 *
 * This deliberately does not consume `stackAllocCandidates` from escape.ts. A
 * use not listed below rejects the site, including every call position, throw,
 * capture/global/heap store, dynamic or missing-key read, shape mutation,
 * enumeration, delete, and suspension-related operation. A direct return may be
 * accepted by the partial-escape subset below when another ordinary exit remains.
 */
export function annotateStackObjectSites(program: IntermediateProgram): void {
	for (const fn of program.functions) {
		// Slots stay rooted for the full activation. Bound their aggregate C-stack
		// and root-scan cost; later sites simply retain ordinary heap allocation.
		const maxStackObjectSlots = 256;
		let stackObjectSlots = 0;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type === "return") {
					delete instruction.stackObjectMaterializeSiteId;
				}
				if (instruction.type === "call") {
					delete instruction.cardinalityPushStackObjectSiteId;
				}
				if (
					instruction.type === "createObject" ||
					instruction.type === "createObjectShaped"
				) {
					delete instruction.stackObject;
					delete instruction.stackObjectSiteId;
				}
				if (
					instruction.type === "loadProperty" ||
					instruction.type === "loadPropertyStatic" ||
					instruction.type === "storeProperty" ||
					instruction.type === "storePropertyStatic"
				) {
					delete instruction.stackObjectSiteId;
					delete instruction.stackObjectSlot;
					if (
						instruction.type === "loadProperty" ||
						instruction.type === "loadPropertyStatic"
					) {
						delete instruction.stackObjectInheritedSiteId;
					}
				}
			}
		}

		if (
			fn.isGenerator ||
			fn.isAsync ||
			(fn.classContext?.isConstructor ?? false) ||
			fn.semanticFile.hasDirectEval.size > 0 ||
			functionUsesWith(fn)
		) {
			continue;
		}

		// Stage 1 partial escape deliberately excludes loops and exception regions.
		// This keeps each accepted return a one-shot edge from a live activation and
		// avoids changing try/finally completion ordering.
		const hasExceptionControl = fn.blocks.some((block) =>
			block.instructions.some(
				(instruction) =>
					instruction.type === "tryBegin" ||
					instruction.type === "tryEnd" ||
					instruction.type === "catch" ||
					instruction.type === "throw",
			),
		);
		const successors = fn.blocks.map((block, blockIndex) => {
			const result = new Set<number>();
			for (const instruction of block.instructions) {
				if (instruction.type === "jump" || instruction.type === "jumpIf") {
					for (const target of instruction.blocks) {
						if (target >= 0 && target < fn.blocks.length) result.add(target);
					}
				}
			}
			const last = block.instructions[block.instructions.length - 1];
			if (
				last?.type !== "jump" &&
				last?.type !== "return" &&
				last?.type !== "throw" &&
				blockIndex + 1 < fn.blocks.length
			) {
				result.add(blockIndex + 1);
			}
			return [...result];
		});
		const reachable = new Set<number>();
		const reachWorklist = fn.blocks.length > 0 ? [0] : [];
		while (reachWorklist.length > 0) {
			const blockIndex = reachWorklist.pop()!;
			if (reachable.has(blockIndex)) continue;
			reachable.add(blockIndex);
			for (const successor of successors[blockIndex]!) reachWorklist.push(successor);
		}
		const predecessors = fn.blocks.map(() => new Set<number>());
		for (const blockIndex of reachable) {
			for (const successor of successors[blockIndex]!) {
				if (reachable.has(successor)) predecessors[successor]!.add(blockIndex);
			}
		}
		const remainingPredecessors = predecessors.map((incoming) => incoming.size);
		const acyclicWorklist = [...reachable].filter(
			(blockIndex) => remainingPredecessors[blockIndex] === 0,
		);
		let acyclicBlockCount = 0;
		while (acyclicWorklist.length > 0) {
			const blockIndex = acyclicWorklist.pop()!;
			acyclicBlockCount++;
			for (const successor of successors[blockIndex]!) {
				if (!reachable.has(successor)) continue;
				remainingPredecessors[successor] = remainingPredecessors[successor]! - 1;
				if (remainingPredecessors[successor] === 0) acyclicWorklist.push(successor);
			}
		}
		const hasReachableCycle = acyclicBlockCount !== reachable.size;
		const dominators = fn.blocks.map((_, blockIndex) =>
			blockIndex === 0 ? new Set([0]) : new Set(reachable),
		);
		let dominatorsChanged = true;
		while (dominatorsChanged) {
			dominatorsChanged = false;
			for (const blockIndex of reachable) {
				if (blockIndex === 0) continue;
				const incoming = [...predecessors[blockIndex]!];
				const next =
					incoming.length === 0
						? new Set<number>()
						: new Set(
								[...dominators[incoming[0]!]!].filter((candidate) =>
									incoming.every((predecessor) =>
										dominators[predecessor]!.has(candidate),
									),
								),
							);
				next.add(blockIndex);
				const current = dominators[blockIndex]!;
				if (
					next.size !== current.size ||
					[...next].some((candidate) => !current.has(candidate))
				) {
					dominators[blockIndex] = next;
					dominatorsChanged = true;
				}
			}
		}
		const registerIndex = buildIRRegisterIndex(fn, { locations: true });
		const instructionLocations = registerIndex.locations!;
		let nextStackObjectSiteId = 0;

		const defCount = new Map<number, number>();
		for (const [register, definitions] of registerIndex.definitions) {
			defCount.set(register, definitions.length);
		}
		const singleDef = registerIndex.uniqueDefinitions;
		const usesOf = registerIndex.uses;

		const constantString = (register: number): number | undefined => {
			const definition = singleDef.get(register);
			return definition?.type === "createString" ? definition.stringIndex : undefined;
		};

		for (const block of fn.blocks) {
			for (const allocation of block.instructions) {
				if (
					allocation.type !== "createObject" &&
					allocation.type !== "createObjectShaped"
				) {
					continue;
				}
				const objectRegister = allocation.registers[0];
				if (
					defCount.get(objectRegister) !== 1 ||
					singleDef.get(objectRegister) !== allocation
				) {
					continue;
				}

				const keyStringIndices =
					allocation.type === "createObjectShaped" ? allocation.keyStringIndices : [];
				const ownKeys = new Set(keyStringIndices);
				const slotByKey = new Map(keyStringIndices.map((key, slot) => [key, slot]));
				const aliases = new Set<number>([objectRegister]);
				const worklist = [objectRegister];
				const stackAccesses = new Map<
					Extract<IRInstruction, { type: "loadProperty" | "storeProperty" }>,
					number
				>();
				const materializingReturns = new Set<
					Extract<IRInstruction, { type: "return" }>
				>();
				const materializingCalls = new Set<Extract<IRInstruction, { type: "call" }>>();
				let inheritedLoad: Extract<IRInstruction, { type: "loadProperty" }> | undefined;
				let hasOwnStore = false;
				let observed = false;
				let safe = true;
				while (safe && worklist.length > 0) {
					const alias = worklist.pop()!;
					for (const { instruction: use, position } of usesOf.get(alias) ?? []) {
						switch (use.type) {
							case "move": {
								const target = use.registers[0];
								if (
									position !== 1 ||
									defCount.get(target) !== 1 ||
									singleDef.get(target) !== use
								) {
									safe = false;
									break;
								}
								if (!aliases.has(target)) {
									aliases.add(target);
									worklist.push(target);
								}
								break;
							}
							case "loadProperty": {
								const key = constantString(use.registers[2]);
								if (position !== 1 || key === undefined) {
									safe = false;
								} else if (ownKeys.has(key)) {
									stackAccesses.set(use, slotByKey.get(key)!);
								} else if (
									allocation.type === "createObjectShaped" &&
									inheritedLoad === undefined
								) {
									inheritedLoad = use;
									observed = true;
								} else {
									safe = false;
								}
								break;
							}
							case "storeProperty": {
								const key = constantString(use.registers[1]);
								if (position !== 0 || key === undefined || !ownKeys.has(key)) {
									safe = false;
								} else {
									stackAccesses.set(use, slotByKey.get(key)!);
									hasOwnStore = true;
								}
								break;
							}
							case "loadPrototype":
								if (position !== 1) safe = false;
								else observed = true;
								break;
							case "unary":
								if (position !== 1 || use.operator !== "typeof") safe = false;
								else observed = true;
								break;
							case "typeofCompare":
								if (position !== 1) safe = false;
								else observed = true;
								break;
							case "binary":
								if (
									(position !== 1 && position !== 2) ||
									(use.operator !== "===" && use.operator !== "!==")
								) {
									safe = false;
								} else {
									observed = true;
								}
								break;
							case "return":
								if (position !== 0) safe = false;
								else materializingReturns.add(use);
								break;
							case "call":
								if (
									position !== 3 ||
									use.registers.length !== 4 ||
									use.nativeCardinalityPush === undefined
								) {
									safe = false;
								} else {
									materializingCalls.add(use);
									observed = true;
								}
								break;
							default:
								safe = false;
						}
						if (!safe) break;
					}
				}

				if (safe && inheritedLoad !== undefined) {
					const allocationLocation = instructionLocations.get(allocation)!;
					const loadLocation = instructionLocations.get(inheritedLoad)!;
					if (
						materializingReturns.size > 0 ||
						hasOwnStore ||
						stackAccesses.size === 0 ||
						!dominators[loadLocation.blockIndex]!.has(allocationLocation.blockIndex) ||
						(loadLocation.blockIndex === allocationLocation.blockIndex &&
							loadLocation.instructionIndex <= allocationLocation.instructionIndex)
					) {
						safe = false;
					} else {
						const sameBlock = allocationLocation.blockIndex === loadLocation.blockIndex;
						let corridor: Set<number>;
						if (sameBlock) {
							// A surrounding loop is harmless when allocation and observation
							// are ordered in one linear block: its backedge occurs after this
							// instance's guarded read, not inside the proof corridor.
							corridor = new Set([allocationLocation.blockIndex]);
						} else {
							const afterAllocation = new Set<number>();
							const forward = [allocationLocation.blockIndex];
							while (forward.length > 0) {
								const blockIndex = forward.pop()!;
								if (afterAllocation.has(blockIndex)) continue;
								afterAllocation.add(blockIndex);
								if (blockIndex === loadLocation.blockIndex) continue;
								for (const successor of successors[blockIndex]!) forward.push(successor);
							}
							const beforeLoad = new Set<number>();
							const reverse = [loadLocation.blockIndex];
							while (reverse.length > 0) {
								const blockIndex = reverse.pop()!;
								if (beforeLoad.has(blockIndex)) continue;
								beforeLoad.add(blockIndex);
								if (blockIndex === allocationLocation.blockIndex) continue;
								for (const predecessor of predecessors[blockIndex]!)
									reverse.push(predecessor);
							}
							corridor = new Set(
								[...afterAllocation].filter((blockIndex) => beforeLoad.has(blockIndex)),
							);
						}
						for (const blockIndex of corridor) {
							if (
								!sameBlock &&
								successors[blockIndex]!.some(
									(successor) =>
										corridor.has(successor) && dominators[blockIndex]!.has(successor),
								)
							) {
								safe = false;
								break;
							}
							const instructions = fn.blocks[blockIndex]!.instructions;
							const start =
								blockIndex === allocationLocation.blockIndex
									? allocationLocation.instructionIndex + 1
									: 0;
							const end =
								blockIndex === loadLocation.blockIndex
									? loadLocation.instructionIndex
									: instructions.length;
							for (let index = start; index < end; index++) {
								const instruction = instructions[index]!;
								const directOwnLoad =
									instruction.type === "loadProperty" && stackAccesses.has(instruction);
								const strictIdentity =
									instruction.type === "binary" &&
									(instruction.operator === "===" || instruction.operator === "!==");
								const immortalString = instruction.type === "createString";
								if (
									isSafepoint(instruction) &&
									!directOwnLoad &&
									!strictIdentity &&
									!immortalString
								) {
									safe = false;
									break;
								}
							}
							if (!safe) break;
						}
					}
				}

				let partialEscape = false;
				if (safe && materializingReturns.size > 0) {
					const allocationLocation = instructionLocations.get(allocation)!;
					const afterDominatedAllocation = (instruction: IRInstruction): boolean => {
						const location = instructionLocations.get(instruction)!;
						return (
							reachable.has(location.blockIndex) &&
							dominators[location.blockIndex]!.has(allocationLocation.blockIndex) &&
							(location.blockIndex !== allocationLocation.blockIndex ||
								location.instructionIndex > allocationLocation.instructionIndex)
						);
					};
					const hasNonescapingReturn = fn.blocks.some((block) =>
						block.instructions.some(
							(instruction) =>
								instruction.type === "return" &&
								!materializingReturns.has(instruction) &&
								afterDominatedAllocation(instruction),
						),
					);
					partialEscape =
						!hasExceptionControl &&
						!hasReachableCycle &&
						hasNonescapingReturn &&
						[...materializingReturns].every(afterDominatedAllocation);
					if (!partialEscape) safe = false;
				}

				// Pure load/store records belong to scalar replacement. Requiring a real
				// identity/type/prototype observation keeps this as the residual class.
				if (
					safe &&
					(observed || partialEscape) &&
					stackObjectSlots + keyStringIndices.length <= maxStackObjectSlots
				) {
					const siteId = nextStackObjectSiteId++;
					allocation.stackObject = true;
					allocation.stackObjectSiteId = siteId;
					for (const [instruction, slot] of stackAccesses) {
						instruction.stackObjectSiteId = siteId;
						instruction.stackObjectSlot = slot;
					}
					if (partialEscape) {
						for (const instruction of materializingReturns) {
							instruction.stackObjectMaterializeSiteId = siteId;
						}
					}
					for (const instruction of materializingCalls) {
						instruction.cardinalityPushStackObjectSiteId = siteId;
					}
					if (inheritedLoad !== undefined) {
						inheritedLoad.stackObjectInheritedSiteId = siteId;
					}
					stackObjectSlots += keyStringIndices.length;
				}
			}
		}
	}
}

/**
 * Drop all instructions from a block after an unconditional jump or return.
 */
function optDropInstructionsAfterJumpsOrReturns(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (let i = 0; i < block.instructions.length; ++i) {
				const instruction = block.instructions[i];
				if (!instruction) {
					continue;
				}

				if (
					instruction.type === "jump" ||
					instruction.type === "return" ||
					instruction.type === "throw"
				) {
					if (i + 1 < block.instructions.length) {
						block.instructions.splice(i + 1);
						changed = true;
					}
					break;
				}
			}
		}
	}

	return changed;
}

type FoldedPrimitive =
	| { kind: "number"; value: number }
	| { kind: "boolean"; value: boolean }
	| { kind: "null" }
	| { kind: "undefined" };

const TYPEOF_RESULTS: ReadonlyArray<IRTypeofResult> = [
	"undefined",
	"object",
	"boolean",
	"number",
	"string",
	"symbol",
	"bigint",
	"function",
];

const TYPEOF_BIT = new Map<IRTypeofResult, number>(
	TYPEOF_RESULTS.map((result, index) => [result, 1 << index]),
);
const TYPEOF_ALL = (1 << TYPEOF_RESULTS.length) - 1;

const BOOLEAN_BINARY_OPERATORS = new Set<
	Extract<IRInstruction, { type: "binary" }>["operator"]
>(["<", "<=", ">", ">=", "==", "!=", "===", "!==", "in", "instanceof"]);

const NUMBER_FROM_NUMBER_BINARY_OPERATORS = new Set<
	Extract<IRInstruction, { type: "binary" }>["operator"]
>(["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>"]);

/** Canonical typeof-result mask produced by one instruction definition. */
function producedTypeofMask(
	instruction: IRInstruction,
	factOf: (register: number) => number | null,
): number | null {
	const bit = (result: IRTypeofResult): number => TYPEOF_BIT.get(result)!;
	switch (instruction.type) {
		case "createUndefined":
			return bit("undefined");
		case "createNull":
		case "createObject":
		case "createObjectShaped":
		case "createArray":
		case "instantiateLiteralTemplate":
		case "createModuleNamespace":
		case "createTemplateObject":
		case "createArgumentsObject":
		case "createRestArguments":
		case "arrayRest":
		case "copyDataProperties":
			return bit("object");
		case "createBoolean":
		case "typeofCompare":
			return bit("boolean");
		case "createNumber":
		case "createF64":
		case "loadArgumentCount":
			return bit("number");
		case "createString":
			return bit("string");
		case "createBigint":
			return bit("bigint");
		case "createFunction":
			return bit("function");
		case "move":
			return factOf(instruction.registers[1]);
		case "binary": {
			if (BOOLEAN_BINARY_OPERATORS.has(instruction.operator)) {
				return bit("boolean");
			}
			if (NUMBER_FROM_NUMBER_BINARY_OPERATORS.has(instruction.operator)) {
				const left = factOf(instruction.registers[1]);
				const right = factOf(instruction.registers[2]);
				if (left === null || right === null) return null;
				return left === bit("number") && right === bit("number")
					? bit("number")
					: TYPEOF_ALL;
			}
			return TYPEOF_ALL;
		}
		case "unary": {
			if (instruction.operator === "!") return bit("boolean");
			if (instruction.operator === "typeof") return bit("string");
			if (
				instruction.operator === "+" ||
				instruction.operator === "-" ||
				instruction.operator === "~" ||
				instruction.operator === "tonumeric" ||
				instruction.operator === "increment" ||
				instruction.operator === "decrement"
			) {
				const source = factOf(instruction.registers[1]);
				if (source === null) return null;
				return source === bit("number") ? bit("number") : TYPEOF_ALL;
			}
			return TYPEOF_ALL;
		}
		default:
			return TYPEOF_ALL;
	}
}

/**
 * Infer a conservative union of canonical typeof results for every virtual
 * register. Multiple definitions union their possibilities; any unmodelled
 * producer contributes the full set. Values only move from unresolved to a
 * concrete mask and then gain bits, so the iteration is monotone.
 */
function inferStaticTypeofMasks(fn: IRFunction): Map<number, number> {
	const facts = new Map<number, number | null>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) continue;
			for (const register of instruction.registers) {
				if (register >= 0 && !facts.has(register)) {
					facts.set(register, register < fn.parameterCount ? TYPEOF_ALL : null);
				}
			}
		}
	}

	const factOf = (register: number): number | null => facts.get(register) ?? TYPEOF_ALL;
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const produced = producedTypeofMask(instruction, factOf);
				if (produced === null) continue;
				for (const register of definedRegisters(instruction)) {
					const current = facts.get(register) ?? null;
					const joined = current === null ? produced : current | produced;
					if (joined !== current) {
						facts.set(register, joined);
						changed = true;
					}
				}
			}
		}
	}

	return new Map(
		[...facts].map(([register, fact]) => [register, fact ?? TYPEOF_ALL] as const),
	);
}

function optFoldStaticTypeofComparisons(
	program: IntermediateProgram,
	functions: ReadonlySet<IRFunction> = new Set(program.functions),
): boolean {
	let changed = false;
	for (const fn of functions) {
		const facts = inferStaticTypeofMasks(fn);
		for (const block of fn.blocks) {
			block.instructions = block.instructions.map((instruction) => {
				if (instruction.type !== "typeofCompare") return instruction;
				const mask = facts.get(instruction.registers[1]) ?? TYPEOF_ALL;
				const expected = TYPEOF_BIT.get(instruction.expected)!;
				const alwaysMatches = (mask & ~expected) === 0;
				const neverMatches = (mask & expected) === 0;
				if (!alwaysMatches && !neverMatches) return instruction;
				changed = true;
				const matches = alwaysMatches;
				return {
					type: "createBoolean",
					registers: [instruction.registers[0]],
					value: instruction.negated ? !matches : matches,
				};
			});
		}
	}
	return changed;
}

/** A terminal conditional in the normalized IR: jump-if-true, then false jump. */
function terminalConditional(
	block: IRFunction["blocks"][number],
): { condition: number; ifTrue: number; ifFalse: number } | undefined {
	const length = block.instructions.length;
	if (length < 2) return undefined;
	const conditional = block.instructions[length - 2];
	const fallback = block.instructions[length - 1];
	if (conditional?.type !== "jumpIf" || fallback?.type !== "jump") return undefined;
	return {
		condition: conditional.registers[0],
		ifTrue: conditional.blocks[0],
		ifFalse: fallback.blocks[0],
	};
}

function staticTypeofSuccessors(fn: IRFunction): Array<Array<number>> {
	return fn.blocks.map((block, blockIndex) => {
		const successors = new Set<number>();
		for (const instruction of block.instructions) {
			if (instruction.type === "jump" || instruction.type === "jumpIf") {
				for (const target of instruction.blocks) {
					if (target >= 0 && target < fn.blocks.length) successors.add(target);
				}
			}
		}
		const last = block.instructions[block.instructions.length - 1];
		if (
			last?.type !== "jump" &&
			last?.type !== "return" &&
			last?.type !== "throw" &&
			blockIndex + 1 < fn.blocks.length
		) {
			successors.add(blockIndex + 1);
		}
		return [...successors];
	});
}

/**
 * Follow unique move definitions to the stable value they copy. Parameters are
 * stable only when the body never writes their register; non-parameters require
 * exactly one definition. A multiply-defined register is deliberately not a
 * refinable SSA value in this first slice.
 */
function stableCanonicalRegister(
	register: number,
	fn: IRFunction,
	definitions: ReadonlyMap<number, ReadonlyArray<{ instruction: IRInstruction }>>,
): number | undefined {
	const seen = new Set<number>();
	let current = register;
	while (!seen.has(current)) {
		seen.add(current);
		const writes = definitions.get(current) ?? [];
		if (current < fn.parameterCount) {
			return writes.length === 0 ? current : undefined;
		}
		if (writes.length !== 1) return undefined;
		const producer = writes[0]!.instruction;
		if (producer.type !== "move") return current;
		current = producer.registers[1];
	}
	return undefined;
}

type StaticTypeofState = Map<number, number>;

function optRefineStaticTypeofBranches(
	program: IntermediateProgram,
	functions: ReadonlySet<IRFunction> = new Set(program.functions),
): boolean {
	let changed = false;
	for (const fn of functions) {
		const hasExceptionControl = fn.blocks.some((block) =>
			block.instructions.some(
				(instruction) =>
					instruction.type === "tryBegin" ||
					instruction.type === "tryEnd" ||
					instruction.type === "catch" ||
					instruction.type === "throw",
			),
		);
		if (
			fn.blocks.length === 0 ||
			fn.isGenerator ||
			fn.isAsync ||
			hasExceptionControl ||
			functionUsesWith(fn) ||
			(fn.semanticFile?.hasDirectEval.size ?? 0) > 0
		) {
			continue;
		}
		const baseFacts = inferStaticTypeofMasks(fn);
		const index = buildIRRegisterIndex(fn);
		const successors = staticTypeofSuccessors(fn);
		const states: Array<StaticTypeofState | null> = fn.blocks.map(() => null);
		states[0] = new Map();
		const worklist = [0];
		const queued = new Set(worklist);
		const baseMask = (register: number): number => baseFacts.get(register) ?? TYPEOF_ALL;
		const stateMask = (state: StaticTypeofState, register: number): number =>
			state.get(register) ?? baseMask(register);

		const enqueueMerge = (target: number, incoming: StaticTypeofState): void => {
			if (target < 0 || target >= fn.blocks.length) return;
			const current = states[target];
			if (current === null || current === undefined) {
				states[target] = new Map(incoming);
				if (!queued.has(target)) {
					queued.add(target);
					worklist.push(target);
				}
				return;
			}
			let stateChanged = false;
			const registers = new Set([...current.keys(), ...incoming.keys()]);
			for (const register of registers) {
				const joined = stateMask(current, register) | stateMask(incoming, register);
				const base = baseMask(register);
				const previous = stateMask(current, register);
				if (joined === base) current.delete(register);
				else current.set(register, joined);
				stateChanged ||= joined !== previous;
			}
			if (stateChanged && !queued.has(target)) {
				queued.add(target);
				worklist.push(target);
			}
		};

		while (worklist.length > 0) {
			const blockIndex = worklist.shift()!;
			queued.delete(blockIndex);
			const input = states[blockIndex];
			if (input === null || input === undefined) continue;
			const branch = terminalConditional(fn.blocks[blockIndex]!);
			let refined = false;
			const branchTargets =
				branch === undefined ? undefined : new Set([branch.ifTrue, branch.ifFalse]);
			const normalizedBranch =
				branch !== undefined &&
				branchTargets!.size === successors[blockIndex]!.length &&
				successors[blockIndex]!.every((target) => branchTargets!.has(target));
			if (branch !== undefined && normalizedBranch) {
				const condition = stableCanonicalRegister(
					branch.condition,
					fn,
					index.definitions,
				);
				const conditionProducer =
					condition === undefined ? undefined : index.uniqueDefinitions.get(condition);
				if (conditionProducer?.type === "typeofCompare") {
					const operand = stableCanonicalRegister(
						conditionProducer.registers[1],
						fn,
						index.definitions,
					);
					if (operand !== undefined) {
						const current = stateMask(input, operand);
						const expected = TYPEOF_BIT.get(conditionProducer.expected)!;
						const matching = current & expected;
						const excluding = current & ~expected;
						const trueMask = conditionProducer.negated ? excluding : matching;
						const falseMask = conditionProducer.negated ? matching : excluding;
						for (const [target, mask] of [
							[branch.ifTrue, trueMask],
							[branch.ifFalse, falseMask],
						] as const) {
							if (mask === 0) continue;
							const outgoing = new Map(input);
							if (mask === baseMask(operand)) outgoing.delete(operand);
							else outgoing.set(operand, mask);
							enqueueMerge(target, outgoing);
						}
						refined = true;
					}
				}
			}
			if (!refined) {
				for (const successor of successors[blockIndex]!) {
					enqueueMerge(successor, input);
				}
			}
		}

		for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
			const input = states[blockIndex];
			if (input === null || input === undefined) continue;
			const block = fn.blocks[blockIndex]!;
			block.instructions = block.instructions.map((instruction) => {
				if (instruction.type !== "typeofCompare") return instruction;
				const operand = stableCanonicalRegister(
					instruction.registers[1],
					fn,
					index.definitions,
				);
				if (operand === undefined) return instruction;
				const mask = stateMask(input, operand);
				const expected = TYPEOF_BIT.get(instruction.expected)!;
				const alwaysMatches = (mask & ~expected) === 0;
				const neverMatches = (mask & expected) === 0;
				if (!alwaysMatches && !neverMatches) return instruction;
				changed = true;
				const matches = alwaysMatches;
				return {
					type: "createBoolean",
					registers: [instruction.registers[0]],
					value: instruction.negated ? !matches : matches,
				};
			});
		}
	}
	return changed;
}

function foldedPrimitive(
	instruction: IRInstruction | undefined,
): FoldedPrimitive | undefined {
	switch (instruction?.type) {
		case "createNumber":
		case "createF64":
			return { kind: "number", value: instruction.value };
		case "createBoolean":
			return { kind: "boolean", value: instruction.value };
		case "createNull":
			return { kind: "null" };
		case "createUndefined":
			return { kind: "undefined" };
		default:
			return undefined;
	}
}

function primitiveTruthy(value: FoldedPrimitive): boolean {
	switch (value.kind) {
		case "number":
			return value.value !== 0 && !Number.isNaN(value.value);
		case "boolean":
			return value.value;
		case "null":
		case "undefined":
			return false;
	}
}

function primitiveNumber(value: FoldedPrimitive): number {
	switch (value.kind) {
		case "number":
			return value.value;
		case "boolean":
			return value.value ? 1 : 0;
		case "null":
			return 0;
		case "undefined":
			return Number.NaN;
	}
}

function foldUnaryPrimitive(
	operator: Extract<IRInstruction, { type: "unary" }>["operator"],
	operand: FoldedPrimitive,
): FoldedPrimitive | undefined {
	switch (operator) {
		case "!":
			return { kind: "boolean", value: !primitiveTruthy(operand) };
		case "+":
			return { kind: "number", value: primitiveNumber(operand) };
		case "-":
			return { kind: "number", value: -primitiveNumber(operand) };
		case "~":
			return { kind: "number", value: ~primitiveNumber(operand) };
		case "typeof":
			return undefined;
	}
}

function foldNumericBinary(
	operator: Extract<IRInstruction, { type: "binary" }>["operator"],
	left: number,
	right: number,
): FoldedPrimitive | undefined {
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
		case "**":
			// Keep host-dependent transcendental approximation out of the wire: the
			// Node and self-hosted compiler must serialize identical f64 bits.
			return undefined;
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
		case "in":
		case "instanceof":
			return undefined;
	}
}

function foldPrimitiveEquality(
	operator: Extract<IRInstruction, { type: "binary" }>["operator"],
	left: FoldedPrimitive,
	right: FoldedPrimitive,
): FoldedPrimitive | undefined {
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
		equal =
			left.kind !== "boolean" || (right.kind === "boolean" && left.value === right.value);
	} else if (loose) {
		equal =
			(left.kind === "null" && right.kind === "undefined") ||
			(left.kind === "undefined" && right.kind === "null") ||
			((left.kind === "number" || left.kind === "boolean") &&
				(right.kind === "number" || right.kind === "boolean") &&
				primitiveNumber(left) === primitiveNumber(right));
	}
	return {
		kind: "boolean",
		value: operator === "!==" || operator === "!=" ? !equal : equal,
	};
}

type FoldedInstruction =
	| Extract<IRInstruction, { type: "createF64" }>
	| Extract<IRInstruction, { type: "createBoolean" }>
	| Extract<IRInstruction, { type: "createNull" }>
	| Extract<IRInstruction, { type: "createUndefined" }>;

function foldedInstruction(
	destination: number,
	value: FoldedPrimitive,
): FoldedInstruction {
	switch (value.kind) {
		case "number":
			// F64 preserves NaN, infinities, and negative zero. Later representation
			// inference still unboxes it in generated C where possible.
			return { type: "createF64", registers: [destination], value: value.value };
		case "boolean":
			return { type: "createBoolean", registers: [destination], value: value.value };
		case "null":
			return { type: "createNull", registers: [destination] };
		case "undefined":
			return { type: "createUndefined", registers: [destination] };
	}
}

function optFoldPrimitiveConstants(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		// Resumable functions can re-enter after an apparent single definition; their
		// continuation state needs a resume-aware constant lattice before this pass is
		// sound for values and branches spanning suspension points.
		if (fn.isGenerator || fn.isAsync) continue;
		const definitionCount = new Map<number, number>();
		const singleDefinition = new Map<number, IRInstruction>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (!("registers" in instruction)) continue;
				for (let i = 0; i < destinationCount(instruction); i++) {
					const register = instruction.registers[i]!;
					const count = (definitionCount.get(register) ?? 0) + 1;
					definitionCount.set(register, count);
					if (count === 1) singleDefinition.set(register, instruction);
					else singleDefinition.delete(register);
				}
			}
		}

		for (const block of fn.blocks) {
			const next: Array<IRInstruction> = [];
			for (const instruction of block.instructions) {
				let replacement: FoldedInstruction | undefined;
				if (instruction.type === "unary") {
					const operand = foldedPrimitive(singleDefinition.get(instruction.registers[1]));
					const result =
						operand === undefined
							? undefined
							: foldUnaryPrimitive(instruction.operator, operand);
					if (result !== undefined) {
						replacement = foldedInstruction(instruction.registers[0], result);
					}
				} else if (instruction.type === "binary") {
					const left = foldedPrimitive(singleDefinition.get(instruction.registers[1]));
					const right = foldedPrimitive(singleDefinition.get(instruction.registers[2]));
					const result =
						left === undefined || right === undefined
							? undefined
							: foldPrimitiveEquality(instruction.operator, left, right);
					if (result !== undefined) {
						replacement = foldedInstruction(instruction.registers[0], result);
					}
				} else if (instruction.type === "jumpIf") {
					const condition = foldedPrimitive(
						singleDefinition.get(instruction.registers[0]),
					);
					if (condition !== undefined) {
						changed = true;
						if (primitiveTruthy(condition)) {
							next.push({ type: "jump", blocks: instruction.blocks });
						}
						continue;
					}
				}

				if (replacement !== undefined) {
					changed = true;
					next.push(replacement);
					if (definitionCount.get(replacement.registers[0]) === 1) {
						singleDefinition.set(replacement.registers[0], replacement);
					}
				} else {
					next.push(instruction);
				}
			}
			block.instructions = next;
		}
	}
	return changed;
}

/**
 * Check if all blocks in the program are referenced. We can assume that all blocks are
 * referenced before we optimize, but in some future cases we might inline blocks or functions.
 */
function optDropUnreferencedBlocks(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		changed = dropUnreferencedBlocksInFunction(fn) || changed;
	}

	return changed;
}

function dropUnreferencedBlocksInFunction(fn: IRFunction): boolean {
	const blockCount = fn.blocks.length;
	if (blockCount <= 1) {
		return false;
	}

	// Count explicit target and positional fall-through occurrences, not just
	// distinct source blocks. Peeling a block removes all of its outgoing
	// occurrences and can expose further zero-indegree blocks. Block zero remains
	// the function entry; cycles retain one another, matching the old behavior.
	const incoming = new Array<number>(blockCount).fill(0);
	for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
		const block = fn.blocks[blockIndex]!;
		for (const instruction of block.instructions) {
			if ("blocks" in instruction) {
				for (const target of instruction.blocks) {
					incoming[target]!++;
				}
			}
		}
		const last = block.instructions.at(-1);
		const endsControlFlow =
			last?.type === "jump" || last?.type === "return" || last?.type === "throw";
		if (!endsControlFlow && blockIndex + 1 < blockCount) {
			incoming[blockIndex + 1]!++;
		}
	}

	const removed = new Array<boolean>(blockCount).fill(false);
	const worklist: Array<number> = [];
	for (let blockIndex = 1; blockIndex < blockCount; blockIndex++) {
		if (incoming[blockIndex] === 0) {
			worklist.push(blockIndex);
		}
	}
	const decrementIncoming = (target: number) => {
		incoming[target]!--;
		if (target !== 0 && incoming[target] === 0) {
			worklist.push(target);
		}
	};

	for (let cursor = 0; cursor < worklist.length; cursor++) {
		const blockIndex = worklist[cursor]!;
		removed[blockIndex] = true;
		const block = fn.blocks[blockIndex]!;
		for (const instruction of block.instructions) {
			if (!("blocks" in instruction)) {
				continue;
			}
			for (const target of instruction.blocks) {
				decrementIncoming(target);
			}
		}
		const last = block.instructions.at(-1);
		const endsControlFlow =
			last?.type === "jump" || last?.type === "return" || last?.type === "throw";
		if (!endsControlFlow && blockIndex + 1 < blockCount) {
			decrementIncoming(blockIndex + 1);
		}
	}

	if (worklist.length === 0) {
		return false;
	}

	const oldToNew = new Array<number | undefined>(blockCount);
	const blocks: IRFunction["blocks"] = [];
	for (let oldIndex = 0; oldIndex < blockCount; oldIndex++) {
		if (!removed[oldIndex]) {
			oldToNew[oldIndex] = blocks.length;
			blocks.push(fn.blocks[oldIndex]!);
		}
	}
	fn.blocks = blocks;
	patchBlockTargets(fn, oldToNew);
	patchBodyEntryBlock(fn, oldToNew);
	return true;
}

/**
 * Move all local variable usages to use registers.
 */
function optLocalsToRegister(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		const localMap = new Map<number, number>();
		const storedLocals = new Set<number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type === "storeLocal") {
					storedLocals.add(instruction.index);
				}
			}
		}

		for (const block of fn.blocks) {
			for (let i = 0; i < block.instructions.length; ++i) {
				const instruction = block.instructions[i];
				if (instruction?.type !== "storeLocal" && instruction?.type !== "loadLocal") {
					continue;
				}
				if (instruction.type === "loadLocal" && !storedLocals.has(instruction.index)) {
					block.instructions[i] = {
						type: "createUndefined",
						registers: [instruction.registers[0]],
					};
					changed = true;
					continue;
				}

				let register = localMap.get(instruction.index);
				if (isNil(register)) {
					register = fn.nextRegisterDestination++;
					localMap.set(instruction.index, register);
				}

				if (instruction.type === "loadLocal") {
					block.instructions[i] = {
						type: "move",
						registers: [instruction.registers[0], register],
					};
					changed = true;
				} else if (instruction.type === "storeLocal") {
					block.instructions[i] = {
						type: "move",
						registers: [register, instruction.registers[0]],
					};
					changed = true;
				}
			}
		}
	}

	return changed;
}

/**
 * We can combine linear blocks into a single block, if they are only jumped to from the last
 * instruction of the previous block.
 */
function optCombineLinearBlocks(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		changed = combineLinearBlocksInFunction(fn) || changed;
	}

	return changed;
}

function combineLinearBlocksInFunction(fn: IRFunction): boolean {
	const blockCount = fn.blocks.length;
	if (blockCount <= 1) {
		return false;
	}

	// Every occurrence matters: a jump plus either tryBegin target, two identical
	// tryBegin targets, or a backedge all make the target multi-referenced.
	const incoming = new Array<number>(blockCount).fill(0);
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if ("blocks" in instruction) {
				for (const target of instruction.blocks) {
					incoming[target]!++;
				}
			}
		}
	}

	// mergeNext[i] means old block i+1 is folded into old block i. Eligible
	// edges can form chains; all decisions use the original CFG and indices.
	const mergeNext = new Array<boolean>(blockCount - 1).fill(false);
	let mergeCount = 0;
	for (let source = 0; source + 1 < blockCount; source++) {
		const lastInstruction = fn.blocks[source]!.instructions.at(-1);
		if (
			incoming[source + 1] === 1 &&
			lastInstruction?.type === "jump" &&
			lastInstruction.blocks[0] === source + 1
		) {
			mergeNext[source] = true;
			mergeCount++;
		}
	}
	if (mergeCount === 0) {
		return false;
	}

	const oldToNew = new Array<number | undefined>(blockCount);
	const blocks: IRFunction["blocks"] = [];
	for (let chainStart = 0; chainStart < blockCount; ) {
		const mergedInstructions: Array<IRInstruction> = [];
		let chainEnd = chainStart;
		while (chainEnd + 1 < blockCount && mergeNext[chainEnd]) {
			const instructions = fn.blocks[chainEnd]!.instructions;
			mergedInstructions.push(...instructions.slice(0, -1));
			chainEnd++;
		}
		mergedInstructions.push(...fn.blocks[chainEnd]!.instructions);

		const newIndex = blocks.length;
		for (let oldIndex = chainStart; oldIndex <= chainEnd; oldIndex++) {
			oldToNew[oldIndex] = newIndex;
		}
		const block = fn.blocks[chainStart]!;
		block.instructions = mergedInstructions;
		blocks.push(block);
		chainStart = chainEnd + 1;
	}

	fn.blocks = blocks;
	patchBlockTargets(fn, oldToNew);
	patchBodyEntryBlock(fn, oldToNew);
	return true;
}

function patchBlockTargets(fn: IRFunction, oldToNew: Array<number | undefined>) {
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("blocks" in instruction)) {
				continue;
			}
			for (let i = 0; i < instruction.blocks.length; i++) {
				instruction.blocks[i] = oldToNew[instruction.blocks[i]!]!;
			}
		}
	}
}

function patchBodyEntryBlock(fn: IRFunction, oldToNew: Array<number | undefined>) {
	if (fn.bodyEntryBlock === undefined) {
		return;
	}
	const newBodyEntry = oldToNew[fn.bodyEntryBlock];
	if (newBodyEntry === undefined) {
		delete fn.bodyEntryBlock;
	} else {
		fn.bodyEntryBlock = newBodyEntry;
	}
}

/**
 * Eliminate temporal-dead-zone checks that are provably redundant.
 *
 * Every read of a `let`/`const`/class binding emits a `throwIfTdz` against the
 * uninitialized ("empty") sentinel, and every block scope seeds its bindings
 * with a `createEmpty` hole-init. For the overwhelmingly common case — a binding
 * declared-with-initializer (or a loop variable) read only after that store —
 * the check can never fire. Removing it both drops a per-read instruction from
 * the interpreter's hot loop and, crucially, removes the only constructs
 * (`createEmpty` / `throwIfTdz`) the native (emit-c) backend cannot lower, so the
 * whole function becomes eligible and its loop counters can stay unboxed.
 *
 * Soundness: a `throwIfTdz` is dropped only where a forward must-analysis proves
 * the slot is definitely initialized (a non-empty store dominates the read on
 * every path). The analysis is restricted to function-local slots
 * (`loadLocal`/`storeLocal`); captured and global bindings can be initialized by
 * another function, so their checks are left alone. Handler facts are intersected
 * at every instruction that can transfer to that handler.
 */
function optEliminateRedundantTdzChecks(program: IntermediateProgram) {
	for (const fn of program.functions) {
		eliminateRedundantTdzChecksInFunction(fn);
	}
}

function eliminateRedundantTdzChecksInFunction(fn: IRFunction) {
	const blocks = fn.blocks;
	if (blocks.length === 0) {
		return;
	}
	if (
		!blocks.some((block) =>
			block.instructions.some((instr) => instr.type === "throwIfTdz"),
		)
	) {
		return;
	}

	// `with` (sloppy mode) introduces the empty sentinel through `withGet`, which
	// would defeat the empty-value tracking below. Such functions are never
	// native-backend eligible anyway, so skip them outright.
	for (const block of blocks) {
		for (const instr of block.instructions) {
			if (
				instr.type === "withGet" ||
				instr.type === "withResolveBase" ||
				instr.type === "withEnter"
			) {
				return;
			}
		}
	}

	const checkedSlots = new Set<number>();
	for (const block of blocks) {
		const regToSlot = new Map<number, number>();
		for (const instr of block.instructions) {
			if (instr.type === "loadLocal") {
				regToSlot.set(instr.registers[0], instr.index);
			} else if (instr.type === "throwIfTdz") {
				const slot = regToSlot.get(instr.registers[0]);
				if (slot !== undefined) {
					checkedSlots.add(slot);
				}
			}
		}
	}
	if (checkedSlots.size === 0) {
		return;
	}

	// Resolve the innermost handler at each potentially throwing instruction. Try
	// markers are balanced in flattened block order, matching VM lowering.
	const handlerByInstruction: Array<Array<number | undefined>> = [];
	const activeHandlers: Array<number> = [];
	for (const block of blocks) {
		const handlers = new Array<number | undefined>(block.instructions.length);
		handlerByInstruction.push(handlers);
		for (let i = 0; i < block.instructions.length; i++) {
			const instr = block.instructions[i]!;
			if (instr.type === "tryBegin") {
				activeHandlers.push(instr.blocks[0]);
			} else if (instr.type === "tryEnd") {
				if (activeHandlers.pop() === undefined) {
					throw new Error("Unbalanced tryEnd marker in TDZ analysis");
				}
			} else if (instr.type === "throw" || isSafepoint(instr)) {
				handlers[i] = activeHandlers[activeHandlers.length - 1];
			}
		}
	}
	if (activeHandlers.length > 0) {
		throw new Error("Unbalanced tryBegin marker in TDZ analysis");
	}

	// Forward must-analysis: inSets[b] = local slots definitely initialized on
	// entry to b. Entry starts empty; other blocks start at top (all checked slots)
	// and are intersected down by normal and instruction-precise exceptional edges.
	// A `jumpIf` continues in-block when not taken, so it is a branch, not a terminator.
	const inSets: Array<Set<number>> = blocks.map((_, b) =>
		b === 0 ? new Set<number>() : new Set(checkedSlots),
	);

	const startSet = (b: number): Set<number> => (b === 0 ? new Set<number>() : inSets[b]!);

	const propagate = (target: number, set: Set<number>): boolean => {
		const current = inSets[target]!;
		let shrank = false;
		for (const slot of current) {
			if (!set.has(slot)) {
				current.delete(slot);
				shrank = true;
			}
		}
		return shrank;
	};

	let changed = true;
	while (changed) {
		changed = false;
		for (let b = 0; b < blocks.length; b++) {
			const cur = new Set(startSet(b));
			const empties = new Set<number>();
			let terminated = false;
			for (let i = 0; i < blocks[b]!.instructions.length; i++) {
				const instr = blocks[b]!.instructions[i]!;
				const handler = handlerByInstruction[b]![i];
				if (handler !== undefined) {
					changed = propagate(handler, cur) || changed;
				}
				if (instr.type === "createEmpty") {
					empties.add(instr.registers[0]);
				} else if (instr.type === "storeLocal" && checkedSlots.has(instr.index)) {
					if (empties.has(instr.registers[0])) {
						cur.delete(instr.index);
					} else {
						cur.add(instr.index);
					}
				} else if (instr.type === "jumpIf") {
					changed = propagate(instr.blocks[0], cur) || changed;
				} else if (instr.type === "jump") {
					changed = propagate(instr.blocks[0], cur) || changed;
					terminated = true;
					break;
				} else if (instr.type === "return" || instr.type === "throw") {
					terminated = true;
					break;
				}
			}
			if (!terminated && b + 1 < blocks.length) {
				changed = propagate(b + 1, cur) || changed;
			}
		}
	}

	// Removal pass: drop each throwIfTdz whose local slot is definitely
	// initialized at that point. A throwIfTdz always immediately follows the load
	// that produced its register, so the register→slot map is fresh.
	const stillChecked = new Set<number>();
	const removable = new Set<IRInstruction>();
	for (let b = 0; b < blocks.length; b++) {
		const cur = new Set(startSet(b));
		const empties = new Set<number>();
		const regToSlot = new Map<number, number>();
		for (const instr of blocks[b]!.instructions) {
			switch (instr.type) {
				case "createEmpty":
					empties.add(instr.registers[0]);
					break;
				case "storeLocal":
					if (!checkedSlots.has(instr.index)) {
						break;
					}
					if (empties.has(instr.registers[0])) {
						cur.delete(instr.index);
					} else {
						cur.add(instr.index);
					}
					break;
				case "loadLocal":
					regToSlot.set(instr.registers[0], instr.index);
					break;
				case "throwIfTdz": {
					const slot = regToSlot.get(instr.registers[0]);
					if (slot === undefined) {
						// A global/captured read — not analyzed here.
					} else if (cur.has(slot)) {
						removable.add(instr);
					} else {
						stillChecked.add(slot);
					}
					break;
				}
			}
		}
	}

	if (removable.size === 0) {
		return;
	}

	// Drop the proven-redundant checks, plus any hole-init whose slot has no
	// surviving check (its empty value can never be observed). The hole-init is
	// always `createEmpty [r]` immediately followed by `storeLocal [r]`.
	for (const block of blocks) {
		const instrs = block.instructions;
		const next: Array<IRInstruction> = [];
		for (let i = 0; i < instrs.length; i++) {
			const instr = instrs[i]!;
			if (instr.type === "throwIfTdz" && removable.has(instr)) {
				continue;
			}
			if (instr.type === "createEmpty") {
				const store = instrs[i + 1];
				if (
					store?.type === "storeLocal" &&
					store.registers[0] === instr.registers[0] &&
					!stillChecked.has(store.index)
				) {
					i++;
					continue;
				}
			}
			next.push(instr);
		}
		block.instructions = next;
	}
}

export const irOptTestHooks = {
	dropUnreferencedBlocksInFunction,
	combineLinearBlocksInFunction,
	eliminateRedundantTdzChecksInFunction,
	foldPrimitiveConstants: optFoldPrimitiveConstants,
	foldStaticTypeofComparisons: optFoldStaticTypeofComparisons,
	refineStaticTypeofBranches: optRefineStaticTypeofBranches,
	eliminateRedundantNumericCoercions: optEliminateRedundantNumericCoercions,
	forwardSingleUsePrimitiveResults: optForwardSingleUsePrimitiveResults,
	commonPrimitiveConstants: optCommonPrimitiveConstants,
	valueNumberIsEmptyChecks: optValueNumberIsEmptyChecks,
	valueNumberNumericSubtractions: optValueNumberNumericSubtractions,
	resetOptimizationIndexBuildCounts() {
		optimizationIndexBuildCounts.typeofComparisons = 0;
		optimizationIndexBuildCounts.capturedSlots = 0;
	},
	optimizationIndexBuildCounts() {
		return { ...optimizationIndexBuildCounts };
	},
};

/** Whether a function contains any `with`-statement op (dynamic scoping). */
function functionUsesWith(fn: IRFunction): boolean {
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "withEnter" ||
				instruction.type === "withExit" ||
				instruction.type === "withGet" ||
				instruction.type === "withResolveBase" ||
				instruction.type === "withSet"
			) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Local (intra-block) copy propagation: after `move [dst, src]`, rewrite later
 * reads of `dst` in the same block to `src`, until either is reassigned. The
 * `move` is left in place; once all its in-block readers point at `src` and
 * `dst` has no other use, optDeadInstructionElimination removes it. MOVE is the
 * most common opcode (the front end copies a value into a working register
 * before almost every use), so this shrinks both backends' output broadly.
 *
 * Safety: only operands past an instruction's destination registers are
 * rewritten (a destination is never altered), and a register is dropped from the
 * active copies the moment it — or the value it copies — is written. Copies do
 * not cross block boundaries.
 */
function optCopyPropagation(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		// `with` makes variable resolution dynamic and lowers to a withGet →
		// fallback shape that writes one result register across several blocks; its
		// register liveness does not fit the simple intra-block model here, so skip
		// such functions entirely (they are rare, sloppy-mode-only).
		if (functionUsesWith(fn)) {
			continue;
		}

		for (const block of fn.blocks) {
			// copyOf.get(d) === s means register d currently holds the same value as
			// register s (read s instead of d).
			const copyOf = new Map<number, number>();

			const invalidate = (register: number) => {
				copyOf.delete(register);
				for (const [dst, src] of copyOf) {
					if (src === register) {
						copyOf.delete(dst);
					}
				}
			};

			for (const instruction of block.instructions) {
				if (!("registers" in instruction)) {
					continue;
				}
				const defs = destinationCount(instruction);

				// Rewrite use operands (those past the destinations) to their source.
				for (let i = defs; i < instruction.registers.length; i++) {
					const register = instruction.registers[i]!;
					const source = copyOf.get(register);
					if (source !== undefined && source !== register) {
						instruction.registers[i] = source;
						changed = true;
					}
				}

				// A reassigned register (and any copy of it) is no longer current.
				for (let i = 0; i < defs; i++) {
					invalidate(instruction.registers[i]!);
				}

				// Record the new copy. The source was already rewritten above, so this
				// collapses chains (a = b; c = a → c copies b).
				if (instruction.type === "move" && defs === 1) {
					const dst = instruction.registers[0];
					const src = instruction.registers[1];
					if (dst >= 0 && src >= 0 && dst !== src) {
						copyOf.set(dst, src);
					}
				}
			}
		}
	}

	return changed;
}

function canonicalTypeofResult(value: string): IRTypeofResult | undefined {
	switch (value) {
		case "undefined":
		case "object":
		case "boolean":
		case "number":
		case "string":
		case "symbol":
		case "bigint":
		case "function":
			return value;
		default:
			return undefined;
	}
}

/**
 * Fuse `typeof value` followed by equality with a canonical result string. The
 * predicate replaces the original typeof producer and the binary comparison
 * becomes a move, preserving the observation point if `value` changes between
 * the two instructions. Any other live use of the produced string keeps the
 * generic allocating typeof operation.
 */
function optFuseTypeofComparisons(
	program: IntermediateProgram,
	candidates: ReadonlySet<IRFunction>,
): boolean {
	let changed = false;
	for (const fn of candidates) {
		const { uniqueDefinitions, uses } = buildIRRegisterIndex(fn);
		const replacements = new Map<IRInstruction, IRInstruction>();

		for (const block of fn.blocks) {
			for (const comparison of block.instructions) {
				if (
					comparison.type !== "binary" ||
					(comparison.operator !== "===" &&
						comparison.operator !== "!==" &&
						comparison.operator !== "==" &&
						comparison.operator !== "!=")
				) {
					continue;
				}

				for (const [typeofPosition, stringPosition] of [
					[1, 2],
					[2, 1],
				] as const) {
					const typeofRegister = comparison.registers[typeofPosition];
					const producer = uniqueDefinitions.get(typeofRegister);
					const string = uniqueDefinitions.get(comparison.registers[stringPosition]);
					if (
						producer?.type !== "unary" ||
						producer.operator !== "typeof" ||
						string?.type !== "createString" ||
						replacements.has(producer)
					) {
						continue;
					}
					const expected = canonicalTypeofResult(
						decodeStringConstant(program, string.stringIndex),
					);
					if (expected === undefined) continue;

					const producerHasOtherLiveUse = (uses.get(typeofRegister) ?? []).some(
						({ instruction: use, position }) => {
							if (use === comparison && position === typeofPosition) return false;
							if (use.type !== "move" || position !== 1) return true;
							return (uses.get(use.registers[0])?.length ?? 0) !== 0;
						},
					);
					if (producerHasOtherLiveUse) continue;

					replacements.set(producer, {
						type: "typeofCompare",
						registers: [producer.registers[0], producer.registers[1]],
						expected,
						negated: comparison.operator === "!==" || comparison.operator === "!=",
					});
					replacements.set(comparison, {
						type: "move",
						registers: [comparison.registers[0], producer.registers[0]],
					});
					break;
				}
			}
		}

		if (replacements.size > 0) {
			for (const block of fn.blocks) {
				block.instructions = block.instructions.map(
					(instruction) => replacements.get(instruction) ?? instruction,
				);
			}
			changed = true;
		}
	}
	return changed;
}

/**
 * Scalar-replace non-escaping object literals — the first slice of escape
 * analysis (see docs/roadmaps/gc.md).
 *
 * A `createObjectShaped` builds an immutable record with statically-known, unique,
 * non-index string keys (`staticObjectShape` already excludes spread, computed
 * keys, accessors, methods, `__proto__`, duplicates and index-like names). The
 * empty `createObject` is the zero-field equivalent. Before this pass, statically
 * decidable type and identity observations are folded only for allocations that
 * satisfy this pass or its mutable counterpart. Once the remaining uses are only
 * constant-own-key reads and single-definition aliases, the object is
 * unobservable. We delete the allocation and rewrite each read
 * `loadProperty [d, obj, keyᵢ]` into `move [d, valueᵢ]`, where `valueᵢ` is the
 * register the literal stored for that key. The now-dead key constants and any
 * unread values are removed by the following DCE pass.
 *
 * This removes the allocation entirely — the GC never sees the object — which is
 * the Phase-7 lever that beats merely shrinking root frames. It is conservative by
 * construction: any use we do not recognise (escaping into a call/return/store,
 * mutation via `storeProperty`, a computed or foreign key, `delete`, or an
 * observation the shared proof cannot decide) leaves the site untouched.
 *
 * Gating: skipped for functions that can observe locals dynamically — `with`
 * (sloppy scope) and direct `eval` (C3) — and for generator/async bodies, where a
 * value live across a suspension has a subtler lifetime (C5, deferred).
 *
 * Soundness conditions, all required:
 *  - the record register is single-assignment (exactly one defining instruction);
 *  - every key register is a single `createString` whose index is an own key of
 *    the record (a read of any other key would resolve up the prototype chain).
 *
 * Value freshness is handled by *snapshotting*: at the (deleted) allocation site we
 * emit `move [snapᵢ, valueᵢ]` into a fresh single-assignment register, and rewrite
 * each read to `move [d, snapᵢ]`. The snapshot captures the value at construction
 * time, so the result is correct even when the source is reassigned afterwards —
 * crucially inside loops, where the per-iteration object is the prize. Copy
 * propagation collapses the snapshot back to a direct move (and DCE drops it) wherever
 * the source is provably unchanged, so the common case costs nothing.
 */
function optScalarReplaceObjectLiterals(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		// C5: a value live across a yield/await is frame-resident; skip for now.
		if (fn.isGenerator || fn.isAsync) {
			continue;
		}
		// C3: `with` / direct `eval` can reach a local without an explicit IR use,
		// so the use scan below would be unsound. `hasDirectEval` is file-scoped, so
		// this conservatively disables the pass for every function in a file that
		// contains a direct eval — acceptable, as direct eval is rare.
		if (functionUsesWith(fn) || fn.semanticFile.hasDirectEval.size > 0) {
			continue;
		}
		changed = foldScalarReplaceableObjectObservationsInFunction(program, fn) || changed;
		changed = scalarReplaceObjectLiteralsInFunction(fn) || changed;
	}
	return changed;
}

interface ScalarReplaceableAllocation {
	allocation: Extract<IRInstruction, { type: "createObject" | "createObjectShaped" }>;
	aliases: Set<number>;
	observations: Set<IRInstruction>;
	comparisonDependencies: Set<ScalarReplaceableAllocation>;
	valid: boolean;
}

/**
 * Fold observations that do not require materializing a fresh ordinary object.
 * The proof deliberately covers the union of the immutable and mutable scalar
 * replacement contracts below. An observation is folded only when every object
 * identity it mentions survives that complete closed-object proof.
 */
function foldScalarReplaceableObjectObservationsInFunction(
	program: IntermediateProgram,
	fn: IRFunction,
): boolean {
	const registerIndex = buildIRRegisterIndex(fn);
	const singleDefinition = registerIndex.uniqueDefinitions;
	const usesOf = registerIndex.uses;
	const facts: Array<ScalarReplaceableAllocation> = [];

	for (const block of fn.blocks) {
		for (const allocation of block.instructions) {
			if (
				(allocation.type !== "createObject" &&
					allocation.type !== "createObjectShaped") ||
				singleDefinition.get(allocation.registers[0]) !== allocation
			) {
				continue;
			}
			const fact: ScalarReplaceableAllocation = {
				allocation,
				aliases: new Set([allocation.registers[0]]),
				observations: new Set(),
				comparisonDependencies: new Set(),
				valid: true,
			};
			const worklist = [allocation.registers[0]];
			while (worklist.length > 0) {
				const alias = worklist.pop()!;
				for (const { instruction: use, position } of usesOf.get(alias) ?? []) {
					if (use.type !== "move" || position !== 1) continue;
					const target = use.registers[0];
					if (singleDefinition.get(target) !== use) {
						fact.valid = false;
						continue;
					}
					if (!fact.aliases.has(target)) {
						fact.aliases.add(target);
						worklist.push(target);
					}
				}
			}
			facts.push(fact);
		}
	}

	const ownerByAlias = new Map<number, ScalarReplaceableAllocation | undefined>();
	for (const fact of facts) {
		for (const alias of fact.aliases) {
			const existing = ownerByAlias.get(alias);
			if (existing === undefined && !ownerByAlias.has(alias)) {
				ownerByAlias.set(alias, fact);
			} else if (existing !== fact) {
				if (existing !== undefined) existing.valid = false;
				fact.valid = false;
				ownerByAlias.set(alias, undefined);
			}
		}
	}

	const constantString = (register: number): number | undefined => {
		const definition = singleDefinition.get(register);
		return definition?.type === "createString" ? definition.stringIndex : undefined;
	};

	for (const fact of facts) {
		const ownKeys = new Set(
			fact.allocation.type === "createObjectShaped"
				? fact.allocation.keyStringIndices
				: [],
		);
		const readKeys: Array<number> = [];
		const storedKeys: Array<number> = [];
		let hasStore = false;

		for (const alias of fact.aliases) {
			for (const { instruction: use, position } of usesOf.get(alias) ?? []) {
				if (
					use.type === "move" &&
					position === 1 &&
					ownerByAlias.get(use.registers[0]) === fact
				) {
					continue;
				}
				if (use.type === "loadProperty" && position === 1) {
					const key = constantString(use.registers[2]);
					if (key === undefined) fact.valid = false;
					else {
						readKeys.push(key);
					}
					continue;
				}
				if (use.type === "storeProperty" && position === 0) {
					const key = constantString(use.registers[1]);
					if (key === undefined) fact.valid = false;
					else {
						hasStore = true;
						storedKeys.push(key);
					}
					continue;
				}
				if (use.type === "unary" && position === 1 && use.operator === "typeof") {
					fact.observations.add(use);
					continue;
				}
				if (use.type === "typeofCompare" && position === 1) {
					fact.observations.add(use);
					continue;
				}
				if (
					use.type === "binary" &&
					(position === 1 || position === 2) &&
					(use.operator === "===" || use.operator === "!==")
				) {
					const other = ownerByAlias.get(use.registers[position === 1 ? 2 : 1]);
					if (other === undefined) fact.valid = false;
					else fact.comparisonDependencies.add(other);
					fact.observations.add(use);
					continue;
				}
				fact.valid = false;
			}
		}

		// Observation folding never relies on a missing-key read: even a key that
		// Object.prototype lacks today could be inherited after arbitrary user code.
		if (readKeys.some((key) => !ownKeys.has(key))) {
			fact.valid = false;
		} else if (!hasStore) {
			if (fact.allocation.type === "createObject" && readKeys.length > 0) {
				fact.valid = false;
			}
		} else {
			for (const key of storedKeys) {
				if (!ownKeys.has(key)) {
					fact.valid = false;
				}
			}
		}
	}

	let invalidated = true;
	while (invalidated) {
		invalidated = false;
		for (const fact of facts) {
			if (
				fact.valid &&
				[...fact.comparisonDependencies].some((dependency) => !dependency.valid)
			) {
				fact.valid = false;
				invalidated = true;
			}
		}
	}

	const replacements = new Map<IRInstruction, IRInstruction>();
	for (const fact of facts) {
		if (!fact.valid) continue;
		for (const observation of fact.observations) {
			if (replacements.has(observation)) continue;
			switch (observation.type) {
				case "unary":
					replacements.set(observation, {
						type: "createString",
						registers: [observation.registers[0]],
						stringIndex: getOrCreateStringConstant(program, "object"),
					});
					break;
				case "typeofCompare":
					replacements.set(observation, {
						type: "createBoolean",
						registers: [observation.registers[0]],
						value: (observation.expected === "object") !== observation.negated,
					});
					break;
				case "binary": {
					const left = ownerByAlias.get(observation.registers[1]);
					const right = ownerByAlias.get(observation.registers[2]);
					if (left === undefined || right === undefined || !left.valid || !right.valid) {
						break;
					}
					const equal = left === right;
					replacements.set(observation, {
						type: "createBoolean",
						registers: [observation.registers[0]],
						value: observation.operator === "===" ? equal : !equal,
					});
					break;
				}
			}
		}
	}
	if (replacements.size === 0) return false;

	for (const block of fn.blocks) {
		block.instructions = block.instructions.map(
			(instruction) => replacements.get(instruction) ?? instruction,
		);
	}
	return true;
}

function scalarReplaceObjectLiteralsInFunction(fn: IRFunction): boolean {
	// Per-register count of defining instructions, and the string index of every
	// register whose sole definition is a `createString` (a usable constant key).
	const defCount = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			const defs = destinationCount(instruction);
			for (let i = 0; i < defs; i++) {
				const register = instruction.registers[i]!;
				defCount.set(register, (defCount.get(register) ?? 0) + 1);
			}
		}
	}

	const constStringIndex = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "createString" &&
				defCount.get(instruction.registers[0]) === 1
			) {
				constStringIndex.set(instruction.registers[0], instruction.stringIndex);
			}
		}
	}

	// Every USE of each register: the instruction plus the operand position. A
	// position below the instruction's destination count is a definition, not a use.
	const usesOf = new Map<
		number,
		Array<{ instruction: IRInstruction; position: number }>
	>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			const defs = destinationCount(instruction);
			for (let position = defs; position < instruction.registers.length; position++) {
				const register = instruction.registers[position]!;
				if (register < 0) {
					continue;
				}
				const list = usesOf.get(register) ?? usesOf.set(register, []).get(register)!;
				list.push({ instruction, position });
			}
		}
	}

	// Each firing record maps to the snapshot moves that replace its allocation;
	// its alias-copy moves become dead and are dropped.
	const snapshotsFor = new Map<
		IRInstruction,
		Array<{ snapshot: number; value: number }>
	>();
	const aliasMovesToDrop = new Set<IRInstruction>();
	let changed = false;

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type !== "createObject" &&
				instruction.type !== "createObjectShaped"
			) {
				continue;
			}
			const objectRegister = instruction.registers[0];
			if (defCount.get(objectRegister) !== 1) {
				continue; // not single-assignment — can't reason about its contents
			}
			const keys =
				instruction.type === "createObjectShaped" ? instruction.keyStringIndices : [];
			// registers = [destination, ...valueRegisters], parallel to keys.
			const valueRegisters = instruction.registers.slice(1);

			// The record may be read directly OR after being copied (once) into a
			// single-assignment register — a move-alias closure. This is what makes the
			// pass work across blocks: copy propagation is intra-block, so a record read
			// in a later block reaches its reads through a `move` (the local slot) rather
			// than the allocation register. Every use across the closure must be a
			// static-own-key `loadProperty` read or a `move` into another
			// single-assignment register (extending the alias set); any other use escapes
			// and leaves the site alone.
			const reads: Array<{ load: IRInstruction; keyIndex: number }> = [];
			const aliasMoves: Array<IRInstruction> = [];
			const aliasSet = new Set<number>([objectRegister]);
			const worklist = [objectRegister];
			let safe = true;
			while (safe && worklist.length > 0) {
				const aliasRegister = worklist.pop()!;
				for (const { instruction: use, position } of usesOf.get(aliasRegister) ?? []) {
					if (use.type === "loadProperty" && position === 1) {
						const stringIndex = constStringIndex.get(use.registers[2]);
						if (stringIndex === undefined) {
							safe = false; // non-constant or multiply-defined key
							break;
						}
						const keyIndex = keys.indexOf(stringIndex);
						if (keyIndex < 0) {
							safe = false; // a key not on the record → would hit the prototype
							break;
						}
						reads.push({ load: use, keyIndex });
					} else if (use.type === "move" && position === 1) {
						// `move [target, alias]` copies the record into `target`. Following it
						// is sound only if `target` is single-assignment (so it always holds
						// the record); its uses are then checked transitively.
						const target = use.registers[0];
						if (defCount.get(target) !== 1) {
							safe = false;
							break;
						}
						if (!aliasSet.has(target)) {
							aliasSet.add(target);
							worklist.push(target);
						}
						aliasMoves.push(use);
					} else {
						safe = false; // escapes / mutated / used as a key — leave the site alone
						break;
					}
				}
			}
			if (!safe) {
				continue;
			}

			// Allocate one snapshot register per distinct read key, rewrite each read
			// into a move from it, and record the snapshot moves that take the
			// allocation's place. Keys never read need no snapshot (their value, if
			// otherwise unused, is dropped by the following DCE pass).
			const snapshotForKey = new Map<number, number>();
			for (const { load, keyIndex } of reads) {
				let snapshot = snapshotForKey.get(keyIndex);
				if (snapshot === undefined) {
					snapshot = fn.nextRegisterDestination++;
					snapshotForKey.set(keyIndex, snapshot);
				}
				// `load` was validated as a `loadProperty`; retype it in place to the
				// structurally-identical `move [destination, snapshot]`.
				const mutable = load as { type: string; registers: Array<number> };
				mutable.registers = [mutable.registers[0]!, snapshot];
				mutable.type = "move";
			}
			snapshotsFor.set(
				instruction,
				[...snapshotForKey].map(([keyIndex, snapshot]) => ({
					snapshot,
					value: valueRegisters[keyIndex]!,
				})),
			);
			// The alias-copy moves now feed only rewritten reads, so they are dead.
			for (const move of aliasMoves) {
				aliasMovesToDrop.add(move);
			}
			changed = true;
		}
	}

	// Replace each firing allocation with its snapshot moves (capturing the values
	// at the construction point) and drop the now-dead alias-copy moves, in place.
	if (snapshotsFor.size > 0) {
		for (const block of fn.blocks) {
			const next: Array<IRInstruction> = [];
			for (const instruction of block.instructions) {
				const snapshots = snapshotsFor.get(instruction);
				if (snapshots !== undefined) {
					for (const { snapshot, value } of snapshots) {
						next.push({ type: "move", registers: [snapshot, value] });
					}
					continue;
				}
				if (aliasMovesToDrop.has(instruction)) {
					continue;
				}
				next.push(instruction);
			}
			block.instructions = next;
		}
	}

	return changed;
}

/**
 * Scalar-replace a non-escaping object that IS mutated — the general (mutable)
 * extension of `optScalarReplaceObjectLiterals` (see docs/roadmaps/gc.md).
 *
 * The immutable pass above eliminates records that are only ever read. This pass
 * handles records that are also *written* (`storeProperty`), the builder /
 * accumulator idiom (`const o = {…}; o.k = …; … o.k …`). The model: give each
 * own key its own **mutable register** ("field register"). A store `o.k = v`
 * becomes `move [fieldₖ, v]`; a read `r = o.k` becomes `move [r, fieldₖ]`; the
 * allocation is deleted and each field register is initialised at the (former)
 * construction site (the literal value, or `undefined` for a key the literal did
 * not declare).
 *
 * Why no phi / merge machinery is needed: the rewrites happen *in place*, so the
 * field register is read and written in exactly the original program order along
 * every path. A control-flow merge leaves the field register holding whatever the
 * last dynamically-executed store wrote — identical to the object's field. This
 * makes the transform correct for arbitrary control flow (branches AND loops: a
 * loop-carried `o.sum += x` becomes a loop-carried `fieldₛᵤₘ = fieldₛᵤₘ + x`).
 *
 * Soundness conditions (any violation ⇒ the object is left as a real allocation):
 *  - the object register is single-assignment (one `createObject`/`createObjectShaped`);
 *  - it has at least one store (else the immutable pass owns it);
 *  - EVERY use, across its single-assignment `move`-alias closure, is a constant
 *    own-key `loadProperty` read (object operand), a constant-key `storeProperty`
 *    write (object operand), or such an alias `move`. Anything else — a dynamic
 *    key, the object as a stored value / call arg / return / `===` operand, a
 *    `delete`, an enumeration — means the identity or full contents escape;
 *  - every key is declared by the literal, hence already an own data property.
 *    A store introducing any new key must perform ordinary [[Set]] because user
 *    code can install an inherited accessor under an arbitrary name.
 *
 * Gating mirrors the immutable pass: skipped under generator/async (a value live
 * across a suspension is frame-resident, C5) and `with`/direct-`eval` (C3).
 */
function optScalarReplaceMutableObjects(program: IntermediateProgram): boolean {
	let changed = false;
	for (const fn of program.functions) {
		if (fn.isGenerator || fn.isAsync) {
			continue;
		}
		if (functionUsesWith(fn) || fn.semanticFile.hasDirectEval.size > 0) {
			continue;
		}
		changed = scalarReplaceMutableObjectsInFunction(program, fn) || changed;
	}
	return changed;
}

function scalarReplaceMutableObjectsInFunction(
	program: IntermediateProgram,
	fn: IRFunction,
): boolean {
	const defCount = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			const defs = destinationCount(instruction);
			for (let i = 0; i < defs; i++) {
				const register = instruction.registers[i]!;
				if (register >= 0) {
					defCount.set(register, (defCount.get(register) ?? 0) + 1);
				}
			}
		}
	}

	// Registers whose sole definition is a `createString` → its string index (a
	// usable constant property key).
	const constStringIndex = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "createString" &&
				defCount.get(instruction.registers[0]) === 1
			) {
				constStringIndex.set(instruction.registers[0], instruction.stringIndex);
			}
		}
	}

	// Every use of each register: instruction + operand position (positions below
	// the destination count are definitions, not uses).
	const usesOf = new Map<
		number,
		Array<{ instruction: IRInstruction; position: number }>
	>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (!("registers" in instruction)) {
				continue;
			}
			const defs = destinationCount(instruction);
			for (let position = defs; position < instruction.registers.length; position++) {
				const register = instruction.registers[position]!;
				if (register < 0) {
					continue;
				}
				const list = usesOf.get(register) ?? usesOf.set(register, []).get(register)!;
				list.push({ instruction, position });
			}
		}
	}

	// In-place rewrites recorded across all objects in this function, applied once
	// at the end. `claimed` prevents two objects from rewriting the same instruction
	// (which would be unsound); the second object to touch it simply bails.
	const replaceAlloc = new Map<IRInstruction, Array<IRInstruction>>();
	const dropInstruction = new Set<IRInstruction>();
	const claimed = new Set<IRInstruction>();
	let changed = false;

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type !== "createObject" &&
				instruction.type !== "createObjectShaped"
			) {
				continue;
			}
			const objectRegister = instruction.registers[0];
			if (defCount.get(objectRegister) !== 1) {
				continue;
			}

			// Literal keys → the value register that initialises each (shaped only).
			const literalKeys =
				instruction.type === "createObjectShaped" ? instruction.keyStringIndices : [];
			const literalValueRegister = new Map<number, number>();
			if (instruction.type === "createObjectShaped") {
				const valueRegisters = instruction.registers.slice(1);
				for (let i = 0; i < literalKeys.length; i++) {
					literalValueRegister.set(literalKeys[i]!, valueRegisters[i]!);
				}
			}
			const literalKeySet = new Set(literalKeys);

			// Walk the object's single-assignment alias closure, classifying every use.
			const reads: Array<{ load: IRInstruction; keyStringIndex: number }> = [];
			const stores: Array<{ store: IRInstruction; keyStringIndex: number }> = [];
			const aliasMoves: Array<IRInstruction> = [];
			const touched: Array<IRInstruction> = [instruction];
			const aliasSet = new Set<number>([objectRegister]);
			const worklist = [objectRegister];
			let safe = true;
			let hasStore = false;

			while (safe && worklist.length > 0) {
				const aliasRegister = worklist.pop()!;
				for (const { instruction: use, position } of usesOf.get(aliasRegister) ?? []) {
					if (use.type === "loadProperty" && position === 1) {
						const keyStringIndex = constStringIndex.get(use.registers[2]);
						if (keyStringIndex === undefined) {
							safe = false;
							break;
						}
						reads.push({ load: use, keyStringIndex });
						touched.push(use);
					} else if (use.type === "storeProperty" && position === 0) {
						const keyStringIndex = constStringIndex.get(use.registers[1]);
						if (keyStringIndex === undefined) {
							safe = false;
							break;
						}
						stores.push({ store: use, keyStringIndex });
						touched.push(use);
						hasStore = true;
					} else if (use.type === "move" && position === 1) {
						const target = use.registers[0];
						if (defCount.get(target) !== 1) {
							safe = false;
							break;
						}
						if (!aliasSet.has(target)) {
							aliasSet.add(target);
							worklist.push(target);
						}
						aliasMoves.push(use);
						touched.push(use);
					} else {
						safe = false; // escapes / mutated via accessor / dynamic key / identity
						break;
					}
				}
			}

			// Only objects that are written; pure-read records are the immutable pass's.
			if (!safe || !hasStore) {
				continue;
			}

			if (
				[...reads, ...stores].some(
					({ keyStringIndex }) => !literalKeySet.has(keyStringIndex),
				)
			) {
				continue;
			}

			// Don't let two objects rewrite the same instruction.
			if (touched.some((i) => claimed.has(i))) {
				continue;
			}

			// A field register per key that is READ (a key only ever written produces a
			// dead store we simply drop). Initialised at the construction site.
			const readKeys = new Set(reads.map((r) => r.keyStringIndex));
			const fieldRegister = new Map<number, number>();
			const init: Array<IRInstruction> = [];
			for (const key of readKeys) {
				const register = fn.nextRegisterDestination++;
				fieldRegister.set(key, register);
				const literalValue = literalValueRegister.get(key);
				if (literalValue !== undefined) {
					init.push({ type: "move", registers: [register, literalValue] });
				} else {
					init.push({ type: "createUndefined", registers: [register] });
				}
			}

			// Rewrite reads → move-from-field, live stores → move-to-field, drop dead
			// stores (a key never read) and the alias copies (now dead).
			for (const { load, keyStringIndex } of reads) {
				const mutable = load as { type: string; registers: Array<number> };
				mutable.registers = [mutable.registers[0]!, fieldRegister.get(keyStringIndex)!];
				mutable.type = "move";
			}
			for (const { store, keyStringIndex } of stores) {
				const register = fieldRegister.get(keyStringIndex);
				if (register === undefined) {
					dropInstruction.add(store); // dead write to a never-read field
					continue;
				}
				const mutable = store as { type: string; registers: Array<number> };
				mutable.registers = [register, mutable.registers[2]!];
				mutable.type = "move";
			}
			for (const move of aliasMoves) {
				dropInstruction.add(move);
			}
			replaceAlloc.set(instruction, init);
			for (const i of touched) {
				claimed.add(i);
			}
			changed = true;
		}
	}

	if (!changed) {
		return false;
	}
	for (const block of fn.blocks) {
		const next: Array<IRInstruction> = [];
		for (const instruction of block.instructions) {
			const init = replaceAlloc.get(instruction);
			if (init !== undefined) {
				next.push(...init);
				continue;
			}
			if (dropInstruction.has(instruction)) {
				continue;
			}
			next.push(instruction);
		}
		block.instructions = next;
	}
	return true;
}

/**
 * Remove side-effect-free instructions whose destination register is never read
 * anywhere in the function. Iterated to a fixpoint per function, so dropping one
 * dead value can expose the instructions that fed it. This cleans up values the
 * front end produced but never consumed (e.g. loads left orphaned once their
 * only reader — a redundant TDZ check — was eliminated) and shrinks both
 * backends' output.
 *
 * A register is "read" wherever it appears as a use. Only a SIDE_EFFECT_FREE op
 * has a known single destination — its `registers[0]` — so only there is the
 * first register excluded from the read set; for every other instruction all
 * registers are treated as uses. That asymmetry is the safety margin: a use is
 * never misclassified as a definition (which would wrongly drop its producer),
 * while at worst a real definition is treated as a use (merely keeping a dead
 * instruction). A side-effect-free instruction whose `registers[0]` is never
 * read is then dead.
 */
function optDeadInstructionElimination(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		let localChanged = true;
		while (localChanged) {
			localChanged = false;

			const read = new Set<number>();
			for (const block of fn.blocks) {
				for (const instruction of block.instructions) {
					if (!("registers" in instruction)) {
						continue;
					}
					// Skip registers[0] only for a side-effect-free op, where it is
					// definitely the (sole) destination; otherwise count every register.
					const firstIsUse = !SIDE_EFFECT_FREE_OPS.has(instruction.type);
					for (let i = 0; i < instruction.registers.length; i++) {
						const register = instruction.registers[i]!;
						if (register >= 0 && (firstIsUse || i > 0)) {
							read.add(register);
						}
					}
				}
			}

			for (const block of fn.blocks) {
				const kept = block.instructions.filter((instruction) => {
					if (
						!SIDE_EFFECT_FREE_OPS.has(instruction.type) ||
						!("registers" in instruction)
					) {
						return true;
					}
					const dst = instruction.registers[0];
					if (dst === undefined || dst < 0 || read.has(dst)) {
						return true;
					}
					localChanged = true;
					changed = true;
					return false;
				});
				if (kept.length !== block.instructions.length) {
					block.instructions = kept;
				}
			}
		}
	}

	return changed;
}

/**
 * Trace down jumps to blocks with only a jump instruction. So we don't jump twice.
 */
function optPatchJumpsToDirectJumpBlocks(program: IntermediateProgram): boolean {
	let changed = false;

	for (const fn of program.functions) {
		const jumpBlockToTarget = new Map<number, number>();

		for (let i = 0; i < fn.blocks.length; i++) {
			const block = fn.blocks[i]!;

			if (block.instructions.length === 1 && block.instructions[0]?.type === "jump") {
				jumpBlockToTarget.set(i, block.instructions[0].blocks[0]);
			}
		}

		// Note that we don't trace through jumpBlockToTarget to compact jump-trains. i.e block 1
		// jumps to 2 and 2 to 3 to compact it as 1 - 3.
		// This is handled by running through the optimizations a few times.
		// At some point we should just handle this tho.

		// Blocks are automatically removed in a different optimization when they are not referenced
		// anymore.

		for (const block of fn.blocks) {
			for (const instr of block.instructions) {
				if ("blocks" in instr) {
					for (let i = 0; i < instr.blocks.length; i++) {
						const targetBlock = instr.blocks[i]!;
						const jumpTarget = jumpBlockToTarget.get(targetBlock);

						// Inline the jump if we have matching target. Self-jumps (e.g. an empty
						// infinite loop) map to themselves; skip them so the fixpoint terminates.
						if (jumpTarget !== undefined && jumpTarget !== targetBlock) {
							instr.blocks[i] = jumpTarget;
							changed = true;
						}
					}
				}
			}
		}
	}

	return changed;
}
