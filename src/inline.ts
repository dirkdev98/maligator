/**
 * Small-function inlining analysis and substitution (see docs/roadmaps/gc.md).
 *
 * Identifies direct and guarded `call` sites whose candidate bodies are safe and
 * cheap to inline, then rewrites them while retaining generic fallbacks wherever
 * target identity is only speculative.
 *
 * Why inline: substituting a local closure's body into the caller lets DCE drop the
 * closure object + its captured `MalEnv` once the closure is otherwise unused — the
 * compiler-based answer to per-activation closure/env garbage that escape analysis
 * cannot reach (the HOF callee is dynamically dispatched). It also exposes cross-call
 * object flow for scalar replacement (T7.4).
 *
 * Conservative v1 target rules (the substitution re-checks): plain `call` only (not
 * construct/spread); callee resolvable to one known target that is not the caller
 * itself (direct self-recursion — deeper cycles are bounded by the substitution's
 * expansion depth); target is not a generator/async, materializes no `arguments`
 * object / rest parameter, owns no captured-slot env, contains no `this` /
 * `new.target` / `with` (caller-relative or dynamic-scope constructs), is free of
 * direct `eval` (C3, file-scoped), and is at most `MAX_INLINE_INSTRUCTIONS` real
 * instructions. Classified `arguments.length` / constant-index reads are admitted:
 * a non-spread call site supplies their exact raw argument values during substitution.
 */

import {
	builtinOperationDescriptor,
	builtinOperations,
	mathUnaryOperationKeys,
} from "./builtin-registry.ts";
import type { MathUnaryOperationKey } from "./builtin-registry.ts";
import type {
	CompilerOptimizationDecision,
	OptimizationDecisionReason,
} from "./compiler-diagnostics.ts";
import {
	compilerGuardPlan,
	compilerFactIsWorldInvariant,
	knownBuiltinCallProves,
	knownFact,
	sourceSiteId,
} from "./compiler-facts.ts";
import { analyzeExactFreshArrayUse } from "./compiler-local-facts.ts";
import { buildIRRegisterIndex } from "./ir-register-index.ts";
import type { IRRegisterIndex } from "./ir-register-index.ts";
import {
	addInlineSourcePosition,
	getOrCreateStringConstant,
	NUMERIC_HOF_INPUT_ACCUMULATOR,
	NUMERIC_HOF_INPUT_ELEMENT,
} from "./ir.ts";
import type {
	IntermediateProgram,
	IRBlock,
	IRFunction,
	IRInstruction,
	IRNumericHofRegion,
	IRNumericHofPlanOperation,
	IRRegion,
} from "./ir.ts";
import { definedRegister } from "./register-alloc.ts";
import { log } from "./utils.ts";

const MATH_UNARY_OPERATION_ID_BY_KEY = new Map(
	mathUnaryOperationKeys.map(([id, key]) => [key, id] as const),
);

/** Max body size (real, non-marker instructions) of an inline target. */
const MAX_INLINE_INSTRUCTIONS = 40;

/** Maximum exact loaded-callee alternatives emitted at one method call site. */
const MAX_METHOD_INLINE_TARGETS = 3;

function recordGuardedBuiltinCall(
	program: IntermediateProgram,
	fn: IRFunction,
	instruction: Extract<IRInstruction, { type: "call" }>,
	operation: string,
	guardOrdinal: number,
	positionId: number | undefined,
): void {
	const position =
		positionId === undefined ? undefined : program.sourcePositions[positionId];
	const positionOwner =
		position?.inlinedFunctionIndex === undefined
			? fn
			: program.functions.find(
					(candidate) => candidate.functionIndex === position.inlinedFunctionIndex,
				);
	const site =
		position === undefined || positionOwner === undefined
			? undefined
			: sourceSiteId(
					positionOwner.semanticFile.path,
					position.line,
					position.column,
					`builtin-call:${operation}`,
				);
	const sharedIdentity = program.facts.builtinIdentities.get(operation);
	const descriptor = builtinOperationDescriptor(operation);
	if (descriptor === undefined) throw new Error(`Unknown builtin operation ${operation}`);
	const identity =
		sharedIdentity?.kind === "known"
			? knownFact(sharedIdentity.value, {
					scope:
						site === undefined
							? { kind: "function", id: fn.functionIndex }
							: { kind: "site", id: site },
					dependencies: sharedIdentity.proof.dependencies,
					obligations: [
						...sharedIdentity.proof.obligations,
						{
							kind: "fallback" as const,
							id: `generic-call:${site ?? `${fn.functionIndex}:${guardOrdinal}`}`,
						},
					],
					origin: `guarded-builtin-site-analysis:${sharedIdentity.proof.origin}`,
				})
			: (sharedIdentity ?? {
					kind: "unknown" as const,
					reason: "not-analyzed" as const,
				});
	instruction.knownBuiltinCall = {
		operation,
		identity,
		semantics:
			identity.kind === "known"
				? knownFact(
						{
							effects: descriptor.effects,
							result: descriptor.result,
							lowerings: descriptor.lowerings,
						},
						{
							...identity.proof,
							origin: `builtin-registry-semantics:${descriptor.id}`,
						},
					)
				: identity,
		...(site === undefined ? {} : { sourceSite: site }),
	};
}

/**
 * Instruction kinds that make a function unsafe to inline as-is: `this` /
 * `new.target` are caller-relative (the callee's binding differs from the caller's),
 * an `arguments` object / rest parameter reflects the callee's own activation, and
 * `with` introduces dynamic scope. (`loadCaptured`/`storeCaptured` are fine: they
 * walk the env chain by owner function index, which a local closure inlined into its
 * definer resolves identically.)
 */
function disqualifies(instruction: IRInstruction): boolean {
	switch (instruction.type) {
		case "loadThis":
		case "loadNewTarget":
		case "loadCallee":
		case "createArgumentsObject":
		case "createRestArguments":
		case "withEnter":
		case "withExit":
		case "withGet":
		case "withResolveBase":
		case "withSet":
			return true;
		default:
			return false;
	}
}

/** Whether a function's body is safe + small enough to inline. */
export function isInlinableTarget(fn: IRFunction): boolean {
	if (fn.isGenerator || fn.isAsync) {
		return false; // suspendable: not a straight-line body
	}
	if (
		fn.argumentsObjectRegister !== undefined &&
		fn.staticArgumentsFallbackRegister === undefined
	) {
		return false; // materializes its own `arguments`
	}
	if ((fn.nextCapturedIndex ?? 0) > 0) {
		return false; // owns a captured-slot env (inner closures capture from it)
	}
	if (fn.semanticFile.hasDirectEval.size > 0) {
		return false; // C3: direct eval can observe locals (file-scoped, conservative)
	}
	let count = 0;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "sourcePos") {
				continue;
			}
			if (disqualifies(instruction)) {
				return false;
			}
			count++;
		}
	}
	return count > 0 && count <= MAX_INLINE_INSTRUCTIONS;
}

/** A captured slot identity: owner function index + slot index, as `owner:index`. */
function capturedSlotKey(owner: number, index: number): string {
	return `${owner}:${index}`;
}

/**
 * Per-function map: register → the functionIndex it provably holds. A register holds
 * a known function when its sole definition is a `createFunction`, a single-assignment
 * `move` chain from one (`const f = () => …`), a `loadCaptured` of a captured slot
 * that `capturedSlots` proves holds one (function declarations + captured local
 * closures bind through the captured env), or a `loadGlobal` of a module/lexical
 * global slot that `globalSlots` proves holds one (top-level functions in module mode
 * — and top-level `let`/`const` closures in script mode — bind through global slots,
 * NOT the dynamic `globalProperty` path, which is reassignable and never resolved).
 * Used to resolve a call's callee.
 */
export function functionValuedRegisters(
	fn: IRFunction,
	capturedSlots: ReadonlyMap<string, number>,
	globalSlots: ReadonlyMap<number, number>,
	registerIndex: IRRegisterIndex = buildIRRegisterIndex(fn),
): Map<number, number> {
	const definitions = registerIndex.definitions;
	const isSingleDefinition = (register: number) =>
		definitions.get(register)?.length === 1;

	const funcOf = new Map<number, number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "createFunction" &&
				isSingleDefinition(instruction.registers[0])
			) {
				funcOf.set(instruction.registers[0], instruction.functionIndex);
			}
		}
	}

	// Propagate through single-assignment moves + resolved captured-slot loads, to a
	// fixpoint (a move may chain off a loadCaptured and vice versa).
	let changed = true;
	while (changed) {
		changed = false;
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type === "move") {
					const destination = instruction.registers[0];
					const source = instruction.registers[1];
					if (
						isSingleDefinition(destination) &&
						funcOf.has(source) &&
						!funcOf.has(destination)
					) {
						funcOf.set(destination, funcOf.get(source)!);
						changed = true;
					}
				} else if (
					instruction.type === "loadCaptured" &&
					instruction.functionIndex !== undefined &&
					instruction.index !== undefined
				) {
					const destination = instruction.registers[0];
					const slot = capturedSlots.get(
						capturedSlotKey(instruction.functionIndex, instruction.index),
					);
					if (
						slot !== undefined &&
						isSingleDefinition(destination) &&
						!funcOf.has(destination)
					) {
						funcOf.set(destination, slot);
						changed = true;
					}
				} else if (instruction.type === "loadGlobal") {
					const destination = instruction.registers[0];
					const slot = globalSlots.get(instruction.index);
					if (
						slot !== undefined &&
						isSingleDefinition(destination) &&
						!funcOf.has(destination)
					) {
						funcOf.set(destination, slot);
						changed = true;
					}
				}
			}
		}
	}
	return funcOf;
}

/**
 * Program-wide: captured slots that provably hold a single known function — written
 * exactly once (across all functions), by a `createFunction`/move value. A slot
 * written more than once, or from a non-function, is excluded. (Resolving the store
 * source uses only createFunction+move, no captured loads, to avoid circularity.)
 */
export interface FunctionSlotFacts {
	captured: Map<string, number>;
	global: Map<number, number>;
}

/** Resolve immutable function-valued captured and global slots in one graph scan.
 * Callers that also need per-function provenance can provide their register indexes,
 * avoiding four identical index builds per function in each inlining pass. */
export function functionSlotFacts(
	program: IntermediateProgram,
	registerIndexes?: ReadonlyMap<IRFunction, IRRegisterIndex>,
): FunctionSlotFacts {
	const empty = new Map<string, number>();
	const emptyGlobals = new Map<number, number>();
	const capturedStores = new Map<string, { func: number | undefined; count: number }>();
	interface GlobalSlotAcc {
		func: number | undefined;
		funcStores: number;
		otherStores: number;
		conflict: boolean;
	}
	const globalStores = new Map<number, GlobalSlotAcc>();
	for (const fn of program.functions) {
		const registerIndex = registerIndexes?.get(fn) ?? buildIRRegisterIndex(fn);
		const localFuncOf = functionValuedRegisters(fn, empty, emptyGlobals, registerIndex);
		const emptyRegisters = createEmptyRegisters(fn, registerIndex);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.type === "storeCaptured" &&
					instruction.functionIndex !== undefined &&
					instruction.index !== undefined
				) {
					const key = capturedSlotKey(instruction.functionIndex, instruction.index);
					const func = localFuncOf.get(instruction.registers[0]);
					const existing = capturedStores.get(key);
					if (existing === undefined) {
						capturedStores.set(key, { func, count: 1 });
					} else {
						existing.count += 1;
					}
				} else if (instruction.type === "storeGlobal") {
					const slot = instruction.index;
					const source = instruction.registers[0];
					let acc = globalStores.get(slot);
					if (acc === undefined) {
						acc = {
							func: undefined,
							funcStores: 0,
							otherStores: 0,
							conflict: false,
						};
						globalStores.set(slot, acc);
					}
					const func = localFuncOf.get(source);
					if (func !== undefined) {
						acc.funcStores += 1;
						if (acc.func === undefined) {
							acc.func = func;
						} else if (acc.func !== func) {
							acc.conflict = true;
						}
					} else if (!emptyRegisters.has(source)) {
						acc.otherStores += 1;
					}
				}
			}
		}
	}
	const captured = new Map<string, number>();
	for (const [key, { func, count }] of capturedStores) {
		if (count === 1 && func !== undefined) {
			captured.set(key, func);
		}
	}
	const global = new Map<number, number>();
	for (const [slot, acc] of globalStores) {
		if (
			acc.func !== undefined &&
			acc.funcStores === 1 &&
			acc.otherStores === 0 &&
			!acc.conflict
		) {
			global.set(slot, acc.func);
		}
	}
	return { captured, global };
}

export function capturedSlotFunctions(program: IntermediateProgram): Map<string, number> {
	return functionSlotFacts(program).captured;
}

/** Registers whose sole definition is a `createEmpty` (the TDZ sentinel a
 * `let`/`const`/class slot is pre-initialized with before its declaration runs).
 * A `storeGlobal` of one is the binding's hoist-time TDZ init, not a value write,
 * so the global-slot resolver ignores it (a real read is still guarded by the
 * `throwIfTdz` the front end emits — kept by DCE — so resolving the callee never
 * skips a temporal-dead-zone throw). */
function createEmptyRegisters(
	fn: IRFunction,
	registerIndex: IRRegisterIndex = buildIRRegisterIndex(fn),
): Set<number> {
	const definitions = registerIndex.definitions;
	const set = new Set<number>();
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (
				instruction.type === "createEmpty" &&
				definitions.get(instruction.registers[0])?.length === 1
			) {
				set.add(instruction.registers[0]);
			}
		}
	}
	return set;
}

/**
 * Program-wide: module/lexical **global slots** (`storeGlobal`/`loadGlobal`, NOT the
 * reassignable `globalProperty` path) that provably hold a single known function.
 *
 * A slot resolves to function F iff, across the whole program, exactly one store to
 * it writes a known function (F) and every other store writes only the TDZ sentinel
 * (`createEmpty`). Any store of a different function, or of a non-function/non-sentinel
 * value (a reassignment — `function f(){}; f = 5` or `let g = a; g = b`), excludes the
 * slot. This is what makes a top-level function declaration in module mode (and a
 * top-level `const f = () => …` in either mode) an inlinable callee: it binds through a
 * closed lexical/module environment that outside code cannot mutate, so a single
 * function store is genuinely single-assignment. (Resolving each store's source uses
 * only createFunction+move chains — no captured/global loads — to avoid circularity.)
 */
export function globalSlotFunctions(program: IntermediateProgram): Map<number, number> {
	return functionSlotFacts(program).global;
}

/**
 * Annotate residual calls and constructions whose callee is proven to be one exact
 * ordinary script closure. This deliberately reuses only the static inliner's
 * immutable provenance: dynamic globals, methods, native/bound/proxy values, and
 * unresolved CommonJS exports never enter `functionValuedRegisters`.
 */
interface IntrinsicDerivedSlotFacts {
	captured: ReadonlySet<string>;
	global: ReadonlySet<number>;
}

/**
 * Find immutable slots whose value is rooted at a compiler intrinsic and reached
 * only through static property loads. This covers aliases such as
 * `const slice = Array.prototype.slice` without claiming anything about dynamic
 * callback parameters, CommonJS call results, bound functions, or proxies. Every
 * mutable property assumption is still validated from the loaded `.call` value at
 * runtime.
 */
function intrinsicDerivedSlotFacts(
	program: IntermediateProgram,
	indexes: ReadonlyMap<IRFunction, IRRegisterIndex> = new Map(
		program.functions.map((fn) => [fn, buildIRRegisterIndex(fn)]),
	),
): IntrinsicDerivedSlotFacts {
	interface StoreSource {
		fn: IRFunction;
		register: number;
	}
	const capturedStores = new Map<string, Array<StoreSource>>();
	const globalStores = new Map<number, Array<StoreSource>>();
	for (const fn of program.functions) {
		const empty = createEmptyRegisters(fn);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.type === "storeCaptured" &&
					instruction.functionIndex !== undefined &&
					instruction.index !== undefined
				) {
					const key = capturedSlotKey(instruction.functionIndex, instruction.index);
					const stores = capturedStores.get(key) ?? [];
					stores.push({ fn, register: instruction.registers[0] });
					capturedStores.set(key, stores);
				} else if (
					instruction.type === "storeGlobal" &&
					!empty.has(instruction.registers[0])
				) {
					const stores = globalStores.get(instruction.index) ?? [];
					stores.push({ fn, register: instruction.registers[0] });
					globalStores.set(instruction.index, stores);
				}
			}
		}
	}

	const captured = new Set<string>();
	const global = new Set<number>();
	const registersFor = (fn: IRFunction): Set<number> => {
		const definitions = indexes.get(fn)!.uniqueDefinitions;
		const registers = new Set<number>();
		let changed = true;
		while (changed) {
			changed = false;
			for (const [register, definition] of definitions) {
				let derived = false;
				switch (definition.type) {
					case "loadIntrinsic":
						derived = true;
						break;
					case "move":
					case "loadPropertyStatic":
						derived = registers.has(definition.registers[1]);
						break;
					case "loadCaptured":
						derived =
							definition.functionIndex !== undefined &&
							definition.index !== undefined &&
							captured.has(capturedSlotKey(definition.functionIndex, definition.index));
						break;
					case "loadGlobal":
						derived = global.has(definition.index);
						break;
				}
				if (derived && !registers.has(register)) {
					registers.add(register);
					changed = true;
				}
			}
		}
		return registers;
	};

	let changed = true;
	while (changed) {
		changed = false;
		const registers = new Map(program.functions.map((fn) => [fn, registersFor(fn)]));
		for (const [key, stores] of capturedStores) {
			if (
				stores.length === 1 &&
				registers.get(stores[0]!.fn)!.has(stores[0]!.register) &&
				!captured.has(key)
			) {
				captured.add(key);
				changed = true;
			}
		}
		for (const [slot, stores] of globalStores) {
			if (
				stores.length === 1 &&
				registers.get(stores[0]!.fn)!.has(stores[0]!.register) &&
				!global.has(slot)
			) {
				global.add(slot);
				changed = true;
			}
		}
	}
	return { captured, global };
}

