import type { BytecodeFunction } from "./runtime-image.ts";

/**
 * Marks instructions that lie on a control-flow cycle. Exceptional edges are
 * omitted, so a loop formed only through a handler is not reported; callers may
 * use the result for profitability, never for correctness.
 */
export function bytecodeLoopInstructions(fn: BytecodeFunction): Uint8Array {
	const count = fn.instructions.length;
	const inLoop = new Uint8Array(count);
	const successors = (ip: number): Array<number> => {
		const instruction = fn.instructions[ip]!;
		switch (instruction.opcode) {
			case "JUMP":
				return [instruction.targetIp];
			case "JUMP_IF":
				return [instruction.targetIp, ip + 1];
			case "RETURN":
			case "THROW":
				return [];
			default:
				return [ip + 1];
		}
	};
	const index = new Int32Array(count).fill(-1);
	const lowLink = new Int32Array(count);
	const onStack = new Uint8Array(count);
	const stack: Array<number> = [];
	let next = 0;
	for (let root = 0; root < count; root++) {
		if (index[root] !== -1) continue;
		const frames: Array<{ ip: number; edges: Array<number>; cursor: number }> = [];
		const open = (ip: number) => {
			index[ip] = lowLink[ip] = next++;
			stack.push(ip);
			onStack[ip] = 1;
			frames.push({
				ip,
				edges: successors(ip).filter((target) => target >= 0 && target < count),
				cursor: 0,
			});
		};
		open(root);
		while (frames.length > 0) {
			const frame = frames.at(-1)!;
			if (frame.cursor < frame.edges.length) {
				const target = frame.edges[frame.cursor++]!;
				if (target === frame.ip) inLoop[target] = 1;
				if (index[target] === -1) open(target);
				else if (onStack[target] === 1)
					lowLink[frame.ip] = Math.min(lowLink[frame.ip]!, index[target]!);
				continue;
			}
			frames.pop();
			const parent = frames.at(-1);
			if (parent !== undefined)
				lowLink[parent.ip] = Math.min(lowLink[parent.ip]!, lowLink[frame.ip]!);
			if (lowLink[frame.ip] !== index[frame.ip]) continue;
			const component: Array<number> = [];
			let member: number;
			do {
				member = stack.pop()!;
				onStack[member] = 0;
				component.push(member);
			} while (member !== frame.ip);
			if (component.length > 1) for (const ip of component) inLoop[ip] = 1;
		}
	}
	return inLoop;
}
