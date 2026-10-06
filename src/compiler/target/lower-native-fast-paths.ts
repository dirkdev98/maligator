import type {
	NativeDirectEntryPlan,
	NativeFunctionPlan,
	VmRegisterRepresentation,
} from "./program-image.ts";
import {
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionUsesRegister,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

type StaticPropertyLoad = Extract<
	BytecodeInstruction,
	{ opcode: "LOAD_PROPERTY_STATIC" }
>;

export type NativePropertyProjectionOperand =
	| { readonly kind: "load"; readonly index: number }
	| { readonly kind: "step"; readonly index: number }
	| { readonly kind: "register"; readonly register: number };

export interface NativePropertyProjectionStep {
	readonly ip: number;
	readonly left: NativePropertyProjectionOperand;
	readonly right: NativePropertyProjectionOperand;
}

export interface NativePropertyProjectionPlan {
	readonly id: number;
	readonly object: number;
	readonly loads: ReadonlyArray<{ readonly ip: number; readonly icIndex: number }>;
	readonly steps: ReadonlyArray<NativePropertyProjectionStep>;
	readonly boxedRegisters: ReadonlyArray<number>;
	readonly skippedIps: ReadonlyArray<number>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-instructions";
	readonly terminalStore?: {
		readonly ip: number;
	};
}

type StaticPropertyStore = Extract<
	BytecodeInstruction,
	{ opcode: "STORE_PROPERTY_STATIC" }
>;

export interface NativePropertyNumericUpdatePlan {
	readonly id: number;
	readonly load: StaticPropertyLoad;
	readonly store: StaticPropertyStore;
	readonly storeIp: number;
	readonly operationIp: number;
	readonly constantIp?: number;
	readonly operation:
		| { readonly kind: "unary"; readonly operator: "increment" | "decrement" }
		| {
				readonly kind: "binary";
				readonly operator: string;
				readonly propertyIsLeft: boolean;
				readonly right:
					| { readonly kind: "literal"; readonly value: number }
					| { readonly kind: "register"; readonly register: number };
		  };
}

export interface NativePropertyNumericUpdateAction {
	readonly plan: NativePropertyNumericUpdatePlan;
	readonly role: "load" | "operation" | "skip";
}

export type NativePropertyProjectionAction =
	| {
			readonly role: "load";
			readonly plan: NativePropertyProjectionPlan;
			readonly index: number;
	  }
	| {
			readonly role: "step";
			readonly plan: NativePropertyProjectionPlan;
			readonly index: number;
	  }
	| { readonly role: "store"; readonly plan: NativePropertyProjectionPlan }
	| { readonly role: "skip"; readonly plan: NativePropertyProjectionPlan };

/** A decline resumes the retained instructions and cannot reuse this admission. */
export interface NativePropertyReadRegionPlan {
	readonly id: number;
	readonly object: number;
	readonly endIp: number;
	readonly loads: ReadonlyArray<{
		readonly ip: number;
		readonly instruction: StaticPropertyLoad;
	}>;
	readonly continuation: "remaining-instructions";
}

export interface NativePropertyReadRegionAction {
	readonly plan: NativePropertyReadRegionPlan;
	readonly index: number;
}

export interface NativeFastPathLowering {
	readonly propertyNumericUpdates: ReadonlyArray<NativePropertyNumericUpdatePlan>;
	readonly propertyNumericUpdateActions: ReadonlyMap<
		number,
		NativePropertyNumericUpdateAction
	>;
	readonly propertyProjections: ReadonlyArray<NativePropertyProjectionPlan>;
	readonly propertyProjectionActions: ReadonlyMap<number, NativePropertyProjectionAction>;
	readonly propertyReadRegions: ReadonlyArray<NativePropertyReadRegionPlan>;
	readonly propertyReadRegionActions: ReadonlyMap<number, NativePropertyReadRegionAction>;
	readonly pairedArrayLoops: ReadonlyArray<NativePairedArrayLoopPlan>;
	readonly pairedArrayLoopActions: ReadonlyMap<number, NativePairedArrayLoopAction>;
	readonly constructorInitialization?: NativeConstructorInitializationPlan;
	readonly constructorInitializationActions: ReadonlyMap<
		number,
		NativeConstructorInitializationAction
	>;
	readonly privateFieldReserve?: NativePrivateFieldReservePlan;
}

export interface NativeIndexedLoopElement {
	readonly lengthLoadIp: number;
	readonly elementLoadIp: number;
	readonly object: number;
	readonly key: number;
	readonly result: number;
}

export interface NativePairedArrayLoopPlan {
	readonly id: number;
	readonly lengthLoadIp: number;
	readonly primaryLoadIp: number;
	readonly primaryObject: number;
	readonly secondaryLoadIp: number;
	readonly secondaryObject: number;
	readonly key: number;
}

export type NativePairedArrayLoopAction =
	| { readonly role: "admit"; readonly plan: NativePairedArrayLoopPlan }
	| { readonly role: "load"; readonly plan: NativePairedArrayLoopPlan };

export interface NativeConstructorInitializationPlan {
	readonly id: number;
	readonly stores: ReadonlyArray<{
		readonly ip: number;
		readonly instruction: StaticPropertyStore;
	}>;
}

export interface NativeConstructorInitializationAction {
	readonly plan: NativeConstructorInitializationPlan;
	readonly index: number;
}

export interface NativePrivateFieldReservePlan {
	readonly id: number;
	readonly count: number;
}

const NATIVE_NUMBER_BINARY_OPERATORS = new Set([
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
]);

function isNumericRepresentation(representation: VmRegisterRepresentation): boolean {
	return representation === "number" || representation === "int32";
}

// Moving later property reads ahead of these instructions must not allocate, poll, or run JavaScript.
function harmlessScalarInstruction(
	instruction: BytecodeInstruction,
	representations: ReadonlyArray<VmRegisterRepresentation>,
): boolean {
	return (
		instruction.opcode === "CREATE_NUMBER" ||
		instruction.opcode === "CREATE_F64" ||
		instruction.opcode === "CREATE_BOOLEAN" ||
		(instruction.opcode === "MOVE" &&
			representations[instruction.src] !== "boxed" &&
			representations[instruction.dst] !== "boxed")
	);
}

function registerEscapesPlan(
	fn: BytecodeFunction,
	register: number,
	startIp: number,
	handlerTargets: ReadonlyArray<number | undefined>,
): boolean {
	const pending = [startIp];
	const visited = new Set<number>();
	while (pending.length > 0) {
		const ip = pending.pop()!;
		if (ip === fn.instructions.length) continue;
		if (ip < 0 || ip > fn.instructions.length) return true;
		if (visited.has(ip)) continue;
		visited.add(ip);
		const instruction = fn.instructions[ip]!;
		if (vmInstructionUsesRegister(instruction, register)) return true;
		const handlerIp = handlerTargets[ip];
		if (handlerIp !== undefined) pending.push(handlerIp);
		if (
			instruction.opcode === "YIELD" ||
			instruction.opcode === "AWAIT" ||
			instruction.opcode === "GENERATOR_START" ||
			instruction.opcode === "TRY_BEGIN"
		)
			return true;
		if (vmInstructionWriteRegisters(instruction).includes(register)) continue;
		if (instruction.opcode === "JUMP") {
			pending.push(instruction.targetIp);
		} else if (instruction.opcode === "JUMP_IF") {
			pending.push(instruction.targetIp, ip + 1);
		} else if (instruction.opcode !== "RETURN" && instruction.opcode !== "THROW") {
			pending.push(ip + 1);
		}
	}
	return false;
}

function lowerPropertyNumericUpdate(
	fn: BytecodeFunction,
	firstIp: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
): NativePropertyNumericUpdatePlan | undefined {
	const load = fn.instructions[firstIp];
	if (
		load?.opcode !== "LOAD_PROPERTY_STATIC" ||
		load.object === load.dst ||
		representations[load.object] !== "boxed" ||
		representations[load.dst] !== "boxed" ||
		conflicts(firstIp)
	)
		return undefined;
	let ip = firstIp + 1;
	const admissible = () => !jumpTargets.has(ip) && !conflicts(ip);
	if (!admissible()) return undefined;
	const coercion = fn.instructions[ip];
	if (
		coercion?.opcode === "UNARY" &&
		coercion.operator === "tonumeric" &&
		coercion.src === load.dst &&
		coercion.dst === load.dst
	) {
		ip++;
		if (!admissible()) return undefined;
	}
	let literal: number | undefined;
	let literalRegister: number | undefined;
	let constantIp: number | undefined;
	const constant = fn.instructions[ip];
	if (
		(constant?.opcode === "CREATE_NUMBER" || constant?.opcode === "CREATE_F64") &&
		constant.dst !== load.object &&
		constant.dst !== load.dst
	) {
		literal = constant.value;
		literalRegister = constant.dst;
		constantIp = ip;
		ip++;
		if (!admissible()) return undefined;
	}
	const operationIp = ip;
	const instruction = fn.instructions[ip];
	let operation: NativePropertyNumericUpdatePlan["operation"];
	if (
		instruction?.opcode === "UNARY" &&
		(instruction.operator === "increment" || instruction.operator === "decrement") &&
		instruction.src === load.dst &&
		instruction.dst === load.dst
	) {
		operation = { kind: "unary", operator: instruction.operator };
	} else if (
		instruction?.opcode === "BINARY" &&
		NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator) &&
		instruction.dst === load.dst &&
		(instruction.left === load.dst || instruction.right === load.dst)
	) {
		const propertyIsLeft = instruction.left === load.dst;
		const other = propertyIsLeft ? instruction.right : instruction.left;
		if (other === load.object || other === load.dst) return undefined;
		if (literalRegister !== undefined && other !== literalRegister) return undefined;
		if (
			literalRegister === undefined &&
			representations[other] !== "boxed" &&
			!isNumericRepresentation(representations[other]!)
		)
			return undefined;
		operation = {
			kind: "binary",
			operator: instruction.operator,
			propertyIsLeft,
			right:
				literalRegister === other
					? { kind: "literal", value: literal! }
					: { kind: "register", register: other },
		};
	} else {
		return undefined;
	}
	if (literalRegister !== undefined && operation.kind !== "binary") return undefined;
	ip++;
	if (!admissible()) return undefined;
	const store = fn.instructions[ip];
	if (
		store?.opcode !== "STORE_PROPERTY_STATIC" ||
		store.object !== load.object ||
		store.value !== load.dst
	)
		return undefined;
	return Object.freeze({
		id: firstIp,
		load,
		store,
		storeIp: ip,
		operationIp,
		...(constantIp === undefined ? {} : { constantIp }),
		operation,
	});
}

