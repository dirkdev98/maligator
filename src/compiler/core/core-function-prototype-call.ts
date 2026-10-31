import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import type { WorldFacts } from "../shared/compiler-facts.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import { primordialNodeAvailable } from "../shared/primordial-catalog.ts";
import type { CoreEditor } from "./core-editor.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import type { CoreNaturalLoop } from "./core-ir-control-flow.ts";
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

export interface CoreAppliedFunctionCall extends CoreFunctionPrototypeCall {
	readonly thisArgument: CoreValueId;
	/** The `apply` lookup, which the check of the loaded method follows. */
	readonly lookup: CoreInstructionId;
	/** The array literal's creation and element definitions, in program order. */
	readonly array: ReadonlyArray<CoreInstructionId>;
}

/** How far after its creation an array literal's `apply` site may be. */
const APPLIED_ARRAY_SCAN_LIMIT = 64;

/**
 * A `f.apply(thisArg, [a, b, ...])` site whose `apply` is read from `f` and whose
 * array literal has no hole and no other use. The literal is created and filled in
 * the site's block, so nothing else can see or change it before `apply` reads it
 * back; the result describes the call `apply` makes: `f` with `thisArg`, `a`, `b`, ...
 */
export function coreAppliedFunctionCall(
	program: CoreProgram,
	fn: CoreFunctionStore,
	site: CoreInstructionId,
): CoreAppliedFunctionCall | undefined {
	if (!coreGuardableCall(fn, site) || fn.kernel.instructionOperandCount(site) !== 4)
		return undefined;
	const call = ownMethodCall(program, fn, site, "apply");
	if (call === undefined) return undefined;
	const thisArgument = call.thisArgument;
	const array = call.arguments[0];
	if (
		thisArgument === undefined ||
		array === undefined ||
		fn.kernel.valueDefinitionKind(array) !== 1 ||
		fn.kernel.valueHandlerUseCount(array) !== 0
	)
		return undefined;
	const creation = coreInstructionId(fn.kernel.valueDefinitionOwner(array));
	if (
		fn.instructionKind(creation) !== "operation" ||
		fn.instructionOpcodeName(creation) !== "createArray" ||
		fn.instructionBlock(creation) !== fn.instructionBlock(site)
	)
		return undefined;
	const length = fn.instructionAttributes(creation).length;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > APPLIED_ARRAY_SCAN_LIMIT
	)
		return undefined;
	const elements = new Map<number, CoreValueId>();
	const definitions = new Set<CoreInstructionId>();
	let siteUses = 0;
	for (let use = fn.kernel.valueFirstUse(array); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		const user = coreInstructionId(fn.kernel.useInstruction(use));
		if (user === site) {
			if (fn.kernel.useOperand(use) !== 3 || ++siteUses > 1) return undefined;
			continue;
		}
		if (fn.kernel.useOperand(use) !== 0) return undefined;
		const element = arrayElementDefinition(fn, user);
		if (element === undefined || element.index >= length || elements.has(element.index))
			return undefined;
		elements.set(element.index, element.value);
		definitions.add(user);
	}
	if (siteUses !== 1 || elements.size !== length) return undefined;
	const ordered = [creation];
	let next = fn.instructionNext(creation);
	for (let scanned = 0; next !== site; scanned++) {
		if (next === undefined || scanned >= APPLIED_ARRAY_SCAN_LIMIT) return undefined;
		if (definitions.has(next)) ordered.push(next);
		next = fn.instructionNext(next);
	}
	if (ordered.length !== length + 1) return undefined;
	const lookup = coreInstructionId(fn.kernel.valueDefinitionOwner(call.method));
	return {
		...call,
		thisArgument,
		lookup,
		array: ordered,
		arguments: Array.from({ length }, (_, index) => elements.get(index)!),
	};
}

