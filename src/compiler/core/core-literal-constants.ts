import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import {
	literalPrototypeMethods,
	literalPrototypeMethodIndex,
	provePrimordialAccess,
} from "../shared/builtin-registry.ts";
import type {
	LiteralPrototypeKey,
	LiteralReceiverKind,
} from "../shared/builtin-registry.ts";
import { invocationPreservesPrivateReceiver } from "../shared/builtin-semantics.ts";
import { scanLiteralTemplateSegment } from "../shared/literal-template-data.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreBlockId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface Use {
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

function definition(
	fn: CoreFunctionStore,
	value: CoreValueId,
): CoreInstructionId | undefined {
	return fn.kernel.valueDefinitionKind(value) === 1
		? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
		: undefined;
}

function result(fn: CoreFunctionStore, instruction: CoreInstructionId): CoreValueId {
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
}

function string(program: CoreProgram, index: number): string {
	return String.fromCharCode(...program.stringConstants[index]!);
}

function literalGraph(
	program: CoreProgram,
	fn: CoreFunctionStore,
	root: CoreInstructionId,
	uses: (value: CoreValueId) => ReadonlyArray<Use>,
): Literal | undefined {
	const allocations = new Set<CoreInstructionId>();
	const initializers = new Set<CoreInstructionId>();
	const words: Array<number> = [];
	const bits = new DataView(new ArrayBuffer(8));
	const pending: Array<{ value: CoreValueId } | { word: number }> = [
		{ value: result(fn, root) },
	];
	let array = false;
	while (pending.length > 0) {
		if (words.length > 16384) return undefined;
		const action = pending.pop()!;
		if ("word" in action) {
			words.push(action.word);
			continue;
		}
		const instruction = definition(fn, action.value);
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
				bits.setFloat64(0, attributes.value as number, true);
				words.push(4, bits.getUint32(0, true), bits.getUint32(4, true));
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
						const key = definition(fn, args[1]!);
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
	return { words, allocations, initializers, array };
}

function propertyName(
	program: CoreProgram,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): LiteralPrototypeKey | undefined {
	if (fn.instructionOpcodeName(instruction) === "loadPropertyStatic")
		return string(program, fn.instructionAttributes(instruction).stringIndex as number);
	if (fn.instructionOpcodeName(instruction) !== "loadProperty") return undefined;
	const key = definition(fn, operands(fn, instruction)[1]!);
	if (key === undefined || fn.instructionKind(key) !== "operation") return undefined;
	if (fn.instructionOpcodeName(key) === "createString")
		return string(program, fn.instructionAttributes(key).stringIndex as number);
	if (
		fn.instructionOpcodeName(key) !== "loadPropertyStatic" ||
		string(program, fn.instructionAttributes(key).stringIndex as number) !== "iterator"
	)
		return undefined;
	const symbol = definition(fn, operands(fn, key)[0]!);
	return symbol !== undefined &&
		fn.instructionOpcodeName(symbol) === "loadIntrinsic" &&
		fn.instructionAttributes(symbol).intrinsic === "Symbol"
		? Symbol.iterator
		: undefined;
}

function templateOwnKeys(data: ReadonlyArray<number>): ReadonlyArray<number> {
	if (data[0] !== 9) return [];
	const keys: Array<number> = [];
	let offset = 2;
	for (let index = 0; index < data[1]!; index++) {
		keys.push(data[offset + 1]!);
		offset = scanLiteralTemplateSegment(data, offset + 2, "literal property").endOffset;
	}
	return keys;
}

function receiverKind(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	literal: Literal | undefined,
): LiteralReceiverKind | undefined {
	switch (fn.instructionOpcodeName(instruction)) {
		case "createArray":
			return "array";
		case "createObject":
		case "createObjectShaped":
			return "object";
		case "instantiateLiteralTemplate":
			return literal === undefined ? undefined : literal.array ? "array" : "object";
		case "createString":
			return "string";
		case "createNumber":
		case "createF64":
		case "createI32":
			return "number";
		case "createBoolean":
			return "boolean";
		case "createBigint":
			return "bigint";
		default:
			return undefined;
	}
}

function shallowTemplate(data: ReadonlyArray<number>): boolean {
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

export const reuseLiteralConstants: CoreFunctionPass = {
	name: "reuse-literal-constants",
	stage: "memory",
	requiredFunctionOpcodesAny: ["loadPropertyStatic", "loadProperty"],
	admission: {
		predicate: "literal receiver with a statically named method in a locked world",
		hasOpportunity({ compilationContext }) {
			return (
				compilationContext.facts.world.primordialPolicy === "locked" &&
				!compilationContext.facts.world.realms
			);
		},
	},
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: ["body", "cfg"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, compilationContext, item } = context;
		if (
			compilationContext.facts.world.primordialPolicy !== "locked" ||
			compilationContext.facts.world.realms
		)
			return undefined;
		const fn = program.function(item.function);
		const roots = new Set<CoreInstructionId>();
		const propertyNames = new Map<CoreInstructionId, LiteralPrototypeKey>();
		for (const instruction of fn.instructionIds()) {
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode !== "loadPropertyStatic" && opcode !== "loadProperty") continue;
			const root = definition(
				fn,
				fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)),
			);
			if (
				root === undefined ||
				fn.instructionKind(root) !== "operation" ||
				(receiverKind(fn, root, undefined) === undefined &&
					fn.instructionOpcodeName(root) !== "instantiateLiteralTemplate")
			)
				continue;
			const name = propertyName(program, fn, instruction);
			if (name === undefined) continue;
			roots.add(root);
			propertyNames.set(instruction, name);
		}
		if (roots.size === 0) return undefined;
		const staticValues = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const useIndex = new Map<CoreValueId, ReadonlyArray<Use>>();
		const uses = (value: CoreValueId): ReadonlyArray<Use> => {
			const cached = useIndex.get(value);
			if (cached !== undefined) return cached;
			const entries: Array<Use> = [];
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				entries.push({
					instruction: fn.kernel.useInstruction(use),
					operand: fn.kernel.useOperand(use),
				});
			}
			entries.sort(
				(left, right) =>
					left.instruction - right.instruction || left.operand - right.operand,
			);
			useIndex.set(value, entries);
			return entries;
		};
		const blockOrders = new Map<CoreBlockId, Map<CoreInstructionId, number>>();
		const instructionOrder = (block: CoreBlockId): Map<CoreInstructionId, number> => {
			let order = blockOrders.get(block);
			if (order === undefined) {
				order = new Map();
				for (const instruction of fn.instructionIds(block))
					order.set(instruction, order.size);
				blockOrders.set(block, order);
			}
			return order;
		};
		let editor: CoreEditor | undefined;
		for (const root of roots) {
			if (!fn.isInstructionLive(root) || fn.instructionKind(root) !== "operation")
				continue;
			const literal = literalGraph(program, fn, root, uses);
			const kind = receiverKind(fn, root, literal);
			if (kind === undefined) continue;
			const receiver = result(fn, root);
			const staticValue = staticValues.query(receiver);
			if (staticValue.kind !== "known" || staticValue.brand !== kind) continue;
			staticValues.verify(staticValue);
			const properties = new Set<CoreInstructionId>();
			const calls = new Map<CoreInstructionId, number>();
			const block = fn.instructionBlock(root);
			for (const use of uses(receiver)) {
				if (use.operand !== 0) continue;
				const name = propertyNames.get(use.instruction);
				if (name === undefined) continue;
				const methodIndex = literalPrototypeMethodIndex(kind, name);
				if (methodIndex === undefined) continue;
				const ownKeys =
					literal === undefined
						? (fn.instructionAttributes(root).keyStringIndices as
								| ReadonlyArray<number>
								| undefined)
						: templateOwnKeys(literal.words);
				if (ownKeys?.some((index) => string(program, index) === name)) continue;
				const proof = provePrimordialAccess(
					compilationContext.facts.world,
					{
						kind:
							kind === "array" || kind === "object" ? "fresh-allocation" : "primitive",
						prototype: `MAL_INTRINSIC_${kind.toUpperCase()}_PROTOTYPE`,
						realm: "current",
						ownKeys: ownKeys?.map((index) => string(program, index)) ?? [],
						ownKeysComplete: true,
						stableUntilRead: true,
					},
					name === Symbol.iterator ? { symbol: "%Symbol.iterator%" } : name,
				);
				if (proof?.resolution?.value?.[0] !== literalPrototypeMethods[methodIndex]!.id)
					continue;
				const callee = result(fn, use.instruction);
				const callUses = uses(callee);
				if (
					fn.kernel.valueHandlerUseCount(callee) !== 0 ||
					callUses.length === 0 ||
					callUses.some(
						(callUse) =>
							callUse.operand !== 0 ||
							fn.instructionKind(callUse.instruction) !== "operation" ||
							fn.instructionOpcodeName(callUse.instruction) !== "call" ||
							operands(fn, callUse.instruction)[1] !== receiver,
					)
				)
					continue;
				properties.add(use.instruction);
				for (const callUse of callUses) calls.set(callUse.instruction, methodIndex);
			}
			const stableMethods =
				literal !== undefined &&
				uses(receiver).every(
					(use) =>
						literal.initializers.has(use.instruction) ||
						(properties.has(use.instruction) && use.operand === 0) ||
						(calls.has(use.instruction) &&
							use.operand === 1 &&
							invocationPreservesPrivateReceiver(
								literalPrototypeMethods[calls.get(use.instruction)!]!.semantics,
								true,
							)),
				);
			if ((kind === "array" || kind === "object") && !stableMethods) {
				const order = instructionOrder(block);
				for (const property of properties) {
					// Without whole-lifetime containment, an earlier write or escape can shadow the method.
					if (
						fn.instructionBlock(property) === block &&
						!uses(receiver).some(
							(use) =>
								use.instruction !== property &&
								!literal?.initializers.has(use.instruction) &&
								!properties.has(use.instruction) &&
								(fn.instructionBlock(use.instruction) !== block ||
									order.get(use.instruction)! < order.get(property)!),
						)
					)
						continue;
					properties.delete(property);
					for (const use of uses(result(fn, property))) calls.delete(use.instruction);
				}
			}
			if (calls.size === 0) continue;
			let reusable = literal !== undefined && literal.allocations.size > 0;
			if (literal !== undefined) {
				for (const methodIndex of calls.values()) {
					if (
						!invocationPreservesPrivateReceiver(
							literalPrototypeMethods[methodIndex]!.semantics,
							shallowTemplate(literal.words),
						)
					)
						reusable = false;
				}
				for (const allocation of literal.allocations) {
					const value = result(fn, allocation);
					if (fn.kernel.valueHandlerUseCount(value) !== 0) reusable = false;
					for (const use of uses(value)) {
						if (
							literal.initializers.has(use.instruction) ||
							literal.allocations.has(use.instruction) ||
							(allocation === root &&
								((properties.has(use.instruction) && use.operand === 0) ||
									(calls.has(use.instruction) && use.operand === 1)))
						)
							continue;
						reusable = false;
					}
				}
				for (const call of calls.keys())
					if (
						fn.instructionBlock(call) === block &&
						[...literal.initializers].some(
							(initializer) =>
								instructionOrder(block).get(initializer)! >=
								instructionOrder(block).get(call)!,
						)
					)
						reusable = false;
			}
			editor ??= CoreEditor.open(program, item.function);
			for (const [call, methodIndex] of calls) {
				editor.replaceInstruction(
					call,
					"callLiteralMethod",
					operands(fn, call).slice(1),
					{
						attributes: {
							methodIndex,
							worldAssumptions: {
								...builtinWorldAssumptions(
									literalPrototypeMethods[methodIndex]!.id,
									kind === "array" || kind === "object"
										? "literal-allocation"
										: "primitive",
									true,
								),
							},
						},
						sourcePosition: fn.instructionSourcePosition(call),
					},
				);
			}
			for (const property of properties) editor.removeInstruction(property);
			if (reusable && literal !== undefined) {
				const constant = editor.appendLiteralConstant(literal.words);
				for (const initializer of literal.initializers)
					editor.removeInstruction(initializer);
				editor.replaceInstruction(root, "instantiateLiteralTemplate", [], {
					attributes: constant,
					sourcePosition: fn.instructionSourcePosition(root),
				});
				for (const allocation of literal.allocations)
					if (allocation !== root) editor.removeInstruction(allocation);
			}
		}
		return editor?.commit();
	},
};
