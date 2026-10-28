import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_REGISTERED_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_NUMBER,
} from "../../src/compiler/shared/compiler-value-kinds.ts";
import {
	instructionInputKind,
	instructionResultKind,
} from "../../src/compiler/shared/instruction-facts.ts";
import { nativeVariantContract } from "../../src/compiler/target/lower-native-storage.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it.each(["mutable", "locked"] as const)(
	"preserves property keys and primitive receiver effects under %s primordials",
	(primordials) => {
		const directory = mkdtempSync(join(tmpdir(), "mal-surviving-key-"));
		try {
			const fixture = "tests/local/surviving-property-key-flow.mjs";
			const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
				encoding: "utf8",
				env: { ...process.env, MAL_PRIMORDIALS: primordials },
			});
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: `surviving-key-${primordials}`,
				outDir: directory,
				mainFile: HOST_MAIN,
				config: resolveBuildConfig({
					engine: { primordials, eval: false, realms: false },
					surface: { node: true },
				}),
				nativeStackRoots: "precise",
			});
			for (const [name, opcode] of [
				["namedPrimitiveWrite", "STORE_PROPERTY_STATIC"],
				["indexedPrimitiveRead", "LOAD_PROPERTY"],
				["primitiveMembership", "BINARY"],
				["primitivePropertyPair", "LOAD_PROPERTY_STATIC"],
				["primitivePropertyRegion", "LOAD_PROPERTY_STATIC"],
				["primitivePropertyProjection", "LOAD_PROPERTY_STATIC"],
				["primitiveNumberRecord", "LOAD_PROPERTY_STATIC"],
				["primitiveNumericUpdate", "LOAD_PROPERTY_STATIC"],
				["indexedPrimitiveWrite", "STORE_PROPERTY"],
				["suspendedPrimitiveWrite", "STORE_PROPERTY"],
			]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				);
				expect(fn, name).toBeDefined();
				if (fn === undefined) throw new Error(`Missing function ${name}`);
				const ip = fn.body.instructions.findIndex(
					(instruction) =>
						instruction.opcode === opcode &&
						(instruction.opcode !== "BINARY" || instruction.operator === "in"),
				);
				expect(ip, name).toBeGreaterThanOrEqual(0);
				const instruction = fn.body.instructions[ip]!;
				const receiver =
					"object" in instruction
						? instruction.object
						: instruction.opcode === "BINARY" && instruction.operator === "in"
							? instruction.right
							: undefined;
				if (receiver === undefined) throw new Error(`Missing property access in ${name}`);
				expect(instructionInputKind(fn.facts?.[ip], receiver)).toBe(
					COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
				);
				for (const plans of [
					fn.storage!.propertyReadPairs,
					fn.storage!.propertyReadRegions,
					fn.storage!.propertyProjections,
					fn.storage!.propertyNumericUpdates,
					fn.storage!.numberRecordRegions,
				])
					expect(plans, name).toEqual([]);
			}
			for (const name of [
				"primitiveArrayPresence",
				"primitivePairedPrimary",
				"primitivePairedSecondary",
				"primitiveArrayDestructure",
			]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				);
				expect(fn, name).toBeDefined();
				for (const plans of [
					fn!.storage!.pairedArrayLoops,
					fn!.storage!.arrayPresence,
					fn!.storage!.arrayPairDestructure,
				])
					expect(plans, name).toEqual([]);
			}
			for (const name of ["conditionalKey", "conditionalProtoKey", "liveInitializer"]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				const entry = fn.directEntries.find(
					(e) => e.parameterRepresentations[0] === "string",
				)!;
				expect(entry, name).toBeDefined();
				expect(fn.storage!.literalPropertyDefinitions, name).toEqual([]);
				expect(entry.storage!.literalPropertyDefinitions, name).toHaveLength(1);
			}
			const symbolFn = pair.programImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "conditionalSymbolKey",
			)!;
			const symbolEntry = symbolFn.directEntries.find(
				(entry) => entry.parameterRepresentations[0] === "string",
			)!;
			expect(symbolEntry).toBeDefined();
			const variant = nativeVariantContract(symbolFn, symbolEntry);
			const keyIp = symbolFn.body.instructions.findIndex(
				(op) => op.opcode === "TO_PROPERTY_KEY",
			);
			const conversion = symbolFn.body.instructions[keyIp]!;
			if (conversion.opcode !== "TO_PROPERTY_KEY")
				throw new Error("Missing Symbol key conversion");
			expect(instructionResultKind(variant.facts?.[keyIp], conversion.dst)).toBe(
				primordials === "locked"
					? COMPILER_VALUE_KIND_REGISTERED_SYMBOL
					: COMPILER_VALUE_KIND_TOP,
			);
			const required = pair.programImage.native.functions.find(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
					) === "requireSymbol",
			)!;
			const requiredEntry = required.directEntries.find(
				(entry) => entry.parameterRepresentations[0] === "string",
			)!;
			expect(requiredEntry).toBeDefined();
			const requiredVariant = nativeVariantContract(required, requiredEntry);
			const requiredIp = required.body.instructions.findIndex(
				(op) => op.opcode === "REQUIRE_COERCIBLE",
			);
			const guard = required.body.instructions[requiredIp]!;
			if (guard.opcode !== "REQUIRE_COERCIBLE")
				throw new Error("Missing coercibility guard");
			expect(requiredVariant.facts?.[requiredIp]?.inputKindMasks).toEqual([
				primordials === "locked"
					? COMPILER_VALUE_KIND_REGISTERED_SYMBOL
					: COMPILER_VALUE_KIND_TOP,
			]);
			for (const name of [
				"branchStringLength",
				"branchStringJoin",
				"branchSuspendedLength",
			]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(fn, name).toBeDefined();
				const ip = fn.body.instructions.findIndex(
					(op) => op.opcode === "LOAD_PROPERTY_STATIC",
				);
				const load = fn.body.instructions[ip]!;
				if (load.opcode !== "LOAD_PROPERTY_STATIC")
					throw new Error("Missing conditional length read");
				expect(instructionInputKind(fn.facts?.[ip], load.object), name).toBe(
					COMPILER_VALUE_KIND_STRING,
				);
			}
			for (const name of ["nullableStringLength", "nullableSuspendedLength"]) {
				const fn = pair.programImage.native.functions.find(
					(fn) =>
						String.fromCharCode(
							...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ??
								[]),
						) === name,
				)!;
				expect(fn, name).toBeDefined();
				const ip = fn.body.instructions.findIndex(
					(op) => op.opcode === "LOAD_PROPERTY_STATIC",
				);
				const load = fn.body.instructions[ip]!;
				if (load.opcode !== "LOAD_PROPERTY_STATIC")
					throw new Error("Missing nullable length read");
				expect(instructionInputKind(fn.facts?.[ip], load.object), name).toBe(
					COMPILER_VALUE_KIND_STRING |
						COMPILER_VALUE_KIND_NULL |
						COMPILER_VALUE_KIND_UNDEFINED,
				);
				expect(instructionResultKind(fn.facts?.[ip], load.dst), name).toBe(
					COMPILER_VALUE_KIND_NUMBER,
				);
			}
			for (const binary of [pair.compiled, pair.interpreted])
				for (const stress of [{}, STRESS_ENV])
					expect(
						runToStdout(binary, {
							env: { MAL_PRIMORDIALS: primordials, MAL_HOST_GC: "1", ...stress },
							timeoutMs: 120000,
						}),
					).toBe(expected);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
	300000,
);
