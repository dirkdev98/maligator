import {
	nativeEntryStableRootRegisters,
	nativePrivateCallResultIps,
	nativePrivateRootRegisters,
} from "./lower-native-root-publication.ts";
import {
	NATIVE_ARITH,
	NATIVE_BITWISE,
	NATIVE_COMPARE,
} from "./native-scalar-operators.ts";
import { nativeFrameRootRegisters } from "./program-image.ts";
import type {
	NativeDirectEntryPlan,
	NativeFunctionPlan,
	ProgramImage,
} from "./program-image.ts";
import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeInstruction } from "./runtime-image.ts";

export interface NativeScalarStoragePlan {
	readonly expressionIps: ReadonlyArray<number>;
	readonly definitionInitializedRegisters: ReadonlyArray<number>;
}

export interface NativeStoragePlan extends NativeScalarStoragePlan {
	readonly rootRegisters: ReadonlyArray<number>;
	readonly privateRegisters: ReadonlyArray<number>;
	readonly privateCallResultIps: ReadonlyArray<number>;
	readonly entryStableRootRegisters: ReadonlyArray<number>;
	readonly numericLeaf: NativeScalarStoragePlan | undefined;
}

function selectNumericLeaf(
	native: NativeFunctionPlan,
	entry: NativeDirectEntryPlan,
): boolean {
	const fn = native.body;
	if (
		fn.instructions.length > 48 ||
		fn.handlers.length > 0 ||
		fn.capturedCount > 0 ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.isClassConstructor ||
		fn.mappedArguments ||
		entry.argumentRepresentations !== undefined ||
		entry.resultRepresentation !== "number" ||
		fn.instructions.at(-1)?.opcode !== "RETURN"
	)
		return false;
	const reps = entry.registerRepresentations;
	const numeric = (local: number) => reps[local] === "number" || reps[local] === "int32";
	return fn.instructions.every((op, ip) => {
		switch (op.opcode) {
			case "JUMP":
			case "JUMP_IF":
				return (
					op.targetIp > ip &&
					op.targetIp < fn.instructions.length &&
					(op.opcode === "JUMP" || reps[op.cond] === "boolean")
				);
			case "CREATE_NUMBER":
			case "CREATE_F64":
				return numeric(op.dst);
			case "CREATE_BOOLEAN":
				return reps[op.dst] === "boolean";
			case "MOVE":
				return (
					(numeric(op.dst) || reps[op.dst] === "boolean") && reps[op.dst] === reps[op.src]
				);
			case "LOAD_PROPERTY_STATIC":
				return (
					reps[op.dst] === "number" &&
					entry.fieldParameters?.loads.some((load) => load.instructionIp === ip) === true
				);
			case "BINARY":
				return (
					numeric(op.left) &&
					numeric(op.right) &&
					((reps[op.dst] === "boolean" && NATIVE_COMPARE[op.operator] !== undefined) ||
						(reps[op.dst] === "number" &&
							(NATIVE_ARITH[op.operator] !== undefined ||
								NATIVE_BITWISE[op.operator] !== undefined ||
								op.operator === ">>>" ||
								op.operator === "%")))
				);
			case "UNARY":
				return (
					numeric(op.src) &&
					reps[op.dst] === "number" &&
					["+", "-", "tonumeric"].includes(op.operator)
				);
			case "RETURN":
				return numeric(op.value);
			default:
				return false;
		}
	});
}

function hasExplicitScalarUses(native: NativeFunctionPlan): boolean {
	const fn = native.body;
	return (
		native.storageValues !== undefined &&
		!fn.isAsync &&
		!fn.isGenerator &&
		fn.handlers.length === 0 &&
		native.specializations.length === 0 &&
		native.instructions.every(
			(plan) =>
				plan === undefined ||
				plan.kind === "exact-operator-input-kinds" ||
				plan.kind === "call" ||
				plan.kind === "construct",
		) &&
		(native.fieldCalls?.length ?? 0) === 0 &&
		(native.literalSwitches?.length ?? 0) === 0
	);
}

