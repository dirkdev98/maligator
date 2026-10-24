import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerTypeofComparison,
	compilerValueKindMaskIsSubset,
	compilerValueKindTruthiness,
} from "../shared/compiler-value-kinds.ts";
import {
	instructionInputIntegerRange,
	instructionInputKind,
	instructionResultKind,
} from "../shared/instruction-facts.ts";
import {
	compilerIntegerRangeComparison,
	compilerIntegerRangeTruthiness,
} from "../shared/integer-range.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import type { NativeDirectEntryPlan, NativeFunctionPlan } from "./program-image.ts";
import { decodeVmValueOperand } from "./runtime-image.ts";

export interface NativeControlFlowPlan {
	readonly branches: ReadonlyArray<{
		readonly instructionIp: number;
		readonly targetIp: number;
	}>;
	readonly unreachableIps: ReadonlyArray<number>;
}

export function selectNativeControlFlow(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	options: {
		readonly constants?: NativeDirectEntryPlan["constantBooleans"];
		readonly externalEntries?: ReadonlyArray<number>;
		readonly workLimit?: number;
	} = {},
): NativeControlFlowPlan | undefined {
	const fn = native.body;
	if (!fn.instructions.some((op) => op.opcode === "JUMP_IF")) return undefined;
	const count = fn.instructions.length;
	const definitions = new Int32Array(fn.registerCount).fill(-1);
	for (const [ip, writes] of body.writes.entries())
		for (const register of writes)
			definitions[register] = definitions[register] === -1 ? ip : -2;
	const first = new Int32Array(count).fill(-1);
	const second = new Int32Array(count).fill(-1);
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "JUMP") first[ip] = op.targetIp;
		else if (op.opcode === "JUMP_IF") {
			first[ip] = op.targetIp;
			second[ip] = ip + 1;
		} else if (!["RETURN", "THROW", "LOAD_UNDECLARED"].includes(op.opcode))
			first[ip] = ip + 1;
	}
	const roots = new Set([0, ...body.externalEntries, ...(options.externalEntries ?? [])]);
	// Selected regions can continue at ordinary labels without following the bytecode edge.
	for (const region of native.specializations)
		for (const ip of [
			...region.anchors,
			...region.claimedIps,
			...region.controlFlow.ordinaryBlockIps,
		])
			roots.add(ip);
	for (const site of native.literalSwitches ?? []) {
		for (const entry of site.cases) roots.add(entry.targetIp);
		roots.add(site.defaultIp);
	}
	for (const site of native.fieldCalls ?? [])
		for (let ip = site.allocationIp; ip <= site.callIp; ip++) roots.add(ip);
	const fixed = new Map(
		options.constants?.map(({ instructionIp, value }) => [instructionIp, value]),
	);
	const protectedUses = new Map<number, Map<number, boolean>>();
	const marks = new Uint32Array(count);
	const pending: Array<number> = [];
	let generation = 0;
	let remaining = options.workLimit ?? Math.max(4096, count * 8);
	const blocks = new Uint32Array(count);
	for (let ip = 1; ip < count; ip++) {
		const prior = fn.instructions[ip - 1]!;
		blocks[ip] =
			blocks[ip - 1]! +
			(roots.has(ip) ||
			body.jumpTargets.has(ip) ||
			["JUMP", "JUMP_IF", "RETURN", "THROW", "LOAD_UNDECLARED"].includes(prior.opcode)
				? 1
				: 0);
	}
	const protectedUse = (definition: number, use: number): boolean => {
		if (definition < use && blocks[definition] === blocks[use]) return true;
		if (roots.has(use)) return false;
		if (roots.size === 1 && roots.has(definition)) return true;
		if (remaining <= 0) return false;
		let uses = protectedUses.get(definition);
		if (uses === undefined)
			protectedUses.set(definition, (uses = new Map<number, boolean>()));
		const previous = uses.get(use);
		if (previous !== undefined) return previous;
		generation++;
		pending.length = 0;
		const push = (ip: number) => {
			if (ip < 0 || ip >= count || marks[ip] === generation || ip === definition) return;
			marks[ip] = generation;
			pending.push(ip);
		};
		for (const root of roots) push(root);
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (ip === use || remaining-- <= 0) {
				uses.set(use, false);
				return false;
			}
			push(first[ip]!);
			push(second[ip]!);
		}
		uses.set(use, true);
		return true;
	};
	const mask = (operand: number, ip: number): number => {
		const value = decodeVmValueOperand(operand);
		if (value.kind === "register") {
			const rep = native.registerRepresentations[value.register];
			if (rep === "number" || rep === "int32") return COMPILER_VALUE_KIND_NUMBER;
			if (rep === "boolean") return COMPILER_VALUE_KIND_BOOLEAN;
			if (rep === "string") return COMPILER_VALUE_KIND_STRING;
			return (
				instructionInputKind(native.facts?.[ip], value.register) ??
				COMPILER_VALUE_KIND_TOP
			);
		}
		return value.kind === "number"
			? COMPILER_VALUE_KIND_NUMBER
			: value.kind === "undefined"
				? COMPILER_VALUE_KIND_UNDEFINED
				: value.kind === "boolean"
					? COMPILER_VALUE_KIND_BOOLEAN
					: value.kind === "string"
						? COMPILER_VALUE_KIND_STRING
						: value.kind === "null"
							? COMPILER_VALUE_KIND_NULL
							: COMPILER_VALUE_KIND_TOP;
	};
	const values = new Map<number, boolean | undefined>();
	const truth = (operand: number, ip: number): boolean | undefined => {
		const chain: Array<{ definition: number; use: number; negate: boolean }> = [];
		const active = new Set<number>();
		let constant: boolean | undefined;
		while (true) {
			const value = decodeVmValueOperand(operand);
			switch (value.kind) {
				case "boolean":
					constant = value.value;
					break;
				case "null":
				case "undefined":
					constant = false;
					break;
				case "number":
					constant = value.value !== 0 && !Number.isNaN(value.value);
					break;
				case "string": {
					const units = stringConstants[value.index];
					constant = units === undefined ? undefined : units.length !== 0;
					break;
				}
				case "register": {
					const facts = native.facts?.[ip];
					constant =
						compilerValueKindTruthiness(
							instructionInputKind(facts, value.register) ?? COMPILER_VALUE_KIND_TOP,
						) ??
						compilerIntegerRangeTruthiness(
							instructionInputIntegerRange(facts, value.register),
						);
					if (constant !== undefined) break;
					const definition = definitions[value.register]!;
					if (definition < 0 || active.has(definition)) break;
					const op = fn.instructions[definition]!;
					if (
						!values.has(definition) &&
						(op.opcode === "MOVE" || (op.opcode === "UNARY" && op.operator === "!"))
					) {
						chain.push({ definition, use: ip, negate: op.opcode === "UNARY" });
						active.add(definition);
						operand = op.src;
						ip = definition;
						continue;
					}
					if (!values.has(definition)) values.set(definition, result(definition));
					constant = values.get(definition);
					if (constant !== undefined && !protectedUse(definition, ip))
						constant = undefined;
					break;
				}
			}
			break;
		}
		for (let index = chain.length - 1; index >= 0; index--) {
			const link = chain[index]!;
			if (constant !== undefined && link.negate) constant = !constant;
			values.set(link.definition, constant);
			if (constant !== undefined && !protectedUse(link.definition, link.use))
				constant = undefined;
		}
		return constant;
	};
	const result = (ip: number): boolean | undefined => {
		const op = fn.instructions[ip]!;
		const constant = fixed.get(ip);
		if (constant !== undefined) return constant;
		const facts = native.facts?.[ip];
		switch (op.opcode) {
			case "CREATE_BOOLEAN":
				return op.value;
			case "CREATE_NUMBER":
			case "CREATE_F64":
				return op.value !== 0 && !Number.isNaN(op.value);
			case "CREATE_NULL":
			case "CREATE_UNDEFINED":
				return false;
			case "CREATE_STRING": {
				const units = stringConstants[op.stringIndex];
				return units === undefined ? undefined : units.length !== 0;
			}
			case "TYPEOF_COMPARE": {
				const value = compilerTypeofComparison(mask(op.src, ip), op.expected);
				return value === undefined ? undefined : value !== op.negated;
			}
			case "BINARY":
				return compilerIntegerRangeComparison(
					op.operator,
					instructionInputIntegerRange(facts, op.left),
					instructionInputIntegerRange(facts, op.right),
				);
			case "CALL_KNOWN": {
				if (op.construct || op.argumentMode !== undefined) break;
				const input = op.arguments[0];
				if (
					[
						"Number.isNaN",
						"Number.isFinite",
						"Number.isInteger",
						"Number.isSafeInteger",
					].includes(op.operation)
				) {
					if (
						input === undefined ||
						compilerValueKindMaskIsSubset(
							mask(input, ip),
							COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_NUMBER,
						)
					)
						return false;
					const value = decodeVmValueOperand(input);
					if (value.kind === "number")
						return op.operation === "Number.isNaN"
							? Number.isNaN(value.value)
							: op.operation === "Number.isFinite"
								? Number.isFinite(value.value)
								: op.operation === "Number.isInteger"
									? Number.isInteger(value.value)
									: Number.isSafeInteger(value.value);
					if (
						value.kind === "register" &&
						(native.registerRepresentations[value.register] === "int32" ||
							instructionInputIntegerRange(facts, value.register) !== undefined)
					)
						return op.operation !== "Number.isNaN";
				} else if (
					op.operation === "Array.isArray" &&
					(input === undefined ||
						compilerValueKindMaskIsSubset(
							mask(input, ip),
							COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_OBJECT,
						))
				)
					return false;
				break;
			}
		}
		return "dst" in op
			? compilerValueKindTruthiness(
					instructionResultKind(facts, op.dst) ?? COMPILER_VALUE_KIND_TOP,
				)
			: undefined;
	};
	const decisions = new Map<number, number>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode !== "JUMP_IF") continue;
		const value = truth(op.cond, ip);
		if (value !== undefined) decisions.set(ip, value ? op.targetIp : ip + 1);
	}
	if (decisions.size === 0) return undefined;
	const reachable = new Uint8Array(count);
	pending.length = 0;
	const push = (ip: number) => {
		if (ip < 0 || ip >= count || reachable[ip]) return;
		reachable[ip] = 1;
		pending.push(ip);
	};
	for (const root of roots) push(root);
	while (pending.length > 0) {
		const ip = pending.pop()!;
		const target = decisions.get(ip);
		if (target !== undefined) push(target);
		else {
			push(first[ip]!);
			push(second[ip]!);
		}
	}
	return {
		branches: [...decisions]
			.filter(([ip]) => reachable[ip])
			.map(([instructionIp, targetIp]) => ({ instructionIp, targetIp })),
		unreachableIps: fn.instructions.flatMap((_, ip) => (reachable[ip] ? [] : [ip])),
	};
}

export function nativeControlFlowPlansMatch(
	left: NativeControlFlowPlan | undefined,
	right: NativeControlFlowPlan | undefined,
): boolean {
	return left === undefined || right === undefined
		? left === right
		: left.branches.length === right.branches.length &&
				left.branches.every(
					(branch, index) =>
						branch.instructionIp === right.branches[index]!.instructionIp &&
						branch.targetIp === right.branches[index]!.targetIp,
				) &&
				left.unreachableIps.length === right.unreachableIps.length &&
				left.unreachableIps.every((ip, index) => ip === right.unreachableIps[index]);
}
