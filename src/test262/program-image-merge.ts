import type {
	ProgramImage,
	NativeInstructionPlan,
	VmRegion,
} from "../compiler/target/program-image.ts";
import { rebaseVmValueOperand } from "../compiler/target/runtime-image.ts";
import type { BytecodeInstruction } from "../compiler/target/runtime-image.ts";

export interface MergedProgramImage {
	image: ProgramImage;
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

function cloneNativeInstructionPlan(
	plan: NativeInstructionPlan | undefined,
	base: RebaseBases,
): NativeInstructionPlan | undefined {
	if (plan === undefined) return undefined;
	if (plan.kind === "call") {
		return {
			...plan,
			guardedFunctionIndices:
				plan.guardedFunctionIndices === undefined
					? undefined
					: plan.guardedFunctionIndices.map((target) => target + base.function),
			directFunctionIndex:
				plan.directFunctionIndex === undefined
					? undefined
					: plan.directFunctionIndex + base.function,
			directCallTargetFunctionIndex:
				plan.directCallTargetFunctionIndex === undefined
					? undefined
					: plan.directCallTargetFunctionIndex + base.function,
			directCallbackFunctionIndex:
				plan.directCallbackFunctionIndex === undefined
					? undefined
					: plan.directCallbackFunctionIndex + base.function,
			numericSortCallback:
				plan.numericSortCallback === undefined
					? undefined
					: {
							...plan.numericSortCallback,
							functionIndex: plan.numericSortCallback.functionIndex + base.function,
						},
			guardedBuiltinCall:
				plan.guardedBuiltinCall === undefined
					? undefined
					: {
							operation: plan.guardedBuiltinCall.operation,
							guard: {
								dependencies: plan.guardedBuiltinCall.guard.dependencies.map(
									(dependency) => ({ ...dependency }),
								),
								obligations: [...plan.guardedBuiltinCall.guard.obligations],
							},
						},
		};
	}
	if (plan.kind === "construct") {
		return { ...plan, directFunctionIndex: plan.directFunctionIndex + base.function };
	}
	return { ...plan };
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
			admission: { ...region.license.admission },
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
		case "array-values-iterator-cursor":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				stepIps: [...region.stepIps],
			};
		case "string-iterator-cursor":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				stepIps: [...region.stepIps],
			};
		case "typed-array-iterator-cursor":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				stepIps: [...region.stepIps],
			};
		case "map-iterator-cursor":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				stepIps: [...region.stepIps],
			};
		case "set-iterator-cursor":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				stepIps: [...region.stepIps],
			};
		case "iterator-result-virtualization":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				stepIps: [...region.stepIps],
			};
		case "iterator-entry-pair-virtualization":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				innerStepIps: [...region.innerStepIps],
				innerCloseIps: [...region.innerCloseIps],
			};
		case "string-char-code-at-chain":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
			};
		case "builtin-collection-call-chain":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
			};
		case "indexed-length-loop":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				sites: region.sites.map((site) => ({
					...site,
					elements: site.elements.map((element) => ({ ...element })),
				})),
			};
		case "numeric-fusion":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				pairs: region.pairs.map((pair) => ({ ...pair })),
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
				resultRegisters: [...region.resultRegisters],
				loads: region.loads.map((load) => ({ ...load })),
			};
		case "regexp-exec-projection":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
				...(region.lockedLiteral === undefined
					? {}
					: { lockedLiteral: { ...region.lockedLiteral } }),
				resultRegisters: [...region.resultRegisters],
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
				resultRegisters: [...region.resultRegisters],
				loads: region.loads.map((load) => ({ ...load })),
			};
		case "string-slice-number":
			return {
				...cloneRegionEnvelope(region),
				kind: region.kind,
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
	}
}

