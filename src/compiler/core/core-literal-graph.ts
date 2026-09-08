import { scanLiteralTemplateSegment } from "../shared/literal-template-data.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export interface LiteralUse {
	readonly instruction: CoreInstructionId;
	readonly operand: number;
}
interface Literal {
	readonly words: ReadonlyArray<number>;
	readonly allocations: ReadonlySet<CoreInstructionId>;
	readonly initializers: ReadonlySet<CoreInstructionId>;
	readonly array: boolean;
}

function operands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	return Array.from({ length: fn.kernel.instructionOperandCount(instruction) }, (_, i) =>
		fn.kernel.operandAt(start + i),
	);
}

export function literalDefinition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

export function literalResult(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): CoreValueId {
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
}

export function literalGraph(
	program: CoreProgram,
	fn: CoreFunctionStore,
	root: CoreInstructionId,
	uses: (value: CoreValueId) => ReadonlyArray<LiteralUse>,
): Literal | undefined {
	const allocations = new Set<CoreInstructionId>();
	const initializers = new Set<CoreInstructionId>();
	const words: Array<number> = [];
	const bits = new DataView(new ArrayBuffer(8));
	const pending: Array<{ value: CoreValueId } | { word: number }> = [
		{ value: literalResult(fn, root) },
	];
	let array = false;
	while (pending.length > 0) {
		if (words.length > 16384) return undefined;
		const action = pending.pop()!;
		if ("word" in action) {
			words.push(action.word);
			continue;
		}
		const instruction = literalDefinition(fn, action.value);
		if (instruction === undefined || fn.instructionKind(instruction) !== "operation")
			return undefined;
		const opcode = fn.instructionOpcodeName(instruction);
		const attributes = fn.instructionAttributes(instruction);
		switch (opcode) {
			case "createUndefined":
				words.push(11);
				break;
			case "createNull":
				words.push(0);
				break;
			case "createBoolean":
				words.push(attributes.value ? 2 : 1);
				break;
			case "createI32":
			case "createF64":
			case "createNumber": {
				const number = attributes.value as number;
				if (
					Number.isInteger(number) &&
					number >= -2147483648 &&
					number <= 2147483647 &&
					!Object.is(number, -0)
				)
					words.push(3, number >>> 0);
				else {
					bits.setFloat64(0, number, true);
					words.push(4, bits.getUint32(0, true), bits.getUint32(4, true));
				}
				break;
			}
			case "createString":
				words.push(5, attributes.stringIndex as number);
				break;
			case "createBigint":
				words.push(6, attributes.bigintIndex as number);
				break;
			case "createArray":
			case "createObjectShaped":
			case "createObject":
			case "instantiateLiteralTemplate": {
				// Shared children and cyclic graphs have observable identity beyond a literal tree.
				if (
					allocations.has(instruction) ||
					fn.instructionBlock(instruction) !== fn.instructionBlock(root)
				)
					return undefined;
				allocations.add(instruction);
				if (opcode === "instantiateLiteralTemplate") {
					if (attributes.cacheSlot !== undefined) return undefined;
					const offset = attributes.templateOffset as number;
					const segment = scanLiteralTemplateSegment(
						program.literalTemplateData,
						offset,
						"Core literal constant",
					);
					const data = program.literalTemplateData.slice(offset, segment.endOffset);
					if (words.length + data.length > 16384) return undefined;
					if (instruction === root) array = data[0] === 8;
					words.push(...data);
					break;
				}
				if (instruction === root) array = opcode === "createArray";
				if (opcode === "createArray") {
					const length = attributes.length as number;
					if (!Number.isSafeInteger(length) || length < 0 || length > 4096)
						return undefined;
					const elements = new Map<number, CoreValueId>();
					for (const use of uses(action.value)) {
						if (
							fn.instructionKind(use.instruction) !== "operation" ||
							fn.instructionOpcodeName(use.instruction) !== "defineProperty" ||
							use.operand !== 0
						)
							continue;
						if (fn.instructionBlock(use.instruction) !== fn.instructionBlock(root))
							return undefined;
						const args = operands(fn, use.instruction);
						const key = literalDefinition(fn, args[1]!);
						if (
							key === undefined ||
							!["createNumber", "createI32", "createF64"].includes(
								fn.instructionOpcodeName(key),
							)
						)
							return undefined;
						const index = fn.instructionAttributes(key).value as number;
						if (
							!Number.isInteger(index) ||
							index < 0 ||
							index >= length ||
							elements.has(index) ||
							args.length !== 3 ||
							fn.instructionAttributes(use.instruction).enumerable !== true
						)
							return undefined;
						elements.set(index, args[2]!);
						initializers.add(use.instruction);
					}
					words.push(8, length);
					for (let i = length - 1; i >= 0; i--) {
						const value = elements.get(i);
						pending.push(value === undefined ? { word: 7 } : { value });
					}
				} else {
					const keys = (attributes.keyStringIndices ?? []) as ReadonlyArray<number>;
					const values = operands(fn, instruction);
					if (keys.length !== values.length) return undefined;
					words.push(9, keys.length);
					for (let i = keys.length - 1; i >= 0; i--) {
						pending.push({ value: values[i]! }, { word: keys[i]! }, { word: 10 });
					}
				}
				break;
			}
			default:
				return undefined;
		}
	}
	return words.length <= 16384 ? { words, allocations, initializers, array } : undefined;
}

export function shallowTemplate(data: ReadonlyArray<number>): boolean {
	let containers = 0;
	const actions: Array<"node" | "key"> = ["node"];
	let offset = 0;
	while (actions.length > 0) {
		if (actions.pop() === "key") {
			offset += 2;
			actions.push("node");
			continue;
		}
		const tag = data[offset++];
		if (tag === 3 || tag === 5 || tag === 6) offset++;
		else if (tag === 4) offset += 2;
		else if (tag === 8 || tag === 9) {
			if (++containers > 1) return false;
			const count = data[offset++]!;
			for (let i = 0; i < count; i++) actions.push(tag === 8 ? "node" : "key");
		}
	}
	return true;
}
