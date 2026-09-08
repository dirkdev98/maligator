import { scanLiteralTemplateSegment } from "../shared/literal-template-data.ts";
import { staticNumberDescription } from "../shared/static-values.ts";
import type {
	StaticDescriptionId,
	StaticMember,
	StaticPropertyDescription,
	StaticPrototype,
} from "../shared/static-values.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type {
	CoreFunctionStore,
	CoreFunctionVersions,
	CoreProgram,
} from "./core-store.ts";

export type StaticAllocationIdentity =
	| {
			readonly kind: "fresh-per-evaluation";
			readonly function: CoreFunctionId;
			readonly value: CoreValueId;
	  }
	| { readonly kind: "realm-pool"; readonly slot: number };

export interface CoreStaticValue {
	readonly kind: "known";
	readonly description: StaticDescriptionId;
	readonly value: CoreValueId;
	readonly brand:
		| "undefined"
		| "null"
		| "boolean"
		| "number"
		| "string"
		| "bigint"
		| "symbol"
		| "function"
		| "array"
		| "object";
	readonly prototype: StaticPrototype;
	readonly identity?: StaticAllocationIdentity;
	readonly state:
		| "immutable-value"
		| "initial-allocation"
		| "joined-allocation"
		| "pooled-instance";
	readonly operands: ReadonlyArray<CoreValueId>;
	readonly environmentDependencies: ReadonlyArray<string>;
}

export type CoreStaticValueResult =
	| CoreStaticValue
	| {
			readonly kind: "unknown";
			readonly reason:
				| "unsupported-producer"
				| "conflicting-join"
				| "cycle-widening"
				| "work-limit";
	  };

export interface CoreStaticValueStatistics {
	queries: number;
	visits: number;
	cacheHits: number;
	cycleWidenings: number;
	budgetBailouts: number;
}

export class CoreStaticValueAnalysis {
	readonly #program: CoreProgram;
	readonly #fn: CoreFunctionStore;
	readonly #versions: CoreFunctionVersions;
	readonly #dataVersion: number;
	readonly #cfg: () => CoreControlFlow;
	readonly #limit: number;
	readonly #cache = new Map<CoreValueId, CoreStaticValueResult>();
	readonly #visiting = new Set<CoreValueId>();
	readonly statistics: CoreStaticValueStatistics = {
		queries: 0,
		visits: 0,
		cacheHits: 0,
		cycleWidenings: 0,
		budgetBailouts: 0,
	};

	constructor(
		program: CoreProgram,
		fn: CoreFunctionStore,
		cfg: () => CoreControlFlow,
		limit = 65536,
	) {
		this.#program = program;
		this.#fn = fn;
		this.#versions = fn.versions;
		this.#dataVersion = program.programVersion("data");
		this.#cfg = cfg;
		this.#limit = limit;
	}

