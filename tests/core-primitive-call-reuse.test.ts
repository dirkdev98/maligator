import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const methods = [
	["Boolean.prototype.valueOf", "Boolean.prototype.valueOf", ""],
	["Boolean.prototype.toString", "Boolean.prototype.toString", ""],
	["Number.prototype.valueOf", "Number.prototype.valueOf", ""],
	["Number.prototype.toString", "Number.prototype.toString", ", 16"],
	["Number.prototype.toFixed", "Number.prototype.toFixed", ", 2"],
	["Number.prototype.toExponential", "Number.prototype.toExponential", ", 3"],
	["Number.prototype.toPrecision", "Number.prototype.toPrecision", ", 4"],
	["String.prototype.valueOf", "String.prototype.valueOf", ""],
	["String.prototype.toString", "String.prototype.toString", ""],
	["BigInt.prototype.valueOf", "BigInt.prototype.valueOf", ""],
	["BigInt.prototype.toString", "BigInt.prototype.toString", ", 16"],
	["Symbol.prototype.valueOf", "Symbol.prototype.valueOf", ""],
	["Symbol.prototype.toString", "Symbol.prototype.toString", ""],
	[
		"Symbol.prototype[%Symbol.toPrimitive%]",
		"Symbol.prototype[Symbol.toPrimitive]",
		", y",
	],
	[
		"Symbol.prototype.description<get>",
		"Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get",
		"",
	],
] as const;
function inspect(body: string, locked = true) {
	return inspectStaticValueFunction(
		`function target(x,y,z){${body}}globalThis.target=target;`,
		"target",
		{ locked },
	);
}
function calls(result: ReturnType<typeof inspect>, operation: string) {
	return result.core.filter((item) => item.attributes.operation === operation);
}
for (const [operation, method, args] of methods) {
	describe(operation, () => {
		it("reuses an immutable receiver slot across an effectful call", () => {
			const result = inspect(
				`const a=${method}.call(x${args});y(x);const b=${method}.call(x${args});return[a,b];`,
			);
			expect(calls(result, operation)).toHaveLength(1);
			expect(result.structure.genericCalls).toBe(1);
		});
		it("retains the first potentially throwing receiver check when the results are unused", () => {
			const result = inspect(
				`${method}.call(x${args});${method}.call(x${args});return 0;`,
			);
			expect(calls(result, operation)).toHaveLength(1);
		});
		it("reuses successful reads in known comparison consumers", () => {
			const result = inspect(
				`return Object.is(${method}.call(x${args}),${method}.call(x${args}));`,
			);
			expect(calls(result, operation)).toHaveLength(1);
		});
		it("reuses strict reads inside a dynamic loop", () => {
			const result = inspect(
				`let a;for(let i=0;i<z;i++){a=${method}.call(x${args});y(a);y(${method}.call(x${args}));}return a;`,
			);
			expect(calls(result, operation)).toHaveLength(1);
		});
		it.each(["apply", "reflect", "bind"])(
			"reuses strict reads through %s adapters",
			(adapter) => {
				const parameters = args === "" ? "" : args.slice(2);
				const expression =
					adapter === "apply"
						? `${method}.apply(x,[${parameters}])`
						: adapter === "reflect"
							? `Reflect.apply(${method},x,[${parameters}])`
							: `${method}.bind(x${args})()`;
				const result = inspect(
					`const a=${expression};y(x);const b=${expression};return[a,b];`,
				);
				expect(calls(result, operation)).toHaveLength(1);
			},
		);
		it("discards a proven wrapper read after preserving its escape", () => {
			const family = operation.split(".")[0]!;
			const producer =
				family === "BigInt"
					? "Object(BigInt(x))"
					: family === "Symbol"
						? "Object(Symbol.for(x))"
						: `new ${family}(x)`;
			const result = inspect(
				`const value=${producer};y(value);${method}.call(value${args});return 0;`,
			);
			expect(calls(result, operation)).toHaveLength(0);
			expect(result.structure.genericCalls).toBe(1);
		});
		it("preserves an escaping ordinary object before a known receiver failure", () => {
			const result = inspect(
				`const value={field:x};y(value);return ${method}.call(value${args});`,
			);
			expect(result.structure.genericCalls).toBe(1);
			expect(
				result.core
					.filter((item) => item.opcode === "builtinError")
					.map((item) => item.attributes.error),
			).toContain(`${operation.split(".")[0]!.toLowerCase()}Receiver`);
		});
		it.each([false, true])(
			"does not infer one wrapper brand across a mixed join with reversed arms %s",
			(reverse) => {
				const family = operation.split(".")[0]!;
				const proper =
					family === "BigInt"
						? "Object(BigInt(x))"
						: family === "Symbol"
							? "Object(Symbol(x))"
							: `new ${family}(x)`;
				const wrong = family === "Number" ? "new Boolean(x)" : "new Number(x)";
				const result = inspect(
					`const value=z?${reverse ? wrong : proper}:${reverse ? proper : wrong};y(value);return ${method}.call(value${args});`,
				);
				expect(result.core.some((item) => item.opcode === "builtinError")).toBe(false);
				expect(calls(result, operation)).toHaveLength(1);
			},
		);
		it.each(["Boolean", "Number", "String", "BigInt", "Symbol"])(
			"observes the exact private slot contract of %s.prototype",
			(family) => {
				const result = inspect(`return ${method}.call(${family}.prototype${args});`);
				expect(calls(result, operation)).toHaveLength(0);
				const errors = result.core
					.filter((item) => item.opcode === "builtinError")
					.map((item) => item.attributes.error);
				if (
					["Boolean", "Number", "String"].includes(family) &&
					operation.startsWith(`${family}.prototype`)
				)
					expect(errors).toHaveLength(0);
				else
					expect(errors).toEqual([`${operation.split(".")[0]!.toLowerCase()}Receiver`]);
			},
		);
		it("retains mutable prototype identity when reading its private slot", () => {
			const family = operation.split(".")[0]!;
			const result = inspect(`return ${method}.call(${family}.prototype${args});`, false);
			expect(result.structure.genericCalls).toBeGreaterThan(0);
		});
		it("does not reuse a different receiver's slot", () => {
			const result = inspect(
				`const a=${method}.call(x${args});const b=${method}.call(z${args});return[a,b];`,
			);
			expect(calls(result, operation)).toHaveLength(2);
		});
		it("keeps mutable descriptor and method lookup", () => {
			const result = inspect(
				`const a=${method}.call(x${args});y(x);const b=${method}.call(x${args});return[a,b];`,
				false,
			);
			expect(result.structure.genericCalls).toBeGreaterThanOrEqual(3);
		});
		it.each(["{}", "[]", "()=>0", "Object.create(null)"])(
			"residualizes an incompatible %s receiver without invoking its coercion hooks",
			(receiver) => {
				const result = inspect(`return ${method}.call(${receiver}${args});`);
				expect(
					result.core
						.filter((item) => item.opcode === "builtinError")
						.map((item) => item.attributes.error),
				).toContain(`${operation.split(".")[0]!.toLowerCase()}Receiver`);
				expect(calls(result, operation)).toHaveLength(0);
			},
		);
	});
}