export function annotateDirectCallTargets(program: IntermediateProgram): number {
	const indexes = new Map(program.functions.map((fn) => [fn, buildIRRegisterIndex(fn)]));
	const { captured: capturedSlots, global: globalSlots } = functionSlotFacts(
		program,
		indexes,
	);
	const intrinsicSlots = intrinsicDerivedSlotFacts(program, indexes);
	const functions = new Map(program.functions.map((fn) => [fn.functionIndex, fn]));
	let functionCallCount = 0;

	for (const fn of program.functions) {
		const registerIndex = indexes.get(fn)!;
		const funcOf = functionValuedRegisters(fn, capturedSlots, globalSlots, registerIndex);
		const definitions = registerIndex.uniqueDefinitions;
		const intrinsicOf = new Set<number>();
		let provenanceChanged = true;
		while (provenanceChanged) {
			provenanceChanged = false;
			for (const [register, definition] of definitions) {
				let derived = false;
				switch (definition.type) {
					case "loadIntrinsic":
						derived = true;
						break;
					case "move":
					case "loadPropertyStatic":
						derived = intrinsicOf.has(definition.registers[1]);
						break;
					case "loadCaptured":
						derived =
							definition.functionIndex !== undefined &&
							definition.index !== undefined &&
							intrinsicSlots.captured.has(
								capturedSlotKey(definition.functionIndex, definition.index),
							);
						break;
					case "loadGlobal":
						derived = intrinsicSlots.global.has(definition.index);
						break;
				}
				if (derived && !intrinsicOf.has(register)) {
					intrinsicOf.add(register);
					provenanceChanged = true;
				}
			}
		}
		const moveRoot = (register: number): number => {
			const seen = new Set<number>();
			while (!seen.has(register)) {
				seen.add(register);
				const definition = definitions.get(register);
				if (definition?.type !== "move") break;
				register = definition.registers[1];
			}
			return register;
		};
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type !== "call" && instruction.type !== "construct") continue;
				const target = funcOf.get(instruction.registers[1]);
				const targetFunction = target === undefined ? undefined : functions.get(target);
				if (
					targetFunction !== undefined &&
					(instruction.type === "call" ||
						(!(targetFunction.isGenerator ?? false) &&
							!(targetFunction.isAsync ?? false) &&
							(targetFunction.hasPrototype ?? true)))
				) {
					instruction.directFunctionIndex = target;
				}
				if (instruction.type !== "call") continue;
				const callee = definitions.get(moveRoot(instruction.registers[1]));
				if (callee?.type !== "loadPropertyStatic") continue;
				const receiver = callee.registers[1];
				const thisValue = instruction.registers[2];
				if (
					decodeStringConstant(program, callee.stringIndex) !== "call" ||
					moveRoot(receiver) !== moveRoot(thisValue)
				) {
					continue;
				}
				const receiverTarget = funcOf.get(thisValue) ?? funcOf.get(receiver);
				if (
					receiverTarget === undefined &&
					!intrinsicOf.has(thisValue) &&
					!intrinsicOf.has(receiver)
				) {
					continue;
				}
				instruction.directFunctionCall = true;
				if (receiverTarget !== undefined && functions.has(receiverTarget)) {
					instruction.directCallTargetFunctionIndex = receiverTarget;
				}
				functionCallCount++;
			}
		}
	}
	return functionCallCount;
}

/**
 * Mark direct `receiver.push(...)` sites for native guarded dense append. The
 * property Get and argument evaluation remain unchanged; this only records that
 * the call consumed that exact loaded method. Bare `this.push(...)` is excluded:
 * it is the common stream-protocol shape and carries no array receiver provenance.
 * Definitely non-array allocation origins are excluded as well. Every admitted
 * unknown value is still speculative and must pass the runtime's exact Array and
 * intrinsic-method guards.
 */
export function annotateDirectArrayPushSites(program: IntermediateProgram): number {
	let count = 0;
	for (const fn of program.functions) {
		let guardOrdinal = 0;
		let positionId: number | undefined;
		const definitions = buildIRRegisterIndex(fn).uniqueDefinitions;
		const provenanceThroughMoves = (
			register: number,
		): { register: number; definition: IRInstruction | undefined } => {
			const seen = new Set<number>();
			while (!seen.has(register)) {
				seen.add(register);
				const definition = definitions.get(register);
				if (definition?.type !== "move") return { register, definition };
				register = definition.registers[1];
			}
			return { register, definition: undefined };
		};

		for (const block of fn.blocks) {
			positionId = undefined;
			for (const instruction of block.instructions) {
				if (instruction.type === "sourcePos") {
					positionId = instruction.pos;
					continue;
				}
				if (instruction.type !== "call") continue;
				const callee = definitions.get(instruction.registers[1]);
				if (callee === undefined) continue;

				let receiver: number;
				let nameStringIndex: number;
				if (callee.type === "loadPropertyStatic") {
					receiver = callee.registers[1];
					nameStringIndex = callee.stringIndex;
				} else if (callee.type === "loadProperty") {
					receiver = callee.registers[1];
					const key = definitions.get(callee.registers[2]);
					if (key?.type !== "createString") continue;
					nameStringIndex = key.stringIndex;
				} else {
					continue;
				}
				const receiverProvenance = provenanceThroughMoves(receiver);
				const thisProvenance = provenanceThroughMoves(instruction.registers[2]);
				if (
					receiverProvenance.register !== thisProvenance.register ||
					decodeStringConstant(program, nameStringIndex) !== "push"
				) {
					continue;
				}

				const origin = receiverProvenance.definition;
				if (
					origin?.type === "loadThis" ||
					origin?.type === "createObject" ||
					origin?.type === "createObjectShaped" ||
					origin?.type === "createFunction"
				) {
					continue;
				}
				recordGuardedBuiltinCall(
					program,
					fn,
					instruction,
					"Array.prototype.push",
					guardOrdinal++,
					positionId,
				);
				count++;
			}
		}
	}
	return count;
}

function annotateDirectPrimitiveStringMethodSites(
	program: IntermediateProgram,
	methodName: "charCodeAt" | "slice" | "split" | "trim",
	operation:
		| "String.prototype.charCodeAt"
		| "String.prototype.slice"
		| "String.prototype.split"
		| "String.prototype.trim",
): number {
	let count = 0;
	for (const fn of program.functions) {
		let guardOrdinal = 0;
		let positionId: number | undefined;
		const definitions = buildIRRegisterIndex(fn).uniqueDefinitions;
		const moveRoot = (initial: number): number => {
			let register = initial;
			const seen = new Set<number>();
			while (!seen.has(register)) {
				seen.add(register);
				const definition = definitions.get(register);
				if (definition?.type !== "move") return register;
				register = definition.registers[1];
			}
			return register;
		};

		for (const block of fn.blocks) {
			positionId = undefined;
			for (const instruction of block.instructions) {
				if (instruction.type === "sourcePos") {
					positionId = instruction.pos;
					continue;
				}
				if (instruction.type !== "call") continue;
				const callee = definitions.get(instruction.registers[1]);
				if (callee === undefined) continue;

				let receiver: number;
				let nameStringIndex: number;
				if (callee.type === "loadPropertyStatic") {
					receiver = callee.registers[1];
					nameStringIndex = callee.stringIndex;
				} else if (callee.type === "loadProperty") {
					receiver = callee.registers[1];
					const key = definitions.get(callee.registers[2]);
					if (key?.type !== "createString") continue;
					nameStringIndex = key.stringIndex;
				} else {
					continue;
				}

				if (
					moveRoot(receiver) !== moveRoot(instruction.registers[2]) ||
					decodeStringConstant(program, nameStringIndex) !== methodName
				) {
					continue;
				}
				recordGuardedBuiltinCall(
					program,
					fn,
					instruction,
					operation,
					guardOrdinal++,
					positionId,
				);
				count++;
			}
		}
	}
	return count;
}

/**
 * Mark direct `receiver.charCodeAt(...)` sites for guarded primitive-String
 * dispatch. The property Get and all arguments remain evaluated normally.
 * Receiver provenance only proves that the loaded method is called with the
 * same `this`; the runtime admits the fast path solely for a primitive String,
 * the live builtin callback, and an absent or numeric position.
 */
export function annotateDirectStringCharCodeAtSites(
	program: IntermediateProgram,
): number {
	return annotateDirectPrimitiveStringMethodSites(
		program,
		"charCodeAt",
		"String.prototype.charCodeAt",
	);
}

/** Canonical identity fact consumed by split projection and cursor regions. */
export function annotateDirectStringSplitSites(program: IntermediateProgram): number {
	return annotateDirectPrimitiveStringMethodSites(
		program,
		"split",
		"String.prototype.split",
	);
}

/** Canonical identity fact consumed by the direct slice-to-Number fusion. */
export function annotateDirectStringSliceSites(program: IntermediateProgram): number {
	return annotateDirectPrimitiveStringMethodSites(
		program,
		"slice",
		"String.prototype.slice",
	);
}

/** Canonical identity fact consumed by closed split-cursor span trimming. */
export function annotateDirectStringTrimSites(program: IntermediateProgram): number {
	return annotateDirectPrimitiveStringMethodSites(
		program,
		"trim",
		"String.prototype.trim",
	);
}

/**
 * Shared namespace/property proof for canonical static intrinsic calls. It
 * records the guarded semantic fact for every recognized method and publishes an
 * exact producer twin only when the intrinsic and property loads are exclusively
 * owned by this call. Locked consumers can then erase both producers without
 * rediscovering the source shape.
 */
function annotateDirectIntrinsicMethodSites(
	program: IntermediateProgram,
	intrinsic: Extract<IRInstruction, { type: "loadIntrinsic" }>["intrinsic"],
	operationByKey: ReadonlyMap<string, string>,
): number {
	let count = 0;
	for (const fn of program.functions) {
		let guardOrdinal = 0;
		let positionId: number | undefined;
		const registerIndex = buildIRRegisterIndex(fn);
		const definitions = registerIndex.uniqueDefinitions;
		const moveRoot = (initial: number): number => {
			let register = initial;
			const seen = new Set<number>();
			while (!seen.has(register)) {
				seen.add(register);
				const definition = definitions.get(register);
				if (definition?.type !== "move") break;
				register = definition.registers[1];
			}
			return register;
		};

		for (const block of fn.blocks) {
			positionId = undefined;
			for (const instruction of block.instructions) {
				if (instruction.type === "sourcePos") {
					positionId = instruction.pos;
					continue;
				}
				if (instruction.type !== "call") continue;
				const callee = definitions.get(instruction.registers[1]);
				if (callee === undefined) continue;

				let receiver: number;
				let nameStringIndex: number;
				if (callee.type === "loadPropertyStatic") {
					receiver = callee.registers[1];
					nameStringIndex = callee.stringIndex;
				} else if (callee.type === "loadProperty") {
					receiver = callee.registers[1];
					const key = definitions.get(callee.registers[2]);
					if (key?.type !== "createString") continue;
					nameStringIndex = key.stringIndex;
				} else {
					continue;
				}

				const receiverRoot = moveRoot(receiver);
				if (receiverRoot !== moveRoot(instruction.registers[2])) continue;
				const origin = definitions.get(receiverRoot);
				if (origin?.type !== "loadIntrinsic" || origin.intrinsic !== intrinsic) continue;
				const operation = operationByKey.get(
					decodeStringConstant(program, nameStringIndex),
				);
				if (operation === undefined) continue;
				recordGuardedBuiltinCall(
					program,
					fn,
					instruction,
					operation,
					guardOrdinal++,
					positionId,
				);
				const calleeUses = registerIndex.uses.get(callee.registers[0]) ?? [];
				const receiverUses = registerIndex.uses.get(receiverRoot) ?? [];
				if (
					callee.type === "loadPropertyStatic" &&
					receiver === receiverRoot &&
					instruction.registers[2] === receiverRoot &&
					calleeUses.length === 1 &&
					calleeUses[0]?.instruction === instruction &&
					calleeUses[0]?.position === 1 &&
					receiverUses.length === 2 &&
					receiverUses.some((use) => use.instruction === callee && use.position === 1) &&
					receiverUses.some(
						(use) => use.instruction === instruction && use.position === 2,
					)
				) {
					instruction.knownBuiltinCallExactProducerTwin = {
						receiver: origin,
						property: callee,
					};
				}
				count++;
			}
		}
	}
	return count;
}

/** Canonical numeric Math facts consumed by locked unboxed lowering. */
export function annotateDirectMathSites(program: IntermediateProgram): number {
	return annotateDirectIntrinsicMethodSites(
		program,
		"Math",
		new Map(
			builtinOperations
				.filter(
					(operation) =>
						operation.owner === "Math" && operation.lowerings.includes("native-number"),
				)
				.map((operation) => [operation.key, operation.id] as const),
		),
	);
}

/** Canonical Object namespace facts consumed by exact locked calls. */
export function annotateDirectObjectSites(program: IntermediateProgram): number {
	return annotateDirectIntrinsicMethodSites(
		program,
		"Object",
		new Map(
			builtinOperations
				.filter(
					(operation) =>
						operation.owner === "Object" &&
						operation.lowerings.includes("exact-builtin-call"),
				)
				.map((operation) => [operation.key, operation.id] as const),
		),
	);
}

/**
 * Attach canonical registry facts to direct `receiver.exec(value)` calls. The
 * receiver remains speculative: capture projection still validates the concrete
 * RegExp brand, own-property absence, callback identity, Realm, input coercion,
 * and lastIndex behavior before bypassing the ordinary call.
 */
export function annotateDirectRegExpExecSites(program: IntermediateProgram): number {
	let count = 0;
	for (const fn of program.functions) {
		let guardOrdinal = 0;
		let positionId: number | undefined;
		const definitions = buildIRRegisterIndex(fn).uniqueDefinitions;
		const moveRoot = (initial: number): number => {
			let register = initial;
			const seen = new Set<number>();
			while (!seen.has(register)) {
				seen.add(register);
				const definition = definitions.get(register);
				if (definition?.type !== "move") break;
				register = definition.registers[1];
			}
			return register;
		};

		for (const block of fn.blocks) {
			positionId = undefined;
			for (const instruction of block.instructions) {
				if (instruction.type === "sourcePos") {
					positionId = instruction.pos;
					continue;
				}
				if (instruction.type !== "call") continue;
				const callee = definitions.get(instruction.registers[1]);
				if (callee === undefined) continue;

				let receiver: number;
				let nameStringIndex: number;
				if (callee.type === "loadPropertyStatic") {
					receiver = callee.registers[1];
					nameStringIndex = callee.stringIndex;
				} else if (callee.type === "loadProperty") {
					receiver = callee.registers[1];
					const key = definitions.get(callee.registers[2]);
					if (key?.type !== "createString") continue;
					nameStringIndex = key.stringIndex;
				} else {
					continue;
				}

				if (
					moveRoot(receiver) !== moveRoot(instruction.registers[2]) ||
					decodeStringConstant(program, nameStringIndex) !== "exec"
				) {
					continue;
				}
				recordGuardedBuiltinCall(
					program,
					fn,
					instruction,
					"RegExp.prototype.exec",
					guardOrdinal++,
					positionId,
				);
				count++;
			}
		}
	}
	return count;
}

/**
 * Mark direct `receiver.get/set/add(...)` calls for guarded native collection
 * dispatch. Property lookup and argument evaluation stay in their original
 * order; unknown receivers remain candidates because the runtime validates both
 * the exact intrinsic callee and the concrete Map/Set brand before bypassing the
 * ordinary cached call seam.
 */
export function annotateDirectCollectionSites(program: IntermediateProgram): number {
	let count = 0;
	for (const fn of program.functions) {
		let guardOrdinal = 0;
		let positionId: number | undefined;
		const definitions = buildIRRegisterIndex(fn).uniqueDefinitions;
		const provenanceThroughMoves = (
			register: number,
		): { register: number; definition: IRInstruction | undefined } => {
			const seen = new Set<number>();
			while (!seen.has(register)) {
				seen.add(register);
				const definition = definitions.get(register);
				if (definition?.type !== "move") return { register, definition };
				register = definition.registers[1];
			}
			return { register, definition: undefined };
		};

		for (const block of fn.blocks) {
			positionId = undefined;
			for (const instruction of block.instructions) {
				if (instruction.type === "sourcePos") {
					positionId = instruction.pos;
					continue;
				}
				if (instruction.type !== "call") continue;
				const callee = definitions.get(instruction.registers[1]);
				if (callee === undefined) continue;

				let receiver: number;
				let nameStringIndex: number;
				if (callee.type === "loadPropertyStatic") {
					receiver = callee.registers[1];
					nameStringIndex = callee.stringIndex;
				} else if (callee.type === "loadProperty") {
					receiver = callee.registers[1];
					const key = definitions.get(callee.registers[2]);
					if (key?.type !== "createString") continue;
					nameStringIndex = key.stringIndex;
				} else {
					continue;
				}

				const receiverProvenance = provenanceThroughMoves(receiver);
				const thisProvenance = provenanceThroughMoves(instruction.registers[2]);
				if (receiverProvenance.register !== thisProvenance.register) continue;

				let operation: "mapGet" | "mapSet" | "setAdd";
				switch (decodeStringConstant(program, nameStringIndex)) {
					case "get":
						operation = "mapGet";
						break;
					case "set":
						operation = "mapSet";
						break;
					case "add":
						operation = "setAdd";
						break;
					default:
						continue;
				}

				const origin = receiverProvenance.definition;
				if (
					origin?.type === "loadThis" ||
					origin?.type === "createArray" ||
					origin?.type === "createObject" ||
					origin?.type === "createObjectShaped" ||
					origin?.type === "createFunction"
				) {
					continue;
				}

				recordGuardedBuiltinCall(
					program,
					fn,
					instruction,
					operation === "mapGet"
						? "Map.prototype.get"
						: operation === "mapSet"
							? "Map.prototype.set"
							: "Set.prototype.add",
					guardOrdinal++,
					positionId,
				);
				count++;
			}
		}
	}
	return count;
}

