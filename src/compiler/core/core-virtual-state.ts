import { CoreEditor } from "./core-editor.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreMaterializationPlan } from "./core-materialization-demands.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
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
const valueCell = (value: CoreValueId): Cell => ({ opcode: "move", inputs: [value] });

export const materializeVirtualState: CoreFunctionPass = {
	name: "materialize-virtual-state",
	stage: "memory",
	requiredFunctionOpcodesAny: ["createArray", "createObject", "createObjectShaped"],
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
			if (
				!["createArray", "createObject", "createObjectShaped"].includes(opcode) ||
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
			const array = opcode === "createArray";
			let length = array ? (attributes.length as number) : 0;
			if (!Number.isSafeInteger(length) || length < 0 || length > LIMIT) continue;
			const cells = new Map<string, Cell>();
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
						cells.delete(key);
						length = Math.max(length - 1, 0);
						transitions++;
						continue;
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
				if (key === undefined) {
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
				removals.size + replacements.size + cells.size * 3 + 4 > context.remainingEdits
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
			if (transitions === 0 && escapes) continue;
			analysis.verify(fact);
			const editor = CoreEditor.open(program, fn.id);
			for (const [instruction, cell] of replacements)
				editor.replaceInstruction(instruction, cell.opcode, cell.inputs, {
					attributes: cell.attributes,
				});
			for (const alias of aliases)
				if (alias !== value) editor.replaceValueUses(alias, value);
			for (const instruction of removals) editor.removeInstruction(instruction);
			if (escapes) {
				editor.replaceInstruction(root, array ? "createArray" : "createObject", [], {
					attributes: { ...(array ? { length } : {}), [MATERIALIZED]: true },
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
