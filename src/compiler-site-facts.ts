import type {
	CompilerFact,
	CompilerSiteFacts,
	FactDependency,
	FactObligation,
	FactProof,
	KnownBuiltinCall,
	ShapeFact,
	SourceSiteId,
} from "./compiler-facts.ts";
import { knownFact, sourceSiteId } from "./compiler-facts.ts";
import type { CoreFunction, CoreInstruction, CoreProgram } from "./core-ir.ts";

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

function functionId(fn: CoreFunction): string {
	return `${encodeURIComponent(fn.metadata.sourcePath)}#${fn.functionIndex}`;
}

function logicalSourceSite(
	program: CoreProgram,
	fn: CoreFunction,
	positionId: number | undefined,
	kind: string,
): SourceSiteId | undefined {
	if (positionId === undefined) return undefined;
	const position = program.sourcePositions[positionId];
	if (position === undefined) return undefined;
	const owner =
		position.inlinedFunctionIndex === undefined
			? fn
			: program.functions.find(
					(candidate) => candidate.functionIndex === position.inlinedFunctionIndex,
				);
	return owner === undefined
		? undefined
		: sourceSiteId(
				owner.metadata.sourcePath,
				position.line,
				position.column,
				kind,
			);
}

function siteProof(
	fn: CoreFunction,
	sourceSite: SourceSiteId | undefined,
	origin: string,
	dependencies: ReadonlyArray<FactDependency> = [],
	obligations: ReadonlyArray<FactObligation> = [],
): FactProof {
	return {
		scope:
			sourceSite === undefined
				? { kind: "function", id: fn.functionIndex }
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
	fn: CoreFunction,
	instruction: CoreInstruction,
	sourceSite: SourceSiteId | undefined,
): CompilerFact<ShapeFact> | undefined {
	if (instruction.opcode === "createObject") {
		return knownFact(
			{ kind: "object", keys: [] },
			siteProof(fn, sourceSite, "fresh-empty-object"),
		);
	}
	if (instruction.opcode === "createObjectShaped") {
		const indices = numberArray(instruction.attributes.keyStringIndices);
		if (indices === undefined) return undefined;
		return knownFact(
			{ kind: "object", keys: indices.map((index) => decodeString(program, index)) },
			siteProof(fn, sourceSite, "static-literal-shape"),
		);
	}
	if (instruction.opcode === "createArray") {
		return knownFact(
			{ kind: "array", elements: "dense" },
			siteProof(fn, sourceSite, "fresh-dense-array"),
		);
	}
	return undefined;
}

function immutableBindingFact(
	program: CoreProgram,
	instruction: CoreInstruction,
): CompilerFact<"immutable"> | undefined {
	const facts = program.compilation?.facts;
	if (facts === undefined) return undefined;
	if (instruction.opcode === "loadIntrinsic") {
		const intrinsic = instruction.attributes.intrinsic;
		return typeof intrinsic === "string"
			? facts.immutableGlobalBindings.get(intrinsic)
			: undefined;
	}
	if (
		instruction.opcode === "loadGlobalProperty" ||
		instruction.opcode === "storeGlobalProperty"
	) {
		const index = instruction.attributes.nameStringIndex;
		return typeof index === "number"
			? facts.immutableGlobalBindings.get(decodeString(program, index))
			: undefined;
	}
	return undefined;
}

function knownBuiltinCall(instruction: CoreInstruction): KnownBuiltinCall | undefined {
	const candidate = instruction.attributes.knownBuiltinCall;
	return candidate !== null && typeof candidate === "object"
		? (candidate as unknown as KnownBuiltinCall)
		: undefined;
}

/** Attach final residual facts directly to immutable Core instruction identities. */
export function attachCoreCompilerSiteFacts(program: CoreProgram): CoreProgram {
	const compilation = program.compilation;
	if (compilation === undefined) return program;
	const sites = new Map<string, CompilerSiteFacts>();
	const instructionSites = compilation.facts.instructionSites;

	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const id = `${fn.functionIndex}:${block.id}:${instruction.id}:${instruction.opcode}`;
				const sourceSite = logicalSourceSite(
					program,
					fn,
					instruction.sourcePosition,
					`residual:${instruction.opcode}`,
				);
				const shape = shapeFact(program, fn, instruction, sourceSite);
				const immutableBinding = immutableBindingFact(program, instruction);
				const builtin = knownBuiltinCall(instruction);
				const isAllocation = allocationOpcodes.has(instruction.opcode);
				const representation = isAllocation
					? knownFact(
							"heap" as const,
							siteProof(fn, sourceSite, "residual-heap-value"),
						)
					: undefined;
				const facts: CompilerSiteFacts = {
					id,
					...(sourceSite === undefined ? {} : { sourceSite }),
					functionId: functionId(fn),
					instruction: instruction.opcode,
					...(shape === undefined ? {} : { shape }),
					...(representation === undefined ? {} : { representation }),
					...(builtin === undefined
						? {}
						: {
								builtinIdentity: builtin.identity,
								builtinSemantics: builtin.semantics,
							}),
					...(immutableBinding === undefined ? {} : { immutableBinding }),
				};
				if (
					facts.shape !== undefined ||
					facts.representation !== undefined ||
					facts.builtinIdentity !== undefined ||
					facts.builtinSemantics !== undefined ||
					facts.immutableBinding !== undefined
				) {
					sites.set(id, facts);
					instructionSites.set(instruction, facts);
				}
			}
		}
	}

	return {
		...program,
		compilation: {
			...compilation,
			facts: { ...compilation.facts, sites },
		},
	};
}
