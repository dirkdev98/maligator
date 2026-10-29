import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

const factory =
	"const make=function make(visit){for(let i=0;i<3;i++)visit();return function callback(value){return value;};};";
function inspect(expression: string, declarations = factory, declaration = "function") {
	return inspectStaticValueFunction(
		`${declarations}${declaration} compute(visit,input,flag){const value=make(visit,input,flag);${declaration.includes("*") ? "yield value;" : ""}${declaration.startsWith("async") ? "await 0;" : ""}return ${expression};}globalThis.compute=compute;`,
		"compute",
		{ realms: false },
	);
}
function keepsAlternative(out: ReturnType<typeof inspect>) {
	return out.core.some(
		(op) => op.opcode === "createNumber" && op.attributes.value === 11,
	);
}

describe("callee-target callability observations", () => {
	it.each([
		"typeof value==='function'?17:11",
		"typeof value!=='function'?11:17",
		"typeof value==='object'?11:17",
		"typeof value==='number'?11:17",
	])(
		"uses returned function targets for %s without dropping the factory call",
		(expression) => {
			const out = inspect(expression);
			expect(keepsAlternative(out)).toBe(false);
			expect(out.fn.instructions.some((op) => op.opcode === "CALL")).toBe(true);
		},
	);

	it("replaces raw typeof using the same returned-function fact", () => {
		const out = inspect("typeof value");
		expect(
			out.core.some((op) => op.opcode === "unary" && op.attributes.operator === "typeof"),
		).toBe(false);
		expect(out.core.some((op) => op.opcode === "createString")).toBe(true);
		expect(out.fn.instructions.some((op) => op.opcode === "CALL")).toBe(true);
	});

	it("uses callability for a standalone logical negation", () => {
		const out = inspect("!value");
		expect(
			out.core.some((op) => op.opcode === "unary" && op.attributes.operator === "!"),
		).toBe(false);
		expect(
			out.core.some(
				(op) => op.opcode === "createBoolean" && op.attributes.value === false,
			),
		).toBe(true);
	});

	it("keeps callability after the finite function identity set widens", () => {
		const returns = Array.from(
			{ length: 6 },
			(_, index) => `if(input===${index})return function cb${index}(){return ${index}};`,
		).join("");
		const out = inspect(
			"typeof value==='function'?17:11",
			`const make=function make(visit,input){for(let i=0;i<3;i++)visit();${returns}return function last(){};};`,
		);
		expect(keepsAlternative(out)).toBe(false);
	});

	it.each(["function", "function*", "async function", "async function*"])(
		"keeps returned-function facts across %s suspension",
		(declaration) => {
			const out = inspect("typeof value==='function'?17:11", factory, declaration);
			expect(keepsAlternative(out)).toBe(false);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);

	it.each(["async function", "function*", "async function*"])(
		"classifies a %s call by its wrapper",
		(declaration) => {
			const out = inspect(
				"typeof value==='function'?11:17",
				`const make=${declaration} make(){return function callback(){};};`,
			);
			expect(keepsAlternative(out)).toBe(false);
		},
	);

	it("does not classify unknown factory returns as callable", () => {
		const out = inspect(
			"typeof value==='function'?17:11",
			"const make=function make(visit,input){for(let i=0;i<3;i++)visit();return input;};",
		);
		expect(keepsAlternative(out)).toBe(true);
	});

	it("uses a returned object allocation independently of factory effects", () => {
		const out = inspect(
			"typeof value==='object'?17:11",
			"const make=function make(visit){for(let i=0;i<3;i++)visit();return {};};",
		);
		expect(keepsAlternative(out)).toBe(false);
		expect(out.fn.instructions.some((op) => op.opcode === "CALL")).toBe(true);
	});

	it("preserves a callable and noncallable return join", () => {
		const out = inspect(
			"typeof value==='function'?17:11",
			"const make=function make(visit,input){for(let i=0;i<3;i++)visit();if(input)return function callback(){};return {};};",
		);
		expect(keepsAlternative(out)).toBe(true);
	});

	it("classifies a returned class without removing its invocation", () => {
		const out = inspect(
			"typeof value==='function'?value():11",
			"const make=function make(visit){for(let i=0;i<3;i++)visit();return class Callback{};};",
		);
		expect(keepsAlternative(out)).toBe(false);
		expect(
			out.fn.instructions.filter((op) => op.opcode === "CALL").length,
		).toBeGreaterThanOrEqual(2);
	});

	it.each([
		"Math.abs",
		"Math.abs.bind(null)",
		"Function(input)",
		"new Function(input)",
		"new Proxy(function target(){},input)",
		"Object.freeze(function target(){})",
		"Object(function target(){})",
	])("carries callable normal returns from %s without removing the factory", (value) => {
		const out = inspect(
			"typeof value==='function'?17:11",
			`const make=function make(visit,input){for(let i=0;i<3;i++)visit();return ${value};};`,
		);
		expect(keepsAlternative(out)).toBe(false);
		expect(out.fn.instructions.some((op) => op.opcode === "CALL")).toBe(true);
	});

	it.each([
		"new Proxy({},input)",
		"Object.getOwnPropertyDescriptor(input,'key')",
		"Reflect.ownKeys(input)",
		"Proxy.revocable(input,{})",
	])("carries noncallable normal returns from %s", (value) => {
		const out = inspect(
			"typeof value==='function'?11:17",
			`const make=function make(visit,input){for(let i=0;i<3;i++)visit();return ${value};};`,
		);
		expect(keepsAlternative(out)).toBe(false);
		expect(out.fn.instructions.some((op) => op.opcode === "CALL")).toBe(true);
	});

	it.each([
		"input.bind(null)",
		"new Proxy(input,{})",
		"Array.from.call(input,[])",
		"input.map(value=>value)",
		"Promise.resolve.call(input,0)",
		"RegExp(input)",
		"Object.freeze(...input)",
	])("retains unknown callability from %s", (value) => {
		const out = inspect(
			"typeof value==='function'?17:11",
			`const make=function make(visit,input){for(let i=0;i<3;i++)visit();return ${value};};`,
		);
		expect(keepsAlternative(out)).toBe(true);
	});

	it("projects a fixed callable argument before an unknown iterable tail", () => {
		const out = inspect(
			"typeof value==='function'?17:11",
			"const make=function make(visit,input){for(let i=0;i<3;i++)visit();return Object.freeze(function target(){},...input);};",
		);
		expect(keepsAlternative(out)).toBe(false);
	});

	it("keeps callable certainty when a phi joins builtin and script functions", () => {
		const out = inspectStaticValueFunction(
			"function compute(flag){const value=flag?Math.abs:function target(){};return typeof value==='function'?17:11;}globalThis.compute=compute;",
			"compute",
			{ realms: false },
		);
		expect(keepsAlternative(out)).toBe(false);
	});

	it("does not treat a mutable builtin property read as its captured primordial", () => {
		const out = inspectStaticValueFunction(
			"function compute(visit){visit();const value=Math.abs;return typeof value==='function'?17:11;}globalThis.compute=compute;",
			"compute",
			{ locked: false, realms: false },
		);
		expect(keepsAlternative(out)).toBe(true);
	});

	it.each(["function*", "async function", "async function*"])(
		"preserves opaque callable certainty across %s suspension",
		(declaration) => {
			const out = inspect(
				"typeof value==='function'?17:11",
				"const make=function make(visit){for(let i=0;i<3;i++)visit();return Math.abs.bind(null);};",
				declaration,
			);
			expect(keepsAlternative(out)).toBe(false);
			expect(deserializeCompilerArtifact(serializeCompilerArtifact(out.image))).toEqual(
				out.image,
			);
		},
	);
});