	assertCurrent(): void {
		if (
			this.#program.function(this.#fn.id) !== this.#fn ||
			!coreFunctionVersionsAreCurrent(this.#fn, this.#versions) ||
			this.#program.programVersion("data") !== this.#dataVersion
		)
			throw new Error("Stale static-value facts");
	}

	query(value: CoreValueId): CoreStaticValueResult {
		this.assertCurrent();
		this.statistics.queries++;
		if (!this.#fn.isValueLive(value))
			throw new Error("Static-value query references a dead SSA value");
		const cached = this.#cache.get(value);
		if (cached !== undefined) {
			this.statistics.cacheHits++;
			return cached;
		}
		if (this.#visiting.has(value)) {
			this.statistics.cycleWidenings++;
			return { kind: "unknown", reason: "cycle-widening" };
		}
		if (this.statistics.visits >= this.#limit || this.#visiting.size >= 128) {
			this.statistics.budgetBailouts++;
			return { kind: "unknown", reason: "work-limit" };
		}
		this.statistics.visits++;
		this.#visiting.add(value);
		let result: CoreStaticValueResult;
		try {
			result = this.#describe(value);
		} finally {
			this.#visiting.delete(value);
		}
		this.#cache.set(value, result);
		return result;
	}

	verify(value: CoreStaticValue, consumer?: CoreInstructionId): void {
		this.assertCurrent();
		if (this.#cache.get(value.value) !== value)
			throw new Error("Static-value proof is not owned by this analysis");
		const summary = this.#program.staticDescriptions.summary(value.description);
		if (summary.identitySlots.length !== 0)
			throw new Error("Static recipe has unbound allocation identities");
		for (const index of summary.operandSlots)
			if (value.operands[index] === undefined)
				throw new Error("Static recipe has an unbound SSA operand");
		for (const operand of value.operands) {
			if (!this.#fn.isValueLive(operand))
				throw new Error("Static recipe hides a dead SSA operand");
			if (consumer === undefined) continue;
			const owner = this.#fn.kernel.valueDefinitionOwner(operand);
			const definition =
				this.#fn.kernel.valueDefinitionKind(operand) === 1
					? coreInstructionId(owner)
					: undefined;
			const block =
				definition === undefined
					? coreBlockId(owner)
					: this.#fn.instructionBlock(definition);
			const useBlock = this.#fn.instructionBlock(consumer);
			if (block !== useBlock) {
				if (!this.#cfg().dominates(block, useBlock))
					throw new Error("Static recipe operand does not dominate its consumer");
			} else if (definition !== undefined) {
				let found = false;
				for (const instruction of this.#fn.instructionIds(block)) {
					if (instruction === consumer) break;
					if (instruction === definition) {
						found = true;
						break;
					}
				}
				if (!found) throw new Error("Static recipe operand follows its consumer");
			}
		}
		if (
			(value.brand === "object" || value.brand === "array") &&
			value.state === "initial-allocation" &&
			(value.identity?.kind !== "fresh-per-evaluation" ||
				value.identity.function !== this.#fn.id ||
				!this.#fn.isValueLive(value.identity.value))
		)
			throw new Error("Static recipe lost its per-evaluation identity");
	}

	#describe(value: CoreValueId): CoreStaticValueResult {
		const fn = this.#fn;
		const program = this.#program;
		if (fn.kernel.valueDefinitionKind(value) === 0) {
			const block = coreBlockId(fn.kernel.valueDefinitionOwner(value));
			if (block === fn.entry) return { kind: "unknown", reason: "unsupported-producer" };
			const index = fn.kernel.valueDefinitionIndex(value);
			const incoming = this.#cfg().predecessors[block] ?? [];
			let joined: CoreStaticValue | undefined;
			for (const edge of incoming) {
				const input = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				if (input === undefined) return { kind: "unknown", reason: "conflicting-join" };
				const fact = this.query(input);
				if (fact.kind === "unknown") return fact;
				if (
					fact.operands.length !== 0 ||
					(joined !== undefined &&
						(joined.description !== fact.description || joined.brand !== fact.brand))
				)
					return { kind: "unknown", reason: "conflicting-join" };
				joined = fact;
			}
			if (joined === undefined) return { kind: "unknown", reason: "conflicting-join" };
			return {
				...joined,
				value,
				identity: undefined,
				state:
					joined.state === "immutable-value" ? "immutable-value" : "joined-allocation",
			};
		}
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionKind(instruction) !== "operation")
			return { kind: "unknown", reason: "unsupported-producer" };
		const opcode = fn.instructionOpcodeName(instruction);
		const attributes = fn.instructionAttributes(instruction);
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operands = Array.from(
			{ length: fn.kernel.instructionOperandCount(instruction) },
			(_, index) => fn.kernel.operandAt(operandStart + index),
		);
		const prototype: StaticPrototype = { kind: "unknown" };
		const primitive = (
			description: StaticDescriptionId,
			brand: CoreStaticValue["brand"],
		): CoreStaticValue => ({
			kind: "known",
			value,
			description,
			brand,
			prototype,
			state: "immutable-value",
			operands: [],
			environmentDependencies: [],
		});
		const intern = program.staticDescriptions;
		if (opcode === "move") {
			const input = this.query(operands[0]!);
			return input.kind === "known" ? { ...input, value } : input;
		}
		switch (opcode) {
			case "createUndefined":
				return primitive(intern.intern({ kind: "undefined" }), "undefined");
			case "createNull":
				return primitive(intern.intern({ kind: "null" }), "null");
			case "createBoolean":
				return primitive(
					intern.intern({ kind: "boolean", value: attributes.value === true }),
					"boolean",
				);
			case "createI32":
			case "createF64":
			case "createNumber":
				return primitive(
					intern.intern(staticNumberDescription(attributes.value as number)),
					"number",
				);
			case "createString":
				return primitive(
					intern.intern({
						kind: "string",
						codeUnits: program.stringConstants[attributes.stringIndex as number]!,
					}),
					"string",
				);
			case "createBigint":
				return primitive(
					intern.intern({
						kind: "bigint",
						decimal: String(program.bigintConstants[attributes.bigintIndex as number]!),
					}),
					"bigint",
				);
		}
		const bindings: Array<CoreValueId> = [];
		const member = (input: CoreValueId): StaticMember => {
			const fact = this.query(input);
			if (
				fact.kind === "known" &&
				fact.state === "immutable-value" &&
				fact.operands.length === 0
			)
				return { kind: "constant", description: fact.description };
			const index = bindings.length;
			bindings.push(input);
			return { kind: "operand", index };
		};
		let description: StaticDescriptionId;
		let brand: "array" | "object";
		if (opcode === "createObject" || opcode === "createObjectShaped") {
			brand = "object";
			const keys = (attributes.keyStringIndices ?? []) as ReadonlyArray<number>;
			if (keys.length !== operands.length)
				return { kind: "unknown", reason: "unsupported-producer" };
			const properties: Array<StaticPropertyDescription> = keys.map((key, index) => ({
				key: String.fromCharCode(...program.stringConstants[key]!),
				enumerable: true,
				configurable: true,
				descriptor: { kind: "data", writable: true, value: member(operands[index]!) },
			}));
			description = intern.intern({
				kind: "object",
				prototype: { kind: "intrinsic", id: "Object.prototype" },
				properties,
			});
		} else if (opcode === "createArray") {
			brand = "array";
			const length = attributes.length as number;
			if (!Number.isSafeInteger(length) || length < 0 || length > 4096)
				return { kind: "unknown", reason: "work-limit" };
			description = intern.intern({
				kind: "array",
				prototype: { kind: "intrinsic", id: "Array.prototype" },
				elements: Array.from({ length }, (): StaticMember => ({ kind: "hole" })),
			});
		} else if (opcode === "instantiateLiteralTemplate") {
			const offset = attributes.templateOffset as number;
			const segment = scanLiteralTemplateSegment(
				program.literalTemplateData,
				offset,
				"static description",
			);
			brand = program.literalTemplateData[offset] === 8 ? "array" : "object";
			description = intern.intern({
				kind: "engine-payload",
				format: "literal-template",
				targetContract: "program-data-tables",
				words: program.literalTemplateData.slice(offset, segment.endOffset),
			});
		} else return { kind: "unknown", reason: "unsupported-producer" };
		return {
			kind: "known",
			value,
			description,
			brand,
			prototype: {
				kind: "intrinsic",
				id: brand === "array" ? "Array.prototype" : "Object.prototype",
			},
			identity:
				opcode === "instantiateLiteralTemplate" &&
				typeof attributes.cacheSlot === "number"
					? { kind: "realm-pool", slot: attributes.cacheSlot }
					: { kind: "fresh-per-evaluation", function: fn.id, value },
			state:
				opcode === "instantiateLiteralTemplate" && attributes.cacheSlot !== undefined
					? "pooled-instance"
					: "initial-allocation",
			operands: bindings,
			environmentDependencies: ["current-realm"],
		};
	}
}

export const CORE_STATIC_VALUE_ANALYSIS: CoreAnalysisDefinition<CoreStaticValueAnalysis> =
	{
		key: "static-value-descriptions",
		scope: "function",
		functionDependencies: ["body", "cfg", "exceptionFlow", "memoryEffects", "facts"],
		programDependencies: ["data"],
		compute({ program, request, get }) {
			if (request.scope !== "function")
				throw new Error("Expected function static-value analysis");
			return new CoreStaticValueAnalysis(
				program,
				program.function(request.function),
				() => get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional(),
			);
		},
	};
