import type { NativeBodyFacts } from "./native-body-facts.ts";
import type { NativeFunctionPlan } from "./program-image.ts";

export interface NativeMapEntryPlan {
	readonly getIp: number;
	readonly setIp: number;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
}

function entryPaths(native: NativeFunctionPlan, body: NativeBodyFacts) {
	const successors = native.body.instructions.map(() => new Array<number>());
	const predecessors = native.body.instructions.map(() => new Array<number>());
	for (const [ip, op] of native.body.instructions.entries()) {
		if (body.projection?.unreachable.has(ip)) continue;
		const add = (target: number) => {
			if (target < 0 || target >= successors.length || successors[ip]!.includes(target))
				return;
			successors[ip]!.push(target);
			predecessors[target]!.push(ip);
		};
		const fixed = body.projection?.branches.get(ip);
		if (fixed !== undefined) add(fixed);
		else if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") add(op.targetIp);
		if (
			fixed === undefined &&
			op.opcode !== "JUMP" &&
			op.opcode !== "RETURN" &&
			op.opcode !== "THROW" &&
			op.opcode !== "LOAD_UNDECLARED"
		)
			add(ip + 1);
		const handler = body.handlerTargets[ip];
		if (handler !== undefined) add(handler);
	}
	return (getIp: number, setIp: number): Uint8Array => {
		const forward = new Uint8Array(successors.length);
		const pending = [...successors[getIp]!];
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (ip === getIp || forward[ip]) continue;
			forward[ip] = 1;
			if (ip !== setIp) pending.push(...successors[ip]!);
		}
		const between = new Uint8Array(successors.length);
		if (forward[setIp]) pending.push(setIp);
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (!forward[ip] || between[ip]) continue;
			between[ip] = 1;
			pending.push(...predecessors[ip]!);
		}
		return between;
	};
}

export function selectNativeMapEntries(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	unavailable: (ip: number) => boolean,
): Array<NativeMapEntryPlan> {
	const fn = native.body,
		plans: Array<NativeMapEntryPlan & { readonly receiver: string }> = [];
	if (
		native.mode !== "direct" ||
		fn.isAsync ||
		fn.isGenerator ||
		fn.profileSiteIds !== undefined ||
		fn.instructions.length > 4096
	)
		return plans;
	const gets = new Map<string, Array<number>>();
	const sets: Array<{ ip: number; receiver: string; key: string }> = [];
	const origins = new Map<number, string>();
	const originOf = (register: number) => origins.get(register) ?? `register:${register}`;
	// Origins only predict reuse: each update revalidates the current receiver, live index and key.
	for (const [ip, op] of fn.instructions.entries()) {
		if (body.projection?.unreachable.has(ip)) continue;
		const plan = native.instructions[ip];
		const operation =
			op.opcode === "CALL_KNOWN"
				? op.operation
				: plan?.kind === "call"
					? plan.guardedBuiltinCall?.operation
					: undefined;
		if ((op.opcode === "CALL" || op.opcode === "CALL_KNOWN") && !unavailable(ip)) {
			const key = op.arguments[0];
			const receiver = originOf(op.thisValue);
			if (key !== undefined) {
				const identity = `${receiver}/${originOf(key)}`;
				if (operation === "Map.prototype.set" && op.arguments.length === 2) {
					sets.push({ ip, receiver, key: identity });
				} else if (operation === "Map.prototype.get" && op.arguments.length === 1) {
					const entries = gets.get(identity) ?? [];
					entries.push(ip);
					gets.set(identity, entries);
				}
			}
		}
		const origin =
			op.opcode === "MOVE"
				? originOf(op.src)
				: op.opcode === "LOAD_GLOBAL"
					? `global:${op.index}`
					: undefined;
		for (const register of body.writes[ip]!)
			origins.set(register, `value:${ip}:${register}`);
		if (origin !== undefined && "dst" in op) origins.set(op.dst, origin);
	}
	for (const set of sets) {
		const entries = gets.get(set.key);
		if (entries === undefined || entries.length === 0) continue;
		const before = entries.findLastIndex((ip) => ip < set.ip);
		const getIp = entries.splice(before < 0 ? 0 : before, 1)[0]!;
		plans.push({
			receiver: set.receiver,
			getIp,
			setIp: set.ip,
			claimedIps: [getIp, set.ip],
			borrowedRegisters: [],
		});
		if (plans.length === 16) break;
	}
	if (plans.length < 2) return [];
	const paths = entryPaths(native, body);
	const between = plans.map((plan) => paths(plan.getIp, plan.setIp));
	// Stop at either endpoint so another loop iteration cannot make adjacent get/set appear overlapping.
	return plans
		.filter((plan, index) =>
			plans.some(
				(other) =>
					other !== plan &&
					other.receiver === plan.receiver &&
					(between[index]![other.getIp] || between[index]![other.setIp]),
			),
		)
		.slice(0, 8)
		.map(({ receiver: _receiver, ...plan }) => plan);
}
