import {
	nativeCallbackTransportsMatch,
	selectNativeCallbackTransports,
} from "./lower-native-callbacks.ts";
import type { NativeCallbackTransportPlan } from "./lower-native-callbacks.ts";
import {
	nativeCallTransportsMatch,
	nativeEntryLookup,
	selectNativeCallTransports,
} from "./lower-native-calls.ts";
import type { NativeCallTransportPlan, NativeEntryLookup } from "./lower-native-calls.ts";
import { selectNativeFastPaths } from "./lower-native-fast-paths.ts";
import type {
	NativeFastPathPlans,
	NativePropertyNumericUpdatePlan,
	NativePropertyProjectionPlan,
	NativePropertyReadRegionPlan,
} from "./lower-native-fast-paths.ts";
import {
	selectNativeDirectHeapObjects,
	selectNativeStackObjectStorage,
} from "./lower-native-objects.ts";
import type { NativeStackObjectStoragePlan } from "./lower-native-objects.ts";
import {
	nativeEntryStableRootRegisters,
	nativePrivateCallResultIps,
	nativePrivateRootRegisters,
} from "./lower-native-root-publication.ts";
import { selectNativeRootStorage } from "./lower-native-roots.ts";
import type { NativeRootStoragePlan } from "./lower-native-roots.ts";
import {
	compactNativeSuspension,
	lowerNativeSuspension,
} from "./lower-native-suspension.ts";
import type { NativeSuspensionPlan } from "./lower-native-suspension.ts";
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
	decodeVmValueOperand,
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeInstruction } from "./runtime-image.ts";

export interface NativeScalarStoragePlan {
	readonly expressionIps: ReadonlyArray<number>;
	readonly definitionInitializedRegisters: ReadonlyArray<number>;
	readonly rematerializedConstantIps: ReadonlyArray<number>;
}

export interface NativeNumericLeafPlan extends NativeScalarStoragePlan {
	readonly fallthroughJumpIps: ReadonlyArray<number>;
}

export interface NativeStoragePlan
	extends NativeScalarStoragePlan, NativeRootStoragePlan, NativeFastPathPlans {
	readonly callTransports: ReadonlyArray<NativeCallTransportPlan>;
	readonly callbackTransports: ReadonlyArray<NativeCallbackTransportPlan>;
	readonly suspension: NativeSuspensionPlan | undefined;
	readonly stackObjects: ReadonlyArray<NativeStackObjectStoragePlan>;
	readonly directHeapObjectIps: ReadonlyArray<number>;
	readonly rootRegisters: ReadonlyArray<number>;
	readonly privateRegisters: ReadonlyArray<number>;
	readonly privateCallResultIps: ReadonlyArray<number>;
	readonly entryStableRootRegisters: ReadonlyArray<number>;
	readonly elidedTdzIps: ReadonlyArray<number>;
	readonly numericLeaf: NativeNumericLeafPlan | undefined;
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
		entry.fieldParameters?.representations.some((rep) => rep !== "number") ||
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
			case "UNARY":
			case "MATH_UNARY_NUMBER":
			case "MATH_BINARY_NUMBER":
				return (
					vmInstructionReadRegisters(op).every(
						(local) => numeric(local) || reps[local] === "boolean",
					) && pureScalarOperation(op, reps, native.instructions[ip])
				);
			case "RETURN":
				return numeric(op.value);
			default:
				return false;
		}
	});
}

interface NativeScalarOwnership {
	readonly blocked: ReadonlySet<number>;
	readonly borrowed: ReadonlySet<number>;
}

