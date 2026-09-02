import { CoreEditor } from "./core-editor.ts";
import {
	CORE_FUNCTION_HAS_BRANCHES,
	CORE_FUNCTION_HAS_CANDIDATE_OPCODES,
	scanCoreFunctionFeatures,
} from "./core-function-features.ts";
import { coreInstructionId } from "./core-ir.ts";
import type {
	CoreAttributeValue,
	CoreBlockId,
	CoreEdge,
	CoreFactId,
	CoreFunctionId,
	CoreImmediate,
	CoreInstructionAttributes,
	CoreInstructionId,
	CoreOpcodeId,
	CoreOpcodeRegistry,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreChangeSet, CoreFunctionStore, CoreProgram } from "./core-store.ts";

const DEAD_CODE_RULE = 0x8000_0000;
const TYPEOF_RESULTS: ReadonlySet<string> = new Set([
	"undefined",
	"object",
	"boolean",
	"number",
	"string",
	"symbol",
	"bigint",
	"function",
]);

class SparseNumericQueue {
	#items: Int32Array;
	#membership: Uint32Array;
	#head = 0;
	#tail = 0;
	#epoch = 1;
	#pushes = 0;
	#maximumDepth = 0;

	constructor(capacity: number) {
		this.#items = new Int32Array(Math.max(16, capacity));
		this.#membership = new Uint32Array(Math.max(16, capacity));
	}

	get pushes(): number {
		return this.#pushes;
	}

	get maximumDepth(): number {
		return this.#maximumDepth;
	}

	get empty(): boolean {
		return this.#head === this.#tail;
	}