function lowerPropertyProjection(
	fn: BytecodeFunction,
	firstIp: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
	terminalFusion: (
		ip: number,
	) => { readonly id: number; readonly role: "start" | "finish" } | undefined,
	transparentJumpTargets: ReadonlySet<number>,
	handlerTargets: ReadonlyArray<number | undefined>,
): NativePropertyProjectionPlan | undefined {
	const first = fn.instructions[firstIp];
	if (
		first?.opcode !== "LOAD_PROPERTY_STATIC" ||
		first.dst === first.object ||
		representations[first.dst] !== "boxed" ||
		conflicts(firstIp)
	) {
		return undefined;
	}
	const loads: Array<{ ip: number; instruction: StaticPropertyLoad }> = [
		{ ip: firstIp, instruction: first },
	];
	const aliases = new Map<number, NativePropertyProjectionOperand>([
		[first.dst, { kind: "load", index: 0 }],
	]);
	const produced = new Map<number, number>([[first.dst, firstIp]]);
	const usedLoads = new Set<number>();
	const boxedRegisters = new Map<number, number>();
	const skippedIps = new Set<number>();
	const steps: Array<
		NativePropertyProjectionStep & {
			instruction: Extract<BytecodeInstruction, { opcode: "BINARY" }>;
		}
	> = [];
	let receiverClobbered = false;
	const limit = Math.min(fn.instructions.length, firstIp + 20);
	for (let ip = firstIp + 1; ip < limit; ip++) {
		if ((jumpTargets.has(ip) && !transparentJumpTargets.has(ip)) || conflicts(ip)) break;
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "JUMP" && instruction.targetIp === ip + 1) {
			skippedIps.add(ip);
			continue;
		}
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			instruction.object === first.object &&
			!receiverClobbered &&
			representations[instruction.dst] === "boxed" &&
			loads.length < 4
		) {
			const index = loads.length;
			loads.push({ ip, instruction });
			aliases.set(instruction.dst, { kind: "load", index });
			produced.set(instruction.dst, ip);
			receiverClobbered = instruction.dst === first.object;
			continue;
		}
		if (instruction.opcode === "THROW_IF_TDZ" && aliases.has(instruction.src)) {
			skippedIps.add(ip);
			continue;
		}
		if (instruction.opcode === "MOVE" && aliases.has(instruction.src)) {
			if (representations[instruction.dst] !== "boxed") break;
			aliases.set(instruction.dst, aliases.get(instruction.src)!);
			produced.set(instruction.dst, ip);
			skippedIps.add(ip);
			receiverClobbered ||= instruction.dst === first.object;
			continue;
		}
		if (
			instruction.opcode === "BINARY" &&
			NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator)
		) {
			const operand = (register: number): NativePropertyProjectionOperand | undefined =>
				aliases.get(register) ??
				(isNumericRepresentation(representations[register]!) ||
				representations[register] === "boxed"
					? { kind: "register", register }
					: undefined);
			const left = operand(instruction.left);
			const right = operand(instruction.right);
			const consumesProjection =
				aliases.has(instruction.left) || aliases.has(instruction.right);
			const consumesPrevious =
				steps.length === 0 ||
				(left?.kind === "step" && left.index === steps.length - 1) ||
				(right?.kind === "step" && right.index === steps.length - 1);
			if (
				left === undefined ||
				right === undefined ||
				!consumesProjection ||
				!consumesPrevious
			) {
				break;
			}
			for (const candidate of [left, right]) {
				if (candidate.kind === "load") usedLoads.add(candidate.index);
				if (
					candidate.kind === "register" &&
					representations[candidate.register] === "boxed"
				)
					boxedRegisters.set(candidate.register, ip);
			}
			const index = steps.length;
			steps.push({ ip, instruction, left, right });
			aliases.set(instruction.dst, { kind: "step", index });
			produced.set(instruction.dst, ip);
			receiverClobbered ||= instruction.dst === first.object;
			continue;
		}
		const touchesProjection = [...aliases.keys()].some(
			(register) =>
				vmInstructionUsesRegister(instruction, register) ||
				vmInstructionWriteRegisters(instruction).includes(register),
		);
		if (
			touchesProjection ||
			vmInstructionWriteRegisters(instruction).includes(first.object) ||
			!harmlessScalarInstruction(instruction, representations)
		)
			break;
	}
	if (steps.length === 0) return undefined;
	const lastIp = steps.at(-1)!.ip;
	if (loads.length < 2 || loads.some((_load, index) => !usedLoads.has(index))) {
		return undefined;
	}
	for (const [register, consumingIp] of boxedRegisters) {
		for (let ip = firstIp + 1; ip <= lastIp; ip++) {
			if (
				ip !== consumingIp &&
				vmInstructionWriteRegisters(fn.instructions[ip]!).includes(register)
			)
				return undefined;
		}
	}
	const finalRegister = steps.at(-1)!.instruction.dst;
	for (const [register, producedIp] of produced) {
		if (producedIp > lastIp) continue;
		if (register === finalRegister) continue;
		if (registerEscapesPlan(fn, register, lastIp + 1, handlerTargets)) return undefined;
	}
	const storeIp = lastIp + 1;
	const store = fn.instructions[storeIp];
	const fusedSteps =
		steps.length === 2 &&
		terminalFusion(steps[0]!.ip)?.role === "start" &&
		terminalFusion(lastIp)?.role === "finish" &&
		terminalFusion(steps[0]!.ip)?.id === terminalFusion(lastIp)?.id;
	const standaloneSteps = steps.every((step) => terminalFusion(step.ip) === undefined);
	const terminalStore =
		loads.length === 2 &&
		(fusedSteps || standaloneSteps) &&
		loads[1]!.instruction.dst !== first.object &&
		finalRegister !== first.object &&
		representations[finalRegister] === "boxed" &&
		store?.opcode === "STORE_PROPERTY_STATIC" &&
		store.object === first.object &&
		store.stringIndex === first.stringIndex &&
		store.value === finalRegister &&
		!jumpTargets.has(storeIp) &&
		!conflicts(storeIp) &&
		terminalFusion(storeIp) === undefined &&
		!registerEscapesPlan(fn, finalRegister, storeIp + 1, handlerTargets)
			? { ip: storeIp, instruction: store }
			: undefined;
	const skipped = [...skippedIps].filter((ip) => ip <= lastIp);
	const claimedIps = [
		...loads.filter((load) => load.ip <= lastIp).map((load) => load.ip),
		...steps.map((step) => step.ip),
		...skipped,
		...(terminalStore === undefined ? [] : [terminalStore.ip]),
	].sort((left, right) => left - right);
	const borrowedRegisters = [
		...new Set(
			claimedIps.flatMap((ip) => [
				...vmInstructionReadRegisters(fn.instructions[ip]!),
				...vmInstructionWriteRegisters(fn.instructions[ip]!),
			]),
		),
	].sort((left, right) => left - right);
	return Object.freeze({
		id: firstIp,
		object: first.object,
		loads: loads.map(({ ip, instruction }) => ({ ip, icIndex: instruction.icIndex })),
		steps: steps.map(({ ip, left, right }) => ({ ip, left, right })),
		boxedRegisters: Object.freeze([...boxedRegisters.keys()]),
		skippedIps: skipped,
		claimedIps,
		borrowedRegisters,
		fallback: "original-instructions",
		...(terminalStore === undefined ? {} : { terminalStore: { ip: terminalStore.ip } }),
	});
}

