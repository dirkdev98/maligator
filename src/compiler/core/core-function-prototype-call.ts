import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import type { WorldFacts } from "../shared/compiler-facts.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import { primordialNodeAvailable } from "../shared/primordial-catalog.ts";
import type { CoreEditor } from "./core-editor.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export interface CoreFunctionPrototypeCall {
	readonly method: CoreValueId;
	readonly target: CoreValueId;
	readonly thisArgument: CoreValueId | undefined;
	readonly arguments: ReadonlyArray<CoreValueId>;
}

/** A `f.call(thisArg, ...args)` site whose `call` is read from the `f` it calls. */
export function coreFunctionPrototypeCall(
	program: CoreProgram,
	fn: CoreFunctionStore,
	site: CoreInstructionId,
): CoreFunctionPrototypeCall | undefined {
	return coreGuardableCall(fn, site)
		? ownMethodCall(program, fn, site, "call")
		: undefined;
}

export interface CoreBoundFunctionCall extends CoreFunctionPrototypeCall {
	/** The `f.bind(...)` call that created the bound function. */
	readonly creation: CoreInstructionId;
}

/**
 * A call of the function a `f.bind(thisArg, ...bound)` call in the same function
 * returned, whose `bind` is read from `f`. The result describes the call that
 * bound function makes: `f` with `thisArg`, `bound` and then the site's arguments.
 */
export function coreBoundFunctionCall(
	program: CoreProgram,
	fn: CoreFunctionStore,
	site: CoreInstructionId,
): CoreBoundFunctionCall | undefined {
	if (
		fn.instructionKind(site) !== "operation" ||
		fn.instructionOpcodeName(site) !== "call"
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(site);
	const callee = fn.kernel.operandAt(start);
	if (fn.kernel.valueDefinitionKind(callee) !== 1) return undefined;
	const creation = coreInstructionId(fn.kernel.valueDefinitionOwner(callee));
	if (
		fn.instructionKind(creation) !== "operation" ||
		fn.instructionOpcodeName(creation) !== "call" ||
		fn.kernel.instructionResultCount(creation) !== 1 ||
		!coreGuardableCall(fn, site)
	)
		return undefined;
	const bind = ownMethodCall(program, fn, creation, "bind");
	if (bind === undefined) return undefined;
	return {
		...bind,
		creation,
		arguments: [
			...bind.arguments,
			...Array.from({ length: fn.kernel.instructionOperandCount(site) - 2 }, (_, index) =>
				fn.kernel.operandAt(start + 2 + index),
			),
		],
	};
}

function ownMethodCall(
	program: CoreProgram,
	fn: CoreFunctionStore,
	site: CoreInstructionId,
	name: string,
): CoreFunctionPrototypeCall | undefined {
	const count = fn.kernel.instructionOperandCount(site);
	if (count < 2) return undefined;
	const start = fn.kernel.instructionOperandStart(site);
	const method = fn.kernel.operandAt(start);
	const target = fn.kernel.operandAt(start + 1);
	if (fn.kernel.valueDefinitionKind(method) !== 1) return undefined;
	const lookup = coreInstructionId(fn.kernel.valueDefinitionOwner(method));
	if (
		fn.instructionKind(lookup) !== "operation" ||
		fn.instructionOpcodeName(lookup) !== "loadPropertyStatic" ||
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(lookup)) !== target
	)
		return undefined;
	const units =
		program.stringConstants[fn.instructionAttributes(lookup).stringIndex as number];
	if (units === undefined || String.fromCharCode(...units) !== name) return undefined;
	return {
		method,
		target,
		thisArgument: count > 2 ? fn.kernel.operandAt(start + 2) : undefined,
		arguments: Array.from({ length: Math.max(0, count - 3) }, (_, index) =>
			fn.kernel.operandAt(start + 3 + index),
		),
	};
}

/** An ordinary call whose block can be split around it. */
export function coreGuardableCall(
	fn: CoreFunctionStore,
	site: CoreInstructionId,
): boolean {
	return (
		fn.instructionKind(site) === "operation" &&
		fn.instructionOpcodeName(site) === "call" &&
		fn.kernel.instructionResultCount(site) === 1 &&
		fn.instructionAttributes(site)[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] !== true &&
		fn.instructionKind(fn.blockTerminator(fn.instructionBlock(site))) !== "guard"
	);
}

