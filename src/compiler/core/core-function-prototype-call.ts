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
	if (!coreGuardableCall(fn, site)) return undefined;
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
	if (units === undefined || String.fromCharCode(...units) !== "call") return undefined;
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