/** The index and value an array literal's `CreateDataPropertyOrThrow` defines. */
function arrayElementDefinition(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): { readonly index: number; readonly value: CoreValueId } | undefined {
	if (
		fn.instructionKind(instruction) !== "operation" ||
		fn.instructionOpcodeName(instruction) !== "defineProperty" ||
		fn.kernel.instructionOperandCount(instruction) !== 3
	)
		return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (
		attributes.enumerable !== true ||
		attributes.writable === false ||
		attributes.configurable === false
	)
		return undefined;
	const start = fn.kernel.instructionOperandStart(instruction);
	const key = fn.kernel.operandAt(start + 1);
	if (fn.kernel.valueDefinitionKind(key) !== 1) return undefined;
	const keyDefinition = coreInstructionId(fn.kernel.valueDefinitionOwner(key));
	if (
		fn.instructionKind(keyDefinition) !== "operation" ||
		!["createNumber", "createI32", "createF64"].includes(
			fn.instructionOpcodeName(keyDefinition),
		)
	)
		return undefined;
	const index = fn.instructionAttributes(keyDefinition).value;
	return typeof index === "number" && Number.isSafeInteger(index) && index >= 0
		? { index, value: fn.kernel.operandAt(start + 2) }
		: undefined;
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

const FUNCTION_PROTOTYPE_APPLY = "Function.prototype.apply";
const FUNCTION_PROTOTYPE_BIND = "Function.prototype.bind";

/** Whether bound-function calls can compare a loaded `bind` with the realm's own. */
export function coreBoundFunctionCallsAvailable(world: WorldFacts): boolean {
	return (
		world.primordialPolicy === "locked" &&
		primordialNodeAvailable(world, FUNCTION_PROTOTYPE_BIND)
	);
}

/** Whether `f.apply(...)` sites can compare a loaded `apply` with the realm's own. */
export function coreAppliedFunctionCallsAvailable(world: WorldFacts): boolean {
	return (
		world.primordialPolicy === "locked" &&
		primordialNodeAvailable(world, FUNCTION_PROTOTYPE_APPLY)
	);
}

/*
 * Compares `method` with the realm's primordial right after `after`. A primordial
 * load is an out-of-line call that loop-invariant code motion leaves in place, so it
 * goes to the preheader of the outermost canonical loop around the comparison, if
 * any; it cannot throw for an available primordial under the locked policy.
 */
function insertPrimordialCheck(
	program: CoreProgram,
	fn: CoreFunctionStore,
	editor: CoreEditor,
	after: CoreInstructionId,
	method: CoreValueId,
	primordial: string,
): CoreValueId {
	const block = fn.instructionBlock(after);
	const before = fn.instructionNext(after);
	const sourcePosition = fn.instructionSourcePosition(after);
	let outermost: CoreNaturalLoop | undefined;
	for (const loop of buildCoreControlFlow(program, fn.id).loops)
		if (
			loop.canonical &&
			loop.blocks.has(block) &&
			(outermost === undefined || loop.depth < outermost.depth)
		)
			outermost = loop;
	const preheader = outermost?.preheader;
	const realm = editor.insertInstruction(
		preheader ?? block,
		preheader === undefined ? before : fn.blockTerminator(preheader),
		"loadPrimordial",
		[],
		{
			attributes: {
				nodeIndex: getPrimordialCatalog().nodes.findIndex(
					(node) => node[0] === primordial,
				),
				worldAssumptions: {
					...builtinWorldAssumptions(primordial, "exact-builtin-proof"),
				},
			},
			sourcePosition,
		},
	).outputs[0]!;
	return editor.insertInstruction(block, before, "binary", [method, realm], {
		attributes: { operator: "===" },
		sourcePosition,
	}).outputs[0]!;
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
	program: CoreProgram,
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
	call: CoreBoundFunctionCall,
): { readonly instructionsIntroduced: number; readonly blocksIntroduced: number } {
	const realmBind = insertPrimordialCheck(
		program,
		fn,
		editor,
		call.creation,
		call.method,
		FUNCTION_PROTOTYPE_BIND,
	);
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

/*
 * %Function.prototype.apply% checks that its receiver is callable, reads the array
 * back into an argument list and calls the receiver with it. When the loaded `apply`
 * is the realm's own and `f` is a function, the site calls `f` with the literal's
 * elements, which were evaluated in order before the check. The literal moves into
 * the original call, which still runs, with its own TypeError, for anything else.
 */
export function expandCoreAppliedFunctionCall(
	program: CoreProgram,
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: CoreInstructionId,
	call: CoreAppliedFunctionCall,
): { readonly instructionsIntroduced: number; readonly blocksIntroduced: number } {
	const realmApply = insertPrimordialCheck(
		program,
		fn,
		editor,
		call.lookup,
		call.method,
		FUNCTION_PROTOTYPE_APPLY,
	);
	const split = splitGuardedCall(fn, editor, site);
	const callable = split.test(realmApply);
	const direct = split.test(
		split.append(callable, "typeofCompare", [call.target], {
			expected: "function",
			negated: false,
		}),
	);
	const fallback = fn.instructionBlock(site);
	for (const instruction of call.array)
		editor.moveInstruction(instruction, fallback, site);
	split.finish(
		direct,
		split.append(direct, "call", [call.target, call.thisArgument, ...call.arguments]),
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