interface GuardedCallSplit {
	readonly append: (
		destination: CoreBlockId,
		opcode: string,
		inputs: ReadonlyArray<CoreValueId>,
		attributes?: Readonly<Record<string, string | number | boolean>>,
	) => CoreValueId;
	/** Branches to the next test, or to the original call, from the block the site was in. */
	readonly test: (condition: CoreValueId) => CoreBlockId;
	readonly finish: (block: CoreBlockId, result: CoreValueId) => void;
	readonly operands: ReadonlyArray<CoreValueId>;
	readonly blocksIntroduced: () => number;
	readonly instructionsIntroduced: () => number;
}

/*
 * Moves the call into a fallback block and the rest of its block into a join; each
 * `test` passes control onward only while its condition holds, so the original call
 * still runs, with its own errors, whenever one fails.
 */
function splitGuardedCall(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
): GuardedCallSplit {
	const block = fn.instructionBlock(site);
	const originalTerminator = fn.blockTerminator(block);
	const sourcePosition = fn.instructionSourcePosition(site);
	const result = fn.kernel.resultAt(fn.kernel.instructionResultStart(site));
	const operandStart = fn.kernel.instructionOperandStart(site);
	const operands = Array.from(
		{ length: fn.kernel.instructionOperandCount(site) },
		(_, index) => fn.kernel.operandAt(operandStart + index),
	);
	const tail: Array<CoreInstructionId> = [];
	for (
		let next = fn.instructionNext(site);
		next !== undefined && next !== originalTerminator;
		next = fn.instructionNext(next)
	)
		tail.push(next);
	const handler = fn.kernel.blockHandlerBlock(block);
	const handlerStart = fn.kernel.blockHandlerArgumentStart(block);
	const handlerArguments = Array.from(
		{ length: handler === undefined ? 0 : fn.kernel.blockHandlerArgumentCount(block) },
		(_, index) => fn.kernel.handlerArgumentAt(handlerStart + index),
	);
	let blocks = 0;
	const create = (parameters: Parameters<CoreEditor["createBlock"]>[0] = []) => {
		const created = editor.createBlock(parameters);
		if (handler !== undefined) editor.setHandler(created, handler, handlerArguments);
		blocks++;
		return created;
	};
	const fallback = create();
	const join = create([{ representation: fn.valueRepresentation(result) }]);
	for (const instruction of tail) editor.moveInstruction(instruction, join);
	editor.replaceValueUses(
		result,
		fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(join)),
	);
	editor.setTerminator(join, {
		...coreTerminatorInput(fn, originalTerminator),
		sourcePosition: fn.instructionSourcePosition(originalTerminator),
	});
	editor.removeInstruction(originalTerminator);
	editor.moveInstruction(site, fallback);
	editor.replaceInstruction(site, "call", operands, {
		attributes: {
			...fn.instructionAttributes(site),
			[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]: true,
		},
		sourcePosition,
		effectRefinement: fn.instructionEffectRefinement(site),
	});
	const finish = (from: CoreBlockId, value: CoreValueId) =>
		editor.setTerminator(from, {
			kind: "jump",
			edge: { block: join, arguments: [value] },
			sourcePosition,
		});
	finish(fallback, result);
	let instructions = 0;
	let current = block;
	return {
		append: (destination, opcode, inputs, attributes = {}) => {
			instructions++;
			return editor.appendInstruction(destination, opcode, inputs, {
				attributes,
				sourcePosition,
				...(opcode.startsWith("guard") ? { outputRepresentations: ["boolean"] } : {}),
			}).outputs[0]!;
		},
		test: (condition) => {
			const next = create();
			editor.setTerminator(current, {
				kind: "branch",
				condition,
				consequent: { block: next, arguments: [] },
				alternate: { block: fallback, arguments: [] },
				sourcePosition,
			});
			current = next;
			return next;
		},
		finish,
		operands,
		blocksIntroduced: () => blocks,
		instructionsIntroduced: () => instructions,
	};
}

/*
 * %Function.prototype.call% only checks that its receiver is callable before calling
 * it, so when the loaded method is the realm's own and `f` is a function the site
 * calls `f` directly; anything else keeps the original call and its TypeError.
 */
