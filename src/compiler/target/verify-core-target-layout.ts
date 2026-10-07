import type { CoreTargetBlockOrderSpan, CoreTargetFunction } from "./core-target-ir.ts";

export function verifyCoreTargetBlockLayout(
	blocks: CoreTargetFunction["blocks"],
	coreBlockCount: number,
	orderedSpans: ReadonlyArray<CoreTargetBlockOrderSpan>,
	order: ReadonlyArray<number>,
): void {
	if (
		order.length !== blocks.length ||
		order[0] !== 0 ||
		new Set(order).size !== blocks.length ||
		order.some((block) => !Number.isInteger(block) || block < 0 || block >= blocks.length)
	)
		throw new Error(
			"Target block layout must be a permutation retaining entry block zero",
		);
	const positions = new Map(order.map((block, index) => [block, index]));
	const predecessors = new Uint32Array(blocks.length);
	for (const { instructions } of blocks)
		for (const instruction of instructions)
			if (instruction.type === "jump" || instruction.type === "jumpIf")
				predecessors[instruction.blocks[0]]!++;
	for (const span of orderedSpans) {
		if (
			!Number.isInteger(span.first) ||
			!Number.isInteger(span.last) ||
			span.first < 0 ||
			span.last < span.first ||
			span.last >= coreBlockCount
		)
			throw new Error("Invalid target block-order span");
		let position = positions.get(span.first)!;
		for (let block = span.first; block <= span.last; block++) {
			if (order[position] !== block)
				throw new Error("Target block layout reordered or split a certificate span");
			if (block === span.last) break;
			let previous = order[position++]!;
			while (order[position]! >= coreBlockCount) {
				const copy = order[position]!;
				const instructions = blocks[copy]!.instructions;
				const jump = blocks[previous]!.instructions.findLast(
					(instruction) =>
						instruction.type !== "sourcePos" && instruction.type !== "tryEnd",
				);
				if (
					predecessors[copy] !== 1 ||
					jump?.type !== "jump" ||
					jump.blocks[0] !== copy ||
					instructions.at(-1)?.type !== "jump" ||
					instructions.slice(0, -1).some((instruction) => instruction.type !== "move")
				)
					throw new Error("Target certificate span contains an unrelated copy block");
				previous = copy;
				position++;
			}
		}
	}
}
