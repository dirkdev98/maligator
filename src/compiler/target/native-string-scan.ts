import type {
	NativeStringBuilderInputs,
	NativeStringBuilderPlan,
} from "./native-string-builders.ts";
import type { NativeStringCodePointSite } from "./native-string-code-points.ts";
import { nativeStringEnumValue } from "./native-string-enums.ts";
import type { NativeStringEnumPlan } from "./native-string-enums.ts";
import { decodeVmValueOperand, vmInstructionWriteRegisters } from "./runtime-image.ts";
import type { BytecodeFunction } from "./runtime-image.ts";

type Literal = {
	readonly kind: "literal";
	readonly value: string | boolean | number;
	readonly stringIndex?: number;
};
type Value =
	| Literal
	| { readonly kind: "input"; readonly register: number }
	| { readonly kind: "numeric"; readonly instruction: number }
	| { readonly kind: "character" }
	| { readonly kind: "prefix" };

export interface NativeStringScanPlan {
	readonly site: NativeStringCodePointSite;
	readonly source: number;
	readonly excludedUnits: ReadonlyArray<number>;
	readonly guards: ReadonlyMap<number, Literal>;
	readonly results: ReadonlyMap<number, Literal | { readonly kind: "prefix" }>;
	readonly builders: ReadonlyMap<number, number>;
}

