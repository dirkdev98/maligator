import {
	COMPILER_NUMERIC_BINARY_OPERATORS,
	COMPILER_NUMERIC_UNARY_OPERATORS,
} from "../shared/compiler-value-kinds.ts";
import type { NativeRecordIterationFlow } from "./native-record-iteration.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";
import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
	vmExceptionHandlerTargets,
} from "./runtime-image.ts";

const NUMBER = 1,
	BOOLEAN = 2,
	NULLISH = 4,
	FRESH = 8,
	UNKNOWN = 16;
const PRIMITIVE = NUMBER | BOOLEAN | NULLISH;

function successors(op: BytecodeInstruction, ip: number): ReadonlyArray<number> {
	return op.opcode === "RETURN" || op.opcode === "THROW"
		? []
		: op.opcode === "JUMP"
			? [op.targetIp]
			: op.opcode === "JUMP_IF"
				? [op.targetIp, ip + 1]
				: [ip + 1];
}

function acyclicOrder(fn: BytecodeFunction): ReadonlyArray<number> | undefined {
	const state = new Uint8Array(fn.instructions.length);
	const order: Array<number> = [];
	const visit = (ip: number): boolean => {
		if (ip < 0 || ip >= state.length || state[ip] === 1) return false;
		if (state[ip] === 2) return true;
		state[ip] = 1;
		for (const next of successors(fn.instructions[ip]!, ip))
			if (!visit(next)) return false;
		state[ip] = 2;
		order.push(ip);
		return true;
	};
	return visit(0) ? order.reverse() : undefined;
}

/** Each successful invocation returns a graph containing only its own allocations. */
export function nativeMapperReturnsFreshGraph(fn: BytecodeFunction): boolean {
	if (
		!fn.strict ||
		fn.isAsync ||
		fn.isGenerator ||
		fn.needsArguments ||
		fn.capturedCount !== 0 ||
		(fn.closureCaptureOwners?.length ?? 0) !== 0 ||
		fn.parameterCount > 2 ||
		fn.handlers.length !== 0 ||
		fn.instructions.length > 128 ||
		fn.registerCount > 128
	)
		return false;
	const order = acyclicOrder(fn);
	if (order === undefined) return false;
	const initial = Array<number>(fn.registerCount).fill(NULLISH);
	if (fn.parameterCount > 0) initial[0] = UNKNOWN;
	if (fn.parameterCount > 1) initial[1] = NUMBER;
	const incoming = new Map<number, Array<number>>([[0, initial]]);
	let returned = false;
	for (const ip of order) {
		const state = incoming.get(ip)!.slice();
		const op = fn.instructions[ip]!;
		const numeric = (r: number) => (state[r]! & ~NUMBER) === 0;
		let mask: number | undefined;
		switch (op.opcode) {
			case "CREATE_NUMBER":
			case "CREATE_F64":
				mask = NUMBER;
				break;
			case "CREATE_BOOLEAN":
				mask = BOOLEAN;
				break;
			case "CREATE_NULL":
			case "CREATE_UNDEFINED":
				mask = NULLISH;
				break;
			case "MOVE":
				mask = state[op.src];
				break;
			case "CREATE_OBJECT_SHAPED":
				if (op.valueRegisters.some((r) => (state[r]! & ~(PRIMITIVE | FRESH)) !== 0))
					return false;
				mask = FRESH;
				break;
			case "BINARY":
				if (!numeric(op.left) || !numeric(op.right)) return false;
				if (COMPILER_NUMERIC_BINARY_OPERATORS.has(op.operator)) mask = NUMBER;
				else if (["===", "!==", "==", "!=", "<", "<=", ">", ">="].includes(op.operator))
					mask = BOOLEAN;
				else return false;
				break;
			case "UNARY":
				if (!numeric(op.src) || !COMPILER_NUMERIC_UNARY_OPERATORS.has(op.operator))
					return false;
				mask = op.operator === "!" ? BOOLEAN : NUMBER;
				break;
			case "JUMP_IF":
				if ((state[op.cond]! & ~PRIMITIVE) !== 0) return false;
				break;
			case "JUMP":
				break;
			case "RETURN":
				if (state[op.value] !== FRESH) return false;
				returned = true;
				break;
			default:
				return false;
		}
		if (mask !== undefined && "dst" in op) state[op.dst] = mask;
		for (const next of successors(op, ip)) {
			const previous = incoming.get(next);
			incoming.set(
				next,
				previous === undefined ? state.slice() : previous.map((v, r) => v | state[r]!),
			);
		}
	}
	return returned;
}

/**
 * How a record loop's columns know the traversed graph private: the locked world proves
 * `Array.from` exact, while mutable primordials leave the `Array.from` call at
 * `checkedProducer`, whose callee and receiver the function compares with the
 * realm's own before calling it.
 */
export interface NativeRecordColumnsPrivacy {
	readonly checkedProducer?: number;
}