export interface InlineCandidate {
	/** The `call` instruction in the caller. */
	call: IRInstruction;
	/** functionIndex of the resolved, eligible target. */
	target: number;
}

export interface ProgramInlineCandidates {
	/** Keyed by caller `IRFunction.functionIndex`. */
	byCaller: Map<number, Array<InlineCandidate>>;
}

function staticArgumentsAreSupplied(fn: IRFunction, argumentCount: number): boolean {
	return !fn.blocks.some((block) =>
		block.instructions.some(
			(instruction) =>
				instruction.type === "loadStaticArgument" && instruction.index >= argumentCount,
		),
	);
}

/** Find direct `call` sites across the program whose callee is a statically-known,
 * inlinable function. */
export function findInlinableCalls(
	program: IntermediateProgram,
): ProgramInlineCandidates {
	const targetOf = new Map<number, IRFunction>();
	const registerIndexes = new Map<IRFunction, IRRegisterIndex>();
	for (const fn of program.functions) {
		targetOf.set(fn.functionIndex, fn);
		registerIndexes.set(fn, buildIRRegisterIndex(fn));
	}
	const eligibleCache = new Map<number, boolean>();
	const isEligible = (index: number): boolean => {
		const cached = eligibleCache.get(index);
		if (cached !== undefined) {
			return cached;
		}
		const target = targetOf.get(index);
		const ok = target !== undefined && isInlinableTarget(target);
		eligibleCache.set(index, ok);
		return ok;
	};

	const { captured: capturedSlots, global: globalSlots } = functionSlotFacts(
		program,
		registerIndexes,
	);
	const byCaller = new Map<number, Array<InlineCandidate>>();
	for (const fn of program.functions) {
		const funcOf = functionValuedRegisters(
			fn,
			capturedSlots,
			globalSlots,
			registerIndexes.get(fn),
		);
		const candidates: Array<InlineCandidate> = [];
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type !== "call") {
					continue;
				}
				const calleeRegister = instruction.registers[1];
				const target = funcOf.get(calleeRegister);
				if (target === undefined || target === fn.functionIndex || !isEligible(target)) {
					continue; // unknown callee / direct self-recursion / ineligible target
				}
				if (
					!staticArgumentsAreSupplied(
						targetOf.get(target)!,
						instruction.registers.length - 3,
					)
				) {
					continue;
				}
				candidates.push({ call: instruction, target });
			}
		}
		if (candidates.length > 0) {
			byCaller.set(fn.functionIndex, candidates);
		}
	}
	return { byCaller };
}

// ---------------------------------------------------------------------------
// Speculative (guarded) direct-call inlining — ELIGIBILITY ANALYSIS ONLY.
//
// A call whose callee is loaded from a *reassignable* global (`loadGlobalProperty`,
// i.e. a script-mode top-level `function`) can't be statically resolved — the binding
// might be reassigned — so `findInlinableCalls` skips it. But the compiler still knows
// the *candidate*: the top-level function declaration that initializes that name. A
// runtime guard (`function_index(callee) === F`) makes inlining it sound — a
// reassignment just fails the guard and deopts to the normal call. This pass only
// *detects* such sites (zero miscompile risk); the guarded transform re-checks + guards.
// ---------------------------------------------------------------------------

export interface SpeculativeInlineSite {
	/** The `call` instruction (`[dst, callee, this, ...args]`). */
	call: IRInstruction;
	/** functionIndex of the candidate the callee is speculated to be (guarded at runtime). */
	target: number;
	/** The global name the callee is loaded from (the guard's subject; for diagnostics). */
	nameStringIndex: number;
}

export interface ProgramSpeculativeSites {
	/** Keyed by caller `IRFunction.functionIndex`. */
	byCaller: Map<number, Array<SpeculativeInlineSite>>;
}

/**
 * Whether a function is free of captured-env access, so inlining it into a caller that is
 * NOT its lexical definer stays sound: its free variables must be module globals (resolved
 * identically anywhere), not enclosing-function locals reached via the env chain (which
 * would resolve against the wrong env once spliced elsewhere). A top-level function is
 * always env-independent; the check is defensive.
 */
function isEnvIndependent(fn: IRFunction): boolean {
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "loadCaptured" || instruction.type === "storeCaptured") {
				return false;
			}
		}
	}
	return true;
}

/**
 * Map a global property name to the top-level function declaration that initializes it
 * (`storeGlobalProperty N ← createFunction F`), when unambiguous — the speculative
 * candidate for a `globalProperty` call. A name with two distinct function declarations is
 * ambiguous and omitted. A later reassignment of the name does not disqualify it: the
 * runtime guard handles that (it is the whole point of speculating a reassignable binding).
 */
function globalFunctionDeclarations(program: IntermediateProgram): Map<number, number> {
	const found = new Map<number, number>();
	const ambiguous = new Set<number>();
	for (const fn of program.functions) {
		// A linear per-block last-writer scan, not a function-wide definition index:
		// reuse one destination register across every `createFunction F; storeGlobalProperty
		// N` pair (so the register is multi-def), and the pair is adjacent, so the most
		// recent writer of the store's source is the createFunction that feeds it.
		for (const block of fn.blocks) {
			const lastWriter = new Map<number, IRInstruction>();
			for (const instruction of block.instructions) {
				if (instruction.type === "storeGlobalProperty") {
					const source = lastWriter.get(instruction.registers[0]);
					if (source !== undefined && source.type === "createFunction") {
						const name = instruction.nameStringIndex;
						const existing = found.get(name);
						if (existing !== undefined && existing !== source.functionIndex) {
							ambiguous.add(name);
						} else {
							found.set(name, source.functionIndex);
						}
					}
				}
				const def = definedRegister(instruction);
				if (def !== null) {
					lastWriter.set(def, instruction);
				}
			}
		}
	}
	for (const name of ambiguous) {
		found.delete(name);
	}
	return found;
}

/**
 * Find direct-call sites whose callee is loaded from a reassignable global with a known
 * top-level function declaration F — the sites a `function_index(callee) === F` guard makes
 * inlinable. F must be an env-independent, inlinable-shaped `isInlinableTarget` and not the
 * caller itself (direct self-recursion). Detection only.
 */
/**
 * Calls a guarded substitution (speculative-global or method) has already wrapped — the
 * original call is preserved verbatim on the deopt path, and its callee's loadProperty def
 * survives in the pre-guard code, so re-detecting would re-wrap every fixpoint round. Both
 * the speculative and method analyses exclude these. Keyed on the instruction object.
 */
const guardedInlineSubstituted = new WeakSet<IRInstruction>();

export function findSpeculativeInlineSites(
	program: IntermediateProgram,
): ProgramSpeculativeSites {
	const targetOf = new Map<number, IRFunction>();
	for (const fn of program.functions) {
		targetOf.set(fn.functionIndex, fn);
	}
	const globalDecls = globalFunctionDeclarations(program);
	const eligible = (index: number): boolean => {
		const fn = targetOf.get(index);
		return (
			fn !== undefined &&
			isInlinableTarget(fn) &&
			isEnvIndependent(fn) &&
			(singleReturnBlock(fn) !== null || multiBlockInlinable(fn) !== null)
		);
	};
	const byCaller = new Map<number, Array<SpeculativeInlineSite>>();
	for (const fn of program.functions) {
		const defs = buildIRRegisterIndex(fn).uniqueDefinitions;
		const sites: Array<SpeculativeInlineSite> = [];
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type !== "call" || guardedInlineSubstituted.has(instruction)) {
					continue;
				}
				// A reassignable-global reference reads `globalThis[name]`, i.e. the callee's
				// def is `loadProperty(loadIntrinsic globalThis, createString name)` (see the
				// globalProperty read path in ir.ts). Match that trio.
				const callee = defs.get(instruction.registers[1]);
				if (callee === undefined || callee.type !== "loadProperty") {
					continue;
				}
				const object = defs.get(callee.registers[1]);
				const key = defs.get(callee.registers[2]);
				if (
					object === undefined ||
					object.type !== "loadIntrinsic" ||
					object.intrinsic !== "globalThis" ||
					key === undefined ||
					key.type !== "createString"
				) {
					continue;
				}
				const target = globalDecls.get(key.stringIndex);
				if (target === undefined || target === fn.functionIndex || !eligible(target)) {
					continue; // no candidate / direct self-recursion / not inlinable
				}
				if (
					!staticArgumentsAreSupplied(
						targetOf.get(target)!,
						instruction.registers.length - 3,
					)
				) {
					continue;
				}
				sites.push({ call: instruction, target, nameStringIndex: key.stringIndex });
			}
		}
		if (sites.length > 0) {
			byCaller.set(fn.functionIndex, sites);
		}
	}
	return { byCaller };
}

export function debugSpeculativeInlineSites(program: IntermediateProgram): string {
	const { byCaller } = findSpeculativeInlineSites(program);
	let output = "";
	for (const fn of program.functions) {
		const sites = byCaller.get(fn.functionIndex);
		if (sites === undefined || sites.length === 0) {
			continue;
		}
		output += `fn#${fn.functionIndex}: ${sites.length} speculative call(s) → ${sites
			.map(
				(site) =>
					`${decodeStringConstant(program, site.nameStringIndex)}=#${site.target}`,
			)
			.join(", ")}\n`;
	}
	log.info(output || "(no speculative inline sites)\n");
	return output;
}

// ---------------------------------------------------------------------------
// Loaded-callee-guarded method inlining — analysis and substitution (phase C).
//
// `obj.m(args)` can't be statically resolved (the method lives on obj's runtime prototype),
// but it knows bounded candidate bodies from program method definitions. The real property
// Get remains observable; after argument evaluation, guards select a body from the actual
// loaded callee's function index, inline with `this` = receiver, or call it normally on miss.
// ---------------------------------------------------------------------------

export interface MethodInlineSite {
	/** The `call` instruction (`[dst, callee, this=receiver, ...args]`). */
	call: IRInstruction;
	/** Candidate function indices, guarded against the already-loaded callee. */
	targets: Array<number>;
	/** Register holding the receiver (also the call's `this`). */
	receiverRegister: number;
	/** The method name, for candidate lookup and diagnostics. */
	nameStringIndex: number;
}

export interface ProgramMethodSites {
	byCaller: Map<number, Array<MethodInlineSite>>;
}

/**
 * Constructs that make a *method* unsafe to inline into an arbitrary caller, beyond the
 * shared disqualifiers. `this` is now ALLOWED (the splice maps it to the receiver), but
 * private-field and `super` access are class-relative — a private name / home-object binding
 * doesn't survive relocation out of the class body — so they still disqualify.
 */
function methodDisqualifies(instruction: IRInstruction): boolean {
	switch (instruction.type) {
		case "loadNewTarget":
		case "loadCallee":
		case "createArgumentsObject":
		case "createRestArguments":
		case "withEnter":
		case "withExit":
		case "withGet":
		case "withResolveBase":
		case "withSet":
		case "loadPrivate":
		case "storePrivate":
		case "hasPrivate":
		case "definePrivate":
		case "initPrivateFields":
		case "createPrivateName":
		case "createPrivateNames":
		case "storeSuperProperty":
		case "loadSuperProperty":
		case "checkSuperClass":
		case "guardFunctionIndex":
			return true;
		default:
			return false;
	}
}

/** Like isInlinableTarget but for a method body: `this` is allowed, private/super are not. */
function isInlinableMethodTarget(fn: IRFunction): boolean {
	if (fn.isGenerator || fn.isAsync) {
		return false;
	}
	if (
		fn.argumentsObjectRegister !== undefined &&
		fn.staticArgumentsFallbackRegister === undefined
	) {
		return false;
	}
	if ((fn.nextCapturedIndex ?? 0) > 0) {
		return false;
	}
	if (fn.semanticFile.hasDirectEval.size > 0) {
		return false;
	}
	let count = 0;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "sourcePos") {
				continue;
			}
			if (methodDisqualifies(instruction)) {
				return false;
			}
			count++;
		}
	}
	return count > 0 && count <= MAX_INLINE_INSTRUCTIONS;
}

/**
 * Map a method name to its bounded set of function definitions across the program
 * (`defineProperty(proto, createString name, createFunction F)`). The real property Get
 * remains at each call site; these are only candidate bodies for loaded-callee guards.
 */
function methodDefinitionsByName(
	program: IntermediateProgram,
): Map<number, Array<number>> {
	const found = new Map<number, Array<number>>();
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			const lastWriter = new Map<number, IRInstruction>();
			for (const instruction of block.instructions) {
				if (instruction.type === "defineProperty") {
					const key = lastWriter.get(instruction.registers[1]);
					const value = lastWriter.get(instruction.registers[2]);
					if (
						key !== undefined &&
						key.type === "createString" &&
						value !== undefined &&
						value.type === "createFunction"
					) {
						const name = key.stringIndex;
						const definitions = found.get(name) ?? [];
						if (!definitions.includes(value.functionIndex)) {
							definitions.push(value.functionIndex);
							found.set(name, definitions);
						}
					}
				}
				const def = definedRegister(instruction);
				if (def !== null) {
					lastWriter.set(def, instruction);
				}
			}
		}
	}
	return found;
}

/**
 * Find `obj.m(args)` sites whose method name has bounded, inlinable program definitions.
 * `obj.m()` is a `call` whose callee is
 * `loadProperty(receiver, createString name)` and whose `this` is that same receiver.
 * Detection only.
 */
export function findMethodInlineSites(program: IntermediateProgram): ProgramMethodSites {
	const targetOf = new Map<number, IRFunction>();
	for (const fn of program.functions) {
		targetOf.set(fn.functionIndex, fn);
	}
	const methods = methodDefinitionsByName(program);
	const eligible = (index: number): boolean => {
		const fn = targetOf.get(index);
		return (
			fn !== undefined &&
			!fn.classContext?.isConstructor &&
			(fn.strict ?? fn.semanticFile.strict) &&
			isInlinableMethodTarget(fn) &&
			isEnvIndependent(fn) &&
			multiBlockInlinable(fn) !== null
		);
	};
	const byCaller = new Map<number, Array<MethodInlineSite>>();
	for (const fn of program.functions) {
		const defs = buildIRRegisterIndex(fn).uniqueDefinitions;
		const sites: Array<MethodInlineSite> = [];
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type !== "call" || guardedInlineSubstituted.has(instruction)) {
					continue;
				}
				const callee = defs.get(instruction.registers[1]);
				if (callee === undefined || callee.type !== "loadProperty") {
					continue;
				}
				const receiverRegister = callee.registers[1];
				// A method call binds `this` to the receiver: the call's this (registers[2])
				// is the same register the callee was loaded from.
				if (instruction.registers[2] !== receiverRegister) {
					continue;
				}
				const key = defs.get(callee.registers[2]);
				if (key === undefined || key.type !== "createString") {
					continue;
				}
				const definitions = methods.get(key.stringIndex) ?? [];
				// The guarded substitution already emits one exact-callee branch per target.
				// Reject a globally common name rather than selecting an arbitrary prefix.
				if (definitions.length === 0 || definitions.length > MAX_METHOD_INLINE_TARGETS) {
					continue;
				}
				const targets = definitions
					.filter(
						(target) =>
							target !== fn.functionIndex &&
							eligible(target) &&
							staticArgumentsAreSupplied(
								targetOf.get(target)!,
								instruction.registers.length - 3,
							),
					)
					.slice(0, MAX_METHOD_INLINE_TARGETS);
				if (targets.length === 0) continue;
				sites.push({
					call: instruction,
					targets,
					receiverRegister,
					nameStringIndex: key.stringIndex,
				});
			}
		}
		if (sites.length > 0) {
			byCaller.set(fn.functionIndex, sites);
		}
	}
	return { byCaller };
}

export function debugMethodInlineSites(program: IntermediateProgram): string {
	const { byCaller } = findMethodInlineSites(program);
	let output = "";
	for (const fn of program.functions) {
		const sites = byCaller.get(fn.functionIndex);
		if (sites === undefined || sites.length === 0) {
			continue;
		}
		output += `fn#${fn.functionIndex}: ${sites.length} method call(s) → ${sites
			.map(
				(site) =>
					`${decodeStringConstant(program, site.nameStringIndex)}=${site.targets
						.map((target) => `#${target}`)
						.join("|")}`,
			)
			.join(", ")}\n`;
	}
	log.info(output || "(no method inline sites)\n");
	return output;
}

// ---------------------------------------------------------------------------
// HOF callback inlining — ELIGIBILITY ANALYSIS ONLY (no transformation yet).
//
// `arr.forEach(cb)` / `map` / `filter` … allocate a fresh closure (+ captured
// `MalEnv`) per call and dispatch the callback dynamically inside the builtin, so
// neither escape analysis nor the direct-call inliner can eliminate them (the
// callback is a parameter of the native, not a known callee at the call site). The
// eventual fix is *guarded* inlining: at the call site, runtime-check that `recv`
// is an Array and the resolved method is the intact builtin, then run an inlined
// loop calling `cb` directly (so the direct-call inliner folds `cb`'s body in and
// DCE drops the closure); else fall back to the normal call. This pass only
// *detects* such sites — zero miscompile risk — to validate the premise and feed
// the substitution. See docs/roadmaps/gc.md.
// ---------------------------------------------------------------------------

