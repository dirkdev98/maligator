import { deepStrictEqual, equal } from "node:assert";
import { describe, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { analyzeCoreInterproceduralValueFlow } from "../src/compiler/core/core-ir-interprocedural-flow.ts";
import type { CoreValueId } from "../src/compiler/core/core-ir.ts";
import { analysisProgram } from "./helpers/core-program-analysis.ts";

describe("Core call argument materialization", () => {
	it("preserves empty, positional and repeated arguments independently of receivers", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		const [argument] = builder.appendInstruction(entry, "createUndefined", []);
		builder.appendInstruction(entry, "call", [callee!, receiver!]);
		builder.appendInstruction(entry, "call", [callee!, receiver!, argument!]);
		const [result] = builder.appendInstruction(entry, "call", [
			callee!,
			receiver!,
			argument!,
			argument!,
		]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const fn = program.function(builder.finish(entry).function);
		const flow = analyzeCoreInterproceduralValueFlow(fn);
		deepStrictEqual(
			flow.calls.map((call) => call.arguments),
			[[], [argument!], [argument!, argument!]],
		);
		for (const call of flow.calls) {
			equal(call.callee, callee);
			equal(call.receiver, receiver);
			equal(Object.isFrozen(call.arguments), true);
		}
		deepStrictEqual(flow.statistics, {
			calls: 3,
			positionalCalls: 3,
			aggregateCalls: 0,
			constructs: 0,
		});
	});

	it("copies wide operand slices without leaking the callee or receiver", () => {
		const program = analysisProgram();
		const builder = new CoreFunctionBuilder(program);
		const entry = builder.createBlock();
		const [callee] = builder.appendInstruction(entry, "createUndefined", []);
		const [receiver] = builder.appendInstruction(entry, "createUndefined", []);
		const [argument] = builder.appendInstruction(entry, "createUndefined", []);
		const arguments_ = new Array<CoreValueId>(128).fill(argument!);
		const [result] = builder.appendInstruction(entry, "call", [
			callee!,
			receiver!,
			...arguments_,
		]);
		builder.setTerminator(entry, { kind: "return", value: result! });
		const fn = program.function(builder.finish(entry).function);
		const flow = analyzeCoreInterproceduralValueFlow(fn);
		deepStrictEqual(flow.calls[0]!.arguments, arguments_);
	});
});