const PROPERTY_REGION_COMPARE_OPERATORS = new Set([
	"===",
	"!==",
	"==",
	"!=",
	"<",
	"<=",
	">",
	">=",
]);

const PROPERTY_REGION_UNARY_OPERATORS = new Set([
	"+",
	"-",
	"~",
	"!",
	"tonumeric",
	"increment",
	"decrement",
]);

function propertyReadRegionPureInstruction(
	instruction: BytecodeInstruction,
	representations: ReadonlyArray<VmRegisterRepresentation>,
): boolean {
	switch (instruction.opcode) {
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_BOOLEAN":
			return true;
		case "MOVE":
			return (
				representations[instruction.src] === representations[instruction.dst] ||
				(isNumericRepresentation(representations[instruction.src]!) &&
					isNumericRepresentation(representations[instruction.dst]!))
			);
		case "BINARY":
			return (
				isNumericRepresentation(representations[instruction.left]!) &&
				isNumericRepresentation(representations[instruction.right]!) &&
				(isNumericRepresentation(representations[instruction.dst]!) ||
					representations[instruction.dst] === "boolean") &&
				(NATIVE_NUMBER_BINARY_OPERATORS.has(instruction.operator) ||
					PROPERTY_REGION_COMPARE_OPERATORS.has(instruction.operator))
			);
		case "UNARY":
			return (
				isNumericRepresentation(representations[instruction.src]!) &&
				(isNumericRepresentation(representations[instruction.dst]!) ||
					representations[instruction.dst] === "boolean") &&
				PROPERTY_REGION_UNARY_OPERATORS.has(instruction.operator)
			);
		default:
			return false;
	}
}

