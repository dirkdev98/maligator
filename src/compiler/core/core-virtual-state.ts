import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreMaterializationPlan } from "./core-materialization-demands.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import { coreStaticMemberOperation } from "./core-static-value-selection.ts";
import type { CoreStaticMemberOperation } from "./core-static-value-selection.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";

const LIMIT = 64;
const MATERIALIZED = "virtualStateMaterialized";
const CONSTANTS = new Set([
	"createNumber",
	"createI32",
	"createF64",
	"createBoolean",
	"createUndefined",
	"createNull",
	"createString",
	"createBigint",
]);
type Cell = CoreStaticMemberOperation;
const undefinedCell: Cell = { opcode: "createUndefined", inputs: [] };
const numberCell = (value: number): Cell => ({
	opcode: "createNumber",
	inputs: [],
	attributes: { value },
});
const valueCell = (value: CoreValueId): Cell => ({
	opcode: "move",
	inputs: [value],
});

export const materializeVirtualState: CoreFunctionPass = {
	name: "materialize-virtual-state",
	stage: "memory",
	requiredFunctionOpcodesAny: [
		"createArray",
		"createObject",
		"createObjectShaped",
		"callKnown",
	],
	admission: {
		predicate: "bounded fresh aggregate with local state observations in a locked world",
		hasOpportunity({ compilationContext }) {
			return (
				compilationContext.facts.world.primordialPolicy === "locked" &&
				!compilationContext.facts.world.realms
			);
		},
	},
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item } = context,
			fn = program.function(item.function);
		const analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		let visits = 0;
		const argsOf = (instruction: CoreInstructionId) =>
			Array.from({ length: fn.kernel.instructionOperandCount(instruction) }, (_, index) =>
				fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
			);
		for (const root of fn.instructionIds()) {
			if (++visits > 4096) return undefined;
			if (fn.instructionKind(root) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(root),
				attributes = fn.instructionAttributes(root);
			const wrapper =
				opcode === "callKnown" &&
				attributes.argumentMode === undefined &&
				(attributes.operation === "Object" ||
					(attributes.construct &&
						["Boolean", "Number", "String"].includes(attributes.operation as string)));
			const arrayResult =
				opcode === "callKnown" &&
				attributes.argumentMode === undefined &&
				!attributes.construct &&
				[
					"Array.of",
					"Array.prototype.toReversed",
					"Array.prototype.with",
					"Array.prototype.toSpliced",
					"Array.prototype.slice",
					"Array.prototype.concat",
					"Array.prototype.flat",
					"String.prototype.split",
				].includes(attributes.operation as string);
			if (
				(!wrapper &&
					!arrayResult &&
					!["createArray", "createObject", "createObjectShaped"].includes(opcode)) ||
				attributes[MATERIALIZED]
			)
				continue;
			const block = fn.instructionBlock(root);
			if (fn.kernel.blockHandlerBlock(block) !== undefined) continue;
			const value = fn.kernel.resultAt(fn.kernel.instructionResultStart(root));
			const demand = coreMaterializationPlan(fn, value);
			if (demand.demands.some((use) => use.reason === "exception-handler-storage"))
				continue;
			const fact = analysis.query(value);
			if (fact.kind !== "known") continue;
			const producedCells = new Map<string, Cell>();
			let resultLength = 0;
			if (arrayResult) {
				const description = program.staticDescriptions.description(fact.description);
				if (
					fact.construction?.instruction !== root ||
					description.kind !== "array" ||
					description.length === null ||
					!Number.isSafeInteger(description.length) ||
					description.length < 0 ||
					description.length > LIMIT ||
					description.ownKeysComplete !== true ||
					description.prototype.kind !== "intrinsic" ||
					description.prototype.id !== "Array.prototype"
				)
					continue;
				resultLength = description.length;
				for (const property of description.properties) {
					if (
						typeof property.key !== "string" ||
						property.descriptor.kind !== "data" ||
						!property.descriptor.writable ||
						!property.enumerable ||
						!property.configurable ||
						!/^(0|[1-9][0-9]*)$/.test(property.key) ||
						Number(property.key) >= description.length
					)
						break;
					const cell = coreStaticMemberOperation(
						program,
						property.descriptor.value,
						fact.operands,
					);
					if (cell === undefined) break;
					producedCells.set(property.key, cell);
				}
				// Missing indexes in a complete description are holes, not undefined cells.
				if (producedCells.size !== description.properties.length) continue;
			}
			let conversion: Cell | undefined;
			if (wrapper) {
				if (
					fact.construction?.instruction !== root ||
					!["Boolean", "Number", "String", "BigInt", "Symbol"].includes(
						fact.exactBrand ?? "",
					)
				)
					continue;
				const input = fact.construction.arguments[0];
				if (
					(attributes.operation === "Number" || attributes.operation === "String") &&
					input !== undefined
				) {
					const payload = analysis.queryAt(input, root);
					if (
						payload.kind !== "known" ||
						payload.brand !== attributes.operation.toLowerCase()
					)
						conversion =
							attributes.operation === "String"
								? {
										opcode: "unary",
										inputs: [input],
										attributes: { operator: "tostring" },
									}
								: {
										opcode: "callKnown",
										inputs: argsOf(root).slice(0, 2),
										attributes: { ...attributes, construct: false },
									};
				}
			}
			const stringWrapper = wrapper && fact.exactBrand === "String";
			const array = opcode === "createArray" || arrayResult;
			let length = arrayResult ? resultLength : array ? (attributes.length as number) : 0;
			if (!Number.isSafeInteger(length) || length < 0 || length > LIMIT) continue;
			const initializers = new Set<CoreInstructionId>();
			const keyConversions = new Set<CoreInstructionId>();
			const initializationOnly =
				!stringWrapper &&
				demand.demands.length <= LIMIT &&
				demand.demands.every((use) => {
					if (
						fn.instructionBlock(use.instruction) !== block ||
						fn.instructionKind(use.instruction) !== "operation"
					)
						return false;
					const op = fn.instructionOpcodeName(use.instruction);
					if (op === "move" && use.kind === "alias") {
						initializers.add(use.instruction);
						return true;
					}
					const attrs = fn.instructionAttributes(use.instruction);
					if (
						(op !== "defineProperty" && op !== "defineAccessor") ||
						use.operand !== 0 ||
						attrs.enumerable !== true ||
						attrs.writable === false ||
						attrs.configurable === false
					)
						return false;
					const key = argsOf(use.instruction)[1]!;
					if (array) {
						const constant = analysis.constant(key);
						const index =
							constant?.kind === "number"
								? constant.value
								: constant?.kind === "string" && /^(0|[1-9][0-9]*)$/.test(constant.value)
									? Number(constant.value)
									: NaN;
						if (!Number.isInteger(index) || index < 0 || index >= 0xffffffff)
							return false;
					}
					if (
						fn.kernel.valueDefinitionKind(key) === 1 &&
						fn.instructionOpcodeName(
							coreInstructionId(fn.kernel.valueDefinitionOwner(key)),
						) === "toPropertyKey"
					) {
						initializers.add(use.instruction);
						return true;
					}
					const keyFact = analysis.query(key);
					if (
						keyFact.kind !== "known" ||
						![
							"undefined",
							"null",
							"boolean",
							"number",
							"string",
							"bigint",
							"symbol",
						].includes(keyFact.brand)
					)
						keyConversions.add(use.instruction);
					initializers.add(use.instruction);
					return true;
				});
			if (
				initializationOnly &&
				initializers.size +
					keyConversions.size * 2 +
					1 +
					Number(conversion !== undefined) <=
					context.remainingEdits
			) {
				const editor = CoreEditor.open(program, fn.id);
				if (conversion !== undefined)
					editor.insertInstruction(block, root, conversion.opcode, conversion.inputs, {
						attributes: conversion.attributes,
						sourcePosition: fn.instructionSourcePosition(root),
					});
				// A discarded ordinary object still owes observable computed-key coercions.
				for (const instruction of keyConversions) {
					const sourcePosition = fn.instructionSourcePosition(instruction);
					const coercible = editor.insertInstruction(
						block,
						instruction,
						"createBoolean",
						[],
						{ attributes: { value: true }, sourcePosition },
					).outputs[0]!;
					editor.insertInstruction(
						block,
						instruction,
						"toPropertyKey",
						[coercible, argsOf(instruction)[1]!],
						{ sourcePosition },
					);
				}
				for (const instruction of initializers) editor.removeInstruction(instruction);
				editor.removeInstruction(root);
				return editor.commit();
			}
			const cells = new Map(producedCells);
			if (opcode === "createObjectShaped") {
				const keys = attributes.keyStringIndices as ReadonlyArray<number>,
					args = argsOf(root);
				if (keys.length > LIMIT) continue;
				for (let index = 0; index < keys.length; index++)
					cells.set(analysis.string(keys[index]!), valueCell(args[index]!));
			}
			const aliases = new Set([value]),
				removals = new Set<CoreInstructionId>();
			const replacements = new Map<CoreInstructionId, Cell>();
			let boundary: CoreInstructionId | undefined,
				started = false,
				transitions = 0;
			const absent = (key: string) => analysis.inherited(fact, key)?.kind === "absent";
			for (const instruction of fn.instructionIds(block)) {
				if (++visits > 4096) return undefined;
				if (instruction === root) {
					started = true;
					continue;
				}
				if (!started) continue;
				const args = argsOf(instruction),
					touches = args.some((input) => aliases.has(input));
				if (fn.instructionKind(instruction) !== "operation") {
					boundary = instruction;
					break;
				}
				const op = fn.instructionOpcodeName(instruction),
					attrs = fn.instructionAttributes(instruction);
				if (!touches) {
					if (CONSTANTS.has(op)) continue;
					const effects = coreInstructionEffects(fn, instruction);
					if (effects.mayGc || effects.callsUserCode || effects.maySuspend) {
						boundary = instruction;
						break;
					}
					continue;
				}
				if (op === "move" && aliases.has(args[0]!)) {
					const alias = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
					if (fn.kernel.valueHandlerUseCount(alias) !== 0) {
						boundary = root;
						break;
					}
					aliases.add(alias);
					removals.add(instruction);
					continue;
				}
				if (!aliases.has(args[0]!) || args.slice(1).some((input) => aliases.has(input))) {
					boundary = instruction;
					break;
				}
				if (
					array &&
					op === "callKnown" &&
					!attrs.construct &&
					attrs.argumentMode === undefined
				) {
					if (
						attrs.operation === "Array.prototype.push" &&
						length + args.length - 1 <= LIMIT &&
						args.slice(1).every((_, index) => absent(String(length + index)))
					) {
						for (const input of args.slice(1))
							cells.set(String(length++), valueCell(input));
						replacements.set(instruction, numberCell(length));
						transitions++;
						continue;
					}
					if (
						attrs.operation === "Array.prototype.pop" &&
						(length === 0 || cells.has(String(length - 1)) || absent(String(length - 1)))
					) {
						const key = String(length - 1);
						replacements.set(
							instruction,
							length === 0 ? undefinedCell : (cells.get(key) ?? undefinedCell),
						);
						if (length > 0) {
							cells.delete(key);
							length--;
						}
						transitions++;
						continue;
					}
					if (attrs.operation === "Array.prototype.unshift") {
						const count = args.length - 1;
						let shiftable = length + count <= LIMIT;
						for (
							let index = 0;
							shiftable && count > 0 && index < length + count;
							index++
						) {
							const key = String(index);
							if (!cells.has(key) && !absent(key)) shiftable = false;
						}
						if (shiftable) {
							if (count > 0) {
								for (let index = length - 1; index >= 0; index--) {
									const cell = cells.get(String(index)),
										key = String(index + count);
									if (cell === undefined) cells.delete(key);
									else cells.set(key, cell);
								}
								for (let index = 0; index < count; index++)
									cells.set(String(index), valueCell(args[index + 1]!));
								length += count;
							}
							replacements.set(instruction, numberCell(length));
							transitions++;
							continue;
						}
					}
					if (attrs.operation === "Array.prototype.shift") {
						let shiftable = true;
						for (let index = 0; index < length; index++) {
							const key = String(index);
							if (!cells.has(key) && !absent(key)) {
								shiftable = false;
								break;
							}
						}
						if (shiftable) {
							replacements.set(
								instruction,
								length === 0 ? undefinedCell : (cells.get("0") ?? undefinedCell),
							);
							for (let index = 1; index < length; index++) {
								const cell = cells.get(String(index)),
									key = String(index - 1);
								if (cell === undefined) cells.delete(key);
								else cells.set(key, cell);
							}
							if (length > 0) cells.delete(String(--length));
							transitions++;
							continue;
						}
					}
					if (
						attrs.operation === "Array.prototype.fill" ||
						attrs.operation === "Array.prototype.copyWithin"
					) {
						const bound = (input: CoreValueId | undefined, fallback: number) => {
							if (input === undefined) return fallback;
							const constant = analysis.constant(input, instruction);
							if (constant?.kind === "undefined") return fallback;
							// Array bounds use ToNumber, which rejects BigInt unlike Number().
							if (constant === undefined || constant.kind === "bigint") return undefined;
							const converted = evaluateConstantBuiltin("Number", undefined, [constant]);
							if (converted.kind !== "value" || converted.value.kind !== "number")
								return undefined;
							const number = converted.value.value;
							const relative =
								Number.isNaN(number) || number === 0 ? 0 : Math.trunc(number);
							return relative < 0
								? Math.max(length + relative, 0)
								: Math.min(relative, length);
						};
						if (attrs.operation === "Array.prototype.copyWithin") {
							const target = bound(args[1], 0),
								start = bound(args[2], 0),
								end = bound(args[3], length);
							if (target !== undefined && start !== undefined && end !== undefined) {
								const count = Math.min(Math.max(end - start, 0), length - target);
								let copyable = true;
								for (let offset = 0; offset < count; offset++) {
									const source = String(start + offset),
										destination = String(target + offset);
									if (
										(!cells.has(source) && !absent(source)) ||
										(cells.has(source) && !cells.has(destination) && !absent(destination))
									) {
										copyable = false;
										break;
									}
								}
								if (copyable) {
									const alias = fn.kernel.resultAt(
										fn.kernel.instructionResultStart(instruction),
									);
									if (fn.kernel.valueHandlerUseCount(alias) !== 0) {
										boundary = root;
										break;
									}
									const backward = start < target && target < start + count;
									for (let step = 0; step < count; step++) {
										const offset = backward ? count - step - 1 : step,
											cell = cells.get(String(start + offset)),
											key = String(target + offset);
										if (cell === undefined) cells.delete(key);
										else cells.set(key, cell);
									}
									aliases.add(alias);
									removals.add(instruction);
									transitions++;
									continue;
								}
							}
							boundary = instruction;
							break;
						}
						const start = bound(args[2], 0),
							end = bound(args[3], length);
						if (start !== undefined && end !== undefined) {
							let fillable = true;
							for (let index = start; index < end; index++) {
								const key = String(index);
								if (!cells.has(key) && !absent(key)) {
									fillable = false;
									break;
								}
							}
							if (fillable) {
								const alias = fn.kernel.resultAt(
									fn.kernel.instructionResultStart(instruction),
								);
								if (fn.kernel.valueHandlerUseCount(alias) !== 0) {
									boundary = root;
									break;
								}
								const cell = args[1] === undefined ? undefinedCell : valueCell(args[1]);
								for (let index = start; index < end; index++)
									cells.set(String(index), cell);
								aliases.add(alias);
								removals.add(instruction);
								transitions++;
								continue;
							}
						}
					}
					if (attrs.operation === "Array.prototype.reverse") {
						let reversible = true;
						for (let lower = 0; lower < Math.floor(length / 2); lower++) {
							const low = String(lower),
								high = String(length - lower - 1);
							if (
								(!cells.has(low) && !absent(low)) ||
								(!cells.has(high) && !absent(high))
							) {
								reversible = false;
								break;
							}
						}
						if (reversible) {
							const alias = fn.kernel.resultAt(
								fn.kernel.instructionResultStart(instruction),
							);
							if (fn.kernel.valueHandlerUseCount(alias) !== 0) {
								boundary = root;
								break;
							}
							// Prove every endpoint before applying any swap; a failed proof keeps the whole call.
							for (let lower = 0; lower < Math.floor(length / 2); lower++) {
								const low = String(lower),
									high = String(length - lower - 1),
									left = cells.get(low),
									right = cells.get(high);
								if (right === undefined) cells.delete(low);
								else cells.set(low, right);
								if (left === undefined) cells.delete(high);
								else cells.set(high, left);
							}
							aliases.add(alias);
							removals.add(instruction);
							transitions++;
							continue;
						}
					}
				}
				if (
					![
						"defineProperty",
						"storeProperty",
						"storePropertyStatic",
						"loadProperty",
						"loadPropertyStatic",
						"deleteProperty",
					].includes(op)
				) {
					boundary = instruction;
					break;
				}
				const constant = args[1] === undefined ? undefined : analysis.constant(args[1]);
				const key = op.endsWith("Static")
					? analysis.string(attrs.stringIndex as number)
					: constant === undefined
						? undefined
						: constant.kind === "undefined"
							? "undefined"
							: String(constant.value);
				// String exotic indexes and length are immutable own properties, not absent cells.
				if (
					key === undefined ||
					(stringWrapper && (key === "length" || /^(0|[1-9][0-9]*)$/.test(key)))
				) {
					boundary = instruction;
					break;
				}
				if (op.startsWith("load")) {
					const cell =
						array && key === "length"
							? numberCell(length)
							: (cells.get(key) ?? (absent(key) ? undefinedCell : undefined));
					if (cell === undefined) {
						boundary = instruction;
						break;
					}
					replacements.set(instruction, cell);
					transitions++;
					continue;
				}
				if (op === "deleteProperty") {
					if (array && key === "length") {
						boundary = instruction;
						break;
					}
					cells.delete(key);
					replacements.set(instruction, {
						opcode: "createBoolean",
						inputs: [],
						attributes: { value: true },
					});
					transitions++;
					continue;
				}
				const input = args[op === "storePropertyStatic" ? 1 : 2]!;
				if (array && key === "length") {
					const count = analysis.constant(input);
					if (
						!op.startsWith("store") ||
						count?.kind !== "number" ||
						!Number.isInteger(count.value) ||
						count.value < 0 ||
						count.value > LIMIT
					) {
						boundary = instruction;
						break;
					}
					length = count.value;
					for (const key of cells.keys())
						if (
							/^(0|[1-9][0-9]*)$/.test(key) &&
							Number(key) >= length &&
							Number(key) < 4294967295
						)
							cells.delete(key);
				} else {
					if (
						(op === "defineProperty" &&
							(attrs.enumerable !== true ||
								attrs.writable === false ||
								attrs.configurable === false)) ||
						(op !== "defineProperty" && !cells.has(key) && !absent(key)) ||
						cells.size >= LIMIT
					) {
						boundary = instruction;
						break;
					}
					const index = Number(key);
					if (
						array &&
						String(index) === key &&
						Number.isInteger(index) &&
						index >= 0 &&
						index < 4294967295
					) {
						if (index >= LIMIT) {
							boundary = instruction;
							break;
						}
						length = Math.max(length, index + 1);
					}
					cells.set(key, valueCell(input));
				}
				removals.add(instruction);
				if (op !== "defineProperty") transitions++;
			}
			if (
				boundary === root ||
				removals.size +
					replacements.size +
					cells.size * 3 +
					4 +
					Number(conversion !== undefined) >
					context.remainingEdits
			)
				continue;
			boundary ??= fn.blockTerminator(block);
			const consumed = new Set([...removals, ...replacements.keys()]);
			const escapes = [...aliases].some((alias) => {
				for (
					let use = fn.kernel.valueFirstUse(alias);
					use >= 0;
					use = fn.kernel.useNext(use)
				)
					if (!consumed.has(fn.kernel.useInstruction(use))) return true;
				return false;
			});
			if (transitions === 0 && escapes && !arrayResult) continue;
			analysis.verify(fact);
			const editor = CoreEditor.open(program, fn.id);
			// Coercion belongs to construction even when the private shell moves or disappears.
			const converted =
				conversion === undefined
					? undefined
					: editor.insertInstruction(block, root, conversion.opcode, conversion.inputs, {
							attributes: conversion.attributes,
							sourcePosition: fn.instructionSourcePosition(root),
						}).outputs[0]!;
			for (const [instruction, cell] of replacements)
				editor.replaceInstruction(instruction, cell.opcode, cell.inputs, {
					attributes: cell.attributes,
				});
			for (const alias of aliases)
				if (alias !== value) editor.replaceValueUses(alias, value);
			for (const instruction of removals) editor.removeInstruction(instruction);
			if (escapes) {
				if (wrapper) {
					const inputs = argsOf(root);
					if (converted !== undefined) inputs[1] = converted;
					editor.replaceInstruction(root, "callKnown", inputs, {
						attributes: { ...attributes, [MATERIALIZED]: true },
					});
				} else
					editor.replaceInstruction(root, array ? "createArray" : "createObject", [], {
						attributes: {
							...(array ? { length } : {}),
							[MATERIALIZED]: true,
						},
					});
				editor.moveInstruction(root, block, boundary);
				for (const [key, cell] of cells) {
					const keyIndex = program.stringConstants.findIndex(
						(units) =>
							units.length === key.length &&
							units.every((unit, index) => unit === key.charCodeAt(index)),
					);
					const stringIndex =
						keyIndex >= 0
							? keyIndex
							: editor.appendStringConstants([
									Array.from({ length: key.length }, (_, index) => key.charCodeAt(index)),
								]);
					const keyValue = editor.insertInstruction(block, boundary, "createString", [], {
						attributes: { stringIndex },
					}).outputs[0]!;
					const cellValue =
						cell.opcode === "move"
							? cell.inputs[0]!
							: editor.insertInstruction(block, boundary, cell.opcode, cell.inputs, {
									attributes: cell.attributes,
								}).outputs[0]!;
					editor.insertInstruction(
						block,
						boundary,
						"defineProperty",
						[value, keyValue, cellValue],
						{ attributes: { enumerable: true } },
					);
				}
			} else editor.removeInstruction(root);
			return editor.commit();
		}
		return undefined;
	},
};
