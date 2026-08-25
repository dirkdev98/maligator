import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { coreOpcodeRegistry } from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import type { CoreProgram, CoreRegion } from "../src/compiler/core/core-ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/core-target-lowering.ts";
import { lowerExecutionToProgramImage } from "../src/compiler/target/lower-vm.ts";
import type { ProgramImage, VmRegion } from "../src/compiler/target/lower-vm.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/serialize-vm.ts";
import { coreCompilationForTest } from "./helpers/core-compilation.ts";

/** One RegExp.exec projection per function: a fresh locked literal, then an open receiver. */
const OPPOSITE_PLACEMENTS = `globalThis.inline = function inline(value) {
	const match = /(\\d+)x/.exec(value);
	if (match === null) return -1;
	return Number(match[1]);
};
globalThis.open = function open(supplied, value) {
	const match = supplied.exec(value);
	if (match === null) return -1;
	return Number(match[1]);
};`;

const SPLIT_AND_SLICE = `globalThis.parse = function parse(value) {
	const fields = value.split(";");
	return Number(fields[1].slice(2)) + fields[0].length + fields.length;
};`;

/** The same regions reached through a branch whose arms are semantically empty. */
const FORWARDED_SPLIT_AND_SLICE = {
	plain: `globalThis.parse = function parse(value, flag) {
	const fields = value.split(";");
	return Number(fields[1].slice(2)) + fields[0].length + fields.length;
};`,
	forwarded: `globalThis.parse = function parse(value, flag) {
	if (flag) {} else {}
	const fields = value.split(";");
	return Number(fields[1].slice(2)) + fields[0].length + fields.length;
};`,
};

function lockedCore(source: string, path: string): CoreProgram {
	let optimized: CoreProgram | undefined;
	compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, path),
		{
			facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
			afterCoreOptimization(program) {
				optimized = program;
			},
		},
	);
	return optimized!;
}

function lockedDefinition(source: string, path: string): ProgramImage {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, path),
		{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
	);
}

function coreRegions(program: CoreProgram): ReadonlyArray<CoreRegion> {
	return program.functions.flatMap(({ regions }) => regions);
}

function corePlacements(program: CoreProgram): ReadonlyArray<[string, unknown]> {
	return coreRegions(program)
		.map(
			(region) =>
				[
					region.kind,
					(region.data as { propertyPlacement?: unknown }).propertyPlacement,
				] as [string, unknown],
		)
		.filter(([, placement]) => placement !== undefined)
		.sort(([left], [right]) => left.localeCompare(right));
}

/** Parameter-only blocks whose whole body is a jump: what the Core pass folds away. */
function emptyForwardingBlocks(program: CoreProgram): ReadonlyArray<string> {
	return program.functions.flatMap((fn) =>
		fn.blocks
			.filter(
				(block) =>
					block.id !== fn.entry &&
					block.id !== fn.bodyEntry &&
					block.instructions.length === 0 &&
					block.handler === undefined &&
					!block.parameters.some(({ role }) => role === "exception") &&
					block.terminator.kind === "jump",
			)
			.map((block) => `f${fn.functionIndex}b${block.id}`),
	);
}

function vmRegions(definition: ProgramImage): ReadonlyArray<VmRegion> {
	return definition.nativePlan.functions.flatMap(
		({ specializations }) => specializations,
	);
}

/** Region kind, placement, and opcode selection, with every register identity dropped. */
function semanticRegionShape(
	definition: ProgramImage,
): ReadonlyArray<Record<string, unknown>> {
	return definition.nativePlan.functions
		.flatMap((native) =>
			native.specializations.map((region) => {
				const fn = definition.functions[native.functionIndex]!;
				return {
					kind: region.kind,
					representation: region.representation,
					materialization: region.license.materialization,
					dependencies: region.license.guard.dependencies,
					placement: (region as { propertyPlacement?: string }).propertyPlacement,
					anchorOpcodes: region.anchors.map((ip) => fn.instructions[ip]?.opcode),
					claimedOpcodes: region.claimedIps
						.map((ip) => fn.instructions[ip]?.opcode)
						.sort(),
				};
			}),
		)
		.sort((left, right) => left.kind.localeCompare(right.kind));
}

