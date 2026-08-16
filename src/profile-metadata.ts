import type { CompilerSiteFacts, FactDependency } from "./compiler-facts.ts";
import type { IntermediateProgram } from "./ir.ts";
import type { VmDefinition, VmInstruction } from "./lower-vm.ts";

export interface ProfileSite {
	id: number;
	/** Deliberately non-unique across structurally identical sites: consumers must
	 * report ambiguity rather than silently joining the wrong locations. */
	logicalId: string;
	/** Stable syntactic operation before cloning/inlining. */
	originId: string;
	/** Exact optimized instance, including its inline caller chain. */
	instanceId: string;
	/** Source expression/statement region used for explicitly coarse attribution. */
	regionId: string;
	functionIndex: number;
	instructionIndex: number;
	positionId: number;
	file: string;
	line: number;
	column: number;
	operation: string;
	inlineChain: Array<{ functionIndex: number; positionId: number }>;
}

export interface CompilerRemark {
	siteId: number;
	phase:
		| "analysis"
		| "optimization"
		| "ir"
		| "lowering"
		| "native-backend"
		| "bytecode-backend";
	operation: string;
	code: string;
	outcome: "applied" | "declined" | "elided" | "guarded" | "retained" | "fallback";
	reason?: string;
	reasonCode?: string;
	details?: Record<string, string | number | boolean>;
	facts?: {
		escape?: string;
		representation?: string;
		shape?: string;
		dependencies: ReadonlyArray<string>;
		obligations: ReadonlyArray<string>;
	};
}

export interface ProfileSiteMatchReport {
	exact: number;
	logical: number;
	ambiguous: number;
	unmatched: number;
	coverage: number;
}

/** Compare build-local tables without ever guessing through duplicate structural
 * identities. A moved unique site is logical; duplicate keys are ambiguous. */
export function matchProfileSites(
	base: ReadonlyArray<ProfileSite>,
	head: ReadonlyArray<ProfileSite>,
): ProfileSiteMatchReport {
	const baseByLogical = new Map<string, Array<ProfileSite>>();
	const headByLogical = new Map<string, Array<ProfileSite>>();
	for (const site of base)
		(
			baseByLogical.get(site.logicalId) ??
			baseByLogical.set(site.logicalId, []).get(site.logicalId)!
		).push(site);
	for (const site of head)
		(
			headByLogical.get(site.logicalId) ??
			headByLogical.set(site.logicalId, []).get(site.logicalId)!
		).push(site);
	let exact = 0;
	let logical = 0;
	let ambiguous = 0;
	let unmatched = 0;
	for (const site of head) {
		const before = baseByLogical.get(site.logicalId) ?? [];
		const after = headByLogical.get(site.logicalId) ?? [];
		if (before.length === 0) {
			unmatched++;
		} else if (before.length !== 1 || after.length !== 1) {
			ambiguous++;
		} else if (
			before[0]!.file === site.file &&
			before[0]!.line === site.line &&
			before[0]!.column === site.column &&
			before[0]!.operation === site.operation
		) {
			exact++;
		} else {
			logical++;
		}
	}
	return {
		exact,
		logical,
		ambiguous,
		unmatched,
		coverage: head.length === 0 ? 1 : (exact + logical) / head.length,
	};
}

function normalizedPath(value: string): string {
	return value.replaceAll("\\", "/");
}

function commonDirectory(paths: Array<string>): string {
	if (paths.length === 0) return "";
	const split = paths.map((value) => normalizedPath(value).split("/"));
	let count = 0;
	while (
		count < split[0]!.length &&
		split.every((parts) => parts[count] === split[0]![count])
	) {
		count++;
	}
	return split[0]!.slice(0, Math.max(0, count - 1)).join("/");
}

