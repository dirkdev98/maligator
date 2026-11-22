import { coreFunctionId, coreInstructionId, coreOpcodeId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

/**
 * Method names the runtime looks up and calls on program objects without the program
 * naming them: ECMAScript protocols, Web IDL callback interfaces, and the methods C
 * host components fetch and call, directly or through their `*_call_method` helpers.
 * A class method under one of these names always counts as callable. A host component
 * that calls a program method by a new name must add it here.
 */
export const IMPLICITLY_CALLED_METHOD_NAMES: ReadonlySet<string> = new Set([
	// Conversion, JSON and thenables.
	"toString",
	"valueOf",
	"toLocaleString",
	"toJSON",
	"toISOString",
	"join",
	"then",
	"catch",
	"finally",
	// Iterators, RegExp subclasses, species and collection adders.
	"next",
	"return",
	"throw",
	"exec",
	"constructor",
	"resolve",
	"set",
	"has",
	"add",
	"keys",
	// Event listeners and stream sources, sinks, transformers and strategies.
	"handleEvent",
	"start",
	"pull",
	"cancel",
	"transform",
	"flush",
	"size",
	// Node stream subclass hooks and callbacks the C host components fetch and call.
	"_construct",
	"_destroy",
	"_final",
	"_flush",
	"_read",
	"_transform",
	"_write",
	"_writev",
	"SNICallback",
	"completer",
	"dispatchEvent",
	"filter",
	"lookup",
	"off",
	"runInAsyncScope",
	// Methods the C host components call by name.
	"abort",
	"addEventListener",
	"arrayBuffer",
	"close",
	"concat",
	"decode",
	"destroy",
	"emit",
	"encode",
	"end",
	"enqueue",
	"error",
	"from",
	"getMaxListeners",
	"getReader",
	"getWriter",
	"listeners",
	"on",
	"once",
	"parse",
	"pause",
	"pipe",
	"push",
	"read",
	"removeEventListener",
	"removeListener",
	"resume",
	"setMaxListeners",
	"slice",
	"unref",
	"write",
	"writeHead",
]);

// A handler's traps run once the program can construct a Proxy.
const PROXY_TRAP_NAMES: ReadonlySet<string> = new Set([
	"apply",
	"construct",
	"defineProperty",
	"deleteProperty",
	"get",
	"getOwnPropertyDescriptor",
	"getPrototypeOf",
	"has",
	"isExtensible",
	"ownKeys",
	"preventExtensions",
	"set",
	"setPrototypeOf",
]);
const PROXY_OPERATION = /^%?Proxy(?:\.|%?$)/;

// Descriptor writes can make a method enumerable under a key we cannot trace.
const REFLECTIVE_NAMES: ReadonlySet<string> = new Set([
	"Reflect",
	"defineProperty",
	"defineProperties",
	"getOwnPropertyDescriptor",
	"getOwnPropertyDescriptors",
	"__lookupGetter__",
	"__lookupSetter__",
]);
const REFLECTIVE_OPERATION =
	/^%?(?:Reflect(?:\.(?:get(?:OwnPropertyDescriptor)?|defineProperty))?|Object\.(?:getOwnPropertyDescriptors?|definePropert(?:y|ies))|Object\.prototype\.__lookup[GS]etter__)%?$/;

// Operations that read a property under the key in their second operand.
const READS_BY_KEY: ReadonlySet<string> = new Set(["loadProperty", "loadSuperProperty"]);

// These operations carry a string index that names no property they read.
const NAMELESS_STRING_ATTRIBUTES: ReadonlySet<string> = new Set([
	"createObjectShaped",
	"createString",
	"throwIfTdz",
]);

/**
 * Functions whose bodies a closed program can run, starting from `roots`. Calling a
 * function needs its identity, so a body nothing creates never runs. A class method
 * needs more: class evaluation creates it, but its only reference is a non-enumerable
 * property under a string key, so its body runs only once running code can read that
 * key. Running code reads a key by naming it statically (as a member, destructured or
 * literal key, or `super` member), by computing it at runtime, through reflection or
 * `with` scopes, or through the runtime calling it implicitly; an optimized call site
 * that names the method's function also counts. Matching by name rather than by class
 * keeps the rule sound for inheritance and duck typing; anything this scan cannot
 * follow releases every deferred method.
 */
export function coreRunnableFunctions(
	program: CoreProgram,
	roots: Iterable<CoreFunctionId>,
	options: {
		readonly dynamicScope: boolean;
		/** A function's `createFunction` sites, which may include removed instructions. */
		readonly creations?: (fn: CoreFunctionStore) => Iterable<CoreInstructionId>;
	},
): ReadonlySet<CoreFunctionId> {
	const live = new Set<CoreFunctionId>();
	const pending: Array<CoreFunctionId> = [];
	const names = new Set<string>();
	const referenced = new Set<CoreFunctionId>();
	// Methods wait under every key that defines them; any one key read runs them.
	const deferred = new Map<string, Array<CoreFunctionId>>();
	const deferredMethods = new Set<CoreFunctionId>();
	let untraceable = options.dynamicScope;
	let proxies = false;
	const run = (id: CoreFunctionId) => {
		if (live.has(id)) return;
		live.add(id);
		pending.push(id);
	};
	const release = (key: string) => {
		const methods = deferred.get(key);
		if (methods === undefined) return;
		deferred.delete(key);
		for (const method of methods) run(method);
	};
	const releaseAll = () => {
		untraceable = true;
		for (const methods of deferred.values()) for (const method of methods) run(method);
		deferred.clear();
	};
	const name = (text: string) => {
		if (names.has(text)) return;
		names.add(text);
		if (REFLECTIVE_NAMES.has(text)) releaseAll();
		else if (text === "Proxy") constructsProxies();
		else release(text);
	};
	const constructsProxies = () => {
		if (proxies) return;
		proxies = true;
		for (const trap of PROXY_TRAP_NAMES) release(trap);
	};
	const reference = (target: number) => {
		const id = coreFunctionId(target);
		referenced.add(id);
		if (deferredMethods.has(id)) run(id);
	};
	const createFunction = program.registry.get("createFunction")?.id;
	for (const root of roots) run(root);
	while (pending.length > 0) {
		const fn = program.function(pending.pop()!);
		for (const instruction of untraceable && options.creations !== undefined
			? options.creations(fn)
			: fn.instructionIds()) {
			if (!fn.isInstructionLive(instruction)) continue;
			const code = fn.kernel.instructionOpcode(instruction);
			if (code < 0) continue;
			if (coreOpcodeId(code) === createFunction) {
				const target = fn.instructionAttributes(instruction).functionIndex;
				if (typeof target !== "number") continue;
				const id = coreFunctionId(target);
				const key =
					untraceable || live.has(id) || referenced.has(id)
						? undefined
						: methodKey(program, fn, instruction);
				if (key === undefined || names.has(key) || (proxies && PROXY_TRAP_NAMES.has(key)))
					run(id);
				else {
					deferredMethods.add(id);
					const methods = deferred.get(key);
					if (methods === undefined) deferred.set(key, [id]);
					else methods.push(id);
				}
				continue;
			}
			// Once every method runs, names and references decide nothing.
			if (untraceable) continue;
			const opcode = fn.instructionOpcodeName(instruction);
			const attributes = fn.instructionAttributes(instruction);
			if (opcode.startsWith("with")) releaseAll();
			else if (opcode === "createString") {
				if (readAsKey(fn, result(fn, instruction)))
					name(program.stringConstantText(attributes.stringIndex as number));
			} else if (READS_BY_KEY.has(opcode)) {
				if (mayBeStringKey(fn, operand(fn, instruction, 1))) releaseAll();
			} else {
				const operation =
					opcode === "loadIntrinsic"
						? attributes.intrinsic
						: (attributes.operation ??
							(attributes.worldAssumptions as { operation?: unknown } | undefined)
								?.operation);
				if (typeof operation === "string") {
					if (REFLECTIVE_OPERATION.test(operation)) releaseAll();
					else if (PROXY_OPERATION.test(operation)) constructsProxies();
				}
			}
			if (untraceable) continue;
			const nameless = NAMELESS_STRING_ATTRIBUTES.has(opcode);
			for (const attribute in attributes) {
				const value = attributes[attribute];
				if (attribute === "functionIndex" || attribute.endsWith("FunctionIndex")) {
					if (typeof value === "number" && value >= 0) reference(value);
				} else if (nameless) continue;
				else if (attribute === "stringIndex" || attribute.endsWith("StringIndex")) {
					if (typeof value === "number" && value >= 0)
						name(program.stringConstantText(value));
				} else if (attribute.endsWith("StringIndices") && Array.isArray(value)) {
					for (const index of value)
						if (typeof index === "number" && index >= 0)
							name(program.stringConstantText(index));
				}
			}
		}
	}
	return live;
}

function result(fn: CoreFunctionStore, instruction: CoreInstructionId): CoreValueId {
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
}

function operand(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	index: number,
): CoreValueId | undefined {
	if (index >= fn.kernel.instructionOperandCount(instruction)) return undefined;
	return fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
}

function definingOpcode(fn: CoreFunctionStore, value: CoreValueId): string | undefined {
	return fn.kernel.valueDefinitionKind(value) === 1
		? fn.instructionOpcodeName(coreInstructionId(fn.kernel.valueDefinitionOwner(value)))
		: undefined;
}

/** Whether a computed key may convert to a string that names a method. */
function mayBeStringKey(fn: CoreFunctionStore, key: CoreValueId | undefined): boolean {
	if (key === undefined) return true;
	const representation = fn.valueRepresentation(key);
	if (representation === "f64" || representation === "i32") return false;
	const opcode = definingOpcode(fn, key);
	// A string constant key is a static name the createString scan records.
	return opcode !== "createString" && opcode !== "createNumber" && opcode !== "createF64";
}

/**
 * Whether a string constant is the key of a property read. A constant that reaches a
 * key any other way arrives there as a computed key, which releases every method.
 */
function readAsKey(fn: CoreFunctionStore, value: CoreValueId): boolean {
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0 || fn.kernel.useOperand(use) !== 1) continue;
		const header = fn.instructionHeader(fn.kernel.useInstruction(use));
		if (typeof header !== "string" && READS_BY_KEY.has(header.opcode)) return true;
	}
	return false;
}

