import type { CoreTargetFunction } from "./core-target-ir.ts";

export function layoutNativeBlocks(
	blocks: CoreTargetFunction["blocks"],
	coreBlockCount: number,
	preserveCoreOrder: boolean,
): ReadonlyArray<number> {
	if (!preserveCoreOrder) {
		const order: Array<number> = [];
		const placed = new Uint8Array(blocks.length);
		for (let start = 0; start < blocks.length; start++) {
			let block = start;
			while (!placed[block]) {
				order.push(block);
				placed[block] = 1;
				const last = blocks[block]!.instructions.findLast(
					(instruction) =>
						instruction.type !== "sourcePos" && instruction.type !== "tryEnd",
				);
				if (last?.type !== "jump") break;
				block = last.blocks[0];
			}
		}
		return order;
	}
	const predecessors = new Uint32Array(blocks.length);
	for (const { instructions } of blocks)
		for (const instruction of instructions)
			if (instruction.type === "jump" || instruction.type === "jumpIf")
				predecessors[instruction.blocks[0]]!++;
	const order: Array<number> = [];
	const placed = new Uint8Array(blocks.length);
	for (let block = 0; block < coreBlockCount; block++) {
		order.push(block);
		placed[block] = 1;
		const last = blocks[block]!.instructions.findLast(
			(instruction) => instruction.type !== "sourcePos" && instruction.type !== "tryEnd",
		);
		if (last?.type !== "jump") continue;
		const target = last.blocks[0];
		if (target < coreBlockCount || predecessors[target] !== 1 || placed[target]) continue;
		order.push(target);
		placed[target] = 1;
	}
	// Region contracts still depend on Core block order; only edge-copy blocks move.
	for (let block = coreBlockCount; block < blocks.length; block++)
		if (!placed[block]) order.push(block);
	return order;
}
