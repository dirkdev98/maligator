import { compilerGuardPlan, knownBuiltinCallProves } from "./compiler-facts.ts";
import type { CompilerGuardPlan } from "./compiler-facts.ts";
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
	IRRegExpExecProjectionRegion,
	IRRegExpIteratorProjectionRegion,
} from "./ir.ts";

const MAX_REGIONS = 8;

function guardIsWorldInvariant(guard: CompilerGuardPlan): boolean {
	return (
		guard.dependencies.length > 0 &&
		guard.dependencies.every((dependency) => dependency.kind === "world") &&
		guard.obligations.some((obligation) => obligation.kind === "fallback")
	);
}

/**
 * Select closed RegExp.exec capture projections while final IR still carries
 * canonical builtin facts, def/use identity, and block dominance. The retained
 * call owns input coercion, null results, `lastIndex`, and every guard miss.
 */
export function annotateRegExpExecProjectionRegions(
	program: IntermediateProgram,
): number {
	let count = 0;
	for (const fn of program.functions) {
		const retained = (fn.regions ?? []).filter(
			(region) => region.kind !== "regexp-exec-projection",
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
		const onlyUsedBy = (register: number, allowed: ReadonlySet<IRInstruction>): boolean =>
			uses(register).every(({ instruction }) => allowed.has(instruction));
		const staticName = (
			instruction: IRInstruction | undefined,
			name: string,
		): instruction is Extract<IRInstruction, { type: "loadPropertyStatic" }> =>
			instruction?.type === "loadPropertyStatic" &&
			decodeStringConstant(program, instruction.stringIndex) === name;
		const exactZeroArgumentCall = (
			instruction: IRInstruction | undefined,
			callee: number,
			thisValue: number,
		): instruction is Extract<IRInstruction, { type: "call" }> =>
			instruction?.type === "call" &&
			instruction.registers.length === 3 &&
			instruction.registers[1] === callee &&
			instruction.registers[2] === thisValue;

		for (const block of fn.blocks) {
			for (const call of block.instructions) {
				if ((fn.regions?.length ?? 0) >= MAX_REGIONS) break;
				if (
					call.type !== "call" ||
					call.registers.length !== 4 ||
					!knownBuiltinCallProves(call.knownBuiltinCall, "RegExp.prototype.exec")
				) {
					continue;
				}
				const callFact = call.knownBuiltinCall;
				if (
					callFact?.semantics.kind !== "known" ||
					!callFact.semantics.value.lowerings.includes("capture-projection") ||
					callFact.semantics.value.result !== "regexp-match-or-null"
				) {
					continue;
				}
				const property = definitions.get(call.registers[1]);
				if (
					!staticName(property, "exec") ||
					property.registers[1] !== call.registers[2] ||
					!irInstructionDominates(cfg, locations, property, call)
				) {
					continue;
				}

				const aliases = new Set<number>([call.registers[0]]);
				const pendingAliases = [call.registers[0]];
				const aliasMoves: Array<Extract<IRInstruction, { type: "move" }>> = [];
				const nullChecks: Array<IRRegExpExecProjectionRegion["nullChecks"][number]> = [];
				const loads: Array<IRRegExpExecProjectionRegion["loads"][number]> = [];
				const captureIndices = new Set<number>();
				let safe = true;
				while (pendingAliases.length > 0 && safe) {
					const alias = pendingAliases.pop()!;
					for (const use of uses(alias)) {
						const consumer = use.instruction;
						if (
							consumer.type === "move" &&
							use.position === 1 &&
							definitions.get(consumer.registers[0]) === consumer
						) {
							if (!aliases.has(consumer.registers[0])) {
								aliases.add(consumer.registers[0]);
								pendingAliases.push(consumer.registers[0]);
								aliasMoves.push(consumer);
							}
							continue;
						}
						if (
							consumer.type === "binary" &&
							(consumer.operator === "===" || consumer.operator === "!==")
						) {
							const other =
								consumer.registers[1] === alias
									? consumer.registers[2]
									: consumer.registers[1];
							const nullValue = definitions.get(other);
							if (
								nullValue?.type !== "createNull" ||
								!irInstructionDominates(cfg, locations, nullValue, consumer)
							) {
								safe = false;
								break;
							}
							nullChecks.push({ comparison: consumer, nullValue });
							continue;
						}
						if (consumer.type === "loadProperty" && use.position === 1) {
							const key = definitions.get(consumer.registers[2]);
							if (
								key?.type !== "createNumber" ||
								!Number.isInteger(key.value) ||
								key.value <= 0 ||
								key.value > 0xffff ||
								captureIndices.has(key.value) ||
								!irInstructionDominates(cfg, locations, call, consumer) ||
								!irInstructionDominates(cfg, locations, key, consumer)
							) {
								safe = false;
								break;
							}
							captureIndices.add(key.value);
							loads.push({ instruction: consumer, key, captureIndex: key.value });
							continue;
						}
						safe = false;
						break;
					}
				}
				if (!safe || aliasMoves.length === 0 || loads.length === 0 || loads.length > 8) {
					continue;
				}

				for (let loadIndex = 0; loadIndex < loads.length && safe; loadIndex++) {
					const load = loads[loadIndex]!;
					const capture = load.instruction.registers[0];
					const captureUses = uses(capture);
					if (captureUses.length === 0) continue;
					if (captureUses.length === 1) {
						const consumer = captureUses[0]!.instruction;
						if (staticName(consumer, "length") && consumer.registers[1] === capture) {
							loads[loadIndex] = {
								...load,
								consumer: { kind: "length", property: consumer },
							};
							continue;
						}
						if (
							consumer.type === "call" &&
							consumer.registers.length === 4 &&
							consumer.registers[3] === capture
						) {
							const intrinsic = definitions.get(consumer.registers[1]);
							if (
								intrinsic?.type === "loadIntrinsic" &&
								intrinsic.intrinsic === "Number"
							) {
								loads[loadIndex] = {
									...load,
									consumer: { kind: "number", intrinsic, call: consumer },
								};
								continue;
							}
						}
					}

					const propertyUses = captureUses.filter(
						(use) => use.position === 1 && use.instruction.type === "loadPropertyStatic",
					);
					const thisUses = captureUses.filter(
						(use) => use.position === 2 && use.instruction.type === "call",
					);
					const charProperty = propertyUses.find(({ instruction }) =>
						staticName(instruction, "charCodeAt"),
					)?.instruction;
					const charCall = thisUses.find(
						({ instruction }) =>
							instruction.type === "call" &&
							charProperty?.type === "loadPropertyStatic" &&
							instruction.registers[1] === charProperty.registers[0],
					)?.instruction;
					if (
						charProperty?.type === "loadPropertyStatic" &&
						charCall?.type === "call" &&
						captureUses.length === 2 &&
						charCall.registers.length === 4 &&
						onlyUsedBy(charProperty.registers[0], new Set([charCall]))
					) {
						const immediateZero = charCall.immediateValues?.[3];
						const zero = definitions.get(charCall.registers[3]!);
						if (
							(immediateZero?.kind === "number" && Object.is(immediateZero.value, 0)) ||
							(zero?.type === "createNumber" && Object.is(zero.value, 0))
						) {
							loads[loadIndex] = {
								...load,
								consumer: {
									kind: "charCodeAtZero",
									property: charProperty,
									call: charCall,
									...(zero?.type === "createNumber" ? { zero } : {}),
								},
							};
							continue;
						}
					}

					const upperProperty = propertyUses.find(({ instruction }) =>
						staticName(instruction, "toUpperCase"),
					)?.instruction;
					const upperCall = thisUses.find(
						({ instruction }) =>
							instruction.type === "call" &&
							upperProperty?.type === "loadPropertyStatic" &&
							instruction.registers[1] === upperProperty.registers[0],
					)?.instruction;
					if (
						upperProperty?.type !== "loadPropertyStatic" ||
						upperCall?.type !== "call" ||
						captureUses.length !== 2 ||
						!exactZeroArgumentCall(upperCall, upperProperty.registers[0], capture) ||
						!onlyUsedBy(upperProperty.registers[0], new Set([upperCall]))
					) {
						continue;
					}
					const upperResultUses = uses(upperCall.registers[0]);
					const lowerProperty = upperResultUses.find(
						({ instruction, position }) =>
							position === 1 && staticName(instruction, "toLowerCase"),
					)?.instruction;
					const lowerCall = upperResultUses.find(
						({ instruction, position }) =>
							position === 2 &&
							instruction.type === "call" &&
							lowerProperty?.type === "loadPropertyStatic" &&
							instruction.registers[1] === lowerProperty.registers[0],
					)?.instruction;
					if (
						lowerProperty?.type !== "loadPropertyStatic" ||
						lowerCall?.type !== "call" ||
						upperResultUses.length !== 2 ||
						!exactZeroArgumentCall(
							lowerCall,
							lowerProperty.registers[0],
							upperCall.registers[0],
						) ||
						!onlyUsedBy(lowerProperty.registers[0], new Set([lowerCall]))
					) {
						continue;
					}
					const resultMoves: Array<Extract<IRInstruction, { type: "move" }>> = [];
					let result = lowerCall.registers[0];
					let lengthProperty:
						| Extract<IRInstruction, { type: "loadPropertyStatic" }>
						| undefined;
					const seenResults = new Set<number>();
					while (!seenResults.has(result)) {
						seenResults.add(result);
						const resultUses = uses(result);
						if (resultUses.length !== 1) break;
						const resultUse = resultUses[0]!;
						if (resultUse.position === 1 && staticName(resultUse.instruction, "length")) {
							lengthProperty = resultUse.instruction;
							break;
						}
						if (
							resultUse.position !== 1 ||
							resultUse.instruction.type !== "move" ||
							definitions.get(resultUse.instruction.registers[0]) !==
								resultUse.instruction
						) {
							break;
						}
						resultMoves.push(resultUse.instruction);
						result = resultUse.instruction.registers[0];
					}
					if (lengthProperty === undefined) {
						continue;
					}
					loads[loadIndex] = {
						...load,
						consumer: {
							kind: "asciiCaseLength",
							upperProperty,
							upperCall,
							lowerProperty,
							lowerCall,
							resultMoves,
							lengthProperty,
						},
					};
				}
				if (!safe) continue;

				const guard = compilerGuardPlan(
					[callFact.identity, callFact.semantics],
					[
						{
							kind: "materialize",
							id: `regexp-exec-projection:${callFact.sourceSite ?? fn.functionIndex}`,
						},
					],
				);
				if (
					guard === undefined ||
					!guard.obligations.some((obligation) => obligation.kind === "fallback")
				) {
					continue;
				}

				let lockedLiteral: IRRegExpExecProjectionRegion["lockedLiteral"];
				const construct = definitions.get(call.registers[2]);
				if (
					guardIsWorldInvariant(guard) &&
					construct?.type === "construct" &&
					construct.registers.length === 4 &&
					onlyUsedBy(construct.registers[0], new Set([property, call]))
				) {
					const constructorIntrinsic = definitions.get(construct.registers[1]);
					if (
						constructorIntrinsic?.type === "loadIntrinsic" &&
						constructorIntrinsic.intrinsic === "RegExp" &&
						irInstructionDominates(cfg, locations, constructorIntrinsic, construct) &&
						irInstructionDominates(cfg, locations, construct, call)
					) {
						lockedLiteral = { constructorIntrinsic, construct };
					}
				}

				const claimed = new Set<IRInstruction>([property, call]);
				for (const move of aliasMoves) claimed.add(move);
				for (const nullCheck of nullChecks) {
					claimed.add(nullCheck.nullValue);
					claimed.add(nullCheck.comparison);
				}
				for (const load of loads) {
					claimed.add(load.key);
					claimed.add(load.instruction);
					const consumer = load.consumer;
					if (consumer?.kind === "length") claimed.add(consumer.property);
					else if (consumer?.kind === "charCodeAtZero") {
						claimed.add(consumer.property);
						claimed.add(consumer.call);
						if (consumer.zero !== undefined) claimed.add(consumer.zero);
					} else if (consumer?.kind === "number") {
						claimed.add(consumer.intrinsic);
						claimed.add(consumer.call);
					} else if (consumer?.kind === "asciiCaseLength") {
						claimed.add(consumer.upperProperty);
						claimed.add(consumer.upperCall);
						claimed.add(consumer.lowerProperty);
						claimed.add(consumer.lowerCall);
						for (const move of consumer.resultMoves) claimed.add(move);
						claimed.add(consumer.lengthProperty);
					}
				}
				if (lockedLiteral !== undefined) {
					claimed.add(lockedLiteral.constructorIntrinsic);
					claimed.add(lockedLiteral.construct);
				}
				const claimedInstructions = [...claimed];
				if (
					claimedInstructions.length > 96 ||
					claimedInstructions.some((candidate) => {
						const location = locations.get(candidate);
						return (
							occupied.has(candidate) ||
							location === undefined ||
							(exceptionHandlers[location.blockIndex]?.[location.instructionIndex] ??
								null) !== null
						);
					})
				) {
					continue;
				}
				const ordinaryBlocks = [
					...new Set(
						claimedInstructions.map((candidate) => locations.get(candidate)!.blockIndex),
					),
				].sort((left, right) => left - right);
				const region: IRRegExpExecProjectionRegion = {
					kind: "regexp-exec-projection",
					license: { guard, genericTwin: "retained", materialization: "whole-region" },
					representation: "regexp-capture-spans",
					anchors: [call, aliasMoves[0]!, loads[0]!.instruction],
					claimedInstructions,
					controlFlow: { ordinaryBlocks, exceptionalBlocks: [] },
					cost: {
						score: loads.length * 12 + nullChecks.length * 2,
						metadataOperations: claimedInstructions.length,
					},
					property,
					aliasMoves,
					nullChecks,
					...(lockedLiteral === undefined ? {} : { lockedLiteral }),
					lastIndexEffect: "retained-call-twin",
					loads,
				};
				fn.regions = [...(fn.regions ?? []), region];
				for (const candidate of claimedInstructions) occupied.add(candidate);
				count++;
			}
		}
	}
	return count;
}

/**
 * Keep disposable RegExp String Iterator matches virtual when every value use is
 * a constant capture passed directly to Number. The exact runtime helper owns
 * brand/next/Realm/RegExp validation and the ordinary iterator step remains the
 * on-demand materialization path.
 */
export function annotateRegExpIteratorProjectionRegions(
	program: IntermediateProgram,
): number {
	let count = 0;
	for (const fn of program.functions) {
		const retained = (fn.regions ?? []).filter(
			(region) => region.kind !== "regexp-iterator-projection",
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

		for (const block of fn.blocks) {
			for (
				let instructionIndex = 0;
				instructionIndex < block.instructions.length;
				instructionIndex++
			) {
				if ((fn.regions?.length ?? 0) >= MAX_REGIONS) break;
				const step = block.instructions[instructionIndex]!;
				const doneBranch = block.instructions[instructionIndex + 1];
				if (
					step.type !== "iteratorStep" ||
					doneBranch?.type !== "jumpIf" ||
					doneBranch.registers[0] !== step.registers[1] ||
					doneBranch.blocks.length !== 1
				) {
					continue;
				}
				const exitBlock = doneBranch.blocks[0];
				if (
					exitBlock < 0 ||
					exitBlock >= fn.blocks.length ||
					exitBlock === locations.get(step)?.blockIndex ||
					!cfg.reachable.has(exitBlock)
				) {
					continue;
				}

				const aliases = new Set<number>([step.registers[0]]);
				const pendingAliases = [step.registers[0]];
				const aliasMoves: Array<Extract<IRInstruction, { type: "move" }>> = [];
				const loads: Array<IRRegExpIteratorProjectionRegion["loads"][number]> = [];
				const captureIndices = new Set<number>();
				let safe = true;
				while (pendingAliases.length > 0 && safe) {
					const alias = pendingAliases.pop()!;
					for (const use of uses(alias)) {
						const consumer = use.instruction;
						if (
							consumer.type === "move" &&
							use.position === 1 &&
							definitions.get(consumer.registers[0]) === consumer
						) {
							if (!aliases.has(consumer.registers[0])) {
								aliases.add(consumer.registers[0]);
								pendingAliases.push(consumer.registers[0]);
								aliasMoves.push(consumer);
							}
							continue;
						}
						if (consumer.type !== "loadProperty" || use.position !== 1) {
							safe = false;
							break;
						}
						const key = definitions.get(consumer.registers[2]);
						const captureUses = index.uses.get(consumer.registers[0]) ?? [];
						const numberUse = captureUses[0];
						const numberCall = numberUse?.instruction;
						const numberIntrinsic =
							numberCall?.type === "call"
								? definitions.get(numberCall.registers[1])
								: undefined;
						if (
							key?.type !== "createNumber" ||
							!Number.isInteger(key.value) ||
							key.value <= 0 ||
							key.value > 0xffff ||
							captureIndices.has(key.value) ||
							captureUses.length !== 1 ||
							numberUse?.position !== 3 ||
							numberCall?.type !== "call" ||
							numberCall.registers.length !== 4 ||
							numberCall.registers[3] !== consumer.registers[0] ||
							numberIntrinsic?.type !== "loadIntrinsic" ||
							numberIntrinsic.intrinsic !== "Number" ||
							!irInstructionDominates(cfg, locations, step, consumer) ||
							!irInstructionDominates(cfg, locations, key, consumer) ||
							!irInstructionDominates(cfg, locations, numberIntrinsic, numberCall)
						) {
							safe = false;
							break;
						}
						captureIndices.add(key.value);
						loads.push({
							instruction: consumer,
							key,
							captureIndex: key.value,
							numberIntrinsic,
							numberCall,
						});
					}
				}
				if (!safe || loads.length === 0 || loads.length > 8) continue;

				const guard = compilerGuardPlan(
					[program.facts.protectors.get("watched-methods")],
					[
						{
							kind: "fallback",
							id: `regexp-iterator-projection:${fn.functionIndex}:${instructionIndex}`,
						},
						{
							kind: "materialize",
							id: `regexp-iterator-projection:${fn.functionIndex}:${instructionIndex}`,
						},
					],
				);
				if (
					guard === undefined ||
					!guard.obligations.some((obligation) => obligation.kind === "fallback")
				) {
					continue;
				}
				const claimed = new Set<IRInstruction>([step, doneBranch]);
				for (const move of aliasMoves) claimed.add(move);
				for (const load of loads) {
					claimed.add(load.key);
					claimed.add(load.instruction);
					claimed.add(load.numberIntrinsic);
					claimed.add(load.numberCall);
				}
				const claimedInstructions = [...claimed];
				if (
					claimedInstructions.length > 96 ||
					claimedInstructions.some(
						(candidate) =>
							occupied.has(candidate) || locations.get(candidate) === undefined,
					)
				) {
					continue;
				}
				const ordinaryBlocks = [
					...new Set(
						claimedInstructions.map((candidate) => locations.get(candidate)!.blockIndex),
					),
				].sort((left, right) => left - right);
				const exceptionalBlocks = [
					...new Set(
						claimedInstructions.flatMap((candidate) => {
							const location = locations.get(candidate)!;
							const handler =
								exceptionHandlers[location.blockIndex]?.[location.instructionIndex] ??
								null;
							return handler === null ? [] : [handler];
						}),
					),
				].sort((left, right) => left - right);
				if (exceptionalBlocks.some((handler) => ordinaryBlocks.includes(handler)))
					continue;
				const region: IRRegExpIteratorProjectionRegion = {
					kind: "regexp-iterator-projection",
					license: { guard, genericTwin: "retained", materialization: "on-demand" },
					representation: "regexp-iterator-capture-spans",
					anchors: [step, doneBranch, loads[0]!.instruction],
					claimedInstructions,
					controlFlow: { ordinaryBlocks, exceptionalBlocks },
					cost: {
						score: loads.length * 16,
						metadataOperations: claimedInstructions.length,
					},
					doneBranch,
					exitBlock,
					aliasMoves,
					statefulEffect: "iterator-last-index-retained-step",
					runtimeGuard: "exact-brand-next-realm-regexp",
					loads,
				};
				fn.regions = [...(fn.regions ?? []), region];
				for (const candidate of claimedInstructions) occupied.add(candidate);
				count++;
			}
		}
	}
	return count;
}
