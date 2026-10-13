import type { ReadAccessorSummary } from "../shared/effect-summary.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreFunctionStore } from "./core-store.ts";

type Read = ReadAccessorSummary["reads"][number];

export function coreReadAccessorSummary(
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
): ReadAccessorSummary | undefined {
	if (
		!fn.metadata.strict ||
		fn.metadata.lexicalThis ||
		fn.isAsync ||
		fn.isGenerator ||
		fn.parameterCount > 4 ||
		fn.metadata.capturedCount !== 0 ||
		fn.metadata.isClassConstructor ||
		cfg.reachable.size > 6 ||
		cfg.loops.length > 0 ||
		cfg.irreducibleCycles.length > 0
	)
		return undefined;
	const instructions: Array<CoreInstructionId> = [];
	for (const block of cfg.reachable) {
		if (fn.kernel.blockHandlerBlock(block) !== undefined) return undefined;
		for (const instruction of fn.bodyInstructionIds(block)) {
			if (instructions.length === 24) return undefined;
			instructions.push(instruction);
		}
	}
	const used = new Set<CoreInstructionId>();
	const operand = (instruction: CoreInstructionId, index: number): CoreValueId =>
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index);
	const producer = (value: CoreValueId): CoreInstructionId | undefined => {
		for (let depth = 0; depth < 16; depth++) {
			if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
			const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			used.add(instruction);
			if (fn.instructionOpcodeName(instruction) !== "move") return instruction;
			value = operand(instruction, 0);
		}
		return undefined;
	};
	const reads: Array<Read> = [];
	const chain = (value: CoreValueId, depth = 0): boolean => {
		if (depth > 4) return false;
		const instruction = producer(value);
		if (instruction === undefined) return false;
		const opcode = fn.instructionOpcodeName(instruction),
			attributes = fn.instructionAttributes(instruction);
		if (opcode === "loadThis") return true;
		if (opcode === "loadPrivate") {
			const key = producer(operand(instruction, 1));
			if (
				key === undefined ||
				fn.instructionOpcodeName(key) !== "loadGlobal" ||
				!chain(operand(instruction, 0), depth + 1)
			)
				return false;
			const slot = fn.instructionAttributes(key).index;
			if (typeof slot !== "number") return false;
			reads.push({ kind: "private", slot });
			return true;
		}
		if (opcode === "loadPropertyStatic") {
			if (
				typeof attributes.stringIndex !== "number" ||
				!chain(operand(instruction, 0), depth + 1)
			)
				return false;
			reads.push({ kind: "named", stringIndex: attributes.stringIndex });
			return true;
		}
		if (opcode === "loadProperty") {
			const keyValue = operand(instruction, 1);
			const argument = Array.from({ length: fn.parameterCount }, (_, index) =>
				fn.kernel.functionParameter(index),
			).indexOf(keyValue);
			const key = argument < 0 ? producer(keyValue) : undefined;
			if (
				argument < 0 &&
				(key === undefined || fn.instructionOpcodeName(key) !== "createString")
			)
				return false;
			if (!chain(operand(instruction, 0), depth + 1)) return false;
			if (argument >= 0) reads.push({ kind: "indexed", argument });
			else {
				const stringIndex = fn.instructionAttributes(key!).stringIndex;
				if (typeof stringIndex !== "number") return false;
				reads.push({ kind: "named", stringIndex });
			}
			return true;
		}
		return false;
	};
	const constant = (value: CoreValueId): ReadAccessorSummary["defaultValue"] => {
		const instruction = producer(value);
		if (instruction === undefined) return undefined;
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "createUndefined") return { kind: "undefined" };
		if (opcode === "createNull") return { kind: "null" };
		const number = fn.instructionAttributes(instruction).value;
		return (opcode === "createNumber" || opcode === "createF64") &&
			typeof number === "number"
			? { kind: "number", value: number }
			: undefined;
	};
	const returns = [...cfg.reachable].filter(
		(block) => fn.instructionKind(fn.blockTerminator(block)) === "return",
	);
	if (returns.length !== 1) return undefined;
	const result = operand(fn.blockTerminator(returns[0]!), 0);
	let defaultValue: ReadAccessorSummary["defaultValue"];
	if (!chain(result)) {
		reads.length = 0;
		if (fn.kernel.valueDefinitionKind(result) !== 0) return undefined;
		const block = returns[0]!,
			parameterStart = fn.kernel.blockParameterStart(block);
		let parameter = -1;
		for (let index = 0; index < fn.kernel.blockParameterCount(block); index++)
			if (fn.kernel.blockParameterValue(parameterStart + index) === result)
				parameter = index;
		const edges = cfg.predecessors[block] ?? [];
		if (parameter < 0 || edges.length !== 2) return undefined;
		const alternatives = edges.map((edge) => edge.arguments[parameter]!);
		let value = alternatives[0]!;
		let defaultIndex = 1;
		defaultValue = constant(alternatives[1]!);
		if (defaultValue === undefined) {
			defaultValue = constant(alternatives[0]!);
			value = alternatives[1]!;
			defaultIndex = 0;
		}
		if (defaultValue === undefined || !chain(value)) return undefined;
		const branches = [...cfg.reachable].filter(
			(candidate) => fn.instructionKind(fn.blockTerminator(candidate)) === "branch",
		);
		if (branches.length !== 1) return undefined;
		const branch = coreTerminatorInput(fn, fn.blockTerminator(branches[0]!));
		if (branch.kind !== "branch") return undefined;
		const onEdge = (target: typeof branch.consequent, index: number): boolean =>
			target.block === block
				? edges[index]!.from === branches[0] &&
					target.arguments[parameter] === alternatives[index]
				: cfg.dominates(target.block, edges[index]!.from);
		if (
			!onEdge(branch.consequent, defaultIndex) ||
			!onEdge(branch.alternate, 1 - defaultIndex)
		)
			return undefined;
		const test = producer(operand(fn.blockTerminator(branches[0]!), 0));
		if (
			test === undefined ||
			fn.instructionOpcodeName(test) !== "binary" ||
			fn.instructionAttributes(test).operator !== "=="
		)
			return undefined;
		const left = producer(operand(test, 0)),
			right = constant(operand(test, 1));
		if (left !== producer(value) || right?.kind !== "undefined") return undefined;
	} else if (
		[...cfg.reachable].some(
			(block) =>
				!["return", "jump"].includes(fn.instructionKind(fn.blockTerminator(block))),
		)
	)
		return undefined;
	if (reads.length === 0 || instructions.some((instruction) => !used.has(instruction)))
		return undefined;
	return Object.freeze({
		reads: Object.freeze(reads),
		...(defaultValue === undefined ? {} : { defaultValue }),
	});
}
