import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "../src/compiler/core/core-internal-attributes.ts";
import { projectCoreSpecializationRecipes } from "../src/compiler/core/core-specialization-recipes.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { analyzeEntrypoint } from "../src/compiler/pipeline/compile-program-common.ts";

const directory = mkdtempSync(join(tmpdir(), "mal-method-hints-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const BOX = `
class Box {
	#keys = [];
	add(key) {
		this.#keys.push(key);
	}
	has(key) {
		return this.#keys.includes(key);
	}
}`;

// A Map loop whose method name matches Box#has; only the receiver decides the callee.
const MAP_LOOP = `
function probe(values) {
	let count = 0;
	for (let index = 0; index < 64; index++) if (values.has(index)) count++;
	return count;
}
const values = new Map();
for (let index = 0; index < 64; index += 2) values.set(index, index);
console.log(probe(values));`;

const BOX_LOOP = `
function boxed(box) {
	let count = 0;
	for (let index = 0; index < 64; index++) if (box.has(index)) count++;
	return count;
}`;

function compile(name: string, entry: string, prelude?: string) {
	const file = join(directory, `${name}.mjs`);
	writeFileSync(file, entry);
	const analysis = analyzeEntrypoint(
		file,
		{
			buildConfig: resolveBuildConfig({}),
			stripTypes: (text) => text,
			...(prelude === undefined
				? {}
				: {
						entryPrelude: {
							specifier: "maligator-internal:hint-prelude",
							source: prelude,
						},
					}),
		},
		(_phase, run) => run(),
	);
	const core = optimizeSemanticProgramToCore(
		analysis.semantic,
		{ facts: analysis.facts },
		(_phase, run) => run(),
	);
	const named = (functionName: string) =>
		[...core.program.functionIds()].find(
			(id) =>
				String.fromCharCode(
					...(core.program.stringConstants[
						core.program.function(id).metadata.nameStringIndex
					] ?? []),
				) === functionName,
		)!;
	// A name hint shows as a guarded inline or a guarded direct call at the method call.
	const guessed = (functionName: string) => {
		const id = named(functionName);
		const fn = core.program.function(id);
		return (
			[...fn.instructionIds()].some(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionAttributes(instruction)[
						CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
					] === true,
			) ||
			projectCoreSpecializationRecipes(core.plan.recipes).some(
				(selection) =>
					selection.function === id &&
					selection.kind === "guarded-direct-call" &&
					selection.representation === "finite-function-set",
			)
		);
	};
	return { core, named, guessed };
}

describe("instance method hints", () => {
	it("keeps toolchain methods from guessing application callees", () => {
		const { core, named, guessed } = compile(
			"toolchain",
			MAP_LOOP,
			`${BOX}${BOX_LOOP}
const box = new Box();
for (let index = 0; index < 64; index += 3) box.add(index);
globalThis.__hintedBoxCount = boxed(box);`,
		);
		expect(core.program.function(named("has")).metadata.toolchain).toBe(true);
		expect(guessed("probe")).toBe(false);
		// Toolchain code still takes its own methods as hints.
		expect(guessed("boxed")).toBe(true);
	});

	it("lets a builtin collection plan keep a call that a method name only guesses at", () => {
		const { core, named } = compile(
			"collection",
			`
class Scan {
	#keys = [];
	add(key) {
		this.#keys.push(key);
	}
	has(key) {
		for (let index = 0; index < this.#keys.length; index++)
			if (this.#keys[index] === key) return true;
		return false;
	}
}
const scan = new Scan();
for (let index = 0; index < 64; index += 3) scan.add(index);
console.log(scan.has(3));${MAP_LOOP}`,
		);
		const plans = projectCoreSpecializationRecipes(core.plan.recipes).filter(
			(selection) => selection.function === named("probe"),
		);
		expect(plans.map((selection) => selection.kind)).toContain(
			"builtin-collection-call-chain",
		);
		expect(plans.some((selection) => selection.kind === "guarded-direct-call")).toBe(
			false,
		);
	});

	it("lets application methods guess application callees", () => {
		const { guessed } = compile(
			"application",
			`${BOX}${BOX_LOOP}${MAP_LOOP}
const box = new Box();
for (let index = 0; index < 64; index += 3) box.add(index);
console.log(boxed(box));`,
		);
		expect(guessed("probe")).toBe(true);
	});
});