describe("strict wrapper checks and coercing methods", () => {
	it.each([
		"Number.prototype.toString",
		"Number.prototype.toFixed",
		"Number.prototype.toExponential",
		"Number.prototype.toPrecision",
		"BigInt.prototype.toString",
	])("retains repeated argument coercion for %s", (method) => {
		const result = inspect(
			`const a=${method}.call(x,y);const b=${method}.call(x,y);return[a,b];`,
		);
		expect(calls(result, method)).toHaveLength(2);
	});
	it.each([
		"String.prototype.trim",
		"String.prototype.charAt",
		"String.prototype.toLowerCase",
	])("retains repeated receiver coercion for %s", (method) => {
		const result = inspect(
			`const a=${method}.call(x);const b=${method}.call(x);return[a,b];`,
		);
		expect(calls(result, method)).toHaveLength(2);
	});
	it("keeps effects in ignored Symbol conversion hints", () => {
		const result = inspect(
			"const a=Symbol.prototype[Symbol.toPrimitive].call(x,y());const b=Symbol.prototype[Symbol.toPrimitive].call(x,y());return[a,b];",
		);
		expect(calls(result, "Symbol.prototype[%Symbol.toPrimitive%]")).toHaveLength(1);
		expect(result.structure.genericCalls).toBe(2);
	});
	it("does not conflate fresh Symbol results", () => {
		const result = inspect("return[Symbol(x),Symbol(x)];");
		expect(calls(result, "Symbol")).toHaveLength(2);
	});
	it("does not reuse an ordinary overridden valueOf call", () => {
		const result = inspect("const a=x.valueOf();y(x);const b=x.valueOf();return[a,b];");
		expect(result.structure.genericCalls).toBe(3);
	});
	it.each(["Boolean", "Number", "String"])(
		"preserves the primitive slot of %s.prototype",
		(family) => {
			const result = inspect(
				`return ${family}.prototype.valueOf.call(${family}.prototype);`,
			);
			expect(result.core.some((op) => op.opcode === "builtinError")).toBe(false);
		},
	);
	it("retains the receiver check on a handler path after the first call throws", () => {
		const result = inspect(
			"try {Number.prototype.valueOf.call(x);} catch(e) { return Number.prototype.valueOf.call(x); } return 0;",
		);
		expect(calls(result, "Number.prototype.valueOf")).toHaveLength(2);
	});
});