function definitionInitializedRegisters(
	native: NativeFunctionPlan,
	jumpTargets: ReadonlySet<number>,
): ReadonlyArray<number> {
	if (!hasExplicitScalarUses(native)) return [];
	const fn = native.body;
	const writes = new Uint32Array(fn.registerCount);
	const definitions = new Int32Array(fn.registerCount).fill(-1);
	const uses: Array<Array<number>> = Array.from({ length: fn.registerCount }, () => []);
	const blocks = new Uint32Array(fn.instructions.length);
	let block = 0;
	for (const [ip, op] of fn.instructions.entries()) {
		if (jumpTargets.has(ip)) block++;
		blocks[ip] = block;
		for (const local of vmInstructionReadRegisters(op)) uses[local]!.push(ip);
		for (const local of vmInstructionWriteRegisters(op)) {
			writes[local]!++;
			definitions[local] = ip;
		}
		if (["JUMP", "JUMP_IF", "RETURN", "THROW"].includes(op.opcode)) block++;
	}
	return native.registerRepresentations.flatMap((rep, local) => {
		const definition = definitions[local]!;
		return local >= fn.parameterCount + fn.argumentSnapshotCount &&
			native.storageValues![local]! >= 0 &&
			(rep === "number" || rep === "int32" || rep === "boolean") &&
			writes[local] === 1 &&
			uses[local]!.every((ip) => ip > definition && blocks[ip] === blocks[definition])
			? [local]
			: [];
	});
}

function pureScalarOperation(
	op: BytecodeInstruction,
	reps: NativeFunctionPlan["registerRepresentations"],
	plan?: NativeFunctionPlan["instructions"][number],
): boolean {
	const numeric = (local: number) => reps[local] === "number" || reps[local] === "int32";
	const numericInput = (local: number, index: number) =>
		numeric(local) ||
		(plan?.kind === "exact-operator-input-kinds" &&
			plan.inputKindMasks[index] === COMPILER_VALUE_KIND_NUMBER);
	switch (op.opcode) {
		case "CREATE_NUMBER":
		case "CREATE_F64":
			return numeric(op.dst);
		case "CREATE_BOOLEAN":
			return reps[op.dst] === "boolean";
		case "MOVE":
			return (
				reps[op.dst] === reps[op.src] && (numeric(op.dst) || reps[op.dst] === "boolean")
			);
		case "UNARY":
			return (
				numeric(op.src) &&
				reps[op.dst] === "number" &&
				["+", "-", "tonumeric"].includes(op.operator)
			);
		case "BINARY":
			return (
				numericInput(op.left, 0) &&
				numericInput(op.right, 1) &&
				((reps[op.dst] === "number" && ["+", "-", "*", "/"].includes(op.operator)) ||
					(reps[op.dst] === "boolean" &&
						["<", "<=", ">", ">=", "===", "!=="].includes(op.operator)))
			);
		default:
			return false;
	}
}