// A nonempty narrow String can replace a pure copy loop when the first iteration
// reaches an inductive state. The character-dependent branches become exclusions;
// everything live at exhaustion must be a constant, an unchanged input, or the copy.
export function selectNativeStringScans(
	fn: BytecodeFunction,
	inputs: NativeStringBuilderInputs,
	builders: NativeStringBuilderPlan,
	sites: ReadonlyArray<NativeStringCodePointSite>,
	live: (ip: number, register: number) => boolean,
): ReadonlyMap<number, NativeStringScanPlan> {
	const plans = new Map<number, NativeStringScanPlan>();
	if (
		fn.isGenerator ||
		fn.isAsync ||
		fn.instructions.length > 1024 ||
		fn.registerCount > 256
	)
		return plans;
	const builderOf = new Map<number, number>();
	for (const [ip, action] of builders.actions) {
		const op = fn.instructions[ip]!;
		const operation = action.operation;
		if (operation?.kind === "append" && !operation.ordinary) {
			builderOf.set(operation.left, operation.builder);
			if ("dst" in op) builderOf.set(op.dst, operation.builder);
		}
	}
	const stringLiteral = (index: number): Literal | undefined => {
		const units = inputs.stringConstants[index];
		return units === undefined || units.length > 256
			? undefined
			: { kind: "literal", value: String.fromCharCode(...units), stringIndex: index };
	};
	const literal = (operand: number, before: number, depth = 0): Literal | undefined => {
		if (depth > 16) return undefined;
		const decoded = decodeVmValueOperand(operand);
		if (decoded.kind === "string") {
			return stringLiteral(decoded.index);
		}
		if (decoded.kind === "boolean" || decoded.kind === "number")
			return { kind: "literal", value: decoded.value };
		if (decoded.kind !== "register") return undefined;
		// These are candidate entry values, never dominance facts: generated guards
		// check each value actually used, including virtual builder and enum storage.
		for (let ip = before - 1; ip >= Math.max(0, before - 128); ip--) {
			const op = fn.instructions[ip]!;
			if (!vmInstructionWriteRegisters(op).includes(operand)) continue;
			if (op.opcode === "CREATE_STRING") return stringLiteral(op.stringIndex);
			if (op.opcode === "CREATE_BOOLEAN" || op.opcode === "CREATE_NUMBER")
				return typeof op.value === "number" && !Number.isFinite(op.value)
					? undefined
					: { kind: "literal", value: op.value };
			return op.opcode === "MOVE" ? literal(op.src, ip, depth + 1) : undefined;
		}
		return undefined;
	};
	for (const site of sites.slice(0, 4)) {
		const step = fn.instructions[site.stepIp];
		const terminal = fn.instructions[site.stepIp + 1];
		if (
			step?.opcode !== "ITERATOR_STEP" ||
			terminal?.opcode !== "JUMP_IF" ||
			terminal.cond !== step.doneDst
		)
			continue;
		const guards = new Map<number, Literal>();
		const excluded = new Set<number>();
		const initial = new Map<number, Value>();
		for (let register = 0; register < fn.registerCount; register++)
			initial.set(register, { kind: "input", register });
		const read = (
			state: ReadonlyMap<number, Value>,
			operand: number,
		): Value | undefined => {
			const decoded = decodeVmValueOperand(operand);
			if (decoded.kind !== "register") return literal(operand, site.stepIp);
			const value = state.get(operand)!;
			if (value.kind !== "input") return value;
			const constant = literal(value.register, site.stepIp);
			if (constant !== undefined) {
				guards.set(value.register, constant);
				return constant;
			}
			return value;
		};
		const iterate = (
			entry: ReadonlyMap<number, Value>,
			continuation: boolean,
		): Map<number, Value> | undefined => {
			const state = new Map(entry);
			state.set(step.valueDst, { kind: "character" });
			state.set(step.doneDst, { kind: "literal", value: false });
			const appends = new Map<number, number>();
			let ip = site.stepIp + 1;
			for (let budget = 0; budget < 256; budget++) {
				if (ip === site.stepIp)
					return appends.size > 0 && [...appends.values()].every((count) => count === 1)
						? state
						: undefined;
				const op = fn.instructions[ip];
				if (op === undefined || ip === terminal.targetIp) return undefined;
				if (
					vmInstructionWriteRegisters(op).some(
						(register) => register === step.iterator || register === step.next,
					)
				)
					return undefined;
				switch (op.opcode) {
					case "JUMP":
						ip = op.targetIp;
						continue;
					case "JUMP_IF": {
						const cond = read(state, op.cond);
						if (cond?.kind !== "literal") return undefined;
						ip = cond.value ? op.targetIp : ip + 1;
						continue;
					}
					case "CREATE_STRING": {
						const value = stringLiteral(op.stringIndex);
						if (value === undefined) return undefined;
						state.set(op.dst, value);
						break;
					}
					case "CREATE_BOOLEAN":
					case "CREATE_NUMBER":
						if (typeof op.value === "number" && !Number.isFinite(op.value))
							return undefined;
						state.set(op.dst, { kind: "literal", value: op.value });
						break;
					case "MOVE": {
						const value = read(state, op.src);
						if (value === undefined) return undefined;
						state.set(op.dst, value);
						break;
					}
					case "UNARY":
						if (
							op.operator !== "increment" ||
							!["number", "int32"].includes(inputs.representations[op.src]!)
						)
							return undefined;
						state.set(op.dst, { kind: "numeric", instruction: ip });
						break;
					case "BINARY": {
						const left = read(state, op.left),
							right = read(state, op.right);
						if (left === undefined || right === undefined) return undefined;
						if (op.operator === "+") {
							const builder = builderOf.get(op.left);
							if (
								builder === undefined ||
								right.kind !== "character" ||
								!(continuation
									? left.kind === "prefix"
									: left.kind === "literal" && left.value === "")
							)
								return undefined;
							appends.set(builder, (appends.get(builder) ?? 0) + 1);
							state.set(op.dst, { kind: "prefix" });
							break;
						}
						if (op.operator !== "===" && op.operator !== "!==") return undefined;
						let equal: boolean;
						if (left.kind === "literal" && right.kind === "literal")
							equal = left.value === right.value;
						else {
							const constant =
								left.kind === "character"
									? right
									: right.kind === "character"
										? left
										: undefined;
							if (constant?.kind !== "literal") return undefined;
							if (typeof constant.value === "string" && constant.value.length === 1) {
								const unit = constant.value.charCodeAt(0);
								if (unit <= 255) excluded.add(unit);
							}
							equal = false;
						}
						state.set(op.dst, {
							kind: "literal",
							value: op.operator === "===" ? equal : !equal,
						});
						break;
					}
					default:
						return undefined;
				}
				ip++;
			}
			return undefined;
		};
		const first = iterate(initial, false);
		const second = first === undefined ? undefined : iterate(first, true);
		if (first === undefined || second === undefined || excluded.size > 16) continue;
		const results = new Map<number, Literal | { readonly kind: "prefix" }>();
		let safe = true;
		for (let register = 0; register < fn.registerCount; register++) {
			if (register === step.valueDst || register === step.doneDst) continue;
			const atExit = live(terminal.targetIp, register);
			if (!atExit && !live(site.stepIp, register)) continue;
			const a = first.get(register),
				b = second.get(register);
			const same =
				a?.kind === b?.kind &&
				(a?.kind === "literal"
					? b?.kind === "literal" && Object.is(a.value, b.value)
					: a?.kind === "input"
						? b?.kind === "input" && a.register === b.register
						: a?.kind === "numeric"
							? b?.kind === "numeric" && a.instruction === b.instruction
							: true);
			if (!same) {
				safe = false;
				break;
			}
			if (!atExit) continue;
			if (a?.kind === "literal" || a?.kind === "prefix") results.set(register, a);
			else if (a?.kind !== "input" || a.register !== register) {
				safe = false;
				break;
			}
		}
		if (!safe || ![...results.values()].some((value) => value.kind === "prefix"))
			continue;
		plans.set(site.stepIp, {
			site,
			source: step.iterator,
			excludedUnits: [...excluded].sort((a, b) => a - b),
			guards,
			results,
			builders: builderOf,
		});
	}
	return plans;
}