function lowerPropertyReadRegion(
	fn: BytecodeFunction,
	firstIp: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
): NativePropertyReadRegionPlan | undefined {
	const first = fn.instructions[firstIp];
	if (
		first?.opcode !== "LOAD_PROPERTY_STATIC" ||
		first.object === first.dst ||
		representations[first.object] !== "boxed" ||
		representations[first.dst] !== "boxed" ||
		conflicts(firstIp)
	) {
		return undefined;
	}
	const loads = [{ ip: firstIp, instruction: first }];
	const limit = Math.min(fn.instructions.length, firstIp + 24);
	for (let ip = firstIp + 1; ip < limit; ip++) {
		if (jumpTargets.has(ip) || conflicts(ip)) break;
		const instruction = fn.instructions[ip]!;
		if (
			instruction.opcode === "LOAD_PROPERTY_STATIC" &&
			instruction.object === first.object &&
			representations[instruction.dst] === "boxed"
		) {
			loads.push({ ip, instruction });
			if (loads.length === 8 || instruction.dst === first.object) break;
			continue;
		}
		// Captured storage is valid only while the receiver is unchanged and no
		// operation can collect, reenter JavaScript, throw, or mutate its layout.
		if (
			vmInstructionWriteRegisters(instruction).includes(first.object) ||
			!propertyReadRegionPureInstruction(instruction, representations)
		) {
			break;
		}
	}
	if (loads.length < 2 || (loads.length === 2 && loads[1]!.ip === firstIp + 1)) {
		// Preserve the smaller existing adjacent-pair admission.
		return undefined;
	}
	return Object.freeze({
		id: firstIp,
		object: first.object,
		endIp: loads.at(-1)!.ip,
		loads: Object.freeze(loads.map((load) => Object.freeze(load))),
		continuation: "remaining-instructions",
	});
}