function cloneInstruction(
	instruction: BytecodeInstruction,
	base: RebaseBases,
): BytecodeInstruction {
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
		case "LOAD_GLOBAL_INDEX":
		case "LOAD_GLOBAL":
		case "STORE_GLOBAL":
			return { ...instruction, index: instruction.index + base.global };
		case "CREATE_STRING":
			return { ...instruction, stringIndex: instruction.stringIndex + base.string };
		case "LOAD_PROPERTY_STATIC":
		case "LOAD_PROPERTY_STATIC_ARRAY_LENGTH":
		case "STORE_PROPERTY_STATIC":
		case "LOAD_PROPERTY_STATIC_SHAPE_CASE":
			return { ...instruction, stringIndex: instruction.stringIndex + base.string };
		case "SELECT_SHAPE_CASE":
			return {
				...instruction,
				candidates: instruction.candidates.map((candidate) => ({
					...candidate,
					shapeFunctionIndex: candidate.shapeFunctionIndex + base.function,
				})),
			};
		case "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT":
		case "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT":
			return {
				...instruction,
				stringIndex: instruction.stringIndex + base.string,
				candidates: instruction.candidates.map((candidate) => ({
					...candidate,
					shapeFunctionIndex: candidate.shapeFunctionIndex + base.function,
				})),
			};
		case "CREATE_BIGINT":
			return { ...instruction, bigintIndex: instruction.bigintIndex + base.bigint };
		case "PREPARED_STRING_COMPARE":
			return { ...instruction, stringIndex: instruction.stringIndex + base.string };
		case "INSTANTIATE_LITERAL_TEMPLATE":
			return {
				...instruction,
				templateOffset: instruction.templateOffset + base.template,
				...(instruction.cacheSlot === undefined
					? {}
					: { cacheSlot: instruction.cacheSlot + base.global }),
			};
		case "QUERY_STATIC_DATA":
			return {
				...instruction,
				templateOffset: instruction.templateOffset + base.template,
			};
		case "LOAD_UNDECLARED":
		case "GLOBAL_BINDING_QUERY":
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
		case "DECLARE_GLOBAL_LEXICAL":
			return {
				...instruction,
				nameStringIndex: instruction.nameStringIndex + base.string,
				index: instruction.index + base.global,
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
				cacheSlot: instruction.cacheSlot < 0 ? -1 : instruction.cacheSlot + base.global,
				nameIndices: instruction.nameIndices.map((index) => index + base.string),
				slots: instruction.slots.map((index) => index + base.global),
			};
		case "CALL":
			return {
				...instruction,
				...(instruction.guardedFunctionIndices === undefined
					? {}
					: {
							guardedFunctionIndices: instruction.guardedFunctionIndices.map(
								(target) => target + base.function,
							),
						}),
				...(instruction.exactFunctionIndex === undefined
					? {}
					: { exactFunctionIndex: instruction.exactFunctionIndex + base.function }),
				callee: rebaseVmValueOperand(instruction.callee, base.string),
				thisValue: rebaseVmValueOperand(instruction.thisValue, base.string),
				arguments: instruction.arguments.map((operand) =>
					rebaseVmValueOperand(operand, base.string),
				),
			};
		case "CALL_KNOWN":
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
				...(instruction.exactFunctionIndex === undefined
					? {}
					: { exactFunctionIndex: instruction.exactFunctionIndex + base.function }),
				callee: rebaseVmValueOperand(instruction.callee, base.string),
				arguments: instruction.arguments.map((operand) =>
					rebaseVmValueOperand(operand, base.string),
				),
			};
		case "COPY_DATA_PROPERTIES":
			return { ...instruction, excluded: [...instruction.excluded] };

		// Registers, instruction pointers, literal values, intrinsic/operator ids,
		// and synthetic negative environment scope ids are image-local values.
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
		case "CALL_REST_ARGUMENTS":
		case "CALL_SPREAD_ITERABLE":
		case "CONSTRUCT_SPREAD":
		case "CONSTRUCT_SUPER":
		case "CONSTRUCT_SUPER_EXPLICIT":
		case "SET_THIS":
		case "BUILTIN_ERROR":
		case "THROW":
		case "CATCH":
		case "TRY_BEGIN":
		case "TRY_END":
		case "GENERATOR_START":
		case "ASYNC_START":
		case "YIELD":
		case "TERMINAL_YIELD":
		case "AWAIT":
		case "LOAD_PRIMORDIAL":
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
		case "PRECISE_NUMBER_SUM":
		case "TYPEOF_COMPARE":
			return { ...instruction };
		case "LOAD_PROPERTY":
		case "STORE_PROPERTY":
		case "BINARY":
			return { ...instruction };
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

