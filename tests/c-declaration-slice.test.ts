import { describe, expect, it } from "vitest";
import {
	GENERATED_PRELUDE_END,
	indexPreludeDeclarations,
	slicedUnitDigest,
	splitExpandedUnit,
} from "../src/c-declaration-slice.ts";

const BASE_PRELUDE = `
typedef struct MalVm { int depth; long counters[4]; } MalVm;
typedef enum MalKind { MAL_KIND_NUMBER, MAL_KIND_STRING = 4 } MalKind;
struct MalShape;
typedef int (*MalHook)(MalVm *vm);
long mal_vm_count(MalVm *vm, MalKind kind);
static inline long mal_vm_depth(MalVm *vm) { return vm->depth + mal_vm_count(vm, MAL_KIND_NUMBER); }
static inline long mal_unused_helper(void) { return 7; }
extern MalHook mal_hook;
`;

const BODY = `long probe(MalVm *vm) { return mal_vm_depth(vm); }`;

function digest(prelude: string, body = BODY): string {
	return slicedUnitDigest(indexPreludeDeclarations(prelude), body);
}

/** True when the edit leaves the probe unit's key unchanged. */
function reusedAfter(edit: (prelude: string) => string, body = BODY): boolean {
	return digest(BASE_PRELUDE, body) === digest(edit(BASE_PRELUDE), body);
}

describe("generated unit declaration slices", () => {
	it("ignores declarations the unit cannot reach", () => {
		expect(
			reusedAfter((p) => `${p}long mal_new_operation(MalVm *vm, int flags);\n`),
		).toBe(true);
		expect(reusedAfter((p) => `${p}typedef struct MalNew { int x; } MalNew;\n`)).toBe(
			true,
		);
		expect(reusedAfter((p) => p.replace("return 7;", "return 8;"))).toBe(true);
		expect(reusedAfter((p) => `${p}enum MalOther { MAL_OTHER_A };\n`)).toBe(true);
	});

	it("keys layouts and helpers the unit reaches, including transitive ones", () => {
		expect(reusedAfter((p) => p.replace("long counters[4];", "long counters[5];"))).toBe(
			false,
		);
		expect(reusedAfter((p) => p.replace("vm->depth +", "vm->depth * 2 +"))).toBe(false);
		expect(
			reusedAfter((p) =>
				p.replace(
					"long mal_vm_count(MalVm *vm, MalKind kind);",
					"long mal_vm_count(const MalVm *vm, MalKind kind);",
				),
			),
		).toBe(false);
		expect(
			reusedAfter((p) => p.replace("MAL_KIND_NUMBER,", "MAL_KIND_NUMBER = 1,")),
		).toBe(false);
	});

	it("keys function-pointer typedefs and externs through the names they declare", () => {
		const body = "int run(MalVm *vm) { return mal_hook(vm); }";
		expect(
			reusedAfter(
				(p) => p.replace("(*MalHook)(MalVm *vm)", "(*MalHook)(MalVm *vm, int)"),
				body,
			),
		).toBe(false);
		expect(
			reusedAfter(
				(p) =>
					p.replace("extern MalHook mal_hook;", "extern _Thread_local MalHook mal_hook;"),
				body,
			),
		).toBe(false);
	});

	it("always keys definitions and directives that every object observes", () => {
		expect(reusedAfter((p) => `${p}int mal_global_counter = 1;\n`)).toBe(false);
		expect(reusedAfter((p) => `${p}long mal_external(void) { return 1; }\n`)).toBe(false);
		expect(reusedAfter((p) => `${p}#pragma STDC FP_CONTRACT OFF\n`)).toBe(false);
		expect(
			reusedAfter(
				(p) =>
					`${p}static void mal_startup(void) __attribute__((constructor));\nstatic void mal_startup(void) {}\n`,
			),
		).toBe(false);
		expect(reusedAfter((p) => `${p}_Static_assert(sizeof(long) == 8, "long");\n`)).toBe(
			false,
		);
	});

	it("keys every change to the expanded body", () => {
		expect(digest(BASE_PRELUDE)).not.toBe(
			digest(BASE_PRELUDE, BODY.replace("mal_vm_depth(vm)", "mal_vm_depth(vm) + 1")),
		);
	});

	it("splits an expanded unit only at the generated prelude end", () => {
		expect(splitExpandedUnit(`int a;\n${GENERATED_PRELUDE_END}\n${BODY}`)).toEqual({
			prelude: "int a;\n",
			body: `\n${BODY}`,
		});
		expect(splitExpandedUnit(BODY)).toBeUndefined();
	});
});
