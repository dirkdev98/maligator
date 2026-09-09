import { builtinPrimitiveResult } from "../shared/builtin-semantics.ts";
import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import { evaluateConstantOperation } from "../shared/constant-evaluator.ts";
import type { ConstantValue } from "../shared/constant-evaluator.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import type { PrimordialKey } from "../shared/primordial-catalog.ts";
import {
	primordialNode,
	primordialNodeAvailable,
	provePrimordialAccess,
} from "../shared/primordial-catalog.ts";
import { staticNumberDescription } from "../shared/static-values.ts";
import type {
	StaticDescriptionId,
	StaticMember,
	StaticPropertyDescription,
	StaticPrototype,
} from "../shared/static-values.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import {
	CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS,
	analyzeCoreMemoryVersions,
} from "./core-ir-memory.ts";
import type { CoreMemoryVersions, CoreExactMemoryLocation } from "./core-ir-memory.ts";
import { coreBlockId, coreInstructionId } from "./core-ir.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { CORE_STATIC_CELL_INDEX } from "./core-static-value-cells.ts";
import { coreFunctionVersionsAreCurrent } from "./core-store.ts";
import type {
	CoreFunctionStore,
	CoreFunctionVersions,
	CoreProgram,
} from "./core-store.ts";

const STATIC_CONSTRUCTORS = new Set([
	"Array",
	"Object",
	"Boolean",
	"Number",
	"String",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"WeakRef",
	"FinalizationRegistry",
	"Promise",
	"DisposableStack",
	"AsyncDisposableStack",
	"Error",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
	"AggregateError",
	"SuppressedError",
	"Date",
	"RegExp",
	"ArrayBuffer",
	"SharedArrayBuffer",
	"DataView",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float16Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
	"Temporal.Instant",
	"Temporal.Duration",
	"Temporal.PlainDate",
	"Temporal.PlainTime",
	"Temporal.PlainDateTime",
	"Temporal.PlainYearMonth",
	"Temporal.PlainMonthDay",
	"Temporal.ZonedDateTime",
	"Intl.Collator",
	"Intl.DateTimeFormat",
	"Intl.NumberFormat",
	"Intl.PluralRules",
	"Intl.RelativeTimeFormat",
	"Intl.ListFormat",
	"Intl.DisplayNames",
	"Intl.Segmenter",
	"Intl.Locale",
	"Intl.DurationFormat",
]);

export type StaticAllocationIdentity =
	| {
			readonly kind: "fresh-per-evaluation";
			readonly function: CoreFunctionId;
			readonly value: CoreValueId;
	  }
	| {
			readonly kind: "template-child";
			readonly function: CoreFunctionId;
			readonly value: CoreValueId;
			readonly offset: number;
	  }
	| { readonly kind: "realm-pool"; readonly slot: number }
	| { readonly kind: "intrinsic" | "symbol-registry"; readonly key: string }
	| {
			readonly kind: "private-cell";
			readonly function: CoreFunctionId;
			readonly key: string;
	  };

function sameStaticIdentity(
	left: StaticAllocationIdentity | undefined,
	right: StaticAllocationIdentity | undefined,
): boolean {
	if (left === right) return true;
	if (left === undefined || right === undefined) return false;
	switch (left.kind) {
		case "fresh-per-evaluation":
			return (
				right.kind === left.kind &&
				left.function === right.function &&
				left.value === right.value
			);
		case "template-child":
			return (
				right.kind === left.kind &&
				left.function === right.function &&
				left.value === right.value &&
				left.offset === right.offset
			);
		case "realm-pool":
			return right.kind === left.kind && left.slot === right.slot;
		case "intrinsic":
		case "symbol-registry":
			return right.kind === left.kind && left.key === right.key;
		case "private-cell":
			return (
				right.kind === left.kind &&
				left.function === right.function &&
				left.key === right.key
			);
	}
}

function staticPropertyKey(key: StaticPropertyDescription["key"]): string {
	return typeof key === "string"
		? `string:${key}`
		: "symbolOperand" in key
			? `operand:${key.symbolOperand}`
			: `identity:${key.symbolIdentitySlot}`;
}