/**
 * Array iteration methods that take a callback as their first argument and invoke
 * it per element. `reduce`/`reduceRight` are included (their callback is still the
 * first argument; the substitution handles the accumulator shape and only fires with
 * an explicit initial value). All entries here have an inlined loop shape in
 * HOF_METHOD_SPECS — forEach/some/every/find/findIndex/findLast/findLastIndex/map/
 * filter/reduce/reduceRight/flatMap.
 */
const HOF_CALLBACK_METHODS = new Set([
	"forEach",
	"map",
	"filter",
	"some",
	"every",
	"find",
	"findIndex",
	"findLast",
	"findLastIndex",
	"flatMap",
	"reduce",
	"reduceRight",
]);

export interface HofInlineSite {
	/** The `call` instruction (`[dst, callee, recv, callback, ...]`). */
	call: Extract<IRInstruction, { type: "call" }>;
	/** Ordinary property Get that captured the method before argument evaluation. */
	property: Extract<IRInstruction, { type: "loadProperty" }>;
	/** The method name (e.g. "forEach"). */
	method: string;
	/** Register holding the receiver (also the call's `this`). */
	receiverRegister: number;
	/** functionIndex of the resolved, inlinable callback. */
	callbackTarget: number;
}

export interface ProgramHofSites {
	/** Keyed by caller `IRFunction.functionIndex`. */
	byCaller: Map<number, Array<HofInlineSite>>;
}

/**
 * Calls the HOF substitution has already wrapped (the original call is preserved on
 * the slow path). Re-detecting them would re-wrap on the next fixpoint round, so they
 * are excluded from `findHofInlineSites`. Program-lifetime (a wrapped call stays
 * wrapped); keyed on the instruction object, which the substitution reuses verbatim.
 */
const hofSubstitutedCalls = new WeakSet<IRInstruction>();

/** Caller registers that replace captured-slot traffic only while a generated HOF
 * callback call is inlined. The guarded slow call still creates the real closure and
 * uses the authoritative environment. */
const hofCaptureOverrides = new WeakMap<IRInstruction, ReadonlyMap<string, number>>();

/**
 * Decode a string-constant index to a JS string (constants are UTF-16 code-unit
 * arrays; method names are ASCII).
 */
export function decodeStringConstant(
	program: IntermediateProgram,
	index: number,
): string {
	return String.fromCharCode(...program.stringConstants[index]!);
}

/**
 * Find `recv.method(callback[, …])` sites whose method is a known array iteration
 * method and whose callback resolves to an inlinable local function. Detection
 * only — no transformation.
 */
export function findHofInlineSites(program: IntermediateProgram): ProgramHofSites {
	const targetOf = new Map<number, IRFunction>();
	const registerIndexes = new Map<IRFunction, IRRegisterIndex>();
	for (const fn of program.functions) {
		targetOf.set(fn.functionIndex, fn);
		registerIndexes.set(fn, buildIRRegisterIndex(fn));
	}
	const eligibleCache = new Map<number, boolean>();
	const isEligible = (index: number): boolean => {
		const cached = eligibleCache.get(index);
		if (cached !== undefined) {
			return cached;
		}
		const target = targetOf.get(index);
		const ok =
			target !== undefined &&
			isInlinableTarget(target) &&
			!target.blocks.some((block) =>
				block.instructions.some(
					(instruction) =>
						instruction.type === "loadArgumentCount" ||
						instruction.type === "loadArgument" ||
						instruction.type === "loadStaticArgument",
				),
			);
		eligibleCache.set(index, ok);
		return ok;
	};

	const { captured: capturedSlots, global: globalSlots } = functionSlotFacts(
		program,
		registerIndexes,
	);
	const byCaller = new Map<number, Array<HofInlineSite>>();
	for (const fn of program.functions) {
		const registerIndex = registerIndexes.get(fn)!;
		const funcOf = functionValuedRegisters(fn, capturedSlots, globalSlots, registerIndex);
		const defs = registerIndex.uniqueDefinitions;
		const sites: Array<HofInlineSite> = [];
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (instruction.type !== "call" || hofSubstitutedCalls.has(instruction)) {
					continue;
				}
				// call.registers = [destination, callee, this, ...arguments]
				const calleeRegister = instruction.registers[1];
				const thisRegister = instruction.registers[2];
				const callbackRegister = instruction.registers[3];
				if (callbackRegister === undefined) {
					continue; // no callback argument
				}

				// callee must be `loadProperty(recv, key)` with recv === this (method call).
				const calleeDef = defs.get(calleeRegister);
				if (calleeDef === undefined || calleeDef.type !== "loadProperty") {
					continue;
				}
				const receiverRegister = calleeDef.registers[1];
				const keyRegister = calleeDef.registers[2];
				if (receiverRegister !== thisRegister) {
					continue;
				}

				// key must be a string constant naming a known iteration method.
				const keyDef = defs.get(keyRegister);
				if (keyDef === undefined || keyDef.type !== "createString") {
					continue;
				}
				const method = decodeStringConstant(program, keyDef.stringIndex);
				if (!HOF_CALLBACK_METHODS.has(method)) {
					continue;
				}

				// callback must resolve to an inlinable local function.
				const callbackTarget = funcOf.get(callbackRegister);
				if (
					callbackTarget === undefined ||
					callbackTarget === fn.functionIndex ||
					!isEligible(callbackTarget)
				) {
					continue;
				}

				sites.push({
					call: instruction,
					property: calleeDef,
					method,
					receiverRegister,
					callbackTarget,
				});
			}
		}
		if (sites.length > 0) {
			byCaller.set(fn.functionIndex, sites);
		}
	}
	return { byCaller };
}

// ---------------------------------------------------------------------------
// Substitution (transformation). Two shapes: a straight-line single-`return`
// target is spliced in place (no control-flow surgery); a branching/multi-`return`
// target is spliced block-wise (host split + appended blocks + return-join). Both
// rely on the IR invariant that every block ends in an explicit jump/return/throw
// (no positional fall-through), so appended blocks need no fall-through fix-up.
// Inlined source positions are rewrapped into inline-frame markers for stack traces.
// ---------------------------------------------------------------------------

/** Cap on a caller's instruction count to bound inline expansion (mutual recursion
 * etc. inlines a few levels then stops). */
const MAX_CALLER_INSTRUCTIONS = 2000;
/** Guarded method bodies retain the original fallback call. A mutually recursive
 * method graph therefore creates a fresh call site at every inline level unless
 * cloned calls carry an explicit expansion bound. */
const MAX_GUARDED_INLINE_DEPTH = 3;
const partialEscapeInlineBlocked = new WeakSet<IRInstruction>();
const guardedInlineDepth = new WeakMap<IRInstruction, number>();

/**
 * If `fn` is a single straight-line block ending in `return` (no branches, no
 * other terminators, no try/closure constructs), return that block — the only
 * shape v1 substitutes. Returns null otherwise.
 */
function singleReturnBlock(fn: IRFunction): IRBlock | null {
	if (fn.blocks.length !== 1) {
		return null;
	}
	const block = fn.blocks[0]!;
	const instructions = block.instructions;
	const last = instructions[instructions.length - 1];
	if (last === undefined || last.type !== "return") {
		return null;
	}
	for (let i = 0; i < instructions.length - 1; ++i) {
		switch (instructions[i]!.type) {
			case "return":
			case "throw":
			case "jump":
			case "jumpIf":
			case "tryBegin":
			case "tryEnd":
			case "createFunction": // inner closure: creation_env subtleties — defer
				return null;
		}
	}
	return block;
}

const MULTI_BLOCK_TERMINATORS = new Set(["jump", "return", "throw"]);

/**
 * Whether a target with branches/multiple returns is safe to splice block-wise.
 * The body *shape* (no `this`/materialized arguments/`with`/eval/captured env,
 * size-bounded)
 * is already vetted by `isInlinableTarget`; here we additionally require
 * inline-able *control flow*: branch targets are `jump`/`jumpIf` (remappable by a
 * constant block offset) and every block ends in an unconditional terminator —
 * the IR's invariant (no positional fall-through), which lets us append the
 * target's blocks + a join block with no fall-through fix-up. Reject `try`/`catch`
 * (handler-table merge — deferred) and inner closures (`createFunction`
 * creation-env remapping — deferred). Returns the blocks to splice, or null.
 */
function multiBlockInlinable(fn: IRFunction): ReadonlyArray<IRBlock> | null {
	for (const block of fn.blocks) {
		const last = block.instructions[block.instructions.length - 1];
		if (last === undefined || !MULTI_BLOCK_TERMINATORS.has(last.type)) {
			return null; // empty block, or relies on positional fall-through
		}
		for (const instruction of block.instructions) {
			switch (instruction.type) {
				case "tryBegin":
				case "tryEnd":
				case "catch":
				case "createFunction":
					return null;
			}
		}
	}
	return fn.blocks;
}

/**
 * Whether the call at `host[index]` sits inside a try-protected region. Exception
 * handler ranges are `[tryBegin_ip, tryEnd_ip)` over the *flattened* instruction
 * stream (block-array order, see lower-vm `collectExceptionHandlers`). Multi-block
 * inlining appends the spliced blocks after every original block — hence after
 * every `tryEnd` marker — so a relocated throw (explicit, or from any throwing
 * inlined op) would escape the enclosing handler. We therefore refuse to multi-
 * block-inline a protected call. (Single-block inlining splices in place, staying
 * within the range, so it is unaffected.)
 */
function isCallInTry(fn: IRFunction, host: IRBlock, index: number): boolean {
	let depth = 0;
	for (const block of fn.blocks) {
		for (let i = 0; i < block.instructions.length; ++i) {
			if (block === host && i === index) {
				return depth > 0;
			}
			const type = block.instructions[i]!.type;
			if (type === "tryBegin") {
				depth++;
			} else if (type === "tryEnd") {
				depth--;
			}
		}
	}
	return false; // call not found (shouldn't happen): treat as unprotected
}

/**
 * Whether an instruction slice carries a try marker. The block-splicing inliners
 * (multi-block + HOF) relocate the host block's tail after the call to a join block
 * appended at the end of the function. Exception handler ranges are derived from the
 * *flattened* (block-array order) position of tryBegin/tryEnd, so relocating a marker
 * whose pair stays put reorders them → unbalanced ranges (a hard lowering error). We
 * therefore refuse to relocate a tail that contains any try marker.
 */
function containsTryMarker(instructions: ReadonlyArray<IRInstruction>): boolean {
	return instructions.some(
		(instruction) => instruction.type === "tryBegin" || instruction.type === "tryEnd",
	);
}

function hasStackObjectMaterialization(fn: IRFunction): boolean {
	return fn.blocks.some((block) =>
		block.instructions.some(
			(instruction) =>
				instruction.type === "return" &&
				instruction.stackObjectMaterializeSiteId !== undefined,
		),
	);
}

/** Whether control can leave `host` and return to it. A partial-escape target
 * inlined at such a site executes its allocation repeatedly in one activation;
 * the current merge analysis then loses the callee's rare materialization path. */
function blockIsInCycle(fn: IRFunction, host: IRBlock): boolean {
	const hostIndex = fn.blocks.indexOf(host);
	if (hostIndex < 0) return false;
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
		return result;
	});
	const visited = new Set<number>();
	const worklist = [...successors[hostIndex]!];
	while (worklist.length > 0) {
		const blockIndex = worklist.pop()!;
		if (blockIndex === hostIndex) return true;
		if (visited.has(blockIndex)) continue;
		visited.add(blockIndex);
		for (const successor of successors[blockIndex]!) worklist.push(successor);
	}
	return false;
}

/** Clone an instruction with every register operand shifted by `offset` (negative
 * sentinels are left as-is). Non-register fields (functionIndex, index, stringIndex,
 * value, blocks, …) are preserved — in particular `loadCaptured`/`storeCaptured`
 * keep their owner/slot, so captured access resolves identically once the closure's
 * body runs against its definer's env. */
function withRegisterOffset(instruction: IRInstruction, offset: number): IRInstruction {
	if (!("registers" in instruction)) {
		return { ...instruction };
	}
	const registers = (instruction.registers as ReadonlyArray<number>).map((r) =>
		r >= 0 ? r + offset : r,
	);
	return { ...instruction, registers } as IRInstruction;
}

function inlineInstruction(
	instruction: IRInstruction,
	offset: number,
	args: ReadonlyArray<number>,
	captureOverrides?: ReadonlyMap<string, number>,
): IRInstruction {
	if (
		(instruction.type === "loadCaptured" || instruction.type === "storeCaptured") &&
		instruction.functionIndex !== undefined &&
		instruction.index !== undefined
	) {
		const shadow = captureOverrides?.get(
			capturedSlotKey(instruction.functionIndex, instruction.index),
		);
		if (shadow !== undefined) {
			return instruction.type === "loadCaptured"
				? { type: "move", registers: [instruction.registers[0] + offset, shadow] }
				: { type: "move", registers: [shadow, instruction.registers[0] + offset] };
		}
	}
	if (instruction.type === "loadArgumentCount") {
		return {
			type: "createNumber",
			registers: [instruction.registers[0] + offset],
			value: args.length,
		};
	}
	if (instruction.type === "loadArgument") {
		const destination = instruction.registers[0] + offset;
		return instruction.index < args.length
			? { type: "move", registers: [destination, args[instruction.index]!] }
			: { type: "createUndefined", registers: [destination] };
	}
	if (instruction.type === "loadStaticArgument") {
		return {
			type: "move",
			registers: [instruction.registers[0] + offset, instruction.registers[2] + offset],
		};
	}
	const cloned = withRegisterOffset(instruction, offset);
	const depth = guardedInlineDepth.get(instruction);
	if (depth !== undefined && cloned.type === "call") {
		guardedInlineDepth.set(cloned, depth);
	}
	return cloned;
}

/**
 * Rewrap an inlined instruction's source position so it reads as the inlined
 * function's frame, called at `callerPosId`. Recurses through an existing inline
 * chain (nested inlining), replacing the terminal leaf — the inlined function's own
 * position — with the call-site link, so the formatter expands one frame per level.
 */
function wrapInlinePosition(
	program: IntermediateProgram,
	posId: number,
	inlinedFunctionIndex: number,
	callerPosId: number,
): number {
	if (posId < 0) {
		return callerPosId; // no position: inlined code inherits the call-site frame
	}
	const pos = program.sourcePositions[posId]!;
	if (pos.inlinedFunctionIndex === undefined) {
		return addInlineSourcePosition(
			program,
			pos.line,
			pos.column,
			inlinedFunctionIndex,
			callerPosId,
		);
	}
	const extended = wrapInlinePosition(
		program,
		pos.callerPosId!,
		inlinedFunctionIndex,
		callerPosId,
	);
	return addInlineSourcePosition(
		program,
		pos.line,
		pos.column,
		pos.inlinedFunctionIndex,
		extended,
	);
}

/**
 * Emit a target function's blocks for inlining at a call site: register operands shifted
 * by `offset`, the callee's `this` reads mapped to `thisSource` (a caller register, or a
 * synthesized `undefined` when null), every `return` converted to move-into-`destination`
 * (when >= 0) + jump to `joinIndex`, and intra-target branch targets shifted by
 * `blockBase`. The parameter binding (args → param registers, missing → undefined) is
 * prepended to the first block, so the caller only appends these blocks and routes control
 * to `blockBase`.
 *
 * Shared by the unconditional multi-block inliner and the guarded (speculative) inliner;
 * `targetBlocks` must be `multiBlockInlinable(target)` (every block ends in an explicit
 * jump/return/throw, no try/closure markers). The `this` mapping is dormant until a target
 * that reads `this` is admitted (method inlining) — plain-call inlining passes `null`.
 */
function buildInlinedBlocks(
	program: IntermediateProgram,
	target: IRFunction,
	targetBlocks: ReadonlyArray<IRBlock>,
	args: ReadonlyArray<number>,
	thisSource: number | null,
	destination: number,
	offset: number,
	callSitePos: number,
	blockBase: number,
	joinIndex: number,
	captureOverrides?: ReadonlyMap<string, number>,
	instructionMap?: Map<IRInstruction, IRInstruction>,
): Array<IRBlock> {
	const rewrap = (
		instruction: Extract<IRInstruction, { type: "sourcePos" }>,
	): IRInstruction => ({
		type: "sourcePos",
		pos: wrapInlinePosition(program, instruction.pos, target.functionIndex, callSitePos),
	});
	const setup: Array<IRInstruction> = [];
	for (let i = 0; i < target.parameterCount; ++i) {
		const paramRegister = offset + i;
		setup.push(
			i < args.length
				? { type: "move", registers: [paramRegister, args[i]!] }
				: { type: "createUndefined", registers: [paramRegister] },
		);
	}
	const out: Array<IRBlock> = [];
	targetBlocks.forEach((tblock, blockIdx) => {
		const instructions: Array<IRInstruction> = blockIdx === 0 ? [...setup] : [];
		const append = (source: IRInstruction, cloned: IRInstruction) => {
			instructions.push(cloned);
			instructionMap?.set(source, cloned);
		};
		for (const instruction of tblock.instructions) {
			if (instruction.type === "sourcePos") {
				append(instruction, rewrap(instruction));
				continue;
			}
			if (instruction.type === "return") {
				const returnRegister = instruction.registers[0];
				if (destination >= 0) {
					append(instruction, {
						type: "move",
						registers: [
							destination,
							returnRegister >= 0 ? returnRegister + offset : returnRegister,
						],
					});
				}
				const exit = { type: "jump" as const, blocks: [joinIndex] as [number] };
				instructions.push(exit);
				if (!instructionMap?.has(instruction)) instructionMap?.set(instruction, exit);
				break; // terminator: the rest of this block is dead
			}
			if (instruction.type === "throw") {
				append(instruction, withRegisterOffset(instruction, offset));
				break;
			}
			if (instruction.type === "jump") {
				append(instruction, {
					type: "jump",
					blocks: [instruction.blocks[0] + blockBase],
				});
				break;
			}
			if (instruction.type === "jumpIf") {
				const condition = instruction.registers[0];
				append(instruction, {
					type: "jumpIf",
					registers: [condition >= 0 ? condition + offset : condition],
					blocks: [instruction.blocks[0] + blockBase],
				});
				continue;
			}
			if (instruction.type === "loadThis") {
				// `this` in the callee resolves to the receiver at the call site (undefined
				// for a plain call) — read `thisSource` instead of the callee's activation.
				const dst = offset + instruction.registers[0];
				append(
					instruction,
					thisSource === null
						? { type: "createUndefined", registers: [dst] }
						: { type: "move", registers: [dst, thisSource] },
				);
				continue;
			}
			append(instruction, inlineInstruction(instruction, offset, args, captureOverrides));
		}
		out.push({ instructions });
	});
	return out;
}

