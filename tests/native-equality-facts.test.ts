import { describe, expect, it } from "vitest";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("partial noncoercing equality facts", () => {
	it.each(["a===b", "a!==b", "a==b", "Object.is(a,b)"])(
		"retains String pointer views at an observable boundary for %s",
		(expression) => {
			const out = inspectStaticValueFunction(
				`function compute(input,other,gate){const a=":"+input,b=":"+other;return gate(${expression});}globalThis.compute=compute;`,
				"compute",
			);
			expect(out.c.source).not.toContain("mal_value_to_string(mal_value_from_string(");
		},
	);

	it.each(["value === other", "Object.is(value,other)"])(
		"defers %s only while its boxed inputs remain available",
		(expression) => {
			for (const boundary of [false, true]) {
				const out = inspectStaticValueFunction(
					`function compute(input,other,gate){const value=!!input;return ${boundary ? `gate(${expression})` : expression};}globalThis.compute=compute;`,
					"compute",
				);
				const ip = out.native.body.instructions.findIndex((op) =>
					expression.startsWith("Object")
						? op.opcode === "CALL_KNOWN" && op.operation === "Object.is"
						: op.opcode === "BINARY" && op.operator === "===",
				);
				expect(ip).toBeGreaterThanOrEqual(0);
				expect(out.native.storage!.expressionIps.includes(ip)).toBe(!boundary);
				expect(
					serializeCompilerArtifact(
						deserializeCompilerArtifact(serializeCompilerArtifact(out.image)),
					),
				).toEqual(serializeCompilerArtifact(out.image));
			}
		},
	);

	it.each([
		"!!input",
		"+input",
		"':' + input",
		"1n",
		"({input})",
		"flag ? ({input}) : !!input",
	])(
		"consumes the known operand in %s without general equality dispatch",
		(expression) => {
			for (const locked of [false, true])
				for (const operator of ["===", "!==", "Object.is"] as const)
					for (const reverse of [false, true]) {
						const left = reverse ? "other" : "value",
							right = reverse ? "value" : "other";
						const observation =
							operator === "Object.is"
								? `Object.is(${left},${right})`
								: `${left}${operator}${right}`;
						const out = inspectStaticValueFunction(
							`function compute(input,other,flag){const value=${expression};return ${observation};}globalThis.compute=compute;`,
							"compute",
							{ locked },
						);
						expect(out.c.source).not.toContain("mal_ops_same_value(");
						expect(out.c.source).not.toContain("mal_ops_strict_equal_boxed(");
						if (!locked && operator === "Object.is")
							expect(out.c.source).toContain("mal_vm_call_cached");
						expect(
							serializeCompilerArtifact(
								deserializeCompilerArtifact(serializeCompilerArtifact(out.image)),
							),
						).toEqual(serializeCompilerArtifact(out.image));
					}
		},
	);

	it("retains arbitrary completion values after a partial mutable SameValue hit", () => {
		const out = inspectStaticValueFunction(
			"function compute(input,other,gate){const result=Object.is(!!input,other);gate();return result;}globalThis.compute=compute;",
			"compute",
			{ locked: false, stackRoots: "precise" },
		);
		const ip = out.native.body.instructions.findIndex(
			(op, index) =>
				op.opcode === "CALL" && out.native.instructions[index]?.kind === "call",
		);
		const op = out.native.body.instructions[ip]!;
		if (op.opcode !== "CALL") throw new Error("Missing mutable SameValue invocation");
		expect(out.native.registerRepresentations[op.dst]).toBe("boxed");
		expect(out.native.storage!.rootRegisters).toContain(op.dst);
	});
});
