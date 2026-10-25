import type { NativeBodyFacts } from "./native-body-facts.ts";
import type { NativeControlFlowPlan } from "./native-control-flow.ts";
import { nativeInstructionEffects } from "./program-image.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";

export function nativeElidedResultRegisters(
	native: NativeFunctionPlan,
): ReadonlySet<number> {
	const elided = new Set(native.storage?.elidedPureIps);
	const registers = new Set<number>();
	for (const ip of elided) {
		const op = native.body.instructions[ip]!;
		if ("dst" in op) registers.add(op.dst);
	}
	if (registers.size === 0) return registers;
	const unreachable = new Set(native.storage?.controlFlow?.unreachableIps);
	const branches = new Set(
		native.storage?.controlFlow?.branches.map((branch) => branch.instructionIp),
	);
	for (const [ip, op] of native.body.instructions.entries()) {
		if (elided.has(ip) || unreachable.has(ip)) continue;
		for (const register of [
			...(branches.has(ip) ? [] : vmInstructionReadRegisters(op)),
			...vmInstructionWriteRegisters(op),
		])
			registers.delete(register);
	}
	return registers;
}

export function selectNativeUnusedValues(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	options: {
		readonly controlFlow: NativeControlFlowPlan | undefined;
		readonly blocked: ReadonlySet<number>;
		readonly borrowed: ReadonlySet<number>;
		readonly roots: ReadonlyArray<number>;
		readonly numberPredicates: ReadonlySet<number>;
	},
): ReadonlyArray<number> {
	const fn = native.body;
	if (fn.profileSiteIds !== undefined) return [];
	const unreachable = new Set(options.controlFlow?.unreachableIps);
	const branches = new Set(
		options.controlFlow?.branches.map((branch) => branch.instructionIp),
	);
	const roots = new Set(options.roots);
	const removable = new Uint8Array(fn.instructions.length);
	const definitions = new Map<number, Array<number>>();
	const needed = new Uint8Array(fn.instructions.length);
	const pending: Array<number> = [];
	// A deleted scalar store must never reactivate stale object bits in a shared root slot.
	for (const [ip, op] of fn.instructions.entries()) {
		if (unreachable.has(ip)) continue;
		if (
			!("dst" in op) ||
			options.blocked.has(ip) ||
			options.borrowed.has(op.dst) ||
			roots.has(op.dst) ||
			op.dst < fn.parameterCount + fn.argumentSnapshotCount
		)
			continue;
		let pure = false;
		// Runtime calls and allocations retain polling and materialization obligations beyond semantic effects.
		switch (op.opcode) {
			case "CREATE_UNDEFINED":
			case "CREATE_NULL":
			case "CREATE_EMPTY":
			case "CREATE_BOOLEAN":
			case "CREATE_NUMBER":
			case "CREATE_F64":
			case "CREATE_STRING":
			case "CREATE_BIGINT":
			case "MOVE":
			case "LOAD_INTRINSIC":
			case "LOAD_ARGUMENT_COUNT":
			case "TYPEOF_COMPARE":
			case "IS_EMPTY":
			case "MATH_UNARY_NUMBER":
			case "MATH_BINARY_NUMBER":
				pure = true;
				break;
			case "UNARY":
			case "BINARY": {
				const effects = nativeInstructionEffects(op, native.facts?.[ip]);
				pure =
					!effects.allocation &&
					!effects.collection &&
					!effects.reentry &&
					!effects.throwing &&
					!effects.invalidation;
				break;
			}
			case "CALL_KNOWN":
				pure = options.numberPredicates.has(ip);
				break;
		}
		if (!pure) continue;
		removable[ip] = 1;
		const writers = definitions.get(op.dst) ?? [];
		writers.push(ip);
		definitions.set(op.dst, writers);
	}
	const required = new Set<number>();
	const requireRegister = (register: number) => {
		if (required.has(register)) return;
		required.add(register);
		for (const ip of definitions.get(register) ?? []) {
			if (needed[ip]) continue;
			needed[ip] = 1;
			pending.push(ip);
		}
	};
	for (const register of options.borrowed) requireRegister(register);
	for (const [ip, reads] of body.reads.entries())
		if (!unreachable.has(ip) && !removable[ip] && !branches.has(ip))
			for (const register of reads) requireRegister(register);
	while (pending.length > 0)
		for (const register of body.reads[pending.pop()!]!) requireRegister(register);
	return fn.instructions.flatMap((_, ip) => (removable[ip] && !needed[ip] ? [ip] : []));
}