function scalarStorageOwnership(
	native: NativeFunctionPlan,
	projections: ReadonlyArray<
		Pick<NativePropertyProjectionPlan, "claimedIps" | "borrowedRegisters">
	>,
	suspension?: NativeSuspensionPlan,
): NativeScalarOwnership {
	const fn = native.body;
	const blocked = new Set(native.specializations.flatMap((region) => region.claimedIps));
	for (const plan of projections) for (const ip of plan.claimedIps) blocked.add(ip);
	for (const action of native.regionActions) blocked.add(action.ip);
	for (const site of native.fieldCalls ?? [])
		for (let ip = site.allocationIp; ip <= site.callIp; ip++) blocked.add(ip);
	for (const site of native.literalSwitches ?? [])
		for (let ip = site.instructionIp; ip <= site.endIp; ip++) blocked.add(ip);
	const handlers = vmExceptionHandlerTargets(fn.instructions.length, fn.handlers);
	for (const handler of fn.handlers) {
		blocked.add(handler.handlerIp);
		blocked.add(handler.endIp);
	}
	for (const [ip, op] of fn.instructions.entries()) {
		const plan = native.instructions[ip];
		if (
			handlers[ip] !== undefined ||
			["CATCH", "TRY_BEGIN", "TRY_END"].includes(op.opcode) ||
			(plan !== undefined &&
				![
					"exact-operator-input-kinds",
					"unsigned-arithmetic",
					"call",
					"construct",
				].includes(plan.kind))
		)
			blocked.add(ip);
	}
	// Region operands may remain borrowed after their explicit instruction has finished.
	const borrowed = new Set(
		[...blocked].flatMap((ip) => {
			const op = fn.instructions[ip];
			return op === undefined
				? []
				: [...vmInstructionReadRegisters(op), ...vmInstructionWriteRegisters(op)];
		}),
	);
	for (const plan of projections)
		for (const register of plan.borrowedRegisters) borrowed.add(register);
	for (const point of suspension?.points ?? []) {
		blocked.add(point.instructionIp);
		for (const register of point.registers) borrowed.add(register);
		for (const register of vmInstructionWriteRegisters(
			fn.instructions[point.instructionIp]!,
		))
			borrowed.add(register);
	}
	return { blocked, borrowed };
}

function elidedTdzIps(
	native: NativeFunctionPlan,
	{ blocked, borrowed }: NativeScalarOwnership,
): ReadonlyArray<number> {
	if (native.storageValues === undefined) return [];
	return native.body.instructions.flatMap((op, ip) =>
		op.opcode === "THROW_IF_TDZ" &&
		!blocked.has(ip) &&
		!borrowed.has(op.src) &&
		["number", "int32", "boolean"].includes(native.registerRepresentations[op.src]!)
			? [ip]
			: [],
	);
}

function scalarStorageReads(
	native: NativeFunctionPlan,
	suspension: NativeSuspensionPlan | undefined,
): ReadonlyArray<ReadonlyArray<number>> {
	const snapshots = new Map(
		suspension?.points.map((point) => [point.instructionIp, point.registers]),
	);
	return native.body.instructions.map((op, ip) => [
		...vmInstructionReadRegisters(op),
		...(snapshots.get(ip) ?? []),
	]);
}

function scalarControlBoundary(op: BytecodeInstruction): boolean {
	return [
		"JUMP",
		"JUMP_IF",
		"RETURN",
		"THROW",
		"GENERATOR_START",
		"YIELD",
		"AWAIT",
		"TERMINAL_YIELD",
	].includes(op.opcode);
}

function definitionInitializedRegisters(
	native: NativeFunctionPlan,
	jumpTargets: ReadonlySet<number>,
	reads: ReadonlyArray<ReadonlyArray<number>>,
	{ blocked, borrowed }: NativeScalarOwnership,
): ReadonlyArray<number> {
	if (native.storageValues === undefined) return [];
	const fn = native.body;
	const writes = new Uint32Array(fn.registerCount);
	const definitions = new Int32Array(fn.registerCount).fill(-1);
	const uses: Array<Array<number>> = Array.from({ length: fn.registerCount }, () => []);
	const blocks = new Uint32Array(fn.instructions.length);
	let block = 0;
	for (const [ip, op] of fn.instructions.entries()) {
		if (jumpTargets.has(ip) || blocked.has(ip)) block++;
		blocks[ip] = block;
		for (const local of reads[ip]!) uses[local]!.push(ip);
		for (const local of vmInstructionWriteRegisters(op)) {
			writes[local]!++;
			definitions[local] = ip;
		}
		if (scalarControlBoundary(op) || blocked.has(ip)) block++;
	}
	return native.registerRepresentations.flatMap((rep, local) => {
		const definition = definitions[local]!;
		return local >= fn.parameterCount + fn.argumentSnapshotCount &&
			native.storageValues![local]! >= 0 &&
			!borrowed.has(local) &&
			!blocked.has(definition) &&
			(rep === "number" || rep === "int32" || rep === "boolean") &&
			writes[local] === 1 &&
			uses[local]!.every((ip) => ip > definition && blocks[ip] === blocks[definition])
			? [local]
			: [];
	});
}

