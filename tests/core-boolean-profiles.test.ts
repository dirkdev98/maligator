import { describe, expect, it } from "vitest";
import { getPrimordialCatalog } from "../src/compiler/shared/primordial-catalog-data.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const conversions = [
	"Boolean(x)",
	"new Boolean(x)",
	"Boolean.prototype.valueOf.call(!!x)",
] as const;

const ignoredProfiles = [
	["unused", (expression: string) => `${expression};return 1;`],
	["branch", (expression: string) => `if(y){${expression};}return 1;`],
	["loop", (expression: string) => `for(let i=0;i<y;i++){${expression};}return 1;`],
	["finally", (expression: string) => `try{${expression};}finally{y();}return 1;`],
	["suspension", (expression: string) => `yield y();${expression};return 1;`],
	["repeated", (expression: string) => `${`${expression};`.repeat(32)}return 1;`],
] as const;

function inspect(body: string, locked = true, generator = false) {
	return inspectStaticValueFunction(
		`function${generator ? "*" : ""} target(x,y){${body}}globalThis.target=target;`,
		"target",
		{ locked },
	);
}

describe("Boolean constructor input normalization", () => {
	it.each([
		["{}", true],
		["{value:!!x}", true],
		["[!!x]", true],
		["function(){}", true],
		["Symbol.iterator", true],
		["new Boolean(false)", true],
		["0", false],
		["-0", false],
		["NaN", false],
		["null", false],
		["undefined", false],
		['""', false],
		['"value"', true],
		["0n", false],
		["7n", true],
	] as const)(
		"normalizes %s while retaining the fresh Boolean wrapper",
		(input, value) => {
			const output = inspect(`return new Boolean(${input});`);
			expect(output.structure.allocations).toBe(0);
			const calls = output.core.filter((operation) => operation.opcode === "callKnown");
			expect(calls).toHaveLength(1);
			expect(calls[0]!.attributes).toMatchObject({
				operation: "Boolean",
				construct: true,
			});
			const payload = calls[0]!.inputs[1];
			expect(
				output.core.find((operation) => operation.outputs.includes(payload!)),
			).toMatchObject({
				opcode: "createBoolean",
				attributes: { value },
			});
		},
	);
	it.each([
		"return new Boolean({},x());",
		"return new Boolean({[x]:y()});",
		"return Reflect.construct(Boolean,[{},y()],x);",
	])("eliminates the private constructor input after effects in %s", (body) => {
		const output = inspect(body);
		expect(output.structure.allocations).toBe(0);
		expect(output.structure.genericCalls).toBe(1);
		expect(output.core.some((operation) => operation.attributes.construct === true)).toBe(
			true,
		);
		expect(inspect(body, false).structure.allocations).toBeGreaterThan(0);
	});
	it("retains escaping constructor input identities", () => {
		const output = inspect("const input={};x(input);return new Boolean(input);");
		expect(output.structure.allocations).toBe(1);
		expect(output.structure.genericCalls).toBe(1);
		expect(output.core.some((operation) => operation.attributes.construct === true)).toBe(
			true,
		);
	});
	it("retains unknown constructor input truthiness", () => {
		const output = inspect("return new Boolean(x);");
		expect(output.core.some((operation) => operation.opcode === "createBoolean")).toBe(
			false,
		);
		expect(output.core.some((operation) => operation.attributes.construct === true)).toBe(
			true,
		);
	});
	it("eliminates private input across a suspended extra constructor argument", () => {
		const output = inspect("return new Boolean({},yield x());", true, true);
		expect(output.structure.allocations).toBe(0);
		expect(output.core.some((operation) => operation.opcode === "yield")).toBe(true);
		expect(output.core.some((operation) => operation.attributes.construct === true)).toBe(
			true,
		);
	});
});

