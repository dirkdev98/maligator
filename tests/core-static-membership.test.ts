import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction, staticValueCases } from "./helpers/static-values.ts";

const present = [
	[
		"own field with an unknown value",
		"const record={present:value};return 'present' in record;",
	],
	[
		"own accessor",
		"const record={get present(){throw value}};return 'present' in record;",
	],
	["Number key", "const record={1:value};return 1 in record;"],
	["negative zero key", "const record={0:value};return -0 in record;"],
	["BigInt key", "const record={1:value};return 1n in record;"],
	["Boolean key", "const record={true:value};return true in record;"],
	["null key", "const record={null:value};return null in record;"],
	["undefined key", "const record={undefined:value};return undefined in record;"],
	["Array element after a hole", "const record=[,value];return 1 in record;"],
	["Array length", "const record=[value];return 'length' in record;"],
	[
		"Array length after escape",
		"const record=[value];observe(record);return 'length' in record;",
	],
	[
		"own field after a private write",
		"const record={present:0};record.present=value;return 'present' in record;",
	],
] as const;

const retained = [
	["unknown key", "const record={present:value};return key in record;"],
	[
		"Proxy receiver",
		"const record=new Proxy({present:value},{has(){throw value}});return 'present' in record;",
	],
	[
		"escaped own property",
		"const record={present:value};observe(record);return 'present' in record;",
	],
	[
		"Object key that can delete the property",
		"const record={present:value};const coercingKey={toString(){delete record.present;return 'present'}};return coercingKey in record;",
	],
	["primitive receiver", "return key in 1;"],
	[
		"loop-carried deletion",
		"const record={present:value};let result=false;for(let i=0;i<key;i++){result='present' in record;delete record.present;}return result;",
	],
] as const;

describe.each([false, true])("static membership with locked primordials %s", (locked) => {
	it.each(
		staticValueCases(
			present,
			([, body], name) =>
				`function ${name}(value,observe){${body}}globalThis.${name}=${name};`,
			{ locked },
		),
	)("folds %s independently of the field value", (_label, _entry, inspect) => {
		const result = inspect();
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "binary" && operation.attributes.operator === "in",
			),
		).toBe(false);
		expect(
			result.fn.instructions.some(
				(instruction) => instruction.opcode === "CREATE_BOOLEAN" && instruction.value,
			),
		).toBe(true);
	});

	it.each(
		staticValueCases(
			retained,
			([, body], name) =>
				`function ${name}(value,key,observe){${body}}globalThis.${name}=${name};`,
			{ locked },
		),
	)("retains %s semantics", (_label, _entry, inspect) => {
		expect(
			inspect().core.some(
				(operation) =>
					operation.opcode === "binary" && operation.attributes.operator === "in",
			),
		).toBe(true);
	});

	it.each(["function*", "async function", "async function*"])(
		"folds a private property across suspension in %s",
		(prefix) => {
			const suspension = prefix === "async function" ? "await 1" : "yield 1";
			const result = inspectStaticValueFunction(
				`${prefix} probe(value){const record={present:value};${suspension};return 'present' in record;}globalThis.probe=probe;`,
				"probe",
				{ locked },
			);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "in",
				),
			).toBe(false);
		},
	);

	it("keeps operand evaluation when folding presence", () => {
		const result = inspectStaticValueFunction(
			"function probe(value,effect){return (effect(), 'present') in {present:value};}globalThis.probe=probe;",
			"probe",
			{ locked },
		);
		expect(result.core.some((operation) => operation.opcode === "call")).toBe(true);
		expect(
			result.core.some(
				(operation) =>
					operation.opcode === "binary" && operation.attributes.operator === "in",
			),
		).toBe(false);
	});

	it("uses world proofs independently for inherited presence and absence", () => {
		for (const key of ["missing", "toString"]) {
			const result = inspectStaticValueFunction(
				`function probe(value){return '${key}' in {present:value};}globalThis.probe=probe;`,
				"probe",
				{ locked },
			);
			expect(
				result.core.some(
					(operation) =>
						operation.opcode === "binary" && operation.attributes.operator === "in",
				),
			).toBe(!locked);
		}
	});
});
