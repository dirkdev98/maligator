import { expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

function inspect(
	body: string,
	options: Parameters<typeof inspectStaticValueFunction>[2] = {},
) {
	return inspectStaticValueFunction(
		`function target(base,...values){${body}} globalThis.target=target;`,
		"target",
		options,
	);
}
const iterate = "let total=base;for(const value of values)total+=value;return total;";

it("lowers a private rest loop to virtual packed reads", () => {
	const output = inspect(iterate);
	expect(output.core.some((op) => op.opcode === "getIterator")).toBe(false);
	expect(
		output.native.instructions.some((plan) => plan?.kind === "virtual-packed-rest-array"),
	).toBe(true);
	expect(
		output.native.instructions.some(
			(plan) => plan?.kind === "exact-packed-rest-array-element",
		),
	).toBe(true);
});

it("keeps rest iteration virtual while forwarding the original arguments", () => {
	const output = inspectStaticValueFunction(
		"function sink(...values){return values.length;} function target(base,...values){let total=base;for(const value of values)total+=value;return sink(...arguments)+total;}globalThis.target=target;",
		"target",
	);
	expect(
		output.native.instructions.some((plan) => plan?.kind === "virtual-packed-rest-array"),
	).toBe(true);
	expect(
		output.native.body.instructions.some((op) => op.opcode === "CALL_REST_ARGUMENTS"),
	).toBe(true);
});

it("updates call summaries when a rest element becomes a callback argument", () => {
	const output = inspect(
		"let total=0;for(const value of values)total+=base(value);return total;",
	);
	expect(
		output.native.instructions.some((plan) => plan?.kind === "virtual-packed-rest-array"),
	).toBe(true);
});

it.each([
	["an escaped rest array", `globalThis.saved=values;${iterate}`],
	["rest writes", `values[1]=base;${iterate}`],
	["a captured rest array", `globalThis.read=()=>values;${iterate}`],
	[
		"multiple iterators",
		"let total=base;for(const value of values)total+=value;for(const value of values)total+=value;return total;",
	],
])("retains %s", (_name, body) => {
	expect(inspect(body).core.some((op) => op.opcode === "getIterator")).toBe(true);
});

it.each([{ locked: false }, { realms: true }])(
	"retains replaceable iterator protocols with %j",
	(options) => {
		expect(inspect(iterate, options).core.some((op) => op.opcode === "getIterator")).toBe(
			true,
		);
	},
);
