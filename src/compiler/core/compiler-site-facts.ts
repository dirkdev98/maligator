import type {
	CompilerCallTargetSet,
	CompilerFact,
	CompilerSiteFacts,
	FactDependency,
	FactObligation,
	FactProof,
	KnownBuiltinCall,
	ShapeFact,
	SourceSiteId,
} from "../shared/compiler-facts.ts";
import { knownFact, sourceSiteId } from "../shared/compiler-facts.ts";
import type { CoreCompilation, CoreCompilationContext } from "./core-compilation.ts";
import type {
	CoreFunctionId,
	CoreInstructionAttributes,
	CoreInstructionId,
} from "./core-ir.ts";
import {
	coreSpecializationRecipeAnchorsAt,
	coreSpecializationRecipeFunctionAt,
	coreSpecializationRecipeKindAt,
	coreSpecializationRecipeRepresentationAt,
	coreSpecializationRecipeTargetFunctionsAt,
} from "./core-specialization-recipes.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

const allocationOpcodes = new Set([
	"createObject",
	"createObjectShaped",
	"createArray",
	"instantiateLiteralTemplate",
	"createFunction",
	"createArgumentsObject",
	"createRestArguments",
	"createModuleNamespace",
	"createTemplateObject",
	"createBigint",
]);

export function coreCompilerSiteId(
	functionId: CoreFunctionId,
	block: number,
	instruction: CoreInstructionId,
	opcode: string,
): string {
	return `${functionId}:${block}:${instruction}:${opcode}`;
}

function compilerFunctionId(fn: CoreFunctionStore): string {
	return `${encodeURIComponent(fn.metadata.sourcePath)}#${fn.id}`;
}

function sourceOwner(
	program: CoreProgram,
	fallback: CoreFunctionStore,
	functionIndex: number | undefined,
): CoreFunctionStore | undefined {
	if (functionIndex === undefined) return fallback;
	for (const functionId of program.functionIds()) {
		if (functionId === functionIndex) return program.function(functionId);
	}
	return undefined;
}

function logicalSourceSite(
	program: CoreProgram,
	fn: CoreFunctionStore,
	positionId: number | undefined,
	kind: string,
): SourceSiteId | undefined {
	if (positionId === undefined) return undefined;
	const position = program.sourcePositions[positionId];
	if (position === undefined) return undefined;
	const owner = sourceOwner(program, fn, position.inlinedFunctionIndex);
	return owner === undefined
		? undefined
		: sourceSiteId(owner.metadata.sourcePath, position.line, position.column, kind);
}

function siteProof(
	fn: CoreFunctionStore,
	sourceSite: SourceSiteId | undefined,
	origin: string,
	dependencies: ReadonlyArray<FactDependency> = [],
	obligations: ReadonlyArray<FactObligation> = [],
): FactProof {
	return {
		scope:
			sourceSite === undefined
				? { kind: "function", id: fn.id }
				: { kind: "site", id: sourceSite },
		dependencies,
		obligations,
		origin,
	};
}

function numberArray(value: unknown): ReadonlyArray<number> | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "number")
		? value
		: undefined;
}

function decodeString(program: CoreProgram, index: number): string {
	const units = program.stringConstants[index];
	return units === undefined ? "" : String.fromCodePoint(...units);
}

function shapeFact(
	program: CoreProgram,
	fn: CoreFunctionStore,
	opcode: string,
	attributes: CoreInstructionAttributes,
	sourceSite: SourceSiteId | undefined,
): CompilerFact<ShapeFact> | undefined {
	if (opcode === "createObject") {
		return knownFact(
			{ kind: "object", keys: [] },
			siteProof(fn, sourceSite, "fresh-empty-object"),
		);
	}
	if (opcode === "createObjectShaped") {
		const indices = numberArray(attributes.keyStringIndices);
		if (indices === undefined) return undefined;
		return knownFact(
			{ kind: "object", keys: indices.map((index) => decodeString(program, index)) },
			siteProof(fn, sourceSite, "static-literal-shape"),
		);
	}
	if (opcode === "createArray") {
		return knownFact(
			{ kind: "array", elements: "dense" },
			siteProof(fn, sourceSite, "fresh-dense-array"),
		);
	}
	return undefined;
}

function immutableBindingFact(
	program: CoreProgram,
	opcode: string,
	attributes: CoreInstructionAttributes,
	context: CoreCompilationContext,
): CompilerFact<"immutable"> | undefined {
	if (opcode === "loadIntrinsic") {
		const intrinsic = attributes.intrinsic;
		return typeof intrinsic === "string"
			? context.facts.immutableGlobalBindings.get(intrinsic)
			: undefined;
	}
	if (opcode === "loadGlobalProperty" || opcode === "storeGlobalProperty") {
		const index = attributes.nameStringIndex;
		return typeof index === "number"
			? context.facts.immutableGlobalBindings.get(decodeString(program, index))
			: undefined;
	}
	return undefined;
}

function knownBuiltinCall(
	attributes: CoreInstructionAttributes,
): KnownBuiltinCall | undefined {
	const candidate = attributes.knownBuiltinCall;
	return candidate !== null && typeof candidate === "object"
		? (candidate as unknown as KnownBuiltinCall)
		: undefined;
}