function lowerConstructorInitialization(
	fn: BytecodeFunction,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
): NativeConstructorInitializationPlan | undefined {
	if (!fn.isClassConstructor || fn.isDerivedConstructor) return undefined;
	const thisAliases = new Set<number>();
	const stores: Array<{ ip: number; instruction: StaticPropertyStore }> = [];
	let thisEscaped = false;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "LOAD_THIS") {
			thisAliases.add(instruction.dst);
			continue;
		}
		if (instruction.opcode === "MOVE") {
			const aliasesThis = thisAliases.has(instruction.src);
			thisAliases.delete(instruction.dst);
			if (aliasesThis) thisAliases.add(instruction.dst);
			continue;
		}
		const usesThis = [...thisAliases].some((register) =>
			vmInstructionUsesRegister(instruction, register),
		);
		const initialization =
			(instruction.opcode === "DEFINE_PROPERTY" ||
				instruction.opcode === "DEFINE_PRIVATE" ||
				instruction.opcode === "INIT_PRIVATE_FIELDS") &&
			thisAliases.has(instruction.object);
		if (
			instruction.opcode === "STORE_PROPERTY_STATIC" &&
			thisAliases.has(instruction.object) &&
			!thisEscaped &&
			!conflicts(ip)
		) {
			stores.push({ ip, instruction });
		} else if (
			usesThis &&
			!initialization &&
			!(instruction.opcode === "THROW_IF_TDZ" && thisAliases.has(instruction.src))
		) {
			thisEscaped = true;
		}
		for (const register of vmInstructionWriteRegisters(instruction)) {
			thisAliases.delete(register);
		}
	}
	if (stores.length < 2 || stores.length > 32) return undefined;
	const firstIp = stores[0]!.ip;
	const lastIp = stores.at(-1)!.ip;
	if (
		stores.some(({ ip }) => ip > firstIp && jumpTargets.has(ip)) ||
		[...jumpTargets].some((ip) => ip > firstIp && ip <= lastIp)
	) {
		return undefined;
	}
	return Object.freeze({
		id: firstIp,
		stores: Object.freeze(stores.map((store) => Object.freeze(store))),
	});
}

