import { builtinPrimitiveResult } from "../shared/builtin-registry.ts";
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
import {
	selectNativeCaptureAccess,
	nativeCaptureAccessPlansMatch,
} from "./lower-native-captures.ts";
import type { NativeCaptureAccessPlan } from "./lower-native-captures.ts";
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
import {
	selectNativeRootStorage,
	validateNativeRootStorage,
} from "./lower-native-roots.ts";
import type { NativeRootStoragePlan } from "./lower-native-roots.ts";
import { nativeStringTransformPlansMatch } from "./lower-native-string-transforms.ts";
import {
	compactNativeSuspension,
	lowerNativeSuspension,
} from "./lower-native-suspension.ts";
import type { NativeSuspensionPlan } from "./lower-native-suspension.ts";
import { analyzeNativeBodyFacts } from "./native-body-facts.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
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
import { decodeVmValueOperand, vmInstructionReadRegisters } from "./runtime-image.ts";
import type { BytecodeInstruction } from "./runtime-image.ts";

export interface NativeScalarStoragePlan {
	readonly expressionIps: ReadonlyArray<number>;
	readonly definitionInitializedRegisters: ReadonlyArray<number>;
	readonly rematerializedConstantIps: ReadonlyArray<number>;
}

export interface NativeNumericWorkerPlan extends NativeScalarStoragePlan {
	readonly fallthroughJumpIps: ReadonlyArray<number>;
	readonly pollingIps: ReadonlyArray<number>;
}

export interface NativeStoragePlan
	extends NativeScalarStoragePlan, NativeRootStoragePlan, NativeFastPathPlans {
	readonly captures: NativeCaptureAccessPlan;
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
	readonly numericWorker: NativeNumericWorkerPlan | undefined;
}

