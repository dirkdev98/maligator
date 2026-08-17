import { rebaseVmValueOperand } from "../lower-vm.ts";
import type { VmDefinition, VmInstruction, VmRegion } from "../lower-vm.ts";

export interface MergedVmDefinition {
	definition: VmDefinition;
	functionBases: Array<number>;
}

interface RebaseBases {
	function: number;
	global: number;
	string: number;
	bigint: number;
	template: number;
	file: number;
	position: number;
}

function assertNever(value: never): never {
	throw new Error(
		`Unsupported VM opcode ${(value as { opcode?: string }).opcode ?? "<missing>"}`,
	);
}

function shifted(index: number, base: number): number {
	return index < 0 ? index : index + base;
}

function cloneRegionEnvelope<T extends VmRegion>(region: T): T {
	return {
		...region,
		license: {
			...region.license,
			guard: {
				dependencies: region.license.guard.dependencies.map((dependency) => ({
					...dependency,
				})),
				obligations: [...region.license.guard.obligations],
			},
		},
		anchors: [...region.anchors],
		claimedIps: [...region.claimedIps],
		controlFlow: {
			ordinaryBlockIps: [...region.controlFlow.ordinaryBlockIps],
			exceptionalHandlerIps: [...region.controlFlow.exceptionalHandlerIps],
		},
	};
}

function cloneRegion(region: VmRegion, base: RebaseBases): VmRegion {
	switch (region.kind) {
		case "finite-object-construction":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				numberGuards: [...region.numberGuards],
				keyStringIndices: region.keyStringIndices.map((index) => index + base.string),
				accessIps: [...region.accessIps],
			};
		case "numeric-fusion":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				pairs: region.pairs.map((pair) => ({ ...pair })),
			};
		case "exact-fresh-array":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				accessIps: [...region.accessIps],
			};
		case "closed-record-array":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				elementLoadIps: [...region.elementLoadIps],
				accesses: region.accesses.map((access) => ({ ...access })),
			};
		case "string-split-cursor":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				primitiveStringLengthIps: [...region.primitiveStringLengthIps],
			};
		case "string-split-projection":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				separatorStringIndex: region.separatorStringIndex + base.string,
				aliasMoveIps: [...region.aliasMoveIps],
				loads: region.loads.map((load) => ({ ...load })),
			};
		case "regexp-exec-projection":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				...(region.lockedLiteral === undefined
					? {}
					: { lockedLiteral: { ...region.lockedLiteral } }),
				aliasMoveIps: [...region.aliasMoveIps],
				nullChecks: region.nullChecks.map((check) => ({ ...check })),
				loads: region.loads.map((load) => ({
					...load,
					...(load.consumer === undefined
						? {}
						: {
								consumer: {
									...load.consumer,
									...(load.consumer.kind === "asciiCaseLength"
										? { resultMoveIps: [...load.consumer.resultMoveIps] }
										: {}),
								},
							}),
				})),
			};
		case "regexp-iterator-projection":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				aliasMoveIps: [...region.aliasMoveIps],
				loads: region.loads.map((load) => ({ ...load })),
			};
		case "string-slice-number":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
			};
		case "string-scan-summary":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
			};
		case "private-aggregate-memo":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				constructionPushIps: [...region.constructionPushIps],
				targetFunctionIndex: region.targetFunctionIndex + base.function,
			};
		case "invariant-json-map-template":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				targetFunctionIndex: region.targetFunctionIndex + base.function,
				captures: region.captures.map((capture) => ({
					ownerFunctionIndex: shifted(capture.ownerFunctionIndex, base.function),
					index: capture.index,
				})),
				primitiveRowStringIndices: region.primitiveRowStringIndices.map(
					(index) => index + base.string,
				),
				nestedBaseStringIndex: region.nestedBaseStringIndex + base.string,
				nestedValueStringIndex: region.nestedValueStringIndex + base.string,
				excludedStringIndices: region.excludedStringIndices.map(
					(index) => index + base.string,
				),
			};
		case "stack-object-plan":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				sites: region.sites.map((site) => ({
					...site,
					accesses: site.accesses.map((access) => ({ ...access })),
					materializations: site.materializations.map((materialization) => ({
						...materialization,
					})),
				})),
			};
		case "cardinality-array":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				accesses: region.accesses.map((access) => ({ ...access })),
			};
		case "numeric-hof":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				dispatch: { ...region.dispatch },
				callbackFunctionIndex: region.callbackFunctionIndex + base.function,
				operations: region.operations.map((operation) => ({ ...operation })),
			};
	}
}

