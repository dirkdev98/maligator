import type { CoreTargetBlockOrderSpan, CoreTargetFunction } from "./core-target-ir.ts";

export function layoutNativeBlocks(
	blocks: CoreTargetFunction["blocks"],
	coreBlockCount: number,
	orderedSpans: ReadonlyArray<CoreTargetBlockOrderSpan>,
): ReadonlyArray<number> {
	const spans: Array<{ first: number; last: number }> = [];
	for (const span of [...orderedSpans].sort(
		(left, right) => left.first - right.first || left.last - right.last,
	)) {
		if (
			!Number.isInteger(span.first) ||
			!Number.isInteger(span.last) ||
			span.first < 0 ||
			span.last < span.first ||
			span.last >= coreBlockCount
		)
			throw new Error("Invalid native block-order span");
		const previous = spans.at(-1);
		if (previous !== undefined && span.first <= previous.last)
			previous.last = Math.max(previous.last, span.last);
		else spans.push({ ...span });
	}
	const defaultSuccessor = (block: number): number | undefined => {
		const last = blocks[block]!.instructions.findLast(
			(instruction) => instruction.type !== "sourcePos" && instruction.type !== "tryEnd",
		);
		return last?.type === "jump" ? last.blocks[0] : undefined;
	};
	const predecessors = new Uint32Array(blocks.length);
	for (const { instructions } of blocks)
		for (const instruction of instructions)
			if (instruction.type === "jump" || instruction.type === "jumpIf")
				predecessors[instruction.blocks[0]]!++;
	const units: Array<Array<number>> = [];
	const unitForBlock = new Int32Array(blocks.length).fill(-1);
	const spanEnds = new Map(spans.map(({ first, last }) => [first, last]));
	for (let block = 0; block < coreBlockCount;) {
		const last = spanEnds.get(block) ?? block;
		const unit: Array<number> = [];
		for (; block <= last; block++) {
			unitForBlock[block] = units.length;
			unit.push(block);
			const target = defaultSuccessor(block);
			// Only the predecessor's private copy block may intervene inside a certificate span.
			if (
				target !== undefined &&
				target >= coreBlockCount &&
				predecessors[target] === 1 &&
				unitForBlock[target] === -1
			) {
				unitForBlock[target] = units.length;
				unit.push(target);
			}
		}
		units.push(unit);
	}
	for (let block = coreBlockCount; block < blocks.length; block++) {
		if (unitForBlock[block] !== -1) continue;
		unitForBlock[block] = units.length;
		units.push([block]);
	}
	const order: Array<number> = [];
	const placed = new Uint8Array(units.length);
	for (let start = 0; start < units.length; start++) {
		let unit = start;
		while (!placed[unit]) {
			placed[unit] = 1;
			for (const block of units[unit]!) order.push(block);
			const successor = defaultSuccessor(units[unit]!.at(-1)!);
			if (successor === undefined) break;
			const next = unitForBlock[successor]!;
			if (units[next]![0] !== successor) break;
			unit = next;
		}
	}
	return order;
}