function selectNumericWorker(
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
		!["RETURN", "JUMP"].includes(fn.instructions.at(-1)?.opcode ?? "") ||
		!fn.instructions.some((op) => op.opcode === "RETURN")
	)
		return false;
	const reps = entry.registerRepresentations;
	const numeric = (local: number) => reps[local] === "number" || reps[local] === "int32";
	return fn.instructions.every((op, ip) => {
		switch (op.opcode) {
			case "JUMP":
			case "JUMP_IF":
				return (
					op.targetIp >= 0 &&
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

interface NativeStorageBodyFacts extends NativeBodyFacts {
	readonly captures: NativeCaptureAccessPlan;
	readonly writeCounts: Uint32Array;
	readonly definitions: Int32Array;
	readonly uses: ReadonlyArray<ReadonlyArray<number>>;
	readonly iteratorDoneRegisters: ReadonlyArray<number>;
	readonly controlBoundaries: ReadonlyArray<boolean>;
	readonly predecessorCounts: Uint32Array;
	readonly controlFlow: NativeStorageControlFlow | undefined;
}

interface NativeStorageControlFlow {
	readonly blockCount: number;
	readonly isReachable: (instructionIp: number) => boolean;
	readonly dominates: (definitionIp: number, useIp: number) => boolean;
	readonly isDefinedBeforeReads: (
		readIps: ReadonlyArray<number>,
		definitionIps: ReadonlyArray<number>,
	) => boolean;
}

function blockDominators(
	successors: ReadonlyArray<ReadonlyArray<number>>,
): (definitionBlock: number, useBlock: number) => boolean {
	const visited = new Uint8Array(successors.length);
	const postorder: Array<number> = [];
	const pending = [{ block: 0, next: 0 }];
	visited[0] = 1;
	while (pending.length > 0) {
		const frame = pending.at(-1)!;
		const edges = successors[frame.block]!;
		if (frame.next < edges.length) {
			const next = edges[frame.next++]!;
			if (visited[next] !== 0) continue;
			visited[next] = 1;
			pending.push({ block: next, next: 0 });
		} else {
			postorder.push(frame.block);
			pending.pop();
		}
	}
	const reversePostorder = postorder.reverse();
	const order = new Int32Array(successors.length).fill(-1);
	const parents = new Int32Array(successors.length).fill(-1);
	const predecessors = successors.map(() => new Array<number>());
	for (const [index, block] of reversePostorder.entries()) {
		order[block] = index;
		for (const next of successors[block]!) predecessors[next]!.push(block);
	}
	parents[0] = 0;
	const intersect = (left: number, right: number): number => {
		while (left !== right) {
			while (order[left]! > order[right]!) left = parents[left]!;
			while (order[right]! > order[left]!) right = parents[right]!;
		}
		return left;
	};
	const queue = reversePostorder.slice(1);
	const queued = new Uint8Array(successors.length);
	for (const block of queue) queued[block] = 1;
	let cursor = 0;
	while (cursor < queue.length) {
		const block = queue[cursor++]!;
		queued[block] = 0;
		let parent: number | undefined;
		for (const previous of predecessors[block]!) {
			if (parents[previous]! < 0) continue;
			parent = parent === undefined ? previous : intersect(parent, previous);
		}
		if (parent === undefined || parents[block] === parent) continue;
		parents[block] = parent;
		for (const next of successors[block]!) {
			if (next === 0 || queued[next] !== 0) continue;
			queued[next] = 1;
			queue.push(next);
		}
	}
	const children = successors.map(() => new Array<number>());
	for (const block of reversePostorder.slice(1)) children[parents[block]!]!.push(block);
	const entries = new Int32Array(successors.length).fill(-1);
	const exits = new Int32Array(successors.length).fill(-1);
	let clock = 0;
	pending.push({ block: 0, next: 0 });
	entries[0] = clock++;
	while (pending.length > 0) {
		const frame = pending.at(-1)!;
		const descendants = children[frame.block]!;
		if (frame.next < descendants.length) {
			const child = descendants[frame.next++]!;
			entries[child] = clock++;
			pending.push({ block: child, next: 0 });
		} else {
			exits[frame.block] = clock++;
			pending.pop();
		}
	}
	return (definitionBlock, useBlock) =>
		entries[useBlock]! >= entries[definitionBlock]! &&
		exits[useBlock]! <= exits[definitionBlock]!;
}

function storageControlFlow(
	fn: NativeFunctionPlan["body"],
	jumpTargets: ReadonlySet<number>,
	controlBoundaries: ReadonlyArray<boolean>,
): NativeStorageControlFlow | undefined {
	if (fn.instructions.length === 0) return undefined;
	const blocks = new Uint32Array(fn.instructions.length);
	const ends: Array<number> = [];
	let block = 0;
	let startsBlock = false;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		if (ip > 0 && (startsBlock || jumpTargets.has(ip))) {
			ends.push(ip - 1);
			block++;
		}
		blocks[ip] = block;
		startsBlock = controlBoundaries[ip]!;
	}
	ends.push(fn.instructions.length - 1);
	const successors = ends.map((ip, index) => {
		const op = fn.instructions[ip]!;
		if (op.opcode === "JUMP") return [blocks[op.targetIp]!];
		const next = index + 1 < ends.length ? [index + 1] : [];
		if (op.opcode === "JUMP_IF") return [...next, blocks[op.targetIp]!];
		return ["RETURN", "THROW", "TERMINAL_YIELD"].includes(op.opcode) ? [] : next;
	});
	const reachable = (): Uint8Array => {
		const visited = new Uint8Array(ends.length);
		const pending = [0];
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (visited[current] !== 0) continue;
			visited[current] = 1;
			pending.push(...successors[current]!);
		}
		return visited;
	};
	const live = reachable();
	let dominatesBlock: ReturnType<typeof blockDominators> | undefined;
	return {
		blockCount: ends.length,
		isReachable: (ip) => live[blocks[ip]!] === 1,
		dominates(definitionIp, useIp) {
			const definitionBlock = blocks[definitionIp]!;
			const useBlock = blocks[useIp]!;
			if (live[definitionBlock] === 0 || live[useBlock] === 0) return false;
			if (useBlock === definitionBlock) return useIp > definitionIp;
			if (definitionBlock === 0) return true;
			dominatesBlock ??= blockDominators(successors);
			return dominatesBlock(definitionBlock, useBlock);
		},
		isDefinedBeforeReads(readIps, definitionIps) {
			if (!readIps.every((ip) => live[blocks[ip]!] === 1)) return false;
			const reads = new Set(readIps);
			const definitions = new Set(definitionIps);
			const visited = new Uint8Array(ends.length);
			const pending = [0];
			while (pending.length > 0) {
				const current = pending.pop()!;
				if (visited[current] !== 0) continue;
				visited[current] = 1;
				const start = current === 0 ? 0 : ends[current - 1]! + 1;
				let defined = false;
				for (let ip = start; ip <= ends[current]!; ip++) {
					// A self-copy reads the old value before defining its destination.
					if (reads.has(ip)) return false;
					if (definitions.has(ip)) {
						defined = true;
						break;
					}
				}
				if (!defined) pending.push(...successors[current]!);
			}
			return true;
		},
	};
}

function storageBodyFacts(native: NativeFunctionPlan): NativeStorageBodyFacts {
	const fn = native.body;
	const facts = analyzeNativeBodyFacts(fn);
	const { reads, writes, jumpTargets } = facts;
	const writeCounts = new Uint32Array(fn.registerCount);
	const definitions = new Int32Array(fn.registerCount).fill(-1);
	const uses: Array<Array<number>> = Array.from({ length: fn.registerCount }, () => []);
	const iteratorDoneRegisters: Array<number> = [];
	const predecessorCounts = new Uint32Array(fn.instructions.length);
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "ITERATOR_STEP") iteratorDoneRegisters.push(op.doneDst);
		// Conservative images have no SSA locals and receive operand validation downstream.
		if (native.storageValues !== undefined) {
			for (const local of writes[ip]!) {
				writeCounts[local]!++;
				definitions[local] = ip;
			}
			for (const local of reads[ip]!) uses[local]!.push(ip);
		}
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") {
			predecessorCounts[op.targetIp]!++;
		}
		if (
			ip + 1 < fn.instructions.length &&
			!["JUMP", "RETURN", "THROW", "TERMINAL_YIELD"].includes(op.opcode)
		)
			predecessorCounts[ip + 1]!++;
	}
	const controlBoundaries = fn.instructions.map(scalarControlBoundary);
	return {
		...facts,
		captures: selectNativeCaptureAccess(fn, native.functionIndex),
		writeCounts,
		definitions,
		uses,
		iteratorDoneRegisters,
		controlBoundaries,
		predecessorCounts,
		controlFlow:
			native.storageValues === undefined || fn.handlers.length > 0
				? undefined
				: storageControlFlow(fn, jumpTargets, controlBoundaries),
	};
}