function cloneInstruction(instruction: VmInstruction, base: RebaseBases): VmInstruction {
	switch (instruction.opcode) {
		case "CREATE_FUNCTION":
			return { ...instruction, functionIndex: instruction.functionIndex + base.function };
		case "LOAD_CAPTURED":
		case "STORE_CAPTURED":
			return {
				...instruction,
				ownerFunctionIndex: shifted(instruction.ownerFunctionIndex, base.function),
			};
		case "GUARD_FUNCTION_INDEX":
			return { ...instruction, functionIndex: instruction.functionIndex + base.function };
		case "LOAD_GLOBAL":
		case "STORE_GLOBAL":
			return { ...instruction, index: instruction.index + base.global };
		case "CREATE_STRING":
			return { ...instruction, stringIndex: instruction.stringIndex + base.string };
		case "LOAD_PROPERTY_STATIC":
		case "STORE_PROPERTY_STATIC":
			return { ...instruction, stringIndex: instruction.stringIndex + base.string };
		case "CREATE_BIGINT":
			return { ...instruction, bigintIndex: instruction.bigintIndex + base.bigint };
		case "INSTANTIATE_LITERAL_TEMPLATE":
			return {
				...instruction,
				templateOffset: instruction.templateOffset + base.template,
			};
		case "LOAD_UNDECLARED":
		case "LOAD_GLOBAL_PROPERTY":
		case "STORE_GLOBAL_PROPERTY":
		case "THROW_IF_TDZ":
		case "WITH_GET":
		case "WITH_RESOLVE_BASE":
		case "WITH_SET":
			return {
				...instruction,
				nameStringIndex: instruction.nameStringIndex + base.string,
			};
		case "INIT_GLOBAL_VARS":
			return {
				...instruction,
				nameStringIndices: instruction.nameStringIndices.map(
					(index) => index + base.string,
				),
			};
		case "CREATE_PRIVATE_NAMES":
			return {
				...instruction,
				ownerFunctionIndex: shifted(instruction.ownerFunctionIndex, base.function),
				capturedIndices: [...instruction.capturedIndices],
			};
		case "INIT_PRIVATE_FIELDS":
			return { ...instruction, keyRegisters: [...instruction.keyRegisters] };
		case "CREATE_OBJECT_SHAPED":
			return {
				...instruction,
				keyStringIndices: instruction.keyStringIndices.map(
					(index) => index + base.string,
				),
				valueRegisters: [...instruction.valueRegisters],
			};
		case "CREATE_TEMPLATE_OBJECT":
			return {
				...instruction,
				cacheSlot: instruction.cacheSlot + base.global,
				cookedIndices: instruction.cookedIndices.map((index) =>
					shifted(index, base.string),
				),
				rawIndices: instruction.rawIndices.map((index) => index + base.string),
			};
		case "CREATE_MODULE_NAMESPACE":
			return {
				...instruction,
				nameIndices: instruction.nameIndices.map((index) => index + base.string),
				slots: instruction.slots.map((index) => index + base.global),
			};
		case "CALL":
			return {
				...instruction,
				directFunctionIndex:
					instruction.directFunctionIndex === undefined
						? undefined
						: instruction.directFunctionIndex + base.function,
				directCallTargetFunctionIndex:
					instruction.directCallTargetFunctionIndex === undefined
						? undefined
						: instruction.directCallTargetFunctionIndex + base.function,
				callee: rebaseVmValueOperand(instruction.callee, base.string),
				thisValue: rebaseVmValueOperand(instruction.thisValue, base.string),
				arguments: instruction.arguments.map((operand) =>
					rebaseVmValueOperand(operand, base.string),
				),
			};
		case "CALL_BUILTIN":
			return {
				...instruction,
				thisValue: rebaseVmValueOperand(instruction.thisValue, base.string),
				arguments: instruction.arguments.map((operand) =>
					rebaseVmValueOperand(operand, base.string),
				),
			};
		case "CONSTRUCT":
			return {
				...instruction,
				directFunctionIndex:
					instruction.directFunctionIndex === undefined
						? undefined
						: instruction.directFunctionIndex + base.function,
				callee: rebaseVmValueOperand(instruction.callee, base.string),
				arguments: instruction.arguments.map((operand) =>
					rebaseVmValueOperand(operand, base.string),
				),
			};
		case "COPY_DATA_PROPERTIES":
			return { ...instruction, excluded: [...instruction.excluded] };

		// Registers, instruction pointers, literal values, intrinsic/operator ids,
		// and synthetic negative environment scope ids are definition-local values.
		case "MOVE":
		case "RETURN":
		case "JUMP_IF":
		case "JUMP":
		case "CREATE_NUMBER":
		case "CREATE_F64":
		case "CREATE_BOOLEAN":
		case "CREATE_OBJECT":
		case "CREATE_ARRAY":
		case "CREATE_UNDEFINED":
		case "CREATE_EMPTY":
		case "CREATE_NULL":
		case "CREATE_ARGUMENTS_OBJECT":
		case "LOAD_ARGUMENT_COUNT":
		case "LOAD_ARGUMENT":
		case "LOAD_STATIC_ARGUMENT":
		case "LOAD_THIS":
		case "LOAD_NEW_TARGET":
		case "LOAD_CALLEE":
		case "CALL_SPREAD":
		case "CALL_SPREAD_ITERABLE":
		case "CONSTRUCT_SPREAD":
		case "CONSTRUCT_SUPER":
		case "CONSTRUCT_SUPER_EXPLICIT":
		case "SET_THIS":
		case "THROW":
		case "CATCH":
		case "TRY_BEGIN":
		case "TRY_END":
		case "GENERATOR_START":
		case "ASYNC_START":
		case "YIELD":
		case "TERMINAL_YIELD":
		case "AWAIT":
		case "LOAD_INTRINSIC":
		case "ENV_PUSH":
		case "ENV_COPY":
		case "ENV_POP":
		case "LOAD_SUPER_PROPERTY":
		case "TO_PROPERTY_KEY":
		case "STORE_SUPER_PROPERTY":
		case "LOAD_PROTOTYPE":
		case "GET_ITERATOR":
		case "GET_ASYNC_ITERATOR":
		case "ITERATOR_NEXT":
		case "ITERATOR_STEP":
		case "ITERATOR_CLOSE":
		case "FOR_IN_KEYS":
		case "MERGE_DATA_PROPERTIES":
		case "DELETE_PROPERTY":
		case "DEFINE_ACCESSOR":
		case "DEFINE_PROPERTY":
		case "SET_FUNCTION_NAME":
		case "CREATE_PRIVATE_NAME":
		case "DEFINE_PRIVATE":
		case "LOAD_PRIVATE":
		case "STORE_PRIVATE":
		case "HAS_PRIVATE":
		case "SET_PROTOTYPE":
		case "WITH_ENTER":
		case "WITH_EXIT":
		case "IS_EMPTY":
		case "REQUIRE_COERCIBLE":
		case "CHECK_SUPER_CLASS":
		case "CREATE_REST_ARGUMENTS":
		case "ARRAY_REST":
		case "UNARY":
		case "MATH_UNARY_NUMBER":
		case "MATH_BINARY_NUMBER":
		case "TYPEOF_COMPARE":
			return { ...instruction };
		case "LOAD_PROPERTY":
			return {
				...instruction,
				nativeClosedGlobalTable:
					instruction.nativeClosedGlobalTable === undefined
						? undefined
						: {
								...instruction.nativeClosedGlobalTable,
								baseIndex: instruction.nativeClosedGlobalTable.baseIndex + base.global,
								stateIndex: instruction.nativeClosedGlobalTable.stateIndex + base.global,
							},
				nativeFiniteKey:
					instruction.nativeFiniteKey === undefined
						? undefined
						: {
								minimum: instruction.nativeFiniteKey.minimum,
								ordinal: instruction.nativeFiniteKey.ordinal,
								stringIndices: instruction.nativeFiniteKey.stringIndices.map(
									(index) => index + base.string,
								),
							},
			};
		case "STORE_PROPERTY":
			return {
				...instruction,
				nativeClosedGlobalTable:
					instruction.nativeClosedGlobalTable === undefined
						? undefined
						: {
								...instruction.nativeClosedGlobalTable,
								baseIndex: instruction.nativeClosedGlobalTable.baseIndex + base.global,
								stateIndex: instruction.nativeClosedGlobalTable.stateIndex + base.global,
							},
				nativeFiniteKey:
					instruction.nativeFiniteKey === undefined
						? undefined
						: {
								minimum: instruction.nativeFiniteKey.minimum,
								ordinal: instruction.nativeFiniteKey.ordinal,
								stringIndices: instruction.nativeFiniteKey.stringIndices.map(
									(index) => index + base.string,
								),
							},
			};
		case "BINARY":
			return {
				...instruction,
				nativeFiniteString:
					instruction.nativeFiniteString === undefined
						? undefined
						: {
								minimum: instruction.nativeFiniteString.minimum,
								stringIndices: instruction.nativeFiniteString.stringIndices.map(
									(index) => index + base.string,
								),
							},
			};
	}
	return assertNever(instruction);
}