function regexpProjections(
	definition: ProgramImage,
): ReadonlyArray<Extract<VmRegion, { kind: "regexp-exec-projection" }>> {
	return vmRegions(definition).filter(
		(region): region is Extract<VmRegion, { kind: "regexp-exec-projection" }> =>
			region.kind === "regexp-exec-projection",
	);
}

describe("Core region property placement", () => {
	it("certifies opposite placements for two equally adjacent property calls", () => {
		const core = lockedCore(OPPOSITE_PLACEMENTS, "placement-opposites.js");
		const placements = coreRegions(core)
			.filter(({ kind }) => kind === "regexp-exec-projection")
			.map((region) => ({
				placement: (region.data as { propertyPlacement?: string }).propertyPlacement,
				locked: (region.data as { lockedLiteral?: unknown }).lockedLiteral !== undefined,
			}));
		expect(placements).toHaveLength(2);
		expect(new Set(placements.map(({ placement }) => placement))).toEqual(
			new Set(["in-place", "call-fallback"]),
		);
		// The deferred one is the locked fresh literal, not the closer one.
		expect(placements.find(({ locked }) => locked)?.placement).toBe("call-fallback");
		expect(placements.find(({ locked }) => !locked)?.placement).toBe("in-place");

		const definition = lockedDefinition(OPPOSITE_PLACEMENTS, "placement-opposites.js");
		const projections = regexpProjections(definition);
		expect(projections).toHaveLength(2);
		for (const projection of projections) {
			const functionIndex = definition.nativePlan.functions.findIndex((candidate) =>
				candidate.specializations.includes(projection),
			);
			const fn = definition.functions[functionIndex]!;
			// Both sites emit the load immediately before its call, so adjacency cannot
			// be what separates them.
			expect(projection.propertyIp + 1).toBe(projection.callIp);
			expect(fn.instructions[projection.propertyIp]?.opcode).toBe("LOAD_PROPERTY_STATIC");
		}
		expect(
			projections.map(({ propertyPlacement, lockedFreshLiteral }) => ({
				propertyPlacement,
				lockedFreshLiteral,
			})),
		).toEqual(
			expect.arrayContaining([
				{ propertyPlacement: "call-fallback", lockedFreshLiteral: true },
				{ propertyPlacement: "in-place", lockedFreshLiteral: false },
			]),
		);
	});

	it("keeps placement and eligibility stable when source positions move", () => {
		const shifted = `// leading comment\n\n\n${OPPOSITE_PLACEMENTS.split("\n").join("\n\n")}\n`;
		const baseline = lockedCore(OPPOSITE_PLACEMENTS, "placement-positions.js");
		const perturbed = lockedCore(shifted, "placement-positions-shifted.js");
		expect(perturbed.sourcePositions).not.toEqual(baseline.sourcePositions);
		expect(corePlacements(perturbed)).toEqual(corePlacements(baseline));
		expect(
			coreRegions(perturbed)
				.map(({ kind }) => kind)
				.sort(),
		).toEqual(
			coreRegions(baseline)
				.map(({ kind }) => kind)
				.sort(),
		);

		expect(
			semanticRegionShape(lockedDefinition(shifted, "placement-positions-shifted.js")),
		).toEqual(
			semanticRegionShape(
				lockedDefinition(OPPOSITE_PLACEMENTS, "placement-positions.js"),
			),
		);
	});

	it("selects the same regions and placements with and without register reuse", () => {
		for (const source of [OPPOSITE_PLACEMENTS, SPLIT_AND_SLICE]) {
			const core = lockedCore(source, "placement-register-reuse.js");
			const reused = lowerExecutionToProgramImage(
				lowerCoreCompilationToExecution(coreCompilationForTest(core), {
					reuseRegisters: true,
				}),
			);
			const distinct = lowerExecutionToProgramImage(
				lowerCoreCompilationToExecution(coreCompilationForTest(core), {
					reuseRegisters: false,
				}),
			);
			expect(distinct.functions.map(({ registerCount }) => registerCount)).not.toEqual(
				reused.functions.map(({ registerCount }) => registerCount),
			);
			expect(semanticRegionShape(distinct)).toEqual(semanticRegionShape(reused));
			expect(vmRegions(distinct)).toHaveLength(vmRegions(reused).length);
		}
	});

	it("keeps placement and eligibility across a semantically empty forwarding block", () => {
		// Empty branch arms contribute blocks that only jump on. Core folds them, so
		// neither region selection nor placement may notice the changed layout.
		const baseline = lockedCore(FORWARDED_SPLIT_AND_SLICE.plain, "placement-layout.js");
		const perturbed = lockedCore(
			FORWARDED_SPLIT_AND_SLICE.forwarded,
			"placement-layout-forwarded.js",
		);
		expect(
			perturbed.functions.some(({ blocks }) =>
				blocks.some(({ terminator }) => terminator.kind === "branch"),
			),
		).toBe(false);
		expect(emptyForwardingBlocks(perturbed)).toEqual([]);
		expect(corePlacements(perturbed)).toEqual(corePlacements(baseline));
		expect(
			semanticRegionShape(
				lockedDefinition(
					FORWARDED_SPLIT_AND_SLICE.forwarded,
					"placement-layout-forwarded.js",
				),
			),
		).toEqual(
			semanticRegionShape(
				lockedDefinition(FORWARDED_SPLIT_AND_SLICE.plain, "placement-layout.js"),
			),
		);
	});

	it("rejects an invalid placement value in a Core certificate", () => {
		const core = lockedCore(SPLIT_AND_SLICE, "placement-invalid.js");
		const functionIndex = core.functions.findIndex(({ regions }) =>
			regions.some(
				(region) =>
					(region.data as { propertyPlacement?: unknown }).propertyPlacement !==
					undefined,
			),
		);
		const owner = core.functions[functionIndex]!;
		const regionIndex = owner.regions.findIndex(
			(region) =>
				(region.data as { propertyPlacement?: unknown }).propertyPlacement !== undefined,
		);
		const region = owner.regions[regionIndex]!;
		const tampered: CoreProgram = {
			...core,
			functions: core.functions.with(functionIndex, {
				...owner,
				regions: owner.regions.with(regionIndex, {
					...region,
					data: { ...region.data, propertyPlacement: "wherever" },
				}),
			}),
		};
		expect(() => verifyCoreProgram(tampered, coreOpcodeRegistry)).toThrow(
			/invalid property placement wherever/,
		);
	});

	it("rejects a deferred placement whose producer is not the call's only consumer", () => {
		const core = lockedCore(SPLIT_AND_SLICE, "placement-consumer.js");
		const { program, functionIndex, regionIndex } = findPlacementRegion(core, () => true);
		const region = program.functions[functionIndex]!.regions[regionIndex]!;
		expect(region.anchors.length).toBeGreaterThan(1);
		// Point the certificate's call anchor at another claimed instruction. The
		// producer still has one consumer, but it is no longer the anchor's callee.
		const tampered = withRegion(program, functionIndex, regionIndex, {
			...region,
			anchors: [region.anchors[1]!, region.anchors[0]!, ...region.anchors.slice(2)],
			data: { ...region.data, propertyPlacement: "call-fallback" },
		});
		expect(() => verifyCoreProgram(tampered, coreOpcodeRegistry)).toThrow(
			/is not consumed only as the callee of|defers @\d+ across the block/,
		);
	});

	it("rejects a deferred placement without a locked identity at the target boundary", () => {
		const core = lockedCore(OPPOSITE_PLACEMENTS, "placement-unlocked.js");
		const { program, functionIndex, regionIndex } = findPlacementRegion(
			core,
			(region) =>
				region.kind === "regexp-exec-projection" &&
				(region.data as { propertyPlacement?: unknown }).propertyPlacement === "in-place",
		);
		const region = program.functions[functionIndex]!.regions[regionIndex]!;
		const tampered = withRegion(program, functionIndex, regionIndex, {
			...region,
			data: { ...region.data, propertyPlacement: "call-fallback" },
		});
		// Core's graph still satisfies the placement's structural half; the open
		// receiver's missing locked identity is caught where the license is consumed.
		expect(() => verifyCoreProgram(tampered, coreOpcodeRegistry)).not.toThrow();
		expect(() =>
			lowerExecutionToProgramImage(
				lowerCoreCompilationToExecution(coreCompilationForTest(tampered)),
			),
		).toThrow(/regexp-exec-projection/);
	});

	it("round-trips placement through the wire form and rejects an invalid tag", () => {
		const definition = lockedDefinition(SPLIT_AND_SLICE, "placement-wire.js");
		const placements = vmRegions(definition).map(
			(region) => (region as { propertyPlacement?: string }).propertyPlacement,
		);
		expect(placements).toContain("call-fallback");
		const bytes = serializeCompilerArtifact(definition, { debugInfo: false });
		const cached = deserializeCompilerArtifact(bytes);
		expect(
			vmRegions(cached).map(
				(region) => (region as { propertyPlacement?: string }).propertyPlacement,
			),
		).toEqual(placements);
		expect(vmRegions(cached)).toEqual(vmRegions(definition));

		const { functionIndex, regionIndex } = findVmSliceRegion(definition);
		const region =
			definition.nativePlan.functions[functionIndex]!.specializations[regionIndex]!;
		if (region.kind !== "string-slice-number") throw new Error("missing fusion region");
		const asInPlace = serializeCompilerArtifact(
			withVmRegion(definition, functionIndex, regionIndex, {
				...region,
				propertyPlacement: "in-place",
			}),
			{ debugInfo: false },
		);
		// The only byte that moves when the placement flips is the placement tag, so
		// this locates it without hard-coding the payload layout.
		const differing = [...bytes].flatMap((byte, index) =>
			byte === asInPlace[index] ? [] : [index],
		);
		expect(differing).toHaveLength(1);
		const corrupted = Uint8Array.from(bytes);
		corrupted[differing[0]!] = 2;
		expect(() => deserializeCompilerArtifact(corrupted)).toThrow(
			/invalid region property placement/,
		);

		expect(() =>
			serializeCompilerArtifact(
				withVmRegion(definition, functionIndex, regionIndex, {
					...region,
					propertyPlacement: "everywhere" as unknown as typeof region.propertyPlacement,
				}),
			),
		).toThrow(/invalid String\.slice Number region|invalid region property placement/);
	});
});