function sameStaticList<T>(
	left: ReadonlyArray<T> | undefined,
	right: ReadonlyArray<T> | undefined,
	equal: (a: T, b: T) => boolean,
): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			left.length === right.length &&
			left.every((value, index) => equal(value, right[index]!)))
	);
}

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
	readonly canonical?: string;
	readonly discriminator?: CoreValueId;
	readonly exactBrand?: string;
	readonly privateUntilObservation?: boolean;
	readonly construction?: {
		readonly kind: "call" | "construct";
		readonly callee: string;
		readonly instruction: CoreInstructionId;
		readonly arguments: ReadonlyArray<CoreValueId>;
	};
	readonly state:
		| "immutable-value"
		| "initial-allocation"
		| "joined-allocation"
		| "pooled-instance"
		| "stored-instance";
	readonly operands: ReadonlyArray<CoreValueId>;
	readonly allocationIdentities?: ReadonlyArray<StaticAllocationIdentity>;
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
	readonly #context: CoreCompilationContext | undefined;
	readonly #memory: () => CoreMemoryVersions;
	readonly #cells:
		| ((
				fn: CoreFunctionStore,
				load: CoreInstructionId,
				value: CoreValueId,
				consumer: CoreInstructionId,
		  ) => CoreStaticValue | undefined)
		| undefined;
	#cellRevision: number | undefined;
	readonly #cache = new Map<CoreValueId, CoreStaticValueResult>();
	readonly #visiting = new Set<CoreValueId>();
	readonly #observations = new Map<string, CoreStaticValueResult>();
	readonly #proofs = new WeakSet<CoreStaticValue>();
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
		context?: CoreCompilationContext,
		memory?: () => CoreMemoryVersions,
		cells?: (
			fn: CoreFunctionStore,
			load: CoreInstructionId,
			value: CoreValueId,
			consumer: CoreInstructionId,
		) => CoreStaticValue | undefined,
	) {
		this.#program = program;
		this.#fn = fn;
		this.#versions = fn.versions;
		this.#dataVersion = program.programVersion("data");
		this.#cfg = cfg;
		this.#limit = limit;
		this.#context = context;
		this.#cells = cells;
		let cachedMemory: CoreMemoryVersions | undefined;
		this.#memory =
			memory ?? (() => (cachedMemory ??= analyzeCoreMemoryVersions(program, fn.id)));
	}

	assertCurrent(): void {
		if (
			this.#program.function(this.#fn.id) !== this.#fn ||
			!coreFunctionVersionsAreCurrent(this.#fn, this.#versions) ||
			this.#program.programVersion("data") !== this.#dataVersion
		)
			throw new Error("Stale static-value facts");
	}

	#refreshCells(): void {
		if (
			this.#cellRevision !== undefined &&
			this.#cellRevision !== this.#program.programFlowRevision
		) {
			this.#observations.clear();
			this.#cache.clear();
			this.#cellRevision = this.#program.programFlowRevision;
		}
	}

	query(value: CoreValueId): CoreStaticValueResult {
		this.assertCurrent();
		this.#refreshCells();
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
		if (result.kind === "known") this.#proofs.add(result);
		return result;
	}

	queryAt(value: CoreValueId, consumer: CoreInstructionId): CoreStaticValueResult {
		this.assertCurrent();
		this.#refreshCells();
		const key = `${value}:${consumer}`;
		const cached = this.#observations.get(key);
		if (cached !== undefined) return cached;
		// Recursive control flow widens before following backedges.
		this.#observations.set(key, { kind: "unknown", reason: "cycle-widening" });
		const result = this.#observe(value, consumer);
		this.#observations.set(key, result);
		if (result.kind === "known") this.#proofs.add(result);
		return result;
	}

	#arguments(instruction: CoreInstructionId): Array<CoreValueId> {
		const kernel = this.#fn.kernel,
			start = kernel.instructionOperandStart(instruction);
		return Array.from(
			{ length: kernel.instructionOperandCount(instruction) },
			(_, index) => kernel.operandAt(start + index),
		);
	}

	#observe(value: CoreValueId, consumer: CoreInstructionId): CoreStaticValueResult {
		const initial = this.query(value);
		if (
			initial.kind === "unknown" &&
			this.#cells !== undefined &&
			this.#fn.kernel.valueDefinitionKind(value) === 1
		) {
			const definition = coreInstructionId(this.#fn.kernel.valueDefinitionOwner(value));
			if (
				["loadGlobal", "loadCaptured"].includes(
					this.#fn.instructionOpcodeName(definition),
				)
			) {
				this.#cellRevision = this.#program.programFlowRevision;
				return this.#cells(this.#fn, definition, value, consumer) ?? initial;
			}
		}
		// A pooled template is admitted only when every use preserves private immutable contents.
		if (
			initial.kind === "unknown" ||
			initial.state === "immutable-value" ||
			initial.state === "pooled-instance"
		)
			return initial;
		const intern = this.#program.staticDescriptions;
		const description = intern.description(initial.description);
		if (description.kind !== "array" && description.kind !== "object") return initial;
		const unknownContents = (): CoreStaticValue => ({
			...initial,
			description: intern.intern({
				...description,
				properties: [],
				ownKeysComplete: false,
				unknownOwnKeys: undefined,
				prototype: { kind: "unknown" },
				...(description.kind === "array" ? { length: null } : {}),
			}),
			prototype: { kind: "unknown" },
			operands: [],
			privateUntilObservation: false,
		});
		const discriminator = initial.discriminator ?? value;
		const isJoined = this.#fn.kernel.valueDefinitionKind(discriminator) === 0;
		if (initial.identity?.kind !== "fresh-per-evaluation" && !isJoined)
			return unknownContents();
		const root = isJoined
			? discriminator
			: initial.identity!.kind === "fresh-per-evaluation"
				? initial.identity!.value
				: value;
		const definition = coreInstructionId(this.#fn.kernel.valueDefinitionOwner(root));
		const startBlock = isJoined
			? coreBlockId(this.#fn.kernel.valueDefinitionOwner(root))
			: this.#fn.instructionBlock(definition);
		const endBlock = this.#fn.instructionBlock(consumer);
		const path: Array<CoreBlockId> = [endBlock];
		while (path[path.length - 1] !== startBlock) {
			if (++this.statistics.visits > this.#limit)
				return { kind: "unknown", reason: "work-limit" };
			const predecessors = this.#cfg().predecessors[path[path.length - 1]!] ?? [];
			const edge = predecessors[0];
			if (
				predecessors.length !== 1 ||
				edge?.kind !== "ordinary" ||
				path.includes(edge.from)
			)
				return unknownContents();
			path.push(edge.from);
		}
		path.reverse();
		this.statistics.visits += description.properties.length;
		if (this.statistics.visits > this.#limit)
			return { kind: "unknown", reason: "work-limit" };
		const propertyMap = new Map(
			description.properties.map((property) => [
				staticPropertyKey(property.key),
				property,
			]),
		);
		let prototype = description.prototype;
		let length = description.kind === "array" ? description.length : null;
		let complete = description.ownKeysComplete !== false;
		let unknownOwnKeys = description.unknownOwnKeys;
		let escaped = isJoined,
			started = isJoined;
		const bindings = [...initial.operands];
		const aliases = new Set<CoreValueId>([root]);
		const bindingIndices = new Map(bindings.map((input, index) => [input, index]));
		const symbolKeys: Array<{ identity: StaticAllocationIdentity; index: number }> = [];
		const bind = (input: CoreValueId): StaticMember => {
			const fact = this.query(input);
			if (
				fact.kind === "known" &&
				fact.state === "immutable-value" &&
				["undefined", "null", "boolean", "number", "string", "bigint"].includes(
					intern.description(fact.description).kind,
				)
			)
				return { kind: "constant", description: fact.description };
			let index = bindingIndices.get(input);
			if (index === undefined) {
				index = bindings.length;
				bindings.push(input);
				bindingIndices.set(input, index);
			}
			return { kind: "operand", index };
		};
		const propertyKey = (
			input: CoreValueId,
		): StaticPropertyDescription["key"] | undefined => {
			const constant = this.constant(input);
			if (constant !== undefined)
				return constant.kind === "undefined" ? "undefined" : String(constant.value);
			const fact = this.query(input);
			if (fact.kind === "known" && fact.brand === "null") return "null";
			if (fact.kind !== "known" || fact.brand !== "symbol") return undefined;
			const identity = fact.identity;
			this.statistics.visits += symbolKeys.length;
			if (this.statistics.visits > this.#limit) return undefined;
			const prior =
				identity === undefined
					? undefined
					: symbolKeys.find((entry) => sameStaticIdentity(entry.identity, identity));
			if (prior !== undefined) return { symbolOperand: prior.index };
			const member = bind(input);
			if (member.kind !== "operand") return undefined;
			if (identity !== undefined) symbolKeys.push({ identity, index: member.index });
			return { symbolOperand: member.index };
		};
		const invalidate = () => {
			propertyMap.clear();
			complete = false;
			unknownOwnKeys = undefined;
			length = null;
			prototype = { kind: "unknown" };
		};
		for (const block of path)
			for (const instruction of this.#fn.instructionIds(block)) {
				if (!isJoined && instruction === definition) {
					started = true;
					continue;
				}
				if (!started) continue;
				if (instruction === consumer) {
					// Integer indices precede strings; stable sorting retains insertion order for strings
					// and symbols.
					const index = (key: StaticPropertyDescription["key"]) =>
						typeof key === "string" &&
						String(Number(key)) === key &&
						Number.isInteger(Number(key)) &&
						Number(key) >= 0 &&
						Number(key) < 4294967295
							? Number(key)
							: Infinity;
					this.statistics.visits += propertyMap.size;
					if (this.statistics.visits > this.#limit)
						return { kind: "unknown", reason: "work-limit" };
					const properties = [...propertyMap.values()];
					properties.sort(
						(a, b) =>
							index(a.key) - index(b.key) ||
							(typeof a.key === "string" ? 0 : 1) - (typeof b.key === "string" ? 0 : 1),
					);
					return {
						...initial,
						prototype,
						operands: bindings,
						privateUntilObservation: !escaped,
						description: intern.intern({
							...description,
							prototype,
							properties,
							ownKeysComplete: complete,
							unknownOwnKeys,
							...(description.kind === "array" ? { length } : {}),
						}),
					};
				}
				if (++this.statistics.visits > this.#limit)
					return { kind: "unknown", reason: "work-limit" };
				if (this.#fn.instructionKind(instruction) !== "operation") continue;
				const opcode = this.#fn.instructionOpcodeName(instruction),
					args = this.#arguments(instruction);
				const attributes = this.#fn.instructionAttributes(instruction);
				const touches = args.some((input) => aliases.has(input));
				if (opcode === "move" && aliases.has(args[0]!)) {
					const result = this.#fn.kernel.instructionResultStart(instruction);
					aliases.add(this.#fn.kernel.resultAt(result));
					continue;
				}
				if (["loadLocal", "loadGlobal", "loadCaptured"].includes(opcode)) {
					const output = this.#fn.kernel.resultAt(
						this.#fn.kernel.instructionResultStart(instruction),
					);
					const fact = this.query(output);
					if (
						fact.kind === "known" &&
						fact.identity !== undefined &&
						sameStaticIdentity(fact.identity, initial.identity)
					)
						aliases.add(output);
				}
				if (opcode === "storeLocal" && touches) continue;
				const receiver = aliases.has(args[0]!);
				if (receiver && opcode === "setPrototype") {
					const fact = this.query(args[1]!);
					if (fact.kind === "known" && fact.brand === "null")
						prototype = { kind: "null" };
					else if (fact.kind === "known" && fact.canonical !== undefined)
						prototype = { kind: "intrinsic", id: fact.canonical };
					else {
						const member = bind(args[1]!);
						prototype =
							member.kind === "operand"
								? { kind: "operand", index: member.index }
								: { kind: "unknown" };
					}
					continue;
				}
				if (
					receiver &&
					[
						"defineProperty",
						"defineAccessor",
						"storeProperty",
						"storePropertyStatic",
						"deleteProperty",
						"loadProperty",
						"loadPropertyStatic",
					].includes(opcode)
				) {
					const key = opcode.endsWith("Static")
						? this.string(attributes.stringIndex as number)
						: propertyKey(args[1]!);
					if (key === undefined) {
						invalidate();
						continue;
					}
					const keyId = staticPropertyKey(key);
					const previous = propertyMap.get(keyId);
					if (opcode.startsWith("load")) {
						if (
							previous?.descriptor.kind !== "data" &&
							!(key === "length" && description.kind === "array")
						)
							invalidate();
						continue;
					}
					if (opcode === "deleteProperty") {
						if (previous?.configurable !== false) propertyMap.delete(keyId);
						continue;
					}
					const input = args[opcode === "storePropertyStatic" ? 1 : 2]!;
					if (key === "length" && description.kind === "array") {
						if (
							length === null ||
							attributes.writable === false ||
							opcode === "defineAccessor"
						) {
							invalidate();
							continue;
						}
						const constant = this.constant(input);
						if (
							constant?.kind !== "number" ||
							!Number.isInteger(constant.value) ||
							constant.value < 0 ||
							constant.value > 4294967295
						) {
							invalidate();
							continue;
						}
						length = constant.value;
						this.statistics.visits += propertyMap.size;
						if (this.statistics.visits > this.#limit)
							return { kind: "unknown", reason: "work-limit" };
						for (const [id, property] of propertyMap) {
							if (
								typeof property.key === "string" &&
								/^(0|[1-9][0-9]*)$/.test(property.key) &&
								Number(property.key) < 4294967295 &&
								Number(property.key) >= length
							) {
								if (!property.configurable) {
									invalidate();
									break;
								}
								propertyMap.delete(id);
							}
						}
						continue;
					}
					if (opcode.startsWith("store") && previous?.descriptor.kind !== "data") {
						invalidate();
						continue;
					}
					if (
						opcode.startsWith("store") &&
						previous?.descriptor.kind === "data" &&
						!previous.descriptor.writable
					)
						continue;
					const property: StaticPropertyDescription =
						opcode === "defineAccessor"
							? {
									key,
									enumerable: attributes.enumerable === true,
									configurable: true,
									descriptor: {
										kind: "accessor",
										get:
											attributes.kind === "get"
												? bind(input)
												: previous?.descriptor.kind === "accessor"
													? previous.descriptor.get
													: {
															kind: "constant",
															description: intern.intern({ kind: "undefined" }),
														},
										set:
											attributes.kind === "set"
												? bind(input)
												: previous?.descriptor.kind === "accessor"
													? previous.descriptor.set
													: {
															kind: "constant",
															description: intern.intern({ kind: "undefined" }),
														},
									},
								}
							: {
									key,
									enumerable: opcode.startsWith("store")
										? previous!.enumerable
										: attributes.enumerable === true,
									configurable: opcode.startsWith("store")
										? previous!.configurable
										: attributes.configurable !== false,
									descriptor: {
										kind: "data",
										writable:
											opcode.startsWith("store") && previous?.descriptor.kind === "data"
												? previous.descriptor.writable
												: attributes.writable !== false,
										value: bind(input),
									},
								};
					propertyMap.set(keyId, property);
					if (
						description.kind === "array" &&
						length !== null &&
						typeof key === "string" &&
						/^(0|[1-9][0-9]*)$/.test(key) &&
						Number(key) < 4294967295
					)
						length = Math.max(length, Number(key) + 1);
					continue;
				}
				if (
					receiver &&
					opcode === "callKnown" &&
					!attributes.construct &&
					attributes.argumentMode === undefined &&
					description.kind === "array" &&
					length !== null &&
					length <= 4096 &&
					!escaped &&
					complete &&
					this.#context?.facts.world.primordialPolicy === "locked" &&
					!this.#context.facts.world.realms
				) {
					const operation = attributes.operation;
					const inheritedAbsent = (key: string) =>
						this.inherited({ ...initial, prototype }, key)?.kind === "absent";
					if (
						operation === "Array.prototype.push" &&
						length + args.length - 1 <= 4096 &&
						args.slice(1).every((_, index) => {
							const key = String(length! + index);
							return !propertyMap.has(staticPropertyKey(key)) && inheritedAbsent(key);
						})
					) {
						for (const input of args.slice(1)) {
							const key = String(length++);
							propertyMap.set(staticPropertyKey(key), {
								key,
								enumerable: true,
								configurable: true,
								descriptor: { kind: "data", writable: true, value: bind(input) },
							});
						}
						continue;
					}
					if (operation === "Array.prototype.pop") {
						const key = String(length - 1),
							property = propertyMap.get(staticPropertyKey(key));
						if (
							length === 0 ||
							(property?.descriptor.kind === "data" && property.configurable) ||
							(property === undefined && inheritedAbsent(key))
						) {
							propertyMap.delete(staticPropertyKey(key));
							length = Math.max(length - 1, 0);
							continue;
						}
					}
				}
				const descriptor = this.#fn.registry.byId(
					this.#fn.instructionOpcode(instruction),
				);
				const effects =
					this.#fn.instructionEffectRefinement(instruction)?.effects ??
					descriptor.effects;
				if (touches && !descriptor.observesOperands) escaped = true;
				if (
					(escaped || touches) &&
					(effects.callsUserCode ||
						effects.maySuspend ||
						effects.writes.includes("object-property") ||
						effects.writes.includes("array-element"))
				)
					invalidate();
			}
		return unknownContents();
	}

	verify(value: CoreStaticValue, consumer?: CoreInstructionId): void {
		this.assertCurrent();
		if (!this.#proofs.has(value))
			throw new Error("Static-value proof is not owned by this analysis");
		const summary = this.#program.staticDescriptions.summary(value.description);
		for (const index of summary.identitySlots)
			if (value.allocationIdentities?.[index] === undefined)
				throw new Error("Static recipe has unbound allocation identities");
		for (const index of summary.operandSlots)
			if (value.operands[index] === undefined)
				throw new Error("Static recipe has an unbound SSA operand");
		for (const operand of [...value.operands, ...(value.construction?.arguments ?? [])]) {
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

	#join(value: CoreValueId, facts: Array<CoreStaticValue>): CoreStaticValueResult {
		const first = facts[0];
		if (first === undefined || facts.some((fact) => fact.brand !== first.brand))
			return { kind: "unknown", reason: "conflicting-join" };
		const exactBrand = facts.every((fact) => fact.exactBrand === first.exactBrand)
			? first.exactBrand
			: undefined;
		const construction = facts.every(
			({ construction: other }) =>
				other === first.construction ||
				(other !== undefined &&
					first.construction !== undefined &&
					other.kind === first.construction.kind &&
					other.callee === first.construction.callee &&
					other.instruction === first.construction.instruction &&
					sameStaticList(
						other.arguments,
						first.construction.arguments,
						(a, b) => a === b,
					)),
		)
			? first.construction
			: undefined;
		const identity = facts.every((fact) =>
			sameStaticIdentity(fact.identity, first.identity),
		)
			? first.identity
			: undefined;
		if (
			facts.every(
				(fact) =>
					fact.description === first.description &&
					sameStaticList(fact.operands, first.operands, (a, b) => a === b) &&
					sameStaticList(
						fact.allocationIdentities,
						first.allocationIdentities,
						sameStaticIdentity,
					),
			)
		)
			return {
				...first,
				value,
				discriminator: value,
				identity,
				construction,
				exactBrand,
				state: first.state === "immutable-value" ? first.state : "joined-allocation",
			};
		if (
			["undefined", "null", "boolean", "number", "string", "bigint", "symbol"].includes(
				first.brand,
			)
		)
			return {
				kind: "known",
				value,
				discriminator: value,
				brand: first.brand,
				identity,
				prototype: { kind: "unknown" },
				state: "immutable-value",
				operands: [],
				environmentDependencies: [
					...new Set(facts.flatMap((fact) => fact.environmentDependencies)),
				],
				description: this.#program.staticDescriptions.intern({
					kind: "engine-payload",
					format: "dynamic-result",
					targetContract: `primitive-join:${first.brand}`,
					contentsComplete: false,
					words: [],
				}),
			};
		const descriptions = facts.map((fact) =>
			this.#program.staticDescriptions.description(fact.description),
		);
		this.statistics.visits += descriptions.reduce(
			(sum, description) =>
				sum +
				(description.kind === "array" || description.kind === "object"
					? description.properties.length
					: 1),
			0,
		);
		if (this.statistics.visits > this.#limit)
			return { kind: "unknown", reason: "work-limit" };
		const propertyMaps = descriptions.map(
			(description) =>
				new Map(
					description.kind === "array" || description.kind === "object"
						? description.properties.map((property) => [property.key, property])
						: [],
				),
		);
		const description = descriptions[0]!;
		if (description.kind !== "array" && description.kind !== "object")
			return { kind: "unknown", reason: "conflicting-join" };
		if (descriptions.some((other) => other.kind !== description.kind))
			return { kind: "unknown", reason: "conflicting-join" };
		const bindings: Array<CoreValueId> = [];
		const member = (values: Array<StaticMember>): StaticMember => {
			const initial = values[0]!;
			if (
				initial.kind === "constant" &&
				values.every(
					(other) =>
						other.kind === "constant" && other.description === initial.description,
				)
			)
				return initial;
			if (initial.kind === "operand") {
				const input = first.operands[initial.index]!;
				if (
					values.every(
						(other, index) =>
							other.kind === "operand" && facts[index]!.operands[other.index] === input,
					)
				) {
					let index = bindings.indexOf(input);
					if (index < 0) {
						index = bindings.length;
						bindings.push(input);
					}
					return { kind: "operand", index };
				}
			}
			return { kind: "unknown" };
		};
		const properties: Array<StaticPropertyDescription> = [];
		for (const property of description.properties) {
			if (typeof property.key !== "string") continue;
			const others = propertyMaps.map((properties) => properties.get(property.key));
			if (
				!others.every(
					(other): other is StaticPropertyDescription =>
						other !== undefined &&
						other.enumerable === property.enumerable &&
						other.configurable === property.configurable &&
						other.descriptor.kind === property.descriptor.kind,
				)
			)
				continue;
			const descriptor = property.descriptor;
			if (
				descriptor.kind === "data" &&
				others.every(
					(other) =>
						other.descriptor.kind === "data" &&
						other.descriptor.writable === descriptor.writable,
				)
			)
				properties.push({
					...property,
					descriptor: {
						...descriptor,
						value: member(
							others.map((other) =>
								other.descriptor.kind === "data"
									? other.descriptor.value
									: { kind: "unknown" },
							),
						),
					},
				});
		}
		const prototype =
			facts.every(
				({ prototype }) =>
					prototype.kind === first.prototype.kind &&
					(prototype.kind !== "intrinsic" ||
						(first.prototype.kind === "intrinsic" &&
							prototype.id === first.prototype.id)),
			) && first.prototype.kind !== "operand"
				? first.prototype
				: ({ kind: "unknown" } as const);
		return {
			...first,
			value,
			discriminator: value,
			identity,
			construction,
			exactBrand,
			prototype,
			state: "joined-allocation",
			operands: bindings,
			description: this.#program.staticDescriptions.intern({
				...description,
				prototype,
				properties,
				unknownOwnKeys: undefined,
				ownKeysComplete: descriptions.every(
					(other) =>
						(other.kind === "array" || other.kind === "object") &&
						other.ownKeysComplete !== false &&
						other.properties.length === properties.length,
				),
				...(description.kind === "array"
					? {
							length: descriptions.every(
								(other) => other.kind === "array" && other.length === description.length,
							)
								? description.length
								: null,
						}
					: {}),
			}),
		};
	}

	#describe(value: CoreValueId): CoreStaticValueResult {
		const fn = this.#fn;
		const program = this.#program;
		if (fn.kernel.valueDefinitionKind(value) === 0) {
			const block = coreBlockId(fn.kernel.valueDefinitionOwner(value));
			if (block === fn.entry) return { kind: "unknown", reason: "unsupported-producer" };
			const index = fn.kernel.valueDefinitionIndex(value);
			const incoming = this.#cfg().predecessors[block] ?? [];
			const facts: Array<CoreStaticValue> = [];
			for (const edge of incoming) {
				const input = edge.arguments[edge.kind === "exceptional" ? index - 1 : index];
				if (input === undefined || edge.kind === "exceptional")
					return { kind: "unknown", reason: "conflicting-join" };
				const fact = this.queryAt(input, fn.blockTerminator(edge.from));
				if (fact.kind === "unknown") return fact;
				facts.push(fact);
			}
			return this.#join(value, facts);
		}
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		if (fn.instructionKind(instruction) !== "operation")
			return { kind: "unknown", reason: "unsupported-producer" };
		const originalOpcode = fn.instructionOpcodeName(instruction);
		const attributes = fn.instructionAttributes(instruction);
		if (originalOpcode === "callKnown" && attributes.argumentMode !== undefined)
			return { kind: "unknown", reason: "unsupported-producer" };
		const knownOperation =
			originalOpcode === "callKnown" ? (attributes.operation as string) : undefined;
		const opcode =
			originalOpcode === "callKnown"
				? attributes.construct
					? "construct"
					: "call"
				: originalOpcode;
		const operandStart = fn.kernel.instructionOperandStart(instruction);
		const operands = Array.from(
			{ length: fn.kernel.instructionOperandCount(instruction) },
			(_, index) => fn.kernel.operandAt(operandStart + index),
		);
		if (knownOperation !== undefined && opcode === "call") operands.unshift(operands[0]!);
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
		if (opcode === "preparedStringCompare" || opcode === "preciseNumberSum")
			return primitive(
				intern.intern({
					kind: "engine-payload",
					format: "dynamic-result",
					targetContract:
						opcode === "preciseNumberSum"
							? "Math.sumPrecise"
							: "String.prototype.localeCompare",
					contentsComplete: false,
					words: [],
				}),
				"number",
			);
		if (
			opcode === "loadIntrinsic" &&
			(attributes.intrinsic === "NaN" || attributes.intrinsic === "Infinity")
		)
			return primitive(
				intern.intern(
					staticNumberDescription(attributes.intrinsic === "NaN" ? NaN : Infinity),
				),
				"number",
			);
		if (opcode === "move") {
			const input = this.query(operands[0]!);
			return input.kind === "known" ? { ...input, value } : input;
		}
		if (["loadLocal", "loadGlobal", "loadCaptured"].includes(opcode)) {
			const location: CoreExactMemoryLocation =
				opcode === "loadLocal"
					? { kind: "local-slot", slot: attributes.index as number }
					: opcode === "loadGlobal"
						? { kind: "global-slot", slot: attributes.index as number }
						: {
								kind: "captured-slot",
								owner: attributes.functionIndex as number,
								index: attributes.index as number,
							};
			const input = this.#memory().valueForRead(instruction, location);
			if (input !== undefined && input !== value) {
				const fact = this.query(input);
				if (fact.kind === "known") return { ...fact, value };
			}
			if (this.#cells !== undefined && opcode !== "loadLocal") {
				this.#cellRevision = this.#program.programFlowRevision;
				const fact = this.#cells(this.#fn, instruction, value, instruction);
				if (fact !== undefined) return fact;
			}
		}

		if (opcode === "binary" || opcode === "unary") {
			const inputs = operands.map((input) => this.constant(input));
			if (inputs.every((input): input is ConstantValue => input !== undefined)) {
				const kind = inputs[0]?.kind;
				if (kind === "number" || kind === "bigint") {
					const evaluated = evaluateConstantOperation(
						`${kind}.${opcode}:${attributes.operator as string}`,
						inputs,
					);
					if (evaluated.kind === "value") {
						const constant = evaluated.value;
						if (constant.kind === "number")
							return primitive(
								intern.intern(staticNumberDescription(constant.value)),
								"number",
							);
						if (constant.kind === "bigint")
							return primitive(
								intern.intern({ kind: "bigint", decimal: String(constant.value) }),
								"bigint",
							);
						if (constant.kind === "boolean")
							return primitive(intern.intern(constant), "boolean");
					}
				}
			}
		}
		let operatorBrand: "number" | "boolean" | "string" | "bigint" | undefined;
		if (
			opcode === "binary" &&
			["+", "-", "*", "/", "%", "**", "&", "|", "^", "<<", ">>", ">>>"].includes(
				attributes.operator as string,
			)
		) {
			const inputs = operands.map((operand) => this.query(operand));
			if (
				attributes.operator === "+" &&
				inputs.some((input) => input.kind === "known" && input.brand === "string")
			)
				operatorBrand = "string";
			else if (
				attributes.operator !== ">>>" &&
				inputs.every((input) => input.kind === "known" && input.brand === "bigint")
			)
				operatorBrand = "bigint";
			else if (
				inputs.every(
					(input) =>
						input.kind === "known" &&
						["undefined", "null", "boolean", "number", "string"].includes(input.brand),
				)
			)
				operatorBrand = "number";
		}
		if (opcode === "unary") {
			operatorBrand =
				attributes.operator === "+"
					? "number"
					: attributes.operator === "!"
						? "boolean"
						: attributes.operator === "tostring" || attributes.operator === "typeof"
							? "string"
							: undefined;
			if (
				["tonumeric", "increment", "decrement", "-", "~"].includes(
					attributes.operator as string,
				)
			) {
				const input = this.query(operands[0]!);
				if (input.kind === "known") {
					if (input.brand === "bigint") operatorBrand = "bigint";
					else if (
						["undefined", "null", "boolean", "number", "string"].includes(input.brand)
					)
						operatorBrand = "number";
				}
			}
		}
		if (operatorBrand !== undefined)
			return primitive(
				intern.intern({
					kind: "engine-payload",
					format: "dynamic-result",
					targetContract: operatorBrand,
					words: [],
					contentsComplete: false,
				}),
				operatorBrand,
			);

		if (this.#context?.facts.world.primordialPolicy === "locked") {
			let canonical: string | undefined;
			if (opcode === "loadIntrinsic") canonical = attributes.intrinsic as string;
			if (opcode === "loadGlobalProperty") {
				const name = this.string(attributes.nameStringIndex as number);
				if (this.#context.facts.immutableGlobalBindings.get(name)?.kind === "known")
					canonical = provePrimordialAccess(
						this.#context.facts.world,
						{ kind: "intrinsic", id: "globalThis", realm: "current" },
						name,
					)?.resolution?.value?.[0];
			}
			if (opcode === "loadPrimordial")
				canonical = getPrimordialCatalog().nodes[attributes.nodeIndex as number]?.[0];
			if (opcode === "loadPropertyStatic" || opcode === "loadProperty") {
				let key: PrimordialKey | undefined;
				if (opcode === "loadPropertyStatic")
					key = this.string(attributes.stringIndex as number);
				else {
					const constant = this.constant(operands[1]!);
					if (constant !== undefined)
						key = constant.kind === "undefined" ? "undefined" : String(constant.value);
					else {
						const symbol = this.query(operands[1]!);
						if (
							symbol.kind === "known" &&
							symbol.brand === "symbol" &&
							symbol.canonical !== undefined
						)
							key = { symbol: symbol.canonical };
					}
				}
				if (key !== undefined) {
					const base = this.queryAt(operands[0]!, instruction);
					if (base.kind === "known")
						canonical = (
							base.canonical !== undefined && base.brand !== "symbol"
								? provePrimordialAccess(
										this.#context.facts.world,
										{ kind: "intrinsic", id: base.canonical, realm: "current" },
										key,
									)
								: this.inherited(base, key)
						)?.resolution?.value?.[0];
				}
			}
			const node = canonical === undefined ? undefined : primordialNode(canonical);
			if (
				node !== undefined &&
				primordialNodeAvailable(this.#context.facts.world, node[0])
			) {
				const symbol = (node[2] & 8) !== 0;
				const symbolDescription = symbol
					? node[5].find((alias) => /^Symbol\.[A-Za-z]+$/.test(alias))
					: undefined;
				return {
					...primitive(
						intern.intern(
							symbol
								? {
										kind: "symbol",
										description: symbolDescription,
										reference: { kind: "well-known", key: node[0] },
									}
								: {
										kind: "engine-payload",
										format: "primordial-reference",
										targetContract: node[0],
										words: [],
									},
						),
						symbol
							? "symbol"
							: node[0] === "Array.prototype"
								? "array"
								: (node[2] & 2) !== 0
									? "function"
									: "object",
					),
					canonical: node[0],
					identity: { kind: "intrinsic", key: node[0] },
					environmentDependencies: ["primordials.locked", "realm.current"],
				};
			}
			if (opcode === "call" && operands.length >= 2) {
				const callee =
					knownOperation === undefined
						? this.query(operands[0]!)
						: { kind: "known" as const, canonical: knownOperation };
				if (callee.kind === "known" && callee.canonical === "Function.prototype.bind") {
					const target = this.queryAt(operands[1]!, instruction);
					if (target.kind === "known" && target.brand === "function") {
						const node =
							target.canonical === undefined
								? undefined
								: primordialNode(target.canonical);
						const prototype: StaticPrototype =
							node !== undefined && node[1] >= 0
								? { kind: "intrinsic", id: getPrimordialCatalog().nodes[node[1]]![0] }
								: target.prototype;
						if (prototype.kind === "intrinsic")
							return {
								kind: "known",
								value,
								brand: "function",
								exactBrand: "BoundFunction",
								prototype,
								description: intern.intern({
									kind: "object",
									prototype,
									properties: [],
									ownKeysComplete: false,
									unknownOwnKeys: { numeric: false, named: ["length", "name"] },
								}),
								identity: { kind: "fresh-per-evaluation", function: fn.id, value },
								state: "initial-allocation",
								operands: [],
								environmentDependencies: ["primordials.locked", "realm.current"],
							};
					}
				}
				if (
					callee.kind === "known" &&
					(callee.canonical === "Symbol" || callee.canonical === "Symbol.for")
				) {
					const input =
						operands[2] === undefined
							? { kind: "undefined" as const }
							: this.constant(operands[2]);
					const registered = callee.canonical === "Symbol.for";
					const converted = evaluateConstantBuiltin("String", undefined, [input]);
					const key =
						converted.kind === "value" && converted.value.kind === "string"
							? converted.value.value
							: undefined;
					const description = !registered && input?.kind === "undefined" ? null : key;
					return {
						...primitive(
							intern.intern({
								kind: "symbol",
								registered,
								...(description === undefined ? {} : { description }),
								...(registered && key !== undefined
									? { reference: { kind: "registry", key } as const }
									: {}),
							}),
							"symbol",
						),
						identity: registered
							? key === undefined
								? undefined
								: { kind: "symbol-registry", key }
							: { kind: "fresh-per-evaluation", function: fn.id, value },
						environmentDependencies: registered ? ["symbol-registry"] : [],
					};
				}
			}
		}
		if (
			this.#context?.facts.world.primordialPolicy === "locked" &&
			(opcode === "construct" || opcode === "call")
		) {
			const callee =
				knownOperation === undefined
					? this.query(operands[0]!)
					: { kind: "known" as const, canonical: knownOperation };
			const canonical = callee.kind === "known" ? callee.canonical : undefined;

			if (opcode === "call" && canonical !== undefined) {
				const primitiveBrand = builtinPrimitiveResult(canonical);
				if (
					primitiveBrand !== undefined &&
					primitiveBrand !== "number-or-undefined" &&
					primitiveBrand !== "string-or-undefined"
				)
					return primitive(
						intern.intern({
							kind: "engine-payload",
							format: "dynamic-result",
							targetContract: canonical,
							contentsComplete: false,
							words: [],
						}),
						primitiveBrand,
					);
				const factory = canonical.match(
					/^(Temporal\.(?:Instant|Duration|PlainDate|PlainTime|PlainDateTime|PlainYearMonth|PlainMonthDay|ZonedDateTime))\.(?:from|fromEpochMilliseconds|fromEpochNanoseconds)$/,
				)?.[1];
				const receiver = operands[1] === undefined ? undefined : this.query(operands[1]);
				const arrayFactory =
					(canonical === "Array.from" || canonical === "Array.of") &&
					receiver?.kind === "known" &&
					receiver.canonical === "Array";
				if (
					factory !== undefined ||
					arrayFactory ||
					canonical === "Intl.getCanonicalLocales" ||
					canonical === "Object.create"
				) {
					let prototype: StaticPrototype = {
						kind: "intrinsic",
						id: `${factory ?? (arrayFactory || canonical === "Intl.getCanonicalLocales" ? "Array" : "Object")}.prototype`,
					};
					let complete = factory !== undefined || canonical === "Array.of";
					if (canonical === "Object.create") {
						const input = operands[2] === undefined ? undefined : this.query(operands[2]);
						if (input?.kind === "known" && input.brand === "null")
							prototype = { kind: "null" };
						else if (input?.kind === "known" && input.canonical !== undefined)
							prototype = { kind: "intrinsic", id: input.canonical };
						else prototype = { kind: "unknown" };
						complete =
							operands[3] === undefined ||
							this.constant(operands[3])?.kind === "undefined";
					}
					const array = arrayFactory || canonical === "Intl.getCanonicalLocales";
					const elements = canonical === "Array.of" ? operands.slice(2) : [];
					const description = intern.intern(
						array
							? {
									kind: "array",
									prototype,
									length: canonical === "Array.of" ? elements.length : null,
									ownKeysComplete: complete,
									properties: elements.map((input, index) => ({
										key: String(index),
										enumerable: true,
										configurable: true,
										descriptor: {
											kind: "data",
											writable: true,
											value: { kind: "operand", index },
										},
									})),
								}
							: { kind: "object", prototype, ownKeysComplete: complete, properties: [] },
					);
					return {
						kind: "known",
						value,
						description,
						brand: array ? "array" : "object",
						exactBrand: factory ?? (array ? "Array" : "Object"),
						construction: {
							kind: "call",
							callee: canonical,
							instruction,
							arguments: operands.slice(2),
						},
						prototype,
						identity: { kind: "fresh-per-evaluation", function: fn.id, value },
						state: "initial-allocation",
						operands: elements,
						environmentDependencies: ["primordials.locked", "realm.current"],
					};
				}
			}

			if (
				canonical !== undefined &&
				STATIC_CONSTRUCTORS.has(canonical) &&
				(opcode === "construct" || canonical === "Array" || canonical === "Object")
			) {
				if (knownOperation !== undefined && opcode === "construct") {
					const target = this.query(operands[0]!);
					if (target.kind !== "known" || target.canonical !== canonical)
						return { kind: "unknown", reason: "unsupported-producer" };
				}
				const args = operands.slice(opcode === "construct" ? 1 : 2);
				// Object returns an existing object argument; its identity is never a new allocation.
				if (canonical === "Object" && args.length !== 0) {
					const argument = this.query(args[0]!);
					if (
						argument.kind === "known" &&
						["object", "array", "function"].includes(argument.brand)
					)
						return { ...argument, value };
					if (
						argument.kind === "known" &&
						["number", "string", "boolean", "bigint", "symbol"].includes(argument.brand)
					) {
						const exactBrand =
							argument.brand === "bigint"
								? "BigInt"
								: argument.brand[0]!.toUpperCase() + argument.brand.slice(1);
						const prototype: StaticPrototype = {
							kind: "intrinsic",
							id: `${exactBrand}.prototype`,
						};
						return {
							kind: "known",
							value,
							description: intern.intern({
								kind: "object",
								prototype,
								properties: [],
								ownKeysComplete: argument.brand !== "string",
								unknownOwnKeys:
									argument.brand === "string"
										? { numeric: true, named: ["length"] }
										: undefined,
							}),
							brand: "object",
							exactBrand,
							prototype,
							construction: {
								kind: opcode,
								callee: canonical,
								instruction,
								arguments: args,
							},
							identity: { kind: "fresh-per-evaluation", function: fn.id, value },
							state: "initial-allocation",
							operands: [],
							environmentDependencies: ["primordials.locked", "realm.current"],
						};
					}
					if (
						argument.kind === "unknown" ||
						!["undefined", "null"].includes(argument.brand)
					)
						return { kind: "unknown", reason: "unsupported-producer" };
				}
				const prototype: StaticPrototype = {
					kind: "intrinsic",
					id: `${canonical}.prototype`,
				};
				if (
					provePrimordialAccess(
						this.#context.facts.world,
						{ kind: "intrinsic", id: canonical, realm: "current" },
						"prototype",
					)?.resolution?.value?.[0] !== primordialNode(`${canonical}.prototype`)?.[0]
				)
					return { kind: "unknown", reason: "unsupported-producer" };
				let description: StaticDescriptionId;
				const bindings: Array<CoreValueId> = [];
				if (canonical === "Array") {
					let length: number | null = args.length;
					let elements = args;
					if (args.length === 1) {
						const constant = this.constant(args[0]!);
						const input = this.query(args[0]!);
						if (constant?.kind === "number") {
							length =
								Number.isInteger(constant.value) &&
								constant.value >= 0 &&
								constant.value <= 4294967295
									? constant.value
									: null;
							elements = [];
						} else if (input.kind === "unknown" || input.brand === "number") {
							length = null;
							elements = [];
						}
					}
					description = intern.intern({
						kind: "array",
						prototype,
						length,
						ownKeysComplete: length !== null,
						properties: elements.map((input, index) => {
							bindings.push(input);
							return {
								key: String(index),
								enumerable: true,
								configurable: true,
								descriptor: {
									kind: "data",
									writable: true,
									value: { kind: "operand", index },
								},
							};
						}),
					});
				} else
					description = intern.intern({
						kind: "object",
						prototype,
						properties: [],
						ownKeysComplete:
							!["String", "RegExp"].includes(canonical) &&
							!canonical.endsWith("Array") &&
							!canonical.endsWith("Error"),
						unknownOwnKeys:
							canonical === "String"
								? { numeric: true, named: ["length"] }
								: canonical === "RegExp"
									? { numeric: false, named: ["lastIndex"] }
									: canonical.endsWith("Array")
										? { numeric: true, named: [] }
										: canonical.endsWith("Error")
											? {
													numeric: false,
													named: [
														"message",
														"cause",
														"errors",
														"error",
														"suppressed",
														"stack",
													],
												}
											: undefined,
					});
				return {
					kind: "known",
					value,
					description,
					brand: canonical === "Array" ? "array" : "object",
					exactBrand: canonical,
					construction: { kind: opcode, callee: canonical, instruction, arguments: args },
					prototype,
					identity: { kind: "fresh-per-evaluation", function: fn.id, value },
					state: "initial-allocation",
					operands: bindings,
					environmentDependencies: ["primordials.locked", "realm.current"],
				};
			}
		}

		if (opcode === "createFunction") {
			const functionIndex = attributes.functionIndex;
			if (typeof functionIndex !== "number")
				return { kind: "unknown", reason: "unsupported-producer" };
			return {
				...primitive(
					intern.intern({
						kind: "function",
						codeIdentity: String(functionIndex),
						captures: [],
						capturesComplete: false,
					}),
					"function",
				),
				state: "initial-allocation",
				identity: { kind: "fresh-per-evaluation", function: fn.id, value },
			};
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
				["undefined", "null", "boolean", "number", "string", "bigint"].includes(
					intern.description(fact.description).kind,
				) &&
				fact.operands.length === 0
			)
				return { kind: "constant", description: fact.description };
			const index = bindings.length;
			bindings.push(input);
			return { kind: "operand", index };
		};
		let description: StaticDescriptionId;
		const allocationIdentities: Array<StaticAllocationIdentity> = [];
		let brand: "array" | "object";
		if (opcode === "createObject" || opcode === "createObjectShaped") {
			brand = "object";
			const keys = (attributes.keyStringIndices ?? []) as ReadonlyArray<number>;
			if (keys.length !== operands.length)
				return { kind: "unknown", reason: "unsupported-producer" };
			this.statistics.visits += keys.length;
			if (this.statistics.visits > this.#limit)
				return { kind: "unknown", reason: "work-limit" };
			const properties: Array<StaticPropertyDescription> = keys.map((key, index) => ({
				key: this.string(key),
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
			if (!Number.isSafeInteger(length) || length < 0 || length > 4294967295)
				return { kind: "unknown", reason: "work-limit" };
			description = intern.intern({
				kind: "array",
				prototype: { kind: "intrinsic", id: "Array.prototype" },
				length,
				properties: [],
			});
		} else if (opcode === "instantiateLiteralTemplate") {
			const offset = attributes.templateOffset as number;
			let position = offset;
			const read = (depth = 0): StaticMember | undefined => {
				if (++this.statistics.visits > this.#limit || depth > 128) return undefined;
				const start = position,
					tag = program.literalTemplateData[position++]!;
				let child: StaticDescriptionId;
				if (tag === 7) return { kind: "hole" };
				if (tag === 0 || tag === 11)
					child = intern.intern({ kind: tag === 0 ? "null" : "undefined" });
				else if (tag === 1 || tag === 2)
					child = intern.intern({ kind: "boolean", value: tag === 2 });
				else if (tag === 3)
					child = intern.intern(
						staticNumberDescription(program.literalTemplateData[position++]! | 0),
					);
				else if (tag === 4)
					child = intern.intern({
						kind: "number",
						low: program.literalTemplateData[position++]!,
						high: program.literalTemplateData[position++]!,
					});
				else if (tag === 5)
					child = intern.intern({
						kind: "string",
						codeUnits: program.stringConstants[program.literalTemplateData[position++]!]!,
					});
				else if (tag === 6)
					child = intern.intern({
						kind: "bigint",
						decimal: String(
							program.bigintConstants[program.literalTemplateData[position++]!]!,
						),
					});
				else if (tag === 8 || tag === 9) {
					const count = program.literalTemplateData[position++]!;
					const properties: Array<StaticPropertyDescription> = [];
					for (let index = 0; index < count; index++) {
						let key = String(index);
						if (tag === 9) {
							if (program.literalTemplateData[position++] !== 10) return undefined;
							key = this.string(program.literalTemplateData[position++]!);
						}
						const member = read(depth + 1);
						if (member === undefined) return undefined;
						if (member.kind !== "hole")
							properties.push({
								key,
								enumerable: true,
								configurable: true,
								descriptor: { kind: "data", writable: true, value: member },
							});
					}
					child = intern.intern(
						tag === 8
							? {
									kind: "array",
									length: count,
									prototype: { kind: "intrinsic", id: "Array.prototype" },
									properties,
								}
							: {
									kind: "object",
									prototype: { kind: "intrinsic", id: "Object.prototype" },
									properties,
								},
					);
					if (depth !== 0) {
						const identitySlot = allocationIdentities.length;
						allocationIdentities.push({
							kind: "template-child",
							function: fn.id,
							value,
							offset: start - offset,
						});
						return { kind: "allocation", description: child, identitySlot };
					}
				} else return undefined;
				return { kind: "constant", description: child };
			};
			const root = read();
			if (root?.kind !== "constant") return { kind: "unknown", reason: "work-limit" };
			brand = program.literalTemplateData[offset] === 8 ? "array" : "object";
			description = root.description;
		} else return { kind: "unknown", reason: "unsupported-producer" };
		return {
			kind: "known",
			value,
			description,
			brand,
			exactBrand: brand === "array" ? "Array" : "Object",
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
			allocationIdentities,
			environmentDependencies: ["current-realm"],
		};
	}

	inherited(value: CoreStaticValue, key: PrimordialKey) {
		if (this.#context === undefined) return undefined;
		if (value.brand === "string" && typeof key === "string") {
			if (key === "length") return undefined;
			if (/^(0|[1-9][0-9]*)$/.test(key)) {
				const text = this.#program.staticDescriptions.description(value.description);
				if (text.kind !== "string" || Number(key) < text.codeUnits.length)
					return undefined;
			}
		}
		if (["string", "number", "boolean", "bigint", "symbol"].includes(value.brand)) {
			const prototype = {
				string: "String",
				number: "Number",
				boolean: "Boolean",
				bigint: "BigInt",
				symbol: "Symbol",
			}[value.brand as "string" | "number" | "boolean" | "bigint" | "symbol"];
			return provePrimordialAccess(
				this.#context.facts.world,
				{
					kind: "primitive",
					prototype: `${prototype}.prototype`,
					realm: "current",
					ownKeys: [],
					ownKeysComplete: true,
					stableUntilRead: true,
				},
				key,
			);
		}
		if (value.prototype.kind !== "intrinsic") return undefined;
		const description = this.#program.staticDescriptions.description(value.description);
		if (
			(description.kind !== "array" && description.kind !== "object") ||
			(description.ownKeysComplete === false &&
				(description.unknownOwnKeys === undefined ||
					(typeof key === "string" &&
						(description.unknownOwnKeys.named.includes(key) ||
							(description.unknownOwnKeys.numeric &&
								(key === "-0" || String(Number(key)) === key)))))) ||
			description.properties.some((property) =>
				typeof key === "string" ? property.key === key : typeof property.key !== "string",
			)
		)
			return undefined;
		return provePrimordialAccess(
			this.#context.facts.world,
			{
				kind: "fresh-allocation",
				prototype: value.prototype.id,
				realm: "current",
				ownKeys: [],
				ownKeysComplete: true,
				stableUntilRead: true,
			},
			key,
		);
	}

	string(index: number): string {
		const units = this.#program.stringConstants[index]!;
		let result = "";
		for (let offset = 0; offset < units.length; offset += 1024)
			result += String.fromCharCode(...units.slice(offset, offset + 1024));
		return result;
	}

	constant(value: CoreValueId, consumer?: CoreInstructionId): ConstantValue | undefined {
		const fact =
			consumer === undefined ? this.query(value) : this.queryAt(value, consumer);
		if (fact.kind === "unknown") return undefined;
		return this.descriptionConstant(fact.description);
	}

	descriptionConstant(id: StaticDescriptionId): ConstantValue | undefined {
		const description = this.#program.staticDescriptions.description(id);
		switch (description.kind) {
			case "null":
				return { kind: "null", value: null };
			case "undefined":
				return { kind: "undefined" };
			case "boolean":
				return description;
			case "bigint":
				return { kind: "bigint", value: BigInt(description.decimal) };
			case "number": {
				const bits = new DataView(new ArrayBuffer(8));
				bits.setUint32(0, description.low, true);
				bits.setUint32(4, description.high, true);
				return { kind: "number", value: bits.getFloat64(0, true) };
			}
			case "string": {
				let result = "";
				for (let offset = 0; offset < description.codeUnits.length; offset += 1024)
					result += String.fromCharCode(
						...description.codeUnits.slice(offset, offset + 1024),
					);
				return { kind: "string", value: result };
			}
			default:
				return undefined;
		}
	}
}

export const CORE_STATIC_VALUE_ANALYSIS: CoreAnalysisDefinition<CoreStaticValueAnalysis> =
	{
		key: "static-value-descriptions",
		scope: "function",
		functionDependencies: ["body", "cfg", "exceptionFlow", "memoryEffects", "facts"],
		programDependencies: ["data"],
		compute({ program, context, request, get }) {
			if (request.scope !== "function")
				throw new Error("Expected function static-value analysis");
			return new CoreStaticValueAnalysis(
				program,
				program.function(request.function),
				() => get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional(),
				65536,
				context,
				() => get(CORE_LOCAL_MEMORY_VERSIONS_ANALYSIS, request),
				(fn, load, value, consumer) =>
					get(CORE_STATIC_CELL_INDEX, { scope: "program" }).query(
						fn,
						load,
						value,
						consumer,
						(functionId) =>
							get(CORE_STATIC_VALUE_ANALYSIS, {
								scope: "function",
								function: functionId,
							}),
						() =>
							get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, {
								scope: "function",
								function: fn.id,
							}).exceptional(),
					),
			);
		},
	};
