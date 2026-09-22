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
interface CellReads {
	readonly reads: ReadonlyArray<Pick<CellAccess, "function" | "instruction">> | undefined;
	readonly visits: number;
	readonly exhausted: boolean;
	charged?: boolean;
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

function hasInitializationCheck(
	fn: CoreFunctionStore,
	load: CoreInstructionId,
	value: CoreValueId,
	consumer: CoreInstructionId,
): boolean {
	if (load === consumer || fn.instructionBlock(load) !== fn.instructionBlock(consumer))
		return false;
	for (
		let instruction = fn.instructionNext(load);
		instruction !== undefined && instruction !== consumer;
		instruction = fn.instructionNext(instruction)
	) {
		if (
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "throwIfTdz" &&
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction)) === value
		)
			return true;
	}
	return false;
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
	readonly #prechecks = new Map<string, CellReads>();
	readonly #properties = new Map<string, Map<string, CoreStaticValue>>();
	#precheckWork = 0;
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
			this.#prechecks.clear();
			this.#properties.clear();
			this.#dataVersion = this.#program.programVersion("data");
		}
		if (dirty.size === 0) return;
		this.#facts.clear();
		this.#prechecks.clear();
		this.#properties.clear();
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
		requestedKey?: string,
	): CoreStaticValue | undefined {
		const key = cellKey(fn, load);
		if (key === undefined || !this.#closed.has(key)) return undefined;
		this.#refresh();
		if (this.#proofWork >= 65536) return undefined;
		let checkedInitialization: boolean | undefined;
		if (requestedKey !== undefined && this.#facts.get(key) === undefined) {
			checkedInitialization = hasInitializationCheck(fn, load, value, consumer);
			if (checkedInitialization) {
				const property = this.#property(key, requestedKey, getAnalysis);
				if (property !== undefined) return this.#stored(property, fn, value, key);
			}
		}
		if (!this.#facts.has(key)) {
			const accesses = [...(this.#cells.get(key)?.values() ?? [])].flat(),
				writes = accesses.filter((access) => access.write);
			if (writes.length === 1 && writes[0]!.function !== fn.id) {
				checkedInitialization = hasInitializationCheck(fn, load, value, consumer);
				// A different activation's initializer cannot prove this read has left the TDZ.
				if (!checkedInitialization) return undefined;
			}
			this.#facts.set(key, undefined);
			if (writes.length === 1) {
				const write = writes[0]!,
					analysis = getAnalysis(write.function);
				const precheck = this.#precheck(key, accesses, write);
				if (precheck !== undefined && precheck.reads === undefined) return undefined;
				const fact = analysis.queryAt(write.value, write.instruction);
				if (
					fact.kind === "known" &&
					fact.operands.length === 0 &&
					(fact.allocationIdentities?.length ?? 0) === 0 &&
					this.#readOnly(accesses, write, fact, getAnalysis, precheck)
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
		if (!initialized)
			initialized =
				checkedInitialization ?? hasInitializationCheck(fn, load, value, consumer);
		if (!initialized) return undefined;
		return this.#stored(source, fn, value, key);
	}
	#stored(
		source: CoreStaticValue,
		fn: CoreFunctionStore,
		value: CoreValueId,
		key: string,
	): CoreStaticValue {
		return {
			...source,
			value,
			identity:
				source.identity === undefined
					? undefined
					: source.brand === "symbol" &&
						  (source.identity.kind === "intrinsic" ||
								source.identity.kind === "symbol-registry")
						? source.identity
						: { kind: "private-cell", function: fn.id, key },
			state: source.state === "immutable-value" ? "immutable-value" : "stored-instance",
			construction: undefined,
			privateUntilObservation: false,
			operands: [],
			allocationIdentities: [],
		};
	}
	#allocation(write: CellAccess): boolean {
		const fn = this.#program.function(write.function);
		if (fn.kernel.valueDefinitionKind(write.value) !== 1) return false;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(write.value));
		const opcode = fn.instructionOpcodeName(instruction);
		if (opcode === "instantiateLiteralTemplate") {
			const tag =
				this.#program.literalTemplateData[
					fn.instructionAttributes(instruction).templateOffset as number
				];
			return tag === 8 || tag === 9;
		}
		return ["createObject", "createObjectShaped", "createArray"].includes(opcode);
	}
	#precheck(
		key: string,
		accesses: ReadonlyArray<CellAccess>,
		write: CellAccess,
	): CellReads | undefined {
		const cached = this.#prechecks.get(key);
		if (cached !== undefined) return cached;
		// Primitive cells can escape safely; only definite allocations may be rejected early.
		if (!this.#allocation(write) || this.#precheckWork >= 65536) return undefined;
		const result = this.#scanReads(accesses, write, 65536 - this.#precheckWork);
		this.#precheckWork += result.visits;
		if (result.exhausted) return undefined;
		this.#prechecks.set(key, result);
		return result;
	}
	#charge(reads: CellReads): boolean {
		if (!reads.charged) {
			this.#proofWork += reads.visits;
			reads.charged = true;
		}
		return !reads.exhausted && this.#proofWork <= 65536;
	}
	#property(
		key: string,
		requestedKey: string,
		getAnalysis: (fn: CoreFunctionId) => CoreStaticValueAnalysis,
	): CoreStaticValue | undefined {
		const cached = this.#properties.get(key);
		if (cached !== undefined) return cached.get(requestedKey);
		const properties = new Map<string, CoreStaticValue>();
		this.#properties.set(key, properties);
		const accesses = [...(this.#cells.get(key)?.values() ?? [])].flat();
		const writes = accesses.filter((access) => access.write);
		if (writes.length !== 1) return undefined;
		const write = writes[0]!;
		const precheck = this.#precheck(key, accesses, write);
		// Reads in the initializer activation may predate the final descriptors or expose aliases.
		if (
			precheck?.reads === undefined ||
			precheck.reads.some((read) => read.function === write.function)
		)
			return undefined;
		const keys = this.#readKeys(precheck, getAnalysis);
		if (keys === undefined) return undefined;
		keys.add(requestedKey);
		const analysis = getAnalysis(write.function);
		const pending = new Map<string, CoreStaticValue>();
		for (const property of keys) {
			const selected = analysis.queryPropertyAt(write.value, property, write.instruction);
			// Property-result uses need no alias walk only when they cannot expose an object.
			if (
				selected?.member.kind !== "constant" ||
				analysis.descriptionConstant(selected.member.description) === undefined
			)
				return undefined;
			analysis.verifyProperty(selected, write.instruction);
			const fact = analysis.queryAt(write.value, write.instruction, { property });
			if (
				fact.kind !== "known" ||
				fact.identity?.kind !== "fresh-per-evaluation" ||
				fact.identity.function !== write.function ||
				fact.identity.value !== write.value
			)
				return undefined;
			const summary = this.#program.staticDescriptions.summary(fact.description);
			if (summary.operandSlots.length !== 0 || summary.identitySlots.length !== 0)
				return undefined;
			pending.set(property, fact);
		}
		if (!this.#charge(precheck)) return undefined;
		for (const [property, fact] of pending) properties.set(property, fact);
		return properties.get(requestedKey);
	}
	#readOnly(
		accesses: ReadonlyArray<CellAccess>,
		write: CellAccess,
		fact: CoreStaticValue,
		getAnalysis: (fn: CoreFunctionId) => CoreStaticValueAnalysis,
		precheck?: CellReads,
	): boolean {
		if (immutablePrimitive(fact)) return true;
		const description = this.#program.staticDescriptions.description(fact.description);
		const root =
			fact.identity?.kind === "fresh-per-evaluation" &&
			fact.identity.function === write.function
				? fact.identity.value
				: write.value;
		const reads =
			precheck ?? this.#scanReads(accesses, write, 65536 - this.#proofWork, root);
		if (!this.#charge(reads) || reads.reads === undefined) return false;
		const keys = this.#readKeys(reads, getAnalysis);
		if (keys === undefined) return false;
		if (keys.size === 0) return true;
		if (description.kind !== "object" && description.kind !== "array") return false;
		return [...keys].every(
			(key) =>
				(description.kind === "array" && key === "length") ||
				description.properties.some(
					(property) => property.key === key && property.descriptor.kind === "data",
				),
		);
	}
	#readKeys(
		reads: CellReads,
		getAnalysis: (fn: CoreFunctionId) => CoreStaticValueAnalysis,
	): Set<string> | undefined {
		const keys = new Set<string>();
		for (const read of reads.reads ?? []) {
			const fn = this.#program.function(read.function),
				instruction = read.instruction;
			const analysis = getAnalysis(fn.id);
			const isStatic = fn.instructionOpcodeName(instruction) === "loadPropertyStatic";
			const constant = isStatic
				? undefined
				: analysis.constant(
						fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1),
					);
			const key = isStatic
				? analysis.string(fn.instructionAttributes(instruction).stringIndex as number)
				: constant === undefined
					? undefined
					: constant.kind === "undefined"
						? "undefined"
						: String(constant.value);
			if (key === undefined) return undefined;
			keys.add(key);
		}
		return keys;
	}
	#scanReads(
		accesses: ReadonlyArray<CellAccess>,
		write: CellAccess,
		limit: number,
		root = write.value,
	): CellReads {
		const reads: Array<Pick<CellAccess, "function" | "instruction">> = [];
		let visits = 0;
		const rejected = (exhausted = false): CellReads => ({
			reads: undefined,
			visits,
			exhausted,
		});

		for (const access of accesses) {
			const fn = this.#program.function(access.function),
				pending = access === write ? [root, access.value] : [access.value],
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
				if (fn.kernel.valueFirstHandlerUse(value) >= 0) return rejected();
				for (
					let use = fn.kernel.valueFirstUse(value);
					use >= 0;
					use = fn.kernel.useNext(use)
				) {
					if (++visits > limit) return rejected(true);
					const instruction = fn.kernel.useInstruction(use),
						operand = fn.kernel.useOperand(use);
					if (access.function === write.function && instruction === write.instruction)
						continue;
					if (fn.instructionKind(instruction) !== "operation") return rejected();
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
					if (["loadPropertyStatic", "loadProperty"].includes(opcode) && operand === 0) {
						reads.push({
							function: fn.id,
							instruction,
						});
						continue;
					}
					return rejected();
				}
			}
		}
		return { reads, visits, exhausted: false };
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
