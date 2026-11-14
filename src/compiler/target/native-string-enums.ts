import type { NativeStringBuilderInputs } from "./native-string-builders.ts";
import type { NativeFunctionPlan, VmRegisterRepresentation } from "./program-image.ts";
import {
	decodeVmValueOperand,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction, BytecodeInstruction } from "./runtime-image.ts";

export interface NativeStringEnumPlan {
	readonly registers: ReadonlySet<number>;
	readonly literals: ReadonlyMap<number, number>;
	readonly domains: ReadonlyMap<number, ReadonlyArray<number>>;
	readonly literalRows: ReadonlyMap<number, number>;
	readonly observations: ReadonlyMap<number, ReadonlyArray<number>>;
	readonly operations: ReadonlyMap<number, NativeStringEnumOperation>;
	readonly switches: ReadonlyMap<number, number>;
}

type NativeStringEnumOperation =
	| { readonly kind: "define"; readonly destination: number; readonly value: string }
	| {
			readonly kind: "compare";
			readonly left: string;
			readonly right: string;
			readonly negated: boolean;
	  };

export const nativeStringEnumValue = (register: number): string =>
	`__string_enum_${register}`;

// The closed definition graph contains only literal strings and copies. Tag zero
// preserves an uninitialized VM local's undefined value; equal literal contents
// share a tag even when composed images keep different constant rows.
export function selectNativeStringEnums(
	fn: BytecodeFunction,
	inputs: NativeStringBuilderInputs,
	switches: ReadonlyArray<NonNullable<NativeFunctionPlan["literalSwitches"]>[number]>,
): NativeStringEnumPlan | undefined {
	const definitions = new Map<number, Array<number>>();
	const claimed = new Set(inputs.foldedPlans.flatMap((plan) => plan.claimedIps));
	for (const [ip, op] of fn.instructions.entries())
		for (const register of vmInstructionWriteRegisters(op)) {
			const list = definitions.get(register) ?? [];
			list.push(ip);
			definitions.set(register, list);
		}
	const candidates = new Set(
		[...definitions.keys()].filter(
			(register) =>
				register >= fn.parameterCount + fn.argumentSnapshotCount &&
				!inputs.deferredReads.has(register) &&
				(inputs.representations[register] === "boxed" ||
					inputs.representations[register] === "string") &&
				definitions.get(register)!.every((ip) => {
					const op = fn.instructions[ip]!;
					return (
						!inputs.skippedIps.has(ip) &&
						!inputs.actionIps.has(ip) &&
						!claimed.has(ip) &&
						(op.opcode === "CREATE_STRING" || op.opcode === "MOVE")
					);
				}),
		),
	);
	let remaining = Math.max(4096, fn.instructions.length * 8);
	for (let changed = true; changed;) {
		changed = false;
		for (const register of candidates)
			if (
				definitions.get(register)!.some((ip) => {
					if (remaining-- <= 0) return true;
					const op = fn.instructions[ip]!;
					if (op.opcode === "CREATE_STRING")
						return inputs.stringConstants[op.stringIndex] === undefined;
					if (op.opcode !== "MOVE") return true;
					const source = decodeVmValueOperand(op.src);
					return source.kind === "register"
						? !candidates.has(source.register)
						: source.kind !== "string" ||
								inputs.stringConstants[source.index] === undefined;
				})
			) {
				candidates.delete(register);
				changed = true;
			}
		if (remaining <= 0) return undefined;
	}
	if (candidates.size === 0) return undefined;
	const parent = new Map([...candidates].map((register) => [register, register]));
	const find = (register: number): number => {
		let root = register;
		while (parent.get(root) !== root) root = parent.get(root)!;
		parent.set(register, root);
		return root;
	};
	for (const register of candidates)
		for (const ip of definitions.get(register)!) {
			const op = fn.instructions[ip]!;
			if (op.opcode === "MOVE" && candidates.has(op.src))
				parent.set(find(register), find(op.src));
		}
	const texts = new Map<string, number>();
	const literals = new Map<number, number>();
	const literalRows = new Map<number, number>();
	const referenced = new Set<number>();
	for (const op of fn.instructions) {
		if (op.opcode === "CREATE_STRING") referenced.add(op.stringIndex);
		else if (op.opcode === "MOVE") {
			const value = decodeVmValueOperand(op.src);
			if (value.kind === "string") referenced.add(value.index);
		} else if (op.opcode === "BINARY") {
			for (const operand of [op.left, op.right]) {
				const value = decodeVmValueOperand(operand);
				if (value.kind === "string") referenced.add(value.index);
			}
		}
	}
	for (const site of switches)
		if (site.kind === "string")
			for (const label of site.cases) referenced.add(label.stringIndex);
	for (const index of referenced) {
		const units = inputs.stringConstants[index];
		if (units === undefined) continue;
		const text = units.join(",");
		let tag = texts.get(text);
		if (tag === undefined) texts.set(text, (tag = texts.size + 1));
		literals.set(index, tag);
		literalRows.set(tag, index);
	}
	const domains = new Map<number, Set<number>>();
	for (const register of candidates) {
		const root = find(register);
		const domain = domains.get(root) ?? new Set<number>();
		for (const ip of definitions.get(register)!) {
			const op = fn.instructions[ip]!;
			const source = op.opcode === "MOVE" ? decodeVmValueOperand(op.src) : undefined;
			const index =
				op.opcode === "CREATE_STRING"
					? op.stringIndex
					: source?.kind === "string"
						? source.index
						: undefined;
			if (index !== undefined) domain.add(literals.get(index)!);
		}
		domains.set(root, domain);
	}
	const profitable = new Set<number>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (inputs.loopInstructions[ip] !== 1) continue;
		if (op.opcode === "BINARY" && (op.operator === "===" || op.operator === "!=="))
			for (const register of [op.left, op.right])
				if (candidates.has(register)) profitable.add(find(register));
	}
	const registers = new Set(
		[...candidates].filter((register) => {
			const domain = domains.get(find(register))!;
			return domain.size >= 2 && domain.size <= 16 && profitable.has(find(register));
		}),
	);
	if (registers.size === 0 || registers.size > 128) return undefined;
	const operations = new Map<number, NativeStringEnumOperation>();
	const observations = new Map<number, Array<number>>();
	const enumSwitches = new Map<number, number>();
	const observed = (ip: number, register: number) => {
		const list = observations.get(ip) ?? [];
		if (!list.includes(register)) list.push(register);
		observations.set(ip, list);
	};
	const literalOperand = (ip: number, register: number): string | undefined => {
		if (registers.has(register)) return nativeStringEnumValue(register);
		const value = decodeVmValueOperand(register);
		if (value.kind === "string") return `${literals.get(value.index)}U`;
		if (!candidates.has(register) || !inputs.provenString(ip, register)) return undefined;
		const domain = domains.get(find(register))!;
		return domain.size === 1 ? `${[...domain][0]}U` : undefined;
	};
	const switchAt = new Map(switches.map((site) => [site.instructionIp, site]));
	for (const [ip, op] of fn.instructions.entries()) {
		if (inputs.skippedIps.has(ip)) continue;
		const site = switchAt.get(ip);
		const consumed = new Set<number>();
		if (site?.kind === "string" && registers.has(site.selector)) {
			enumSwitches.set(ip, site.selector);
			consumed.add(site.selector);
		} else if ("dst" in op && registers.has(op.dst)) {
			if (op.opcode === "CREATE_STRING")
				operations.set(ip, {
					kind: "define",
					destination: op.dst,
					value: `${literals.get(op.stringIndex)}U`,
				});
			else if (op.opcode === "MOVE") {
				operations.set(ip, {
					kind: "define",
					destination: op.dst,
					value: literalOperand(ip, op.src)!,
				});
				consumed.add(op.src);
			}
		} else if (
			op.opcode === "BINARY" &&
			(op.operator === "===" || op.operator === "!==") &&
			(registers.has(op.left) || registers.has(op.right))
		) {
			const left = literalOperand(ip, op.left),
				right = literalOperand(ip, op.right);
			if (left !== undefined && right !== undefined) {
				operations.set(ip, {
					kind: "compare",
					left,
					right,
					negated: op.operator === "!==",
				});
				consumed.add(op.left);
				consumed.add(op.right);
			}
		}
		for (const register of inputs.forcedReads.get(ip) ?? vmInstructionReadRegisters(op))
			if (registers.has(register) && !consumed.has(register)) observed(ip, register);
	}
	for (const plan of inputs.foldedPlans)
		for (const register of registers)
			if (
				plan.claimedIps.some((ip) =>
					vmInstructionReadRegisters(fn.instructions[ip]!).includes(register),
				)
			)
				for (const ip of plan.syncIps) observed(ip, register);
	return {
		registers,
		literals,
		literalRows,
		domains: new Map(
			[...registers].map((register) => [register, [...domains.get(find(register))!]]),
		),
		observations,
		operations,
		switches: enumSwitches,
	};
}

