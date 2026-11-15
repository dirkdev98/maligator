import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("split cursor escape proof", () => {
	it("keeps cursor lowering when only the checksum escapes", () => {
		const out = inspectStaticValueFunction(
			`function consume(value) {
				const parts = value.split("|");
				let total = 0;
				for (let index = 0; index < parts.length; index++) {
					const part = parts[index].trim();
					total += part.length;
				}
				return total;
			} globalThis.consume = consume;`,
			"consume",
			{ locked: true },
		);
		expect(
			out.native.specializations.some((plan) => plan.kind === "string-split-cursor"),
		).toBe(true);
	});

	it.each(["return parts;", "throw parts;", "return flag ? parts : undefined;"])(
		"retains materialization for %s",
		(completion) => {
			const out = inspectStaticValueFunction(
				`function consume(value, flag) {
					const parts = value.split("|");
					let total = 0;
					for (let index = 0; index < parts.length; index++) {
						const part = parts[index].trim();
						total += part.length;
					}
					${completion}
				} globalThis.consume = consume;`,
				"consume",
				{ locked: true },
			);
			expect(
				out.native.specializations.some((plan) => plan.kind === "string-split-cursor"),
			).toBe(false);
		},
	);
});