/** Clone one target-owned proof region alongside a multi-block inline. Region
 * instruction identity is part of the certificate, so cloning code without
 * rebasing this table would silently strand every anchor in the emptied callee. */
function cloneInlinedRegion(
	region: IRRegion,
	instructionMap: ReadonlyMap<IRInstruction, IRInstruction>,
	blockBase: number,
): IRRegion | undefined {
	const mapInstruction = <T extends IRInstruction>(instruction: T): T | undefined =>
		instructionMap.get(instruction) as T | undefined;
	const anchors = region.anchors.map((instruction) => mapInstruction(instruction));
	const claimedInstructions = region.claimedInstructions.map((instruction) =>
		mapInstruction(instruction),
	);
	if (
		anchors.some((instruction) => instruction === undefined) ||
		claimedInstructions.some((instruction) => instruction === undefined)
	) {
		return undefined;
	}
	const common = {
		...region,
		anchors: anchors as ReadonlyArray<IRInstruction>,
		claimedInstructions: claimedInstructions as ReadonlyArray<IRInstruction>,
		controlFlow: {
			ordinaryBlocks: region.controlFlow.ordinaryBlocks.map((block) => block + blockBase),
			exceptionalBlocks: region.controlFlow.exceptionalBlocks.map(
				(block) => block + blockBase,
			),
		},
	};
	switch (region.kind) {
		case "finite-object-construction": {
			const accesses = region.accesses.map((instruction) => mapInstruction(instruction));
			if (accesses.some((instruction) => instruction === undefined)) return undefined;
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				accesses: accesses as typeof region.accesses,
			} as unknown as Extract<IRRegion, { kind: "finite-object-construction" }>;
		}
		case "numeric-fusion": {
			const pairs = region.pairs.map((pair) => ({
				...pair,
				first: mapInstruction(pair.first),
				finish: mapInstruction(pair.finish),
			}));
			if (pairs.some((pair) => pair.first === undefined || pair.finish === undefined)) {
				return undefined;
			}
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				pairs: pairs as typeof region.pairs,
			} as unknown as Extract<IRRegion, { kind: "numeric-fusion" }>;
		}
		case "cardinality-array": {
			const accesses = region.accesses.map((access) => ({
				...access,
				instruction: mapInstruction(access.instruction),
			}));
			if (accesses.some((access) => access.instruction === undefined)) {
				return undefined;
			}
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				accesses: accesses as typeof region.accesses,
			} as unknown as Extract<IRRegion, { kind: "cardinality-array" }>;
		}
		case "closed-record-array": {
			const elementLoads = region.elementLoads.map((instruction) =>
				mapInstruction(instruction),
			);
			const accesses = region.accesses.map((access) => ({
				...access,
				instruction: mapInstruction(access.instruction),
			}));
			if (
				elementLoads.some((instruction) => instruction === undefined) ||
				accesses.some((access) => access.instruction === undefined)
			) {
				return undefined;
			}
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				elementLoads: elementLoads as typeof region.elementLoads,
				accesses: accesses as typeof region.accesses,
			} as unknown as Extract<IRRegion, { kind: "closed-record-array" }>;
		}
		case "string-split-projection": {
			const property =
				region.property === undefined ? undefined : mapInstruction(region.property);
			const aliasMoves = region.aliasMoves.map((instruction) =>
				mapInstruction(instruction),
			);
			const loads = region.loads.map((load) => ({
				...load,
				instruction: mapInstruction(load.instruction),
			}));
			if (
				(region.property !== undefined && property === undefined) ||
				aliasMoves.some((instruction) => instruction === undefined) ||
				loads.some((load) => load.instruction === undefined)
			) {
				return undefined;
			}
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				...(property === undefined ? {} : { property }),
				aliasMoves: aliasMoves as typeof region.aliasMoves,
				loads: loads as typeof region.loads,
			} as unknown as Extract<IRRegion, { kind: "string-split-projection" }>;
		}
		case "regexp-exec-projection": {
			const property = mapInstruction(region.property);
			const aliasMoves = region.aliasMoves.map((instruction) =>
				mapInstruction(instruction),
			);
			const nullChecks = region.nullChecks.map((check) => ({
				comparison: mapInstruction(check.comparison),
				nullValue: mapInstruction(check.nullValue),
			}));
			const lockedLiteral =
				region.lockedLiteral === undefined
					? undefined
					: {
							constructorIntrinsic: mapInstruction(
								region.lockedLiteral.constructorIntrinsic,
							),
							construct: mapInstruction(region.lockedLiteral.construct),
						};
			const loads = region.loads.map((load) => {
				const consumer = load.consumer;
				return {
					...load,
					instruction: mapInstruction(load.instruction),
					key: mapInstruction(load.key),
					consumer:
						consumer === undefined
							? undefined
							: consumer.kind === "length"
								? { ...consumer, property: mapInstruction(consumer.property) }
								: consumer.kind === "charCodeAtZero"
									? {
											...consumer,
											property: mapInstruction(consumer.property),
											call: mapInstruction(consumer.call),
											...(consumer.zero === undefined
												? {}
												: { zero: mapInstruction(consumer.zero) }),
										}
									: consumer.kind === "number"
										? {
												...consumer,
												intrinsic: mapInstruction(consumer.intrinsic),
												call: mapInstruction(consumer.call),
											}
										: {
												...consumer,
												upperProperty: mapInstruction(consumer.upperProperty),
												upperCall: mapInstruction(consumer.upperCall),
												lowerProperty: mapInstruction(consumer.lowerProperty),
												lowerCall: mapInstruction(consumer.lowerCall),
												resultMoves: consumer.resultMoves.map((move) =>
													mapInstruction(move),
												),
												lengthProperty: mapInstruction(consumer.lengthProperty),
											},
				};
			});
			if (
				property === undefined ||
				aliasMoves.some((instruction) => instruction === undefined) ||
				nullChecks.some(
					(check) => check.comparison === undefined || check.nullValue === undefined,
				) ||
				(lockedLiteral !== undefined &&
					(lockedLiteral.constructorIntrinsic === undefined ||
						lockedLiteral.construct === undefined)) ||
				loads.some(
					(load) =>
						load.instruction === undefined ||
						load.key === undefined ||
						(load.consumer !== undefined &&
							Object.values(load.consumer).some((value) => value === undefined)) ||
						(load.consumer?.kind === "asciiCaseLength" &&
							load.consumer.resultMoves.some((move) => move === undefined)),
				)
			) {
				return undefined;
			}
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				property,
				aliasMoves,
				nullChecks,
				...(lockedLiteral === undefined ? {} : { lockedLiteral }),
				loads,
			} as unknown as Extract<IRRegion, { kind: "regexp-exec-projection" }>;
		}
		case "regexp-iterator-projection": {
			const doneBranch = mapInstruction(region.doneBranch);
			const aliasMoves = region.aliasMoves.map((instruction) =>
				mapInstruction(instruction),
			);
			const loads = region.loads.map((load) => ({
				...load,
				instruction: mapInstruction(load.instruction),
				key: mapInstruction(load.key),
				numberIntrinsic: mapInstruction(load.numberIntrinsic),
				numberCall: mapInstruction(load.numberCall),
			}));
			if (
				doneBranch === undefined ||
				aliasMoves.some((instruction) => instruction === undefined) ||
				loads.some(
					(load) =>
						load.instruction === undefined ||
						load.key === undefined ||
						load.numberIntrinsic === undefined ||
						load.numberCall === undefined,
				)
			) {
				return undefined;
			}
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				doneBranch,
				exitBlock: region.exitBlock + blockBase,
				aliasMoves,
				loads,
			} as unknown as Extract<IRRegion, { kind: "regexp-iterator-projection" }>;
		}
		case "string-slice-number": {
			const property = mapInstruction(region.property);
			const numberIntrinsic = mapInstruction(region.numberIntrinsic);
			const numberCall = mapInstruction(region.numberCall);
			if (
				property === undefined ||
				numberIntrinsic === undefined ||
				numberCall === undefined
			) {
				return undefined;
			}
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				property,
				numberIntrinsic,
				numberCall,
			} as unknown as Extract<IRRegion, { kind: "string-slice-number" }>;
		}
		case "string-split-cursor": {
			const property =
				region.property === undefined ? undefined : mapInstruction(region.property);
			const compare = mapInstruction(region.compare);
			const element = mapInstruction(region.element);
			const trimProperty = mapInstruction(region.trimProperty);
			const trimCall = mapInstruction(region.trimCall);
			const primitiveStringLengths = region.primitiveStringLengths.map((instruction) =>
				mapInstruction(instruction),
			);
			if (
				(region.property !== undefined && property === undefined) ||
				compare === undefined ||
				element === undefined ||
				trimProperty === undefined ||
				trimCall === undefined ||
				primitiveStringLengths.some((instruction) => instruction === undefined)
			) {
				return undefined;
			}
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				...(property === undefined ? {} : { property }),
				compare,
				element,
				trimProperty,
				trimCall,
				primitiveStringLengths:
					primitiveStringLengths as typeof region.primitiveStringLengths,
				exitBlock: region.exitBlock + blockBase,
			} as unknown as Extract<IRRegion, { kind: "string-split-cursor" }>;
		}
		case "numeric-hof": {
			const dispatch =
				region.dispatch.kind === "guarded"
					? {
							kind: "guarded" as const,
							eligibility: mapInstruction(region.dispatch.eligibility),
							slowCall: mapInstruction(region.dispatch.slowCall),
						}
					: {
							kind: "closed" as const,
							receiverAllocation: mapInstruction(region.dispatch.receiverAllocation),
						};
			if (
				(dispatch.kind === "guarded" &&
					(dispatch.eligibility === undefined || dispatch.slowCall === undefined)) ||
				(dispatch.kind === "closed" && dispatch.receiverAllocation === undefined)
			) {
				return undefined;
			}
			return {
				...common,
				kind: region.kind,
				anchors: common.anchors as typeof region.anchors,
				dispatch: dispatch as typeof region.dispatch,
			} as unknown as Extract<IRRegion, { kind: "numeric-hof" }>;
		}
	}
}

/** Total real (non-marker) instruction count of a function. */
function instructionCount(fn: IRFunction): number {
	let count = 0;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type !== "sourcePos") {
				count += 1;
			}
		}
	}
	return count;
}

function instructionPosition(fn: IRFunction, target: IRInstruction): number {
	let position = -1;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "sourcePos") position = instruction.pos;
			else if (instruction === target) return position;
		}
	}
	return -1;
}

function recordInlineDecision(
	program: IntermediateProgram,
	fn: IRFunction,
	call: IRInstruction,
	outcome: "applied" | "declined",
	reason: OptimizationDecisionReason | "inline" | "guarded-inline",
): void {
	const decisions = program.optimizationDecisions;
	if (decisions === undefined) return;
	const positionId = instructionPosition(fn, call);
	const code: CompilerOptimizationDecision["code"] =
		outcome === "applied"
			? `optimization.applied.${reason}`
			: `optimization.declined.${reason as OptimizationDecisionReason}`;
	if (
		decisions.some(
			(decision) =>
				decision.functionIndex === fn.functionIndex &&
				decision.positionId === positionId &&
				decision.code === code,
		)
	) {
		return;
	}
	decisions.push({
		functionIndex: fn.functionIndex,
		positionId,
		operation: "call",
		phase: "optimization",
		code,
		outcome,
		...(outcome === "declined" ? { reason: reason as OptimizationDecisionReason } : {}),
	});
}

function inlineShapeDeclineReason(fn: IRFunction): OptimizationDecisionReason {
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "createFunction") return "inner-closure";
			if (
				instruction.type === "tryBegin" ||
				instruction.type === "tryEnd" ||
				instruction.type === "catch"
			) {
				return "exception-region";
			}
		}
	}
	return "relocation";
}

/**
 * Inline direct calls. For each inlinable call to a target T, shift T's registers
 * above the caller's and move the call's arguments into T's parameter registers
 * (missing args → undefined). A straight-line single-`return` T is spliced in place
 * of the call (its returned register moved into the destination). A branching/
 * multi-`return` T is spliced block-wise: the host block is split at the call, T's
 * blocks + a join block are appended (branch targets remapped by a constant block
 * offset), and every `return` becomes move-to-dst + jump-to-join. T's captured-slot
 * loads/stores need no remapping (they walk the env chain by owner index, which a
 * local closure inlined into its definer resolves the same way). When the inlined
 * closure is afterwards unused, DCE drops its `createFunction` → no closure object +
 * no captured `MalEnv` allocated.
 */
export function optInlineCalls(program: IntermediateProgram): boolean {
	let changed = false;
	const { byCaller } = findInlinableCalls(program);
	const targetOf = new Map<number, IRFunction>();
	for (const fn of program.functions) {
		targetOf.set(fn.functionIndex, fn);
	}

	for (const fn of program.functions) {
		const candidates = byCaller.get(fn.functionIndex);
		if (candidates === undefined) {
			continue;
		}
		for (const { call, target } of candidates) {
			if (instructionCount(fn) >= MAX_CALLER_INSTRUCTIONS) {
				recordInlineDecision(program, fn, call, "declined", "expansion-limit");
				continue;
			}
			const targetFn = targetOf.get(target);
			if (targetFn === undefined) {
				recordInlineDecision(program, fn, call, "declined", "unavailable-world-fact");
				continue;
			}
			const singleBlock = singleReturnBlock(targetFn);
			const multiBlocks = singleBlock === null ? multiBlockInlinable(targetFn) : null;
			if (singleBlock === null && multiBlocks === null) {
				recordInlineDecision(
					program,
					fn,
					call,
					"declined",
					inlineShapeDeclineReason(targetFn),
				);
				continue; // not an inlinable shape (yet)
			}

			// Locate the call by reference (earlier inlines shift indices/blocks).
			let host: IRBlock | undefined;
			let index = -1;
			for (const candidateBlock of fn.blocks) {
				const at = candidateBlock.instructions.indexOf(call);
				if (at >= 0) {
					host = candidateBlock;
					index = at;
					break;
				}
			}
			if (host === undefined) {
				recordInlineDecision(program, fn, call, "declined", "relocation");
				continue; // already removed/rewritten by a prior step
			}
			if (hasStackObjectMaterialization(targetFn) && blockIsInCycle(fn, host)) {
				partialEscapeInlineBlocked.add(call);
				recordInlineDecision(program, fn, call, "declined", "escape-cost-barrier");
				continue; // preserve rare materialization instead of allocating every iteration
			}

			if (singleBlock === null && isCallInTry(fn, host, index)) {
				recordInlineDecision(program, fn, call, "declined", "exception-region");
				continue; // multi-block relocation would move code out of the enclosing try
			}

			// call.registers = [destination, callee, this, ...arguments]
			const callRegisters = (call as { registers: ReadonlyArray<number> }).registers;
			const destination = callRegisters[0]!;
			const args = callRegisters.slice(3);
			const captureOverrides = hofCaptureOverrides.get(call);

			// The source position active at the call (nearest preceding marker in the
			// host block) roots the inlined frames in the caller.
			let callSitePos = -1;
			for (let i = index - 1; i >= 0; --i) {
				const prior = host.instructions[i]!;
				if (prior.type === "sourcePos") {
					callSitePos = prior.pos;
					break;
				}
			}

			const offset = fn.nextRegisterDestination;
			fn.nextRegisterDestination += targetFn.nextRegisterDestination;

			// Parameter binding (shared): args → param registers (offset), missing →
			// undefined. The target's params occupy its first `parameterCount` registers.
			const paramSetup: Array<IRInstruction> = [];
			for (let i = 0; i < targetFn.parameterCount; ++i) {
				const paramRegister = offset + i;
				paramSetup.push(
					i < args.length
						? { type: "move", registers: [paramRegister, args[i]!] }
						: { type: "createUndefined", registers: [paramRegister] },
				);
			}

			// Rewrap an inlined source position so traces show the target's frame
			// called at the call site (inline-frame markers).
			const rewrap = (
				instruction: Extract<IRInstruction, { type: "sourcePos" }>,
			): IRInstruction => ({
				type: "sourcePos",
				pos: wrapInlinePosition(program, instruction.pos, target, callSitePos),
			});

			if (singleBlock !== null) {
				// Straight-line target: splice its body (minus the trailing `return`) in
				// place of the call, moving the returned register into the destination.
				const inlined: Array<IRInstruction> = [...paramSetup];
				const body = singleBlock.instructions;
				for (let i = 0; i < body.length - 1; ++i) {
					const instruction = body[i]!;
					inlined.push(
						instruction.type === "sourcePos"
							? rewrap(instruction)
							: inlineInstruction(instruction, offset, args, captureOverrides),
					);
				}
				const returnInstruction = body[body.length - 1] as {
					registers: ReadonlyArray<number>;
				};
				const returnRegister = returnInstruction.registers[0]!;
				if (destination >= 0) {
					inlined.push({
						type: "move",
						registers: [destination, offset + returnRegister],
					});
				}
				recordInlineDecision(program, fn, call, "applied", "inline");
				host.instructions.splice(index, 1, ...inlined);
				changed = true;
				continue;
			}

			// Multi-block target: split the host block at the call, append the target's
			// blocks (via buildInlinedBlocks) and a join block. Block order is irrelevant
			// (all edges are explicit), so appending at the end is sound and touches no
			// existing block index.
			const blocks = multiBlocks!;
			const base = fn.blocks.length;
			const joinIndex = base + blocks.length;
			const post = host.instructions.slice(index + 1);
			if (post.length === 0 || containsTryMarker(post)) {
				// Empty post shouldn't happen; a try marker in the relocated tail would be
				// reordered relative to its pair in the flattened stream → unbalanced
				// handler ranges (see containsTryMarker).
				recordInlineDecision(program, fn, call, "declined", "relocation");
				continue;
			}
			// Host: pre + jump to the inlined entry (the target's block 0, which begins with
			// the parameter binding buildInlinedBlocks prepends).
			recordInlineDecision(program, fn, call, "applied", "inline");
			host.instructions = [
				...host.instructions.slice(0, index),
				{ type: "jump", blocks: [base] },
			];
			// Plain call → no receiver (thisSource null); the target is `this`-free anyway.
			const instructionMap = new Map<IRInstruction, IRInstruction>();
			for (const inlinedBlock of buildInlinedBlocks(
				program,
				targetFn,
				blocks,
				args,
				null,
				destination,
				offset,
				callSitePos,
				base,
				joinIndex,
				captureOverrides,
				instructionMap,
			)) {
				fn.blocks.push(inlinedBlock);
			}
			const clonedRegions = (targetFn.regions ?? []).flatMap((region) => {
				const cloned = cloneInlinedRegion(region, instructionMap, base);
				return cloned === undefined ? [] : [cloned];
			});
			if (clonedRegions.length > 0) {
				fn.regions = [...(fn.regions ?? []), ...clonedRegions];
			}
			// Join: the host's tail after the call (already ends in the host's terminator).
			fn.blocks.push({ instructions: post });
			changed = true;
		}
	}
	return changed;
}

