export interface CompilerProfileFrame {
	readonly functionName: string;
	readonly url: string;
	readonly lineNumber: number;
}

export interface CompilerAllocationProfileNode {
	readonly callFrame: CompilerProfileFrame;
	readonly selfSize: number;
	readonly children: ReadonlyArray<CompilerAllocationProfileNode>;
}

export interface CompilerProfileHotspot {
	readonly function: string;
	readonly source: string;
	readonly line: number;
	readonly weight: number;
}

function hotspotKey(frame: CompilerProfileFrame): string {
	return `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}`;
}

function recordHotspot(
	frame: CompilerProfileFrame,
	weight: number,
	weights: Map<string, number>,
	frames: Map<string, CompilerProfileFrame>,
): void {
	const key = hotspotKey(frame);
	weights.set(key, (weights.get(key) ?? 0) + weight);
	frames.set(key, frame);
}

export function topCompilerProfileHotspots(
	weights: ReadonlyMap<string, number>,
	frames: ReadonlyMap<string, CompilerProfileFrame>,
): ReadonlyArray<CompilerProfileHotspot> {
	return Object.freeze(
		[...weights]
			.sort((left, right) => right[1] - left[1])
			.slice(0, 20)
			.map(([key, weight]) => {
				const frame = frames.get(key)!;
				return Object.freeze({
					function: frame.functionName || "(anonymous)",
					source: frame.url,
					line: frame.lineNumber + 1,
					weight,
				});
			}),
	);
}

interface SampledAllocationCollection {
	readonly sampledBytes: number;
	readonly sampledOptimizeCoreBytes: number;
	readonly sampledOptimizeCoreAttributedBytes: number;
}

function collectSampledAllocation(
	node: CompilerAllocationProfileNode,
	repositoryUrlPrefix: string,
	insideOptimizeCore: boolean,
	owner: CompilerProfileFrame | undefined,
	directWeights: Map<string, number>,
	directFrames: Map<string, CompilerProfileFrame>,
	ownerWeights: Map<string, number>,
	ownerFrames: Map<string, CompilerProfileFrame>,
): SampledAllocationCollection {
	const inside = insideOptimizeCore || node.callFrame.functionName === "optimizeCore";
	const currentOwner =
		inside && node.callFrame.url.startsWith(repositoryUrlPrefix) ? node.callFrame : owner;
	let sampledBytes = node.selfSize;
	let sampledOptimizeCoreBytes = inside ? node.selfSize : 0;
	let sampledOptimizeCoreAttributedBytes = 0;
	if (inside && node.selfSize > 0) {
		recordHotspot(node.callFrame, node.selfSize, directWeights, directFrames);
		if (currentOwner !== undefined) {
			recordHotspot(currentOwner, node.selfSize, ownerWeights, ownerFrames);
			sampledOptimizeCoreAttributedBytes += node.selfSize;
		}
	}
	for (const child of node.children) {
		const childSummary = collectSampledAllocation(
			child,
			repositoryUrlPrefix,
			inside,
			currentOwner,
			directWeights,
			directFrames,
			ownerWeights,
			ownerFrames,
		);
		sampledBytes += childSummary.sampledBytes;
		sampledOptimizeCoreBytes += childSummary.sampledOptimizeCoreBytes;
		sampledOptimizeCoreAttributedBytes += childSummary.sampledOptimizeCoreAttributedBytes;
	}
	return { sampledBytes, sampledOptimizeCoreBytes, sampledOptimizeCoreAttributedBytes };
}

export function sampledCompilerAllocationSummary(
	node: CompilerAllocationProfileNode,
	repositoryUrlPrefix: string,
): SampledAllocationCollection & {
	readonly allocationHotspots: ReadonlyArray<CompilerProfileHotspot>;
	readonly allocationOwnerHotspots: ReadonlyArray<CompilerProfileHotspot>;
} {
	const directWeights = new Map<string, number>();
	const directFrames = new Map<string, CompilerProfileFrame>();
	const ownerWeights = new Map<string, number>();
	const ownerFrames = new Map<string, CompilerProfileFrame>();
	return {
		...collectSampledAllocation(
			node,
			repositoryUrlPrefix,
			false,
			undefined,
			directWeights,
			directFrames,
			ownerWeights,
			ownerFrames,
		),
		allocationHotspots: topCompilerProfileHotspots(directWeights, directFrames),
		allocationOwnerHotspots: topCompilerProfileHotspots(ownerWeights, ownerFrames),
	};
}
