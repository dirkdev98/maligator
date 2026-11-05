import { expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

it("selects complete string constants for a bounded Number construction", () => {
	const output = inspectStaticValueFunction(
		"function target(input){return `field${input&7}`;}globalThis.target=target;",
		"target",
	);
	expect(output.core.some((op) => op.opcode === "concatStrings")).toBe(false);
});

it("updates call arguments after selecting a bounded string", () => {
	const output = inspectStaticValueFunction(
		"function target(input,callback){return callback(`field${input&7}`);}globalThis.target=target;",
		"target",
	);
	expect(output.core.some((op) => op.opcode === "concatStrings")).toBe(false);
});

it("uses a branch-refined integer range at the construction", () => {
	const output = inspectStaticValueFunction(
		"function target(input){const value=input|0;if(value>=-2&&value<3)return `branch${value}`;return 'outside';}globalThis.target=target;",
		"target",
	);
	expect(output.core.some((op) => op.opcode === "concatStrings")).toBe(false);
});

it("uses a loop-carried integer range without changing its backedge", () => {
	const output = inspectStaticValueFunction(
		"function target(){const values=[];for(let value=-3;value<4;value++)values.push(`loop${value}`);return values;}globalThis.target=target;",
		"target",
	);
	expect(output.core.some((op) => op.opcode === "concatStrings")).toBe(false);
});

it("selects strings for a range crossing the signed 32-bit boundary", () => {
	const output = inspectStaticValueFunction(
		"function target(){const values=[];for(let value=2147483646;value<2147483654;value++)values.push(`large${value}`);return values;}globalThis.target=target;",
		"target",
	);
	expect(output.core.some((op) => op.opcode === "concatStrings")).toBe(false);
});

it("retains construction whose constant expansion exceeds its text budget", () => {
	const output = inspectStaticValueFunction(
		`function target(input){return \`${"x".repeat(600)}\${input&7}\`;}globalThis.target=target;`,
		"target",
	);
	expect(output.core.some((op) => op.opcode === "concatStrings")).toBe(true);
});

it.each(["input", "input&255", "input/2"])(
	"retains construction outside a small integral domain: %s",
	(expression) => {
		const output = inspectStaticValueFunction(
			`function target(input){return \`field\${${expression}}\`;}globalThis.target=target;`,
			"target",
		);
		expect(output.core.some((op) => op.opcode === "concatStrings")).toBe(true);
	},
);