function lowerPrivateFieldReserve(
	fn: BytecodeFunction,
): NativePrivateFieldReservePlan | undefined {
	if (!fn.isClassConstructor || fn.isDerivedConstructor) return undefined;
	const thisAliases = new Set<number>();
	let firstIp: number | undefined;
	let count = 0;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "LOAD_THIS") {
			thisAliases.add(instruction.dst);
			continue;
		}
		if (instruction.opcode === "MOVE") {
			const aliasesThis = thisAliases.has(instruction.src);
			thisAliases.delete(instruction.dst);
			if (aliasesThis) thisAliases.add(instruction.dst);
			continue;
		}
		const privateCount =
			instruction.opcode === "DEFINE_PRIVATE" && thisAliases.has(instruction.object)
				? 1
				: instruction.opcode === "INIT_PRIVATE_FIELDS" &&
					  thisAliases.has(instruction.object)
					? instruction.keyRegisters.length
					: 0;
		if (privateCount > 0) {
			firstIp ??= ip;
			count += privateCount;
		}
		for (const register of vmInstructionWriteRegisters(instruction)) {
			thisAliases.delete(register);
		}
	}
	return firstIp === undefined || count < 2
		? undefined
		: Object.freeze({ id: firstIp, count });
}

function lowerPairedArrayLoops(
	fn: BytecodeFunction,
	indexedLoops: ReadonlyArray<NativeIndexedLoopElement>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
): ReadonlyArray<NativePairedArrayLoopPlan> {
	const plans: Array<NativePairedArrayLoopPlan> = [];
	for (const indexed of indexedLoops) {
		const primary = fn.instructions[indexed.elementLoadIp];
		if (
			primary?.opcode !== "LOAD_PROPERTY" ||
			primary.object !== indexed.object ||
			primary.key !== indexed.key ||
			primary.dst !== indexed.result
		)
			continue;
		const limit = Math.min(fn.instructions.length, indexed.elementLoadIp + 8);
		let secondary:
			| {
					readonly ip: number;
					readonly instruction: Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY" }>;
			  }
			| undefined;
		for (let ip = indexed.elementLoadIp + 1; ip < limit; ip++) {
			if (jumpTargets.has(ip)) break;
			const instruction = fn.instructions[ip]!;
			if (
				instruction.opcode === "LOAD_PROPERTY" &&
				instruction.key === indexed.key &&
				instruction.object !== indexed.object &&
				!conflicts(ip)
			) {
				secondary = { ip, instruction };
				break;
			}
			if (instruction.opcode !== "THROW_IF_TDZ") break;
		}
		if (secondary === undefined) continue;
		const comparison = fn.instructions[secondary.ip + 1];
		if (
			comparison?.opcode !== "BINARY" ||
			comparison.operator !== "===" ||
			!(
				(comparison.left === indexed.result &&
					comparison.right === secondary.instruction.dst) ||
				(comparison.right === indexed.result &&
					comparison.left === secondary.instruction.dst)
			) ||
			conflicts(secondary.ip + 1)
		)
			continue;
		let secondaryStable = true;
		// The receiver stays live across the backedge, so later register reuse begins after the loop.
		for (let ip = indexed.lengthLoadIp + 1; ip < secondary.ip; ip++) {
			if (
				vmInstructionWriteRegisters(fn.instructions[ip]!).includes(
					secondary.instruction.object,
				)
			) {
				secondaryStable = false;
				break;
			}
		}
		if (!secondaryStable) continue;
		plans.push(
			Object.freeze({
				id: indexed.lengthLoadIp,
				lengthLoadIp: indexed.lengthLoadIp,
				primaryLoadIp: indexed.elementLoadIp,
				primaryObject: indexed.object,
				secondaryLoadIp: secondary.ip,
				secondaryObject: secondary.instruction.object,
				key: indexed.key,
			}),
		);
	}
	return Object.freeze(plans);
}

