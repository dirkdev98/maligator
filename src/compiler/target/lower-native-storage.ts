import { builtinNormalResultKinds } from "../shared/builtin-registry.ts";
import {
	instructionInputKind,
	instructionResultKind,
} from "../shared/instruction-facts.ts";
import type { InstructionFacts } from "../shared/instruction-facts.ts";
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
import {
	analyzeNativeFastPaths,
	nativeFastPathWindows,
} from "./lower-native-fast-paths.ts";
import type {
	NativeFastPathPlans,
	NativePropertyNumericUpdatePlan,
	NativePropertyProjectionPlan,
	NativeNumberRecordRegionPlan,
	NativeNumericLoopRegionPlan,
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
	nativeUnobservedCallResultRegisters,
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
import { analyzeNativeBodyFacts, projectNativeBodyFacts } from "./native-body-facts.ts";
import type { NativeBodyFacts, NativeBodyProjection } from "./native-body-facts.ts";
import {
	selectNativeControlFlow,
	nativeControlFlowPlansMatch,
	nativeControlFlowContract,
} from "./native-control-flow.ts";
import type {
	NativeControlFlowEntryOptions,
	NativeControlFlowPlan,
} from "./native-control-flow.ts";
import {
	NATIVE_ARITH,
	NATIVE_BITWISE,
	NATIVE_COMPARE,
} from "./native-scalar-operators.ts";
import { selectNativeStringComparisons } from "./native-string-comparisons.ts";
import type { NativeStringComparisonPlan } from "./native-string-comparisons.ts";
import {
	selectNativeUnusedValues,
	selectNativeUnusedRegisters,
} from "./native-unused-values.ts";
import {
	validateNativeInstructionFacts,
	nativeFrameRootRegisters,
	nativeRecordCallIps,
	nativeRecordParameterIps,
} from "./program-image.ts";
import type {
	NativeDirectEntryPlan,
	NativeFunctionPlan,
	ProgramImage,
} from "./program-image.ts";
import {
	decodeVmValueOperand,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

export interface NativeScalarStoragePlan {
	readonly expressionIps: ReadonlyArray<number>;
	/** Registers whose every read follows a definition; slot-backed roots still start zeroed. */
	readonly definitionInitializedRegisters: ReadonlyArray<number>;
	readonly rematerializedConstantIps: ReadonlyArray<number>;
}

export interface NativeNumericWorkerPlan extends NativeScalarStoragePlan {
	readonly fallthroughJumpIps: ReadonlyArray<number>;
	readonly pollingIps: ReadonlyArray<number>;
}

/**
 * Native code keeps its live values in C locals and the runtime scans native stacks
 * for them; Wasm cannot scan its stack and publishes them into a shadow root frame.
 */
export type NativeStackRoots = "conservative" | "precise";

export interface NativeStoragePlan
	extends NativeScalarStoragePlan, NativeRootStoragePlan, NativeFastPathPlans {
	readonly stackRoots: NativeStackRoots;
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
	readonly rootPublicationContinuations: ReadonlyArray<number>;
	readonly numericWorker: NativeNumericWorkerPlan | undefined;
	readonly controlFlow?: NativeControlFlowPlan;
	readonly elidedPureIps: ReadonlyArray<number>;
	readonly unusedRegisters: ReadonlyArray<number>;
	readonly stringComparisons: ReadonlyArray<NativeStringComparisonPlan>;
}

function selectNumericWorker(
	native: NativeFunctionPlan,
	entry: NativeDirectEntryPlan,
	controlFlow: NativeControlFlowPlan | undefined,
	elided: ReadonlySet<number>,
): boolean {
	const fn = native.body;
	const unreachable = new Set(controlFlow?.unreachableIps);
	const branches = new Set(controlFlow?.branches.map((branch) => branch.instructionIp));
	const last = fn.instructions.findLast((_, ip) => !unreachable.has(ip));
	if (
		fn.instructions.length - unreachable.size > 48 ||
		fn.handlers.length > 0 ||
		fn.capturedCount > 0 ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.isClassConstructor ||
		fn.mappedArguments ||
		entry.argumentRepresentations !== undefined ||
		entry.resultRepresentation !== "number" ||
		entry.fieldParameters?.representations.some((rep) => rep !== "number") ||
		!["RETURN", "JUMP"].includes(last?.opcode ?? "") ||
		!fn.instructions.some((op, ip) => op.opcode === "RETURN" && !unreachable.has(ip))
	)
		return false;
	const reps = entry.registerRepresentations;
	const numeric = (local: number) => reps[local] === "number" || reps[local] === "int32";
	return fn.instructions.every((op, ip) => {
		if (unreachable.has(ip) || elided.has(ip)) return true;
		switch (op.opcode) {
			case "JUMP":
			case "JUMP_IF":
				return (
					op.targetIp >= 0 &&
					op.targetIp < fn.instructions.length &&
					(op.opcode === "JUMP" || branches.has(ip) || reps[op.cond] === "boolean")
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
					) && pureScalarOperation(op, reps, native.instructions[ip], native.facts?.[ip])
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
	readonly accesses: NativeBodyFacts;
	readonly branchTargets: ReadonlyMap<number, number> | undefined;
	readonly isReachable: (instructionIp: number) => boolean;
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
	handlerTargets: ReadonlyArray<number | undefined>,
	projection?: NativeBodyProjection,
): NativeStorageControlFlow | undefined {
	if (fn.instructions.length === 0 || handlerTargets[0] !== undefined) return undefined;
	const blocks = new Uint32Array(fn.instructions.length);
	const ends: Array<number> = [];
	let block = 0;
	let startsBlock = false;
	for (let ip = 0; ip < fn.instructions.length; ip++) {
		// Each protected instruction starts a block, so its exceptional edge can leave
		// from before its writes.
		if (
			ip > 0 &&
			(startsBlock || jumpTargets.has(ip) || handlerTargets[ip] !== undefined)
		) {
			ends.push(ip - 1);
			block++;
		}
		blocks[ip] = block;
		startsBlock = controlBoundaries[ip]! || handlerTargets[ip] !== undefined;
	}
	ends.push(fn.instructions.length - 1);
	const successors = ends.map((ip, index) => {
		if (projection?.unreachable.has(ip)) return [];
		const op = fn.instructions[ip]!;
		const target = projection?.branches.get(ip);
		if (target !== undefined) return [blocks[target]!];
		if (op.opcode === "JUMP") return [blocks[op.targetIp]!];
		const next = index + 1 < ends.length ? [index + 1] : [];
		if (op.opcode === "JUMP_IF") return [...next, blocks[op.targetIp]!];
		return ["RETURN", "THROW", "TERMINAL_YIELD"].includes(op.opcode) ? [] : next;
	});
	if (fn.handlers.length > 0) {
		const predecessors = ends.map(() => new Array<number>());
		for (const [from, targets] of successors.entries())
			for (const target of targets) predecessors[target]!.push(from);
		for (const [index, end] of ends.entries()) {
			const start = index === 0 ? 0 : ends[index - 1]! + 1;
			const handler = handlerTargets[start];
			if (handler === undefined || start !== end) continue;
			for (const from of predecessors[index]!)
				if (!successors[from]!.includes(blocks[handler]!))
					successors[from]!.push(blocks[handler]!);
		}
	}
	const entries =
		projection === undefined
			? [0]
			: [...new Set([...projection.entries].map((ip) => blocks[ip]!))];
	const reachable = (): Uint8Array => {
		const visited = new Uint8Array(ends.length);
		const pending = [...entries];
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
	const multipleEntries = entries.length > 1;
	return {
		isReachable: (ip) => live[blocks[ip]!] === 1,
		dominates(definitionIp, useIp) {
			const definitionBlock = blocks[definitionIp]!;
			const useBlock = blocks[useIp]!;
			if (live[definitionBlock] === 0 || live[useBlock] === 0) return false;
			if (useBlock === definitionBlock) return useIp > definitionIp;
			if (definitionBlock === 0 && !multipleEntries) return true;
			dominatesBlock ??= blockDominators(
				multipleEntries
					? [
							entries.map((entry) => entry + 1),
							...successors.map((targets) => targets.map((target) => target + 1)),
						]
					: successors,
			);
			const offset = multipleEntries ? 1 : 0;
			return dominatesBlock(definitionBlock + offset, useBlock + offset);
		},
		isDefinedBeforeReads(readIps, definitionIps) {
			if (!readIps.every((ip) => live[blocks[ip]!] === 1)) return false;
			const reads = new Set(readIps);
			const definitions = new Set(definitionIps);
			const visited = new Uint8Array(ends.length);
			const pending = [...entries];
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

function storageBodyFacts(
	native: NativeFunctionPlan,
	facts = analyzeNativeBodyFacts(native.body),
	captures = selectNativeCaptureAccess(native),
): NativeStorageBodyFacts {
	const fn = native.body;
	const { reads, writes, jumpTargets, projection } = facts;
	const writeCounts = new Uint32Array(fn.registerCount);
	const definitions = new Int32Array(fn.registerCount).fill(-1);
	const uses: Array<Array<number>> = Array.from({ length: fn.registerCount }, () => []);
	const iteratorDoneRegisters: Array<number> = [];
	const predecessorCounts = new Uint32Array(fn.instructions.length);
	for (const [ip, op] of fn.instructions.entries()) {
		if (projection?.unreachable.has(ip)) continue;
		if (op.opcode === "ITERATOR_STEP") iteratorDoneRegisters.push(op.doneDst);
		// Conservative images have no SSA locals and receive operand validation downstream.
		if (native.storageValues !== undefined) {
			for (const local of writes[ip]!) {
				writeCounts[local]!++;
				definitions[local] = ip;
			}
			for (const local of reads[ip]!) uses[local]!.push(ip);
		}
		const target = projection?.branches.get(ip);
		if (target !== undefined) {
			predecessorCounts[target]!++;
			continue;
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
	const controlBoundaries = fn.instructions.map(
		(op, ip) =>
			!projection?.unreachable.has(ip) &&
			projection?.branches.get(ip) !== ip + 1 &&
			scalarControlBoundary(op),
	);
	let controlFlow: NativeStorageControlFlow | undefined;
	let controlFlowAnalyzed = false;
	return {
		...facts,
		accesses: facts,
		branchTargets: projection?.branches,
		isReachable: (ip) => !projection?.unreachable.has(ip),
		captures,
		writeCounts,
		definitions,
		uses,
		iteratorDoneRegisters,
		controlBoundaries,
		predecessorCounts,
		get controlFlow() {
			if (!controlFlowAnalyzed) {
				controlFlowAnalyzed = true;
				if (native.storageValues !== undefined)
					controlFlow = storageControlFlow(
						fn,
						jumpTargets,
						controlBoundaries,
						facts.handlerTargets,
						projection,
					);
			}
			return controlFlow;
		},
	};
}

function projectStorageBodyFacts(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	controlFlow: NativeControlFlowPlan | undefined,
	entries: NativeControlFlowEntryOptions,
): NativeStorageBodyFacts {
	if (controlFlow === undefined) return body;
	return storageBodyFacts(
		native,
		projectNativeBodyFacts(native, body.accesses, controlFlow, entries),
		body.captures,
	);
}

function scalarStorageOwnership(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	projections: ReadonlyArray<
		Pick<NativePropertyProjectionPlan, "claimedIps" | "borrowedRegisters">
	>,
	suspension?: NativeSuspensionPlan,
	purpose: "scheduling" | "value-lifetime" | "result-lifetime" = "scheduling",
): NativeScalarOwnership {
	const fn = native.body;
	const blocked = new Set(
		native.specializations.flatMap((region) =>
			purpose === "value-lifetime" && region.kind === "numeric-fusion"
				? []
				: region.claimedIps,
		),
	);
	for (const plan of projections) for (const ip of plan.claimedIps) blocked.add(ip);
	for (const action of native.regionActions)
		if (
			purpose !== "value-lifetime" ||
			native.specializations[action.regionIndex]?.kind !== "numeric-fusion"
		)
			blocked.add(action.ip);
	for (const site of native.fieldCalls ?? [])
		for (let ip = site.allocationIp; ip <= site.callIp; ip++) blocked.add(ip);
	for (const ip of nativeRecordCallIps(native)) blocked.add(ip);
	for (const site of native.literalSwitches ?? [])
		for (let ip = site.instructionIp; ip <= site.endIp; ip++) blocked.add(ip);
	const handlers = body.handlerTargets;
	if (purpose !== "result-lifetime")
		for (const handler of fn.handlers) {
			blocked.add(handler.handlerIp);
			blocked.add(handler.endIp);
		}
	for (const [ip, op] of fn.instructions.entries()) {
		const plan = native.instructions[ip];
		if (
			(purpose !== "result-lifetime" &&
				(handlers[ip] !== undefined ||
					["CATCH", "TRY_BEGIN", "TRY_END"].includes(op.opcode))) ||
			(plan !== undefined &&
				!["unsigned-arithmetic", "call", "construct", "return-completion"].includes(
					plan.kind,
				))
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
		// Resume dispatch writes these outputs independently of ordinary reachability.
		for (const register of vmInstructionWriteRegisters(
			fn.instructions[point.instructionIp]!,
		))
			borrowed.add(register);
	}
	return { blocked, borrowed };
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
	publicationRegisters: ReadonlyArray<number> = [],
): ReadonlyArray<number> {
	if (native.storageValues === undefined) return [];
	const fn = native.body;
	const { writeCounts: writes, definitions } = body;
	// TODO: admit boxed locals of resumable bodies once their suspension paths are covered by tests.
	const boxedLocals = !fn.isGenerator && !fn.isAsync;
	const eligible = native.registerRepresentations.flatMap((rep, local) =>
		local >= fn.parameterCount + fn.argumentSnapshotCount &&
		native.storageValues![local]! >= 0 &&
		!borrowed.has(local) &&
		(["number", "int32", "boolean"].includes(rep) ||
			(boxedLocals && (rep === "boxed" || rep === "string")))
			? [local]
			: [],
	);
	if (eligible.length === 0) return [];
	const eligibleRoots = new Set(publicationRegisters);
	const publicationRoots = new Set(eligible.filter((local) => eligibleRoots.has(local)));
	const publicationUses = new Map<number, Array<number>>();
	// Root publication reads boxed locals even when no bytecode operand does.
	for (const point of publicationRoots.size === 0 ? [] : native.gc.safepoints)
		for (const local of point.incomingRootRegisters) {
			if (!publicationRoots.has(local)) continue;
			const reads = publicationUses.get(local) ?? [...uses[local]!];
			reads.push(point.instructionIp);
			publicationUses.set(local, reads);
		}
	// Resume entries need a broader CFG; handler entries are its exceptional edges.
	const selectControlFlow = (): NativeStorageControlFlow | undefined =>
		native.mode === "direct" &&
		!fn.isGenerator &&
		!fn.isAsync &&
		[...body.externalEntries].every((ip) => body.handlerEntries.has(ip))
			? body.controlFlow
			: undefined;
	const phiControlFlow =
		fn.registerCount <= 128 &&
		fn.instructions.length <= 4096 &&
		eligible.some((local) => writes[local]! > 1)
			? selectControlFlow()
			: undefined;
	const phiDefinitions =
		phiControlFlow !== undefined ? new Map<number, Array<number>>() : undefined;
	if (phiDefinitions !== undefined)
		for (const [ip, op] of fn.instructions.entries())
			if (
				body.isReachable(ip) &&
				op.opcode === "MOVE" &&
				writes[op.dst]! > 1 &&
				!blocked.has(ip)
			) {
				const definitions = phiDefinitions.get(op.dst) ?? [];
				definitions.push(ip);
				phiDefinitions.set(op.dst, definitions);
			}
	let blocks: Uint32Array | undefined;
	const sameBlock = (definition: number, use: number): boolean => {
		if (blocks === undefined) {
			blocks = new Uint32Array(fn.instructions.length);
			let block = 0;
			for (let ip = 0; ip < fn.instructions.length; ip++) {
				if (jumpTargets.has(ip) || blocked.has(ip)) block++;
				blocks[ip] = block;
				if (body.controlBoundaries[ip] || blocked.has(ip)) block++;
			}
		}
		return blocks[definition] === blocks[use];
	};
	return eligible.flatMap((local) => {
		const reads = publicationUses.get(local) ?? uses[local]!;
		const definition = definitions[local]!;
		if (writes[local] === 1) {
			if (blocked.has(definition)) return [];
			if (reads.every((ip) => ip > definition && sameBlock(definition, ip)))
				return [local];
			const controlFlow = selectControlFlow();
			return controlFlow !== undefined &&
				reads.every((ip) => controlFlow.dominates(definition, ip))
				? [local]
				: [];
		}
		const copies = phiDefinitions?.get(local);
		return copies !== undefined &&
			copies.length === writes[local] &&
			phiControlFlow!.isDefinedBeforeReads(reads, copies)
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
		fn.handlers.length > 0 ||
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
		// A window that claims the definition writes the register itself, even a scalar one.
		if (
			immutableOwnership.blocked.has(ip) ||
			(!scalar && (!boxed || immutableOwnership.borrowed.has(op.dst)))
		)
			return [];
		const controlFlow = body.controlFlow;
		if (controlFlow === undefined || !controlFlow.isReachable(ip)) return [];
		// Scalar region inputs are immutable; overlays only write explicit outputs or boxed storage.
		const dominates = uses[op.dst]!.every((useIp) => controlFlow.dominates(ip, useIp));
		return dominates ? [ip] : [];
	});
}

function pureScalarOperation(
	op: BytecodeInstruction,
	reps: NativeFunctionPlan["registerRepresentations"],
	plan?: NativeFunctionPlan["instructions"][number],
	facts?: InstructionFacts,
): boolean {
	const numeric = (local: number) => reps[local] === "number" || reps[local] === "int32";
	const numberResult = (local: number) =>
		reps[local] === "number" || reps[local] === "boxed";
	const booleanResult = (local: number) =>
		reps[local] === "boolean" || reps[local] === "boxed";
	const numericInput = (local: number, index: number) =>
		numeric(local) ||
		plan?.kind === "unsigned-arithmetic" ||
		facts?.inputKindMasks?.[index] === COMPILER_VALUE_KIND_NUMBER;
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
			if (booleanResult(op.dst) && (op.operator === "===" || op.operator === "!=="))
				return true;
			if (plan?.kind === "unsigned-arithmetic")
				return (
					(numberResult(op.dst) || reps[op.dst] === "int32") &&
					["+", "-", "*", "%"].includes(op.operator)
				);
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
		case "CALL_KNOWN":
			return (
				op.operation === "Object.is" &&
				!op.construct &&
				op.argumentMode === undefined &&
				(op.specialized === undefined || op.specialized === op.operation) &&
				booleanResult(op.dst)
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
		case "CONCAT_STRINGS":
			return op.arguments.includes(local);
		case "STRING_CONCAT_LENGTH":
			return op.prefixLength === local || op.part === local;
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
	const purity = new Uint8Array(fn.instructions.length);
	const pure = (ip: number): boolean => {
		if (purity[ip] === 0)
			purity[ip] = pureScalarOperation(
				fn.instructions[ip]!,
				native.registerRepresentations,
				native.instructions[ip],
				native.facts?.[ip],
			)
				? 2
				: 1;
		return purity[ip] === 2;
	};
	const safepoints = new Set(native.gc.safepoints.map((point) => point.instructionIp));
	const fallthroughJumps = new Set<number>();
	for (const [ip, op] of fn.instructions.entries())
		if (
			((op.opcode === "JUMP" && op.targetIp === ip + 1) ||
				body.branchTargets?.get(ip) === ip + 1) &&
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
			!body.isReachable(ip) ||
			(candidates !== undefined && !candidates.has(ip)) ||
			blocked.has(ip) ||
			!pure(ip) ||
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
			!pure(consumerIp) &&
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
			if (!body.isReachable(next)) continue;
			if (
				blocked.has(next) ||
				(jumpTargets.has(next) && !fallthroughJumps.has(next - 1)) ||
				(next < consumerIp &&
					((!pure(next) && !fallthroughJumps.has(next)) ||
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
	const instructionOverrides = entry.callOverrides?.length
		? [...native.instructions]
		: undefined;
	const instructions = instructionOverrides ?? native.instructions;
	const factOverrides = entry.instructionFacts?.length
		? [
				...(native.facts ??
					new Array<InstructionFacts | undefined>(native.instructions.length)),
			]
		: undefined;
	const facts = factOverrides ?? native.facts;
	for (const {
		instructionIp,
		masks,
		results,
		inputIntegerRanges,
		resultIntegerRanges,
		effectMask,
	} of entry.instructionFacts ?? []) {
		const canonical = facts?.[instructionIp];
		if (
			(canonical?.inputKindMasks !== undefined &&
				canonical.inputKindMasks.length !== masks.length) ||
			(canonical?.resultKindMasks !== undefined &&
				canonical.resultKindMasks.length !== results.length)
		)
			throw new RangeError("Invalid native instruction kinds arity");
		factOverrides![instructionIp] = {
			...canonical,
			inputKindMasks: masks,
			resultKindMasks: results,
			inputIntegerRanges,
			resultIntegerRanges,
			effectMask,
		};
	}
	for (const call of entry.callOverrides ?? []) {
		const canonical = instructions[call.instructionIp];
		instructionOverrides![call.instructionIp] = {
			kind: "call",
			...(call.guarded
				? { guardedFunctionIndices: [call.functionIndex] }
				: { directFunctionIndex: call.functionIndex }),
			directEntryId: call.entryId,
			...(canonical?.kind === "call" &&
			canonical.directClosureOwner !== undefined &&
			canonical.directFunctionIndex === call.functionIndex &&
			call.guarded !== true
				? { directClosureOwner: canonical.directClosureOwner }
				: {}),
		};
	}
	return {
		...native,
		registerRepresentations: entry.registerRepresentations,
		gc: entry.gc,
		instructions,
		facts,
		storage: entry.storage,
		...(entry.resultFields?.forwards === undefined
			? {}
			: {
					recordForwardIps: entry.resultFields.forwards.map((forward) => forward.callIp),
				}),
		...(entry.recordParameters === undefined
			? {}
			: { recordParameterIps: nativeRecordParameterIps(entry) }),
	};
}

function immediateOperatorResult(
	op: Extract<BytecodeInstruction, { opcode: "UNARY" | "BINARY" }>,
	reps: NativeFunctionPlan["registerRepresentations"],
	plan: NativeFunctionPlan["instructions"][number],
	facts?: InstructionFacts,
): boolean {
	if (pureScalarOperation(op, reps, plan, facts)) return true;
	const opcode = op.opcode === "UNARY" ? "unary" : "binary";
	const fixed = compilerOperatorFixedResultKind(opcode, op.operator);
	if (fixed !== undefined)
		return compilerValueKindMaskIsSubset(
			fixed,
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_BOOLEAN,
		);
	const masks = facts?.inputKindMasks;
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

function untracedValueRegisters(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	{ blocked, borrowed }: NativeScalarOwnership,
	rematerializedConstantIps: ReadonlyArray<number>,
): ReadonlySet<number> {
	const registers = new Set<number>();
	if (native.storageValues === undefined || native.gc.safepoints.length === 0)
		return registers;
	const fn = native.body;
	const entryCount = fn.parameterCount + fn.argumentSnapshotCount;
	const traceable = new Uint8Array(fn.registerCount);
	const pending: Array<number> = [];
	const copies = new Array<Array<number> | undefined>(fn.registerCount);
	const constants = new Set(rematerializedConstantIps);
	const scalar = (register: number): boolean => {
		const rep = native.registerRepresentations[register];
		return rep === "number" || rep === "int32" || rep === "boolean";
	};
	const retain = (register: number): void => {
		if (traceable[register] !== 0 || scalar(register)) return;
		traceable[register] = 1;
		pending.push(register);
	};
	const immediate = (kind: number | undefined): boolean =>
		kind !== undefined &&
		compilerValueKindMaskIsSubset(
			kind,
			COMPILER_VALUE_KIND_NUMBER |
				COMPILER_VALUE_KIND_BOOLEAN |
				COMPILER_VALUE_KIND_NULLISH,
		);
	for (let register = 0; register < fn.registerCount; register++)
		if (
			register < entryCount ||
			borrowed.has(register) ||
			body.writeCounts[register] === 0
		)
			retain(register);
	for (const [ip, op] of native.body.instructions.entries()) {
		if (!body.isReachable(ip)) continue;
		for (const destination of body.writes[ip]!) {
			if (scalar(destination)) continue;
			// Multi-result helpers retain their separate output-ownership certificates.
			if (
				!("dst" in op) ||
				op.dst !== destination ||
				blocked.has(ip) ||
				(op.opcode !== "MOVE" && body.reads[ip]!.includes(destination))
			) {
				retain(destination);
				continue;
			}
			const facts = native.facts?.[ip];
			// Pooled literals have immovable runtime-image addresses, including through copies.
			if (constants.has(ip) || immediate(instructionResultKind(facts, destination)))
				continue;
			if (op.opcode === "MOVE") {
				if (op.src < 0 || immediate(instructionInputKind(facts, op.src))) continue;
				const destinations = (copies[op.src] ??= []);
				destinations.push(destination);
				continue;
			}
			if (
				op.opcode === "CREATE_NUMBER" ||
				op.opcode === "CREATE_F64" ||
				op.opcode === "CREATE_BOOLEAN" ||
				op.opcode === "CREATE_NULL" ||
				op.opcode === "CREATE_UNDEFINED" ||
				op.opcode === "CREATE_EMPTY"
			)
				continue;
			if (
				(op.opcode === "CALL_KNOWN" &&
					!op.construct &&
					op.argumentMode === undefined &&
					[COMPILER_VALUE_KIND_NUMBER, COMPILER_VALUE_KIND_BOOLEAN].includes(
						builtinNormalResultKinds(op.operation) ?? 0,
					)) ||
				((op.opcode === "UNARY" || op.opcode === "BINARY") &&
					immediateOperatorResult(
						op,
						native.registerRepresentations,
						native.instructions[ip],
						facts,
					))
			)
				continue;
			retain(destination);
		}
	}
	// A phi or copy cycle needs tracing if any incoming definition can hold a managed value.
	for (let cursor = 0; cursor < pending.length; cursor++)
		for (const destination of copies[pending[cursor]!] ?? []) retain(destination);
	for (let register = entryCount; register < fn.registerCount; register++)
		if (
			traceable[register] === 0 &&
			native.storageValues[register]! >= 0 &&
			!scalar(register)
		)
			registers.add(register);
	return registers;
}

const CONSERVATIVE_ROOT_STORAGE: Pick<
	NativeStoragePlan,
	| "rootRegisters"
	| "rootSlots"
	| "rootSlotCount"
	| "privateRegisters"
	| "privateCallResultIps"
	| "entryStableRootRegisters"
> = Object.freeze({
	rootRegisters: Object.freeze([]),
	rootSlots: Object.freeze([]),
	rootSlotCount: 0,
	privateRegisters: Object.freeze([]),
	privateCallResultIps: Object.freeze([]),
	entryStableRootRegisters: Object.freeze([]),
});

function rootStorage(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	fastPaths: NativeFastPathPlans,
	callTransports: ReadonlyArray<NativeCallTransportPlan>,
	rematerializedConstantIps: ReadonlyArray<number>,
	expressionIps: ReadonlyArray<number>,
	untracedResults: ReadonlySet<number>,
	gcCertificate = native.gc,
) {
	const fn = native.body;
	// Admitted expressions produce untraced scalars; pooled literals have immortal addresses.
	const rootFree = new Set(untracedResults);
	const resultOwnership = scalarStorageOwnership(
		native,
		body,
		nativeFastPathWindows(fastPaths),
		undefined,
		"result-lifetime",
	);
	for (const register of nativeUnobservedCallResultRegisters(
		native,
		body,
		resultOwnership.blocked,
		resultOwnership.borrowed,
	))
		rootFree.add(register);
	for (const ip of [...rematerializedConstantIps, ...expressionIps]) {
		const op = fn.instructions[ip]!;
		if (!("dst" in op)) throw new Error("Native expression lacks a destination");
		rootFree.add(op.dst);
	}
	const reachableRoots =
		native.gc === gcCertificate
			? undefined
			: new Set(native.gc.safepoints.flatMap((point) => point.rootRegisters));
	// The complete source certificate still validates polling in the original CFG.
	let roots = nativeFrameRootRegisters(fn, {
		registerRepresentations: native.registerRepresentations,
		gc: gcCertificate,
	}).filter(
		(local) =>
			(reachableRoots === undefined || reachableRoots.has(local)) &&
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
			[
				...fastPaths.propertyReadRegions,
				...fastPaths.propertyReadPairs,
				...fastPaths.numberRecordRegions,
				...fastPaths.numericLoopRegions,
				...fastPaths.arrayInitializations,
				...fastPaths.mapEntries,
				...fastPaths.objectEnumerationSnapshots,
				...fastPaths.spanContinuations,
			].flatMap((plan) => plan.borrowedRegisters),
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
		...selectNativeRootStorage(native, roots, privateLocals, calls, {
			registers: instructionLocalRoots(
				native,
				body,
				roots.filter((local) => !privateLocals.has(local)),
				[
					...borrowedPlans,
					...fastPaths.propertyReadRegions,
					...fastPaths.propertyReadPairs,
					...fastPaths.numberRecordRegions,
					...fastPaths.numericLoopRegions,
					...fastPaths.arrayInitializations,
					...fastPaths.mapEntries,
					...fastPaths.objectEnumerationSnapshots,
					...fastPaths.spanContinuations,
				],
				expressionIps,
			),
			facts: body,
		}),
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

const INSTRUCTION_LOCAL_PLAN_KINDS: ReadonlySet<string> = new Set([
	"call",
	"return-completion",
]);

/** Continuously rooted registers whose emitted storage accesses are their VM reads and writes. */
function instructionLocalRoots(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	continuous: ReadonlyArray<number>,
	borrowedPlans: ReadonlyArray<{ readonly borrowedRegisters: ReadonlyArray<number> }>,
	expressionIps: ReadonlyArray<number>,
): ReadonlySet<number> {
	const local = new Set(continuous);
	if (local.size === 0) return local;
	const fn = native.body;
	const regional = new Uint8Array(fn.instructions.length);
	for (const [ip, plan] of native.instructions.entries())
		if (plan !== undefined && !INSTRUCTION_LOCAL_PLAN_KINDS.has(plan.kind))
			regional[ip] = 1;
	for (const { ip } of native.regionActions) regional[ip] = 1;
	for (const region of native.specializations)
		for (const ip of region.claimedIps) regional[ip] = 1;
	for (const call of native.fieldCalls ?? [])
		for (let ip = call.allocationIp; ip <= call.callIp; ip++) regional[ip] = 1;
	for (const ip of nativeRecordCallIps(native)) regional[ip] = 1;
	// Expressions render at their consumer, after their operands' VM reads.
	for (const ip of expressionIps) regional[ip] = 1;
	for (let ip = 0; ip < regional.length; ip++) {
		if (regional[ip] === 0) continue;
		for (const register of body.reads[ip]!) local.delete(register);
		for (const register of body.writes[ip]!) local.delete(register);
	}
	for (const plan of borrowedPlans)
		for (const register of plan.borrowedRegisters) local.delete(register);
	return local;
}

function rootPublicationContinuations(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	windows: ReturnType<typeof nativeFastPathWindows>,
	exits: ReadonlyArray<number>,
): ReadonlyArray<number> {
	const fn = native.body;
	if (
		native.storageValues === undefined ||
		native.mode !== "direct" ||
		fn.isGenerator ||
		fn.isAsync
	)
		return [];
	const polls = new Set(native.gc.safepoints.map((point) => point.instructionIp));
	const loopPolls = new Set(
		native.gc.safepoints
			.filter((point) => point.kind === "loop-backedge")
			.map((point) => point.instructionIp),
	);
	const targets: Array<number> = [];
	for (const [target, sources] of body.branchSources) {
		const source = sources[0]!;
		const instruction = fn.instructions[source];
		if (
			sources.length === 1 &&
			source < target &&
			(instruction?.opcode === "JUMP" || instruction?.opcode === "JUMP_IF") &&
			body.predecessorCounts[target] === 1 &&
			!body.externalEntries.has(source) &&
			!body.externalEntries.has(target) &&
			!polls.has(source) &&
			!loopPolls.has(target)
		)
			targets.push(target);
	}
	if (targets.length === 0) return targets;
	const blocked = new Set<number>();
	const blockSpan = (ips: ReadonlyArray<number>): void => {
		if (ips.length === 0) return;
		let start = ips[0]!;
		let end = start;
		for (const ip of ips) {
			start = Math.min(start, ip);
			end = Math.max(end, ip);
		}
		for (let ip = start; ip <= end; ip++) blocked.add(ip);
	};
	// Selected helpers can carry hidden control and storage between sparse claims.
	for (const region of native.specializations)
		blockSpan([
			region.license.admission.anchorIp,
			...region.anchors,
			...region.claimedIps,
			...region.controlFlow.ordinaryBlockIps,
		]);
	for (const window of windows) blockSpan(window.claimedIps);
	// An admitted region is a second, unpublished edge into each place it continues.
	for (const exit of exits) blocked.add(exit);
	for (const action of native.regionActions) blocked.add(action.ip);
	for (const site of native.fieldCalls ?? []) blockSpan([site.allocationIp, site.callIp]);
	for (const ip of nativeRecordCallIps(native)) blockSpan([ip]);
	for (const site of native.literalSwitches ?? [])
		blockSpan([site.instructionIp, site.endIp]);
	return targets.filter(
		(target) => !blocked.has(body.branchSources.get(target)![0]!) && !blocked.has(target),
	);
}

function lowerStorage(
	native: NativeFunctionPlan,
	body: NativeStorageBodyFacts,
	preserveProfileSites = true,
	entry?: NativeDirectEntryPlan,
	entries: NativeEntryLookup = new Map(),
	suspension = lowerNativeSuspension(native, body),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	stackRoots: NativeStackRoots = "precise",
): NativeStoragePlan {
	const fn = native.body;
	const selection = analyzeNativeFastPaths(native, entry, stringConstants, body);
	const controlEntries = {
		externalGroups: nativeFastPathWindows(selection.plans, false).map(
			(window) => window.claimedIps,
		),
	};
	const controlFlow = selectNativeControlFlow(native, body, stringConstants, {
		constants: entry?.constantBooleans,
		...controlEntries,
	});
	body = projectStorageBodyFacts(native, body, controlFlow, controlEntries);
	const fastPaths = selection.refineForControlFlow(body.accesses);
	const expressionWindows = nativeFastPathWindows(fastPaths);
	const gcCertificate = native.gc;
	native = nativeControlFlowContract(native, controlFlow);
	const jumpTargets = body.jumpTargets;
	const uses = scalarStorageUses(body, suspension);
	const immutableOwnership = scalarStorageOwnership(native, body, expressionWindows);
	const ownership =
		suspension === undefined
			? immutableOwnership
			: scalarStorageOwnership(native, body, expressionWindows, suspension);
	const scalarStorage = (
		variant: NativeFunctionPlan,
		variantOwnership = variant === native
			? ownership
			: scalarStorageOwnership(variant, body, expressionWindows, suspension),
	) => {
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
		return {
			expressionIps: expressionIps(
				variant,
				body,
				jumpTargets,
				preserveProfileSites,
				variantOwnership,
			).filter((ip) => !constantIps.has(ip)),
			rematerializedConstantIps: constants,
		};
	};
	const callTransports = selectNativeCallTransports(native, entries);
	const scalar = scalarStorage(native);
	const directHeapObjectIps = selectNativeDirectHeapObjects(native);
	const roots =
		stackRoots === "conservative"
			? CONSERVATIVE_ROOT_STORAGE
			: rootStorage(
					native,
					body,
					fastPaths,
					callTransports,
					scalar.rematerializedConstantIps,
					scalar.expressionIps,
					untracedValueRegisters(
						native,
						body,
						// Fusion overlays preserve value kinds while blocking scalar rescheduling.
						native.specializations.some((region) => region.kind === "numeric-fusion")
							? scalarStorageOwnership(
									native,
									body,
									expressionWindows,
									suspension,
									"value-lifetime",
								)
							: ownership,
						scalar.rematerializedConstantIps,
					),
					gcCertificate,
				);
	const elidedPureIps = selectNativeUnusedValues(native, body, {
		...ownership,
		controlFlow,
		roots: roots.rootRegisters,
		numberPredicates: new Set(
			fastPaths.numberPredicates.map((plan) => plan.instructionIp),
		),
	});
	const unusedRegisters = selectNativeUnusedRegisters(native, body, {
		controlFlow,
		elidedPureIps,
		borrowed: ownership.borrowed,
		roots: roots.rootRegisters,
	});
	let numericWorker: NativeNumericWorkerPlan | undefined;
	if (
		entry !== undefined &&
		selectNumericWorker(native, entry, controlFlow, new Set(elidedPureIps))
	) {
		const worker = nativeNumericWorkerContract(native);
		const pollingIps = native.gc.safepoints.flatMap((point) =>
			point.kind === "loop-backedge" ? [point.instructionIp] : [],
		);
		const polls = new Set(pollingIps);
		const workerOwnership = scalarStorageOwnership(
			worker,
			body,
			expressionWindows,
			suspension,
		);
		numericWorker = {
			...scalarStorage(worker, workerOwnership),
			definitionInitializedRegisters: definitionInitializedRegisters(
				worker,
				body,
				jumpTargets,
				uses,
				workerOwnership,
			),
			pollingIps,
			fallthroughJumpIps: fn.instructions.flatMap((op, ip) =>
				op.opcode === "JUMP" && op.targetIp === ip + 1 && !polls.has(ip) ? [ip] : [],
			),
		};
	}

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
		stackRoots,
		...roots,
		rootPublicationContinuations:
			stackRoots === "conservative"
				? []
				: rootPublicationContinuations(native, body, expressionWindows, [
						...fastPaths.numberRecordRegions.map((plan) => plan.exitIp),
						...fastPaths.numericLoopRegions.flatMap((plan) => [
							plan.id,
							...plan.exits.map((exit) => exit.targetIp),
						]),
					]),
		...scalar,
		definitionInitializedRegisters: definitionInitializedRegisters(
			native,
			body,
			jumpTargets,
			uses,
			ownership,
			roots.privateRegisters,
		),
		numericWorker,
		elidedPureIps,
		unusedRegisters,
		stringComparisons: selectNativeStringComparisons(native, body, {
			controlFlow,
			...controlEntries,
			elided: new Set(elidedPureIps),
			stringLength: (index) => stringConstants[index]?.length,
		}),
		...(controlFlow === undefined ? {} : { controlFlow }),
	};
}

export function lowerNativeFunctionStorage(
	native: NativeFunctionPlan,
	entries: NativeEntryLookup = new Map(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	stackRoots: NativeStackRoots = "precise",
	functions: ReadonlyArray<BytecodeFunction> = [],
): NativeFunctionPlan {
	const body = storageBodyFacts(
		native,
		undefined,
		selectNativeCaptureAccess(native, functions),
	);
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
			stackRoots,
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
				stackRoots,
			),
		})),
	};
}

// Like verified execution programs, storage trust follows object identity: a replaced
// program or string table revalidates, and frozen function lists reject in-place swaps.
const certifiedNativeStorage = new WeakMap<
	ProgramImage["native"],
	ReadonlyArray<ReadonlyArray<number>>
>();

function certifyNativeStorage(
	native: ProgramImage["native"],
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	Object.freeze(native.functions);
	Object.freeze(native);
	certifiedNativeStorage.set(native, stringConstants);
}

export function lowerNativeStorage(
	image: ProgramImage,
	stackRoots: NativeStackRoots = "precise",
): ProgramImage {
	const entries = nativeEntryLookup(image.native.functions);
	const native = {
		...image.native,
		functions: image.native.functions.map((native) =>
			lowerNativeFunctionStorage(
				native,
				entries,
				image.runtime.stringConstants,
				stackRoots,
				image.runtime.functions,
			),
		),
	};
	certifyNativeStorage(native, image.runtime.stringConstants);
	return { ...image, native };
}

/** Validate every storage plan of a program unless this exact program already passed. */
export function validateNativeProgramStorage(
	native: ProgramImage["native"],
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
): void {
	if (certifiedNativeStorage.get(native) === stringConstants) return;
	const entries = nativeEntryLookup(native.functions);
	const functions = native.functions.map((fn) => fn.body);
	for (const fn of native.functions)
		validateNativeStorage(fn, entries, stringConstants, functions);
	certifyNativeStorage(native, stringConstants);
}

export function validateNativeStorage(
	native: NativeFunctionPlan,
	entries: NativeEntryLookup = new Map(),
	stringConstants: ReadonlyArray<ReadonlyArray<number>> = [],
	functions: ReadonlyArray<BytecodeFunction> = [],
): void {
	validateNativeInstructionFacts(native.body, native.facts, native.instructions);
	// Recompute body facts at this trust boundary; callers can replace or mutate an image.
	const body = storageBodyFacts(
		native,
		undefined,
		selectNativeCaptureAccess(native, functions),
	);
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

	const sameRecordRegions = (
		stored: ReadonlyArray<NativeNumberRecordRegionPlan>,
		selected: ReadonlyArray<NativeNumberRecordRegionPlan>,
	): boolean =>
		stored.length === selected.length &&
		stored.every((plan, index) => {
			const expected = selected[index]!;
			return (
				plan.id === expected.id &&
				plan.object === expected.object &&
				plan.exitIp === expected.exitIp &&
				plan.fallback === expected.fallback &&
				plan.fields.length === expected.fields.length &&
				plan.fields.every(
					(field, i) =>
						field.stringIndex === expected.fields[i]!.stringIndex &&
						field.icIndex === expected.fields[i]!.icIndex &&
						field.stored === expected.fields[i]!.stored,
				) &&
				sameNumbers(plan.inputs, expected.inputs) &&
				sameNumbers(plan.outputs, expected.outputs) &&
				sameNumbers(plan.claimedIps, expected.claimedIps) &&
				sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters)
			);
		});

	const sameNumericLoops = (
		stored: ReadonlyArray<NativeNumericLoopRegionPlan>,
		selected: ReadonlyArray<NativeNumericLoopRegionPlan>,
	): boolean =>
		stored.length === selected.length &&
		stored.every((plan, index) => {
			const expected = selected[index]!;
			return (
				plan.kind === expected.kind &&
				(plan.kind !== "array-iteration" ||
					(expected.kind === "array-iteration" &&
						plan.initializeIp === expected.initializeIp &&
						plan.iterator === expected.iterator &&
						(plan.records ?? []).join() === (expected.records ?? []).join())) &&
				(plan.kind !== "fixed-numeric" ||
					(expected.kind === "fixed-numeric" &&
						plan.counter?.index === expected.counter?.index &&
						plan.counter?.bound === expected.counter?.bound &&
						plan.counter?.boundObject === expected.counter?.boundObject &&
						plan.counter?.comparison === expected.counter?.comparison &&
						plan.counter?.limitOffset === expected.counter?.limitOffset &&
						plan.counter?.stride === expected.counter?.stride &&
						(plan.records ?? []).join() === (expected.records ?? []).join() &&
						plan.views.length === expected.views.length &&
						plan.views.every(
							(view, i) =>
								view.object === expected.views[i]!.object &&
								view.writable === expected.views[i]!.writable &&
								view.minOffset === expected.views[i]!.minOffset &&
								view.maxOffset === expected.views[i]!.maxOffset &&
								view.checked === expected.views[i]!.checked &&
								view.text === expected.views[i]!.text &&
								view.byteScale === expected.views[i]!.byteScale,
						) &&
						(plan.dataViewCalls?.length ?? 0) === (expected.dataViewCalls?.length ?? 0) &&
						(plan.dataViewCalls ?? []).every(
							(call, i) =>
								call.ip === expected.dataViewCalls![i]!.ip &&
								call.set === expected.dataViewCalls![i]!.set &&
								call.type === expected.dataViewCalls![i]!.type,
						))) &&
				plan.id === expected.id &&
				plan.entryIp === expected.entryIp &&
				plan.fallback === expected.fallback &&
				sameNumbers(plan.inputs, expected.inputs) &&
				sameNumbers(plan.carried, expected.carried) &&
				plan.exits.length === expected.exits.length &&
				plan.exits.every(
					(exit, i) =>
						exit.targetIp === expected.exits[i]!.targetIp &&
						sameNumbers(exit.outputs, expected.exits[i]!.outputs),
				) &&
				sameNumbers(plan.claimedIps, expected.claimedIps) &&
				sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters)
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
			stored.stackRoots === selected.stackRoots &&
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
					plan.arity === expected.arity
				);
			}) &&
			stored.numberPredicates.length === selected.numberPredicates.length &&
			stored.numberPredicates.every(
				(plan, index) =>
					plan.instructionIp === selected.numberPredicates[index]!.instructionIp &&
					plan.mode === selected.numberPredicates[index]!.mode,
			) &&
			stored.spanContinuations.length === selected.spanContinuations.length &&
			stored.spanContinuations.every((plan, index) => {
				const expected = selected.spanContinuations[index]!;
				return (
					plan.producerIp === expected.producerIp &&
					plan.sourceKind === expected.sourceKind &&
					plan.sourceCallIp === expected.sourceCallIp &&
					plan.rangeOperation === expected.rangeOperation &&
					sameNumbers(plan.claimedIps, expected.claimedIps) &&
					sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters) &&
					plan.consumers.length === expected.consumers.length &&
					plan.consumers.every((consumer, i) => {
						const value = expected.consumers[i]!;
						return (
							consumer.ip === value.ip &&
							consumer.value === value.value &&
							consumer.kind === value.kind
						);
					})
				);
			}) &&
			stored.arrayInitializations.length === selected.arrayInitializations.length &&
			stored.arrayInitializations.every((plan, index) => {
				const expected = selected.arrayInitializations[index]!;
				return (
					plan.allocationIp === expected.allocationIp &&
					plan.mode === expected.mode &&
					sameNumbers(plan.stores, expected.stores) &&
					sameNumbers(plan.values, expected.values) &&
					sameNumbers(plan.claimedIps, expected.claimedIps) &&
					sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters)
				);
			}) &&
			stored.mapEntries.length === selected.mapEntries.length &&
			stored.mapEntries.every((plan, index) => {
				const expected = selected.mapEntries[index]!;
				return (
					plan.getIp === expected.getIp &&
					plan.setIp === expected.setIp &&
					sameNumbers(plan.claimedIps, expected.claimedIps) &&
					sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters)
				);
			}) &&
			stored.objectEnumerationSnapshots.length ===
				selected.objectEnumerationSnapshots.length &&
			stored.objectEnumerationSnapshots.every((plan, index) => {
				const expected = selected.objectEnumerationSnapshots[index]!;
				return (
					plan.callIp === expected.callIp &&
					plan.kind === expected.kind &&
					sameNumbers(plan.lengthIps, expected.lengthIps) &&
					sameNumbers(plan.elementIps, expected.elementIps) &&
					plan.fallback === expected.fallback &&
					sameNumbers(plan.claimedIps, expected.claimedIps) &&
					sameNumbers(plan.borrowedRegisters, expected.borrowedRegisters)
				);
			}) &&
			nativeStringTransformPlansMatch(
				stored.stringTransforms,
				selected.stringTransforms,
			) &&
			sameProjections(stored.propertyProjections, selected.propertyProjections) &&
			sameUpdates(stored.propertyNumericUpdates, selected.propertyNumericUpdates) &&
			sameReadRegions(stored.propertyReadRegions, selected.propertyReadRegions) &&
			sameRecordRegions(stored.numberRecordRegions, selected.numberRecordRegions) &&
			sameNumericLoops(stored.numericLoopRegions, selected.numericLoopRegions) &&
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
					"rootPublicationContinuations",
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
		const stackRoots = variant.storage.stackRoots;
		const suspension = lowerNativeSuspension(variant, body);
		const selected = lowerStorage(
			variant,
			body,
			false,
			entry,
			entries,
			suspension,
			stringConstants,
			stackRoots,
		);
		const projected = projectStorageBodyFacts(variant, body, selected.controlFlow, {
			externalGroups: nativeFastPathWindows(selected, false).map(
				(window) => window.claimedIps,
			),
		});
		if (!sameScalar(variant.storage, selected)) return false;
		if (!sameNumbers(variant.storage.elidedPureIps, selected.elidedPureIps)) return false;
		if (!sameNumbers(variant.storage.unusedRegisters, selected.unusedRegisters))
			return false;
		if (
			variant.storage.stringComparisons.length !== selected.stringComparisons.length ||
			variant.storage.stringComparisons.some((plan, index) => {
				const expected = selected.stringComparisons[index]!;
				return (
					plan.instructionIp !== expected.instructionIp ||
					plan.operand !== expected.operand ||
					plan.length !== expected.length ||
					plan.kind !== expected.kind
				);
			})
		)
			return false;
		if (!nativeControlFlowPlansMatch(variant.storage.controlFlow, selected.controlFlow))
			return false;
		const reachable = nativeControlFlowContract(variant, selected.controlFlow);
		if (stackRoots === "precise") {
			validateNativeRootStorage(
				reachable,
				variant.storage.rootRegisters,
				variant.storage,
				{
					privateRegisters: new Set(variant.storage.privateRegisters),
					facts: projected,
				},
			);
		}
		if (
			!sameNumbers(variant.storage.expressionIps, selected.expressionIps) &&
			!sameNumbers(
				variant.storage.expressionIps,
				expressionIps(
					variant,
					projected,
					projected.jumpTargets,
					false,
					scalarStorageOwnership(
						variant,
						projected,
						nativeFastPathWindows(selected),
						suspension,
					),
					new Set(variant.storage.expressionIps),
				),
			)
		)
			return false;
		const retained =
			stackRoots === "conservative" ||
			(sameNumbers(
				variant.storage.rematerializedConstantIps,
				selected.rematerializedConstantIps,
			) &&
				sameNumbers(variant.storage.expressionIps, selected.expressionIps))
				? selected
				: {
						...selected,
						...rootStorage(
							reachable,
							projected,
							selected,
							selected.callTransports,
							variant.storage.rematerializedConstantIps,
							variant.storage.expressionIps,
							untracedValueRegisters(
								reachable,
								projected,
								scalarStorageOwnership(
									variant,
									projected,
									nativeFastPathWindows(selected),
									suspension,
									"value-lifetime",
								),
								variant.storage.rematerializedConstantIps,
							),
							variant.gc,
						),
					};
		// Retained scalar schedules can add roots; their slot writes remain mandatory.
		const retainedRoots = new Set(retained.rootRegisters);
		if (variant.storage.unusedRegisters.some((register) => retainedRoots.has(register)))
			return false;
		if (
			variant.storage.elidedPureIps.some((ip) => {
				const op = variant.body.instructions[ip]!;
				return "dst" in op && retainedRoots.has(op.dst);
			})
		)
			return false;
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
	compilerNumericResultKind,
	COMPILER_NUMERIC_UNARY_OPERATORS,
	COMPILER_NUMERIC_BINARY_OPERATORS,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_NULLISH,
} from "../shared/compiler-value-kinds.ts";
