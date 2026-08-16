import type {
	CompilerFact,
	CompilerSiteFacts,
	FactDependency,
	FactObligation,
	FactProof,
	RepresentationFact,
	ShapeFact,
	SourceSiteId,
} from "./compiler-facts.ts";
import { knownFact, sourceSiteId } from "./compiler-facts.ts";
import { ensureCompilerEscape, ensureCompilerSummaries } from "./compiler-summaries.ts";
import { escapeOfRegister } from "./escape.ts";
import { decodeStringConstant } from "./inline.ts";
import type { IntermediateProgram, IRFunction, IRInstruction } from "./ir.ts";

const localSites = new WeakMap<
	IntermediateProgram,
	ReadonlyMap<string, CompilerSiteFacts>
>();

const allocationTypes = new Set<IRInstruction["type"]>([
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

function functionId(fn: IRFunction): string {
	return `${encodeURIComponent(fn.semanticFile.path)}#${fn.functionIndex}`;
}

function logicalSourceSite(
	program: IntermediateProgram,
	fn: IRFunction,
	positionId: number,
	kind: string,
): SourceSiteId | undefined {
	if (positionId < 0) return undefined;
	const position = program.sourcePositions[positionId];
	if (position === undefined) return undefined;
	const owner =
		position.inlinedFunctionIndex === undefined
			? fn
			: program.functions.find(
					(candidate) => candidate.functionIndex === position.inlinedFunctionIndex,
				);
	if (owner === undefined) return undefined;
	return sourceSiteId(owner.semanticFile.path, position.line, position.column, kind);
}

function siteProof(
	fn: IRFunction,
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

function shapeFact(
	program: IntermediateProgram,
	fn: IRFunction,
	instruction: IRInstruction,
	sourceSite: SourceSiteId | undefined,
): CompilerFact<ShapeFact> | undefined {
	if (instruction.type === "createObject") {
		return knownFact(
			{ kind: "object", keys: [] },
			siteProof(fn, sourceSite, "fresh-empty-object"),
		);
	}
	if (instruction.type === "createObjectShaped") {
		return knownFact(
			{
				kind: "object",
				keys: instruction.keyStringIndices.map((index) =>
					decodeStringConstant(program, index),
				),
			},
			siteProof(fn, sourceSite, "static-literal-shape"),
		);
	}
	if (instruction.type === "createArray") {
		return knownFact(
			{ kind: "array", elements: "dense" },
			siteProof(fn, sourceSite, "fresh-dense-array"),
		);
	}
	return undefined;
}

function immutableBindingFact(
	program: IntermediateProgram,
	instruction: IRInstruction,
): CompilerFact<"immutable"> | undefined {
	if (instruction.type === "loadIntrinsic") {
		return program.facts.immutableGlobalBindings.get(instruction.intrinsic);
	}
	if (
		instruction.type === "loadGlobalProperty" ||
		instruction.type === "storeGlobalProperty"
	) {
		return program.facts.immutableGlobalBindings.get(
			decodeStringConstant(program, instruction.nameStringIndex),
		);
	}
	return undefined;
}

/**
 * Classify final residual instructions after optimization and before register
 * allocation. These facts are diagnostic in Phase 2; lowering behavior is unchanged.
 */
export function ensureCompilerSiteFacts(
	program: IntermediateProgram,
): ReadonlyMap<string, CompilerSiteFacts> {
	const cached = localSites.get(program);
	if (cached !== undefined) return cached;

	ensureCompilerSummaries(program);
	const escape = ensureCompilerEscape(program);
	const sites = new Map<string, CompilerSiteFacts>();
	const instructionSites = program.facts.instructionSites;

	for (const fn of program.functions) {
		const context = escape.contexts.get(fn.functionIndex);
		const materializingSiteIds = new Set<number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.type === "return" &&
					instruction.stackObjectMaterializeSiteId !== undefined
				) {
					materializingSiteIds.add(instruction.stackObjectMaterializeSiteId);
				}
			}
		}

		let positionId = -1;
		for (const [blockIndex, block] of fn.blocks.entries()) {
			for (const [instructionIndex, instruction] of block.instructions.entries()) {
				if (instruction.type === "sourcePos") {
					positionId = instruction.pos;
					continue;
				}
				const id = `${fn.functionIndex}:${blockIndex}:${instructionIndex}:${instruction.type}`;
				const sourceSite = logicalSourceSite(
					program,
					fn,
					positionId,
					`residual:${instruction.type}`,
				);
				const isAllocation = allocationTypes.has(instruction.type);
				const destination =
					isAllocation && "registers" in instruction
						? instruction.registers[0]
						: undefined;
				const escapeFact =
					context === undefined || destination === undefined
						? undefined
						: knownFact(
								escapeOfRegister(program, fn, context, destination, escape.summaries),
								siteProof(fn, sourceSite, "program-escape-fixed-point", [
									{ kind: "summary", id: functionId(fn) },
								]),
							);
				const stackObject =
					(instruction.type === "createObject" ||
						instruction.type === "createObjectShaped") &&
					instruction.stackObject === true;
				const materializes =
					stackObject &&
					instruction.stackObjectSiteId !== undefined &&
					materializingSiteIds.has(instruction.stackObjectSiteId);
				const representation: CompilerFact<RepresentationFact> | undefined = isAllocation
					? knownFact(
							stackObject ? "stack" : "heap",
							siteProof(
								fn,
								sourceSite,
								stackObject ? "closed-stack-object-proof" : "residual-heap-value",
								[],
								materializes ? [{ kind: "materialize", id: `stack-object:${id}` }] : [],
							),
						)
					: undefined;
				const binding = immutableBindingFact(program, instruction);
				const shape = shapeFact(program, fn, instruction, sourceSite);
				const facts: CompilerSiteFacts = {
					id,
					...(sourceSite === undefined ? {} : { sourceSite }),
					functionId: functionId(fn),
					instruction: instruction.type,
					...(shape === undefined ? {} : { shape }),
					...(escapeFact === undefined ? {} : { escape: escapeFact }),
					...(representation === undefined ? {} : { representation }),
					...(instruction.type === "call" && instruction.knownBuiltinCall !== undefined
						? { builtinIdentity: instruction.knownBuiltinCall.identity }
						: {}),
					...(binding === undefined ? {} : { immutableBinding: binding }),
				};
				if (
					facts.shape !== undefined ||
					facts.escape !== undefined ||
					facts.representation !== undefined ||
					facts.builtinIdentity !== undefined ||
					facts.immutableBinding !== undefined
				) {
					sites.set(id, facts);
					instructionSites.set(instruction, facts);
				}
			}
		}
	}

	program.facts = { ...program.facts, sites };
	localSites.set(program, sites);
	return sites;
}
