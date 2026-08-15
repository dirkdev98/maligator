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
	phase: "ir" | "lowering" | "native-backend" | "bytecode-backend";
	operation: string;
	code: string;
	outcome: "applied" | "elided" | "guarded" | "retained" | "fallback";
	reasonCode?: string;
	details?: Record<string, string | number | boolean>;
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
	if (opcode.startsWith("CALL")) return "call";
	if (opcode.startsWith("CONSTRUCT")) return "construct";
	if (opcode.includes("PROPERTY")) return "property";
	if (PROFILE_ALLOCATION_OPCODES.has(opcode)) return "allocation";
	if (opcode === "BINARY") return "binary";
	if (opcode === "UNARY") return "unary";
	return "execute";
}

function remarkableOperation(operation: string): boolean {
	return (
		operation === "call" ||
		operation === "construct" ||
		operation === "property" ||
		operation === "allocation" ||
		operation === "binary" ||
		operation === "unary"
	);
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
	const remarks: Array<CompilerRemark> = [];
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
		}
		fn.profileSiteIds = siteIds;
	}

	definition.profileSites = sites;
	definition.profileRemarks = [];
}