function rematerializedConstantIps(
	native: NativeFunctionPlan,
	jumpTargets: ReadonlySet<number>,
	preserveProfileSites: boolean,
	reads: ReadonlyArray<ReadonlyArray<number>>,
): ReadonlyArray<number> {
	const fn = native.body;
	if (
		native.storageValues === undefined ||
		fn.handlers.length > 0 ||
		(preserveProfileSites && fn.profileSiteIds !== undefined)
	)
		return [];
	const writes = new Uint32Array(fn.registerCount);
	const uses: Array<Array<number>> = Array.from({ length: fn.registerCount }, () => []);
	const blocks = new Uint32Array(fn.instructions.length);
	const ends: Array<number> = [];
	let block = 0;
	let startsBlock = false;
	for (const [ip, op] of fn.instructions.entries()) {
		if (ip > 0 && (startsBlock || jumpTargets.has(ip))) {
			ends.push(ip - 1);
			block++;
		}
		blocks[ip] = block;
		for (const local of vmInstructionWriteRegisters(op)) writes[local]!++;
		for (const local of reads[ip]!) uses[local]!.push(ip);
		startsBlock = scalarControlBoundary(op);
	}
	if (fn.instructions.length === 0) return [];
	ends.push(fn.instructions.length - 1);
	const successors = ends.map((ip, index) => {
		const op = fn.instructions[ip]!;
		if (op.opcode === "JUMP") return [blocks[op.targetIp]!];
		const next = index + 1 < ends.length ? [index + 1] : [];
		if (op.opcode === "JUMP_IF") return [...next, blocks[op.targetIp]!];
		return ["RETURN", "THROW", "TERMINAL_YIELD"].includes(op.opcode) ? [] : next;
	});
	const reachable = (skippedBlock = -1): Uint8Array => {
		const visited = new Uint8Array(ends.length);
		const pending = [0];
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (current === skippedBlock || visited[current] !== 0) continue;
			visited[current] = 1;
			pending.push(...successors[current]!);
		}
		return visited;
	};
	const live = reachable();
	const withoutDefinition = new Map<number, Uint8Array>();
	return fn.instructions.flatMap((op, ip) => {
		if (
			!["CREATE_NUMBER", "CREATE_F64", "CREATE_BOOLEAN"].includes(op.opcode) ||
			!("dst" in op) ||
			op.dst < fn.parameterCount + fn.argumentSnapshotCount ||
			!(native.storageValues![op.dst]! >= 0) ||
			writes[op.dst] !== 1 ||
			(op.opcode === "CREATE_BOOLEAN"
				? native.registerRepresentations[op.dst] !== "boolean"
				: !["number", "int32"].includes(native.registerRepresentations[op.dst]!))
		)
			return [];
		const definitionBlock = blocks[ip]!;
		if (live[definitionBlock] === 0) return [];
		// Scalar region inputs are immutable; overlays only write explicit outputs or boxed storage.
		const dominates = uses[op.dst]!.every((useIp) => {
			const useBlock = blocks[useIp]!;
			if (live[useBlock] === 0) return false;
			if (useBlock === definitionBlock) return useIp > ip;
			let bypass = withoutDefinition.get(definitionBlock);
			if (bypass === undefined) {
				bypass = reachable(definitionBlock);
				withoutDefinition.set(definitionBlock, bypass);
			}
			return bypass[useBlock] === 0;
		});
		return dominates ? [ip] : [];
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
		plan?.kind === "unsigned-arithmetic" ||
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
				(op.operator === "!" &&
					reps[op.dst] === "boolean" &&
					(reps[op.src] === "boolean" || numericInput(op.src, 0))) ||
				(numericInput(op.src, 0) &&
					((reps[op.dst] === "number" &&
						["+", "-", "tonumeric", "~"].includes(op.operator)) ||
						(reps[op.dst] === "int32" && op.operator === "~")))
			);
		case "BINARY":
			if (plan?.kind === "unsigned-arithmetic")
				return numeric(op.dst) && ["+", "-", "*", "%"].includes(op.operator);
			if (
				reps[op.dst] === "boolean" &&
				reps[op.left] === "boolean" &&
				reps[op.right] === "boolean"
			)
				return ["===", "!=="].includes(op.operator);
			return (
				numericInput(op.left, 0) &&
				numericInput(op.right, 1) &&
				((reps[op.dst] === "number" &&
					(NATIVE_ARITH[op.operator] !== undefined ||
						NATIVE_BITWISE[op.operator] !== undefined ||
						["%", ">>>"].includes(op.operator))) ||
					(reps[op.dst] === "int32" && NATIVE_BITWISE[op.operator] !== undefined) ||
					(reps[op.dst] === "boolean" && NATIVE_COMPARE[op.operator] !== undefined))
			);
		case "MATH_UNARY_NUMBER":
			return (
				reps[op.dst] === "number" && ["number", "int32", "boxed"].includes(reps[op.src]!)
			);
		case "MATH_BINARY_NUMBER":
			return (
				reps[op.dst] === "number" &&
				[op.left, op.right].every((local) =>
					["number", "int32", "boxed"].includes(reps[local]!),
				)
			);
		default:
			return false;
	}
}