describe("empty-object Boolean inputs", () => {
	it.each([
		"return Boolean({});",
		"return Boolean({},x());",
		"const object={};x();return Boolean(object);",
		"return Boolean({get value(){return x();}});",
		"Boolean({},x());return 1;",
		"for(let i=0;i<x;i++)y(Boolean({}));return 1;",
	])("eliminates private input materialization in %s", (body) => {
		const output = inspect(body);
		expect(output.structure.allocations).toBe(0);
		expect(inspect(body, false).structure.allocations).toBeGreaterThan(0);
	});
	it("preserves ignored argument effects after eliminating an empty input", () => {
		const output = inspect("return Boolean({},x());");
		expect(output.structure.genericCalls).toBe(1);
		expect(output.core.some((operation) => operation.opcode === "createBoolean")).toBe(
			true,
		);
	});
	it("eliminates empty input across an ignored suspended argument", () => {
		const body = "return Boolean({},yield x());";
		const output = inspect(body, true, true);
		expect(output.structure.allocations).toBe(0);
		expect(output.structure.genericCalls).toBe(1);
		expect(output.core.some((operation) => operation.opcode === "yield")).toBe(true);
		expect(inspect(body, false, true).structure.allocations).toBe(1);
	});
	it.each([true, false])(
		"folds distinct empty-object identities when locked=%s",
		(locked) => {
			const output = inspect("return {} === {};", locked);
			expect(output.structure.allocations).toBe(0);
			expect(output.core).toHaveLength(1);
			expect(output.core[0]).toMatchObject({
				opcode: "createBoolean",
				attributes: { value: false },
			});
		},
	);
	it.each([
		"return {};",
		"const object={};x(object);return Boolean(object);",
		"const object={};object.value=x;return object;",
		"const object={};Object.setPrototypeOf(object,x);return object.value;",
		"const object={};Object.defineProperty(object,'value',{get:x});return object.value;",
	])("retains observable object state in %s", (body) => {
		expect(inspect(body).structure.allocations).toBeGreaterThan(0);
	});
});

describe("mutable Boolean call guards", () => {
	it.each([
		["Boolean(x,y())", "Boolean"],
		["globalThis.Boolean(x,y())", "Boolean"],
		["(!!x).valueOf(y())", "Boolean.prototype.valueOf"],
		["(!!x).toString(y())", "Boolean.prototype.toString"],
	])(
		"guards %s while retaining the original call and argument effects",
		(expression, operation) => {
			const output = inspect(`return ${expression};`, false);
			const calls = output.fn.instructions.filter(
				(instruction) => instruction.opcode === "CALL",
			);
			expect(calls).toHaveLength(2);
			expect(calls.map((call) => call.guardedBuiltinCall?.operation)).toContain(
				operation,
			);
			expect(output.c.source).toContain("mal_builtin_boolean_callee_matches(");
			expect(output.c.source).toContain("mal_vm_call_cached(");
			const restored = deserializeCompilerArtifact(
				serializeCompilerArtifact(output.image),
			);
			expect(restored.runtime.functions).toEqual(output.image.runtime.functions);
		},
	);
	it.each(["Boolean()", "Boolean(x,1,2,3,4)"])(
		"retains the argument count at %s",
		(expression) => {
			const output = inspect(`return ${expression};`, false);
			const call = output.fn.instructions.find(
				(instruction) => instruction.opcode === "CALL",
			);
			expect(call?.guardedBuiltinCall?.operation).toBe("Boolean");
			expect(call?.argumentCount).toBe(expression === "Boolean()" ? 0 : 5);
		},
	);
	it.each(["new Boolean(x)", "x.toString(y())", "x.valueOf(y())"])(
		"keeps %s outside primitive call admission",
		(expression) => {
			expect(inspect(`return ${expression};`, false).c.source).not.toContain(
				"mal_builtin_boolean_callee_matches(",
			);
		},
	);
	it("does not infer a builtin from a shadowed lexical binding", () => {
		const output = inspect("const Boolean=y; return Boolean(x);", false);
		expect(output.c.source).not.toContain("mal_builtin_boolean_callee_matches(");
	});
	it("retains a loaded Boolean callee across suspension", () => {
		const output = inspect("return Boolean(x,yield y());", false, true);
		expect(
			output.fn.instructions.some(
				(instruction) =>
					instruction.opcode === "CALL" &&
					instruction.guardedBuiltinCall?.operation === "Boolean",
			),
		).toBe(true);
		expect(output.c.source).toContain("mal_vm_call_cached(");
	});
});