export function lowerNativeFastPaths(
	fn: BytecodeFunction,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	jumpTargets: ReadonlySet<number>,
	conflicts: (ip: number) => boolean,
	projections:
		| { readonly kind: "select" }
		| {
				readonly kind: "render";
				readonly plans: ReadonlyArray<NativePropertyProjectionPlan>;
		  },
	indexedLoops: ReadonlyArray<NativeIndexedLoopElement> = [],
	terminalFusion: (
		ip: number,
	) => { readonly id: number; readonly role: "start" | "finish" } | undefined = () =>
		undefined,
	transparentJumpTargets: ReadonlySet<number> = new Set(),
): NativeFastPathLowering {
	const projectionClaims = new Set(
		projections.kind === "render"
			? projections.plans.flatMap((plan) => plan.claimedIps)
			: [],
	);
	const otherConflicts = (ip: number) => conflicts(ip) || projectionClaims.has(ip);
	const handlerTargets =
		fn.handlers.length === 0
			? []
			: vmExceptionHandlerTargets(fn.instructions.length, fn.handlers);
	const pairedArrayLoops = lowerPairedArrayLoops(
		fn,
		indexedLoops,
		jumpTargets,
		otherConflicts,
	);
	const pairedArrayLoopActions = new Map<number, NativePairedArrayLoopAction>();
	for (const plan of pairedArrayLoops) {
		pairedArrayLoopActions.set(plan.lengthLoadIp, { role: "admit", plan });
		pairedArrayLoopActions.set(plan.secondaryLoadIp, { role: "load", plan });
	}
	const propertyNumericUpdates: Array<NativePropertyNumericUpdatePlan> = [];
	const propertyNumericUpdateActions = new Map<
		number,
		NativePropertyNumericUpdateAction
	>();
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const plan = lowerPropertyNumericUpdate(
			fn,
			ip,
			representations,
			jumpTargets,
			(candidate) =>
				otherConflicts(candidate) ||
				pairedArrayLoopActions.has(candidate) ||
				propertyNumericUpdateActions.has(candidate),
		);
		if (plan === undefined) continue;
		propertyNumericUpdates.push(plan);
		propertyNumericUpdateActions.set(ip, { plan, role: "load" });
		propertyNumericUpdateActions.set(plan.operationIp, {
			plan,
			role: "operation",
		});
		for (let skip = ip + 1; skip <= plan.storeIp; skip++) {
			if (skip !== plan.constantIp && !propertyNumericUpdateActions.has(skip))
				propertyNumericUpdateActions.set(skip, { plan, role: "skip" });
		}
		ip = plan.storeIp;
	}
	const propertyProjections: Array<NativePropertyProjectionPlan> = [];
	const propertyProjectionActions = new Map<number, NativePropertyProjectionAction>();
	for (
		let ip = 0;
		projections.kind === "select" && ip + 1 < fn.instructions.length;
		ip++
	) {
		if (propertyProjectionActions.has(ip)) continue;
		const plan = lowerPropertyProjection(
			fn,
			ip,
			representations,
			jumpTargets,
			(candidate) =>
				conflicts(candidate) ||
				pairedArrayLoopActions.has(candidate) ||
				propertyNumericUpdateActions.has(candidate) ||
				propertyProjectionActions.has(candidate),
			terminalFusion,
			transparentJumpTargets,
			handlerTargets,
		);
		if (plan === undefined) continue;
		propertyProjections.push(plan);
		for (const claimedIp of plan.claimedIps)
			propertyProjectionActions.set(claimedIp, { role: "skip", plan });
	}
	if (projections.kind === "render") propertyProjections.push(...projections.plans);
	propertyProjectionActions.clear();
	for (const plan of propertyProjections) {
		for (const [index, load] of plan.loads.entries()) {
			propertyProjectionActions.set(load.ip, { role: "load", plan, index });
		}
		for (const [index, step] of plan.steps.entries()) {
			propertyProjectionActions.set(step.ip, { role: "step", plan, index });
		}
		for (const skippedIp of plan.skippedIps) {
			propertyProjectionActions.set(skippedIp, { role: "skip", plan });
		}
		if (plan.terminalStore !== undefined) {
			propertyProjectionActions.set(plan.terminalStore.ip, { role: "store", plan });
		}
	}
	const propertyReadRegions: Array<NativePropertyReadRegionPlan> = [];
	const propertyReadRegionActions = new Map<number, NativePropertyReadRegionAction>();
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		const plan = lowerPropertyReadRegion(
			fn,
			ip,
			representations,
			jumpTargets,
			(candidate) =>
				conflicts(candidate) ||
				pairedArrayLoopActions.has(candidate) ||
				propertyNumericUpdateActions.has(candidate) ||
				propertyProjectionActions.has(candidate),
		);
		if (plan === undefined) continue;
		propertyReadRegions.push(plan);
		for (const [index, load] of plan.loads.entries()) {
			propertyReadRegionActions.set(load.ip, { plan, index });
		}
		ip = plan.endIp;
	}
	const constructorInitialization = lowerConstructorInitialization(
		fn,
		jumpTargets,
		(candidate) =>
			conflicts(candidate) ||
			pairedArrayLoopActions.has(candidate) ||
			propertyNumericUpdateActions.has(candidate) ||
			propertyProjectionActions.has(candidate),
	);
	const privateFieldReserve = lowerPrivateFieldReserve(fn);
	const constructorInitializationActions = new Map<
		number,
		NativeConstructorInitializationAction
	>();
	for (const [index, store] of constructorInitialization?.stores.entries() ?? []) {
		constructorInitializationActions.set(store.ip, {
			plan: constructorInitialization!,
			index,
		});
	}
	return Object.freeze({
		pairedArrayLoops,
		pairedArrayLoopActions,
		propertyNumericUpdates: Object.freeze(propertyNumericUpdates),
		propertyNumericUpdateActions,
		propertyProjections: Object.freeze(propertyProjections),
		propertyProjectionActions,
		propertyReadRegions: Object.freeze(propertyReadRegions),
		propertyReadRegionActions,
		...(constructorInitialization === undefined ? {} : { constructorInitialization }),
		constructorInitializationActions,
		...(privateFieldReserve === undefined ? {} : { privateFieldReserve }),
	});
}