export function renderNativeStringScan(
	plan: NativeStringScanPlan,
	inputs: Pick<NativeStringBuilderInputs, "representations">,
	enums: NativeStringEnumPlan | undefined,
	stringValue: (index: number) => string,
): ReadonlyArray<string> {
	const cursor = `__iter_deferred_${plan.site.initializeIp}`;
	const name = `__string_scan_${plan.site.stepIp}`;
	const numberText = (value: number) => (Object.is(value, -0) ? "-0.0" : String(value));
	const constant = (value: Literal): string =>
		value.stringIndex !== undefined
			? stringValue(value.stringIndex)
			: typeof value.value === "boolean"
				? `mal_value_new_boolean(${value.value})`
				: `mal_ops_number_value(${numberText(value.value as number)})`;
	const enumTag = (value: Literal) =>
		value.stringIndex === undefined ? undefined : enums?.literals.get(value.stringIndex);
	for (const [register, value] of [...plan.guards, ...plan.results])
		if (
			enums?.registers.has(register) &&
			(value.kind !== "literal" || enumTag(value) === undefined)
		)
			return [];
	const guards = [...plan.guards].map(([register, value]) => {
		const tag = enumTag(value);
		if (enums?.registers.has(register))
			return `${nativeStringEnumValue(register)} == ${tag}U`;
		const builder = plan.builders.get(register);
		const representation = inputs.representations[register];
		const ordinary =
			representation === "boolean"
				? `r${register} == ${value.value}`
				: representation === "number" || representation === "int32"
					? `mal_ops_same_value(mal_ops_number_value(r${register}), ${constant(value)})`
					: `mal_ops_same_value(r${register}, ${constant(value)})`;
		return builder === undefined
			? ordinary
			: `(__sb_${builder}.active ? ${value.value === "" ? `__sb_${builder}.length == 0` : `mal_local_string_builder_equals(&__sb_${builder}, ${constant(value)})`} : ${ordinary})`;
	});
	const writes: Array<string> = [];
	const deactivated = new Set<number>();
	for (const [register, value] of plan.results) {
		const builder = plan.builders.get(register);
		if (builder !== undefined) deactivated.add(builder);
		if (value.kind === "prefix") {
			writes.push(`r${register} = r${plan.source};`);
		} else if (enums?.registers.has(register))
			writes.push(`${nativeStringEnumValue(register)} = ${enumTag(value)}U;`);
		else
			writes.push(
				`r${register} = ${inputs.representations[register] === "boolean" ? value.value : inputs.representations[register] === "number" || inputs.representations[register] === "int32" ? numberText(value.value as number) : constant(value)};`,
			);
	}
	return [
		`if (${cursor}.active && ${cursor}.string && ${cursor}.index == 0 && !${cursor}.done${guards.map((g) => ` && (${g})`).join("")}) {`,
		`  const MalString *${name} = mal_value_to_string(r${plan.source});`,
		`  if (${name}->latin1 && ${name}->storage < MAL_STRING_STORAGE_DEPENDENT && ${name}->length > 0 && ${name}->length <= MAL_LOCAL_STRING_BUILDER_CAPACITY) {`,
		`    usize ${name}_index = 0;`,
		`    for (; ${name}_index < ${name}->length; ${name}_index++) {`,
		`      c16 unit = mal_string_flat_code_unit_at(${name}, ${name}_index);`,
		...(plan.excludedUnits.length === 0
			? [`      (void) unit;`]
			: [
					`      if (${plan.excludedUnits.map((unit) => `unit == ${unit}U`).join(" || ")}) break;`,
				]),
		`    }`,
		`    if (${name}_index == ${name}->length) {`,
		...writes.map((line) => `      ${line}`),
		...[...deactivated].map((builder) => `      __sb_${builder}.active = false;`),
		`      ${cursor}.index = ${name}->length;`,
		`    }`,
		`  }`,
		`}`,
	];
}