describe("primordial own descriptors", () => {
	it("resolves a descriptor constructor while preserving its explicit newTarget", () => {
		const result = inspect(
			"return Reflect.construct(Object.getOwnPropertyDescriptor(Number.prototype,'constructor').value,[x],y);",
		);
		expect(calls(result, "Reflect.construct")).toHaveLength(0);
		expect(calls(result, "Number").map((item) => item.attributes.construct)).toEqual([
			true,
		]);
	});
	it("preserves array-like argument consumption after resolving a descriptor getter", () => {
		const result = inspect(
			"return Reflect.apply(Object.getOwnPropertyDescriptor(Symbol.prototype,'description').get,x,y);",
		);
		expect(calls(result, "Reflect.apply")).toHaveLength(0);
		expect(
			calls(result, "Symbol.prototype.description<get>").map(
				(item) => item.attributes.argumentMode,
			),
		).toEqual(["array-like"]);
	});
	it.each([
		"Object.getOwnPropertyDescriptor(Number.prototype, 'valueOf').value.call(x)",
		"Reflect.getOwnPropertyDescriptor(Number.prototype, 'toFixed').value.call(x,2)",
		"Object.getOwnPropertyDescriptor(Symbol.prototype, Symbol.toPrimitive).value.call(x)",
		"Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get.call(x)",
		"Reflect.getOwnPropertyDescriptor(Symbol.prototype, 'description').get.call(x)",
	])("resolves exact invocation through %s", (expression) => {
		const result = inspect(`return ${expression};`);
		expect(result.structure.allocations).toBe(0);
		expect(result.structure.genericLookups).toBe(0);
		expect(result.structure.genericCalls).toBe(0);
		expect(calls(result, "Object.getOwnPropertyDescriptor")).toHaveLength(0);
		expect(calls(result, "Reflect.getOwnPropertyDescriptor")).toHaveLength(0);
	});
	it.each(["Object", "Reflect"])("materializes fresh %s descriptor results", (owner) => {
		const result = inspect(
			`const a=${owner}.getOwnPropertyDescriptor(Number,'name');const b=${owner}.getOwnPropertyDescriptor(Number,'name');y(a,b);return[a,b,a===b];`,
		);
		expect(calls(result, `${owner}.getOwnPropertyDescriptor`)).toHaveLength(0);
		expect(result.structure.allocations).toBeGreaterThanOrEqual(2);
	});
	it.each([
		"Object.getOwnPropertyDescriptor(Number,'valueOf')",
		"Reflect.getOwnPropertyDescriptor(Number.prototype,'absentDescriptor')",
		"Object.getOwnPropertyDescriptor(Number.prototype,Symbol.toPrimitive)",
	])(
		"does not turn an inherited or absent property into an own descriptor: %s",
		(expression) => {
			const result = inspect(`return ${expression};`);
			expect(result.core).toContainEqual(
				expect.objectContaining({ opcode: "createUndefined" }),
			);
			expect(result.structure.genericCalls).toBe(0);
		},
	);
	it.each(["Object", "Reflect"])(
		"retains %s descriptor key conversion effects",
		(owner) => {
			const result = inspect(
				`return ${owner}.getOwnPropertyDescriptor(Number.prototype,x);`,
			);
			expect(calls(result, `${owner}.getOwnPropertyDescriptor`)).toHaveLength(1);
		},
	);
});