/**
 * The string key of a class method definition: a created function whose only
 * reference is a non-enumerable data property defined under a constant key. Keys the
 * runtime calls implicitly and canonical numeric keys, which computed number keys
 * reach, have none.
 */
function methodKey(
	program: CoreProgram,
	fn: CoreFunctionStore,
	creation: CoreInstructionId,
): string | undefined {
	const value = result(fn, creation);
	if (fn.kernel.valueHandlerUseCount(value) !== 0) return undefined;
	let definition: CoreInstructionId | undefined;
	for (let use = fn.kernel.valueFirstUse(value); use >= 0; use = fn.kernel.useNext(use)) {
		if (fn.kernel.useLive(use) === 0) continue;
		const instruction = fn.kernel.useInstruction(use);
		const header = fn.instructionHeader(instruction);
		if (
			definition !== undefined ||
			typeof header === "string" ||
			header.opcode !== "defineProperty" ||
			fn.kernel.useOperand(use) !== 2
		)
			return undefined;
		definition = instruction;
	}
	if (
		definition === undefined ||
		fn.instructionAttributes(definition).enumerable !== false
	)
		return undefined;
	const key = operand(fn, definition, 1);
	if (key === undefined || definingOpcode(fn, key) !== "createString") return undefined;
	const { stringIndex } = fn.instructionAttributes(
		coreInstructionId(fn.kernel.valueDefinitionOwner(key)),
	);
	if (typeof stringIndex !== "number") return undefined;
	const text = program.stringConstantText(stringIndex);
	if (
		IMPLICITLY_CALLED_METHOD_NAMES.has(text) ||
		text === "-0" ||
		String(Number(text)) === text
	)
		return undefined;
	return text;
}
