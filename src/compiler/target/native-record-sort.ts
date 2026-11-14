import type { NativeDirectEntryPlan, NativeFunctionPlan } from "./program-image.ts";
import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";

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
