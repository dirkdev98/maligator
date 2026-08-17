import { compilerGuardPlan, knownBuiltinCallProves } from "./compiler-facts.ts";
import { decodeStringConstant } from "./inline.ts";
import {
	buildIRExceptionHandlers,
	buildIROrdinaryControlFlow,
	irInstructionDominates,
} from "./ir-control-flow.ts";
import { buildIRRegisterIndex } from "./ir-register-index.ts";
import type {
	IntermediateProgram,
	IRInstruction,
	IRStringSliceNumberRegion,
} from "./ir.ts";

const MAX_REGIONS = 8;

function isLoweringMarker(instruction: IRInstruction): boolean {
	return (
		instruction.type === "sourcePos" ||
		instruction.type === "tryBegin" ||
		instruction.type === "tryEnd"
	);
}

/**
 * Select exact slice-to-Number fusions while final IR still owns canonical
 * identity, def/use, block, and exception-scope information. Selection is
 * deliberately stricter than the old post-wire adjacency scan: the slice
 * property result and sliced String must each have exactly their expected use.
 */
export function annotateStringSliceNumberRegions(program: IntermediateProgram): number {
	let count = 0;
	for (const fn of program.functions) {
		const retained = (fn.regions ?? []).filter(
			(region) => region.kind !== "string-slice-number",
		);
		fn.regions = retained.length > 0 ? retained : undefined;
		if (retained.length >= MAX_REGIONS) continue;
		const occupied = new Set(
			retained.flatMap((region) => [...region.claimedInstructions]),
		);
		const index = buildIRRegisterIndex(fn, { locations: true });
		const definitions = index.uniqueDefinitions;
		const locations = index.locations!;
		const cfg = buildIROrdinaryControlFlow(fn);
		const exceptionHandlers = buildIRExceptionHandlers(fn);
		const uses = (register: number) => index.uses.get(register) ?? [];

		for (let blockIndex = 0; blockIndex < fn.blocks.length; blockIndex++) {
			const block = fn.blocks[blockIndex]!;
			const runtimeInstructions = block.instructions.filter(
				(instruction) => !isLoweringMarker(instruction),
			);
			for (
				let runtimeIndex = 1;
				runtimeIndex + 1 < runtimeInstructions.length;
				runtimeIndex++
			) {
				if ((fn.regions?.length ?? 0) >= MAX_REGIONS) break;
				const property = runtimeInstructions[runtimeIndex - 1]!;
				const sliceCall = runtimeInstructions[runtimeIndex]!;
				const numberCall = runtimeInstructions[runtimeIndex + 1]!;
				if (
					property.type !== "loadPropertyStatic" ||
					decodeStringConstant(program, property.stringIndex) !== "slice" ||
					sliceCall.type !== "call" ||
					sliceCall.registers.length !== 4 ||
					!knownBuiltinCallProves(sliceCall.knownBuiltinCall, "String.prototype.slice") ||
					property.registers[0] !== sliceCall.registers[1] ||
					property.registers[1] !== sliceCall.registers[2] ||
					numberCall.type !== "call" ||
					numberCall.registers.length !== 4 ||
					numberCall.registers[3] !== sliceCall.registers[0]
				) {
					continue;
				}
				const sliceFact = sliceCall.knownBuiltinCall!;
				if (
					sliceFact.semantics.kind !== "known" ||
					!sliceFact.semantics.value.lowerings.includes("number-consumer-fusion") ||
					sliceFact.semantics.value.result !== "string"
				) {
					continue;
				}
				const numberIntrinsic = definitions.get(numberCall.registers[1]);
				if (
					numberIntrinsic?.type !== "loadIntrinsic" ||
					numberIntrinsic.intrinsic !== "Number" ||
					definitions.get(sliceCall.registers[0]) !== sliceCall ||
					uses(property.registers[0]).some(
						(use) => use.instruction !== sliceCall || use.position !== 1,
					) ||
					uses(sliceCall.registers[0]).length !== 1 ||
					uses(sliceCall.registers[0])[0]?.instruction !== numberCall ||
					!irInstructionDominates(cfg, locations, property, sliceCall) ||
					!irInstructionDominates(cfg, locations, numberIntrinsic, numberCall)
				) {
					continue;
				}
				const immediateStart = sliceCall.immediateValues?.[3];
				const startDefinition = definitions.get(sliceCall.registers[3]!);
				const sliceStart =
					immediateStart?.kind === "number"
						? immediateStart.value
						: startDefinition?.type === "createNumber" ||
							  startDefinition?.type === "createF64"
							? startDefinition.value
							: undefined;
				if (sliceStart === undefined || !Number.isFinite(sliceStart)) continue;

				const guard = compilerGuardPlan(
					[sliceFact.identity, sliceFact.semantics],
					[
						{
							kind: "fallback",
							id: `string-slice-number:${sliceFact.sourceSite ?? fn.functionIndex}`,
						},
					],
				);
				if (
					guard === undefined ||
					!guard.obligations.some((obligation) => obligation.kind === "fallback")
				) {
					continue;
				}

				const claimedInstructions = [
					property,
					sliceCall,
					numberIntrinsic,
					numberCall,
				] as const;
				if (
					new Set<IRInstruction>(claimedInstructions).size !==
						claimedInstructions.length ||
					claimedInstructions.some((instruction) => occupied.has(instruction))
				) {
					continue;
				}
				const ordinaryBlocks = [
					...new Set(
						claimedInstructions.map(
							(instruction) => locations.get(instruction)!.blockIndex,
						),
					),
				].sort((left, right) => left - right);
				const exceptionalBlocks = [
					...new Set(
						claimedInstructions.flatMap((instruction) => {
							const location = locations.get(instruction)!;
							const handler =
								exceptionHandlers[location.blockIndex]?.[location.instructionIndex] ??
								null;
							return handler === null ? [] : [handler];
						}),
					),
				].sort((left, right) => left - right);
				if (exceptionalBlocks.some((handler) => ordinaryBlocks.includes(handler)))
					continue;

				const region: IRStringSliceNumberRegion = {
					kind: "string-slice-number",
					license: { guard, genericTwin: "retained", materialization: "none" },
					representation: "primitive-string-span-number",
					anchors: [sliceCall, numberCall],
					claimedInstructions,
					controlFlow: { ordinaryBlocks, exceptionalBlocks },
					cost: { score: 16, metadataOperations: claimedInstructions.length },
					property,
					numberIntrinsic,
					numberCall,
					sliceStart,
				};
				fn.regions = [...(fn.regions ?? []), region];
				for (const instruction of claimedInstructions) occupied.add(instruction);
				count++;
			}
		}
	}
	return count;
}