function scalarStorageOwnership(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
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
	const handlers = body.handlerTargets;
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
			return op === undefined ? [] : [...body.reads[ip]!, ...body.writes[ip]!];
		}),
	);
	for (const plan of projections)
		for (const register of plan.borrowedRegisters) borrowed.add(register);
	for (const point of suspension?.points ?? []) {
		blocked.add(point.instructionIp);
		for (const register of point.registers) borrowed.add(register);
		for (const register of body.writes[point.instructionIp]!) borrowed.add(register);
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

function scalarStorageUses(
	body: NativeStorageBodyFacts,
	suspension: NativeSuspensionPlan | undefined,
): ReadonlyArray<ReadonlyArray<number>> {
	if (suspension === undefined || suspension.points.length === 0) return body.uses;
	const uses = body.uses.map((ips) => [...ips]);
	for (const point of suspension.points)
		for (const local of point.registers) uses[local]!.push(point.instructionIp);
	return uses;
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
	body: NativeStorageBodyFacts,
	jumpTargets: ReadonlySet<number>,
	uses: ReadonlyArray<ReadonlyArray<number>>,
	{ blocked, borrowed }: NativeScalarOwnership,
): ReadonlyArray<number> {
	if (native.storageValues === undefined) return [];
	const fn = native.body;
	const { writeCounts: writes, definitions } = body;
	// Limit added dominance work deterministically; exception/resume entries need a broader CFG.
	const controlFlow =
		native.mode === "direct" &&
		!fn.isGenerator &&
		!fn.isAsync &&
		body.externalEntries.size === 0 &&
		(body.controlFlow?.blockCount ?? Infinity) <= 256
			? body.controlFlow
			: undefined;
	const phiDefinitions =
		controlFlow !== undefined && fn.registerCount <= 128 && fn.instructions.length <= 4096
			? new Map<number, Array<number>>()
			: undefined;
	if (phiDefinitions !== undefined)
		for (const [ip, op] of fn.instructions.entries())
			if (op.opcode === "MOVE" && writes[op.dst]! > 1 && !blocked.has(ip)) {
				const definitions = phiDefinitions.get(op.dst) ?? [];
				definitions.push(ip);
				phiDefinitions.set(op.dst, definitions);
			}
	const blocks = new Uint32Array(fn.instructions.length);
	let block = 0;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		if (jumpTargets.has(ip) || blocked.has(ip)) block++;
		blocks[ip] = block;
		if (body.controlBoundaries[ip] || blocked.has(ip)) block++;
	}
	return native.registerRepresentations.flatMap((rep, local) => {
		const definition = definitions[local]!;
		if (
			local < fn.parameterCount + fn.argumentSnapshotCount ||
			!(native.storageValues![local]! >= 0) ||
			borrowed.has(local) ||
			!["number", "int32", "boolean"].includes(rep)
		)
			return [];
		if (writes[local] === 1)
			return !blocked.has(definition) &&
				(uses[local]!.every(
					(ip) => ip > definition && blocks[ip] === blocks[definition],
				) ||
					(controlFlow !== undefined &&
						uses[local]!.every((ip) => controlFlow.dominates(definition, ip))))
				? [local]
				: [];
		const copies = phiDefinitions?.get(local);
		return copies !== undefined &&
			copies.length === writes[local] &&
			controlFlow!.isDefinedBeforeReads(uses[local]!, copies)
			? [local]
			: [];
	});
}

