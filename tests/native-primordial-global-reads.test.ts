import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("guarded native global primordial reads", () => {
	it.each(["Symbol", "Object", "Date", "Uint8Array", "JSON"])(
		"checks the binding epoch before reading the intrinsic for %s",
		(name) => {
			const { c } = inspectStaticValueFunction(
				`function probe() { return ${name}; } globalThis.probe = probe;`,
				"probe",
				{ locked: false, realms: true },
			);
			expect(c.source).toContain("mal_vm_primordial_bindings_intact(vm)");
			expect(c.source).toContain("mal_vm_op_load_global_property(vm,");
		},
	);

	it.each(["applicationGlobal", "Intl", "ShadowRealm"])(
		"keeps %s outside the unconditional intrinsic set",
		(name) => {
			const { c } = inspectStaticValueFunction(
				`function probe() { return ${name}; } globalThis.probe = probe;`,
				"probe",
				{ locked: false, realms: true, intl: true },
			);
			expect(c.source).not.toContain("mal_vm_primordial_bindings_intact(vm)");
			expect(c.source).toContain("mal_vm_op_load_global_property(vm,");
		},
	);
});