export function nativeStringEnumDeclarations(
	plan: NativeStringEnumPlan | undefined,
): ReadonlyArray<string> {
	return [...(plan?.registers ?? [])].map(
		(register) => `u32 ${nativeStringEnumValue(register)} = 0;`,
	);
}

export function materializeNativeStringEnum(
	plan: NativeStringEnumPlan,
	register: number,
	stringValue: (index: number) => string,
): ReadonlyArray<string> {
	const lines = [
		"MAL_PERF_COUNT(string_enum_materializations);",
		`switch (${nativeStringEnumValue(register)}) {`,
	];
	for (const tag of plan.domains.get(register)!) {
		const index = plan.literalRows.get(tag)!;
		lines.push(`case ${tag}U: r${register} = ${stringValue(index)}; break;`);
	}
	lines.push(`default: r${register} = MAL_VALUE_UNDEFINED; break;`, "}");
	return lines;
}

export function renderNativeStringEnumOperation(
	operation: NativeStringEnumOperation | undefined,
	op: BytecodeInstruction,
	ordinary: ReadonlyArray<string>,
	representations: ReadonlyArray<VmRegisterRepresentation>,
): ReadonlyArray<string> {
	if (operation?.kind === "define")
		return [`${nativeStringEnumValue(operation.destination)} = ${operation.value};`];
	if (operation?.kind !== "compare" || op.opcode !== "BINARY") return ordinary;
	const expression = `${operation.left} ${operation.negated ? "!=" : "=="} ${operation.right}`;
	return [
		"MAL_PERF_COUNT(string_enum_comparisons);",
		`r${op.dst} = ${representations[op.dst] === "boolean" ? expression : `mal_value_new_boolean(${expression})`};`,
	];
}
