import type { NativeDirectEntryPlan, NativeFunctionPlan } from "./program-image.ts";
import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";

interface NumericOrderKey {
	readonly key: number;
	readonly descending: boolean;
}

/**
 * A lexicographic chain of opposite-record field differences defines a total
 * preorder when its captured keys are not NaN. Other leaves retain the generic
 * sort's comparison schedule, including its treatment of inconsistent orders.
 */
export function nativeRecordSortNumericOrder(
	native: NativeFunctionPlan,
	entry: NativeDirectEntryPlan,
): ReadonlyArray<NumericOrderKey> | undefined {
	const fields = entry.fieldParameters;
	if (fields === undefined || native.body.instructions.length > 128) return undefined;
	type Value =
		| { readonly kind: "field"; readonly parameter: number; readonly key: number }
		| ({ readonly kind: "difference" } & NumericOrderKey);
	const loads = new Map(fields.loads.map((load) => [load.instructionIp, load.field]));
	let remaining = 256;
	const same = (left: NumericOrderKey, right: NumericOrderKey) =>
		left.key === right.key && left.descending === right.descending;
	const walk = (
		start: number,
		registers: Map<number, Value>,
		conditions: ReadonlyMap<number, boolean>,
	): Array<NumericOrderKey> | undefined => {
		for (let ip = start; --remaining >= 0; ip++) {
			const op = native.body.instructions[ip];
			if (op === undefined) return undefined;
			switch (op.opcode) {
				case "JUMP":
					ip = op.targetIp - 1;
					break;
				case "LOAD_PROPERTY_STATIC": {
					const field = loads.get(ip);
					if (field === undefined) return undefined;
					registers.set(op.dst, { kind: "field", ...fields.sources[field]! });
					break;
				}
				case "MOVE": {
					const value = registers.get(op.src);
					if (value === undefined) return undefined;
					registers.set(op.dst, value);
					break;
				}
				case "BINARY": {
					const left = registers.get(op.left);
					const right = registers.get(op.right);
					if (
						op.operator !== "-" ||
						left?.kind !== "field" ||
						right?.kind !== "field" ||
						left.key !== right.key ||
						(left.parameter !== 0 && left.parameter !== 1) ||
						right.parameter !== 1 - left.parameter
					)
						return undefined;
					registers.set(op.dst, {
						kind: "difference",
						key: left.key,
						descending: left.parameter === 1,
					});
					break;
				}
				case "JUMP_IF": {
					const condition = registers.get(op.cond);
					if (condition?.kind !== "difference") return undefined;
					const known = conditions.get(condition.key);
					if (known !== undefined) {
						if (known) ip = op.targetIp - 1;
						break;
					}
					const selected = walk(
						op.targetIp,
						new Map(registers),
						new Map(conditions).set(condition.key, true),
					);
					if (selected?.length !== 1 || !same(selected[0]!, condition)) return undefined;
					const tail = walk(
						ip + 1,
						registers,
						new Map(conditions).set(condition.key, false),
					);
					return tail === undefined ? undefined : [condition, ...tail];
				}
				case "RETURN": {
					const value = registers.get(op.value);
					return value?.kind === "difference" ? [value] : undefined;
				}
				default:
					return undefined;
			}
		}
		return undefined;
	};
	const order = walk(0, new Map(), new Map());
	const seen = new Set<number>();
	return order?.filter(({ key }) => {
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Fields whose complete use graph only compares the same key on opposite records.
 * A multiply assigned local has no single field provenance and fails closed.
 */
export function nativeRecordSortOrderFields(
	native: NativeFunctionPlan,
	entry: NativeDirectEntryPlan,
): {
	readonly keys: ReadonlyArray<number>;
	readonly registers: ReadonlyMap<number, number>;
} {
	const fields = entry.fieldParameters;
	const registers = new Map<number, number>();
	if (fields === undefined) return { keys: [], registers };
	const writes = new Uint32Array(native.body.registerCount);
	for (const op of native.body.instructions)
		for (const register of vmInstructionWriteRegisters(op)) writes[register]!++;
	const rejected = new Set<number>();
	for (const load of fields.loads) {
		const op = native.body.instructions[load.instructionIp];
		if (op?.opcode !== "LOAD_PROPERTY_STATIC")
			throw new Error("Record sort field lacks its property load");
		const source = fields.sources[load.field]!;
		if (writes[op.dst] !== 1) rejected.add(source.key);
		else registers.set(op.dst, load.field);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const op of native.body.instructions) {
			if (op.opcode !== "MOVE" || registers.has(op.dst)) continue;
			const source = registers.get(op.src);
			if (source === undefined) continue;
			if (writes[op.dst] !== 1) rejected.add(fields.sources[source]!.key);
			else {
				registers.set(op.dst, source);
				changed = true;
			}
		}
	}
	for (const op of native.body.instructions) {
		for (const register of vmInstructionReadRegisters(op)) {
			const field = registers.get(register);
			if (field === undefined) continue;
			const source = fields.sources[field]!;
			if (op.opcode === "MOVE" && registers.get(op.dst) === field) continue;
			if (
				op.opcode === "BINARY" &&
				["<", ">", "<=", ">=", "===", "!=="].includes(op.operator)
			) {
				const other = registers.get(op.left === register ? op.right : op.left);
				const opposite = other === undefined ? undefined : fields.sources[other];
				if (opposite?.key === source.key && opposite.parameter !== source.parameter)
					continue;
			}
			rejected.add(source.key);
		}
	}
	const keys = [...new Set(fields.sources.map(({ key }) => key))].filter(
		(key) =>
			!rejected.has(key) &&
			fields.sources.some((source) => source.key === key && source.parameter === 0) &&
			fields.sources.some((source) => source.key === key && source.parameter === 1),
	);
	// Each additional polymorphic field doubles the generated merge loops.
	return { keys: keys.slice(0, 2), registers };
}