function rematerializedConstantIps(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	preserveProfileSites: boolean,
	uses: ReadonlyArray<ReadonlyArray<number>>,
	immutableOwnership: NativeScalarOwnership,
): ReadonlyArray<number> {
	const fn = native.body;
	if (
		native.storageValues === undefined ||
		body.controlFlow === undefined ||
		(preserveProfileSites && fn.profileSiteIds !== undefined)
	)
		return [];
	const writes = body.writeCounts;
	return fn.instructions.flatMap((op, ip) => {
		if (
			![
				"CREATE_NUMBER",
				"CREATE_F64",
				"CREATE_BOOLEAN",
				"CREATE_STRING",
				"CREATE_BIGINT",
				"CREATE_NULL",
				"CREATE_UNDEFINED",
			].includes(op.opcode) ||
			!("dst" in op) ||
			op.dst < fn.parameterCount + fn.argumentSnapshotCount ||
			!(native.storageValues![op.dst]! >= 0) ||
			writes[op.dst] !== 1
		)
			return [];
		const rep = native.registerRepresentations[op.dst];
		const scalar =
			op.opcode === "CREATE_BOOLEAN"
				? rep === "boolean"
				: (op.opcode === "CREATE_NUMBER" || op.opcode === "CREATE_F64") &&
					(rep === "number" || rep === "int32");
		const boxed = rep === "boxed" || (op.opcode === "CREATE_STRING" && rep === "string");
		if (
			!scalar &&
			(!boxed ||
				immutableOwnership.blocked.has(ip) ||
				immutableOwnership.borrowed.has(op.dst))
		)
			return [];
		if (!body.controlFlow!.isReachable(ip)) return [];
		// Scalar region inputs are immutable; overlays only write explicit outputs or boxed storage.
		const dominates = uses[op.dst]!.every((useIp) =>
			body.controlFlow!.dominates(ip, useIp),
		);
		return dominates ? [ip] : [];
	});
}

