import type { IntermediateProgram } from "./ir.ts";
import type { VmDefinition, VmInstruction } from "./lower-vm.ts";

export interface ProfileSite {
	id: number;
	/** Deliberately non-unique across structurally identical sites: consumers must
	 * report ambiguity rather than silently joining the wrong locations. */
	logicalId: string;
	functionIndex: number;
	positionId: number;
	file: string;
	line: number;
	column: number;
	operation: string;
}

export interface CompilerRemark {
	siteId: number;
	phase: "lowering";
	code:
		| "call.generic"
		| "call.guarded"
		| "object.heap"
		| "object.shaped"
		| "property.dynamic-load"
		| "property.dynamic-store"
		| "property.static-load"
		| "property.static-store";
	outcome: "applied" | "retained";
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
	for (const site of base) (baseByLogical.get(site.logicalId) ?? baseByLogical.set(site.logicalId, []).get(site.logicalId)!).push(site);
	for (const site of head) (headByLogical.get(site.logicalId) ?? headByLogical.set(site.logicalId, []).get(site.logicalId)!).push(site);
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

function operationFor(instruction: VmInstruction): string {
	const opcode = instruction.opcode;
	if (opcode.startsWith("CALL")) return "call";
	if (opcode.startsWith("CONSTRUCT")) return "construct";
	if (opcode.includes("PROPERTY")) return "property";
	if (opcode.startsWith("CREATE_")) return "allocation";
	return "execute";
}

function remarkFor(instruction: VmInstruction): Omit<CompilerRemark, "siteId"> | undefined {
	switch (instruction.opcode) {
		case "CALL":
		case "CALL_SPREAD":
		case "CALL_SPREAD_ITERABLE":
			return { phase: "lowering", code: "call.generic", outcome: "retained" };
		case "GUARD_FUNCTION_INDEX":
			return { phase: "lowering", code: "call.guarded", outcome: "applied" };
		case "LOAD_PROPERTY":
			return { phase: "lowering", code: "property.dynamic-load", outcome: "retained" };
		case "LOAD_PROPERTY_STATIC":
			return { phase: "lowering", code: "property.static-load", outcome: "applied" };
		case "STORE_PROPERTY":
			return { phase: "lowering", code: "property.dynamic-store", outcome: "retained" };
		case "STORE_PROPERTY_STATIC":
			return { phase: "lowering", code: "property.static-store", outcome: "applied" };
		case "CREATE_OBJECT":
			return { phase: "lowering", code: "object.heap", outcome: "retained" };
		case "CREATE_OBJECT_SHAPED":
			return { phase: "lowering", code: "object.shaped", outcome: "applied" };
		default:
			return undefined;
	}
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
	const siteByPhysicalKey = new Map<string, number>();
	const remarkKeys = new Set<string>();

	for (const [functionIndex, fn] of definition.functions.entries()) {
		const physicalFile = normalizedPath(definition.files[fn.fileIndex] ?? "<unknown>");
		const source = fileByPath.get(physicalFile)?.contents ?? "";
		const lines = source.split("\n");
		const nameUnits = definition.stringConstants[fn.nameStringIndex] ?? [];
		const functionName = String.fromCodePoint(...nameUnits) || "<anonymous>";
		const siteIds = new Array<number>(fn.instructions.length).fill(-1);

		for (const [instructionIndex, instruction] of fn.instructions.entries()) {
			const positionId = fn.positions[instructionIndex] ?? -1;
			if (positionId < 0) continue;
			const position = definition.sourcePositions[positionId];
			if (position === undefined) continue;
			const operation = operationFor(instruction);
			const physicalKey = `${functionIndex}:${positionId}:${operation}`;
			let siteId = siteByPhysicalKey.get(physicalKey);
			if (siteId === undefined) {
				const relativeFile =
					root !== "" && physicalFile.startsWith(`${root}/`)
						? physicalFile.slice(root.length + 1)
						: physicalFile;
				const anchor = (lines[position.line - 1] ?? "")
					.trim()
					.replaceAll(/\s+/g, " ");
				siteId = sites.length;
				sites.push({
					id: siteId,
					logicalId: logicalId(
						`${relativeFile}\u0000${functionName}\u0000${anchor}\u0000${position.column}\u0000${operation}`,
					),
					functionIndex,
					positionId,
					file: relativeFile,
					line: position.line,
					column: position.column,
					operation,
				});
				siteByPhysicalKey.set(physicalKey, siteId);
			}
			siteIds[instructionIndex] = siteId;
			const remark = remarkFor(instruction);
			const remarkKey = remark === undefined ? "" : `${siteId}:${remark.code}`;
			if (remark !== undefined && !remarkKeys.has(remarkKey)) {
				remarkKeys.add(remarkKey);
				remarks.push({ siteId, ...remark });
			}
		}
		fn.profileSiteIds = siteIds;
	}

	definition.profileSites = sites;
	definition.profileRemarks = remarks;
}