	push(value: number): boolean {
		this.#growMembership(value + 1);
		if (this.#membership[value] === this.#epoch) return false;
		this.#membership[value] = this.#epoch;
		this.#growItems(this.#tail + 1);
		this.#items[this.#tail++] = value;
		this.#pushes++;
		this.#maximumDepth = Math.max(this.#maximumDepth, this.#tail - this.#head);
		return true;
	}

	pop(): number | undefined {
		if (this.#head === this.#tail) return undefined;
		const value = this.#items[this.#head++]!;
		this.#membership[value] = 0;
		return value;
	}

	#growItems(required: number): void {
		if (required <= this.#items.length) return;
		const next = new Int32Array(Math.max(required, this.#items.length * 2));
		next.set(this.#items);
		this.#items = next;
	}

	#growMembership(required: number): void {
		if (required <= this.#membership.length) return;
		const next = new Uint32Array(Math.max(required, this.#membership.length * 2));
		next.set(this.#membership);
		this.#membership = next;
	}
}

export interface CoreLocalOptimizerStatistics {
	readonly instructionQueuePushes: number;
	readonly instructionQueuePops: number;
	readonly instructionQueueMaximumDepth: number;
	readonly blockQueuePushes: number;
	readonly blockQueuePops: number;
	readonly blockQueueMaximumDepth: number;
	readonly rulesConsidered: number;
	readonly rulesApplied: number;
	readonly edits: number;
	readonly editSessions: number;
	readonly workBudgetExhausted: boolean;
	readonly editBudgetExhausted: boolean;
}

export interface CoreLocalOptimizerResult {
	readonly changes: CoreChangeSet | undefined;
	readonly statistics: CoreLocalOptimizerStatistics;
}

export interface CoreLocalInstructionRule {
	readonly name: string;
	readonly opcodes: ReadonlyArray<CoreOpcodeId>;
	run(optimizer: CoreLocalOptimizer, instruction: CoreInstructionId): boolean;
}

export interface CoreLocalBlockRule {
	readonly name: string;
	run(optimizer: CoreLocalOptimizer, block: CoreBlockId): boolean;
}

export interface CoreLocalOptimizerOptions {
	readonly maxWorkItems?: number;
	readonly maxEdits?: number;
	readonly budgetExhaustion?: "stop" | "error";
	readonly additionalRules?: ReadonlyArray<CoreLocalInstructionRule>;
	readonly ruleRegistry?: CoreLocalRuleRegistry;
}

const COPY_PROPAGATION_RULE: CoreLocalInstructionRule = {
	name: "local-copy-propagation",
	opcodes: [],
	run(optimizer, instruction) {
		return optimizer.propagateCopy(instruction);
	},
};

const CONSTANT_FOLDING_RULE: CoreLocalInstructionRule = {
	name: "local-constant-folding",
	opcodes: [],
	run(optimizer, instruction) {
		return optimizer.foldConstant(instruction);
	},
};

const REPRESENTED_TONUMERIC_RULE: CoreLocalInstructionRule = {
	name: "represented-tonumeric-elision",
	opcodes: [],
	run(optimizer, instruction) {
		return optimizer.eliminateRepresentedToNumeric(instruction);
	},
};

const TYPEOF_COMPARISON_RULE: CoreLocalInstructionRule = {
	name: "typeof-comparison-canonicalization",
	opcodes: [],
	run(optimizer, instruction) {
		return optimizer.canonicalizeTypeofComparison(instruction);
	},
};

const STATIC_PROPERTY_KEY_RULE: CoreLocalInstructionRule = {
	name: "fold-static-property-keys",
	opcodes: [],
	run(optimizer, instruction) {
		return optimizer.foldStaticPropertyKey(instruction);
	},
};

const CONTROL_FOLDING_RULE: CoreLocalBlockRule = {
	name: "local-control-folding",
	run(optimizer, block) {
		return optimizer.foldControl(block);
	},
};

const VALUE_NUMBERING_RULE: CoreLocalBlockRule = {
	name: "local-value-numbering",
	run(optimizer, block) {
		return optimizer.eliminateLocalDuplicates(block);
	},
};

const NUMBER_HASH_VIEW = new DataView(new ArrayBuffer(8));

function mixHash(hash: number, value: number): number {
	return Math.imul(hash ^ value, 0x0100_0193) >>> 0;
}

function hashString(hash: number, value: string): number {
	let result = mixHash(hash, value.length);
	for (let index = 0; index < value.length; index++) {
		result = mixHash(result, value.charCodeAt(index));
	}
	return result;
}

function isAttributeArray(
	value: CoreAttributeValue,
): value is ReadonlyArray<CoreAttributeValue> {
	return Array.isArray(value);
}

function hashAttribute(hash: number, value: CoreAttributeValue): number {
	if (value === undefined) return mixHash(hash, 1);
	if (value === null) return mixHash(hash, 2);
	if (typeof value === "boolean") return mixHash(hash, value ? 4 : 3);
	if (typeof value === "number") {
		NUMBER_HASH_VIEW.setFloat64(0, value);
		return mixHash(
			mixHash(mixHash(hash, 5), NUMBER_HASH_VIEW.getUint32(0)),
			NUMBER_HASH_VIEW.getUint32(4),
		);
	}
	if (typeof value === "string") return hashString(mixHash(hash, 6), value);
	if (isAttributeArray(value)) {
		let result = mixHash(mixHash(hash, 7), value.length);
		for (const entry of value) result = hashAttribute(result, entry);
		return result;
	}
	const object = value;
	const keys = Object.keys(object).sort();
	let result = mixHash(mixHash(hash, 8), keys.length);
	for (const key of keys) {
		result = hashAttribute(hashString(result, key), object[key]);
	}
	return result;
}

function attributesEqual(left: CoreAttributeValue, right: CoreAttributeValue): boolean {
	if (Object.is(left, right)) return true;
	if (isAttributeArray(left)) {
		return (
			isAttributeArray(right) &&
			left.length === right.length &&
			left.every((entry, index) => attributesEqual(entry, right[index]))
		);
	}
	if (
		left === null ||
		right === null ||
		typeof left !== "object" ||
		typeof right !== "object" ||
		isAttributeArray(right)
	) {
		return false;
	}
	const leftObject = left;
	const rightObject = right;
	const leftKeys = Object.keys(leftObject).sort();
	const rightKeys = Object.keys(rightObject).sort();
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key, index) =>
				key === rightKeys[index] &&
				attributesEqual(leftObject[key], rightObject[key]),
		)
	);
}

type LocalConstant =
	| { readonly kind: "undefined" }
	| { readonly kind: "null" }
	| { readonly kind: "boolean"; readonly value: boolean }
	| { readonly kind: "number"; readonly value: number }
	| { readonly kind: "string"; readonly index: number };

export class CoreLocalRuleRegistry {
	readonly #opcodeRegistry: CoreOpcodeRegistry;
	readonly rules: ReadonlyArray<CoreLocalInstructionRule>;
	readonly blockRules: ReadonlyArray<CoreLocalBlockRule>;
	readonly dispatch: Uint32Array;
	readonly moveOpcode: CoreOpcodeId | undefined;

	constructor(
		program: CoreProgram,
		additionalRules: ReadonlyArray<CoreLocalInstructionRule> = [],
	) {
		this.#opcodeRegistry = program.registry;
		this.moveOpcode = program.registry.get("move")?.id;
		this.rules = [
			...(this.moveOpcode === undefined
				? []
				: [{ ...COPY_PROPAGATION_RULE, opcodes: [this.moveOpcode] }]),
			{
				...CONSTANT_FOLDING_RULE,
				opcodes: ["binary", "unary", "typeofCompare"].flatMap((opcode) => {
					const id = program.registry.get(opcode)?.id;
					return id === undefined ? [] : [id];
				}),
			},
			...(program.registry.get("unary") === undefined
				? []
				: [
						{
							...REPRESENTED_TONUMERIC_RULE,
							opcodes: [program.registry.require("unary").id],
						},
					]),
			...(program.registry.get("binary") === undefined
				? []
				: [
						{
							...TYPEOF_COMPARISON_RULE,
							opcodes: [program.registry.require("binary").id],
						},
					]),
			{
				...STATIC_PROPERTY_KEY_RULE,
				opcodes: ["loadProperty", "storeProperty"].flatMap((opcode) => {
					const id = program.registry.get(opcode)?.id;
					return id === undefined ? [] : [id];
				}),
			},
			...additionalRules,
		];
		this.blockRules = [CONTROL_FOLDING_RULE, VALUE_NUMBERING_RULE];
		if (this.rules.length > 31) {
			throw new Error("Core local optimizer supports at most 31 opcode rules");
		}
		this.dispatch = new Uint32Array(program.registry.entries().length);
		for (let ruleIndex = 0; ruleIndex < this.rules.length; ruleIndex++) {
			const bit = 1 << ruleIndex;
			for (const opcode of this.rules[ruleIndex]!.opcodes) {
				this.dispatch[opcode] = (this.dispatch[opcode] ?? 0) | bit;
			}
		}
		for (const descriptor of program.registry.entries()) {
			if (descriptor.discardable || descriptor.opcode === "unary") {
				this.dispatch[descriptor.id] =
					(this.dispatch[descriptor.id] ?? 0) | DEAD_CODE_RULE;
			}
		}
	}

	assertProgram(program: CoreProgram): void {
		if (program.registry !== this.#opcodeRegistry) {
			throw new Error("Core local rule registry belongs to another opcode registry");
		}
	}
}

export class CoreLocalOptimizer {
	readonly #program: CoreProgram;
	readonly #fn: CoreFunctionStore;
	readonly #instructionQueue: SparseNumericQueue;
	readonly #blockQueue: SparseNumericQueue;
	readonly #rules: ReadonlyArray<CoreLocalInstructionRule>;
	readonly #blockRules: ReadonlyArray<CoreLocalBlockRule>;
	readonly #dispatch: Uint32Array;
	readonly #features: number;
	readonly #maxWorkItems: number;
	readonly #maxEdits: number;
	readonly #budgetExhaustion: "stop" | "error";
	readonly #moveOpcode: CoreOpcodeId | undefined;
	#editor: CoreEditor | undefined;
	#handlerUseCounts: Uint32Array | undefined;
	#instructionQueuePops = 0;
	#blockQueuePops = 0;
	#rulesConsidered = 0;
	#rulesApplied = 0;
	#workBudgetExhausted = false;
	#editBudgetExhausted = false;

	constructor(
		program: CoreProgram,
		functionId: CoreFunctionId,
		options: CoreLocalOptimizerOptions = {},
	) {
		this.#program = program;
		this.#fn = program.function(functionId);
		this.#instructionQueue = new SparseNumericQueue(this.#fn.instructionCapacity);
		this.#blockQueue = new SparseNumericQueue(this.#fn.blockCapacity);
		this.#maxWorkItems = options.maxWorkItems ?? 2_000_000;
		this.#maxEdits = options.maxEdits ?? 1_000_000;
		this.#budgetExhaustion = options.budgetExhaustion ?? "stop";
		if (!Number.isSafeInteger(this.#maxWorkItems) || this.#maxWorkItems < 1) {
			throw new Error("Core local optimizer work budget must be a positive integer");
		}
		if (!Number.isSafeInteger(this.#maxEdits) || this.#maxEdits < 0) {
			throw new Error("Core local optimizer edit budget must be a non-negative integer");
		}
		if (options.ruleRegistry !== undefined && options.additionalRules !== undefined) {
			throw new Error("Core local optimizer cannot extend a shared rule registry");
		}
		const ruleRegistry =
			options.ruleRegistry ?? new CoreLocalRuleRegistry(program, options.additionalRules);
		ruleRegistry.assertProgram(program);
		this.#moveOpcode = ruleRegistry.moveOpcode;
		this.#rules = ruleRegistry.rules;
		this.#blockRules = ruleRegistry.blockRules;
		this.#dispatch = ruleRegistry.dispatch;
		this.#features = scanCoreFunctionFeatures(this.#fn, this.#dispatch);
	}

	run(initialChanges?: ReadonlyArray<CoreChangeSet>): CoreLocalOptimizerResult {
		if (initialChanges === undefined) {
			if ((this.#features & CORE_FUNCTION_HAS_CANDIDATE_OPCODES) !== 0) {
				for (let id = 0; id < this.#fn.instructionCapacity; id++) {
					this.#enqueueInstruction(coreInstructionId(id));
				}
			}
			if (
				(this.#features &
					(CORE_FUNCTION_HAS_BRANCHES | CORE_FUNCTION_HAS_CANDIDATE_OPCODES)) !==
				0
			) {
				for (let id = 0; id < this.#fn.blockCapacity; id++) {
					this.#enqueueBlock(id as CoreBlockId);
				}
			}
		} else {
			for (const changes of initialChanges) this.#submit(changes);
		}

		while (this.#instructionQueuePops + this.#blockQueuePops < this.#maxWorkItems) {
			const queuedInstruction = this.#instructionQueue.pop();
			if (queuedInstruction !== undefined) {
				this.#drainInstruction(coreInstructionId(queuedInstruction));
			} else {
				const queuedBlock = this.#blockQueue.pop();
				if (queuedBlock === undefined) break;
				this.#drainBlock(queuedBlock as CoreBlockId);
			}
			if ((this.#editor?.pendingEdits ?? 0) >= this.#maxEdits) {
				this.#editBudgetExhausted = true;
				break;
			}
		}
		if (
			this.#instructionQueuePops + this.#blockQueuePops >= this.#maxWorkItems &&
			(!this.#instructionQueue.empty || !this.#blockQueue.empty)
		) {
			this.#workBudgetExhausted = true;
		}
		if (
			this.#budgetExhaustion === "error" &&
			(this.#workBudgetExhausted || this.#editBudgetExhausted)
		) {
			throw new Error("Required Core local optimizer exhausted its budget");
		}

		const changes = this.#editor?.commit();
		return Object.freeze({ changes, statistics: this.#statistics(changes?.edits ?? 0) });
	}

	propagateCopy(instruction: CoreInstructionId): boolean {
		if (
			this.#fn.kernel.instructionLive(instruction) === 0 ||
			this.#moveOpcode === undefined ||
			this.#fn.kernel.instructionOpcode(instruction) !== this.#moveOpcode ||
			this.#fn.kernel.instructionOperandCount(instruction) !== 1 ||
			this.#fn.kernel.instructionResultCount(instruction) !== 1
		) {
			return false;
		}
		const input = this.#fn.kernel.operandAt(
			this.#fn.kernel.instructionOperandStart(instruction),
		);
		const result = this.#fn.kernel.resultAt(
			this.#fn.kernel.instructionResultStart(instruction),
		);
		if (this.#fn.valueRepresentation(result) !== this.#fn.valueRepresentation(input)) {
			return false;
		}
		this.#replaceInstructionWithValue(instruction, result, input);
		return true;
	}

	eliminateRepresentedToNumeric(instruction: CoreInstructionId): boolean {
		if (
			this.#fn.kernel.instructionLive(instruction) === 0 ||
			this.#fn.kernel.instructionOpcode(instruction) < 0 ||
			this.#fn.instructionOpcodeName(instruction) !== "unary" ||
			this.#fn.instructionAttributes(instruction).operator !== "tonumeric" ||
			this.#fn.kernel.instructionOperandCount(instruction) !== 1 ||
			this.#fn.kernel.instructionResultCount(instruction) !== 1
		) {
			return false;
		}
		const input = this.#fn.kernel.operandAt(
			this.#fn.kernel.instructionOperandStart(instruction),
		);
		const result = this.#fn.kernel.resultAt(
			this.#fn.kernel.instructionResultStart(instruction),
		);
		const representation = this.#fn.valueRepresentation(input);
		if (
			(representation !== "f64" && representation !== "i32") ||
			this.#fn.valueRepresentation(result) !== representation
		) {
			return false;
		}
		this.#replaceInstructionWithValue(instruction, result, input);
		return true;
	}

	foldConstant(instruction: CoreInstructionId): boolean {
		if (
			this.#fn.kernel.instructionLive(instruction) === 0 ||
			this.#fn.kernel.instructionOpcode(instruction) < 0 ||
			this.#fn.kernel.instructionResultCount(instruction) !== 1
		) {
			return false;
		}
		const folded = this.#foldInstruction(instruction);
		if (folded === undefined) return false;
		const replacement = this.#constantOpcode(folded);
		if (this.#program.registry.get(replacement.opcode) === undefined) return false;
		const operandStart = this.#fn.kernel.instructionOperandStart(instruction);
		const operandCount = this.#fn.kernel.instructionOperandCount(instruction);
		const operands = Array.from({ length: operandCount }, (_, index) =>
			this.#fn.kernel.operandAt(operandStart + index),
		);
		const result = this.#fn.kernel.resultAt(
			this.#fn.kernel.instructionResultStart(instruction),
		);
		this.#edit().replaceInstruction(instruction, replacement.opcode, [], {
			attributes: replacement.attributes,
			sourcePosition: this.#fn.instructionSourcePosition(instruction),
		});
		for (const operand of operands) this.#wakeValueDefinition(operand);
		this.#wakeValueUsers(result);
		this.#enqueueInstruction(instruction);
		return true;
	}

	canonicalizeTypeofComparison(instruction: CoreInstructionId): boolean {
		if (
			this.#fn.kernel.instructionLive(instruction) === 0 ||
			this.#fn.kernel.instructionOpcode(instruction) < 0 ||
			this.#fn.instructionOpcodeName(instruction) !== "binary" ||
			this.#fn.kernel.instructionOperandCount(instruction) !== 2 ||
			this.#fn.kernel.instructionResultCount(instruction) !== 1 ||
			this.#program.registry.get("typeofCompare") === undefined
		) {
			return false;
		}
		const operator = this.#fn.instructionAttributes(instruction).operator;
		if (
			operator !== "===" &&
			operator !== "!==" &&
			operator !== "==" &&
			operator !== "!="
		) {
			return false;
		}
		const left = this.#instructionOperand(instruction, 0)!;
		const right = this.#instructionOperand(instruction, 1)!;
		const typeofInput = (value: CoreValueId): CoreValueId | undefined => {
			if (this.#fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
			const definition = coreInstructionId(this.#fn.kernel.valueDefinitionOwner(value));
			if (
				this.#fn.kernel.instructionLive(definition) === 0 ||
				this.#fn.kernel.instructionOpcode(definition) < 0 ||
				this.#fn.instructionOpcodeName(definition) !== "unary" ||
				this.#fn.instructionAttributes(definition).operator !== "typeof"
			) {
				return undefined;
			}
			return this.#instructionOperand(definition, 0);
		};
		const leftInput = typeofInput(left);
		const rightInput = typeofInput(right);
		const input = leftInput ?? rightInput;
		const constant = this.#constantForValue(leftInput === undefined ? left : right);
		if (input === undefined || constant?.kind !== "string") return false;
		const expected = String.fromCharCode(
			...(this.#program.stringConstants[constant.index] ?? []),
		);
		if (!TYPEOF_RESULTS.has(expected)) return false;
		const result = this.#fn.kernel.resultAt(
			this.#fn.kernel.instructionResultStart(instruction),
		);
		this.#edit().replaceInstruction(instruction, "typeofCompare", [input], {
			attributes: { expected, negated: operator === "!==" || operator === "!=" },
			sourcePosition: this.#fn.instructionSourcePosition(instruction),
		});
		this.#wakeValueDefinition(left);
		this.#wakeValueDefinition(right);
		this.#wakeValueUsers(result);
		this.#enqueueInstruction(instruction);
		return true;
	}

	foldStaticPropertyKey(instruction: CoreInstructionId): boolean {
		if (
			this.#fn.kernel.instructionLive(instruction) === 0 ||
			this.#fn.kernel.instructionOpcode(instruction) < 0
		) {
			return false;
		}
		const opcode = this.#fn.instructionOpcodeName(instruction);
		if (opcode !== "loadProperty" && opcode !== "storeProperty") return false;
		const replacement =
			opcode === "loadProperty" ? "loadPropertyStatic" : "storePropertyStatic";
		if (this.#program.registry.get(replacement) === undefined) return false;
		const key = this.#instructionOperand(instruction, 1);
		if (key === undefined) return false;
		const constant = this.#constantForValue(key);
		if (constant?.kind !== "string") return false;
		const operandStart = this.#fn.kernel.instructionOperandStart(instruction);
		const operandCount = this.#fn.kernel.instructionOperandCount(instruction);
		const inputs = Array.from({ length: operandCount }, (_, index) =>
			this.#fn.kernel.operandAt(operandStart + index),
		).filter((_, index) => index !== 1);
		const resultStart = this.#fn.kernel.instructionResultStart(instruction);
		const resultCount = this.#fn.kernel.instructionResultCount(instruction);
		this.#edit().replaceInstruction(instruction, replacement, inputs, {
			attributes: {
				...this.#fn.instructionAttributes(instruction),
				stringIndex: constant.index,
			},
			sourcePosition: this.#fn.instructionSourcePosition(instruction),
		});
		this.#wakeValueDefinition(key);
		for (let index = 0; index < resultCount; index++) {
			this.#wakeValueUsers(this.#fn.kernel.resultAt(resultStart + index));
		}
		return true;
	}

	foldControl(block: CoreBlockId): boolean {
		if (this.#fn.kernel.blockLive(block) === 0) return false;
		const terminator = this.#fn.blockTerminator(block);
		const kind = this.#fn.instructionKind(terminator);
		let selected: CoreEdge | undefined;
		let removedFact: CoreFactId | undefined;
		let condition: CoreValueId | undefined;
		if (kind === "branch") {
			condition = this.#instructionOperand(terminator, 0);
			if (condition === undefined) return false;
			const consequent = this.#copyTerminatorEdge(terminator, 0);
			const alternate = this.#copyTerminatorEdge(terminator, 1);
			const constant = this.#constantForValue(condition);
			if (constant?.kind === "boolean") {
				selected = constant.value ? consequent : alternate;
			} else if (this.#sameEdge(consequent, alternate)) {
				selected = consequent;
			}
		} else if (kind === "switch") {
			condition = this.#instructionOperand(terminator, 0);
			if (condition === undefined) return false;
			const constant = this.#constantForValue(condition);
			if (constant !== undefined) {
				const edgeStart = this.#fn.kernel.terminatorEdgeStart(terminator);
				const edgeCount = this.#fn.kernel.terminatorEdgeCount(terminator);
				for (let offset = 0; offset < edgeCount - 1; offset++) {
					const value = this.#fn.kernel.terminatorEdgeCaseValue(edgeStart + offset);
					if (value !== undefined && this.#immediateEqualsConstant(value, constant)) {
						selected = this.#copyTerminatorEdge(terminator, offset);
						break;
					}
				}
				selected ??= this.#copyTerminatorEdge(terminator, edgeCount - 1);
			}
		} else if (kind === "guard") {
			const success = this.#copyTerminatorEdge(terminator, 0);
			const fallback = this.#copyTerminatorEdge(terminator, 1);
			if (!this.#sameEdge(success, fallback)) return false;
			const factId = this.#fn.kernel.terminatorFact(terminator);
			if (factId === undefined) return false;
			const fact = this.#fn.fact(factId);
			const exclusivelyGuardsTerminator = fact.obligations.every(
				(obligation) =>
					obligation.kind === "guard" && obligation.instruction === terminator,
			);
			let usedByRefinement = false;
			for (let id = 0; id < this.#fn.instructionCapacity; id++) {
				const instruction = coreInstructionId(id);
				if (
					this.#fn.kernel.instructionLive(instruction) !== 0 &&
					this.#fn.kernel.instructionOpcode(instruction) >= 0 &&
					this.#fn.instructionEffectRefinement(instruction)?.proof === factId
				) {
					usedByRefinement = true;
					break;
				}
			}
			if (exclusivelyGuardsTerminator && !usedByRefinement) {
				selected = success;
				removedFact = factId;
			}
		}
		if (selected === undefined) return false;
		if (condition !== undefined) this.#wakeValueDefinition(condition);
		const editor = this.#edit();
		editor.replaceTerminator(block, { kind: "jump", edge: selected });
		if (removedFact !== undefined) editor.removeFact(removedFact);
		return true;
	}

	eliminateLocalDuplicates(block: CoreBlockId): boolean {
		if (this.#fn.kernel.blockLive(block) === 0) return false;
		const available = new Map<
			number,
			CoreInstructionId | Array<CoreInstructionId>
		>();
		const replacements: Array<{
			readonly instruction: CoreInstructionId;
			readonly replacement: CoreValueId;
		}> = [];
		for (const instruction of this.#fn.bodyInstructionIds(block)) {
			const descriptor = this.#program.registry.byId(
				this.#fn.instructionOpcode(instruction),
			);
			const effects = descriptor.effects;
			if (
				this.#fn.kernel.instructionResultCount(instruction) !== 1 ||
				!descriptor.discardable ||
				effects.reads.length > 0 ||
				effects.writes.length > 0 ||
				effects.mayThrow ||
				effects.maySuspend ||
				effects.mayGc ||
				effects.callsUserCode
			) {
				continue;
			}
			const operandStart = this.#fn.kernel.instructionOperandStart(instruction);
			const operandCount = this.#fn.kernel.instructionOperandCount(instruction);
			let hash = mixHash(0x811c_9dc5, descriptor.id);
			for (let index = 0; index < operandCount; index++) {
				hash = mixHash(hash, this.#fn.kernel.operandAt(operandStart + index));
			}
			hash = hashAttribute(hash, this.#fn.instructionAttributes(instruction));
			const bucket = available.get(hash);
			const existing = Array.isArray(bucket)
				? bucket.find((candidate) => this.#sameValueNumber(candidate, instruction))
				: bucket !== undefined && this.#sameValueNumber(bucket, instruction)
					? bucket
					: undefined;
			if (existing !== undefined) {
				replacements.push({
					instruction,
					replacement: this.#fn.kernel.resultAt(
						this.#fn.kernel.instructionResultStart(existing),
					),
				});
			} else if (bucket === undefined) {
				available.set(hash, instruction);
			} else if (Array.isArray(bucket)) {
				bucket.push(instruction);
			} else {
				available.set(hash, [bucket, instruction]);
			}
		}
		if (replacements.length === 0) return false;
		const editor = this.#edit();
		for (const { instruction, replacement } of replacements) {
			if (this.#fn.kernel.instructionLive(instruction) === 0) continue;
			const result = this.#fn.kernel.resultAt(
				this.#fn.kernel.instructionResultStart(instruction),
			);
			const operandStart = this.#fn.kernel.instructionOperandStart(instruction);
			const operandCount = this.#fn.kernel.instructionOperandCount(instruction);
			this.#wakeValueUsers(result);
			editor.replaceValueUses(result, replacement);
			for (let index = 0; index < operandCount; index++) {
				this.#wakeValueDefinition(this.#fn.kernel.operandAt(operandStart + index));
			}
			editor.removeInstruction(instruction);
		}
		return true;
	}

	#sameValueNumber(left: CoreInstructionId, right: CoreInstructionId): boolean {
		if (
			this.#fn.kernel.instructionOpcode(left) !==
				this.#fn.kernel.instructionOpcode(right) ||
			this.#fn.kernel.instructionOperandCount(left) !==
				this.#fn.kernel.instructionOperandCount(right) ||
			!attributesEqual(
				this.#fn.instructionAttributes(left),
				this.#fn.instructionAttributes(right),
			)
		) {
			return false;
		}
		const leftStart = this.#fn.kernel.instructionOperandStart(left);
		const rightStart = this.#fn.kernel.instructionOperandStart(right);
		const count = this.#fn.kernel.instructionOperandCount(left);
		for (let index = 0; index < count; index++) {
			if (
				this.#fn.kernel.operandAt(leftStart + index) !==
				this.#fn.kernel.operandAt(rightStart + index)
			) {
				return false;
			}
		}
		return true;
	}

	#drainInstruction(instruction: CoreInstructionId): void {
		this.#instructionQueuePops++;
		if (this.#fn.kernel.instructionLive(instruction) === 0) return;
		const opcode = this.#fn.kernel.instructionOpcode(instruction);
		if (opcode < 0) return;
		let mask = this.#dispatch[opcode] ?? 0;
		for (let ruleIndex = 0; ruleIndex < this.#rules.length; ruleIndex++) {
			const bit = 1 << ruleIndex;
			if ((mask & bit) === 0) continue;
			this.#rulesConsidered++;
			if (this.#rules[ruleIndex]!.run(this, instruction)) {
				this.#rulesApplied++;
				mask = 0;
				break;
			}
		}
		if (
			(mask & DEAD_CODE_RULE) !== 0 &&
			this.#fn.kernel.instructionLive(instruction) !== 0
		) {
			this.#rulesConsidered++;
			if (this.#removeDeadInstruction(instruction)) this.#rulesApplied++;
		}
	}

	#drainBlock(block: CoreBlockId): void {
		this.#blockQueuePops++;
		if (this.#fn.kernel.blockLive(block) === 0) return;
		for (const rule of this.#blockRules) {
			this.#rulesConsidered++;
			if (rule.run(this, block)) this.#rulesApplied++;
		}
	}

	#removeDeadInstruction(instruction: CoreInstructionId): boolean {
		const descriptor = this.#program.registry.byId(
			this.#fn.instructionOpcode(instruction),
		);
		if (
			!descriptor.discardable &&
			!(
				descriptor.opcode === "unary" &&
				this.#fn.instructionAttributes(instruction).operator === "typeof"
			)
		) {
			return false;
		}
		const resultStart = this.#fn.kernel.instructionResultStart(instruction);
		const resultCount = this.#fn.kernel.instructionResultCount(instruction);
		for (let index = 0; index < resultCount; index++) {
			if (this.#valueHasUses(this.#fn.kernel.resultAt(resultStart + index))) {
				return false;
			}
		}
		const operandStart = this.#fn.kernel.instructionOperandStart(instruction);
		const operandCount = this.#fn.kernel.instructionOperandCount(instruction);
		for (let index = 0; index < operandCount; index++) {
			this.#wakeValueDefinition(this.#fn.kernel.operandAt(operandStart + index));
		}
		this.#edit().removeInstruction(instruction);
		return true;
	}

	#valueHasUses(value: CoreValueId): boolean {
		if (this.#fn.kernel.valueUseCount(value) > 0) return true;
		this.#handlerUseCounts ??= this.#buildHandlerUseCounts();
		return (this.#handlerUseCounts[value] ?? 0) > 0;
	}

	#buildHandlerUseCounts(): Uint32Array {
		const counts = new Uint32Array(this.#fn.valueCapacity);
		for (let id = 0; id < this.#fn.blockCapacity; id++) {
			const block = id as CoreBlockId;
			if (this.#fn.kernel.blockLive(block) === 0) continue;
			const start = this.#fn.kernel.blockHandlerArgumentStart(block);
			const count = this.#fn.kernel.blockHandlerArgumentCount(block);
			for (let index = 0; index < count; index++) {
				const value = this.#fn.kernel.handlerArgumentAt(start + index);
				counts[value] = (counts[value] ?? 0) + 1;
			}
		}
		return counts;
	}

	#wakeValueUsers(value: CoreValueId): void {
		for (
			let use = this.#fn.kernel.valueFirstUse(value);
			use >= 0;
			use = this.#fn.kernel.useNext(use)
		) {
			if (this.#fn.kernel.useLive(use) !== 0) {
				const instruction = this.#fn.kernel.useInstruction(use);
				this.#enqueueBlock(this.#fn.instructionBlock(instruction));
				if (this.#fn.kernel.instructionOpcode(instruction) >= 0) {
					this.#enqueueInstruction(instruction);
				}
			}
		}
	}

	#wakeValueDefinition(value: CoreValueId): void {
		if (this.#fn.kernel.valueDefinitionKind(value) !== 1) return;
		this.#enqueueInstruction(
			coreInstructionId(this.#fn.kernel.valueDefinitionOwner(value)),
		);
	}

	#enqueueInstruction(instruction: CoreInstructionId): void {
		if (this.#fn.kernel.instructionLive(instruction) === 0) return;
		const opcode = this.#fn.kernel.instructionOpcode(instruction);
		if (opcode >= 0 && this.#dispatch[opcode] !== 0) {
			this.#instructionQueue.push(instruction);
		}
	}

	#enqueueBlock(block: CoreBlockId): void {
		if (this.#fn.kernel.blockLive(block) === 0) return;
		this.#blockQueue.push(block);
	}

	#submit(changes: CoreChangeSet): void {
		if (changes.function !== this.#fn.id) {
			throw new Error("Core local optimizer received changes for another function");
		}
		for (const instruction of changes.instructions) {
			this.#enqueueInstruction(instruction);
			if (this.#fn.kernel.instructionLive(instruction) !== 0) {
				this.#enqueueBlock(this.#fn.instructionBlock(instruction));
			}
		}
		for (const instruction of changes.calls) this.#enqueueInstruction(instruction);
		for (const value of changes.values) {
			if (this.#fn.kernel.valueLive(value) === 0) continue;
			this.#wakeValueDefinition(value);
			this.#wakeValueUsers(value);
		}
		for (const block of changes.blocks) {
			this.#enqueueBlock(block);
			this.#enqueueBlockInstructions(block);
		}
		for (const edge of changes.edges) {
			this.#enqueueBlock(edge.source);
			this.#enqueueBlock(edge.target);
			this.#enqueueBlockInstructions(edge.source);
			this.#enqueueBlockInstructions(edge.target);
		}
	}

	#enqueueBlockInstructions(block: CoreBlockId): void {
		if (this.#fn.kernel.blockLive(block) === 0) return;
		for (
			let instruction = this.#fn.kernel.blockFirstInstruction(block);
			instruction >= 0;
			instruction = this.#fn.kernel.instructionNext(coreInstructionId(instruction))
		) {
			this.#enqueueInstruction(coreInstructionId(instruction));
		}
	}

	#instructionOperand(
		instruction: CoreInstructionId,
		index: number,
	): CoreValueId | undefined {
		const count = this.#fn.kernel.instructionOperandCount(instruction);
		if (index < 0 || index >= count) return undefined;
		return this.#fn.kernel.operandAt(
			this.#fn.kernel.instructionOperandStart(instruction) + index,
		);
	}

	#copyTerminatorEdge(instruction: CoreInstructionId, offset: number): CoreEdge {
		const edgeStart = this.#fn.kernel.terminatorEdgeStart(instruction);
		const edgeCount = this.#fn.kernel.terminatorEdgeCount(instruction);
		if (offset < 0 || offset >= edgeCount) {
			throw new Error(`Malformed Core ${this.#fn.instructionKind(instruction)} edges`);
		}
		const row = edgeStart + offset;
		const argumentStart = this.#fn.kernel.terminatorEdgeArgumentStart(row);
		const argumentCount = this.#fn.kernel.terminatorEdgeArgumentCount(row);
		return {
			block: this.#fn.kernel.terminatorEdgeBlock(row),
			arguments: Array.from({ length: argumentCount }, (_, index) =>
				this.#fn.kernel.operandAt(argumentStart + index),
			),
		};
	}

	#constantForValue(value: CoreValueId): LocalConstant | undefined {
		if (this.#fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(this.#fn.kernel.valueDefinitionOwner(value));
		if (
			this.#fn.kernel.instructionLive(instruction) === 0 ||
			this.#fn.kernel.instructionOpcode(instruction) < 0
		) {
			return undefined;
		}
		const attributes = this.#fn.instructionAttributes(instruction);
		switch (this.#fn.instructionOpcodeName(instruction)) {
			case "createUndefined":
				return { kind: "undefined" };
			case "createNull":
				return { kind: "null" };
			case "createBoolean":
				return typeof attributes.value === "boolean"
					? { kind: "boolean", value: attributes.value }
					: undefined;
			case "createNumber":
			case "createF64":
				return typeof attributes.value === "number"
					? { kind: "number", value: attributes.value }
					: undefined;
			case "createString":
				return typeof attributes.stringIndex === "number"
					? { kind: "string", index: attributes.stringIndex }
					: undefined;
			default:
				return undefined;
		}
	}

	#foldInstruction(instruction: CoreInstructionId): LocalConstant | undefined {
		const opcode = this.#fn.instructionOpcodeName(instruction);
		const attributes = this.#fn.instructionAttributes(instruction);
		if (opcode === "binary") {
			const leftValue = this.#instructionOperand(instruction, 0);
			const rightValue = this.#instructionOperand(instruction, 1);
			if (leftValue === undefined || rightValue === undefined) return undefined;
			const left = this.#constantForValue(leftValue);
			const right = this.#constantForValue(rightValue);
			if (left === undefined || right === undefined) return undefined;
			if (
				attributes.operator === "==" ||
				attributes.operator === "!=" ||
				attributes.operator === "===" ||
				attributes.operator === "!=="
			) {
				const loose = attributes.operator === "==" || attributes.operator === "!=";
				const equal = loose
					? this.#abstractPrimitiveEquality(left, right)
					: this.#strictPrimitiveEquality(left, right);
				return {
					kind: "boolean",
					value:
						attributes.operator === "!=" || attributes.operator === "!=="
							? !equal
							: equal,
				};
			}
			return left.kind === "number" && right.kind === "number"
				? this.#numberBinary(attributes.operator, left.value, right.value)
				: undefined;
		}
		if (opcode === "unary") {
			const inputValue = this.#instructionOperand(instruction, 0);
			const input =
				inputValue === undefined ? undefined : this.#constantForValue(inputValue);
			return input?.kind === "number"
				? this.#numberUnary(attributes.operator, input.value)
				: input?.kind === "boolean" && attributes.operator === "!"
					? { kind: "boolean", value: !input.value }
					: undefined;
		}
		if (opcode === "typeofCompare") {
			const inputValue = this.#instructionOperand(instruction, 0);
			const input =
				inputValue === undefined ? undefined : this.#constantForValue(inputValue);
			if (input === undefined || typeof attributes.expected !== "string") {
				return undefined;
			}
			const actual = input.kind === "null" ? "object" : input.kind;
			const matches = actual === attributes.expected;
			return {
				kind: "boolean",
				value: attributes.negated === true ? !matches : matches,
			};
		}
		return undefined;
	}

	#constantOpcode(constant: LocalConstant): {
		readonly opcode: string;
		readonly attributes: CoreInstructionAttributes;
	} {
		switch (constant.kind) {
			case "undefined":
				return { opcode: "createUndefined", attributes: {} };
			case "null":
				return { opcode: "createNull", attributes: {} };
			case "boolean":
				return { opcode: "createBoolean", attributes: { value: constant.value } };
			case "number": {
				const int32 =
					!Object.is(constant.value, -0) &&
					Number.isInteger(constant.value) &&
					constant.value >= -0x8000_0000 &&
					constant.value <= 0x7fff_ffff;
				return {
					opcode: int32 ? "createNumber" : "createF64",
					attributes: { value: constant.value },
				};
			}
			case "string":
				return {
					opcode: "createString",
					attributes: { stringIndex: constant.index },
				};
		}
	}

	#numberBinary(
		operator: CoreAttributeValue,
		left: number,
		right: number,
	): LocalConstant | undefined {
		switch (operator) {
			case "+":
				return { kind: "number", value: left + right };
			case "-":
				return { kind: "number", value: left - right };
			case "*":
				return { kind: "number", value: left * right };
			case "/":
				return { kind: "number", value: left / right };
			case "%":
				return { kind: "number", value: left % right };
			case "**":
				return { kind: "number", value: left ** right };
			case "&":
				return { kind: "number", value: left & right };
			case "|":
				return { kind: "number", value: left | right };
			case "^":
				return { kind: "number", value: left ^ right };
			case "<<":
				return { kind: "number", value: left << right };
			case ">>":
				return { kind: "number", value: left >> right };
			case ">>>":
				return { kind: "number", value: left >>> right };
			case "<":
				return { kind: "boolean", value: left < right };
			case "<=":
				return { kind: "boolean", value: left <= right };
			case ">":
				return { kind: "boolean", value: left > right };
			case ">=":
				return { kind: "boolean", value: left >= right };
			case "==":
			case "===":
				return { kind: "boolean", value: left === right };
			case "!=":
			case "!==":
				return { kind: "boolean", value: left !== right };
			default:
				return undefined;
		}
	}

	#numberUnary(operator: CoreAttributeValue, value: number): LocalConstant | undefined {
		switch (operator) {
			case "!":
				return { kind: "boolean", value: !value };
			case "-":
				return { kind: "number", value: -value };
			case "+":
				return { kind: "number", value };
			case "~":
				return { kind: "number", value: ~value };
			case "tonumeric":
				return { kind: "number", value };
			case "increment":
				return { kind: "number", value: value + 1 };
			case "decrement":
				return { kind: "number", value: value - 1 };
			default:
				return undefined;
		}
	}

	#strictPrimitiveEquality(left: LocalConstant, right: LocalConstant): boolean {
		if (left.kind !== right.kind) return false;
		switch (left.kind) {
			case "undefined":
			case "null":
				return true;
			case "boolean":
			case "number":
				return left.value === (right as { readonly value: unknown }).value;
			case "string":
				return (
					this.#decodeString(left.index) ===
					this.#decodeString((right as { readonly index: number }).index)
				);
		}
	}

	#abstractPrimitiveEquality(left: LocalConstant, right: LocalConstant): boolean {
		if (left.kind === right.kind) return this.#strictPrimitiveEquality(left, right);
		if (
			(left.kind === "null" && right.kind === "undefined") ||
			(left.kind === "undefined" && right.kind === "null")
		) {
			return true;
		}
		if (left.kind === "boolean") {
			return this.#abstractPrimitiveEquality(
				{ kind: "number", value: left.value ? 1 : 0 },
				right,
			);
		}
		if (right.kind === "boolean") {
			return this.#abstractPrimitiveEquality(left, {
				kind: "number",
				value: right.value ? 1 : 0,
			});
		}
		if (left.kind === "number" && right.kind === "string") {
			const value = this.#decodeString(right.index);
			return value !== undefined && left.value === Number(value);
		}
		if (left.kind === "string" && right.kind === "number") {
			const value = this.#decodeString(left.index);
			return value !== undefined && Number(value) === right.value;
		}
		return false;
	}

	#decodeString(index: number): string | undefined {
		const units = this.#program.stringConstants[index];
		return units === undefined ? undefined : String.fromCodePoint(...units);
	}

	#immediateEqualsConstant(immediate: CoreImmediate, constant: LocalConstant): boolean {
		if (immediate.kind !== constant.kind) return false;
		switch (immediate.kind) {
			case "undefined":
			case "null":
				return true;
			case "boolean":
			case "number":
				return immediate.value === (constant as { readonly value: unknown }).value;
			case "string":
				return immediate.index === (constant as { readonly index: number }).index;
		}
	}

	#sameEdge(left: CoreEdge | undefined, right: CoreEdge | undefined): boolean {
		return (
			left === right ||
			(left !== undefined &&
				right !== undefined &&
				left.block === right.block &&
				left.arguments.length === right.arguments.length &&
				left.arguments.every((value, index) => value === right.arguments[index]))
		);
	}

	#replaceInstructionWithValue(
		instruction: CoreInstructionId,
		result: CoreValueId,
		replacement: CoreValueId,
	): void {
		this.#wakeValueUsers(result);
		const editor = this.#edit();
		editor.replaceValueUses(result, replacement);
		if (this.#handlerUseCounts !== undefined && replacement !== result) {
			this.#handlerUseCounts[replacement] =
				(this.#handlerUseCounts[replacement] ?? 0) +
				(this.#handlerUseCounts[result] ?? 0);
			this.#handlerUseCounts[result] = 0;
		}
		editor.removeInstruction(instruction);
		this.#wakeValueDefinition(replacement);
	}

	#edit(): CoreEditor {
		this.#editor ??= CoreEditor.open(this.#program, this.#fn.id);
		return this.#editor;
	}

	#statistics(edits: number): CoreLocalOptimizerStatistics {
		return Object.freeze({
			instructionQueuePushes: this.#instructionQueue.pushes,
			instructionQueuePops: this.#instructionQueuePops,
			instructionQueueMaximumDepth: this.#instructionQueue.maximumDepth,
			blockQueuePushes: this.#blockQueue.pushes,
			blockQueuePops: this.#blockQueuePops,
			blockQueueMaximumDepth: this.#blockQueue.maximumDepth,
			rulesConsidered: this.#rulesConsidered,
			rulesApplied: this.#rulesApplied,
			edits,
			editSessions: this.#editor === undefined ? 0 : 1,
			workBudgetExhausted: this.#workBudgetExhausted,
			editBudgetExhausted: this.#editBudgetExhausted,
		});
	}
}