// ---------------------------------------------------------------------------
// Speculative (guarded) direct-call inlining — SUBSTITUTION. For each site
// findSpeculativeInlineSites reports, splice the candidate F's body behind a runtime
// `function_index(callee) === F` guard, deopting to the original call on a miss:
//
//   pre; t = guardFunctionIndex(callee, F); if (t) goto inline; else goto deopt
//   inline: <F's body (buildInlinedBlocks), return → move-to-dst + goto join>
//   deopt:  <original call>; goto join
//   join:   <the host's tail after the call>
//
// The guard is never trusted for correctness (the deopt path is the real call), so this is
// sound for a reassignable binding: a reassignment / any other callee simply fails the guard.
// ---------------------------------------------------------------------------

/**
 * Splice candidate bodies at `call` behind function-index guards, deopting to the
 * original call when none match. `thisSource` maps the callee's `this`; the real Get
 * has already produced the guarded callee, so no receiver-shape assumption is needed.
 */
function inlineGuardedCallSite(
	program: IntermediateProgram,
	fn: IRFunction,
	call: IRInstruction,
	targetFns: ReadonlyArray<IRFunction>,
	thisSource: number | null,
	emptyTargetReason: OptimizationDecisionReason = "unavailable-world-fact",
): boolean {
	if (targetFns.length === 0) {
		recordInlineDecision(program, fn, call, "declined", emptyTargetReason);
		return false;
	}
	if (guardedInlineSubstituted.has(call)) {
		return false;
	}
	if (
		instructionCount(fn) +
			targetFns.reduce((sum, target) => sum + instructionCount(target), 0) >=
		MAX_CALLER_INSTRUCTIONS
	) {
		recordInlineDecision(program, fn, call, "declined", "expansion-limit");
		return false;
	}
	const targetBlocks = targetFns.map((target) => multiBlockInlinable(target));
	if (targetBlocks.some((blocks) => blocks === null)) {
		const rejected = targetFns.find((_target, index) => targetBlocks[index] === null);
		recordInlineDecision(
			program,
			fn,
			call,
			"declined",
			rejected === undefined ? "relocation" : inlineShapeDeclineReason(rejected),
		);
		return false; // not a splice-able control-flow shape
	}
	// Locate the call by reference (earlier substitutions shift indices/blocks).
	let host: IRBlock | undefined;
	let index = -1;
	for (const candidateBlock of fn.blocks) {
		const at = candidateBlock.instructions.indexOf(call);
		if (at >= 0) {
			host = candidateBlock;
			index = at;
			break;
		}
	}
	if (host === undefined) {
		recordInlineDecision(program, fn, call, "declined", "relocation");
		return false;
	}
	if (isCallInTry(fn, host, index)) {
		recordInlineDecision(program, fn, call, "declined", "exception-region");
		return false; // gone / relocating out of an enclosing try (see multi-block inliner)
	}
	const expansionDepth = guardedInlineDepth.get(call) ?? 0;
	if (expansionDepth >= MAX_GUARDED_INLINE_DEPTH) {
		recordInlineDecision(program, fn, call, "declined", "expansion-limit");
		return false;
	}
	if (
		targetFns.some((target) => hasStackObjectMaterialization(target)) &&
		blockIsInCycle(fn, host)
	) {
		partialEscapeInlineBlocked.add(call);
		recordInlineDecision(program, fn, call, "declined", "escape-cost-barrier");
		return false;
	}

	// call.registers = [destination, callee, this, ...arguments]
	const callRegisters = (call as { registers: ReadonlyArray<number> }).registers;
	const destination = callRegisters[0]!;
	const calleeRegister = callRegisters[1]!;
	const args = callRegisters.slice(3);
	const post = host.instructions.slice(index + 1);
	if (post.length === 0 || containsTryMarker(post)) {
		recordInlineDecision(program, fn, call, "declined", "relocation");
		return false;
	}

	let callSitePos = -1;
	for (let i = index - 1; i >= 0; --i) {
		const prior = host.instructions[i]!;
		if (prior.type === "sourcePos") {
			callSitePos = prior.pos;
			break;
		}
	}
	const base = fn.blocks.length;
	let nextBlockIndex = base;
	const layouts = targetFns.map((targetFn, targetIndex) => {
		const blocks = targetBlocks[targetIndex]!;
		const offset = fn.nextRegisterDestination;
		fn.nextRegisterDestination += targetFn.nextRegisterDestination;
		const guardRegister = fn.nextRegisterDestination++;
		const entryIndex = nextBlockIndex;
		nextBlockIndex += blocks.length;
		return { targetFn, blocks, offset, guardRegister, entryIndex };
	});
	const deoptIndex = nextBlockIndex;
	const joinIndex = deoptIndex + 1;

	// Host: test each candidate against the already-loaded callee, then deopt.
	recordInlineDecision(program, fn, call, "applied", "guarded-inline");
	host.instructions = [
		...host.instructions.slice(0, index),
		...layouts.flatMap(({ targetFn, guardRegister, entryIndex }) => [
			{
				type: "guardFunctionIndex" as const,
				registers: [guardRegister, calleeRegister] as [number, number],
				functionIndex: targetFn.functionIndex,
			},
			{
				type: "jumpIf" as const,
				registers: [guardRegister] as [number],
				blocks: [entryIndex] as [number],
			},
		]),
		{ type: "jump", blocks: [deoptIndex] },
	];
	for (const { targetFn, blocks, offset, entryIndex } of layouts) {
		const instructionMap = new Map<IRInstruction, IRInstruction>();
		for (const inlinedBlock of buildInlinedBlocks(
			program,
			targetFn,
			blocks,
			args,
			thisSource,
			destination,
			offset,
			callSitePos,
			entryIndex,
			joinIndex,
			undefined,
			instructionMap,
		)) {
			for (const instruction of inlinedBlock.instructions) {
				if (instruction.type === "call") {
					guardedInlineDepth.set(
						instruction,
						Math.max(guardedInlineDepth.get(instruction) ?? 0, expansionDepth + 1),
					);
				}
			}
			fn.blocks.push(inlinedBlock);
		}
		const clonedRegions = (targetFn.regions ?? []).flatMap((region) => {
			const cloned = cloneInlinedRegion(region, instructionMap, entryIndex);
			return cloned === undefined ? [] : [cloned];
		});
		if (clonedRegions.length > 0) {
			fn.regions = [...(fn.regions ?? []), ...clonedRegions];
		}
	}
	// Deopt block: the original call verbatim, then jump to the join.
	guardedInlineSubstituted.add(call);
	fn.blocks.push({ instructions: [call, { type: "jump", blocks: [joinIndex] }] });
	// Join: the host's tail after the call (already ends in the host's terminator).
	fn.blocks.push({ instructions: post });
	return true;
}

export function optInlineSpeculative(program: IntermediateProgram): boolean {
	let changed = false;
	const { byCaller } = findSpeculativeInlineSites(program);
	const targetOf = new Map<number, IRFunction>();
	for (const fn of program.functions) {
		targetOf.set(fn.functionIndex, fn);
	}
	for (const fn of program.functions) {
		for (const { call, target } of byCaller.get(fn.functionIndex) ?? []) {
			const targetFn = targetOf.get(target);
			if (targetFn === undefined) {
				recordInlineDecision(program, fn, call, "declined", "unavailable-world-fact");
			} else if (inlineGuardedCallSite(program, fn, call, [targetFn], null)) {
				changed = true;
			}
		}
	}
	return changed;
}

export function optInlineMethod(program: IntermediateProgram): boolean {
	let changed = false;
	const { byCaller } = findMethodInlineSites(program);
	const targetOf = new Map<number, IRFunction>();
	for (const fn of program.functions) {
		targetOf.set(fn.functionIndex, fn);
	}
	for (const fn of program.functions) {
		for (const { call, targets, receiverRegister } of byCaller.get(fn.functionIndex) ??
			[]) {
			const targetFns = targets
				.map((target) => targetOf.get(target))
				.filter(
					(target): target is IRFunction =>
						target !== undefined && isInlinableMethodTarget(target),
				);
			if (
				inlineGuardedCallSite(
					program,
					fn,
					call,
					targetFns,
					receiverRegister,
					"unsupported-consumer",
				)
			) {
				changed = true;
			}
		}
	}
	return changed;
}

// ---------------------------------------------------------------------------
// HOF callback inlining — SUBSTITUTION. Replace `arr.method(cb)` (forEach / some /
// every / find / findIndex) with a runtime-guarded inlined loop so the callback
// becomes a *direct* call that the direct-call inliner folds in — eliminating the
// per-call closure + its captured `MalEnv` + the per-element dispatch. The guard
// (`__arrayIterationEligible(callee, arr, methodId)`) proves at runtime that the
// already-loaded method is the original builtin; if not, the slow path runs the
// original call unchanged.
// The loop matches each method's observable semantics: length read once; the
// hole-skipping methods (forEach/some/every) do a `HasProperty` (`in`) check before
// the live `Get`, the find family visits every index (holes → undefined) — so it is
// correct on sparse/mutated arrays without any dense-array assumption.
// ---------------------------------------------------------------------------

/** How a method turns the per-element callback result into control flow + a value. */
interface HofMethodSpec {
	/** Method id passed to `__arrayIterationEligible` (matches the runtime switch). */
	methodId: number;
	/** forEach/some/every skip holes (HasProperty); the find family does not. */
	skipHoles: boolean;
	/** some/every/find/findIndex break out of the loop; forEach runs to completion. */
	earlyExit: boolean;
	/** When earlyExit: true ⟹ exit on a truthy result (some/find/findIndex); false ⟹
	 * exit on a falsy result (every). */
	exitOnTruthy?: boolean;
	/** Destination value written when the loop exits early. */
	exitValue?: "true" | "false" | "element" | "index";
	/** Destination value after the loop completes without an early exit (ignored when
	 * buildsResult is set — those return the result array). */
	defaultValue: "undefined" | "true" | "false" | "neg1";
	/** map/filter/flatMap construct a result array: map stores cb(elem) at every
	 * present index (length preset to len, holes preserved); filter appends the
	 * element when cb is truthy; flatMap appends cb(elem) flattened one level (via the
	 * __arrayFlatMapAppend intrinsic). Requires a default @@species (runtime guard). */
	buildsResult?: "map" | "filter" | "flatMap";
	/** reduce threads an accumulator: `acc = cb(acc, elem, i, arr)` per present element,
	 * returning the accumulator. Only fires with an explicit initial value (the
	 * no-initial/empty-throw case stays on the slow path). */
	accumulator?: boolean;
	/** reduceRight/findLast/findLastIndex iterate from len-1 down to 0. */
	backward?: boolean;
}

const HOF_METHOD_SPECS: ReadonlyMap<string, HofMethodSpec> = new Map([
	[
		"forEach",
		{ methodId: 0, skipHoles: true, earlyExit: false, defaultValue: "undefined" },
	],
	[
		"some",
		{
			methodId: 1,
			skipHoles: true,
			earlyExit: true,
			exitOnTruthy: true,
			exitValue: "true",
			defaultValue: "false",
		},
	],
	[
		"every",
		{
			methodId: 2,
			skipHoles: true,
			earlyExit: true,
			exitOnTruthy: false,
			exitValue: "false",
			defaultValue: "true",
		},
	],
	[
		"find",
		{
			methodId: 3,
			skipHoles: false,
			earlyExit: true,
			exitOnTruthy: true,
			exitValue: "element",
			defaultValue: "undefined",
		},
	],
	[
		"findIndex",
		{
			methodId: 4,
			skipHoles: false,
			earlyExit: true,
			exitOnTruthy: true,
			exitValue: "index",
			defaultValue: "neg1",
		},
	],
	[
		"map",
		{
			methodId: 5,
			skipHoles: true,
			earlyExit: false,
			defaultValue: "undefined",
			buildsResult: "map",
		},
	],
	[
		"filter",
		{
			methodId: 6,
			skipHoles: true,
			earlyExit: false,
			defaultValue: "undefined",
			buildsResult: "filter",
		},
	],
	[
		"reduce",
		{
			methodId: 7,
			skipHoles: true,
			earlyExit: false,
			defaultValue: "undefined",
			accumulator: true,
		},
	],
	[
		"reduceRight",
		{
			methodId: 8,
			skipHoles: true,
			earlyExit: false,
			defaultValue: "undefined",
			accumulator: true,
			backward: true,
		},
	],
	[
		"findLast",
		{
			methodId: 9,
			skipHoles: false,
			earlyExit: true,
			exitOnTruthy: true,
			exitValue: "element",
			defaultValue: "undefined",
			backward: true,
		},
	],
	[
		"findLastIndex",
		{
			methodId: 10,
			skipHoles: false,
			earlyExit: true,
			exitOnTruthy: true,
			exitValue: "index",
			defaultValue: "neg1",
			backward: true,
		},
	],
	[
		"flatMap",
		{
			methodId: 11,
			skipHoles: true,
			earlyExit: false,
			defaultValue: "undefined",
			buildsResult: "flatMap",
		},
	],
]);

interface HofCaptureShadow {
	readonly key: string;
	readonly functionIndex: number;
	readonly index: number;
	readonly write: boolean;
}

/** Compile a deliberately tiny, side-effect-free numeric callback language while
 * the exact HOF callback identity is still available. This is provenance, not an
 * optimizer guess: unsupported control flow, captures, coercions, or calls reject. */