function findPlacementRegion(
	program: CoreProgram,
	predicate: (region: CoreRegion) => boolean,
): { program: CoreProgram; functionIndex: number; regionIndex: number } {
	const carries = (region: CoreRegion) =>
		(region.data as { propertyPlacement?: unknown }).propertyPlacement !== undefined &&
		predicate(region);
	const functionIndex = program.functions.findIndex(({ regions }) =>
		regions.some(carries),
	);
	if (functionIndex < 0) throw new Error("no placement-carrying region");
	const regionIndex = program.functions[functionIndex]!.regions.findIndex(carries);
	return { program, functionIndex, regionIndex };
}

function withRegion(
	program: CoreProgram,
	functionIndex: number,
	regionIndex: number,
	region: CoreRegion,
): CoreProgram {
	const owner = program.functions[functionIndex]!;
	return {
		...program,
		functions: program.functions.with(functionIndex, {
			...owner,
			regions: owner.regions.with(regionIndex, region),
		}),
	};
}

function findVmSliceRegion(definition: ProgramImage): {
	functionIndex: number;
	regionIndex: number;
} {
	const functionIndex = definition.nativePlan.functions.findIndex((fn) =>
		fn.specializations.some((region) => region.kind === "string-slice-number"),
	);
	if (functionIndex < 0) throw new Error("no string-slice-number region");
	return {
		functionIndex,
		regionIndex: definition.nativePlan.functions[
			functionIndex
		]!.specializations.findIndex((region) => region.kind === "string-slice-number"),
	};
}

function withVmRegion(
	definition: ProgramImage,
	functionIndex: number,
	regionIndex: number,
	region: VmRegion,
): ProgramImage {
	const owner = definition.nativePlan.functions[functionIndex]!;
	return {
		...definition,
		nativePlan: {
			functions: definition.nativePlan.functions.with(functionIndex, {
				...owner,
				specializations: owner.specializations.with(regionIndex, region),
			}),
		},
	};
}
