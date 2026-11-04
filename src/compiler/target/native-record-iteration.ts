import {
	COMPILER_VALUE_KIND_BOOLEAN as BOOLEAN,
	COMPILER_VALUE_KIND_NULL as NULL,
	COMPILER_VALUE_KIND_NULLISH as NULLISH,
	COMPILER_VALUE_KIND_NUMBER as NUMBER,
	COMPILER_VALUE_KIND_OBJECT as OBJECT,
	COMPILER_VALUE_KIND_UNDEFINED as UNDEFINED,
	COMPILER_NUMERIC_BINARY_OPERATORS,
	COMPILER_NUMERIC_UNARY_OPERATORS,
} from "../shared/compiler-value-kinds.ts";
import type { VmRegisterRepresentation } from "./program-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
	DecodedVmValueOperand,
} from "./runtime-image.ts";
import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";

/** Preflight admits every field before stores; Number-only writes preserve its slot handles. */
export interface NativeRecordIterationGraph {
	readonly references: ReadonlyArray<{
		readonly register: number;
		readonly field: number;
		readonly nullable: boolean;
	}>;
	readonly fields: ReadonlyArray<{
		readonly object: number;
		readonly instructionIp: number;
		readonly kind: "number" | "boolean" | "reference";
		readonly stored: boolean;
	}>;
}

export interface NativeRecordIterationBuiltin {
	readonly operation: string;
	readonly resultKind: "number" | "boolean";
	readonly arguments: ReadonlyArray<
		Extract<DecodedVmValueOperand, { kind: "number" | "register" }>
	>;
}

export type NativeRecordIterationBuiltinQuery = (
	op: BytecodeInstruction,
) => NativeRecordIterationBuiltin | undefined;

export interface NativeRecordIterationFlow {
	readonly graph: NativeRecordIterationGraph;
	readonly references: ReadonlyMap<number, number>;
	readonly fields: ReadonlyMap<number, number>;
	readonly kinds: ReadonlyMap<number, number>;
	readonly states: ReadonlyMap<number, ReadonlyMap<number, number>>;
	readonly inputs: ReadonlySet<number>;
	readonly written: ReadonlySet<number>;
	readonly assigned: ReadonlyMap<number, ReadonlySet<number>>;
}

export function recordIterationNullishTest(
	op: BytecodeInstruction,
	state: ReadonlyMap<number, number>,
): { register: number; mask: number; equal: boolean } | undefined {
	if (op.opcode !== "BINARY" || !["==", "!=", "===", "!=="].includes(op.operator))
		return undefined;
	for (const [value, constant] of [
		[op.left, op.right],
		[op.right, op.left],
	]) {
		const mask = state.get(constant!);
		if (mask !== NULL && mask !== UNDEFINED) continue;
		return {
			register: value!,
			mask: op.operator.length === 2 ? NULLISH : mask,
			equal: op.operator[0] === "=",
		};
	}
	return undefined;
}

function successors(op: BytecodeInstruction, ip: number): Array<number> {
	return op.opcode === "JUMP"
		? [op.targetIp]
		: op.opcode === "JUMP_IF"
			? [op.targetIp, ip + 1]
			: [ip + 1];
}

