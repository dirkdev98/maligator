import type { NativeBodyFacts } from "./native-body-facts.ts";
import { nativeControlFlowEntries } from "./native-control-flow.ts";
import type {
	NativeControlFlowEntryOptions,
	NativeControlFlowPlan,
} from "./native-control-flow.ts";
import type { NativeFunctionPlan } from "./program-image.ts";

// All reaching literals must agree on the requested fact; queries share a bounded work budget.
export function createNativeStringLiteralQuery(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	options: NativeControlFlowEntryOptions & {
		readonly controlFlow?: NativeControlFlowPlan;
		readonly literalFact: (index: number) => number | undefined;
		readonly workLimit?: number;
	},
): (use: number, register: number) => number | undefined {
	const fn = native.body;
	const unreachable =
		body.projection?.unreachable ?? new Set(options.controlFlow?.unreachableIps);
	const branches =
		body.projection?.branches ??
		new Map(
			options.controlFlow?.branches.map(({ instructionIp, targetIp }) => [
				instructionIp,
				targetIp,
			]),
		);
	const roots =
		body.projection?.entries ?? nativeControlFlowEntries(native, body, options).roots;
	const predecessors = new Array<Array<number> | undefined>(fn.instructions.length);
	const add = (from: number, to: number): void => {
		if (to < 0 || to >= fn.instructions.length || unreachable.has(to)) return;
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
			if (
				!["JUMP", "RETURN", "THROW", "LOAD_UNDECLARED", "TERMINAL_YIELD"].includes(
					op.opcode,
				)
			)
				add(ip, ip + 1);
		}
	}
	let remaining = options.workLimit ?? Math.max(4096, fn.instructions.length * 8);
	const cache = new Map<string, number | undefined>();
	return (use, register) => {
		if (!written.has(register)) return undefined;
		const key = `${use}:${register}`;
		if (cache.has(key)) return cache.get(key);
		const pending = [{ ip: use, register }];
		const visited = new Set<string>();
		let fact: number | undefined;
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
				if (op.opcode === "MOVE" || op.opcode === "TO_PROPERTY_KEY") {
					// A successful ToPropertyKey preserves a String; its nil check stays at the source site.
					pending.push({ ip, register: op.opcode === "MOVE" ? op.src : op.key });
					continue;
				}
				const candidate =
					op.opcode === "CREATE_STRING" ? options.literalFact(op.stringIndex) : undefined;
				if (candidate === undefined || (fact !== undefined && fact !== candidate)) {
					valid = false;
					break;
				}
				fact = candidate;
			}
		}
		const result = valid ? fact : undefined;
		cache.set(key, result);
		return result;
	};
}