/** Merge immutable images while cloning and rebasing every indexed table. */
export function mergeProgramImages(images: Array<ProgramImage>): MergedProgramImage {
	const mergedNativeFunctions: Array<ProgramImage["native"]["functions"][number]> = [];
	const mergedRuntime: ProgramImage["runtime"] = {
		entrypointPath: images[0]?.runtime.entrypointPath ?? "",
		functionCount: 0,
		functions: [],
		stringConstants: [],
		bigintConstants: [],
		literalTemplateData: [],
		precompiledLiteralShapes: [],
		globalCount: 0,
		files: [],
		sourcePositions: [],
		cjsModuleFunctionIndices: [],
		hostInstalls: [],
	};
	const semanticImages = images.filter(
		(image) => image.native.semanticProtectors.length > 0,
	);
	let semanticProtectors: ProgramImage["native"]["semanticProtectors"] = [];
	if (semanticImages.length > 0) {
		const firstFacts = semanticImages[0]!.native.semanticProtectors;
		const signature = JSON.stringify(firstFacts);
		if (
			semanticImages.length !== images.length ||
			semanticImages.some(
				(image) => JSON.stringify(image.native.semanticProtectors) !== signature,
			)
		) {
			throw new Error("VM image semantic protector facts do not match");
		}
		semanticProtectors = firstFacts.map((fact) => ({
			family: fact.family,
			guard: {
				dependencies: fact.guard.dependencies.map((dependency) => ({ ...dependency })),
				obligations: [...fact.guard.obligations],
			},
		}));
	}
	const functionBases: Array<number> = [];

	for (const programImage of images) {
		const runtime = programImage.runtime;
		if (runtime.functionCount !== runtime.functions.length) {
			throw new Error("runtime image functionCount does not match functions.length");
		}
		if (programImage.native.functions.length !== runtime.functions.length) {
			throw new Error("native-plan count does not match runtime functions.length");
		}
		const base: RebaseBases = {
			function: mergedRuntime.functions.length,
			global: mergedRuntime.globalCount,
			string: mergedRuntime.stringConstants.length,
			bigint: mergedRuntime.bigintConstants.length,
			template: mergedRuntime.literalTemplateData.length,
			file: mergedRuntime.files.length,
			position: mergedRuntime.sourcePositions.length,
		};
		functionBases.push(base.function);

		mergedRuntime.stringConstants.push(
			...runtime.stringConstants.map((value) => [...value]),
		);
		mergedRuntime.bigintConstants.push(...runtime.bigintConstants);
		mergedRuntime.literalTemplateData.push(
			...cloneLiteralTemplates(runtime.literalTemplateData, base.string, base.bigint),
		);
		mergedRuntime.precompiledLiteralShapes.push(
			...runtime.precompiledLiteralShapes.map((descriptor) => ({
				functionIndex: descriptor.functionIndex + base.function,
				shapeCacheIndex: descriptor.shapeCacheIndex,
				keyStringIndices: descriptor.keyStringIndices.map((index) => index + base.string),
			})),
		);
		mergedRuntime.globalCount += runtime.globalCount;
		mergedRuntime.files.push(...runtime.files);
		mergedRuntime.sourcePositions.push(
			...runtime.sourcePositions.map((position) => ({
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
		mergedRuntime.cjsModuleFunctionIndices.push(
			...runtime.cjsModuleFunctionIndices.map((index) => index + base.function),
		);
		mergedRuntime.hostInstalls.push(
			...runtime.hostInstalls.map((install) => ({
				installer: install.installer,
				exports: install.exports.map((entry) => ({
					...entry,
					slot: entry.slot + base.global,
				})),
			})),
		);
		mergedRuntime.functions.push(
			...runtime.functions.map((fn) => ({
				...fn,
				nameStringIndex: shifted(fn.nameStringIndex, base.string),
				instructions: fn.instructions.map((instruction) =>
					cloneInstruction(instruction, base),
				),
				handlers: fn.handlers.map((handler) => ({ ...handler })),
				fileIndex: shifted(fn.fileIndex, base.file),
				positions: fn.positions.map((position) => shifted(position, base.position)),
				mappedArgumentSlots: [...fn.mappedArgumentSlots],
			})),
		);
		mergedNativeFunctions.push(
			...programImage.native.functions.map((native, localFunctionIndex) => ({
				...native,
				functionIndex: base.function + localFunctionIndex,
				mode: native.mode,
				registerRepresentations: [...native.registerRepresentations],
				directEntries: native.directEntries.map((entry) => ({
					...entry,
					parameterRepresentations: [...entry.parameterRepresentations],
					resultRepresentation: entry.resultRepresentation,
					fieldParameters:
						entry.fieldParameters === undefined
							? undefined
							: {
									keys: entry.fieldParameters.keys.map((key) => key + base.string),
									loads: entry.fieldParameters.loads.map((load) => ({ ...load })),
								},
					argumentRepresentations: entry.argumentRepresentations?.slice(),
					operatorInputs: entry.operatorInputs?.map((input) => ({
						...input,
						masks: [...input.masks] as typeof input.masks,
					})),
					constantBooleans: entry.constantBooleans?.map((constant) => ({ ...constant })),
					registerRepresentations: [...entry.registerRepresentations],
					gc: {
						safepoints: entry.gc.safepoints.map((safepoint) => ({
							kind: safepoint.kind,
							instructionIp: safepoint.instructionIp,
							rootRegisters: [...safepoint.rootRegisters],
						})),
					},
				})),
				literalSwitches: native.literalSwitches?.map((site) =>
					site.kind === "string"
						? {
								...site,
								cases: site.cases.map((label) => ({
									...label,
									stringIndex: label.stringIndex + base.string,
								})),
							}
						: { ...site, cases: site.cases.map((label) => ({ ...label })) },
				),
				fieldCalls: native.fieldCalls?.map((site) => ({
					...site,
					entries: site.entries.map((entry) => ({
						...entry,
						functionIndex: entry.functionIndex + base.function,
					})),
				})),
				gc: {
					safepoints: native.gc.safepoints.map((safepoint) => ({
						kind: safepoint.kind,
						instructionIp: safepoint.instructionIp,
						rootRegisters: [...safepoint.rootRegisters],
					})),
				},
				instructions: native.instructions.map((plan) =>
					cloneNativeInstructionPlan(plan, base),
				),
				specializations: native.specializations.map((region) =>
					cloneRegion(region, base),
				),
				regionActions: native.regionActions.map((action) => ({ ...action })),
				compilerSiteIds: native.compilerSiteIds ? [...native.compilerSiteIds] : undefined,
			})),
		);
	}

	mergedRuntime.functionCount = mergedRuntime.functions.length;
	const merged: ProgramImage = {
		runtime: mergedRuntime,
		native: { semanticProtectors, functions: mergedNativeFunctions },
		diagnostics: {},
	};
	return { image: merged, functionBases };
}