function pureScalarOperation(
	op: BytecodeInstruction,
	reps: NativeFunctionPlan["registerRepresentations"],
	plan?: NativeFunctionPlan["instructions"][number],
): boolean {
	const numeric = (local: number) => reps[local] === "number" || reps[local] === "int32";
	const numberResult = (local: number) =>
		reps[local] === "number" || reps[local] === "boxed";
	const booleanResult = (local: number) =>
		reps[local] === "boolean" || reps[local] === "boxed";
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
					booleanResult(op.dst) &&
					(reps[op.src] === "boolean" || numericInput(op.src, 0))) ||
				(numericInput(op.src, 0) &&
					((numberResult(op.dst) &&
						["+", "-", "tonumeric", "~", "increment", "decrement"].includes(
							op.operator,
						)) ||
						(reps[op.dst] === "int32" && op.operator === "~")))
			);
		case "BINARY":
			if (plan?.kind === "unsigned-arithmetic")
				return (
					(numberResult(op.dst) || reps[op.dst] === "int32") &&
					["+", "-", "*", "%"].includes(op.operator)
				);
			if (
				booleanResult(op.dst) &&
				reps[op.left] === "boolean" &&
				reps[op.right] === "boolean"
			)
				return ["===", "!=="].includes(op.operator);
			return (
				numericInput(op.left, 0) &&
				numericInput(op.right, 1) &&
				((numberResult(op.dst) &&
					(NATIVE_ARITH[op.operator] !== undefined ||
						NATIVE_BITWISE[op.operator] !== undefined ||
						["%", ">>>"].includes(op.operator))) ||
					(reps[op.dst] === "int32" && NATIVE_BITWISE[op.operator] !== undefined) ||
					(booleanResult(op.dst) && NATIVE_COMPARE[op.operator] !== undefined))
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
		case "MOVE":
			return op.src === local && op.dst !== local;
		case "LOAD_PROPERTY":
			return op.key === local && op.object !== local;
		case "CREATE_OBJECT_SHAPED":
			return op.valueRegisters.includes(local);
		case "STORE_PROPERTY_STATIC":
		case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
			return op.value === local && op.object !== local;
		case "STORE_PROPERTY":
			return (
				op.object !== local &&
				((op.key === local && op.value !== local) ||
					(op.value === local && op.key !== local))
			);
		case "DEFINE_PROPERTY":
			return op.value === local && op.object !== local && op.key !== local;
		case "CALL":
			return !isLocal(op.callee) && !isLocal(op.thisValue) && op.arguments.some(isLocal);
		case "CALL_KNOWN":
			return (
				!op.construct &&
				op.argumentMode === undefined &&
				!isLocal(op.thisValue) &&
				op.arguments.some(isLocal)
			);
		case "QUERY_STATIC_DATA":
			return op.needle === local || op.fromIndex === local;
		case "PREPARED_STRING_COMPARE":
			return op.left === local || op.right === local;
		case "PRECISE_NUMBER_SUM":
			return op.arguments.includes(local);
		default:
			return false;
	}
}