export function expandCoreFunctionPrototypeCall(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
	call: CoreFunctionPrototypeCall,
): { readonly instructionsIntroduced: number; readonly blocksIntroduced: number } {
	const block = fn.instructionBlock(site);
	const split = splitGuardedCall(fn, editor, site);
	const intrinsic = split.append(block, "loadIntrinsic", [], {
		intrinsic: "__functionPrototypeCall",
	});
	const callable = split.test(
		split.append(block, "binary", [call.method, intrinsic], { operator: "===" }),
	);
	const direct = split.test(
		split.append(callable, "typeofCompare", [call.target], {
			expected: "function",
			negated: false,
		}),
	);
	const thisArgument = call.thisArgument ?? split.append(direct, "createUndefined", []);
	split.finish(
		direct,
		split.append(direct, "call", [call.target, thisArgument, ...call.arguments]),
	);
	return {
		instructionsIntroduced: split.instructionsIntroduced(),
		blocksIntroduced: split.blocksIntroduced(),
	};
}

const FUNCTION_PROTOTYPE_BIND = "Function.prototype.bind";

/** Whether bound-function calls can compare a loaded `bind` with the realm's own. */
export function coreBoundFunctionCallsAvailable(world: WorldFacts): boolean {
	return (
		world.primordialPolicy === "locked" &&
		primordialNodeAvailable(world, FUNCTION_PROTOTYPE_BIND)
	);
}

/*
 * A bound function's target, `this` and leading arguments are fixed when
 * %Function.prototype.bind% creates it, and calling it calls the target with them
 * ahead of its own arguments. When the loaded `bind` was the realm's own and returned,
 * the target was callable, so the site calls it directly; any other `bind` keeps the
 * original call. The bound function itself stays as created for every other use.
 *
 * The check sits right after the creation rather than at the site, so a bound
 * function created outside a loop and called inside it tests one boolean per call.
 */
export function expandCoreBoundFunctionCall(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
	call: CoreBoundFunctionCall,
): { readonly instructionsIntroduced: number; readonly blocksIntroduced: number } {
	const creationBlock = fn.instructionBlock(call.creation);
	const afterCreation = fn.instructionNext(call.creation);
	const sourcePosition = fn.instructionSourcePosition(call.creation);
	const bind = editor.insertInstruction(
		creationBlock,
		afterCreation,
		"loadPrimordial",
		[],
		{
			attributes: {
				nodeIndex: getPrimordialCatalog().nodes.findIndex(
					(node) => node[0] === FUNCTION_PROTOTYPE_BIND,
				),
				worldAssumptions: {
					...builtinWorldAssumptions(FUNCTION_PROTOTYPE_BIND, "exact-builtin-proof"),
				},
			},
			sourcePosition,
		},
	).outputs[0]!;
	const realmBind = editor.insertInstruction(
		creationBlock,
		afterCreation,
		"binary",
		[call.method, bind],
		{ attributes: { operator: "===" }, sourcePosition },
	).outputs[0]!;
	const split = splitGuardedCall(fn, editor, site);
	const direct = split.test(realmBind);
	const thisArgument = call.thisArgument ?? split.append(direct, "createUndefined", []);
	split.finish(
		direct,
		split.append(direct, "call", [call.target, thisArgument, ...call.arguments]),
	);
	return {
		instructionsIntroduced: split.instructionsIntroduced() + 2,
		blocksIntroduced: split.blocksIntroduced(),
	};
}

/**
 * Calls a closure of `replacement` instead when the callee is a closure of `target`.
 * The replacement must behave like `target` whatever environment it closes over.
 */
export function expandCoreFunctionIndexCall(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
	target: CoreFunctionId,
	replacement: CoreFunctionId,
): void {
	const block = fn.instructionBlock(site);
	const split = splitGuardedCall(fn, editor, site);
	const direct = split.test(
		split.append(block, "guardFunctionIndex", [split.operands[0]!], {
			functionIndex: target,
		}),
	);
	const callee = split.append(direct, "createFunction", [], {
		functionIndex: replacement,
	});
	split.finish(
		direct,
		split.append(direct, "call", [callee, ...split.operands.slice(1)]),
	);
}
