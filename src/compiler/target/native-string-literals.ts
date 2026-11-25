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
	const count = fn.instructions.length;
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
	const predecessors = new Array<number | Array<number> | undefined>(count);
	const add = (from: number, to: number): void => {
		if (to < 0 || to >= count || unreachable.has(to)) return;
		const prior = predecessors[to];
		if (prior === undefined) predecessors[to] = from;
		else if (typeof prior === "number") predecessors[to] = [prior, from];
		else prior.push(from);
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
	let remaining = options.workLimit ?? Math.max(4096, count * 8);
	const registerCount = fn.registerCount;
	const canPack = Number.isSafeInteger(count * registerCount);
	const keyFor = (ip: number, register: number): number | string =>
		canPack && ip >= 0 && ip < count && register >= 0 && register < registerCount
			? ip * registerCount + register
			: `${ip}:${register}`;
	const cache = new Map<number | string, number | null>();
	return (use, register) => {
		if (!written.has(register)) return undefined;
		const key = keyFor(use, register);
		const cached = cache.get(key);
		if (cached !== undefined) return cached ?? undefined;
		const pending = [use, register];
		const visited = new Set<number | string>();
		let fact: number | undefined;
		let valid = true;
		// Revisited aliases add no definitions; every entry path must still reach a literal.
		while (pending.length > 0 && valid) {
			const register = pending.pop()!;
			const use = pending.pop()!;
			const key = keyFor(use, register);
			if (visited.has(key)) continue;
			visited.add(key);
			if (roots.has(use) || remaining-- <= 0) {
				valid = false;
				break;
			}
			const incoming = predecessors[use];
			if (incoming === undefined) {
				valid = false;
				break;
			}
			const single = typeof incoming === "number";
			const length = single ? 1 : incoming.length;
			for (let index = 0; index < length; index++) {
				const ip = single ? incoming : incoming[index]!;
				const op = fn.instructions[ip]!;
				if (!body.writes[ip]!.includes(register)) {
					pending.push(ip, register);
					continue;
				}
				if (op.opcode === "MOVE" || op.opcode === "TO_PROPERTY_KEY") {
					// A successful ToPropertyKey preserves a String; its nil check stays at the source site.
					pending.push(ip, op.opcode === "MOVE" ? op.src : op.key);
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
		cache.set(key, result ?? null);
		return result;
	};
}
