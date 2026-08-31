import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-ir.ts";
import type {
	CoreAttributeObject,
	CoreBlockId,
	CoreFunction,
	CoreInstructionId,
	CoreProgram,
	CoreRegion,
} from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";

/**
 * Reaches projection, operation-chain, stateful-protocol, virtual-object, and
 * structural families in one program so their admission contracts stay aligned.
 */
const REGION_SOURCE = `globalThis.run = function run(value, separator) {
	const parts = value.split(separator);
	let total = 0;
	for (let index = 0; index < parts.length; index++) {
		total += parts[index].trim().length;
	}
	const fields = value.split(";");
	const match = /(\\d+)x/.exec(value);
	return total + Number(fields[1].slice(2)) + fields.length + (match === null ? 0 : Number(match[1]));
};
globalThis.iterate = function iterate(values) {
	let total = 0;
	for (const value of values) total += value;
	return total;
};`;

interface Compiled {
	readonly core: CoreProgram;
	readonly definition: ProgramImage;
}

function compile(primordials: "locked" | "mutable"): Compiled {
	let core: CoreProgram | undefined;
	const definition = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			REGION_SOURCE,
			`region-validity-${primordials}.js`,
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { primordials } }),
			),
			afterCoreOptimization(program) {
				core = program;
			},
		},
	);
	return { core: core!, definition };
}

function licenseOf(region: CoreRegion): CoreAttributeObject {
	return region.data.license as CoreAttributeObject;
}

function admissionOf(region: CoreRegion): CoreAttributeObject {
	return licenseOf(region).admission as CoreAttributeObject;
}

function dependencyKinds(region: CoreRegion): ReadonlyArray<string> {
	const guard = licenseOf(region).guard;
	if (typeof guard === "string") return [];
	const dependencies = (guard as CoreAttributeObject).dependencies as ReadonlyArray<{
		readonly kind: string;
	}>;
	return dependencies.map(({ kind }) => kind);
}

function coreRegions(program: CoreProgram): ReadonlyArray<CoreRegion> {
	return program.functions.flatMap(({ regions }) => regions);
}

/** Replace one region of a compiled Core program, keeping everything else intact. */
function withPatchedRegion(
	program: CoreProgram,
	select: (region: CoreRegion) => boolean,
	patch: (region: CoreRegion) => CoreRegion,
): CoreProgram {
	const functionIndex = program.functions.findIndex(({ regions }) =>
		regions.some(select),
	);
	if (functionIndex < 0) throw new Error("no matching region");
	const owner = program.functions[functionIndex]!;
	const regionIndex = owner.regions.findIndex(select);
	return {
		...program,
		functions: program.functions.with(functionIndex, {
			...owner,
			regions: owner.regions.with(regionIndex, patch(owner.regions[regionIndex]!)),
		}),
	};
}

function withLicense(region: CoreRegion, license: CoreAttributeObject): CoreRegion {
	return { ...region, data: { ...region.data, license } };
}

