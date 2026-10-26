import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
} from "../../src/compiler/shared/compiler-value-kinds.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import {
	buildNativeProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("classifies every typeof operand mask across native entries, calls and suspension", () => {
	const directory = mkdtempSync(join(tmpdir(), "mal-typeof-masks-"));
	try {
		const config = resolveBuildConfig({
			engine: { primordials: "mutable", eval: false, realms: false },
		});
		const suspended = [
			COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_STRING,
			COMPILER_VALUE_KIND_NULL | COMPILER_VALUE_KIND_OBJECT,
			COMPILER_VALUE_KIND_OBJECT,
			COMPILER_VALUE_KIND_TOP,
		];
		const categories = [
			"undefined",
			"object",
			"boolean",
			"number",
			"string",
			"bigint",
			"symbol",
			"function",
		];
		const kindTests = categories
			.map((expected, bit) => `(typeof value==='${expected}'?${1 << bit}:0)`)
			.join("|");
		const declarations = Array.from({ length: COMPILER_VALUE_KIND_TOP }, (_, index) => {
			const mask = index + 1;
			return `globalThis.fast_${mask}=function fast_${mask}(value){return typeof value==='object';};
globalThis.framed_${mask}=function framed_${mask}(value,gate){gate();return typeof value!=='object';};
globalThis.kinds_${mask}=function kinds_${mask}(value){return ${kindTests};};`;
		}).join("\n");
		const resumable = suspended
			.map(
				(mask) => `
globalThis.generator_${mask}=function* generator_${mask}(value,gate){yield 0;gate();return typeof value==='object';};
globalThis.async_${mask}=async function async_${mask}(value,gate){await gate();return typeof value!=='object';};`,
			)
			.join("\n");
		const samples = [
			[COMPILER_VALUE_KIND_UNDEFINED, "undefined"],
			[COMPILER_VALUE_KIND_NULL, "null"],
			[COMPILER_VALUE_KIND_BOOLEAN, "false"],
			[COMPILER_VALUE_KIND_BOOLEAN, "true"],
			[COMPILER_VALUE_KIND_NUMBER, "0"],
			[COMPILER_VALUE_KIND_NUMBER, "-0"],
			[COMPILER_VALUE_KIND_NUMBER, "NaN"],
			[COMPILER_VALUE_KIND_NUMBER, "Infinity"],
			[COMPILER_VALUE_KIND_NUMBER, "-1.75"],
			[COMPILER_VALUE_KIND_STRING, "''"],
			[COMPILER_VALUE_KIND_STRING, "'text'"],
			[COMPILER_VALUE_KIND_BIGINT, "0n"],
			[COMPILER_VALUE_KIND_BIGINT, "-123456789012345678901234n"],
			[COMPILER_VALUE_KIND_SYMBOL, "Symbol('value')"],
			[COMPILER_VALUE_KIND_OBJECT, "{}"],
			[COMPILER_VALUE_KIND_OBJECT, "[]"],
			[COMPILER_VALUE_KIND_OBJECT, "new Boolean(false)"],
			[COMPILER_VALUE_KIND_OBJECT, "function(){}"],
			[COMPILER_VALUE_KIND_OBJECT, "(function(){}).bind(null)"],
			[COMPILER_VALUE_KIND_OBJECT, "new Proxy(function(){},traps)"],
			[COMPILER_VALUE_KIND_OBJECT, "new Proxy({},traps)"],
			[COMPILER_VALUE_KIND_OBJECT, "revokedCall.proxy"],
			[COMPILER_VALUE_KIND_OBJECT, "revokedObject.proxy"],
			[
				COMPILER_VALUE_KIND_OBJECT,
				"({get [Symbol.toPrimitive](){throw new Error('coercion');}})",
			],
		] as const;
		const source = `${declarations}\n${resumable}
const traps={get(){throw new Error('get trap');}};
const revokedCall=Proxy.revocable(function(){},traps);
const revokedObject=Proxy.revocable({},traps);
revokedCall.revoke();revokedObject.revoke();
const samples=[${samples.map(([kind, value]) => `[${kind},${value}]`).join(",")}];
let gates=0, checks=0;
function gate(){if((++gates&63)===0&&typeof globalThis.gc==='function')globalThis.gc();}
for(let mask=1;mask<=${COMPILER_VALUE_KIND_TOP};mask++){
 for(const [kind,value] of samples)if(mask&kind){
  const object=typeof value==='object';
  if(globalThis['fast_'+mask](value)!==object)throw new Error('fast '+mask);
  if(globalThis['framed_'+mask](value,gate)===object)throw new Error('framed '+mask);
  if(globalThis['kinds_'+mask](value)!==(1<<${JSON.stringify(categories)}.indexOf(typeof value)))throw new Error('kinds '+mask);
  checks+=3;
 }
}
async function resume(){
 for(const mask of [${suspended.join(",")}])for(const [kind,value] of samples)if(mask&kind){
  const object=typeof value==='object';
  const iterator=globalThis['generator_'+mask](value,gate);
  if(iterator.next().value!==0)throw new Error('yield '+mask);
  gate();
  if(iterator.next().value!==object)throw new Error('generator '+mask);
  if((await globalThis['async_'+mask](value,gate))===object)throw new Error('async '+mask);
  checks+=2;
 }
 console.log(checks+':'+gates);
}
resume();`;
		const fixture = join(directory, "typeof.mjs");
		writeFileSync(fixture, source);
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, fixture),
			{ facts: compilerProgramFactsFromConfig(config) },
		);
		let patched = 0;
		const functions = image.native.functions.map((native) => {
			const name = String.fromCharCode(
				...(image.runtime.stringConstants[native.body.nameStringIndex] ?? []),
			);
			const match = /^(fast|framed|kinds|generator|async)_(\d+)$/.exec(name);
			if (match === null) return native;
			const mask = Number(match[2]);
			let comparisons = 0;
			const facts = native.facts!.map((row, ip) => {
				if (native.body.instructions[ip]!.opcode !== "TYPEOF_COMPARE") return row;
				comparisons++;
				return { ...row!, inputKindMasks: [mask] };
			});
			expect(comparisons, name).toBe(match[1] === "kinds" ? 8 : 1);
			patched++;
			return { ...native, facts };
		});
		expect(patched).toBe(COMPILER_VALUE_KIND_TOP * 3 + suspended.length * 2);
		const candidate = lowerNativeStorage(
			{ ...image, native: { ...image.native, functions } },
			"precise",
		);
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(candidate));
		const binary = buildNativeProgramImage(restored, {
			name: "typeof",
			outDir: directory,
			config,
			nativeStackRoots: "precise",
		});
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		expect(runToStdout(binary)).toBe(expected);
		expect(
			runToStdout(binary, {
				env: { ...STRESS_ENV, MAL_HOST_GC: "1" },
				timeoutMs: 120000,
			}),
		).toBe(expected);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 300000);