function expressionIps(
	native: NativeFunctionPlan,
	jumpTargets: ReadonlySet<number>,
	preserveProfileSites = true,
): ReadonlyArray<number> {
	const fn = native.body;
	// Region helpers can borrow storage beyond explicit operands; profiling retains producer sites.
	if (
		!hasExplicitScalarUses(native) ||
		(preserveProfileSites && fn.profileSiteIds !== undefined)
	)
		return [];
	const writes = new Uint32Array(fn.registerCount);
	const uses: Array<Array<number>> = Array.from({ length: fn.registerCount }, () => []);
	for (const [ip, op] of fn.instructions.entries()) {
		for (const local of vmInstructionWriteRegisters(op)) writes[local]!++;
		for (const local of vmInstructionReadRegisters(op)) uses[local]!.push(ip);
	}
	const expressions: Array<number> = [];
	const leavesByLocal = new Map<number, ReadonlySet<number>>();
	const costs = new Map<number, number>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (
			!pureScalarOperation(op, native.registerRepresentations, native.instructions[ip]) ||
			!("dst" in op) ||
			op.dst < fn.parameterCount + fn.argumentSnapshotCount ||
			writes[op.dst] !== 1 ||
			uses[op.dst]!.length !== 1
		)
			continue;
		const consumerIp = uses[op.dst]![0]!;
		// Bound expansion work and leave every throwing/control boundary in its original order.
		if (consumerIp <= ip || consumerIp - ip > 16) continue;
		const consumer = fn.instructions[consumerIp]!;
		if (
			!pureScalarOperation(
				consumer,
				native.registerRepresentations,
				native.instructions[consumerIp],
			) &&
			consumer.opcode !== "RETURN" &&
			consumer.opcode !== "JUMP_IF"
		)
			continue;
		const inputs = vmInstructionReadRegisters(op);
		const operands = new Set(
			inputs.flatMap((local) => [...(leavesByLocal.get(local) ?? [local])]),
		);
		const cost = 1 + inputs.reduce((sum, local) => sum + (costs.get(local) ?? 1), 0);
		if (cost > 16) continue;
		let safe = true;
		for (let next = ip + 1; next <= consumerIp; next++) {
			if (
				jumpTargets.has(next) ||
				(next < consumerIp &&
					(!pureScalarOperation(
						fn.instructions[next]!,
						native.registerRepresentations,
						native.instructions[next],
					) ||
						vmInstructionWriteRegisters(fn.instructions[next]!).some((local) =>
							operands.has(local),
						)))
			) {
				safe = false;
				break;
			}
		}
		if (safe) {
			expressions.push(ip);
			leavesByLocal.set(op.dst, operands);
			costs.set(op.dst, cost);
		}
	}
	return expressions;
}

export function nativeVariantContract(
	native: NativeFunctionPlan,
	entry: NativeDirectEntryPlan,
): NativeFunctionPlan {
	const instructions = [...native.instructions];
	for (const { instructionIp, masks } of entry.operatorInputs ?? []) {
		if (instructions[instructionIp]?.kind !== "unsigned-arithmetic")
			instructions[instructionIp] = {
				kind: "exact-operator-input-kinds",
				inputKindMasks: masks,
			};
	}
	for (const call of entry.callOverrides ?? []) {
		instructions[call.instructionIp] = {
			kind: "call",
			...(call.guarded
				? { guardedFunctionIndices: [call.functionIndex] }
				: { directFunctionIndex: call.functionIndex }),
			directEntryId: call.entryId,
		};
	}
	return {
		...native,
		registerRepresentations: entry.registerRepresentations,
		gc: entry.gc,
		instructions,
		storage: entry.storage,
	};
}

function lowerStorage(
	native: NativeFunctionPlan,
	preserveProfileSites = true,
	entry?: NativeDirectEntryPlan,
): NativeStoragePlan {
	const fn = native.body;
	const jumpTargets = new Set(fn.handlers.map((handler) => handler.handlerIp));
	for (const op of fn.instructions) {
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") jumpTargets.add(op.targetIp);
	}
	let numericLeaf: NativeScalarStoragePlan | undefined;
	if (entry !== undefined && selectNumericLeaf(native, entry)) {
		const leaf = {
			...native,
			instructions: Array<undefined>(fn.instructions.length).fill(undefined),
			specializations: [],
			regionActions: [],
			fieldCalls: [],
			literalSwitches: [],
		};
		numericLeaf = {
			expressionIps: expressionIps(leaf, jumpTargets, preserveProfileSites),
			definitionInitializedRegisters: definitionInitializedRegisters(leaf, jumpTargets),
		};
	}
	const roots = nativeFrameRootRegisters(fn, native).filter((local) =>
		["boxed", "string"].includes(native.registerRepresentations[local]!),
	);
	if (roots.length > 64) {
		const counts = new Uint32Array(fn.registerCount);
		for (const point of native.gc.safepoints)
			for (const local of point.rootRegisters) counts[local]!++;
		roots.sort((left, right) => counts[left]! - counts[right]! || left - right);
	}
	const calls = nativePrivateCallResultIps(fn, native);
	const privateLocals = new Set(
		nativePrivateRootRegisters(fn, native, new Set(roots), calls),
	);
	// Every prefix is eligible independently; later unused loads must not hide an earlier projection.
	for (const [start, first] of fn.instructions.entries()) {
		if (first.opcode !== "LOAD_PROPERTY_STATIC") continue;
		const aliases = new Set([first.dst]);
		let loadCount = 1;
		for (let ip = start + 1; ip < Math.min(start + 20, fn.instructions.length); ip++) {
			const op = fn.instructions[ip]!;
			if (op.opcode === "JUMP" && op.targetIp === ip + 1) continue;
			if (op.opcode === "THROW_IF_TDZ" && aliases.has(op.src)) continue;
			if (
				(op.opcode === "LOAD_PROPERTY_STATIC" && op.object === first.object) ||
				(op.opcode === "MOVE" && aliases.has(op.src))
			) {
				aliases.add(op.dst);
				if (op.opcode === "LOAD_PROPERTY_STATIC") loadCount++;
				continue;
			}
			if (
				op.opcode === "BINARY" &&
				["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>", ">>>"].includes(
					op.operator,
				) &&
				(aliases.has(op.left) || aliases.has(op.right))
			) {
				aliases.add(op.dst);
				if (loadCount >= 2) for (const local of aliases) privateLocals.delete(local);
				continue;
			}
			if (
				op.opcode === "CREATE_NUMBER" ||
				op.opcode === "CREATE_F64" ||
				op.opcode === "CREATE_BOOLEAN" ||
				(op.opcode === "MOVE" &&
					native.registerRepresentations[op.src] !== "boxed" &&
					native.registerRepresentations[op.dst] !== "boxed")
			)
				continue;
			break;
		}
	}
	return {
		rootRegisters: roots,
		privateRegisters: roots.filter((local) => privateLocals.has(local)),
		privateCallResultIps: [...calls],
		entryStableRootRegisters: [...nativeEntryStableRootRegisters(fn, privateLocals)],
		expressionIps: expressionIps(native, jumpTargets, preserveProfileSites),
		definitionInitializedRegisters: definitionInitializedRegisters(native, jumpTargets),
		numericLeaf,
	};
}