function selectedStackAllocations(compilation: CoreCompilation): ReadonlySet<string> {
	const selected = new Set<string>();
	for (let row = 0; row < compilation.plan.recipes.count; row++) {
		if (
			coreSpecializationRecipeKindAt(compilation.plan.recipes, row) !==
			"stack-object-plan"
		)
			continue;
		const functionId = coreSpecializationRecipeFunctionAt(compilation.plan.recipes, row);
		for (const instruction of coreSpecializationRecipeAnchorsAt(
			compilation.plan.recipes,
			row,
		)) {
			selected.add(`${functionId}:${instruction}`);
		}
	}
	return selected;
}

function selectedCallTargets(
	compilation: CoreCompilation,
): ReadonlyMap<string, CompilerCallTargetSet> {
	const selected = new Map<string, Set<CoreFunctionId>>();
	const open = new Set<string>();
	const add = (
		caller: CoreFunctionId,
		instruction: CoreInstructionId,
		targets: ReadonlyArray<CoreFunctionId>,
		opaque: boolean,
	): void => {
		const key = `${caller}:${instruction}`;
		const current = selected.get(key) ?? new Set<CoreFunctionId>();
		for (const target of targets) current.add(target);
		selected.set(key, current);
		if (opaque) open.add(key);
	};
	for (let row = 0; row < compilation.plan.recipes.count; row++) {
		if (
			coreSpecializationRecipeKindAt(compilation.plan.recipes, row) !==
			"guarded-direct-call"
		)
			continue;
		add(
			coreSpecializationRecipeFunctionAt(compilation.plan.recipes, row),
			coreSpecializationRecipeAnchorsAt(compilation.plan.recipes, row)[0]!,
			coreSpecializationRecipeTargetFunctionsAt(compilation.plan.recipes, row),
			coreSpecializationRecipeRepresentationAt(compilation.plan.recipes, row) !==
				"exact-function",
		);
	}
	for (const entry of compilation.plan.directEntries) {
		for (const site of entry.callSites) {
			add(site.caller, site.instruction, [entry.function], false);
		}
	}
	return new Map(
		[...selected].map(([key, targets]) => [
			key,
			{
				functions: [...targets].sort((left, right) => left - right),
				anyScript: false,
				opaque: open.has(key),
			},
		]),
	);
}

/** Derive residual site facts from sealed Core and its selected plan without analysis. */
export function attachCoreCompilerSiteFacts(
	compilation: CoreCompilation,
): CoreCompilation {
	const { program, context } = compilation;
	const sites = new Map<string, CompilerSiteFacts>();
	const stackAllocations = selectedStackAllocations(compilation);
	const callTargets = selectedCallTargets(compilation);
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		for (const block of fn.blockIds()) {
			for (const instruction of fn.bodyInstructionIds(block)) {
				const opcode = fn.instructionOpcodeName(instruction);
				const attributes = fn.instructionAttributes(instruction);
				const id = coreCompilerSiteId(functionId, block, instruction, opcode);
				const sourceSite = logicalSourceSite(
					program,
					fn,
					fn.instructionSourcePosition(instruction),
					`residual:${opcode}`,
				);
				const shape = shapeFact(program, fn, opcode, attributes, sourceSite);
				const immutableBinding = immutableBindingFact(
					program,
					opcode,
					attributes,
					context,
				);
				const builtin = knownBuiltinCall(attributes);
				const selectedTargets = callTargets.get(`${functionId}:${instruction}`);
				const callTarget =
					selectedTargets === undefined
						? undefined
						: knownFact(
								selectedTargets,
								siteProof(fn, sourceSite, "core-specialization-plan"),
							);
				const isAllocation = allocationOpcodes.has(opcode);
				const isStack = stackAllocations.has(`${functionId}:${instruction}`);
				const representation = isAllocation
					? knownFact(
							isStack ? ("stack" as const) : ("heap" as const),
							siteProof(
								fn,
								sourceSite,
								isStack ? "core-specialization-plan" : "residual-heap-value",
							),
						)
					: undefined;
				const escape = isStack
					? knownFact(
							"none" as const,
							siteProof(fn, sourceSite, "core-specialization-plan"),
						)
					: undefined;
				const facts: CompilerSiteFacts = {
					id,
					...(sourceSite === undefined ? {} : { sourceSite }),
					functionId: compilerFunctionId(fn),
					instruction: opcode,
					...(shape === undefined ? {} : { shape }),
					...(escape === undefined ? {} : { escape }),
					...(representation === undefined ? {} : { representation }),
					...(builtin === undefined
						? {}
						: {
								builtinIdentity: builtin.identity,
								builtinSemantics: builtin.semantics,
							}),
					...(immutableBinding === undefined ? {} : { immutableBinding }),
					...(callTarget === undefined ? {} : { callTargets: callTarget }),
				};
				if (
					facts.shape !== undefined ||
					facts.escape !== undefined ||
					facts.representation !== undefined ||
					facts.builtinIdentity !== undefined ||
					facts.builtinSemantics !== undefined ||
					facts.immutableBinding !== undefined ||
					facts.callTargets !== undefined
				) {
					sites.set(id, facts);
				}
			}
		}
	}
	return Object.freeze({
		...compilation,
		context: Object.freeze({
			...context,
			facts: Object.freeze({ ...context.facts, sites }),
		}),
	});
}
