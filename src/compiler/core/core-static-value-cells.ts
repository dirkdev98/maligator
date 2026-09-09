import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreStaticValue, CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface CellAccess {
	readonly function: CoreFunctionId;
	readonly instruction: CoreInstructionId;
	readonly value: CoreValueId;
	readonly write: boolean;
}
function immutablePrimitive(fact: CoreStaticValue): boolean {
	return (
		fact.state === "immutable-value" &&
		["undefined", "null", "boolean", "number", "string", "bigint", "symbol"].includes(
			fact.brand,
		)
	);
}
function cellKey(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): string | undefined {
	const opcode = fn.instructionOpcodeName(instruction),
		attributes = fn.instructionAttributes(instruction);
	if (opcode === "loadGlobal" || opcode === "storeGlobal")
		return `global:${attributes.index as number}`;
	if (opcode === "loadCaptured" || opcode === "storeCaptured")
		return `captured:${attributes.functionIndex as number}:${attributes.index as number}`;
	return undefined;
}

export class CoreStaticCellIndex {
	readonly #program: CoreProgram;
	readonly #closed: Set<string>;
	readonly #functions = new Map<CoreFunctionId, Map<string, Array<CellAccess>>>();
	readonly #cells = new Map<string, Map<CoreFunctionId, Array<CellAccess>>>();
	readonly #facts = new Map<
		string,
		{ fact: CoreStaticValue; write: CellAccess } | undefined
	>();
	#revision = -1;
	#dataVersion = -1;
	#proofWork = 0;
	constructor(program: CoreProgram, context: CoreCompilationContext) {
		this.#program = program;
		this.#closed = new Set([
			...context.data.singleAssignmentGlobalSlots.map((slot) => `global:${slot}`),
			...context.data.singleAssignmentCapturedSlots.map(
				(slot) => `captured:${slot.owner}:${slot.index}`,
			),
		]);
	}
	#refresh(): void {
		const dirty = new Set<CoreFunctionId>();
		if (this.#revision < 0) for (const fn of this.#program.functionIds()) dirty.add(fn);
		else
			for (
				let revision = this.#revision;
				revision < this.#program.programFlowRevision;
				revision++
			)
				dirty.add(this.#program.programFlowFunctionAt(revision));
		if (this.#dataVersion !== this.#program.programVersion("data")) {
			this.#facts.clear();
			this.#dataVersion = this.#program.programVersion("data");
		}
		if (dirty.size === 0) return;
		this.#facts.clear();
		for (const functionId of dirty) {
			for (const key of this.#functions.get(functionId)?.keys() ?? [])
				this.#cells.get(key)?.delete(functionId);
			this.#functions.delete(functionId);
			if (!this.#program.hasFunction(functionId)) continue;
			const fn = this.#program.function(functionId),
				found = new Map<string, Array<CellAccess>>();
			for (const instruction of fn.instructionIds()) {
				if (fn.instructionKind(instruction) !== "operation") continue;
				const key = cellKey(fn, instruction);
				if (key === undefined || !this.#closed.has(key)) continue;
				const write = fn.instructionOpcodeName(instruction).startsWith("store");
				const value = write
					? fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction))
					: fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
				if (
					write &&
					fn.kernel.valueDefinitionKind(value) === 1 &&
					fn.instructionOpcodeName(
						coreInstructionId(fn.kernel.valueDefinitionOwner(value)),
					) === "createEmpty"
				)
					continue;
				const accesses = found.get(key) ?? [];
				accesses.push({ function: functionId, instruction, value, write });
				found.set(key, accesses);
			}
			this.#functions.set(functionId, found);
			for (const [key, accesses] of found) {
				const cell = this.#cells.get(key) ?? new Map<CoreFunctionId, Array<CellAccess>>();
				cell.set(functionId, accesses);
				this.#cells.set(key, cell);
			}
		}
		this.#revision = this.#program.programFlowRevision;
	}
	query(
		fn: CoreFunctionStore,
		load: CoreInstructionId,
		value: CoreValueId,
		consumer: CoreInstructionId,
		getAnalysis: (fn: CoreFunctionId) => CoreStaticValueAnalysis,
		control: () => CoreControlFlow,
	): CoreStaticValue | undefined {
		const key = cellKey(fn, load);
		if (key === undefined || !this.#closed.has(key)) return undefined;
		this.#refresh();
		if (this.#proofWork >= 65536) return undefined;
		if (!this.#facts.has(key)) {
			this.#facts.set(key, undefined);
			const accesses = [...(this.#cells.get(key)?.values() ?? [])].flat(),
				writes = accesses.filter((access) => access.write);
			if (writes.length === 1) {
				const write = writes[0]!,
					analysis = getAnalysis(write.function);
				const fact = analysis.queryAt(write.value, write.instruction);
				if (
					fact.kind === "known" &&
					fact.operands.length === 0 &&
					(fact.allocationIdentities?.length ?? 0) === 0 &&
					this.#readOnly(accesses, write, fact, getAnalysis)
				)
					this.#facts.set(key, { fact, write });
			}
		}
		const proof = this.#facts.get(key);
		if (proof === undefined) return undefined;
		const source = proof.fact;
		let initialized = false;
		if (immutablePrimitive(source) && proof.write.function === fn.id) {
			const writeBlock = fn.instructionBlock(proof.write.instruction);
			const loadBlock = fn.instructionBlock(load);
			if (writeBlock !== loadBlock)
				initialized = control().instructionDominatesBlock(writeBlock, loadBlock);
			else
				for (const instruction of fn.instructionIds(loadBlock)) {
					if (instruction === load) break;
					if (instruction === proof.write.instruction) {
						initialized = true;
						break;
					}
				}
		}
		if (
			!initialized &&
			load !== consumer &&
			fn.instructionBlock(load) === fn.instructionBlock(consumer)
		) {
			// A different activation's initializer cannot prove this read has left the TDZ.
			for (
				let instruction = fn.instructionNext(load);
				instruction !== undefined && instruction !== consumer;
				instruction = fn.instructionNext(instruction)
			) {
				if (
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "throwIfTdz" &&
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)) === value
				) {
					initialized = true;
					break;
				}
			}
		}
		if (!initialized) return undefined;
		return {
			...source,
			value,
			identity:
				source.identity === undefined
					? undefined
					: { kind: "private-cell", function: fn.id, key },
			state: source.state === "immutable-value" ? "immutable-value" : "stored-instance",
			construction: undefined,
			privateUntilObservation: false,
			operands: [],
			allocationIdentities: [],
		};
	}
	#readOnly(
		accesses: ReadonlyArray<CellAccess>,
		write: CellAccess,
		fact: CoreStaticValue,
		getAnalysis: (fn: CoreFunctionId) => CoreStaticValueAnalysis,
	): boolean {
		if (immutablePrimitive(fact)) return true;
		const description = this.#program.staticDescriptions.description(fact.description);

		for (const access of accesses) {
			const fn = this.#program.function(access.function),
				pending = [access.value],
				seen = new Set<CoreValueId>();
			const initializers = new Set<CoreInstructionId>();
			if (access === write) {
				for (const instruction of fn.instructionIds(
					fn.instructionBlock(write.instruction),
				)) {
					if (instruction === write.instruction) break;
					initializers.add(instruction);
				}
			}
			while (pending.length > 0) {
				const value = pending.pop()!;
				if (seen.has(value)) continue;
				seen.add(value);
				if (fn.kernel.valueFirstHandlerUse(value) >= 0) return false;
				for (
					let use = fn.kernel.valueFirstUse(value);
					use >= 0;
					use = fn.kernel.useNext(use)
				) {
					if (++this.#proofWork > 65536) return false;
					const instruction = fn.kernel.useInstruction(use),
						operand = fn.kernel.useOperand(use);
					if (access.function === write.function && instruction === write.instruction)
						continue;
					if (fn.instructionKind(instruction) !== "operation") return false;
					const opcode = fn.instructionOpcodeName(instruction);
					if (opcode === "move") {
						pending.push(
							fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
						);
						continue;
					}
					if (
						opcode === "throwIfTdz" ||
						opcode === "typeofCompare" ||
						(opcode === "unary" &&
							fn.instructionAttributes(instruction).operator === "typeof") ||
						(opcode === "binary" &&
							["===", "!=="].includes(
								fn.instructionAttributes(instruction).operator as string,
							))
					)
						continue;
					if (
						initializers.has(instruction) &&
						operand === 0 &&
						["defineProperty", "defineAccessor", "setPrototype"].includes(opcode)
					)
						continue;
					if (
						["loadPropertyStatic", "loadProperty"].includes(opcode) &&
						operand === 0 &&
						(description.kind === "object" || description.kind === "array")
					) {
						const analysis = getAnalysis(fn.id);
						const constant =
							opcode === "loadProperty"
								? analysis.constant(
										fn.kernel.operandAt(
											fn.kernel.instructionOperandStart(instruction) + 1,
										),
									)
								: undefined;
						const key =
							opcode === "loadPropertyStatic"
								? analysis.string(
										fn.instructionAttributes(instruction).stringIndex as number,
									)
								: constant === undefined
									? undefined
									: constant.kind === "undefined"
										? "undefined"
										: String(constant.value);
						if (key === undefined) return false;
						if (description.kind === "array" && key === "length") continue;
						if (
							description.properties.some(
								(property) => property.key === key && property.descriptor.kind === "data",
							)
						)
							continue;
					}
					return false;
				}
			}
		}
		return true;
	}
}

export const CORE_STATIC_CELL_INDEX: CoreAnalysisDefinition<CoreStaticCellIndex> = {
	key: "static-private-cell-index",
	scope: "program",
	programDependencies: ["functions"],
	compute({ program, context }) {
		return program.staticCellIndex(
			context,
			() => new CoreStaticCellIndex(program, context),
		);
	},
};