export function lowerNativeFunctionStorage(
	native: NativeFunctionPlan,
): NativeFunctionPlan {
	return {
		...native,
		storage: lowerStorage(native),
		directEntries: native.directEntries.map((entry) => ({
			...entry,
			storage: lowerStorage(nativeVariantContract(native, entry), true, entry),
		})),
	};
}

export function lowerNativeStorage(image: ProgramImage): ProgramImage {
	return {
		...image,
		native: {
			...image.native,
			functions: image.native.functions.map(lowerNativeFunctionStorage),
		},
	};
}

export function validateNativeStorage(native: NativeFunctionPlan): void {
	const sameScalar = (
		stored: NativeScalarStoragePlan | undefined,
		selected: NativeScalarStoragePlan | undefined,
	): boolean => {
		if (stored === undefined || selected === undefined) return stored === selected;
		return (
			stored.definitionInitializedRegisters.length ===
				selected.definitionInitializedRegisters.length &&
			stored.definitionInitializedRegisters.every(
				(value, index) => value === selected.definitionInitializedRegisters[index],
			) &&
			// Profiling can retain producers; persisted choices may use any safe subset.
			stored.expressionIps.every(
				(ip, index) =>
					selected.expressionIps.includes(ip) &&
					(index === 0 || ip > stored.expressionIps[index - 1]!),
			) &&
			(native.body.profileSiteIds === undefined || stored.expressionIps.length === 0)
		);
	};
	const same = (
		stored: NativeStoragePlan | undefined,
		selected: NativeStoragePlan | undefined,
	): boolean =>
		stored !== undefined &&
		selected !== undefined &&
		sameScalar(stored, selected) &&
		sameScalar(stored.numericLeaf, selected.numericLeaf) &&
		(
			[
				"rootRegisters",
				"privateRegisters",
				"privateCallResultIps",
				"entryStableRootRegisters",
			] as const
		).every(
			(key) =>
				stored[key].length === selected[key].length &&
				stored[key].every((value, index) => value === selected[key][index]),
		);
	if (
		!same(native.storage, lowerStorage(native, false)) ||
		native.directEntries.some(
			(entry) =>
				!same(
					entry.storage,
					lowerStorage(nativeVariantContract(native, entry), false, entry),
				),
		)
	)
		throw new Error("Native function has an invalid or stale storage plan");
}
import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