function stableHash(value: string, seed: number): string {
	let hash = seed >>> 0;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function logicalId(value: string): string {
	return `site-v1-${stableHash(value, 0x811c9dc5)}${stableHash(value, 0x9e3779b9)}`;
}

const PROFILE_ALLOCATION_OPCODES = new Set<VmInstruction["opcode"]>([
	"CREATE_ARGUMENTS_OBJECT",
	"CREATE_ARRAY",
	"CREATE_FUNCTION",
	"CREATE_MODULE_NAMESPACE",
	"CREATE_OBJECT",
	"CREATE_OBJECT_SHAPED",
	"CREATE_PRIVATE_NAME",
	"CREATE_PRIVATE_NAMES",
	"CREATE_REST_ARGUMENTS",
	"CREATE_TEMPLATE_OBJECT",
]);

export function profileOperationForInstruction(instruction: VmInstruction): string {
	const opcode = instruction.opcode;
	if (opcode.startsWith("CALL") || opcode === "GUARD_FUNCTION_INDEX") return "call";
	if (opcode.startsWith("CONSTRUCT")) return "call";
	if (
		opcode.includes("PROPERTY") ||
		opcode === "LOAD_PROTOTYPE" ||
		opcode === "SET_PROTOTYPE"
	) {
		return "property";
	}
	if (
		PROFILE_ALLOCATION_OPCODES.has(opcode) ||
		opcode === "INSTANTIATE_LITERAL_TEMPLATE" ||
		opcode === "CREATE_BIGINT"
	) {
		return "allocation";
	}
	if (
		opcode === "BINARY" ||
		opcode === "UNARY" ||
		opcode === "TO_PROPERTY_KEY" ||
		opcode === "REQUIRE_COERCIBLE"
	) {
		return "boxing";
	}
	return "execute";
}

function remarkableOperation(operation: string): boolean {
	return (
		operation === "call" ||
		operation === "property" ||
		operation === "allocation" ||
		operation === "boxing"
	);
}

function remarkForInstruction(
	instruction: VmInstruction,
): Omit<CompilerRemark, "siteId"> | undefined {
	const operation = profileOperationForInstruction(instruction);
	switch (instruction.opcode) {
		case "CALL":
		case "CALL_SPREAD":
		case "CALL_SPREAD_ITERABLE":
			return {
				phase: "lowering",
				operation,
				code: "call.generic",
				outcome: "retained",
			};
		case "GUARD_FUNCTION_INDEX":
			return {
				phase: "lowering",
				operation,
				code: "call.guarded",
				outcome: "applied",
			};
		case "LOAD_PROPERTY":
			return {
				phase: "lowering",
				operation,
				code: "property.dynamic-load",
				outcome: "retained",
			};
		case "LOAD_PROPERTY_STATIC":
			return {
				phase: "lowering",
				operation,
				code: "property.static-load",
				outcome: "applied",
			};
		case "STORE_PROPERTY":
			return {
				phase: "lowering",
				operation,
				code: "property.dynamic-store",
				outcome: "retained",
			};
		case "STORE_PROPERTY_STATIC":
			return {
				phase: "lowering",
				operation,
				code: "property.static-store",
				outcome: "applied",
			};
		case "CREATE_OBJECT":
			return {
				phase: "lowering",
				operation,
				code: "object.heap",
				outcome: "retained",
			};
		case "CREATE_OBJECT_SHAPED":
			return {
				phase: "lowering",
				operation,
				code: "object.shaped",
				outcome: "applied",
			};
		default:
			switch (operation) {
				case "allocation":
					return {
						phase: "lowering",
						operation,
						code: "allocation.heap",
						outcome: "retained",
					};
				case "call":
					return {
						phase: "lowering",
						operation,
						code: "call.generic",
						outcome: "retained",
					};
				case "property":
					return {
						phase: "lowering",
						operation,
						code: "property.dynamic-load",
						outcome: "retained",
					};
				case "boxing":
					return {
						phase: "lowering",
						operation,
						code: "boxing.generic",
						outcome: "retained",
					};
				default:
					return undefined;
			}
	}
}

function dependencyLabel(dependency: FactDependency): string {
	switch (dependency.kind) {
		case "world":
			return `world:${dependency.fact}`;
		case "epoch":
			return `epoch:${dependency.family}`;
		case "guard":
			return `guard:${dependency.id}`;
		case "summary":
			return `summary:${dependency.id}`;
	}
}

function factRemarks(
	site: CompilerSiteFacts | undefined,
	operation: string,
): Array<Omit<CompilerRemark, "siteId">> {
	if (site === undefined) return [];
	const remarks: Array<Omit<CompilerRemark, "siteId">> = [];
	const details = (
		fact:
			| CompilerSiteFacts["shape"]
			| CompilerSiteFacts["escape"]
			| CompilerSiteFacts["representation"]
			| CompilerSiteFacts["builtinIdentity"]
			| CompilerSiteFacts["immutableBinding"],
	): NonNullable<CompilerRemark["facts"]> | undefined => {
		if (fact?.kind !== "known") return undefined;
		return {
			...(site.escape?.kind === "known" ? { escape: site.escape.value } : {}),
			...(site.representation?.kind === "known"
				? { representation: site.representation.value }
				: {}),
			...(site.shape?.kind === "known"
				? { shape: JSON.stringify(site.shape.value) }
				: {}),
			dependencies: fact.proof.dependencies.map(dependencyLabel),
			obligations: fact.proof.obligations.map(
				(obligation) => `${obligation.kind}:${obligation.id}`,
			),
		};
	};
	if (site.shape?.kind === "known") {
		remarks.push({
			phase: "analysis",
			operation,
			code: "optimization.applied.known-shape",
			outcome: "applied",
			facts: details(site.shape),
		});
	}
	if (site.representation?.kind === "known" && site.representation.value === "stack") {
		remarks.push({
			phase: "optimization",
			operation,
			code: "optimization.applied.stack-representation",
			outcome: "applied",
			facts: details(site.representation),
		});
		if (
			site.representation.proof.obligations.some(
				(obligation) => obligation.kind === "materialize",
			)
		) {
			remarks.push({
				phase: "optimization",
				operation,
				code: "optimization.applied.partial-escape-materialization",
				outcome: "applied",
				facts: details(site.representation),
			});
		}
	}
	if (site.builtinIdentity?.kind === "known") {
		remarks.push({
			phase: "analysis",
			operation,
			code: "optimization.applied.known-builtin",
			outcome: "applied",
			facts: details(site.builtinIdentity),
		});
	}
	if (site.immutableBinding?.kind === "known") {
		remarks.push({
			phase: "analysis",
			operation,
			code: "optimization.applied.immutable-binding",
			outcome: "applied",
			facts: details(site.immutableBinding),
		});
	}
	return remarks;
}

interface FinalCompiledFunction {
	profileDecisions: Array<{
		instructionIndex: number;
		operation: string;
		code: string;
		outcome: CompilerRemark["outcome"];
		reasonCode?: string;
		details?: Record<string, string | number | boolean>;
	}>;
}

/** Publish remarks only after the backend has selected its final emitted variant. */
export function finalizeCompilerRemarks(
	definition: VmDefinition,
	compiled: ReadonlyArray<FinalCompiledFunction | null>,
): void {
	if (definition.profileSites === undefined) return;
	const remarks: Array<CompilerRemark> = [...(definition.profileRemarks ?? [])];
	for (const [functionIndex, fn] of definition.functions.entries()) {
		const emitted = compiled[functionIndex];
		if (emitted === null || emitted === undefined) {
			for (const siteId of fn.profileSiteIds ?? []) {
				if (siteId < 0) continue;
				const site = definition.profileSites[siteId];
				if (site === undefined || !remarkableOperation(site.operation)) continue;
				remarks.push({
					siteId,
					phase: "bytecode-backend",
					operation: site.operation,
					code: `${site.operation}.bytecode`,
					outcome: "fallback",
					reasonCode: "native-backend-not-selected",
				});
			}
			continue;
		}
		for (const decision of emitted.profileDecisions) {
			const siteId = fn.profileSiteIds?.[decision.instructionIndex] ?? -1;
			if (siteId < 0) continue;
			remarks.push({
				siteId,
				phase: "native-backend",
				operation: decision.operation,
				code: decision.code,
				outcome: decision.outcome,
				...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
				...(decision.details === undefined ? {} : { details: decision.details }),
			});
		}
	}
	definition.profileRemarks = remarks;
}

/** Derive dense runtime IDs plus conservative cross-build keys from the final
 * optimized program. Normalized source text, not line number, anchors identity so
 * unrelated insertions do not churn a site. */
export function buildProfileMetadata(
	program: IntermediateProgram,
	definition: VmDefinition,
): void {
	const sourcePaths = program.semantic.files.map((file) => normalizedPath(file.path));
	const root = commonDirectory(sourcePaths);
	const fileByPath = new Map(
		program.semantic.files.map((file) => [normalizedPath(file.path), file] as const),
	);
	const sites: Array<ProfileSite> = [];
	const remarks: Array<CompilerRemark> = [];
	const remarkKeys = new Set<string>();
	const decisionSiteByKey = new Map<string, number>();
	const addRemark = (siteId: number, remark: Omit<CompilerRemark, "siteId">): void => {
		const remarkKey = `${siteId}:${remark.code}:${remark.reason ?? ""}`;
		if (remarkKeys.has(remarkKey)) return;
		remarkKeys.add(remarkKey);
		remarks.push({ siteId, ...remark });
	};
	const relativeFile = (file: string): string =>
		root !== "" && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
	const functionName = (functionIndex: number): string => {
		const candidate = definition.functions[functionIndex];
		const units =
			candidate === undefined
				? undefined
				: definition.stringConstants[candidate.nameStringIndex];
		return units === undefined
			? "<anonymous>"
			: String.fromCodePoint(...units) || "<anonymous>";
	};
	const functionFile = (functionIndex: number): string => {
		const candidate = definition.functions[functionIndex];
		return normalizedPath(
			candidate === undefined
				? "<unknown>"
				: (definition.files[candidate.fileIndex] ?? "<unknown>"),
		);
	};
	const ensureDecisionSite = (
		functionIndex: number,
		positionId: number,
		operation: string,
	): number | undefined => {
		const decisionKey = `${functionIndex}:${positionId}:${operation}`;
		const existing = decisionSiteByKey.get(decisionKey);
		if (existing !== undefined) return existing;
		const position = definition.sourcePositions[positionId];
		if (position === undefined) return undefined;
		const leafFunctionIndex = position.inlinedFunctionIndex ?? functionIndex;
		const leafFile = functionFile(leafFunctionIndex);
		const leafSource = fileByPath.get(leafFile)?.contents ?? "";
		const anchor = (leafSource.split("\n")[position.line - 1] ?? "")
			.trim()
			.replaceAll(/\s+/g, " ");
		const inlineChain: Array<{ functionIndex: number; positionId: number }> = [];
		let chainPositionId = positionId;
		let guard = 0;
		while (chainPositionId >= 0 && guard++ < 1024) {
			const chainPosition = definition.sourcePositions[chainPositionId];
			if (chainPosition === undefined) break;
			inlineChain.push({
				functionIndex: chainPosition.inlinedFunctionIndex ?? functionIndex,
				positionId: chainPositionId,
			});
			chainPositionId = chainPosition.callerPosId ?? -1;
		}
		const chainKey = inlineChain
			.map((entry) => {
				const chainPosition = definition.sourcePositions[entry.positionId]!;
				const chainFile = functionFile(entry.functionIndex);
				const chainSource = fileByPath.get(chainFile)?.contents ?? "";
				const chainAnchor = (chainSource.split("\n")[chainPosition.line - 1] ?? "")
					.trim()
					.replaceAll(/\s+/g, " ");
				return `${relativeFile(chainFile)}:${functionName(entry.functionIndex)}:${chainAnchor}:${chainPosition.column}`;
			})
			.join("<-");
		const originKey = `${relativeFile(leafFile)}\u0000${functionName(leafFunctionIndex)}\u0000${anchor}\u0000${position.column}\u0000${operation}\u00000`;
		const originId = logicalId(originKey);
		const instanceId = logicalId(`${originKey}\u0000${chainKey}`);
		const physicalFile = functionFile(functionIndex);
		const siteId = sites.length;
		sites.push({
			id: siteId,
			logicalId: instanceId,
			originId,
			instanceId,
			regionId: logicalId(
				`${relativeFile(physicalFile)}\u0000${functionName(functionIndex)}\u0000${chainKey}`,
			),
			functionIndex,
			instructionIndex: -1,
			positionId,
			file: relativeFile(leafFile),
			line: position.line,
			column: position.column,
			operation,
			inlineChain,
		});
		decisionSiteByKey.set(decisionKey, siteId);
		return siteId;
	};

	for (const [functionIndex, fn] of definition.functions.entries()) {
		const physicalFile = normalizedPath(definition.files[fn.fileIndex] ?? "<unknown>");
		const siteIds = new Array<number>(fn.instructions.length).fill(-1);
		const occurrenceByOrigin = new Map<string, number>();

		for (const [instructionIndex, instruction] of fn.instructions.entries()) {
			const positionId = fn.positions[instructionIndex] ?? -1;
			if (positionId < 0) continue;
			const position = definition.sourcePositions[positionId];
			if (position === undefined) continue;
			const operation = profileOperationForInstruction(instruction);
			const leafFunctionIndex = position.inlinedFunctionIndex ?? functionIndex;
			const leafFile = functionFile(leafFunctionIndex);
			const leafSource = fileByPath.get(leafFile)?.contents ?? "";
			const anchor = (leafSource.split("\n")[position.line - 1] ?? "")
				.trim()
				.replaceAll(/\s+/g, " ");
			const occurrenceKey = `${positionId}:${operation}`;
			const occurrence = occurrenceByOrigin.get(occurrenceKey) ?? 0;
			occurrenceByOrigin.set(occurrenceKey, occurrence + 1);
			const originKey = `${relativeFile(leafFile)}\u0000${functionName(leafFunctionIndex)}\u0000${anchor}\u0000${position.column}\u0000${operation}\u0000${occurrence}`;
			const inlineChain: Array<{ functionIndex: number; positionId: number }> = [];
			let chainPositionId = positionId;
			let guard = 0;
			while (chainPositionId >= 0 && guard++ < 1024) {
				const chainPosition = definition.sourcePositions[chainPositionId];
				if (chainPosition === undefined) break;
				inlineChain.push({
					functionIndex: chainPosition.inlinedFunctionIndex ?? functionIndex,
					positionId: chainPositionId,
				});
				chainPositionId = chainPosition.callerPosId ?? -1;
			}
			const chainKey = inlineChain
				.map((entry) => {
					const chainPosition = definition.sourcePositions[entry.positionId]!;
					const chainFile = functionFile(entry.functionIndex);
					const chainSource = fileByPath.get(chainFile)?.contents ?? "";
					const chainAnchor = (chainSource.split("\n")[chainPosition.line - 1] ?? "")
						.trim()
						.replaceAll(/\s+/g, " ");
					return `${relativeFile(chainFile)}:${functionName(entry.functionIndex)}:${chainAnchor}:${chainPosition.column}`;
				})
				.join("<-");
			const originId = logicalId(originKey);
			const instanceId = logicalId(`${originKey}\u0000${chainKey}`);
			const regionId = logicalId(
				`${relativeFile(physicalFile)}\u0000${functionName(functionIndex)}\u0000${chainKey}`,
			);
			const siteId = sites.length;
			sites.push({
				id: siteId,
				logicalId: instanceId,
				originId,
				instanceId,
				regionId,
				functionIndex,
				instructionIndex,
				positionId,
				file: relativeFile(leafFile),
				line: position.line,
				column: position.column,
				operation,
				inlineChain,
			});
			siteIds[instructionIndex] = siteId;
			const decisionKey = `${functionIndex}:${positionId}:${operation}`;
			if (!decisionSiteByKey.has(decisionKey)) {
				decisionSiteByKey.set(decisionKey, siteId);
			}
			const compilerSiteId = fn.compilerSiteIds?.[instructionIndex];
			const compilerSite =
				compilerSiteId === undefined
					? undefined
					: program.facts.sites.get(compilerSiteId);
			for (const remark of [
				remarkForInstruction(instruction),
				...factRemarks(compilerSite, operation),
			]) {
				if (remark !== undefined) addRemark(siteId, remark);
			}
		}
		fn.profileSiteIds = siteIds;
	}

	for (const decision of program.optimizationDecisions ?? []) {
		const siteId = ensureDecisionSite(
			decision.functionIndex,
			decision.positionId,
			decision.operation,
		);
		if (siteId === undefined) continue;
		addRemark(siteId, {
			phase: decision.phase,
			operation: decision.operation,
			code: decision.code,
			outcome: decision.outcome,
			...(decision.reason === undefined ? {} : { reason: decision.reason }),
		});
	}

	definition.profileSites = sites;
	definition.profileRemarks = remarks;
}
