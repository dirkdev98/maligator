import { COMPILER_VALUE_KIND_STRING } from "../shared/compiler-value-kinds.ts";
import { instructionInputKind } from "../shared/instruction-facts.ts";
import {
	materializeNativeStringCodePoint,
	nativeStringCodePointName,
	selectNativeStringCodePoints,
} from "./native-string-code-points.ts";
import type {
	NativeStringCodePointPlan,
	NativeStringCodePointSite,
} from "./native-string-code-points.ts";
import { selectNativeStringEnums } from "./native-string-enums.ts";
import type { NativeStringEnumPlan } from "./native-string-enums.ts";
import type { NativeFunctionPlan, VmRegisterRepresentation } from "./program-image.ts";
import {
	decodeVmValueOperand,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

/**
 * Function-local string accumulators.
 *
 * A web is a set of boxed registers that hold one accumulating String: each is
 * defined only by a reset (a String literal or a proven String copied in), by `+`
 * with a web register on the left, or by a copy of a web register. When at most
 * one web register is live at any point, the web's value can live in one native
 * unit buffer: appends write into it, and a heap String exists only where some
 * other operation reads a web register. JavaScript observes a String's content,
 * never its identity, so materializing at each such read is exact.
 *
 * Liveness enforces the single-value invariant: no web definition may leave another
 * register of its web live. The first web definition on every path is then a reset,
 * which initializes the builder before anything reads it.
 */
export interface NativeStringBuilderPlan {
	readonly builderCount: number;
	readonly actions: ReadonlyMap<number, NativeStringBuilderAction>;
	readonly codePoints?: NativeStringCodePointPlan;
	readonly enums?: NativeStringEnumPlan;
}

export interface NativeStringBuilderAction {
	/** Web registers to materialize before the instruction reads them. */
	readonly observations: ReadonlyArray<NativeStringBuilderObservation>;
	readonly operation?: NativeStringBuilderOperation;
}

export interface NativeStringBuilderObservation {
	readonly builder: number;
	readonly register: number;
}

export type NativeStringBuilderOperation =
	| {
			readonly kind: "append";
			readonly builder: number;
			readonly left: number;
			readonly right: number;
			/** Another fast path renders this `+`, so the builder only hands its value over. */
			readonly ordinary: boolean;
	  }
	| { readonly kind: "reset"; readonly builder: number; readonly empty: boolean }
	| { readonly kind: "length"; readonly builder: number }
	| {
			readonly kind: "equals";
			readonly builder: number;
			readonly other: number;
			readonly negated: boolean;
	  };

export interface NativeStringBuilderInputs {
	readonly representations: ReadonlyArray<VmRegisterRepresentation>;
	readonly handlerTargets: ReadonlyArray<number | undefined>;
	readonly loopInstructions: Uint8Array;
	readonly stringConstants: ReadonlyArray<ReadonlyArray<number>>;
	/** Whether a register operand of the instruction at `ip` is a String there. */
	readonly provenString: (ip: number, register: number) => boolean;
	/** Instructions that are not rendered in place: elided, unreachable or folded into another. */
	readonly skippedIps: ReadonlySet<number>;
	/** Registers read where another instruction renders them, outside instruction order. */
	readonly deferredReads: ReadonlySet<number>;
	/**
	 * Plans that render several instructions together. Any of `syncIps` may read what a
	 * claimed instruction reads, and a claimed instruction may not run its own emission.
	 */
	readonly foldedPlans: ReadonlyArray<NativeStringBuilderFoldedPlan>;
	/** Registers that a range rendered at once reads at its first instruction. */
	readonly forcedReads: ReadonlyMap<number, ReadonlyArray<number>>;
	/**
	 * Instructions another fast path renders. Their operands can be placeholders that
	 * only that rendering understands, and it can keep state the builder would skip.
	 */
	readonly actionIps: ReadonlySet<number>;
}

export interface NativeStringBuilderFoldedPlan {
	readonly claimedIps: ReadonlyArray<number>;
	readonly syncIps: ReadonlyArray<number>;
}

/** Each builder costs C stack, so a function keeps only its first few accumulators. */
const MAX_BUILDERS = 4;

const EQUALITY_OPERATORS: ReadonlyMap<string, boolean> = new Map([
	["===", false],
	["==", false],
	["!==", true],
	["!=", true],
]);

type Definition =
	| { readonly kind: "append"; readonly left: number; readonly right: number }
	| { readonly kind: "move"; readonly source: number }
	| { readonly kind: "constant"; readonly empty: boolean }
	| { readonly kind: "other" };

interface Projection {
	readonly operation: NativeStringBuilderOperation;
	readonly consumed: number;
}

export function selectNativeStringBuilders(
	fn: BytecodeFunction,
	inputs: NativeStringBuilderInputs,
): NativeStringBuilderPlan | undefined {
	const { instructions } = fn;
	const count = instructions.length;
	const constantText = (index: number) => inputs.stringConstants[index];
	const definitionOf = (ip: number): Definition => {
		const op = instructions[ip]!;
		if (op.opcode === "BINARY" && op.operator === "+" && op.left >= 0)
			return { kind: "append", left: op.left, right: op.right };
		if (op.opcode === "MOVE") {
			const source = decodeVmValueOperand(op.src);
			if (source.kind === "register") return { kind: "move", source: op.src };
			return source.kind === "string"
				? { kind: "constant", empty: constantText(source.index)?.length === 0 }
				: { kind: "other" };
		}
		if (op.opcode === "CREATE_STRING")
			return { kind: "constant", empty: constantText(op.stringIndex)?.length === 0 };
		return { kind: "other" };
	};

	const definitions = new Map<number, Array<number>>();
	const invalid = new Set<number>(inputs.deferredReads);
	for (let ip = 0; ip < count; ip++) {
		const writes = vmInstructionWriteRegisters(instructions[ip]!);
		for (const register of writes) {
			if (
				writes.length !== 1 ||
				inputs.skippedIps.has(ip) ||
				definitionOf(ip).kind === "other"
			)
				invalid.add(register);
			const list = definitions.get(register);
			if (list === undefined) definitions.set(register, [ip]);
			else list.push(ip);
		}
	}
	const appendsInLoop = (ips: ReadonlyArray<number>) =>
		ips.some(
			(ip) => inputs.loopInstructions[ip] === 1 && definitionOf(ip).kind === "append",
		);
	const candidates = new Set<number>();
	for (const register of definitions.keys()) {
		const representation = inputs.representations[register];
		if (
			register >= fn.parameterCount + fn.argumentSnapshotCount &&
			!invalid.has(register) &&
			(representation === "boxed" || representation === "string")
		)
			candidates.add(register);
	}
	if (![...candidates].some((register) => appendsInLoop(definitions.get(register)!)))
		return undefined;

	const claimedIps = new Set(inputs.foldedPlans.flatMap((plan) => plan.claimedIps));
	const live = registerLiveness(fn, inputs.handlerTargets, candidates);
	const constantOrigin = (register: number) => {
		const ips = definitions.get(register);
		if (ips?.length !== 1) return undefined;
		const origin = definitionOf(ips[0]!);
		return origin.kind === "constant" ? origin : undefined;
	};
	// A source still live after the copy or append keeps its own String, so the
	// definition cannot share its buffer.
	const sharesBuffer = (ip: number, source: number) =>
		candidates.has(source) && !live.out(ip, source);
	for (let changed = true; changed;) {
		changed = false;
		for (const register of candidates) {
			const valid = definitions.get(register)!.every((ip) => {
				const definition = definitionOf(ip);
				switch (definition.kind) {
					case "append":
						return sharesBuffer(ip, definition.left);
					case "move":
						return (
							sharesBuffer(ip, definition.source) ||
							constantOrigin(definition.source) !== undefined ||
							inputs.provenString(ip, definition.source)
						);
					case "constant":
						return true;
					case "other":
						return false;
				}
			});
			if (!valid) {
				candidates.delete(register);
				changed = true;
			}
		}
	}

	const parent = new Map([...candidates].map((register) => [register, register]));
	const find = (register: number): number => {
		let root = register;
		while (parent.get(root) !== root) root = parent.get(root)!;
		parent.set(register, root);
		return root;
	};
	const sharedSource = (ip: number): number | undefined => {
		const definition = definitionOf(ip);
		const source =
			definition.kind === "append"
				? definition.left
				: definition.kind === "move"
					? definition.source
					: undefined;
		return source !== undefined && sharesBuffer(ip, source) ? source : undefined;
	};
	for (const register of candidates)
		for (const ip of definitions.get(register)!) {
			const source = sharedSource(ip);
			if (source !== undefined) parent.set(find(register), find(source));
		}
	const webs = new Map<number, Array<number>>();
	for (const register of candidates) {
		const root = find(register);
		const members = webs.get(root);
		if (members === undefined) webs.set(root, [register]);
		else members.push(register);
	}

	const builderOf = new Map<number, number>();
	let builderCount = 0;
	for (const members of webs.values()) {
		if (builderCount === MAX_BUILDERS) break;
		const definitionIps = members.flatMap((register) =>
			definitions.get(register)!.map((ip) => ({ ip, register })),
		);
		if (
			!appendsInLoop(definitionIps.map(({ ip }) => ip)) ||
			definitionIps.some(({ ip }) => claimedIps.has(ip)) ||
			members.some((register) => live.in(0, register)) ||
			definitionIps.some(({ ip, register }) =>
				members.some((other) => other !== register && live.out(ip, other)),
			)
		)
			continue;
		for (const register of members) builderOf.set(register, builderCount);
		builderCount++;
	}
	if (builderCount === 0) return undefined;

	// A folded plan can read a claimed instruction's web operand at any of its positions.
	const syncs = new Map<number, Set<number>>();
	for (const plan of inputs.foldedPlans) {
		const reads = plan.claimedIps.flatMap((ip) =>
			vmInstructionReadRegisters(instructions[ip]!).filter((register) =>
				builderOf.has(register),
			),
		);
		for (const ip of reads.length === 0 ? [] : plan.syncIps)
			for (const register of reads)
				if (live.in(ip, register)) {
					const registers = syncs.get(ip);
					if (registers === undefined) syncs.set(ip, new Set([register]));
					else registers.add(register);
				}
	}

	const actions = new Map<number, NativeStringBuilderAction>();
	for (let ip = 0; ip < count; ip++) {
		if (inputs.skippedIps.has(ip)) continue;
		const op = instructions[ip]!;
		const writes = vmInstructionWriteRegisters(op);
		const defined = writes.length === 1 ? builderOf.get(writes[0]!) : undefined;
		let operation: NativeStringBuilderOperation | undefined;
		let consumed: number | undefined;
		if (defined !== undefined) {
			const definition = definitionOf(ip);
			const source = sharedSource(ip);
			if (definition.kind === "append") {
				operation = {
					kind: "append",
					builder: defined,
					left: definition.left,
					right: definition.right,
					ordinary: inputs.actionIps.has(ip),
				};
				// `s += s` reads the String the buffer held before it grows.
				if (definition.right !== definition.left) consumed = definition.left;
			} else if (source !== undefined) {
				consumed = source;
			} else {
				operation = {
					kind: "reset",
					builder: defined,
					empty:
						definition.kind === "constant"
							? definition.empty
							: definition.kind === "move" &&
								constantOrigin(definition.source)?.empty === true,
				};
			}
		} else if (!claimedIps.has(ip) && !inputs.actionIps.has(ip)) {
			const projected = projection(ip, op, builderOf, inputs);
			operation = projected?.operation;
			consumed = projected?.consumed;
		}
		const observations: Array<NativeStringBuilderObservation> = [];
		const observe = (register: number) => {
			const builder = builderOf.get(register);
			if (
				builder !== undefined &&
				register !== consumed &&
				!observations.some((observation) => observation.register === register)
			)
				observations.push({ builder, register });
		};
		for (const register of inputs.forcedReads.get(ip) ?? vmInstructionReadRegisters(op))
			observe(register);
		for (const register of syncs.get(ip) ?? []) observe(register);
		if (observations.length > 0 || operation !== undefined)
			actions.set(ip, {
				observations,
				...(operation === undefined ? {} : { operation }),
			});
	}
	return { builderCount, actions };
}

/** Instruction ranges that native rendering emits in some other way than one by one. */
export interface NativeStringBuilderRendering {
	readonly handlerTargets: ReadonlyArray<number | undefined>;
	readonly loopInstructions: Uint8Array;
	readonly unreachable: ReadonlySet<number>;
	readonly elided: ReadonlySet<number>;
	/** Values rendered where they are used, so their operands are read there. */
	readonly expressionIps: ReadonlySet<number>;
	readonly rematerializedConstantIps: ReadonlySet<number>;
	/** Comparison chains rendered as one switch over their selector at their first instruction. */
	readonly switches: ReadonlyArray<
		NonNullable<NativeFunctionPlan["literalSwitches"]>[number]
	>;
	readonly codePointSteps?: ReadonlyArray<NativeStringCodePointSite>;
	/** Regions that render a copy of their instructions at their entry. */
	readonly regions: ReadonlyArray<{
		readonly entryIp: number;
		readonly claimedIps: ReadonlyArray<number>;
	}>;
	/**
	 * Fast-path plans and regions of any kind, as plan lists or single plans. One that
	 * claims several instructions can render one instruction's operands at another's
	 * position.
	 */
	readonly plans: Iterable<unknown>;
	/** Per-instruction fast-path actions, keyed by instruction. */
	readonly actions: Iterable<ReadonlyMap<number, unknown>>;
}

function planClaimedIps(plan: unknown): ReadonlyArray<number> {
	if (typeof plan !== "object" || plan === null || !("claimedIps" in plan)) return [];
	const { claimedIps } = plan;
	return Array.isArray(claimedIps) ? (claimedIps as ReadonlyArray<number>) : [];
}

export function planNativeStringBuilders(
	fn: BytecodeFunction,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	facts: NativeFunctionPlan["facts"],
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	rendering: NativeStringBuilderRendering,
): NativeStringBuilderPlan | undefined {
	const skippedIps = new Set([
		...rendering.unreachable,
		...rendering.elided,
		...rendering.expressionIps,
		...rendering.rematerializedConstantIps,
	]);
	const deferredReads = new Set<number>();
	for (const ip of rendering.expressionIps)
		if (!rendering.elided.has(ip))
			for (const register of vmInstructionReadRegisters(fn.instructions[ip]!))
				deferredReads.add(register);
	const foldedPlans: Array<NativeStringBuilderFoldedPlan> = [];
	const forcedReads = new Map<number, ReadonlyArray<number>>();
	for (const site of rendering.switches) {
		const reads = new Set<number>();
		for (let ip = site.instructionIp; ip <= site.endIp; ip++) {
			for (const register of vmInstructionReadRegisters(fn.instructions[ip]!))
				reads.add(register);
			if (ip > site.instructionIp) skippedIps.add(ip);
		}
		foldedPlans.push({ claimedIps: [site.instructionIp], syncIps: [] });
		forcedReads.set(site.instructionIp, [...reads]);
	}
	for (const region of rendering.regions)
		foldedPlans.push({
			claimedIps: region.claimedIps,
			syncIps: [region.entryIp, ...region.claimedIps],
		});
	for (const entry of rendering.plans)
		for (const plan of Array.isArray(entry)
			? (entry as ReadonlyArray<unknown>)
			: [entry]) {
			const claimedIps = planClaimedIps(plan);
			if (claimedIps.length > 0) foldedPlans.push({ claimedIps, syncIps: claimedIps });
		}
	const inputs: NativeStringBuilderInputs = {
		representations,
		handlerTargets: rendering.handlerTargets,
		loopInstructions: rendering.loopInstructions,
		stringConstants,
		provenString: (ip, register) =>
			representations[register] === "string" ||
			instructionInputKind(facts?.[ip], register) === COMPILER_VALUE_KIND_STRING,
		skippedIps,
		deferredReads,
		foldedPlans,
		forcedReads,
		actionIps: new Set([...rendering.actions].flatMap((actions) => [...actions.keys()])),
	};
	const builders = selectNativeStringBuilders(fn, inputs);
	if (fn.profileSiteIds !== undefined) return builders;
	const enums = selectNativeStringEnums(fn, inputs, rendering.switches);
	if (builders === undefined && enums === undefined) return undefined;
	const plan = builders ?? {
		builderCount: 0,
		actions: new Map<number, NativeStringBuilderAction>(),
	};
	const codePoints = selectNativeStringCodePoints(
		fn,
		inputs,
		plan,
		rendering.codePointSteps ?? [],
		rendering.switches,
	);
	return {
		...plan,
		...(codePoints === undefined ? {} : { codePoints }),
		...(enums === undefined ? {} : { enums }),
	};
}

function projection(
	ip: number,
	op: BytecodeInstruction,
	builderOf: ReadonlyMap<number, number>,
	inputs: NativeStringBuilderInputs,
): Projection | undefined {
	if (op.opcode === "LOAD_PROPERTY_STATIC") {
		const builder = builderOf.get(op.object);
		const name = inputs.stringConstants[op.stringIndex];
		return builder !== undefined &&
			name !== undefined &&
			String.fromCharCode(...name) === "length"
			? { operation: { kind: "length", builder }, consumed: op.object }
			: undefined;
	}
	if (op.opcode !== "BINARY") return undefined;
	const negated = EQUALITY_OPERATORS.get(op.operator);
	if (negated === undefined) return undefined;
	const left = builderOf.get(op.left);
	const right = builderOf.get(op.right);
	if ((left === undefined) === (right === undefined)) return undefined;
	const [builder, accumulator, other] =
		left === undefined ? [right!, op.right, op.left] : [left, op.left, op.right];
	// Loose equality coerces the String unless the other side is a String too.
	const strict = op.operator === "===" || op.operator === "!==";
	const decoded = decodeVmValueOperand(other);
	const otherIsString =
		decoded.kind === "string" ||
		(decoded.kind === "register" && inputs.provenString(ip, other));
	return strict || otherIsString
		? { operation: { kind: "equals", builder, other, negated }, consumed: accumulator }
		: undefined;
}

interface RegisterLiveness {
	in(ip: number, register: number): boolean;
	out(ip: number, register: number): boolean;
}

/**
 * Liveness of the given registers over every instruction, including exception edges:
 * an instruction can throw before it writes, so its handler's live registers stay live
 * through it.
 */
function registerLiveness(
	fn: BytecodeFunction,
	handlerTargets: ReadonlyArray<number | undefined>,
	registers: ReadonlySet<number>,
): RegisterLiveness {
	const { instructions } = fn;
	const count = instructions.length;
	const index = new Map([...registers].map((register, slot) => [register, slot]));
	const words = Math.max(1, Math.ceil(index.size / 32));
	const liveIn = new Uint32Array(count * words);
	const liveOut = new Uint32Array(count * words);
	const uses = new Uint32Array(count * words);
	const kills = new Uint32Array(count * words);
	const successors: Array<ReadonlyArray<number>> = [];
	const predecessors: Array<Array<number>> = Array.from({ length: count }, () => []);
	const mark = (bits: Uint32Array, ip: number, register: number) => {
		const slot = index.get(register);
		if (slot !== undefined) bits[ip * words + (slot >>> 5)]! |= 1 << (slot & 31);
	};
	for (let ip = 0; ip < count; ip++) {
		const op = instructions[ip]!;
		for (const register of vmInstructionReadRegisters(op)) mark(uses, ip, register);
		for (const register of vmInstructionWriteRegisters(op)) mark(kills, ip, register);
		const next: Array<number> = [];
		if (op.opcode === "JUMP") next.push(op.targetIp);
		else if (op.opcode === "JUMP_IF") next.push(op.targetIp, ip + 1);
		else if (op.opcode !== "RETURN" && op.opcode !== "THROW") next.push(ip + 1);
		if (op.opcode === "TRY_BEGIN") next.push(op.handlerIp);
		const handler = handlerTargets[ip];
		if (handler !== undefined) next.push(handler);
		const targets = next.filter((target) => target >= 0 && target < count);
		successors.push(targets);
		for (const target of targets) predecessors[target]!.push(ip);
	}
	const pending: Array<number> = [];
	const queued = new Uint8Array(count).fill(1);
	for (let ip = 0; ip < count; ip++) pending.push(ip);
	while (pending.length > 0) {
		const ip = pending.pop()!;
		queued[ip] = 0;
		const handler = handlerTargets[ip];
		let changed = false;
		for (let word = 0; word < words; word++) {
			const at = ip * words + word;
			let out = 0;
			for (const target of successors[ip]!) out |= liveIn[target * words + word]!;
			liveOut[at] = out;
			// A throwing instruction has not written its result for its handler.
			const exceptional = handler === undefined ? 0 : liveIn[handler * words + word]!;
			const value = (uses[at]! | (out & ~kills[at]!) | exceptional) >>> 0;
			if (value !== liveIn[at]) {
				liveIn[at] = value;
				changed = true;
			}
		}
		if (!changed) continue;
		for (const predecessor of predecessors[ip]!)
			if (queued[predecessor] === 0) {
				queued[predecessor] = 1;
				pending.push(predecessor);
			}
	}
	const test = (bits: Uint32Array, ip: number, register: number) => {
		const slot = index.get(register);
		return (
			slot !== undefined && (bits[ip * words + (slot >>> 5)]! & (1 << (slot & 31))) !== 0
		);
	};
	return {
		in: (ip, register) => test(liveIn, ip, register),
		out: (ip, register) => test(liveOut, ip, register),
	};
}

/** Function-scope state for each builder; a reset initializes it before any use. */
export function nativeStringBuilderDeclarations(
	plan: NativeStringBuilderPlan | undefined,
): ReadonlyArray<string> {
	return Array.from(
		{ length: plan?.builderCount ?? 0 },
		(_, builder) => `MalLocalStringBuilder __sb_${builder};`,
	);
}

/**
 * Wraps an instruction's ordinary rendering with its builder operation. The ordinary
 * rendering stays the fallback, so a declined fast path behaves exactly as before.
 */
export function renderNativeStringBuilderOperation(
	action: NativeStringBuilderAction | undefined,
	op: BytecodeInstruction,
	ordinary: ReadonlyArray<string>,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	stringValue: (index: number) => string,
	codePoint?: NativeStringCodePointSite,
): ReadonlyArray<string> {
	const operation = action?.operation;
	if (operation === undefined || !("dst" in op)) return ordinary;
	const builder = `__sb_${operation.builder}`;
	const dst = op.dst;
	const indented = ordinary.map((line) => `  ${line}`);
	switch (operation.kind) {
		case "append": {
			// An inactive builder's register holds a String, which a later append adopts.
			const fallback = [
				...(codePoint === undefined ? [] : [materializeNativeStringCodePoint(codePoint)]),
				`MAL_PERF_COUNT(string_builder_fallbacks);`,
				`if (${builder}.active && !${builder}.synced) r${operation.left} = mal_local_string_builder_materialize(vm, &${builder});`,
				`${builder}.active = false;`,
				...ordinary,
			];
			if (operation.ordinary) return fallback;
			const right = boxedOperand(operation.right, representations, stringValue);
			const append =
				codePoint === undefined
					? `mal_local_string_builder_append(&${builder}, ${right})`
					: `(${nativeStringCodePointName(codePoint)}_active ? mal_local_string_builder_append_code_point(&${builder}, ${nativeStringCodePointName(codePoint)}) : mal_local_string_builder_append(&${builder}, ${right}))`;
			return [
				`if ((${builder}.active || mal_local_string_builder_adopt(&${builder}, r${operation.left})) && ${append}) {`,
				`  r${dst} = MAL_VALUE_UNDEFINED;`,
				`} else {`,
				...fallback.map((line) => `  ${line}`),
				`}`,
			];
		}
		case "reset":
			return [
				...ordinary,
				operation.empty
					? `mal_local_string_builder_clear(&${builder});`
					: `${builder}.active = false;`,
			];
		case "length": {
			const length = `${builder}.length`;
			const representation = representations[dst];
			const value =
				representation === "int32"
					? `(i32) ${length}`
					: representation === "number"
						? `(f64) ${length}`
						: representation === "boxed" || representation === "string"
							? `mal_value_from_i32((i32) ${length})`
							: undefined;
			return value === undefined
				? ordinary
				: [
						`if (${builder}.active) {`,
						`  MAL_PERF_COUNT(string_builder_projections);`,
						`  r${dst} = ${value};`,
						`} else {`,
						...indented,
						`}`,
					];
		}
		case "equals": {
			const equal = `${operation.negated ? "!" : ""}mal_local_string_builder_equals(&${builder}, ${boxedOperand(operation.other, representations, stringValue)})`;
			const representation = representations[dst];
			const value =
				representation === "boolean"
					? equal
					: representation === "boxed"
						? `mal_value_new_boolean(${equal})`
						: undefined;
			return value === undefined
				? ordinary
				: [
						`if (${builder}.active) {`,
						`  r${dst} = ${value};`,
						`} else {`,
						...indented,
						`}`,
					];
		}
	}
}

function boxedOperand(
	operand: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	stringValue: (index: number) => string,
): string {
	const decoded = decodeVmValueOperand(operand);
	switch (decoded.kind) {
		case "register": {
			const register = `r${decoded.register}`;
			switch (representations[decoded.register]) {
				case "int32":
					return `mal_value_from_i32(${register})`;
				case "number":
					return `mal_ops_number_value(${register})`;
				case "boolean":
					return `mal_value_new_boolean(${register})`;
				default:
					return register;
			}
		}
		case "undefined":
			return "MAL_VALUE_UNDEFINED";
		case "null":
			return "MAL_VALUE_NULL";
		case "boolean":
			return `MAL_VALUE_${decoded.value ? "TRUE" : "FALSE"}`;
		case "number":
			return `mal_value_from_i32(${decoded.value})`;
		case "string":
			return stringValue(decoded.index);
	}
}
