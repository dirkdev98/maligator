import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
import { CoreEditor } from "./core-editor.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreTerminatorInput,
} from "./core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionPass } from "./core-pass.ts";

export const continueGuardedCallArithmetic: CoreFunctionPass = {
	name: "guarded-call-arithmetic-continuation",
	stage: "canonicalize",
	requiredFunctionOpcodesAny: ["call"],
	admission: {
		predicate: "guarded inline fallback with a numeric continuation",
		hasOpportunity({ program, function: functionId }) {
			const fn = program.function(functionId);
			for (const instruction of fn.instructionIds()) {
				if (
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "call" &&
					fn.instructionAttributes(instruction)[
						CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
					] === true
				)
					return true;
			}
			return false;
		},
	},
	requiredAnalyses: [CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, CORE_LOCAL_VALUE_KIND_ANALYSIS],
	wakesOn: ["body", "cfg", "normalResults", "representations"],
	changes: { cfg: true, calls: true, facts: true, representations: false },
	budget: { maxWorkItems: 100_000, maxEdits: 32, exhaustion: "stop" },
	run(context) {
		const { program, item } = context;
		const fn = program.function(item.function);
		if (
			fn.isAsync ||
			fn.isGenerator ||
			fn.liveStorageCounts().instructions > 4000 ||
			context.remainingEdits < 8
		)
			return undefined;
		const control = context.analysis(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS).exceptional();
		const kinds = context.analysis(CORE_LOCAL_VALUE_KIND_ANALYSIS);
		const operand = (instruction: CoreInstructionId, index: number) =>
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
		const fromGuardedFallback = (initial: CoreValueId) => {
			const pending = [{ value: initial, depth: 0 }];
			const visited = new Set<CoreValueId>();
			for (let work = 0; pending.length > 0 && work < 32; work++) {
				const { value, depth } = pending.pop()!;
				if (depth >= 8 || visited.has(value)) continue;
				visited.add(value);
				const kind = fn.kernel.valueDefinitionKind(value);
				const owner = fn.kernel.valueDefinitionOwner(value);
				if (kind === 0) {
					const block = coreBlockId(owner);
					const incoming = control.predecessors[block] ?? [];
					if (incoming.length > 2) continue;
					const start = fn.kernel.blockParameterStart(block);
					for (let index = 0; index < fn.kernel.blockParameterCount(block); index++) {
						if (fn.kernel.blockParameterValue(start + index) !== value) continue;
						for (const edge of incoming) {
							if (edge.kind === "ordinary")
								pending.push({ value: edge.arguments[index]!, depth: depth + 1 });
						}
						break;
					}
				} else if (kind === 1) {
					const definition = coreInstructionId(owner);
					const opcode = fn.instructionOpcodeName(definition);
					if (
						opcode === "call" &&
						fn.instructionAttributes(definition)[
							CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
						] === true
					)
						return true;
					if (opcode === "move")
						pending.push({ value: operand(definition, 0), depth: depth + 1 });
					else if (opcode === "binary") {
						const left = operand(definition, 0),
							right = operand(definition, 1);
						if (kinds.kindMask(left) === COMPILER_VALUE_KIND_NUMBER)
							pending.push({ value: right, depth: depth + 1 });
						else if (kinds.kindMask(right) === COMPILER_VALUE_KIND_NUMBER)
							pending.push({ value: left, depth: depth + 1 });
					}
				}
			}
			return false;
		};
		for (const block of fn.blockIds()) {
			if (
				!control.reachable.has(block) ||
				fn.kernel.blockHandlerBlock(block) !== undefined
			)
				continue;
			let instruction: CoreInstructionId | undefined;
			for (const first of fn.instructionIds(block)) {
				instruction = first;
				break;
			}
			if (instruction === undefined || fn.instructionKind(instruction) !== "operation")
				continue;
			const operator = fn.instructionAttributes(instruction).operator;
			if (
				fn.instructionOpcodeName(instruction) !== "binary" ||
				typeof operator !== "string" ||
				!["+", "-", "*", "/", "%", "|", "&", "^", "<<", ">>", ">>>"].includes(operator)
			)
				continue;
			const incoming = control.predecessors[block] ?? [];
			if (
				incoming.length !== 2 ||
				incoming.some(
					(edge) =>
						edge.kind !== "ordinary" ||
						edge.from === block ||
						control.dominates(block, edge.from) ||
						fn.kernel.blockHandlerBlock(edge.from) !== undefined,
				)
			)
				continue;
			const parameters = new Map<CoreValueId, number>();
			const start = fn.kernel.blockParameterStart(block);
			for (let index = 0; index < fn.kernel.blockParameterCount(block); index++) {
				parameters.set(fn.kernel.blockParameterValue(start + index), index);
			}
			const inputs = [operand(instruction, 0), operand(instruction, 1)];
			const position = inputs.findIndex(
				(value) =>
					parameters.has(value) &&
					kinds.kindMask(value) !== COMPILER_VALUE_KIND_NUMBER &&
					fn.valueUseCount(value) === 1 &&
					fn.kernel.valueHandlerUseCount(value) === 0,
			);
			if (
				position < 0 ||
				kinds.kindMask(inputs[1 - position]!) !== COMPILER_VALUE_KIND_NUMBER
			)
				continue;
			const parameterIndex = parameters.get(inputs[position]!)!;
			const rows = incoming.map((edge) => ({
				block: edge.from,
				terminator: coreTerminatorInput(fn, fn.blockTerminator(edge.from)),
				arguments: [...edge.arguments],
			}));
			if (
				rows.some(
					(row) => row.terminator.kind !== "jump" || row.terminator.edge.block !== block,
				)
			)
				continue;
			const values = rows.map((row) => row.arguments[parameterIndex]!);
			if (
				!values.some((value) => kinds.kindMask(value) === COMPILER_VALUE_KIND_NUMBER) ||
				!values.some(fromGuardedFallback)
			)
				continue;
			const translated = rows.map((row) =>
				inputs.map((value) => {
					const index = parameters.get(value);
					if (index !== undefined) {
						let argument = row.arguments[index]!;
						for (
							let depth = 0;
							depth < 4 && fn.kernel.valueDefinitionKind(argument) === 1;
							depth++
						) {
							const definition = coreInstructionId(
								fn.kernel.valueDefinitionOwner(argument),
							);
							if (fn.instructionOpcodeName(definition) !== "move") break;
							const source = operand(definition, 0);
							if (kinds.kindMask(source) !== COMPILER_VALUE_KIND_NUMBER) break;
							argument = source;
						}
						return argument;
					}
					const kind = fn.kernel.valueDefinitionKind(value);
					if (kind !== 0 && kind !== 1) return undefined;
					const owner = fn.kernel.valueDefinitionOwner(value);
					const definitionBlock =
						kind === 0
							? coreBlockId(owner)
							: fn.instructionBlock(coreInstructionId(owner));
					return definitionBlock === row.block ||
						control.instructionDominatesBlock(definitionBlock, row.block)
						? value
						: undefined;
				}),
			);
			if (translated.some((row) => row.some((value) => value === undefined))) continue;
			// Sole transfers and a first join operation preserve coercion order on each
			// completed branch, without replaying calls or crossing a handler.
			const output = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
			if (
				6 + fn.valueUseCount(output) + fn.kernel.valueHandlerUseCount(output) >
				context.remainingEdits
			)
				continue;
			const editor = CoreEditor.open(program, item.function);
			const result = editor.appendBlockParameter(block, {
				representation: fn.valueRepresentation(output),
			});
			for (const [index, row] of rows.entries()) {
				const value = editor.appendInstruction(
					row.block,
					"binary",
					translated[index] as Array<CoreValueId>,
					{
						attributes: { operator: fn.instructionAttributes(instruction).operator! },
						outputRepresentations: [fn.valueRepresentation(output)],
						sourcePosition: fn.instructionSourcePosition(instruction),
					},
				).outputs[0]!;
				editor.replaceTerminator(row.block, {
					kind: "jump",
					edge: { block, arguments: [...row.arguments, value] },
					sourcePosition: fn.instructionSourcePosition(fn.blockTerminator(row.block)),
				});
			}
			editor.replaceValueUses(output, result);
			editor.removeInstruction(instruction);
			return editor.commit();
		}
		return undefined;
	},
};
