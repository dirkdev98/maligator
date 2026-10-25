import { COMPILER_VALUE_KIND_STRING } from "../shared/compiler-value-kinds.ts";
import { instructionInputKind } from "../shared/instruction-facts.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import { nativeControlFlowEntries } from "./native-control-flow.ts";
import type { NativeControlFlowPlan } from "./native-control-flow.ts";
import type { NativeFunctionPlan } from "./program-image.ts";

export interface NativeStringComparisonPlan {
	readonly instructionIp: number;
	readonly register: number;
	readonly length: number;
	readonly kind: "boxed" | "strings";
}

export function selectNativeStringComparisons(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	options: {
		readonly controlFlow?: NativeControlFlowPlan;
		readonly externalEntries?: ReadonlyArray<number>;
		readonly elided: ReadonlySet<number>;
		readonly stringLength: (index: number) => number | undefined;
		readonly workLimit?: number;
	},
): ReadonlyArray<NativeStringComparisonPlan> {
	const fn = native.body;
	const comparisons = fn.instructions.flatMap((op, ip) =>
		op.opcode === "BINARY" &&
		(op.operator === "===" || op.operator === "!==") &&
		!options.elided.has(ip)
			? [{ op, ip }]
			: [],
	);
	if (
		comparisons.length === 0 ||
		!fn.instructions.some((op) => op.opcode === "CREATE_STRING")
	)
		return [];
	const unreachable = new Set(options.controlFlow?.unreachableIps);
	const branches = new Map(
		options.controlFlow?.branches.map(({ instructionIp, targetIp }) => [
			instructionIp,
			targetIp,
		]),
	);
	const roots =
		body.projection?.entries ??
		nativeControlFlowEntries(native, body, options.externalEntries).roots;
	const predecessors = new Array<Array<number> | undefined>(fn.instructions.length);
	const add = (from: number, to: number): void => {
		if (to < 0 || to >= fn.instructions.length) return;
		(predecessors[to] ??= []).push(from);
	};
	const written = new Set<number>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (unreachable.has(ip)) continue;
		for (const register of body.writes[ip]!) written.add(register);
		const fixed = branches.get(ip);
		if (fixed !== undefined) add(ip, fixed);
		else {
			if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") add(ip, op.targetIp);
			if (!["JUMP", "RETURN", "THROW", "LOAD_UNDECLARED"].includes(op.opcode))
				add(ip, ip + 1);
		}
	}
	let remaining = options.workLimit ?? Math.max(4096, fn.instructions.length * 8);
	const cache = new Map<string, number | undefined>();
	const lengthAt = (use: number, register: number): number | undefined => {
		if (!written.has(register)) return undefined;
		const key = `${use}:${register}`;
		if (cache.has(key)) return cache.get(key);
		const pending = [{ ip: use, register }];
		const visited = new Set<string>();
		let length: number | undefined;
		let valid = true;
		// Revisited aliases add no definitions; every entry path must still reach a literal.
		while (pending.length > 0 && valid) {
			const state = pending.pop()!;
			const key = `${state.ip}:${state.register}`;
			if (visited.has(key)) continue;
			visited.add(key);
			if (roots.has(state.ip) || remaining-- <= 0) {
				valid = false;
				break;
			}
			const incoming = predecessors[state.ip];
			if (incoming === undefined) {
				valid = false;
				break;
			}
			for (const ip of incoming) {
				const op = fn.instructions[ip]!;
				if (!body.writes[ip]!.includes(state.register)) {
					pending.push({ ip, register: state.register });
					continue;
				}
				if (op.opcode === "MOVE") {
					pending.push({ ip, register: op.src });
					continue;
				}
				const candidate =
					op.opcode === "CREATE_STRING"
						? options.stringLength(op.stringIndex)
						: undefined;
				if (candidate === undefined || (length !== undefined && length !== candidate)) {
					valid = false;
					break;
				}
				length = candidate;
			}
		}
		const result = valid ? length : undefined;
		cache.set(key, result);
		return result;
	};
	return comparisons.flatMap(({ op, ip }) => {
		if (unreachable.has(ip)) return [];
		for (const register of [op.right, op.left]) {
			const length = lengthAt(ip, register);
			if (length !== undefined) {
				const other = register === op.right ? op.left : op.right;
				const knownString =
					native.registerRepresentations[other] === "string" ||
					instructionInputKind(native.facts?.[ip], other) === COMPILER_VALUE_KIND_STRING;
				return [
					{
						instructionIp: ip,
						register,
						length,
						kind: knownString ? ("strings" as const) : ("boxed" as const),
					},
				];
			}
		}
		return [];
	});
}