describe("primitive prototype payloads", () => {
	it.each([
		"Number.prototype.toString",
		"Number.prototype.toFixed",
		"Number.prototype.toExponential",
		"Number.prototype.toPrecision",
	])("exposes positive zero to dynamic options in %s", (operation) => {
		const result = inspect(`return ${operation}.call(Number.prototype,x);`);
		const receiver = calls(result, operation)[0]!.inputs[0]!;
		expect(
			result.core.find((item) => item.outputs.includes(receiver))?.attributes.value,
		).toBe(0);
	});
	it("retains a receiver check across a mixed primordial join", () => {
		const result = inspect(
			"const value=x?Boolean.prototype:Number.prototype;y(value);return Boolean.prototype.valueOf.call(value);",
		);
		expect(result.core.some((item) => item.opcode === "builtinError")).toBe(false);
		expect(calls(result, "Boolean.prototype.valueOf")).toHaveLength(1);
	});
	it("reads an escaped Symbol wrapper's description from its primitive payload", () => {
		const result = inspect(
			"const value=Object(Symbol(x));y(value);return Object.getOwnPropertyDescriptor(Symbol.prototype,'description').get.call(value);",
		);
		const wrapper = calls(result, "Object")[0]!;
		expect(wrapper).toBeDefined();
		expect(
			calls(result, "Symbol.prototype.description<get>").every(
				(item) => item.inputs[0] !== wrapper.outputs[0],
			),
		).toBe(true);
		expect(result.structure.genericCalls).toBe(1);
	});
});

describe("locale case result reuse", () => {
	for (const method of ["toLocaleLowerCase", "toLocaleUpperCase"]) {
		for (const intl of [false, true]) {
			it.each(["'tr'", "'tr-TR'", "String(y)", "undefined"])(
				`reuses ${method} with immutable locale %s and intl=${intl}`,
				(locale) => {
					const result = inspectStaticValueFunction(
						`function probe(x,y,effect){const value=String(x),locale=${locale};const first=value.${method}(locale);effect(first);return first===value.${method}(locale);}globalThis.probe=probe;`,
						"probe",
						{ intl },
					);
					expect(
						result.core.filter(
							(op) => op.attributes.operation === `String.prototype.${method}`,
						),
					).toHaveLength(1);
					expect(result.structure.genericCalls).toBe(1);
				},
			);
			it(`discards unused ${method} with a certified locale and intl=${intl} after argument effects`, () => {
				const result = inspectStaticValueFunction(
					`function probe(x,effect){const value=String(x);value.${method}('tr',effect());return 17;}globalThis.probe=probe;`,
					"probe",
					{ intl },
				);
				expect(
					result.core.filter(
						(op) => op.attributes.operation === `String.prototype.${method}`,
					),
				).toHaveLength(0);
				expect(result.structure.genericCalls).toBe(1);
				expect(
					result.core.filter((op) => op.attributes.operation === "String"),
				).toHaveLength(1);
			});
		}
		it.each(["y", "[y]", "{get length(){effect();return 0;}}", "new String(y)"])(
			`retains locale object observations in repeated ${method} with %s`,
			(locale) => {
				const result = inspectStaticValueFunction(
					`function probe(x,y,effect){const value=String(x),locale=${locale};const first=value.${method}(locale);effect(locale);return first===value.${method}(locale);}globalThis.probe=probe;`,
					"probe",
					{ intl: true },
				);
				expect(
					result.core.filter(
						(op) => op.attributes.operation === `String.prototype.${method}`,
					),
				).toHaveLength(2);
			},
		);
		it(`retains invalid dynamic locale validation in unused ${method}`, () => {
			const result = inspectStaticValueFunction(
				`function probe(x,y){const value=String(x),locale=String(y);value.${method}(locale);return 17;}globalThis.probe=probe;`,
				"probe",
				{ intl: true },
			);
			expect(
				result.core.filter(
					(op) => op.attributes.operation === `String.prototype.${method}`,
				),
			).toHaveLength(1);
		});
		it(`keeps extra argument effects around a reused ${method}`, () => {
			const result = inspectStaticValueFunction(
				`function probe(x,effect){const value=String(x);const first=value.${method}('tr',effect());effect(first);return first===value.${method}('tr',effect());}globalThis.probe=probe;`,
				"probe",
				{ intl: true },
			);
			expect(
				result.core.filter(
					(op) => op.attributes.operation === `String.prototype.${method}`,
				),
			).toHaveLength(1);
			expect(result.structure.genericCalls).toBe(3);
		});
	}
});