export function analyzeRecordIteration(
	fn: BytecodeFunction,
	order: ReadonlyArray<number>,
	element: number,
	representations: ReadonlyArray<VmRegisterRepresentation>,
	builtin: NativeRecordIterationBuiltinQuery,
): NativeRecordIterationFlow | undefined {
	if (order.length > 128) return undefined;
	const writers = new Map<number, Array<number>>();
	const uses = new Map<number, Array<number>>();
	for (const ip of order) {
		const op = fn.instructions[ip]!;
		for (const register of vmInstructionWriteRegisters(op)) {
			const list = writers.get(register) ?? [];
			list.push(ip);
			writers.set(register, list);
		}
		for (const register of vmInstructionReadRegisters(op)) {
			const list = uses.get(register) ?? [];
			list.push(ip);
			uses.set(register, list);
		}
	}
	const needed = new Set<number>([element]);
	for (const ip of order) {
		const op = fn.instructions[ip]!;
		if (op.opcode === "LOAD_PROPERTY_STATIC" || op.opcode === "STORE_PROPERTY_STATIC")
			needed.add(op.object);
	}
	const references = new Map<number, number>();
	const nodes: Array<NativeRecordIterationGraph["references"][number]> = [];
	const fields: Array<NativeRecordIterationGraph["fields"][number]> = [];
	const fieldIps = new Map<number, number>();
	const byProperty = new Map<string, number>();
	const pending = new Set<number>();
	const addReference = (register: number): number | undefined => {
		const known = references.get(register);
		if (known !== undefined) return known;
		if (
			pending.has(register) ||
			nodes.length >= 16 ||
			writers.get(register)?.length !== 1
		)
			return undefined;
		pending.add(register);
		const ip = writers.get(register)![0]!;
		const op = fn.instructions[ip]!;
		let node: number | undefined;
		if (register === element && op.opcode === "ITERATOR_STEP") {
			node = nodes.length;
			nodes.push({ register, field: -1, nullable: false });
		} else if (op.opcode === "MOVE") node = addReference(op.src);
		else if (op.opcode === "LOAD_PROPERTY_STATIC") {
			const parent = addReference(op.object);
			if (parent === undefined) return undefined;
			const key = `${parent}:${op.stringIndex}`;
			let field = byProperty.get(key);
			if (field === undefined) {
				field = fields.length;
				fields.push({
					object: parent,
					instructionIp: ip,
					kind: "reference",
					stored: false,
				});
				byProperty.set(key, field);
			}
			if (fields[field]!.kind !== "reference") return undefined;
			node = nodes.findIndex((entry) => entry.field === field);
			if (node < 0) {
				node = nodes.length;
				nodes.push({ register, field, nullable: false });
			}
		}
		pending.delete(register);
		if (node !== undefined) references.set(register, node);
		return node;
	};
	for (const register of needed)
		if (addReference(register) === undefined) return undefined;
	if (nodes.length === 0 || nodes.length > 16) return undefined;
	// A copy of a reference retains its node even when it is only compared with nullish.
	for (let changed = true; changed;) {
		changed = false;
		for (const ip of order) {
			const op = fn.instructions[ip]!;
			if (op.opcode !== "MOVE" || !references.has(op.src) || references.has(op.dst))
				continue;
			if (writers.get(op.dst)?.length !== 1) return undefined;
			references.set(op.dst, references.get(op.src)!);
			changed = true;
		}
	}
	const nullishRegisters = new Set(
		order.flatMap((ip) => {
			const op = fn.instructions[ip]!;
			return op.opcode === "CREATE_NULL" || op.opcode === "CREATE_UNDEFINED"
				? [op.dst]
				: [];
		}),
	);
	for (const [register, node] of references) {
		for (const ip of uses.get(register) ?? []) {
			const op = fn.instructions[ip]!;
			if (
				(op.opcode === "LOAD_PROPERTY_STATIC" || op.opcode === "STORE_PROPERTY_STATIC") &&
				op.object === register &&
				!vmInstructionWriteRegisters(op).includes(register)
			)
				continue;
			if (
				op.opcode === "REQUIRE_COERCIBLE" ||
				(op.opcode === "MOVE" && references.has(op.dst))
			)
				continue;
			if (
				op.opcode === "BINARY" &&
				["==", "!=", "===", "!=="].includes(op.operator) &&
				nullishRegisters.has(op.left === register ? op.right : op.left)
			) {
				if (node === 0) return undefined;
				nodes[node] = { ...nodes[node]!, nullable: true };
				continue;
			}
			return undefined;
		}
	}
	const onlyBooleanUses = (register: number, seen = new Set<number>()): boolean => {
		if (seen.has(register)) return false;
		seen.add(register);
		const ips = uses.get(register) ?? [];
		return (
			ips.length > 0 &&
			ips.every((ip) => {
				const op = fn.instructions[ip]!;
				return (
					(op.opcode === "JUMP_IF" && op.cond === register) ||
					(op.opcode === "UNARY" && op.operator === "!") ||
					(op.opcode === "MOVE" && onlyBooleanUses(op.dst, seen))
				);
			})
		);
	};
	for (const ip of order) {
		const op = fn.instructions[ip]!;
		if (op.opcode !== "LOAD_PROPERTY_STATIC" && op.opcode !== "STORE_PROPERTY_STATIC")
			continue;
		const object = references.get(op.object);
		if (object === undefined) return undefined;
		const key = `${object}:${op.stringIndex}`;
		const stored = op.opcode === "STORE_PROPERTY_STATIC";
		const kind = stored
			? "number"
			: references.has(op.dst)
				? "reference"
				: onlyBooleanUses(op.dst)
					? "boolean"
					: "number";
		let field = byProperty.get(key);
		if (field === undefined) {
			field = fields.length;
			fields.push({ object, instructionIp: ip, kind, stored });
			byProperty.set(key, field);
		} else {
			const previous = fields[field]!;
			if (previous.kind !== kind) return undefined;
			if (stored) fields[field] = { ...previous, instructionIp: ip, stored: true };
		}
		fieldIps.set(ip, field);
	}
	if (fields.length === 0 || fields.length > 32) return undefined;
	const kinds = new Map<number, number>();
	const states = new Map<number, Map<number, number>>([[order[0]!, new Map()]]);
	const assigned = new Map<number, Set<number>>([[order[0]!, new Set()]]);
	const inputs = new Set<number>();
	const written = new Set<number>();
	const intrinsic = new Set<number>();
	const predicates = new Map<
		number,
		{ register: number; mask: number; equal: boolean }
	>();
	const note = (register: number, mask: number) =>
		kinds.set(register, (kinds.get(register) ?? 0) | mask);
	const join = (ip: number, state: Map<number, number>, defined: Set<number>) => {
		const prior = states.get(ip);
		if (prior === undefined) {
			states.set(ip, new Map(state));
			assigned.set(ip, new Set(defined));
			return;
		}
		for (const [register, mask] of prior) {
			const next = state.get(register);
			if (next === undefined) prior.delete(register);
			else prior.set(register, mask | next);
		}
		for (const register of assigned.get(ip)!)
			if (!defined.has(register)) assigned.get(ip)!.delete(register);
	};
	for (const ip of order) {
		const before = states.get(ip);
		if (before === undefined) return undefined;
		const state = new Map(before),
			defined = new Set(assigned.get(ip));
		const op = fn.instructions[ip]!;
		const read = (register: number, expected?: number): number | undefined => {
			if (intrinsic.has(register)) return undefined;
			let mask = state.get(register);
			if (mask === undefined) {
				if (references.has(register)) return undefined;
				const rep = representations[register];
				mask =
					rep === "number" || rep === "int32"
						? NUMBER
						: rep === "boolean"
							? BOOLEAN
							: rep === "boxed"
								? expected
								: undefined;
				if (mask !== NUMBER && mask !== BOOLEAN) return undefined;
				inputs.add(register);
				state.set(register, mask);
			}
			note(register, mask);
			return mask !== 0 && (expected === undefined || (mask & ~expected) === 0)
				? mask
				: undefined;
		};
		const write = (register: number, mask: number) => {
			for (const [condition, predicate] of predicates)
				if (predicate.register === register) predicates.delete(condition);
			state.set(register, mask);
			defined.add(register);
			written.add(register);
			note(register, mask);
		};
		let ok = true;
		const numeric = builtin(op);
		if (numeric !== undefined) {
			ok = numeric.arguments.every(
				(argument) =>
					argument.kind === "number" || read(argument.register, NUMBER) !== undefined,
			);
			write(
				(op as { dst: number }).dst,
				numeric.resultKind === "number" ? NUMBER : BOOLEAN,
			);
		} else
			switch (op.opcode) {
				case "ITERATOR_STEP":
					if (op.valueDst !== element || ip !== order[0]) return undefined;
					write(op.valueDst, OBJECT);
					write(op.doneDst, BOOLEAN);
					break;
				case "LOAD_PROPERTY_STATIC": {
					ok = read(op.object, OBJECT) !== undefined;
					const field = fields[fieldIps.get(ip)!]!;
					const node = references.get(op.dst);
					write(
						op.dst,
						field.kind === "number"
							? NUMBER
							: field.kind === "boolean"
								? BOOLEAN
								: OBJECT | (nodes[node!]!.nullable ? NULLISH : 0),
					);
					break;
				}
				case "STORE_PROPERTY_STATIC":
					ok =
						read(op.object, OBJECT) !== undefined && read(op.value, NUMBER) !== undefined;
					break;
				case "REQUIRE_COERCIBLE":
					ok = read(op.src, OBJECT) !== undefined;
					break;
				case "CREATE_NUMBER":
				case "CREATE_F64":
					write(op.dst, NUMBER);
					break;
				case "CREATE_BOOLEAN":
					write(op.dst, BOOLEAN);
					break;
				case "CREATE_NULL":
					write(op.dst, NULL);
					break;
				case "CREATE_UNDEFINED":
					write(op.dst, UNDEFINED);
					break;
				case "LOAD_INTRINSIC":
					if (op.intrinsic !== "Math" || kinds.has(op.dst)) return undefined;
					intrinsic.add(op.dst);
					break;
				case "MOVE": {
					const mask = read(op.src);
					ok = mask !== undefined;
					if (mask !== undefined) write(op.dst, mask);
					break;
				}
				case "BINARY": {
					const test = recordIterationNullishTest(op, state);
					if (test !== undefined) {
						if (writers.get(op.dst)?.length !== 1) return undefined;
						ok = read(test.register) !== undefined;
						write(op.dst, BOOLEAN);
						if (op.dst !== test.register) predicates.set(op.dst, test);
					} else {
						ok =
							(COMPILER_NUMERIC_BINARY_OPERATORS.has(op.operator) ||
								["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(op.operator)) &&
							read(op.left, NUMBER) !== undefined &&
							read(op.right, NUMBER) !== undefined;
						write(
							op.dst,
							COMPILER_NUMERIC_BINARY_OPERATORS.has(op.operator) ? NUMBER : BOOLEAN,
						);
					}
					break;
				}
				case "UNARY":
					ok =
						(op.operator === "!" || COMPILER_NUMERIC_UNARY_OPERATORS.has(op.operator)) &&
						read(op.src, op.operator === "!" ? undefined : NUMBER) !== undefined;
					write(op.dst, op.operator === "!" ? BOOLEAN : NUMBER);
					break;
				case "JUMP_IF":
					ok = read(op.cond) !== undefined;
					break;
				case "JUMP":
					break;
				default:
					return undefined;
			}
		if (!ok) return undefined;
		for (const target of successors(op, ip)) {
			const next = new Map(state);
			const test =
				op.opcode === "JUMP_IF" && defined.has(op.cond)
					? predicates.get(op.cond)
					: undefined;
			if (op.opcode === "JUMP_IF" && test !== undefined) {
				const equal = (target === op.targetIp) === test.equal;
				const node = references.get(test.register);
				for (const [register, mask] of next)
					if (
						register === test.register ||
						(node !== undefined && references.get(register) === node)
					)
						next.set(register, equal ? mask & test.mask : mask & ~test.mask);
			}
			join(target, next, defined);
		}
	}
	for (const register of inputs)
		if (kinds.get(register) !== NUMBER && kinds.get(register) !== BOOLEAN)
			return undefined;
	return {
		graph: { references: nodes, fields },
		references,
		fields: fieldIps,
		kinds,
		states,
		inputs,
		written,
		assigned,
	};
}
