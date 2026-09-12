import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import type { StaticMember, StaticPropertyDescription } from "../shared/static-values.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreStaticValue, CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

// The caller must prove a canonical call in the locked current realm.
export function coreStaticArrayCopyResult(
	program: CoreProgram,
	fn: CoreFunctionStore,
	analysis: CoreStaticValueAnalysis,
	instruction: CoreInstructionId,
	value: CoreValueId,
	operation: string,
	receiver: CoreValueId,
	args: ReadonlyArray<CoreValueId>,
): CoreStaticValue | undefined {
	if (
		args.length > 258 ||
		(operation !== "Array.prototype.toReversed" &&
			operation !== "Array.prototype.with" &&
			operation !== "Array.prototype.toSpliced" &&
			operation !== "Array.prototype.slice" &&
			operation !== "Array.prototype.concat" &&
			operation !== "Array.prototype.flat")
	)
		return undefined;
	const source = analysis.queryAt(receiver, instruction);
	if (source.kind !== "known") return undefined;
	const array = program.staticDescriptions.description(source.description);
	if (
		array.kind !== "array" ||
		array.length === null ||
		array.length > 256 ||
		array.properties.length > 4096 ||
		array.ownKeysComplete === false
	)
		return undefined;
	const length = array.length;
	const slice = operation === "Array.prototype.slice";
	const concat = operation === "Array.prototype.concat";
	const flat = operation === "Array.prototype.flat";
	const dependencies = [...source.environmentDependencies];
	let descriptorWork = array.properties.length;
	const sourceProperties = new Map(
		array.properties.map((property) => [property.key, property]),
	);
	if (slice || concat || flat) {
		descriptorWork += array.properties.length;
		if (descriptorWork > 4096) return undefined;
		const constructor = analysis.inherited(source, "constructor");
		// The locked intrinsic Array constructor keeps its default species getter.
		if (
			source.prototype.kind !== "intrinsic" ||
			source.prototype.id !== "Array.prototype" ||
			constructor?.kind !== "descriptor" ||
			constructor.resolution?.value?.[0] !== "Array" ||
			constructor.resolution.getter !== undefined
		)
			return undefined;
		dependencies.push(...constructor.dependencies);
	}
	const integer = (input: CoreValueId | undefined): number | undefined => {
		if (input === undefined) return 0;
		const constant = analysis.constant(input, instruction);
		// Copy bounds use ToNumber, which rejects BigInt even though Number accepts it.
		if (constant === undefined || constant.kind === "bigint") return undefined;
		const converted = evaluateConstantBuiltin("Number", undefined, [constant]);
		if (converted.kind !== "value" || converted.value.kind !== "number") return undefined;
		const number = converted.value.value;
		return Number.isNaN(number) || number === 0 ? 0 : Math.trunc(number);
	};
	const undefinedMember: StaticMember = {
		kind: "constant",
		description: program.staticDescriptions.intern({ kind: "undefined" }),
	};
	const operands = [...source.operands];
	const bind = (input: CoreValueId | undefined): StaticMember => {
		if (input === undefined) return undefinedMember;
		const fact = analysis.queryAt(input, instruction);
		if (
			fact.kind === "known" &&
			fact.state === "immutable-value" &&
			["undefined", "null", "boolean", "number", "string", "bigint"].includes(
				program.staticDescriptions.description(fact.description).kind,
			)
		)
			return { kind: "constant", description: fact.description };
		const index = operands.length;
		operands.push(input);
		return { kind: "operand", index };
	};
	const read = (index: number): StaticMember | undefined => {
		const key = String(index);
		const property = sourceProperties.get(key);
		if (property !== undefined)
			return property.descriptor.kind === "data" &&
				property.descriptor.value.kind !== "hole"
				? property.descriptor.value
				: undefined;
		if (source.prototype.kind !== "null") {
			descriptorWork += array.properties.length + 1;
			if (descriptorWork > 4096) return undefined;
			const inherited = analysis.inherited(source, key);
			if (inherited?.kind !== "absent") return undefined;
			dependencies.push(...inherited.dependencies);
		}
		return slice || flat ? { kind: "hole" } : undefinedMember;
	};
	let indexes: Array<number | StaticMember>;
	if (flat) {
		const depth =
			args[0] === undefined ||
			analysis.constant(args[0], instruction)?.kind === "undefined"
				? 1
				: integer(args[0]);
		if (depth === undefined) return undefined;
		indexes = [];
		if (depth <= 0) {
			for (let index = 0; index < length; index++) {
				const member = read(index);
				if (member === undefined) return undefined;
				if (member.kind !== "hole") indexes.push(member);
			}
		} else {
			const active = new Set<CoreValueId>();
			const flatten = (
				current: CoreStaticValue,
				remaining: number,
				level: number,
			): boolean => {
				if (level > 32 || active.has(current.value)) return false;
				const description = program.staticDescriptions.description(current.description);
				if (
					description.kind !== "array" ||
					description.length === null ||
					!Number.isSafeInteger(description.length) ||
					description.length < 0 ||
					description.length > 256 ||
					description.ownKeysComplete === false
				)
					return false;
				descriptorWork += 1 + (current === source ? 0 : description.properties.length);
				if (descriptorWork > 4096) return false;
				const properties =
					current === source
						? sourceProperties
						: new Map(description.properties.map((property) => [property.key, property]));
				active.add(current.value);
				dependencies.push(...current.environmentDependencies);
				for (let index = 0; index < description.length; index++) {
					if (++descriptorWork > 4096) return false;
					const key = String(index);
					const property = properties.get(key);
					if (property === undefined) {
						if (current.prototype.kind !== "null") {
							descriptorWork += description.properties.length + 1;
							if (descriptorWork > 4096) return false;
							const inherited = analysis.inherited(current, key);
							if (inherited?.kind !== "absent") return false;
							dependencies.push(...inherited.dependencies);
						}
						continue;
					}
					if (property.descriptor.kind !== "data") return false;
					const member = property.descriptor.value;
					let retained: StaticMember;
					if (member.kind === "operand") {
						const input = current.operands[member.index];
						if (input === undefined) return false;
						if (remaining > 0) {
							// Every child is observed at the call, after all argument evaluation.
							const child = analysis.queryAt(input, instruction);
							if (child.kind !== "known") return false;
							dependencies.push(...child.environmentDependencies);
							if (child.brand === "array") {
								if (!flatten(child, remaining - 1, level + 1)) return false;
								continue;
							}
						}
						retained = bind(input);
					} else if (
						member.kind === "constant" &&
						["undefined", "null", "boolean", "number", "string", "bigint"].includes(
							program.staticDescriptions.description(member.description).kind,
						)
					)
						retained = member;
					else return false;
					if (indexes.length === 256) return false;
					indexes.push(retained);
				}
				active.delete(current.value);
				return true;
			};
			if (!flatten(source, depth, 0)) return undefined;
		}
	} else if (concat) {
		indexes = [];
		for (const input of [receiver, ...args]) {
			const segment = input === receiver ? source : analysis.queryAt(input, instruction);
			if (segment.kind !== "known") return undefined;
			if (!["array", "object", "function"].includes(segment.brand)) {
				if (indexes.length === 256) return undefined;
				indexes.push(bind(input));
				continue;
			}
			const description = program.staticDescriptions.description(segment.description);
			if (
				(description.kind !== "array" && description.kind !== "object") ||
				description.ownKeysComplete === false
			)
				return undefined;
			descriptorWork += 2 * description.properties.length + 1;
			if (descriptorWork > 4096) return undefined;
			const spreadability = analysis.inherited(segment, {
				symbol: "%Symbol.isConcatSpreadable%",
			});
			if (spreadability?.kind !== "absent") return undefined;
			dependencies.push(
				...segment.environmentDependencies,
				...spreadability.dependencies,
			);
			if (description.kind === "object") {
				if (indexes.length === 256) return undefined;
				indexes.push(bind(input));
				continue;
			}
			if (
				description.length === null ||
				!Number.isSafeInteger(description.length) ||
				description.length < 0 ||
				description.length > 256 - indexes.length
			)
				return undefined;
			const properties = new Map(
				description.properties.map((property) => [property.key, property]),
			);
			for (let index = 0; index < description.length; index++) {
				const key = String(index),
					property = properties.get(key);
				if (property === undefined) {
					descriptorWork += description.properties.length + 1;
					if (descriptorWork > 4096) return undefined;
					const inherited = analysis.inherited(segment, key);
					if (inherited?.kind !== "absent") return undefined;
					dependencies.push(...inherited.dependencies);
					indexes.push({ kind: "hole" });
					continue;
				}
				if (property.descriptor.kind !== "data") return undefined;
				const member = property.descriptor.value;
				if (member.kind === "constant") indexes.push(member);
				else if (member.kind === "operand") {
					const operand = segment.operands[member.index];
					if (operand === undefined) return undefined;
					indexes.push(bind(operand));
				} else return undefined;
			}
		}
	} else if (operation === "Array.prototype.toReversed")
		indexes = Array.from({ length }, (_, index) => length - index - 1);
	else if (slice) {
		const bound = (input: CoreValueId | undefined, fallback: number) => {
			if (input === undefined) return fallback;
			const constant = analysis.constant(input, instruction);
			if (constant?.kind === "undefined") return fallback;
			const relative = integer(input);
			if (relative === undefined) return undefined;
			return relative < 0 ? Math.max(length + relative, 0) : Math.min(relative, length);
		};
		const start = bound(args[0], 0);
		const end = bound(args[1], length);
		if (start === undefined || end === undefined) return undefined;
		indexes = Array.from(
			{ length: Math.max(end - start, 0) },
			(_, index) => start + index,
		);
	} else if (operation === "Array.prototype.with") {
		const relative = integer(args[0]);
		if (relative === undefined) return undefined;
		const actual = relative < 0 ? length + relative : relative;
		if (actual < 0 || actual >= length) return undefined;
		const replacement = bind(args[1]);
		indexes = Array.from({ length }, (_, index) =>
			index === actual ? replacement : index,
		);
	} else {
		const relative = integer(args[0]);
		if (relative === undefined) return undefined;
		const start =
			relative < 0 ? Math.max(length + relative, 0) : Math.min(relative, length);
		const requested = args.length < 2 ? length - start : integer(args[1]);
		if (requested === undefined) return undefined;
		const removed =
			args.length === 0 ? 0 : Math.min(Math.max(requested, 0), length - start);
		const inserted = Math.max(args.length - 2, 0);
		if (length - removed + inserted > 256) return undefined;
		indexes = [
			...Array.from({ length: start }, (_, index) => index),
			...args.slice(2).map(bind),
			...Array.from(
				{ length: length - start - removed },
				(_, index) => start + removed + index,
			),
		];
	}
	const properties: Array<StaticPropertyDescription> = [];
	for (const [index, input] of indexes.entries()) {
		const member = typeof input === "number" ? read(input) : input;
		if ((slice || concat) && member?.kind === "hole") continue;
		if (member === undefined || member.kind === "hole" || member.kind === "unknown")
			return undefined;
		properties.push({
			key: String(index),
			enumerable: true,
			configurable: true,
			descriptor: { kind: "data", writable: true, value: member },
		});
	}
	const prototype = { kind: "intrinsic", id: "Array.prototype" } as const;
	return {
		kind: "known",
		value,
		description: program.staticDescriptions.intern({
			kind: "array",
			prototype,
			length: indexes.length,
			properties,
			ownKeysComplete: true,
		}),
		brand: "array",
		exactBrand: "Array",
		prototype,
		identity: { kind: "fresh-per-evaluation", function: fn.id, value },
		construction: { kind: "call", callee: operation, instruction, arguments: args },
		state: "initial-allocation",
		operands,
		allocationIdentities: source.allocationIdentities,
		environmentDependencies: [
			...new Set([...dependencies, "primordials.locked", "realm.current"]),
		],
	};
}
