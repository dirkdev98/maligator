import { CORE_OPTIMIZATION_OWNER } from "../src/compiler/core/core-optimization-owners.ts";
import type { CoreOptimizationOwnerReport } from "../src/compiler/core/core-optimization-owners.ts";

export interface CompilerOwnerLedgerRow {
	readonly id: number;
	readonly name: string;
	readonly nodeMs: number;
	readonly maligatorMs: number;
	readonly hostRatio: number | null;
	readonly hostGapMs: number;
	readonly workUnits: number;
	readonly nodeNsPerWorkUnit: number | null;
	readonly maligatorNsPerWorkUnit: number | null;
	readonly allocatedBytes?: number;
	readonly collections?: number;
}

function ratio(numerator: number, denominator: number): number | null {
	return denominator === 0 ? null : numerator / denominator;
}

export function compareCompilerOwnerLedgers(
	node: ReadonlyArray<CoreOptimizationOwnerReport>,
	maligator: ReadonlyArray<CoreOptimizationOwnerReport>,
): ReadonlyArray<CompilerOwnerLedgerRow> {
	if (node.length === 0 || maligator.length === 0) {
		throw new Error("compiler owner comparison requires two populated ledgers");
	}
	if (node.length !== maligator.length) {
		throw new Error("compiler owner ledgers have different lengths");
	}
	return Object.freeze(
		node.map((nodeOwner, index) => {
			const maligatorOwner = maligator[index]!;
			if (nodeOwner.id !== index || maligatorOwner.id !== index) {
				throw new Error(`compiler owner ledger has unstable id at index ${index}`);
			}
			if (nodeOwner.name !== maligatorOwner.name) {
				throw new Error(`compiler owner ${index} has different names between hosts`);
			}
			if (nodeOwner.workUnits !== maligatorOwner.workUnits) {
				throw new Error(
					`compiler owner ${index} work differs between hosts: ${nodeOwner.workUnits} != ${maligatorOwner.workUnits}`,
				);
			}
			const workUnits = nodeOwner.workUnits;
			return Object.freeze({
				id: nodeOwner.id,
				name: nodeOwner.name,
				nodeMs: nodeOwner.elapsedMs,
				maligatorMs: maligatorOwner.elapsedMs,
				hostRatio: ratio(maligatorOwner.elapsedMs, nodeOwner.elapsedMs),
				hostGapMs: maligatorOwner.elapsedMs - nodeOwner.elapsedMs,
				workUnits,
				nodeNsPerWorkUnit: ratio(nodeOwner.elapsedMs * 1e6, workUnits),
				maligatorNsPerWorkUnit: ratio(maligatorOwner.elapsedMs * 1e6, workUnits),
				...(maligatorOwner.allocatedBytes === undefined
					? {}
					: { allocatedBytes: maligatorOwner.allocatedBytes }),
				...(maligatorOwner.collections === undefined
					? {}
					: { collections: maligatorOwner.collections }),
			});
		}),
	);
}

export interface CompilerOwnerCoverage {
	readonly nodeOptimizeCore: number;
	readonly maligatorOptimizeCore: number;
	readonly hostGap: number;
	readonly allocation?: number;
}

export function compilerOwnerCoverage(
	owners: ReadonlyArray<CompilerOwnerLedgerRow>,
	totals: {
		readonly nodeOptimizeCoreMs: number;
		readonly maligatorOptimizeCoreMs: number;
		readonly nodeWallMs: number;
		readonly maligatorWallMs: number;
	},
): CompilerOwnerCoverage {
	const optimizeOwners = owners.filter(
		({ id }) =>
			id >= CORE_OPTIMIZATION_OWNER.constructionStructuralCleanup &&
			id <= CORE_OPTIMIZATION_OWNER.coreVerification,
	);
	const attributedOwners = owners.filter(
		({ id }) => id !== CORE_OPTIMIZATION_OWNER.unattributed,
	);
	const nodeOptimizeMs = optimizeOwners.reduce((sum, owner) => sum + owner.nodeMs, 0);
	const maligatorOptimizeMs = optimizeOwners.reduce(
		(sum, owner) => sum + owner.maligatorMs,
		0,
	);
	const attributedHostGapMs = attributedOwners.reduce(
		(sum, owner) => sum + owner.hostGapMs,
		0,
	);
	const allocatedBytes = owners.reduce(
		(sum, owner) => sum + (owner.allocatedBytes ?? 0),
		0,
	);
	const attributedAllocatedBytes = attributedOwners.reduce(
		(sum, owner) => sum + (owner.allocatedBytes ?? 0),
		0,
	);
	return Object.freeze({
		nodeOptimizeCore: ratio(nodeOptimizeMs, totals.nodeOptimizeCoreMs) ?? 0,
		maligatorOptimizeCore:
			ratio(maligatorOptimizeMs, totals.maligatorOptimizeCoreMs) ?? 0,
		hostGap: ratio(attributedHostGapMs, totals.maligatorWallMs - totals.nodeWallMs) ?? 0,
		...(allocatedBytes === 0
			? {}
			: { allocation: attributedAllocatedBytes / allocatedBytes }),
	});
}