function cloneLiteralTemplates(
	data: Array<number>,
	stringBase: number,
	bigintBase: number,
): Array<number> {
	const cloned = [...data];
	let position = 0;
	while (position < cloned.length) {
		const tag = cloned[position++]!;
		switch (tag) {
			case 0: // null
			case 1: // false
			case 2: // true
			case 7: // hole
				break;
			case 3: // i32
			case 8: // array + element count
			case 9: // object + property count
				if (position >= cloned.length) throw new Error("Truncated VM literal template");
				position++;
				break;
			case 4: // f64 words
				if (position + 1 >= cloned.length)
					throw new Error("Truncated VM literal template");
				position += 2;
				break;
			case 5: // string
			case 10: // object key string
				if (position >= cloned.length) throw new Error("Truncated VM literal template");
				cloned[position] = cloned[position]! + stringBase;
				position++;
				break;
			case 6: // bigint
				if (position >= cloned.length) throw new Error("Truncated VM literal template");
				cloned[position] = cloned[position]! + bigintBase;
				position++;
				break;
			default:
				throw new Error(`Unknown VM literal-template tag ${tag}`);
		}
	}
	return cloned;
}

/** Merge immutable definitions while cloning and rebasing every indexed table. */
export function mergeVmDefinitions(definitions: Array<VmDefinition>): MergedVmDefinition {
	const merged: VmDefinition = {
		entrypointPath: definitions[0]?.entrypointPath ?? "",
		functionCount: 0,
		functions: [],
		stringConstants: [],
		bigintConstants: [],
		literalTemplateData: [],
		globalCount: 0,
		files: [],
		sourcePositions: [],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
	};
	const semanticDefinitions = definitions.filter(
		(definition) => definition.semanticProtectors !== undefined,
	);
	if (semanticDefinitions.length > 0) {
		const firstFacts = semanticDefinitions[0]!.semanticProtectors!;
		const signature = JSON.stringify(firstFacts);
		if (
			semanticDefinitions.length !== definitions.length ||
			semanticDefinitions.some(
				(definition) => JSON.stringify(definition.semanticProtectors) !== signature,
			)
		) {
			throw new Error("VM definition semantic protector facts do not match");
		}
		merged.semanticProtectors = firstFacts.map((fact) => ({
			family: fact.family,
			guard: {
				dependencies: fact.guard.dependencies.map((dependency) => ({ ...dependency })),
				obligations: [...fact.guard.obligations],
			},
		}));
	}
	const functionBases: Array<number> = [];

	for (const definition of definitions) {
		if (definition.functionCount !== definition.functions.length) {
			throw new Error("VM definition functionCount does not match functions.length");
		}
		const base: RebaseBases = {
			function: merged.functions.length,
			global: merged.globalCount,
			string: merged.stringConstants.length,
			bigint: merged.bigintConstants.length,
			template: merged.literalTemplateData.length,
			file: merged.files.length,
			position: merged.sourcePositions.length,
		};
		functionBases.push(base.function);

		merged.stringConstants.push(...definition.stringConstants.map((value) => [...value]));
		merged.bigintConstants.push(...definition.bigintConstants);
		merged.literalTemplateData.push(
			...cloneLiteralTemplates(definition.literalTemplateData, base.string, base.bigint),
		);
		merged.globalCount += definition.globalCount;
		merged.files.push(...definition.files);
		merged.sourcePositions.push(
			...definition.sourcePositions.map((position) => ({
				...position,
				inlinedFunctionIndex:
					position.inlinedFunctionIndex === undefined
						? undefined
						: shifted(position.inlinedFunctionIndex, base.function),
				callerPosId:
					position.callerPosId === undefined
						? undefined
						: shifted(position.callerPosId, base.position),
			})),
		);
		merged.cjsModuleFunctionIndices.push(
			...definition.cjsModuleFunctionIndices.map((index) => index + base.function),
		);
		merged.hostInstalls.push(
			...definition.hostInstalls.map((install) => ({
				installer: install.installer,
				exports: install.exports.map((entry) => ({
					...entry,
					slot: entry.slot + base.global,
				})),
			})),
		);
		merged.functions.push(
			...definition.functions.map((fn) => ({
				...fn,
				nameStringIndex: shifted(fn.nameStringIndex, base.string),
				instructions: fn.instructions.map((instruction) =>
					cloneInstruction(instruction, base),
				),
				handlers: fn.handlers.map((handler) => ({ ...handler })),
				fileIndex: shifted(fn.fileIndex, base.file),
				positions: fn.positions.map((position) => shifted(position, base.position)),
				gcRootRegisters:
					fn.gcRootRegisters === undefined ? undefined : [...fn.gcRootRegisters],
				mappedArgumentSlots: [...fn.mappedArgumentSlots],
				regions: fn.regions?.map((region) => cloneRegion(region, base)),
			})),
		);
	}

	merged.functionCount = merged.functions.length;
	return { definition: merged, functionBases };
}
