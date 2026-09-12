import { deepStrictEqual, equal } from "node:assert";
import { describe, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreLocalExceptionFlows } from "../src/compiler/core/core-ir-exception-flow.ts";
import type { CoreBlockId } from "../src/compiler/core/core-ir.ts";
import { analysisProgram } from "./helpers/core-program-analysis.ts";

function sharedHandler(
	mode: "throws" | "returning-owner" | "ordinary-predecessor",
	count = 4,
) {
	const program = analysisProgram();
	const builder = new CoreFunctionBuilder(program);
	const entry = builder.createBlock();
	const handler = builder.createBlock([
		{ role: "exception", representation: "boxed" },
		{ representation: "boxed" },
	]);
	const sources = Array.from({ length: count }, () => builder.createBlock());
	const [value] = builder.appendInstruction(entry, "createUndefined", []);
	const [payload] = builder.appendInstruction(entry, "createUndefined", []);
	const [condition] = builder.appendInstruction(entry, "createBoolean", [], {
		attributes: { value: true },
	});
	for (const [index, source] of sources.entries()) {
		builder.setHandler(source, handler, [payload!]);
		builder.setTerminator(source, {
			kind: mode === "returning-owner" && index === count - 1 ? "return" : "throw",
			value: value!,
		});
	}
	builder.setTerminator(handler, {
		kind: "return",
		value: builder.blockParameterValue(handler, 0),
	});
	const targets = mode === "ordinary-predecessor" ? [...sources, handler] : sources;
	const edge = (block: CoreBlockId) => ({
		block,
		arguments: block === handler ? [value!, payload!] : [],
	});
	let dispatch = entry;
	for (let index = 0; index < targets.length - 2; index++) {
		const next = builder.createBlock();
		builder.setTerminator(dispatch, {
			kind: "branch",
			condition: condition!,
			consequent: edge(targets[index]!),
			alternate: edge(next),
		});
		dispatch = next;
	}
	builder.setTerminator(dispatch, {
		kind: "branch",
		condition: condition!,
		consequent: edge(targets[targets.length - 2]!),
		alternate: edge(targets[targets.length - 1]!),
	});
	const fn = program.function(builder.finish(entry).function);
	const cfg = buildCoreControlFlow(program, fn.id, { exceptions: true });
	return { fn, cfg, sources, handler, value, payload };
}

describe("Core shared exception-handler eligibility", () => {
	it("preserves every qualifying throw and handler argument in a large fan-in", () => {
		const fixture = sharedHandler("throws", 64);
		const flows = analyzeCoreLocalExceptionFlows(fixture.fn, fixture.cfg);
		deepStrictEqual(new Set(flows.map((flow) => flow.source)), new Set(fixture.sources));
		for (const flow of flows) {
			equal(flow.handler, fixture.handler);
			equal(flow.thrownValue, fixture.value);
			deepStrictEqual(flow.handlerArguments, [fixture.payload!]);
		}
		equal(Object.isFrozen(flows), true);
	});

	it("rejects all candidates when a handler has a nonqualifying owner", () => {
		const { fn, cfg } = sharedHandler("returning-owner");
		deepStrictEqual(analyzeCoreLocalExceptionFlows(fn, cfg), []);
	});

	it("rejects an ordinary predecessor even when all handler owners qualify", () => {
		const { fn, cfg } = sharedHandler("ordinary-predecessor");
		deepStrictEqual(analyzeCoreLocalExceptionFlows(fn, cfg), []);
	});
});