function expressionIps(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	jumpTargets: ReadonlySet<number>,
	preserveProfileSites: boolean,
	{ blocked, borrowed }: NativeScalarOwnership,
	candidates?: ReadonlySet<number>,
): ReadonlyArray<number> {
	const fn = native.body;
	if (
		native.storageValues === undefined ||
		(preserveProfileSites && fn.profileSiteIds !== undefined)
	)
		return [];
	const { writeCounts: writes, uses } = body;
	const safepoints = new Set(native.gc.safepoints.map((point) => point.instructionIp));
	const fallthroughJumps = new Set<number>();
	for (const [ip, op] of fn.instructions.entries())
		if (
			op.opcode === "JUMP" &&
			op.targetIp === ip + 1 &&
			!blocked.has(ip) &&
			!blocked.has(ip + 1) &&
			!safepoints.has(ip) &&
			body.predecessorCounts[ip + 1] === 1 &&
			!body.externalEntries.has(ip + 1)
		)
			fallthroughJumps.add(ip);
	const expressions: Array<number> = [];
	const leavesByLocal = new Map<number, ReadonlySet<number>>();
	const costs = new Map<number, number>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (
			(candidates !== undefined && !candidates.has(ip)) ||
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
		const inputs = body.reads[ip]!;
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
				(jumpTargets.has(next) && !fallthroughJumps.has(next - 1)) ||
				(next < consumerIp &&
					((!pureScalarOperation(
						fn.instructions[next]!,
						native.registerRepresentations,
						native.instructions[next],
					) &&
						!fallthroughJumps.has(next)) ||
						body.writes[next]!.some((local) => operands.has(local))))
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

export function nativeNumericWorkerContract(
	native: NativeFunctionPlan,
): NativeFunctionPlan {
	return {
		...native,
		instructions: native.instructions.map((plan) =>
			plan?.kind === "unsigned-arithmetic" ? plan : undefined,
		),
		specializations: [],
		regionActions: [],
		fieldCalls: [],
		literalSwitches: [],
	};
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

function immediateOperatorResult(
	op: Extract<BytecodeInstruction, { opcode: "UNARY" | "BINARY" }>,
	reps: NativeFunctionPlan["registerRepresentations"],
	plan: NativeFunctionPlan["instructions"][number],
): boolean {
	if (pureScalarOperation(op, reps, plan)) return true;
	const opcode = op.opcode === "UNARY" ? "unary" : "binary";
	const fixed = compilerOperatorFixedResultKind(opcode, op.operator);
	if (fixed !== undefined)
		return compilerValueKindMaskIsSubset(
			fixed,
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BOOLEAN,
		);
	const masks =
		plan?.kind === "exact-operator-input-kinds" &&
		compilerOperatorInputKindsHaveExactNativeSemantics(
			opcode,
			op.operator,
			plan.inputKindMasks,
		)
			? plan.inputKindMasks
			: undefined;
	const kind = (local: number, index: number): number => {
		switch (reps[local]) {
			case "number":
			case "int32":
				return COMPILER_VALUE_KIND_NUMBER;
			case "boolean":
				return COMPILER_VALUE_KIND_BOOLEAN;
			case "string":
				return COMPILER_VALUE_KIND_STRING;
			default:
				return masks?.[index] ?? COMPILER_VALUE_KIND_TOP;
		}
	};
	if (op.opcode === "UNARY")
		return (
			COMPILER_NUMERIC_UNARY_OPERATORS.has(op.operator) &&
			compilerNumericResultKind("unary", kind(op.src, 0)) === COMPILER_VALUE_KIND_NUMBER
		);
	return (
		COMPILER_NUMERIC_BINARY_OPERATORS.has(op.operator) &&
		compilerNumericResultKind(
			op.operator === "+" ? "add" : "binary",
			kind(op.left, 0),
			kind(op.right, 1),
		) === COMPILER_VALUE_KIND_NUMBER
	);
}

function untracedPrimitiveResultRegisters(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	{ blocked, borrowed }: NativeScalarOwnership,
): ReadonlySet<number> {
	const registers = new Set<number>();
	if (native.storageValues === undefined) return registers;
	for (const [ip, op] of native.body.instructions.entries()) {
		if (op.opcode !== "UNARY" && op.opcode !== "BINARY" && op.opcode !== "CALL_KNOWN")
			continue;
		const immediate =
			op.opcode === "CALL_KNOWN"
				? !op.construct &&
					op.argumentMode === undefined &&
					!body.reads[ip]!.includes(op.dst) &&
					["number", "boolean"].includes(builtinPrimitiveResult(op.operation) ?? "")
				: immediateOperatorResult(
						op,
						native.registerRepresentations,
						native.instructions[ip],
					);
		if (
			!blocked.has(ip) &&
			!borrowed.has(op.dst) &&
			op.dst >= native.body.parameterCount + native.body.argumentSnapshotCount &&
			native.storageValues[op.dst]! >= 0 &&
			body.writeCounts[op.dst] === 1 &&
			native.registerRepresentations[op.dst] === "boxed" &&
			immediate
		)
			registers.add(op.dst);
	}
	return registers;
}

function rootStorage(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	fastPaths: NativeFastPathPlans,
	callTransports: ReadonlyArray<NativeCallTransportPlan>,
	rematerializedConstantIps: ReadonlyArray<number>,
	expressionIps: ReadonlyArray<number>,
	untracedResults: ReadonlySet<number>,
) {
	const fn = native.body;
	// Admitted expressions produce untraced scalars; pooled literals have immortal addresses.
	const rootFree = new Set(untracedResults);
	for (const ip of [...rematerializedConstantIps, ...expressionIps]) {
		const op = fn.instructions[ip]!;
		if (!("dst" in op)) throw new Error("Native expression lacks a destination");
		rootFree.add(op.dst);
	}
	let roots = nativeFrameRootRegisters(fn, native).filter(
		(local) =>
			["boxed", "string"].includes(native.registerRepresentations[local]!) &&
			!rootFree.has(local),
	);
	if (roots.length > 64) {
		const counts = new Uint32Array(fn.registerCount);
		for (const point of native.gc.safepoints)
			for (const local of point.rootRegisters) counts[local]!++;
		roots.sort((left, right) => counts[left]! - counts[right]! || left - right);
	}
	const calls = nativePrivateCallResultIps(fn, native, callTransports);
	const privateLocals = new Set(
		nativePrivateRootRegisters(fn, native, new Set(roots), calls, body),
	);
	const borrowedPlans = [
		...fastPaths.propertyProjections,
		...fastPaths.propertyNumericUpdates,
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
	for (const plan of borrowedPlans)
		for (const local of plan.borrowedRegisters) privateLocals.delete(local);
	if (
		native.storageValues !== undefined &&
		privateLocals.size > 0 &&
		body.iteratorDoneRegisters.length > 0
	) {
		const omissionBorrowed = new Set(
			[...fastPaths.propertyReadRegions, ...fastPaths.propertyReadPairs].flatMap(
				(plan) => plan.borrowedRegisters,
			),
		);
		const iteratorDone = new Set<number>();
		for (const local of body.iteratorDoneRegisters) {
			// Private ownership certifies final outputs; every iterator variant writes a Boolean.
			if (
				privateLocals.has(local) &&
				!omissionBorrowed.has(local) &&
				local >= fn.parameterCount + fn.argumentSnapshotCount &&
				native.storageValues[local]! >= 0 &&
				body.writeCounts[local] === 1 &&
				native.registerRepresentations[local] === "boxed"
			) {
				iteratorDone.add(local);
				privateLocals.delete(local);
			}
		}
		if (iteratorDone.size > 0) roots = roots.filter((local) => !iteratorDone.has(local));
	}
	return {
		rootRegisters: roots,
		...selectNativeRootStorage(native, roots, privateLocals, calls),
		privateRegisters: roots.filter((local) => privateLocals.has(local)),
		privateCallResultIps: [...calls],
		entryStableRootRegisters: [
			...nativeEntryStableRootRegisters(
				fn,
				privateLocals,
				native.storageValues === undefined ? undefined : body.writeCounts,
			),
		],
	};
}

function scalarStorageWindows(fastPaths: NativeFastPathPlans) {
	return [
		...fastPaths.propertyProjections,
		...fastPaths.propertyNumericUpdates,
		...fastPaths.propertyReadRegions,
		...fastPaths.propertyReadPairs,
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
}

function lowerStorage(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	preserveProfileSites = true,
	entry?: NativeDirectEntryPlan,
	entries: NativeEntryLookup = new Map(),
	suspension = lowerNativeSuspension(native, body),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): NativeStoragePlan {
	const fn = native.body;
	const fastPaths = selectNativeFastPaths(native, entry, stringConstants, body);
	const expressionWindows = scalarStorageWindows(fastPaths);
	const jumpTargets = body.jumpTargets;
	const uses = scalarStorageUses(body, suspension);
	const immutableOwnership = scalarStorageOwnership(native, body, expressionWindows);
	const ownership =
		suspension === undefined
			? immutableOwnership
			: scalarStorageOwnership(native, body, expressionWindows, suspension);
	const scalarStorage = (variant: NativeFunctionPlan): NativeScalarStoragePlan => {
		const constants = rematerializedConstantIps(
			variant,
			body,
			preserveProfileSites,
			uses,
			variant === native
				? immutableOwnership
				: scalarStorageOwnership(variant, body, expressionWindows),
		);
		const constantIps = new Set(constants);
		const variantOwnership =
			variant === native
				? ownership
				: scalarStorageOwnership(variant, body, expressionWindows, suspension);
		return {
			expressionIps: expressionIps(
				variant,
				body,
				jumpTargets,
				preserveProfileSites,
				variantOwnership,
			).filter((ip) => !constantIps.has(ip)),
			definitionInitializedRegisters: definitionInitializedRegisters(
				variant,
				body,
				jumpTargets,
				uses,
				variantOwnership,
			),
			rematerializedConstantIps: constants,
		};
	};
	let numericWorker: NativeNumericWorkerPlan | undefined;
	if (entry !== undefined && selectNumericWorker(native, entry)) {
		const worker = nativeNumericWorkerContract(native);
		const pollingIps = native.gc.safepoints.flatMap((point) =>
			point.kind === "loop-backedge" ? [point.instructionIp] : [],
		);
		const polls = new Set(pollingIps);
		numericWorker = {
			...scalarStorage(worker),
			pollingIps,
			fallthroughJumpIps: fn.instructions.flatMap((op, ip) =>
				op.opcode === "JUMP" && op.targetIp === ip + 1 && !polls.has(ip) ? [ip] : [],
			),
		};
	}
	const callTransports = selectNativeCallTransports(native, entries);
	const scalar = scalarStorage(native);
	const directHeapObjectIps = selectNativeDirectHeapObjects(native);
	return {
		...fastPaths,
		captures: body.captures,
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
		...rootStorage(
			native,
			body,
			fastPaths,
			callTransports,
			scalar.rematerializedConstantIps,
			scalar.expressionIps,
			untracedPrimitiveResultRegisters(native, body, ownership),
		),
		elidedTdzIps: elidedTdzIps(native, ownership),
		...scalar,
		numericWorker,
	};
}

export function lowerNativeFunctionStorage(
	native: NativeFunctionPlan,
	entries: NativeEntryLookup = new Map(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
): NativeFunctionPlan {
	const body = storageBodyFacts(native);
	return {
		...native,
		storage: lowerStorage(
			native,
			body,
			true,
			undefined,
			entries,
			undefined,
			stringConstants,
		),
		directEntries: native.directEntries.map((entry) => ({
			...entry,
			storage: lowerStorage(
				nativeVariantContract(native, entry),
				body,
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
	// Recompute body facts at this trust boundary; callers can replace or mutate an image.
	const body = storageBodyFacts(native);
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
			nativeCaptureAccessPlansMatch(stored.captures, selected.captures) &&
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
			stored.numberPredicates.length === selected.numberPredicates.length &&
			stored.numberPredicates.every(
				(plan, index) =>
					plan.instructionIp === selected.numberPredicates[index]!.instructionIp &&
					plan.mode === selected.numberPredicates[index]!.mode,
			) &&
			nativeStringTransformPlansMatch(
				stored.stringTransforms,
				selected.stringTransforms,
			) &&
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
			sameScalar(stored.numericWorker, selected.numericWorker) &&
			(stored.numericWorker === undefined ||
				(sameNumbers(
					stored.numericWorker.pollingIps,
					selected.numericWorker!.pollingIps,
				) &&
					stored.numericWorker.fallthroughJumpIps.length ===
						selected.numericWorker!.fallthroughJumpIps.length &&
					stored.numericWorker.fallthroughJumpIps.every(
						(ip, index) => ip === selected.numericWorker!.fallthroughJumpIps[index],
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
		if (variant.storage === undefined) return false;
		validateNativeRootStorage(variant, variant.storage.rootRegisters, variant.storage);
		const suspension = lowerNativeSuspension(variant, body);
		const selected = lowerStorage(
			variant,
			body,
			false,
			entry,
			entries,
			suspension,
			stringConstants,
		);
		if (!sameScalar(variant.storage, selected)) return false;
		if (
			!sameNumbers(variant.storage.expressionIps, selected.expressionIps) &&
			!sameNumbers(
				variant.storage.expressionIps,
				expressionIps(
					variant,
					body,
					body.jumpTargets,
					false,
					scalarStorageOwnership(
						variant,
						body,
						scalarStorageWindows(selected),
						suspension,
					),
					new Set(variant.storage.expressionIps),
				),
			)
		)
			return false;
		const retained =
			sameNumbers(
				variant.storage.rematerializedConstantIps,
				selected.rematerializedConstantIps,
			) && sameNumbers(variant.storage.expressionIps, selected.expressionIps)
				? selected
				: {
						...selected,
						...rootStorage(
							variant,
							body,
							selected,
							selected.callTransports,
							variant.storage.rematerializedConstantIps,
							variant.storage.expressionIps,
							untracedPrimitiveResultRegisters(
								variant,
								body,
								scalarStorageOwnership(
									variant,
									body,
									scalarStorageWindows(selected),
									suspension,
								),
							),
						),
					};
		return same(variant.storage, retained, suspension);
	};
	if (
		!matches(native) ||
		native.directEntries.some(
			(entry) => !matches(nativeVariantContract(native, entry), entry),
		)
	)
		throw new Error("Native function has an invalid or stale storage plan");
}
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_BOOLEAN,
	compilerOperatorFixedResultKind,
	compilerValueKindMaskIsSubset,
	compilerOperatorInputKindsHaveExactNativeSemantics,
	compilerNumericResultKind,
	COMPILER_NUMERIC_UNARY_OPERATORS,
	COMPILER_NUMERIC_BINARY_OPERATORS,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
} from "../shared/compiler-value-kinds.ts";
