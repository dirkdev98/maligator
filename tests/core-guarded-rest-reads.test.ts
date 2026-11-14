import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(body: string) {
	return inspectStaticValueFunction(
		`function target(first,...rest){${body}}globalThis.target=target;`,
		"target",
		{ locked: false, realms: true },
	);
}

describe("private static rest read arity guards", () => {
	it.each([
		"return rest[0]+rest[1]+rest[2];",
		"return rest.length;",
		"return first ? rest[0] : rest[3];",
		"const value=rest[0];first();return value+rest[1];",
	])("versions private reads in a small body: %s", (body) => {
		const { core } = inspect(body);
		const count = core.find((operation) => operation.opcode === "loadArgumentCount")!;
		const guard = core.find(
			(operation) =>
				operation.opcode === "binary" && operation.attributes.operator === ">=",
		);
		expect(guard?.inputs).toContain(count.outputs[0]);
		const allocation = core.find(
			(operation) => operation.opcode === "createRestArguments",
		)!;
		expect(allocation).toBeDefined();
		expect(allocation.block).not.toBe(guard!.block);
	});

	it.each([
		"globalThis.saved=rest;return rest[0];",
		"rest[0]=first;return rest[0];",
		"return ()=>rest[0];",
		"while(first--)globalThis.tick();return rest[0];",
		"try{return rest[0]+first();}catch{return rest[1];}",
		`let value=rest[0];${"value=globalThis.effect(value);".repeat(40)}return value;`,
	])(
		"keeps the original body when privacy or bounded copying is unavailable: %s",
		(body) => {
			const { core } = inspect(body);
			expect(core.some((operation) => operation.opcode === "loadArgumentCount")).toBe(
				false,
			);
		},
	);
});