function verificationError(program: CoreProgram): string {
	try {
		verifyCoreProgram(program, coreOpcodeRegistry);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected Core verification to reject the program");
}

describe("guarded-region admission modes", () => {
	it("keeps a locked-world license stable and re-checks an invalidatable one per use", () => {
		const locked = coreRegions(compile("locked").core);
		const mutable = coreRegions(compile("mutable").core);

		expect(locked.length).toBeGreaterThan(0);
		expect(mutable.length).toBeGreaterThan(0);

		// Locking primordials replaces every epoch dependency with a world
		// dependency, which cannot change while the program runs, so one admission
		// covers the region.
		for (const region of locked) {
			expect(dependencyKinds(region)).not.toContain("epoch");
			expect(admissionOf(region).mode).toBe("stable");
		}

		// The same regions in a mutable world depend on an invalidatable epoch and
		// their interiors run user code, so each licensed use keeps its check.
		const invalidatable = mutable.filter((region) =>
			dependencyKinds(region).includes("epoch"),
		);
		expect(invalidatable.length).toBeGreaterThan(0);
		for (const region of invalidatable) {
			expect(admissionOf(region).mode).toBe("per-use");
		}
		// A structural license names nothing invalidatable in either world.
		for (const region of mutable.filter(
			(candidate) => !dependencyKinds(candidate).includes("epoch"),
		)) {
			expect(admissionOf(region).mode).toBe("stable");
		}
	});

	it("rejects a stable claim over an interior that runs user code", () => {
		const { core } = compile("mutable");
		const select = (region: CoreRegion) => dependencyKinds(region).includes("epoch");
		const tampered = withPatchedRegion(core, select, (region) =>
			withLicense(region, {
				...licenseOf(region),
				admission: { ...admissionOf(region), mode: "stable" },
			}),
		);

		expect(verificationError(tampered)).toMatch(
			/claims one admission at @\d+ without an epoch-stable interior/,
		);
	});

	it("rejects a license that names an epoch family no backend can lower", () => {
		const { core } = compile("mutable");
		const select = (region: CoreRegion) => dependencyKinds(region).includes("epoch");
		const tampered = withPatchedRegion(core, select, (region) =>
			withLicense(region, {
				...licenseOf(region),
				guard: {
					...(licenseOf(region).guard as CoreAttributeObject),
					dependencies: [{ kind: "epoch", family: "object-shapes" }],
				},
			}),
		);

		expect(verificationError(tampered)).toMatch(
			/depends on unlowerable epoch family object-shapes/,
		);
	});

	it("rejects a certificate with no admission record", () => {
		const { core } = compile("locked");
		const tampered = withPatchedRegion(
			core,
			() => true,
			(region) => {
				const { admission: _dropped, ...rest } = licenseOf(region);
				return withLicense(region, rest);
			},
		);

		expect(verificationError(tampered)).toMatch(/has no readable license admission/);
	});

	it("rejects an unreadable license guard", () => {
		const { core } = compile("locked");
		const tampered = withPatchedRegion(
			core,
			() => true,
			(region) => withLicense(region, { ...licenseOf(region), guard: 7 }),
		);

		expect(verificationError(tampered)).toMatch(/has an unreadable license guard/);
	});

	it("rejects a virtual result without its materialization obligation", () => {
		const { core } = compile("locked");
		const tampered = withPatchedRegion(
			core,
			({ kind }) => kind === "iterator-result-virtualization",
			(region) => {
				const license = licenseOf(region);
				const guard = license.guard as CoreAttributeObject;
				const obligations = guard.obligations as ReadonlyArray<CoreAttributeObject>;
				return withLicense(region, {
					...license,
					guard: {
						...guard,
						obligations: obligations.filter(
							(obligation) => obligation.kind !== "materialize",
						),
					},
				});
			},
		);

		expect(verificationError(tampered)).toMatch(
			/has a mismatched materialization obligation/,
		);
	});

	it("carries the admission decision across wire serialization", () => {
		for (const primordials of ["locked", "mutable"] as const) {
			const { definition } = compile(primordials);
			const restored = deserializeCompilerArtifact(serializeCompilerArtifact(definition));
			const original = definition.native.functions.flatMap((fn) => fn.specializations);
			const roundTripped = restored.native.functions.flatMap((fn) => fn.specializations);

			expect(original.length).toBeGreaterThan(0);
			expect(roundTripped.map((region) => region.license.admission)).toEqual(
				original.map((region) => region.license.admission),
			);
		}
	});

	it("rejects a wire admission anchor outside the region's claims", () => {
		const { definition } = compile("locked");
		const functionIndex = definition.native.functions.findIndex((fn) =>
			fn.specializations.some(({ kind }) => kind === "string-split-cursor"),
		);
		const owner = definition.native.functions[functionIndex]!;
		const bytecode = definition.runtime.functions[functionIndex]!;
		const regionIndex = owner.specializations.findIndex(
			({ kind }) => kind === "string-split-cursor",
		);
		const region = owner.specializations[regionIndex]!;
		if (region.kind !== "string-split-cursor") throw new Error("unreachable");
		const foreign = bytecode.instructions.findIndex(
			(_instruction, ip) => !region.claimedIps.includes(ip),
		);
		const tampered: ProgramImage = {
			...definition,
			native: {
				...definition.native,
				functions: definition.native.functions.with(functionIndex, {
					...owner,
					specializations: owner.specializations.with(regionIndex, {
						...region,
						license: {
							...region.license,
							admission: { ...region.license.admission, anchorIp: foreign },
						},
					}),
				}),
			},
		};

		expect(() => serializeCompilerArtifact(tampered)).toThrow(/invalid region envelope/);
	});
});

/**
 * Hand-built certificates over an invalidatable license. Compiled programs cover
 * the vacuous and the user-code interiors; these cover the interior proof itself,
 * where a scalar-only interior earns `stable` and each escape route loses it.
 */
describe("guarded-region interior proof", () => {
	interface Built {
		readonly program: CoreProgram;
		readonly anchor: CoreInstructionId;
	}

	function certificate(
		anchor: CoreInstructionId,
		ordinaryBlocks: ReadonlyArray<CoreBlockId>,
	): CoreRegion {
		return {
			kind: "test-certificate",
			anchors: [anchor],
			claimedInstructions: [anchor],
			ordinaryBlocks,
			exceptionalBlocks: [],
			data: {
				license: {
					guard: {
						dependencies: [{ kind: "epoch", family: "watched-methods" }],
						obligations: [{ kind: "fallback", id: "interior-proof", cause: "authority" }],
					},
					genericTwin: "retained",
					materialization: "none",
					admission: { anchor: { $coreInstruction: anchor }, mode: "stable" },
				},
			},
		};
	}

	function program(functions: ReadonlyArray<CoreFunction>): CoreProgram {
		return {
			functions,
			stringConstants: [[]],
			bigintConstants: [],
			literalTemplateData: [],
			sourcePositions: [],
			globalCount: 0,
		};
	}

	/** One block: anchor, then `extra` unclaimed instructions, then a return. */
	function straightLine(
		extra: (builder: CoreFunctionBuilder, block: CoreBlockId) => void,
	): Built {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [admitted] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		extra(builder, entry);
		const [result] = builder.appendInstruction(entry, "createUndefined", []);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const complete = builder.finish(entry);
		const anchor = complete.blocks[0]!.instructions.find(
			(instruction) => instruction.outputs[0] === admitted,
		)!.id;
		return {
			program: program([{ ...complete, regions: [certificate(anchor, [entry])] }]),
			anchor,
		};
	}

	it("accepts one admission over a scalar-only interior", () => {
		const built = straightLine((builder, block) => {
			const [left] = builder.appendInstruction(block, "createF64", [], {
				attributes: { value: 2 },
				outputRepresentations: ["f64"],
			});
			const [right] = builder.appendInstruction(block, "createF64", [], {
				attributes: { value: 3 },
				outputRepresentations: ["f64"],
			});
			builder.appendInstruction(block, "binary", [left!, right!], {
				attributes: { operator: "+" },
				outputRepresentations: ["f64"],
			});
		});

		expect(() => verifyCoreProgram(built.program, coreOpcodeRegistry)).not.toThrow();
	});

	it("rejects a licensed use before its same-block admission anchor", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const [early] = builder.appendInstruction(entry, "createF64", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		const [admitted] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 2 },
			outputRepresentations: ["f64"],
		});
		const [result] = builder.appendInstruction(entry, "createUndefined", []);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const complete = builder.finish(entry);
		const earlyInstruction = complete.blocks[0]!.instructions.find(
			(instruction) => instruction.outputs[0] === early,
		)!.id;
		const anchor = complete.blocks[0]!.instructions.find(
			(instruction) => instruction.outputs[0] === admitted,
		)!.id;
		const region = certificate(anchor, [entry]);
		const claimedBeforeAdmission: CoreRegion = {
			...region,
			claimedInstructions: [earlyInstruction, anchor],
		};

		expect(
			verificationError(program([{ ...complete, regions: [claimedBeforeAdmission] }])),
		).toMatch(/without an epoch-stable interior/);
	});

	it("loses one admission when interior arithmetic can run a coercion hook", () => {
		const built = straightLine((builder, block) => {
			const [left] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value: 2 },
			});
			const [right] = builder.appendInstruction(block, "createNumber", [], {
				attributes: { value: 3 },
			});
			builder.appendInstruction(block, "binary", [left!, right!], {
				attributes: { operator: "+" },
			});
		});

		expect(verificationError(built.program)).toMatch(/without an epoch-stable interior/);
	});

	it("loses one admission when the interior stores to a property", () => {
		const built = straightLine((builder, block) => {
			const [object] = builder.appendInstruction(block, "createObject", [], {
				attributes: { keyStringIndices: [] },
			});
			const [value] = builder.appendInstruction(block, "createF64", [], {
				attributes: { value: 1 },
				outputRepresentations: ["f64"],
			});
			builder.appendInstruction(block, "storePropertyStatic", [object!, value!], {
				attributes: { stringIndex: 0 },
			});
		});

		expect(verificationError(built.program)).toMatch(/without an epoch-stable interior/);
	});

	it("loses one admission when a licensed block is reachable without the anchor", () => {
		const builder = new CoreFunctionBuilder(0, coreOpcodeRegistry);
		const entry = builder.createBlock();
		const bypass = builder.createBlock();
		const licensed = builder.createBlock();
		const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
			attributes: { value: true },
		});
		const [admitted] = builder.appendInstruction(entry, "createNumber", [], {
			attributes: { value: 1 },
			outputRepresentations: ["f64"],
		});
		builder.setTerminator(entry, {
			kind: "branch",
			condition: condition!,
			consequent: { block: licensed, arguments: [] },
			alternate: { block: bypass, arguments: [] },
		});
		builder.setTerminator(bypass, {
			kind: "jump",
			edge: { block: licensed, arguments: [] },
		});
		const [result] = builder.appendInstruction(licensed, "createUndefined", []);
		builder.setTerminator(licensed, { kind: "return", value: result! });
		const complete = builder.finish(entry);
		const anchor = complete.blocks[0]!.instructions.find(
			(instruction) => instruction.outputs[0] === admitted,
		)!.id;

		// `entry` dominates `licensed`, but `bypass` reaches it too, so the interior
		// is not closed against re-entry after code the proof never examined.
		expect(
			verificationError(
				program([{ ...complete, regions: [certificate(anchor, [entry, licensed])] }]),
			),
		).toMatch(/without an epoch-stable interior/);
	});
});