export function selectNativePropertyProjections(
	native: NativeFunctionPlan,
	entry?: NativeDirectEntryPlan,
): ReadonlyArray<NativePropertyProjectionPlan> {
	const fn = native.body;
	const handlerEntries = new Set(fn.handlers.map((handler) => handler.handlerIp));
	const jumpTargets = new Set(handlerEntries);
	const incoming = new Map<number, number>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") {
			jumpTargets.add(op.targetIp);
			incoming.set(op.targetIp, (incoming.get(op.targetIp) ?? 0) + 1);
		}
		if (["GENERATOR_START", "YIELD", "AWAIT"].includes(op.opcode))
			jumpTargets.add(ip + 1);
	}
	const transparent = new Set<number>();
	if (native.mode === "direct" && (native.literalSwitches?.length ?? 0) === 0) {
		for (const [ip, op] of fn.instructions.entries()) {
			if (
				op.opcode === "JUMP" &&
				op.targetIp === ip + 1 &&
				incoming.get(ip + 1) === 1 &&
				!handlerEntries.has(ip + 1)
			)
				transparent.add(ip + 1);
		}
	}
	const blocked = new Set(
		entry?.fieldParameters?.loads.map((load) => load.instructionIp),
	);
	// A physically forward copy edge can still poll on a native or exceptional cycle.
	for (const point of native.gc.safepoints)
		if (point.kind === "loop-backedge") blocked.add(point.instructionIp);
	for (const site of native.fieldCalls ?? [])
		for (let ip = site.allocationIp; ip <= site.callIp; ip++) blocked.add(ip);
	for (const site of native.literalSwitches ?? [])
		for (let ip = site.instructionIp; ip <= site.endIp; ip++) blocked.add(ip);
	const fusions = new Map<
		number,
		{ readonly id: number; readonly role: "start" | "finish" }
	>();
	const indexedLoops: Array<NativeIndexedLoopElement> = [];
	for (const action of native.regionActions) {
		const region = native.specializations[action.regionIndex]!;
		if (region.kind !== "numeric-fusion") {
			blocked.add(action.ip);
			for (const ip of region.claimedIps) blocked.add(ip);
		}
		switch (region.kind) {
			case "numeric-fusion": {
				const pair = region.pairs[action.primaryIndex!]!;
				if (
					native.instructions[pair.firstIp]?.kind !== "unsigned-arithmetic" &&
					native.instructions[pair.finishIp]?.kind !== "unsigned-arithmetic"
				) {
					if (action.role !== "start" && action.role !== "finish")
						throw new Error("Invalid numeric-fusion action");
					fusions.set(action.ip, { id: pair.firstIp, role: action.role });
				}
				break;
			}
			case "indexed-length-loop": {
				blocked.add(action.ip);
				const site = region.sites[action.primaryIndex!]!;
				const element =
					action.role === "element" ? site.elements[action.secondaryIndex!] : undefined;
				const op = fn.instructions[action.ip]!;
				if (
					element?.kind === "load" &&
					element.arrayIndexIsUint32 &&
					op.opcode === "LOAD_PROPERTY"
				)
					indexedLoops.push({
						lengthLoadIp: site.loadIp,
						elementLoadIp: action.ip,
						object: op.object,
						key: op.key,
						result: op.dst,
					});
				break;
			}
		}
	}
	return lowerNativeFastPaths(
		fn,
		native.registerRepresentations,
		jumpTargets,
		(ip) => blocked.has(ip) || native.instructions[ip] !== undefined,
		{ kind: "select" },
		indexedLoops,
		(ip) => fusions.get(ip),
		transparent,
	).propertyProjections;
}
