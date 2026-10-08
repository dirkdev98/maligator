import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, test } from "vitest";
import { summarizeEmittedC } from "../scripts/self-compile-workload.ts";

const directories: Array<string> = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function output(files: Record<string, string>): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "mal-emitted-c-"));
	directories.push(directory);
	for (const [name, source] of Object.entries(files))
		writeFileSync(path.join(directory, name), source);
	return directory;
}

test("counts root publication and runtime work across every emitted C unit", () => {
	const directory = output({
		"self-compile-code-0.c": [
			"    r3 = MAL_VALUE_UNDEFINED;",
			"    __gc_slots[2] = r7;",
			"    __gc_slots[130] = MAL_VALUE_UNDEFINED;",
			"    MAL_ROOT_MASK(0x4);",
			"    if (mal_gc_poll) { __gc_slots[2] = r7; MAL_ROOT_MASK_WIDE(0x1, __gc_inactive_tail_0); mal_gc_safepoint(vm); }",
			"    r9 = mal_vm_op_load_property(vm, r3, r4);",
			"    if (MAL_THREW()) goto __throw_exit;",
		].join("\n"),
		"self-compile-data-0.c": "if (vm->completion.kind == MAL_COMPLETION_THROW) return;\n",
		"self-compile.malw": "__gc_slots[1] = r1;",
	});
	expect(summarizeEmittedC(directory)).toMatchObject({
		rootPublicationStores: 2,
		rootClears: 1,
		rootMasks: 2,
		wideRootMasks: 1,
		undefinedRegisterStores: 1,
		throwChecks: 2,
		runtimeCallSites: 2,
	});
});