function compileNumericReducePlan(
	program: IntermediateProgram,
	callback: IRFunction,
): { operations: Array<IRNumericHofPlanOperation>; resultOperand: number } | undefined {
	if (
		callback.parameterCount !== 2 ||
		callback.nextCapturedIndex !== 0 ||
		callback.isGenerator === true ||
		callback.isAsync === true ||
		callback.argumentsObjectRegister !== undefined ||
		callback.mappedArguments === true ||
		(callback.mappedArgumentSlots?.length ?? 0) !== 0 ||
		callback.classContext?.isConstructor === true ||
		callback.classContext?.isDerivedConstructor === true ||
		callback.directEvalPersistentScopeRegister !== undefined
	) {
		return undefined;
	}
	type Value =
		| { kind: "number"; operand: number }
		| { kind: "math" }
		| { kind: "string"; value: string }
		| { kind: "mathFunction"; operation: MathUnaryOperationKey };
	const values = new Map<number, Value>([
		[0, { kind: "number", operand: NUMERIC_HOF_INPUT_ACCUMULATOR }],
		[1, { kind: "number", operand: NUMERIC_HOF_INPUT_ELEMENT }],
	]);
	const locals = new Map<number, Value>();
	const operations: Array<IRNumericHofPlanOperation> = [];
	const numeric = (register: number): number | undefined => {
		const value = values.get(register);
		return value?.kind === "number" ? value.operand : undefined;
	};
	const defineOperation = (register: number, operation: IRNumericHofPlanOperation) => {
		if (operations.length >= 32) return false;
		const operand = operations.push(operation) - 1;
		values.set(register, { kind: "number", operand });
		return true;
	};

	const visited = new Set<number>();
	let blockIndex = 0;
	while (!visited.has(blockIndex)) {
		visited.add(blockIndex);
		const block = callback.blocks[blockIndex];
		if (block === undefined) return undefined;
		let nextBlock: number | undefined;
		for (let index = 0; index < block.instructions.length; index++) {
			const instruction = block.instructions[index]!;
			switch (instruction.type) {
				case "sourcePos":
					break;
				case "storeLocal": {
					const value = values.get(instruction.registers[0]);
					if (value === undefined) return undefined;
					locals.set(instruction.index, value);
					break;
				}
				case "loadLocal": {
					const value = locals.get(instruction.index);
					if (value === undefined) return undefined;
					values.set(instruction.registers[0], value);
					break;
				}
				case "move": {
					const value = values.get(instruction.registers[1]);
					if (value === undefined) return undefined;
					values.set(instruction.registers[0], value);
					break;
				}
				case "createNumber":
				case "createF64":
					if (
						!defineOperation(instruction.registers[0], {
							type: "constant",
							value: instruction.value,
						})
					)
						return undefined;
					break;
				case "loadIntrinsic":
					if (instruction.intrinsic !== "Math") return undefined;
					values.set(instruction.registers[0], { kind: "math" });
					break;
				case "createString":
					values.set(instruction.registers[0], {
						kind: "string",
						value: decodeStringConstant(program, instruction.stringIndex),
					});
					break;
				case "loadProperty": {
					const object = values.get(instruction.registers[1]);
					const key = values.get(instruction.registers[2]);
					if (object?.kind !== "math" || key?.kind !== "string") return undefined;
					const operationId = MATH_UNARY_OPERATION_ID_BY_KEY.get(
						key.value as MathUnaryOperationKey,
					);
					const operation = mathUnaryOperationKeys.find(
						([, name]) => name === key.value,
					)?.[1];
					const identity =
						operationId === undefined
							? undefined
							: program.facts.builtinIdentities.get(operationId);
					if (operation === undefined || identity?.kind !== "known") return undefined;
					values.set(instruction.registers[0], {
						kind: "mathFunction",
						operation,
					});
					break;
				}
				case "call": {
					const callee = values.get(instruction.registers[1]);
					const receiver = values.get(instruction.registers[2]);
					const value = numeric(instruction.registers[3]!);
					if (
						callee?.kind !== "mathFunction" ||
						receiver?.kind !== "math" ||
						instruction.registers.length !== 4 ||
						value === undefined ||
						!defineOperation(instruction.registers[0], {
							type: "math",
							operation: callee.operation,
							value,
						})
					)
						return undefined;
					break;
				}
				case "binary": {
					if (!["+", "-", "*", "/", "%"].includes(instruction.operator)) {
						return undefined;
					}
					const left = numeric(instruction.registers[1]);
					const right = numeric(instruction.registers[2]);
					if (left === undefined || right === undefined) return undefined;
					if (
						!defineOperation(instruction.registers[0], {
							type: "binary",
							operator: instruction.operator as "+" | "-" | "*" | "/" | "%",
							left,
							right,
						})
					)
						return undefined;
					break;
				}
				case "jump":
					if (index !== block.instructions.length - 1) return undefined;
					nextBlock = instruction.blocks[0];
					break;
				case "return": {
					if (index !== block.instructions.length - 1) return undefined;
					const resultOperand = numeric(instruction.registers[0]);
					return resultOperand === undefined || operations.length === 0
						? undefined
						: { operations, resultOperand };
				}
				default:
					return undefined;
			}
		}
		if (nextBlock === undefined) return undefined;
		blockIndex = nextBlock;
	}
	return undefined;
}

/** Captures that can use a caller-local register on one guarded HOF fast path.
 * A third function could observe the environment during re-entrant property access,
 * so only slots accessed by the owner and this callback are eligible. */
function hofCaptureShadows(
	program: IntermediateProgram,
	owner: IRFunction,
	site: HofInlineSite,
	callbackRegister: number,
): Array<HofCaptureShadow> {
	if ((owner.mappedArgumentSlots?.length ?? 0) > 0) {
		return [];
	}
	const callbackUses = buildIRRegisterIndex(owner).uses.get(callbackRegister) ?? [];
	if (
		callbackUses.length !== 1 ||
		callbackUses[0]!.instruction !== site.call ||
		callbackUses[0]!.position !== 3
	) {
		return [];
	}

	const target = program.functions.find(
		(candidate) => candidate.functionIndex === site.callbackTarget,
	);
	if (target === undefined) {
		return [];
	}
	const candidates = new Map<string, HofCaptureShadow>();
	for (const block of target.blocks) {
		for (const instruction of block.instructions) {
			if (
				(instruction.type === "loadCaptured" || instruction.type === "storeCaptured") &&
				instruction.functionIndex === owner.functionIndex &&
				instruction.index !== undefined
			) {
				const key = capturedSlotKey(instruction.functionIndex, instruction.index);
				const current = candidates.get(key);
				candidates.set(key, {
					key,
					functionIndex: instruction.functionIndex,
					index: instruction.index,
					write: current?.write === true || instruction.type === "storeCaptured",
				});
			}
		}
	}

	for (const fn of program.functions) {
		if (
			fn.functionIndex === owner.functionIndex ||
			fn.functionIndex === target.functionIndex
		) {
			continue;
		}
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					(instruction.type === "loadCaptured" || instruction.type === "storeCaptured") &&
					instruction.functionIndex !== undefined &&
					instruction.index !== undefined
				) {
					candidates.delete(
						capturedSlotKey(instruction.functionIndex, instruction.index),
					);
				}
			}
		}
	}
	return [...candidates.values()];
}

/**
 * Inline `arr.method(cb)` array-iteration sites behind a runtime guard, for the
 * methods in HOF_METHOD_SPECS. Skips calls inside a try region and calls whose tail
 * carries a try marker (the appended blocks would land outside / reorder the enclosing
 * handler — same reasons as multi-block inlining).
 */
export function optInlineHofCallbacks(program: IntermediateProgram): boolean {
	let changed = false;
	const { byCaller } = findHofInlineSites(program);

	for (const fn of program.functions) {
		let builtinGuardOrdinal = 0;
		const sites = byCaller.get(fn.functionIndex);
		if (sites === undefined) {
			continue;
		}
		for (const site of sites) {
			const spec = HOF_METHOD_SPECS.get(site.method);
			if (spec === undefined) {
				continue; // method has no inlined loop shape yet (map/filter/…)
			}
			const operation = `Array.prototype.${site.method}`;
			const positionId = instructionPosition(fn, site.call);
			recordGuardedBuiltinCall(
				program,
				fn,
				site.call,
				operation,
				builtinGuardOrdinal++,
				positionId < 0 ? undefined : positionId,
			);
			if (!knownBuiltinCallProves(site.call.knownBuiltinCall, operation)) continue;

			// Locate the call by reference (earlier substitutions shift blocks).
			let host: IRBlock | undefined;
			let index = -1;
			for (const block of fn.blocks) {
				const at = block.instructions.indexOf(site.call);
				if (at >= 0) {
					host = block;
					index = at;
					break;
				}
			}
			if (host === undefined) {
				continue;
			}
			if (isCallInTry(fn, host, index)) {
				continue; // relocated throw would escape the enclosing try
			}

			const callRegisters = (site.call as { registers: ReadonlyArray<number> }).registers;
			const destination = callRegisters[0]!;
			const receiver = callRegisters[2]!; // === site.receiverRegister (call's `this`)
			const callback = callRegisters[3]!;
			const callbackTarget = program.functions.find(
				(candidate) => candidate.functionIndex === site.callbackTarget,
			);
			const numericReduceCandidate =
				spec.accumulator === true &&
				spec.backward !== true &&
				callbackTarget !== undefined
					? compileNumericReducePlan(program, callbackTarget)
					: undefined;
			const numericReduceGuard =
				numericReduceCandidate === undefined
					? undefined
					: compilerGuardPlan(
							[
								site.call.knownBuiltinCall?.identity,
								program.facts.protectors.get("primitive-methods"),
								program.facts.protectors.get("array-elements"),
								...numericReduceCandidate.operations
									.filter((candidate) => candidate.type === "math")
									.map((candidate) =>
										program.facts.builtinIdentities.get(
											MATH_UNARY_OPERATION_ID_BY_KEY.get(candidate.operation)!,
										),
									),
							],
							[
								{
									kind: "fallback",
									id: `numeric-reduce:${fn.functionIndex}:${positionId ?? builtinGuardOrdinal}`,
								},
							],
						);
			const numericReducePlan =
				numericReduceGuard === undefined || numericReduceCandidate === undefined
					? undefined
					: { ...numericReduceCandidate, guard: numericReduceGuard };
			const exactFreshReceiver = analyzeExactFreshArrayUse(fn, {
				receiver,
				callee: callRegisters[1]!,
				property: site.property,
				call: site.call,
			});
			const lockedExactReceiver =
				compilerFactIsWorldInvariant(site.call.knownBuiltinCall?.identity) &&
				exactFreshReceiver.fact.kind === "known";
			const closedFreshArray = lockedExactReceiver
				? exactFreshReceiver.fact.value
				: undefined;
			// Hole coverage remains stable only when the callback cannot receive the
			// Array argument and mutate a later index. Captured aliases were already
			// rejected by the exact-use fact; dynamic `arguments`/rest consumers are
			// rejected by HOF-site eligibility.
			const callbackReceiverParameter = spec.accumulator ? 3 : 2;
			const callbackCannotObserveReceiver =
				callbackTarget !== undefined &&
				callbackTarget.parameterCount <= callbackReceiverParameter;

			const post = host.instructions.slice(index + 1);
			if (post.length === 0 || containsTryMarker(post)) {
				continue; // see containsTryMarker; empty post shouldn't happen
			}

			// reduce only inlines with an explicit initial value (call arg after the
			// callback): the no-initial case needs first-element selection + an
			// empty-array TypeError, left to the slow path.
			const initialValue = spec.accumulator ? callRegisters[4] : undefined;
			if (spec.accumulator && initialValue === undefined) {
				continue;
			}
			const initialValueDefinition =
				initialValue === undefined
					? undefined
					: buildIRRegisterIndex(fn).uniqueDefinitions.get(initialValue);

			// To let the fast path allocate nothing, the slow path re-creates the
			// closure rather than sharing the one defined before the call: once the
			// fast `cb(...)` is inlined, the original `createFunction` is used only by
			// that (now folded) call, so DCE drops it. Sound only when the callback is
			// *directly* a `createFunction` here (no move/captured-slot chain) so
			// duplicating it captures the same activation env.
			let callbackDefinition:
				| Extract<IRInstruction, { type: "createFunction" }>
				| undefined;
			for (const block of fn.blocks) {
				for (const candidate of block.instructions) {
					if (
						candidate.type === "createFunction" &&
						candidate.registers[0] === callback
					) {
						callbackDefinition = candidate;
					}
				}
			}
			const captureShadows =
				callbackDefinition === undefined
					? []
					: hofCaptureShadows(program, fn, site, callback);
			const captureOverrides = new Map<string, number>();
			for (const shadow of captureShadows) {
				captureOverrides.set(shadow.key, fn.nextRegisterDestination++);
			}

			// Fresh registers for the guard + loop scaffolding.
			const r = fn.nextRegisterDestination;
			fn.nextRegisterDestination += 17;
			const eligibleFn = r;
			const eligible = r + 1;
			const methodIdReg = r + 2;
			const lengthKeyReg = r + 3;
			const lengthReg = r + 4;
			const indexReg = r + 5;
			const oneReg = r + 6;
			const condReg = r + 7;
			const hasReg = r + 8;
			const elementReg = r + 9;
			const callbackResult = r + 10;
			const undefinedReg = r + 11;
			const resultReg = r + 12; // map/filter/flatMap result array
			const resultLenReg = r + 13; // filter: next append index; flatMap: append-call sink
			const accumulatorReg = r + 14; // reduce accumulator
			const zeroReg = r + 15; // backward loop bound (i >= 0)
			const flatMapAppendFn = r + 16; // flatMap: the __arrayFlatMapAppend intrinsic

			// Block indices (some are conditional on the method shape).
			const base = fn.blocks.length;
			let next = base;
			const fastInit = next++;
			const loopCond = next++;
			const requiresHoleCheck =
				spec.skipHoles &&
				(closedFreshArray?.indexedCoverage !== "complete" ||
					!callbackCannotObserveReceiver);
			const holeCheck = requiresHoleCheck ? next++ : -1;
			const callBlock = next++;
			const appendBlock = spec.buildsResult === "filter" ? next++ : -1;
			const loopIncr = next++;
			const exitBlock = spec.earlyExit ? next++ : -1;
			const afterLoop = next++;
			const slowPath = lockedExactReceiver ? -1 : next++;
			const join = next++;

			const needsLengthKey =
				closedFreshArray === undefined || spec.buildsResult === "map";
			const lengthString = needsLengthKey
				? getOrCreateStringConstant(program, "length")
				: -1;

			const valueInstruction = (
				kind: "undefined" | "true" | "false" | "neg1" | "element" | "index",
				dst: number,
			): IRInstruction => {
				switch (kind) {
					case "undefined":
						return { type: "createUndefined", registers: [dst] };
					case "true":
						return { type: "createBoolean", registers: [dst], value: true };
					case "false":
						return { type: "createBoolean", registers: [dst], value: false };
					case "neg1":
						return { type: "createNumber", registers: [dst], value: -1 };
					case "element":
						return { type: "move", registers: [dst, elementReg] };
					case "index":
						return { type: "move", registers: [dst, indexReg] };
				}
			};

			const eligibilityCall: Extract<IRInstruction, { type: "call" }> = {
				type: "call",
				registers: [
					eligible,
					eligibleFn,
					undefinedReg,
					callRegisters[1]!,
					receiver,
					methodIdReg,
				],
			};

			// Host: a locked exact fresh Array has no alias that can install an own
			// method/constructor or observe its prototype before this call, so its
			// canonical identity fact discharges the guard and generic fallback. Other
			// receivers validate the already-loaded callee before entering the fast loop.
			const hostPrefix = host.instructions
				.slice(0, index)
				.filter((instruction) => !lockedExactReceiver || instruction !== site.property);
			host.instructions = lockedExactReceiver
				? [
						...hostPrefix,
						{ type: "createUndefined", registers: [undefinedReg] },
						{ type: "jump", blocks: [fastInit] },
					]
				: [
						...hostPrefix,
						{
							type: "loadIntrinsic",
							registers: [eligibleFn],
							intrinsic: "__arrayIterationEligible",
						},
						{ type: "createNumber", registers: [methodIdReg], value: spec.methodId },
						{ type: "createUndefined", registers: [undefinedReg] },
						eligibilityCall,
						{ type: "jumpIf", registers: [eligible], blocks: [fastInit] },
						{ type: "jump", blocks: [slowPath] },
					];

			// fastInit: len = arr.length; one = 1; i = 0 (forward) or len-1 (backward,
			// with a zero bound for the `i >= 0` test); plus result-array setup.
			const fastInitInstructions: Array<IRInstruction> = [];
			if (needsLengthKey) {
				fastInitInstructions.push({
					type: "createString",
					registers: [lengthKeyReg],
					stringIndex: lengthString,
				});
			}
			fastInitInstructions.push(
				closedFreshArray === undefined
					? { type: "loadProperty", registers: [lengthReg, receiver, lengthKeyReg] }
					: {
							type: "createNumber",
							registers: [lengthReg],
							value: closedFreshArray.length,
						},
				{ type: "createNumber", registers: [oneReg], value: 1 },
			);
			for (const shadow of captureShadows) {
				fastInitInstructions.push({
					type: "loadCaptured",
					registers: [captureOverrides.get(shadow.key)!],
					functionIndex: shadow.functionIndex,
					index: shadow.index,
				});
			}
			if (spec.backward) {
				fastInitInstructions.push({
					type: "createNumber",
					registers: [zeroReg],
					value: 0,
				});
				fastInitInstructions.push({
					type: "binary",
					operator: "-",
					registers: [indexReg, lengthReg, oneReg],
				});
			} else {
				fastInitInstructions.push({
					type: "createNumber",
					registers: [indexReg],
					value: 0,
				});
			}
			if (spec.buildsResult !== undefined) {
				fastInitInstructions.push({
					type: "createArray",
					registers: [resultReg],
					length: 0,
				});
			}
			if (spec.buildsResult === "map") {
				// map result has the source length (holes preserved); set it once so
				// index stores fill in place rather than growing past it.
				fastInitInstructions.push({
					type: "storeProperty",
					registers: [resultReg, lengthKeyReg, lengthReg],
				});
			} else if (spec.buildsResult === "filter") {
				fastInitInstructions.push({
					type: "createNumber",
					registers: [resultLenReg],
					value: 0,
				});
			} else if (spec.buildsResult === "flatMap") {
				// Load the flatten-append helper once; the loop calls it per element.
				fastInitInstructions.push({
					type: "loadIntrinsic",
					registers: [flatMapAppendFn],
					intrinsic: "__arrayFlatMapAppend",
				});
			}
			let accumulatorInitialMove: Extract<IRInstruction, { type: "move" }> | undefined;
			if (spec.accumulator) {
				// acc = initial value (guaranteed present: checked above).
				accumulatorInitialMove = {
					type: "move",
					registers: [accumulatorReg, initialValue!],
				};
				fastInitInstructions.push(accumulatorInitialMove);
			}
			fastInitInstructions.push({ type: "jump", blocks: [loopCond] });
			fn.blocks.push({ instructions: fastInitInstructions });
			// loopCond: forward `i < len` / backward `i >= 0` → (hole check | call
			// block), else afterLoop.
			const loopExit: Extract<IRInstruction, { type: "jump" }> = {
				type: "jump",
				blocks: [afterLoop],
			};
			fn.blocks.push({
				instructions: [
					spec.backward
						? { type: "binary", operator: ">=", registers: [condReg, indexReg, zeroReg] }
						: {
								type: "binary",
								operator: "<",
								registers: [condReg, indexReg, lengthReg],
							},
					{
						type: "jumpIf",
						registers: [condReg],
						blocks: [requiresHoleCheck ? holeCheck : callBlock],
					},
					loopExit,
				],
			});
			// holeCheck (hole-skipping methods): if (i in arr) call, else skip.
			if (requiresHoleCheck) {
				fn.blocks.push({
					instructions: [
						{ type: "binary", operator: "in", registers: [hasReg, indexReg, receiver] },
						{ type: "jumpIf", registers: [hasReg], blocks: [callBlock] },
						{ type: "jump", blocks: [loopIncr] },
					],
				});
			}
			// callBlock: elem = arr[i]; then call the callback. reduce threads the
			// accumulator: `acc = cb(acc, elem, i, arr)`; the others: `r = cb(elem, i, arr)`.
			const fastCallbackCall: IRInstruction = spec.accumulator
				? {
						type: "call",
						registers: [
							accumulatorReg,
							callback,
							undefinedReg,
							accumulatorReg,
							elementReg,
							indexReg,
							receiver,
						],
					}
				: {
						type: "call",
						registers: [
							callbackResult,
							callback,
							undefinedReg,
							elementReg,
							indexReg,
							receiver,
						],
					};
			if (captureOverrides.size > 0) {
				hofCaptureOverrides.set(fastCallbackCall, captureOverrides);
			}
			const elementLoad: Extract<IRInstruction, { type: "loadProperty" }> = {
				type: "loadProperty",
				registers: [elementReg, receiver, indexReg],
			};
			if (
				closedFreshArray?.indexedCoverage === "complete" &&
				callbackCannotObserveReceiver &&
				exactFreshReceiver.allocation !== undefined
			) {
				elementLoad.nativeExactFreshArrayAccess = {
					allocation: exactFreshReceiver.allocation,
				};
			}
			const callTail: Array<IRInstruction> = [elementLoad, fastCallbackCall];
			if (spec.buildsResult === "map") {
				// result[i] = cb(elem, i, arr) (index < preset length → fills in place).
				callTail.push({
					type: "storeProperty",
					registers: [resultReg, indexReg, callbackResult],
				});
				callTail.push({ type: "jump", blocks: [loopIncr] });
			} else if (spec.buildsResult === "flatMap") {
				// __arrayFlatMapAppend(result, cb(elem, i, arr)) — flatten one level into
				// result (the sink register is unused). Append cursor = result.length.
				callTail.push({
					type: "call",
					registers: [
						resultLenReg,
						flatMapAppendFn,
						undefinedReg,
						resultReg,
						callbackResult,
					],
				});
				callTail.push({ type: "jump", blocks: [loopIncr] });
			} else if (spec.buildsResult === "filter") {
				callTail.push({
					type: "jumpIf",
					registers: [callbackResult],
					blocks: [appendBlock],
				});
				callTail.push({ type: "jump", blocks: [loopIncr] });
			} else if (!spec.earlyExit) {
				callTail.push({ type: "jump", blocks: [loopIncr] });
			} else if (spec.exitOnTruthy) {
				callTail.push({
					type: "jumpIf",
					registers: [callbackResult],
					blocks: [exitBlock],
				});
				callTail.push({ type: "jump", blocks: [loopIncr] });
			} else {
				// every: continue while truthy, exit on the first falsy result.
				callTail.push({
					type: "jumpIf",
					registers: [callbackResult],
					blocks: [loopIncr],
				});
				callTail.push({ type: "jump", blocks: [exitBlock] });
			}
			fn.blocks.push({ instructions: callTail });
			// appendBlock (filter): result[resultLen++] = element (cb was truthy).
			if (spec.buildsResult === "filter") {
				fn.blocks.push({
					instructions: [
						{ type: "storeProperty", registers: [resultReg, resultLenReg, elementReg] },
						{
							type: "binary",
							operator: "+",
							registers: [resultLenReg, resultLenReg, oneReg],
						},
						{ type: "jump", blocks: [loopIncr] },
					],
				});
			}
			// loopIncr: forward i++ / backward i--.
			const loopBackedge: Extract<IRInstruction, { type: "jump" }> = {
				type: "jump",
				blocks: [loopCond],
			};
			fn.blocks.push({
				instructions: [
					{
						type: "binary",
						operator: spec.backward ? "-" : "+",
						registers: [indexReg, indexReg, oneReg],
					},
					loopBackedge,
				],
			});
			// exitBlock (early-exit methods): dst = exit value; jump join.
			if (spec.earlyExit) {
				const exitInstructions: Array<IRInstruction> = [
					valueInstruction(spec.exitValue!, destination),
				];
				for (const shadow of captureShadows) {
					if (shadow.write) {
						exitInstructions.push({
							type: "storeCaptured",
							registers: [captureOverrides.get(shadow.key)!],
							functionIndex: shadow.functionIndex,
							index: shadow.index,
						});
					}
				}
				exitInstructions.push({ type: "jump", blocks: [join] });
				fn.blocks.push({ instructions: exitInstructions });
			}
			// afterLoop: dst = result array (map/filter) / accumulator (reduce) / the
			// method's default value.
			const afterLoopValue: IRInstruction =
				spec.buildsResult !== undefined
					? { type: "move", registers: [destination, resultReg] }
					: spec.accumulator
						? { type: "move", registers: [destination, accumulatorReg] }
						: valueInstruction(spec.defaultValue, destination);
			const afterLoopInstructions: Array<IRInstruction> = [afterLoopValue];
			for (const shadow of captureShadows) {
				if (shadow.write) {
					afterLoopInstructions.push({
						type: "storeCaptured",
						registers: [captureOverrides.get(shadow.key)!],
						functionIndex: shadow.functionIndex,
						index: shadow.index,
					});
				}
			}
			const fastExit: Extract<IRInstruction, { type: "jump" }> = {
				type: "jump",
				blocks: [join],
			};
			afterLoopInstructions.push(fastExit);
			fn.blocks.push({ instructions: afterLoopInstructions });
			// slowPath: run the original method. When the callback is a direct
			// createFunction, re-create it here so the fast path's closure becomes dead
			// (DCE'd → no allocation on the common path); else use the original call.
			let slowCallAnchor: Extract<IRInstruction, { type: "call" }> | undefined;
			if (lockedExactReceiver) {
				// The canonical identity and complete receiver-use proof discharge the
				// fallback obligation. The callback is now fast-path-only and folds away.
			} else if (callbackDefinition !== undefined) {
				const freshCallback = fn.nextRegisterDestination;
				fn.nextRegisterDestination += 1;
				const slowCall: Extract<IRInstruction, { type: "call" }> = {
					type: "call",
					registers: [
						destination,
						callRegisters[1]!,
						receiver,
						freshCallback,
						...callRegisters.slice(4),
					],
					knownBuiltinCall: site.call.knownBuiltinCall,
				};
				slowCallAnchor = slowCall;
				hofSubstitutedCalls.add(slowCall);
				fn.blocks.push({
					instructions: [
						{
							type: "createFunction",
							registers: [freshCallback],
							functionIndex: callbackDefinition.functionIndex,
						},
						slowCall,
						{ type: "jump", blocks: [join] },
					],
				});
			} else {
				hofSubstitutedCalls.add(site.call);
				slowCallAnchor = site.call;
				fn.blocks.push({ instructions: [site.call, { type: "jump", blocks: [join] }] });
			}
			const numericDispatch =
				lockedExactReceiver && exactFreshReceiver.allocation !== undefined
					? ({
							kind: "closed",
							receiverAllocation: exactFreshReceiver.allocation,
						} as const)
					: slowCallAnchor === undefined
						? undefined
						: ({
								kind: "guarded",
								eligibility: eligibilityCall,
								slowCall: slowCallAnchor,
							} as const);
			if (
				numericReducePlan !== undefined &&
				callbackDefinition !== undefined &&
				callbackDefinition.functionIndex === site.callbackTarget &&
				(initialValueDefinition?.type === "createNumber" ||
					initialValueDefinition?.type === "createF64") &&
				accumulatorInitialMove !== undefined &&
				afterLoopValue.type === "move" &&
				numericDispatch !== undefined
			) {
				const dispatchClaims =
					numericDispatch.kind === "guarded"
						? [numericDispatch.eligibility, numericDispatch.slowCall]
						: [numericDispatch.receiverAllocation];
				const claimedInstructions = [
					accumulatorInitialMove,
					elementLoad,
					loopBackedge,
					loopExit,
					...dispatchClaims,
				];
				const numericRegion: IRNumericHofRegion = {
					kind: "numeric-hof",
					method: "reduce",
					license: {
						guard: numericReducePlan.guard,
						genericTwin: "retained",
						materialization: "none",
					},
					representation: "numeric-reduce-f64",
					anchors: [accumulatorInitialMove, elementLoad, loopBackedge, loopExit],
					claimedInstructions,
					controlFlow: {
						ordinaryBlocks: [fastInit, loopCond, callBlock, loopIncr, afterLoop],
						exceptionalBlocks: [],
					},
					cost: {
						score: 4 + numericReducePlan.operations.length,
						metadataOperations: claimedInstructions.length,
					},
					callbackFunctionIndex: site.callbackTarget,
					operations: numericReducePlan.operations,
					resultOperand: numericReducePlan.resultOperand,
					initialValue: initialValueDefinition.value,
					pollPolicy: "end-only-no-preempt",
					dispatch: numericDispatch,
				};
				fn.regions = [...(fn.regions ?? []), numericRegion];
			}
			// join: the host's tail after the call.
			fn.blocks.push({ instructions: post });

			changed = true;
		}
	}
	return changed;
}