describe("Boolean method observation profiles", () => {
	it.each(["valueOf", "toString"])(
		"resolves the canonical %s function from a dynamic Boolean receiver",
		(method) => {
			const output = inspect(`return (!!x).${method};`);
			expect(output.core).toHaveLength(1);
			expect(output.core[0]!.opcode).toBe("loadPrimordial");
			expect(
				getPrimordialCatalog().nodes[output.core[0]!.attributes.nodeIndex as number]?.[0],
			).toBe(`Boolean.prototype.${method}`);
			const mutable = inspect(`return (!!x).${method};`, false);
			expect(mutable.structure.genericLookups).toBeGreaterThan(0);
		},
	);

	it.each(["valueOf", "toString"])(
		"folds %s on a static receiver after evaluating an ignored dynamic argument",
		(method) => {
			const output = inspect(`return Boolean.prototype.${method}.call(false,x());`);
			expect(output.structure.genericCalls).toBe(1);
			expect(output.structure.genericLookups).toBe(0);
			expect(output.structure.allocations).toBe(0);
			expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(
				false,
			);
			expect(
				output.core.filter(
					(operation) =>
						operation.opcode ===
						(method === "valueOf" ? "createBoolean" : "createString"),
				),
			).toHaveLength(1);
			const mutable = inspect(
				`return Boolean.prototype.${method}.call(false,x());`,
				false,
			);
			expect(mutable.structure.genericCalls).toBeGreaterThan(1);
		},
	);

	it.each(["valueOf", "toString"])(
		"specializes dynamic Boolean %s while preserving argument effects",
		(method) => {
			const output = inspect(`return (!!x).${method}(y());`);
			expect(output.structure.genericCalls).toBe(1);
			expect(output.structure.genericLookups).toBe(0);
			expect(output.structure.allocations).toBe(0);
			expect(output.core.some((operation) => operation.opcode === "callKnown")).toBe(
				false,
			);
			const unknown = inspect(`return x.${method}(y());`);
			expect(unknown.structure.genericCalls).toBe(2);
			expect(unknown.structure.genericLookups).toBeGreaterThan(0);
		},
	);
});

describe("Boolean dead result profiles", () => {
	for (const [profile, body] of ignoredProfiles) {
		it.each(conversions)(`removes ignored ${profile} conversion %s`, (expression) => {
			const output = inspect(body(expression), true, profile === "suspension");
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "unary" && operation.attributes.operator === "!",
				),
			).toBe(false);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "callKnown" || operation.opcode === "construct",
				),
			).toBe(false);
			expect(output.structure.genericCalls).toBe(
				profile === "finally" || profile === "suspension" ? 1 : 0,
			);
			expect(output.structure.allocations).toBe(0);
		});
	}

	it.each(conversions)("retains effectful inputs to ignored %s", (expression) => {
		const output = inspect(`${expression.replaceAll("x", "x()")};y();return 1;`);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "!",
			),
		).toBe(false);
		expect(output.structure.genericCalls).toBe(2);
	});

	it.each(conversions)("retains mutable targets for ignored %s", (expression) => {
		const output = inspect(`${expression};return 1;`, false);
		expect(
			output.structure.genericCalls +
				output.core.filter((operation) => operation.opcode === "construct").length,
		).toBeGreaterThan(0);
	});

	it.each([
		"Boolean.prototype.valueOf.call(x)",
		"Boolean.prototype.toString.call(x)",
		"+x",
		"-x",
		"~x",
	])("retains brand checks or numeric coercion in ignored %s", (expression) => {
		const output = inspect(`${expression};return 1;`);
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "callKnown" ||
					operation.opcode === "unary" ||
					operation.opcode === "toNumber",
			),
		).toBe(true);
	});

	it("retains the TDZ check when discarding an unread truthiness result", () => {
		const output = inspect("!value;let value=x;return 1;");
		expect(output.core.some((operation) => operation.opcode === "throwIfTdz")).toBe(true);
		expect(output.core.some((operation) => operation.opcode === "unary")).toBe(false);
	});

	it("retains a demanded logical negation", () => {
		const output = inspect("return !x;");
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "unary" && operation.attributes.operator === "!",
			),
		).toBe(true);
	});
});

describe("noncoercing unary reuse", () => {
	it.each(["!x", "typeof x", "Boolean(x)"])(
		"reuses %s across an intervening callback",
		(expression) => {
			const output = inspect(
				`const first=${expression};y();return y(first,${expression});`,
			);
			const operations = output.core.filter((operation) => operation.opcode === "unary");
			expect(operations).toHaveLength(expression === "Boolean(x)" ? 2 : 1);
			expect(output.structure.genericCalls).toBe(2);
			const calls = output.core.filter((operation) => operation.opcode === "call");
			expect(calls.at(-1)!.inputs.slice(-2)[0]).toBe(calls.at(-1)!.inputs.slice(-2)[1]);
		},
	);

	it.each(["-x", "+x", "~x"])(
		"does not reuse coercing %s across a callback",
		(expression) => {
			const output = inspect(
				`const first=${expression};y();return y(first,${expression});`,
			);
			const calls = output.core.filter((operation) => operation.opcode === "call");
			expect(calls.at(-1)!.inputs.slice(-2)[0]).not.toBe(
				calls.at(-1)!.inputs.slice(-2)[1],
			);
		},
	);

	it("keeps separate Boolean inputs and mutable conversion calls", () => {
		const distinct = inspect("return y(Boolean(x),Boolean(y));");
		expect(
			distinct.core.filter((operation) => operation.opcode === "unary"),
		).toHaveLength(4);
		const mutable = inspect(
			"const first=Boolean(x);y();return y(first,Boolean(x));",
			false,
		);
		expect(mutable.structure.genericCalls).toBe(4);
	});
});