/** Column writes stay private until an explicit fallback writes them back to the heap. */
export function nativeRecordGraphIsPrivate(
	fn: BytecodeFunction,
	functions: ReadonlyArray<BytecodeFunction>,
	initializeIp: number,
	claimedIps: ReadonlyArray<number>,
	flow: NativeRecordIterationFlow,
): NativeRecordColumnsPrivacy | undefined {
	const init = fn.instructions[initializeIp];
	if (init?.opcode !== "GET_ITERATOR" || fn.instructions.length > 512) return undefined;
	const handlers = vmExceptionHandlerTargets(fn.instructions.length, fn.handlers);
	const next = (ip: number) => [
		...successors(fn.instructions[ip]!, ip),
		...(handlers[ip] === undefined ? [] : [handlers[ip]]),
	];
	// An exceptional edge leaves its instruction before that instruction's write.
	const predecessors = new Map<number, Array<{ ip: number; thrown: boolean }>>();
	for (const ip of fn.instructions.keys())
		for (const [index, successor] of next(ip).entries()) {
			const list = predecessors.get(successor) ?? [];
			list.push({ ip, thrown: index >= successors(fn.instructions[ip]!, ip).length });
			predecessors.set(successor, list);
		}
	// The one write of `r` that every path into `ip` last performs.
	const definition = (r: number, ip: number): number | undefined => {
		const found = new Set<number>();
		const visited = new Set<string>();
		const pending = [...(predecessors.get(ip) ?? [])];
		if (ip === 0 || pending.length === 0) return undefined;
		while (pending.length > 0) {
			const at = pending.pop()!;
			const key = `${at.ip}:${at.thrown}`;
			if (visited.has(key)) continue;
			visited.add(key);
			if (
				!at.thrown &&
				vmInstructionWriteRegisters(fn.instructions[at.ip]!).includes(r)
			) {
				found.add(at.ip);
				continue;
			}
			const incoming = predecessors.get(at.ip) ?? [];
			if (at.ip === 0 || incoming.length === 0) return undefined;
			pending.push(...incoming);
		}
		return found.size === 1 ? [...found][0] : undefined;
	};
	const reaches = (starts: ReadonlyArray<number>, target: number, blocked = -1) => {
		const visited = new Set<number>();
		const pending = [...starts];
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (ip === blocked || visited.has(ip) || fn.instructions[ip] === undefined)
				continue;
			if (ip === target) return true;
			visited.add(ip);
			pending.push(...next(ip));
		}
		return false;
	};
	const producerIp = definition(init.source, initializeIp);
	if (producerIp === undefined) return undefined;
	const producer = fn.instructions[producerIp]!;
	let receiverIp: number | undefined;
	let checkedProducer: number | undefined;
	if (
		producer.opcode === "CALL_KNOWN" &&
		producer.operation === "Array.from" &&
		!producer.construct &&
		producer.argumentMode === undefined &&
		producer.argumentCount === 2
	) {
		receiverIp = definition(producer.thisValue, producerIp);
		const receiver = receiverIp === undefined ? undefined : fn.instructions[receiverIp];
		if (receiver?.opcode !== "LOAD_INTRINSIC" || receiver.intrinsic !== "Array")
			return undefined;
	} else if (producer.opcode === "CALL" && producer.argumentCount === 2) {
		// Only the runtime comparison proves this call the realm's `Array.from`; the
		// loads just keep both values fixed between the comparison and the call.
		const calleeIp = definition(producer.callee, producerIp);
		const callee = calleeIp === undefined ? undefined : fn.instructions[calleeIp];
		receiverIp = definition(producer.thisValue, producerIp);
		const receiver = receiverIp === undefined ? undefined : fn.instructions[receiverIp];
		if (
			callee?.opcode !== "LOAD_PROPERTY_STATIC" ||
			callee.object !== producer.thisValue ||
			definition(callee.object, calleeIp!) !== receiverIp ||
			receiver?.opcode !== "LOAD_GLOBAL_PROPERTY"
		)
			return undefined;
		checkedProducer = producerIp;
	} else return undefined;
	const callbackIp = definition(producer.arguments[1]!, producerIp);
	const callback = callbackIp === undefined ? undefined : fn.instructions[callbackIp];
	if (callback?.opcode !== "CREATE_FUNCTION") return undefined;
	const mapper = functions[callback.functionIndex];
	if (mapper === undefined || !nativeMapperReturnsFreshGraph(mapper)) return undefined;
	// The allocation dominates every traversal and cannot repeat, including through catches.
	if (
		reaches([0], initializeIp, producerIp) ||
		reaches(next(producerIp), producerIp) ||
		reaches([0], producerIp, receiverIp) ||
		reaches([0], producerIp, callbackIp)
	)
		return undefined;
	// Nothing but the traversal reads the allocation through the register it defines.
	const visited = new Set<number>();
	const pending = [...next(producerIp)];
	while (pending.length > 0) {
		const ip = pending.pop()!;
		const op = fn.instructions[ip];
		if (visited.has(ip) || op === undefined) continue;
		visited.add(ip);
		if (ip !== initializeIp && vmInstructionReadRegisters(op).includes(init.source))
			return undefined;
		if (!vmInstructionWriteRegisters(op).includes(init.source)) pending.push(...next(ip));
	}
	const members = new Set(claimedIps);
	for (const [ip, op] of fn.instructions.entries())
		for (const r of [
			...vmInstructionReadRegisters(op),
			...vmInstructionWriteRegisters(op),
		])
			if (flow.references.has(r) && !members.has(ip)) return undefined;
	return checkedProducer === undefined ? {} : { checkedProducer };
}