function scalarValueBoundary(op: BytecodeInstruction, local: number): boolean {
	const isLocal = (operand: number): boolean => {
		const value = decodeVmValueOperand(operand);
		return value.kind === "register" && value.register === local;
	};
	switch (op.opcode) {
		case "CREATE_OBJECT_SHAPED":
			return op.valueRegisters.includes(local);
		case "STORE_PROPERTY_STATIC":
		case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
			return op.value === local && op.object !== local;
		case "STORE_PROPERTY":
		case "DEFINE_PROPERTY":
			return op.value === local && op.object !== local && op.key !== local;
		case "CALL":
			return !isLocal(op.callee) && !isLocal(op.thisValue) && op.arguments.some(isLocal);
		default:
			return false;
	}
}

function expressionIps(
	native: NativeFunctionPlan,
	jumpTargets: ReadonlySet<number>,
	preserveProfileSites: boolean,
	{ blocked, borrowed }: NativeScalarOwnership,
): ReadonlyArray<number> {
	const fn = native.body;
	if (
		native.storageValues === undefined ||
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
			blocked.has(ip) ||
			!pureScalarOperation(op, native.registerRepresentations, native.instructions[ip]) ||
			!("dst" in op) ||
			borrowed.has(op.dst) ||
			op.dst < fn.parameterCount + fn.argumentSnapshotCount ||
			writes[op.dst] !== 1 ||
			uses[op.dst]!.length !== 1
		)
			continue;
		const consumerIp = uses[op.dst]![0]!;
		// Bound expansion work and leave every throwing/control boundary in its original order.
		if (consumerIp <= ip || consumerIp - ip > 16 || blocked.has(consumerIp)) continue;
		const consumer = fn.instructions[consumerIp]!;
		if (
			!pureScalarOperation(
				consumer,
				native.registerRepresentations,
				native.instructions[consumerIp],
			) &&
			consumer.opcode !== "RETURN" &&
			consumer.opcode !== "JUMP_IF" &&
			!scalarValueBoundary(consumer, op.dst)
		)
			continue;
		const inputs = vmInstructionReadRegisters(op);
		const operands = new Set(
			inputs.flatMap((local) => [...(leavesByLocal.get(local) ?? [local])]),
		);
		// Consumer preludes can clear boxed root slots before delayed argument/field evaluation.
		if (
			scalarValueBoundary(consumer, op.dst) &&
			[...operands].some(
				(local) =>
					!["number", "int32", "boolean"].includes(
						native.registerRepresentations[local]!,
					),
			)
		)
			continue;
		const cost = 1 + inputs.reduce((sum, local) => sum + (costs.get(local) ?? 1), 0);
		if (cost > 16) continue;
		let safe = true;
		for (let next = ip + 1; next <= consumerIp; next++) {
			if (
				blocked.has(next) ||
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
	entries: NativeEntryLookup = new Map(),
	suspension = lowerNativeSuspension(native),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): NativeStoragePlan {
	const fn = native.body;
	const fastPaths = selectNativeFastPaths(native, entry, stringConstants);
	const {
		propertyProjections,
		propertyNumericUpdates,
		propertyReadRegions,
		propertyReadPairs,
	} = fastPaths;
	const propertyWindows = [...propertyProjections, ...propertyNumericUpdates];
	const auxiliaryWindows = [
		...fastPaths.pairedArrayLoops,
		...fastPaths.arrayPresence,
		...fastPaths.arrayPairDestructure,
		...(fastPaths.constructorInitialization === undefined
			? []
			: [fastPaths.constructorInitialization]),
		...(fastPaths.privateFieldReserve === undefined
			? []
			: [fastPaths.privateFieldReserve]),
	];
	const expressionWindows = [
		...propertyWindows,
		...propertyReadRegions,
		...propertyReadPairs,
		...auxiliaryWindows,
	];
	const jumpTargets = new Set(fn.handlers.map((handler) => handler.handlerIp));
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") jumpTargets.add(op.targetIp);
		if (["GENERATOR_START", "YIELD", "AWAIT"].includes(op.opcode))
			jumpTargets.add(ip + 1);
	}
	const reads = scalarStorageReads(native, suspension);
	const ownership = scalarStorageOwnership(native, expressionWindows, suspension);
	const scalarStorage = (variant: NativeFunctionPlan): NativeScalarStoragePlan => {
		const constants = rematerializedConstantIps(
			variant,
			jumpTargets,
			preserveProfileSites,
			reads,
		);
		const constantIps = new Set(constants);
		const variantOwnership =
			variant === native
				? ownership
				: scalarStorageOwnership(variant, expressionWindows, suspension);
		return {
			expressionIps: expressionIps(
				variant,
				jumpTargets,
				preserveProfileSites,
				variantOwnership,
			).filter((ip) => !constantIps.has(ip)),
			definitionInitializedRegisters: definitionInitializedRegisters(
				variant,
				jumpTargets,
				reads,
				variantOwnership,
			),
			rematerializedConstantIps: constants,
		};
	};
	let numericLeaf: NativeNumericLeafPlan | undefined;
	if (entry !== undefined && selectNumericLeaf(native, entry)) {
		const leaf = {
			...native,
			instructions: native.instructions.map((plan) =>
				plan?.kind === "unsigned-arithmetic" ? plan : undefined,
			),
			specializations: [],
			regionActions: [],
			fieldCalls: [],
			literalSwitches: [],
		};
		numericLeaf = {
			...scalarStorage(leaf),
			fallthroughJumpIps: fn.instructions.flatMap((op, ip) =>
				op.opcode === "JUMP" && op.targetIp === ip + 1 ? [ip] : [],
			),
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
	const callTransports = selectNativeCallTransports(native, entries);
	const calls = nativePrivateCallResultIps(fn, native, callTransports);
	const privateLocals = new Set(
		nativePrivateRootRegisters(fn, native, new Set(roots), calls),
	);
	for (const plan of [...propertyWindows, ...auxiliaryWindows])
		for (const local of plan.borrowedRegisters) privateLocals.delete(local);
	const scalar = scalarStorage(native);
	const directHeapObjectIps = selectNativeDirectHeapObjects(native);
	return {
		...fastPaths,
		callTransports,
		callbackTransports: selectNativeCallbackTransports(native, entries),
		suspension: compactNativeSuspension(
			suspension,
			new Set(
				scalar.rematerializedConstantIps.map((ip) => {
					const op = fn.instructions[ip]!;
					if (!("dst" in op))
						throw new Error("Rematerialized constant lacks a destination");
					return op.dst;
				}),
			),
		),
		directHeapObjectIps,
		stackObjects: selectNativeStackObjectStorage(native, new Set(directHeapObjectIps)),
		rootRegisters: roots,
		...selectNativeRootStorage(native, roots, privateLocals, calls),
		privateRegisters: roots.filter((local) => privateLocals.has(local)),
		privateCallResultIps: [...calls],
		entryStableRootRegisters: [...nativeEntryStableRootRegisters(fn, privateLocals)],
		elidedTdzIps: elidedTdzIps(native, ownership),
		...scalar,
		numericLeaf,
	};
}

export function lowerNativeFunctionStorage(
	native: NativeFunctionPlan,
	entries: NativeEntryLookup = new Map(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): NativeFunctionPlan {
	return {
		...native,
		storage: lowerStorage(native, true, undefined, entries, undefined, stringConstants),
		directEntries: native.directEntries.map((entry) => ({
			...entry,
			storage: lowerStorage(
				nativeVariantContract(native, entry),
				true,
				entry,
				entries,
				undefined,
				stringConstants,
			),
		})),
	};
}

export function lowerNativeStorage(image: ProgramImage): ProgramImage {
	const entries = nativeEntryLookup(image.native.functions);
	return {
		...image,
		native: {
			...image.native,
			functions: image.native.functions.map((native) =>
				lowerNativeFunctionStorage(native, entries, image.runtime.stringConstants),
			),
		},
	};
}

export function validateNativeStorage(
	native: NativeFunctionPlan,
	entries: NativeEntryLookup = new Map(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): void {
	const sameNumbers = (left: ReadonlyArray<number>, right: ReadonlyArray<number>) =>
		left.length === right.length && left.every((value, index) => value === right[index]);
	const sameProjections = (
		stored: ReadonlyArray<NativePropertyProjectionPlan>,
		selected: ReadonlyArray<NativePropertyProjectionPlan>,
	): boolean =>
		stored.length === selected.length &&
		stored.every((plan, index) => {
			const expected = selected[index]!;
			const operand = (value: NativePropertyProjectionPlan["steps"][number]["left"]) =>
				[value.kind, value.kind === "register" ? value.register : value.index].join(":");
			return (
				plan.id === expected.id &&
				plan.object === expected.object &&
				plan.fallback === expected.fallback &&
				plan.terminalStore?.ip === expected.terminalStore?.ip &&
				plan.loads.length === expected.loads.length &&
				plan.loads.every(
					(load, i) =>
						load.ip === expected.loads[i]!.ip &&
						load.icIndex === expected.loads[i]!.icIndex,
				) &&
				plan.steps.length === expected.steps.length &&
				plan.steps.every(
					(step, i) =>
						step.ip === expected.steps[i]!.ip &&
						operand(step.left) === operand(expected.steps[i]!.left) &&
						operand(step.right) === operand(expected.steps[i]!.right),
				) &&
				(
					["boxedRegisters", "skippedIps", "claimedIps", "borrowedRegisters"] as const
				).every((key) => sameNumbers(plan[key], expected[key]))
			);
		});
	const sameUpdates = (
		stored: ReadonlyArray<NativePropertyNumericUpdatePlan>,
		selected: ReadonlyArray<NativePropertyNumericUpdatePlan>,
	): boolean =>
		stored.length === selected.length &&
		stored.every((plan, index) => {
			const expected = selected[index]!;
			const operation = plan.operation;
			const other = expected.operation;
			return (
				plan.id === expected.id &&
				plan.loadIp === expected.loadIp &&
				plan.storeIp === expected.storeIp &&
				plan.operationIp === expected.operationIp &&
				plan.constantIp === expected.constantIp &&
				plan.fallback === expected.fallback &&
				operation.kind === other.kind &&
				operation.operator === other.operator &&
				(operation.kind === "unary" ||
					(other.kind === "binary" &&
						operation.propertyIsLeft === other.propertyIsLeft &&
						operation.right.kind === other.right.kind &&
						(operation.right.kind === "literal"
							? other.right.kind === "literal" &&
								Object.is(operation.right.value, other.right.value)
							: other.right.kind === "register" &&
								operation.right.register === other.right.register))) &&
				sameNumbers(plan.claimedIps, expected.claimedIps) &&
				sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters) &&
				plan.materializations.length === expected.materializations.length &&
				plan.materializations.every(
					(value, i) =>
						value.ip === expected.materializations[i]!.ip &&
						value.register === expected.materializations[i]!.register &&
						value.value === expected.materializations[i]!.value,
				)
			);
		});

	const sameReadRegions = (
		stored: ReadonlyArray<NativePropertyReadRegionPlan>,
		selected: ReadonlyArray<NativePropertyReadRegionPlan>,
	): boolean =>
		stored.length === selected.length &&
		stored.every((plan, index) => {
			const expected = selected[index]!;
			return (
				plan.id === expected.id &&
				plan.object === expected.object &&
				plan.endIp === expected.endIp &&
				plan.continuation === expected.continuation &&
				sameNumbers(plan.claimedIps, expected.claimedIps) &&
				sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters) &&
				plan.loads.length === expected.loads.length &&
				plan.loads.every(
					(load, i) =>
						load.ip === expected.loads[i]!.ip &&
						load.icIndex === expected.loads[i]!.icIndex,
				)
			);
		});

	const sameScalar = (
		stored: NativeScalarStoragePlan | undefined,
		selected: NativeScalarStoragePlan | undefined,
	): boolean => {
		if (stored === undefined || selected === undefined) return stored === selected;
		const selectedExpressions = new Set(selected.expressionIps);
		const selectedConstants = new Set(selected.rematerializedConstantIps);
		const storedExpressions = new Set(stored.expressionIps);

		return (
			stored.definitionInitializedRegisters.length ===
				selected.definitionInitializedRegisters.length &&
			stored.definitionInitializedRegisters.every(
				(value, index) => value === selected.definitionInitializedRegisters[index],
			) &&
			// Profiling can retain producers; persisted choices may use any safe subset.
			stored.expressionIps.every(
				(ip, index) =>
					selectedExpressions.has(ip) &&
					(index === 0 || ip > stored.expressionIps[index - 1]!),
			) &&
			stored.rematerializedConstantIps.every(
				(ip, index) =>
					selectedConstants.has(ip) &&
					!storedExpressions.has(ip) &&
					(index === 0 || ip > stored.rematerializedConstantIps[index - 1]!),
			) &&
			(native.body.profileSiteIds === undefined ||
				(stored.expressionIps.length === 0 &&
					stored.rematerializedConstantIps.length === 0))
		);
	};
	const same = (
		stored: NativeStoragePlan | undefined,
		selected: NativeStoragePlan | undefined,
		baseSuspension: NativeSuspensionPlan | undefined,
	): boolean => {
		const suspension =
			stored === undefined
				? undefined
				: compactNativeSuspension(
						baseSuspension,
						new Set(
							stored.rematerializedConstantIps.flatMap((ip) => {
								const op = native.body.instructions[ip];
								return op !== undefined && "dst" in op ? [op.dst] : [];
							}),
						),
					);
		return (
			stored !== undefined &&
			selected !== undefined &&
			stored.rootSlotCount === selected.rootSlotCount &&
			nativeCallTransportsMatch(stored.callTransports, selected.callTransports) &&
			nativeCallbackTransportsMatch(
				stored.callbackTransports,
				selected.callbackTransports,
			) &&
			sameScalar(stored, selected) &&
			sameNumbers(stored.directHeapObjectIps, selected.directHeapObjectIps) &&
			stored.stackObjects.length === selected.stackObjects.length &&
			stored.stackObjects.every(
				(plan, index) =>
					plan.allocationIp === selected.stackObjects[index]!.allocationIp &&
					plan.slotRepresentations.length ===
						selected.stackObjects[index]!.slotRepresentations.length &&
					plan.slotRepresentations.every(
						(rep, slot) =>
							rep === selected.stackObjects[index]!.slotRepresentations[slot],
					),
			) &&
			(stored.suspension === undefined || suspension === undefined
				? stored.suspension === suspension
				: stored.suspension.valueSlot === suspension.valueSlot &&
					stored.suspension.modeSlot === suspension.modeSlot &&
					stored.suspension.slotCount === suspension.slotCount &&
					stored.suspension.points.length === suspension.points.length &&
					stored.suspension.points.every(
						(point, index) =>
							point.instructionIp === suspension.points[index]!.instructionIp &&
							sameNumbers(point.registers, suspension.points[index]!.registers),
					)) &&
			stored.literalPropertyDefinitions.length ===
				selected.literalPropertyDefinitions.length &&
			stored.literalPropertyDefinitions.every((plan, index) => {
				const expected = selected.literalPropertyDefinitions[index]!;
				return (
					plan.instructionIp === expected.instructionIp &&
					plan.stringIndex === expected.stringIndex
				);
			}) &&
			stored.mathCalls.length === selected.mathCalls.length &&
			stored.mathCalls.every((plan, index) => {
				const expected = selected.mathCalls[index]!;
				return (
					plan.instructionIp === expected.instructionIp &&
					plan.operation === expected.operation &&
					plan.arity === expected.arity &&
					plan.mode === expected.mode
				);
			}) &&
			sameProjections(stored.propertyProjections, selected.propertyProjections) &&
			sameUpdates(stored.propertyNumericUpdates, selected.propertyNumericUpdates) &&
			sameReadRegions(stored.propertyReadRegions, selected.propertyReadRegions) &&
			stored.arrayPresence.length === selected.arrayPresence.length &&
			stored.arrayPresence.every((plan, index) => {
				const expected = selected.arrayPresence[index]!;
				return (
					(
						[
							"regionIndex",
							"siteIndex",
							"elementIndex",
							"membershipIp",
							"loadIp",
							"fallback",
						] as const
					).every((key) => plan[key] === expected[key]) &&
					sameNumbers(plan.claimedIps, expected.claimedIps) &&
					sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters)
				);
			}) &&
			stored.arrayPairDestructure.length === selected.arrayPairDestructure.length &&
			stored.arrayPairDestructure.every((plan, index) => {
				const expected = selected.arrayPairDestructure[index]!;
				return (
					(
						[
							"regionIndex",
							"initializeIp",
							"firstStepIp",
							"secondStepIp",
							"closeIp",
							"continuationIp",
							"fallback",
						] as const
					).every((key) => plan[key] === expected[key]) &&
					sameNumbers(plan.claimedIps, expected.claimedIps) &&
					sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters)
				);
			}) &&
			stored.pairedArrayLoops.length === selected.pairedArrayLoops.length &&
			stored.pairedArrayLoops.every((plan, index) => {
				const expected = selected.pairedArrayLoops[index]!;
				return (
					(
						[
							"id",
							"lengthLoadIp",
							"primaryLoadIp",
							"primaryObject",
							"secondaryLoadIp",
							"secondaryObject",
							"key",
						] as const
					).every((key) => plan[key] === expected[key]) &&
					sameNumbers(plan.claimedIps, expected.claimedIps) &&
					sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters)
				);
			}) &&
			(stored.constructorInitialization === undefined ||
			selected.constructorInitialization === undefined
				? stored.constructorInitialization === selected.constructorInitialization
				: stored.constructorInitialization.id === selected.constructorInitialization.id &&
					sameNumbers(
						stored.constructorInitialization.stores,
						selected.constructorInitialization.stores,
					) &&
					sameNumbers(
						stored.constructorInitialization.claimedIps,
						selected.constructorInitialization.claimedIps,
					) &&
					sameNumbers(
						stored.constructorInitialization.borrowedRegisters,
						selected.constructorInitialization.borrowedRegisters,
					)) &&
			(stored.privateFieldReserve === undefined ||
			selected.privateFieldReserve === undefined
				? stored.privateFieldReserve === selected.privateFieldReserve
				: stored.privateFieldReserve.id === selected.privateFieldReserve.id &&
					stored.privateFieldReserve.count === selected.privateFieldReserve.count &&
					sameNumbers(
						stored.privateFieldReserve.claimedIps,
						selected.privateFieldReserve.claimedIps,
					) &&
					sameNumbers(
						stored.privateFieldReserve.borrowedRegisters,
						selected.privateFieldReserve.borrowedRegisters,
					)) &&
			stored.propertyReadPairs.length === selected.propertyReadPairs.length &&
			stored.propertyReadPairs.every((plan, index) => {
				const expected = selected.propertyReadPairs[index]!;
				return (
					plan.id === expected.id &&
					plan.object === expected.object &&
					plan.fallback === expected.fallback &&
					sameNumbers(plan.claimedIps, expected.claimedIps) &&
					sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters) &&
					plan.loads.length === expected.loads.length &&
					plan.loads.every(
						(load, i) =>
							load.ip === expected.loads[i]!.ip &&
							load.icIndex === expected.loads[i]!.icIndex,
					)
				);
			}) &&
			sameScalar(stored.numericLeaf, selected.numericLeaf) &&
			(stored.numericLeaf === undefined ||
				(stored.numericLeaf.fallthroughJumpIps.length ===
					selected.numericLeaf!.fallthroughJumpIps.length &&
					stored.numericLeaf.fallthroughJumpIps.every(
						(ip, index) => ip === selected.numericLeaf!.fallthroughJumpIps[index],
					))) &&
			(
				[
					"rootRegisters",
					"rootSlots",
					"privateRegisters",
					"privateCallResultIps",
					"entryStableRootRegisters",
					"elidedTdzIps",
				] as const
			).every(
				(key) =>
					stored[key].length === selected[key].length &&
					stored[key].every((value, index) => value === selected[key][index]),
			)
		);
	};
	const matches = (variant: NativeFunctionPlan, entry?: NativeDirectEntryPlan) => {
		const suspension = lowerNativeSuspension(variant);
		return same(
			variant.storage,
			lowerStorage(variant, false, entry, entries, suspension, stringConstants),
			suspension,
		);
	};
	if (
		!matches(native) ||
		native.directEntries.some(
			(entry) => !matches(nativeVariantContract(native, entry), entry),
		)
	)
		throw new Error("Native function has an invalid or stale storage plan");
}
import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