describe("Boolean constant observations", () => {
	for (const expression of [
		"Boolean(x)",
		"new Boolean(x).valueOf()",
		"Boolean.prototype.valueOf.call(!!x)",
		"(!!x).valueOf()",
	]) {
		it.each(["===", "!==", "==", "!="])(
			`folds repeated ${expression} observations with %s`,
			(operator) => {
				const output = inspect(
					`const first=${expression};y();return first${operator}${expression};`,
				);
				expect(output.structure.genericCalls).toBe(1);
				expect(output.structure.allocations).toBe(0);
				expect(
					output.core.some((operation) =>
						["unary", "binary", "callKnown", "construct"].includes(operation.opcode),
					),
				).toBe(false);
				expect(
					output.core
						.filter((operation) => operation.opcode === "createBoolean")
						.map((operation) => operation.attributes.value),
				).toEqual([operator === "===" || operator === "=="]);
			},
		);
	}

	it.each(["Boolean(x)", "String(x)"])(
		"retains mutable %s self-comparisons that may observe NaN",
		(expression) => {
			const output = inspect(`const value=${expression};return value===value;`, false);
			expect(output.structure.genericCalls).toBeGreaterThan(0);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "===",
				),
			).toBe(true);
		},
	);

	it.each(["x", "+x", "Number(x)", "x?true:NaN"])(
		"retains the possible NaN result of %s",
		(expression) => {
			const output = inspect(`const value=${expression};return value===value;`);
			expect(
				output.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "===",
				),
			).toBe(true);
		},
	);

	it("folds a string self-comparison while retaining its input conversion", () => {
		const output = inspect("const value=String(x);y();return value===value;");
		expect(
			output.core.some(
				(operation) =>
					operation.opcode === "callKnown" && operation.attributes.operation === "String",
			),
		).toBe(true);
		expect(output.structure.genericCalls).toBe(1);
		expect(output.core.some((operation) => operation.opcode === "binary")).toBe(false);
	});

	it("folds a Boolean self-comparison across suspension", () => {
		const output = inspect(
			"const value=Boolean(x);yield y();return value===value;",
			true,
			true,
		);
		expect(output.core.some((operation) => operation.opcode === "yield")).toBe(true);
		expect(output.core.some((operation) => operation.opcode === "unary")).toBe(false);
		expect(output.structure.genericCalls).toBe(1);
	});

	it.each([
		"{value:!!x}",
		"[!!x]",
		"{value:x()}",
		"[x()]",
		"{first:x(),second:y()}",
		"[x(),y()]",
	])("consumes only the truthiness of %s without materialization", (expression) => {
		const output = inspect(`return Boolean(${expression});`);
		expect(output.structure.allocations).toBe(0);
		expect(
			output.core.some(
				(operation) => operation.opcode === "unary" || operation.opcode === "callKnown",
			),
		).toBe(false);
		expect(output.structure.genericCalls).toBe(
			(expression.match(/[xy]\(\)/g) ?? []).length,
		);
		expect(
			output.core
				.filter((operation) => operation.opcode === "createBoolean")
				.map((operation) => operation.attributes.value),
		).toEqual([true]);
	});

	it.each(["{value:!!x}", "[!!x]"])(
		"retains escaped %s identity and mutable conversion targets",
		(expression) => {
			const escaped = inspect(
				`const value=${expression};y(value);return Boolean(value);`,
			);
			expect(escaped.structure.allocations).toBe(1);
			expect(escaped.structure.genericCalls).toBe(1);
			const mutable = inspect(`return Boolean(${expression});`, false);
			expect(mutable.structure.allocations).toBe(1);
			expect(mutable.structure.genericCalls).toBe(1);
		},
	);
});