// ---------------------------------------------------------------------------
// Captured-slot internalization (env elimination). After inlining pulls a
// capturing closure's body into its definer, the body reads the captured variable
// via `loadCaptured(definer, idx)` — so the definer still allocates a `MalEnv`. When
// a slot is written exactly once from a stable register and ALL its accesses are now
// inside the definer, the loads can read that register directly and the store drop;
// once no captured access of a function remains, its env allocation is removed.
// ---------------------------------------------------------------------------

/**
 * Empty the body of every function unreachable from the entry via `createFunction`
 * edges. A function whose closure is never created can never run, so its body is
 * dead — after inlining + DCE removes a closure's `createFunction`, its original body
 * becomes unreachable. Emptying it reclaims code size AND unblocks env elimination
 * (the only remaining accesses of the definer's captured slots are then the inlined
 * ones, all inside the definer).
 *
 * Sound: `createFunction` and the CommonJS module table are the only roots that
 * reference functions as executable values (`loadCaptured`/`storeCaptured`'s
 * functionIndex is a scope id within the function's own — now dead — body). The
 * entry (index 0) is always live. `functionIndex` == array position is preserved:
 * functions are stubbed in place, never removed.
 */
export function optEmptyDeadFunctions(program: IntermediateProgram): boolean {
	const byIndex = new Map<number, IRFunction>();
	for (const fn of program.functions) {
		byIndex.set(fn.functionIndex, fn);
	}

	const live = new Set<number>([0, ...program.cjsWrapperFunctionIndex]);
	const worklist = [...live];
	while (worklist.length > 0) {
		const fn = byIndex.get(worklist.pop()!);
		if (fn === undefined) {
			continue;
		}
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.type === "createFunction" &&
					!live.has(instruction.functionIndex)
				) {
					live.add(instruction.functionIndex);
					worklist.push(instruction.functionIndex);
				}
			}
		}
	}

	let changed = false;
	for (const fn of program.functions) {
		if (live.has(fn.functionIndex)) {
			continue;
		}
		const onlyBlock = fn.blocks.length === 1 ? fn.blocks[0]! : undefined;
		const alreadyStub =
			onlyBlock !== undefined &&
			onlyBlock.instructions.length === 2 &&
			onlyBlock.instructions[0]!.type === "createUndefined";
		if (alreadyStub) {
			continue;
		}
		fn.blocks = [
			{
				instructions: [
					{ type: "createUndefined", registers: [0] },
					{ type: "return", registers: [0] },
				],
			},
		];
		fn.parameterCount = 0;
		fn.nextRegisterDestination = 1;
		fn.nextCapturedIndex = 0;
		fn.argumentsObjectRegister = undefined;
		fn.isGenerator = false;
		fn.isAsync = false;
		changed = true;
	}
	return changed;
}

interface CapturedSlotUse {
	fn: IRFunction;
	instruction: IRInstruction;
}

export interface CapturedSlotOptimizationFacts {
	/** Functions containing a structurally valid captured load or store. */
	readonly accessFunctions: ReadonlySet<IRFunction>;
	/** Functions containing a captured store targeting their own environment. */
	readonly storeOwnerFunctions: ReadonlySet<IRFunction>;
	/** Functions that currently declare at least one captured slot. */
	readonly environmentFunctions: ReadonlySet<IRFunction>;
	/** Captured/private-name instructions referencing each owning environment. */
	readonly environmentReferenceCounts: ReadonlyMap<number, number>;
}

/**
 * Replace captured slots that are provably internal to their owner with direct
 * register access, then drop the env of any function left with no captured access.
 * Conservative: a slot is internalized only when every load/store of it is in the
 * owner function, there is exactly one store, and its source register is
 * single-assignment (a stable value at every read).
 */
export function optEliminateCapturedSlots(
	program: IntermediateProgram,
	facts: CapturedSlotOptimizationFacts,
): boolean {
	// Gather, per (owner, idx), every load and store from the sparse access set,
	// plus definition counts only for functions with a possible owner-local store.
	const loadsBySlot = new Map<string, Array<CapturedSlotUse>>();
	const storesBySlot = new Map<string, Array<{ use: CapturedSlotUse; source: number }>>();
	const defCountByFn = new Map<number, Map<number, number>>();
	const environmentReferenceCounts = new Map(facts.environmentReferenceCounts);

	for (const fn of facts.storeOwnerFunctions) {
		const defCount = new Map<number, number>();
		for (const [register, definitions] of buildIRRegisterIndex(fn).definitions) {
			defCount.set(register, definitions.length);
		}
		defCountByFn.set(fn.functionIndex, defCount);
	}

	for (const fn of facts.accessFunctions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					(instruction.type === "loadCaptured" || instruction.type === "storeCaptured") &&
					instruction.functionIndex !== undefined &&
					instruction.index !== undefined
				) {
					const key = capturedSlotKey(instruction.functionIndex, instruction.index);
					if (instruction.type === "loadCaptured") {
						(loadsBySlot.get(key) ?? loadsBySlot.set(key, []).get(key)!).push({
							fn,
							instruction,
						});
					} else {
						(storesBySlot.get(key) ?? storesBySlot.set(key, []).get(key)!).push({
							use: { fn, instruction },
							source: instruction.registers[0],
						});
					}
				}
			}
		}
	}

	// Rewrite the loads of each internalizable slot to read the stored register and
	// mark the slot's store for removal. Keep the precomputed environment reference
	// counts exact as those instructions disappear.
	const dropStore = new Set<IRInstruction>();
	let changed = false;
	for (const [key, stores] of storesBySlot) {
		if (stores.length !== 1) {
			continue; // mutated (or never read with a single store): leave it
		}
		const ownerIndex = Number(key.split(":")[0]);
		if ((program.functions[ownerIndex]?.mappedArgumentSlots?.length ?? 0) > 0) {
			continue;
		}
		const store = stores[0]!;
		const loads = loadsBySlot.get(key) ?? [];
		// Every access must be in the owner function.
		if (
			store.use.fn.functionIndex !== ownerIndex ||
			loads.some((l) => l.fn.functionIndex !== ownerIndex)
		) {
			continue;
		}
		// The stored source must be single-assignment (stable at every read).
		if ((defCountByFn.get(ownerIndex)?.get(store.source) ?? 0) > 1) {
			continue;
		}
		for (const load of loads) {
			const mutable = load.instruction as {
				type: string;
				registers: Array<number>;
				functionIndex?: number;
				index?: number;
			};
			mutable.type = "move";
			mutable.registers = [mutable.registers[0]!, store.source];
			delete mutable.functionIndex;
			delete mutable.index;
			environmentReferenceCounts.set(
				ownerIndex,
				(environmentReferenceCounts.get(ownerIndex) ?? 1) - 1,
			);
		}
		dropStore.add(store.use.instruction);
		environmentReferenceCounts.set(
			ownerIndex,
			(environmentReferenceCounts.get(ownerIndex) ?? 1) - 1,
		);
		changed = true;
	}

	if (dropStore.size > 0) {
		for (const fn of program.functions) {
			for (const block of fn.blocks) {
				if (block.instructions.some((instruction) => dropStore.has(instruction))) {
					block.instructions = block.instructions.filter(
						(instruction) => !dropStore.has(instruction),
					);
				}
			}
		}
	}

	// Any function with no remaining captured access of its own slots needs no env.
	for (const fn of facts.environmentFunctions) {
		if (
			(environmentReferenceCounts.get(fn.functionIndex) ?? 0) === 0 &&
			(fn.mappedArgumentSlots?.length ?? 0) === 0
		) {
			fn.nextCapturedIndex = 0; // no env allocation needed
			changed = true;
		}
	}

	return changed;
}

/** Render the inlinable-call summary for `--dump-inline`. */
export function debugInlinableCalls(program: IntermediateProgram): string {
	const { byCaller } = findInlinableCalls(program);
	let output = "";
	for (const fn of program.functions) {
		const candidates = byCaller.get(fn.functionIndex);
		if (candidates === undefined || candidates.length === 0) {
			continue;
		}
		output += `fn#${fn.functionIndex}: ${candidates.length} inlinable call(s) → ${candidates
			.map(
				(candidate) =>
					`#${candidate.target}${
						partialEscapeInlineBlocked.has(candidate.call)
							? " (kept call: partial escape in cycle)"
							: ""
					}`,
			)
			.join(", ")}\n`;
	}
	log.info(output || "(no inlinable calls)\n");
	return output;
}

/** Human-readable dump of the HOF (array-iteration) inline sites (`--dump-hof`). */
export function debugHofInlineSites(program: IntermediateProgram): string {
	const { byCaller } = findHofInlineSites(program);
	let output = "";
	for (const fn of program.functions) {
		const sites = byCaller.get(fn.functionIndex);
		if (sites === undefined || sites.length === 0) {
			continue;
		}
		output += `fn#${fn.functionIndex}: ${sites.length} HOF site(s) → ${sites
			.map((site) => `${site.method}(callback #${site.callbackTarget})`)
			.join(", ")}\n`;
	}
	log.info(output || "(no HOF inline sites)\n");
	return output;
}
