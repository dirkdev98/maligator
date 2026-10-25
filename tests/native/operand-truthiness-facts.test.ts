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
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_BIGINT,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_UNDEFINED,
	COMPILER_VALUE_KIND_TOP,
} from "../../src/compiler/shared/compiler-value-kinds.ts";
import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import {
	buildNativeProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("executes every truthiness mask in canonical and guarded bodies with arbitrary fallback results", () => {
	const directory = mkdtempSync(join(tmpdir(), "mal-truthiness-masks-"));
	const config = resolveBuildConfig({
		engine: {
			primordials: "mutable",
			eval: false,
			realms: false,
			intl: { enabled: false },
			temporal: false,
		},
	});
	const samples = [
		[COMPILER_VALUE_KIND_UNDEFINED, "undefined"],
		[COMPILER_VALUE_KIND_NULL, "null"],
		[COMPILER_VALUE_KIND_BOOLEAN, "false"],
		[COMPILER_VALUE_KIND_BOOLEAN, "true"],
		[COMPILER_VALUE_KIND_NUMBER, "0"],
		[COMPILER_VALUE_KIND_NUMBER, "-0"],
		[COMPILER_VALUE_KIND_NUMBER, "NaN"],
		[COMPILER_VALUE_KIND_NUMBER, "Infinity"],
		[COMPILER_VALUE_KIND_NUMBER, "-1.5"],
		[COMPILER_VALUE_KIND_STRING, '""'],
		[COMPILER_VALUE_KIND_STRING, '"text"'],
		[COMPILER_VALUE_KIND_BIGINT, "0n"],
		[COMPILER_VALUE_KIND_BIGINT, "1n"],
		[COMPILER_VALUE_KIND_BIGINT, "-123456789012345678901234n"],
		[COMPILER_VALUE_KIND_SYMBOL, 'Symbol("value")'],
		[COMPILER_VALUE_KIND_OBJECT, "{}"],
		[COMPILER_VALUE_KIND_OBJECT, "new Boolean(false)"],
		[
			COMPILER_VALUE_KIND_OBJECT,
			'({[Symbol.toPrimitive](){throw new Error("coercion");}})',
		],
	] as const;
	const declarations = Array.from({ length: COMPILER_VALUE_KIND_TOP }, (_, index) => {
		const mask = index + 1;
		return `globalThis.truth_${mask}=function truth_${mask}(value){return Boolean(value);};\nglobalThis.logical_${mask}=function logical_${mask}(value){return !!value;};`;
	}).join("\n");
	const source = `${declarations}

const values=[${samples.map(([kind, value]) => `[${kind},${value}]`).join(",")}];
const same=Object.is;
let checks=0;
for(let mask=1;mask<=${COMPILER_VALUE_KIND_TOP};mask++){
 const invoke=globalThis["truth_"+mask];
 for(const [kind,value] of values) if(mask & kind){
  if(invoke(value)!==!!value) throw new Error("mask "+mask+" kind "+kind);
  if(globalThis["logical_"+mask](value)!==!!value) throw new Error("logical "+mask+" kind "+kind);
  checks+=2;
 }
}
const original=Boolean;
try{
 globalThis.Boolean=function(value){return {value};};
 for(let mask=1;mask<=${COMPILER_VALUE_KIND_TOP};mask++){
  const invoke=globalThis["truth_"+mask];
  for(const [kind,value] of values) if(mask & kind){
   if(!same(invoke(value).value,value)) throw new Error("fallback "+mask+" kind "+kind);
   if(globalThis["logical_"+mask](value)!==!!value) throw new Error("logical fallback "+mask+" kind "+kind);
   checks+=2;
  }
 }
}finally{globalThis.Boolean=original;}
console.log(checks);
`;
	const fixture = join(directory, "truthiness.mjs");
	writeFileSync(fixture, source);
	try {
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, fixture),
			{ facts: compilerProgramFactsFromConfig(config) },
		);
		let patched = 0;
		const functions = image.native.functions.map((native) => {
			const runtime = image.runtime.functions[native.functionIndex]!;
			const name = String.fromCharCode(
				...(image.runtime.stringConstants[runtime.nameStringIndex] ?? []),
			);
			const match = /^(truth|logical)_(\d+)$/.exec(name);
			if (match === null) return native;
			const mask = Number(match[2]);
			const facts = [...native.facts!];
			let calls = 0;
			for (const [ip, op] of native.body.instructions.entries()) {
				const operand =
					match[1] === "truth" && op.opcode === "CALL"
						? op.arguments[0]
						: match[1] === "logical" &&
							  op.opcode === "UNARY" &&
							  op.operator === "!" &&
							  calls === 0
							? op.src
							: undefined;
				if (operand === undefined) continue;
				const row = facts[ip]!;
				const index = row.registers!.indexOf(operand, row.inputOffset) - row.inputOffset!;
				expect(index).toBeGreaterThanOrEqual(0);
				const masks = [...row.inputKindMasks!];
				masks[index] = mask;
				facts[ip] = { ...row, inputKindMasks: masks };
				calls++;
			}
			expect(calls, name).toBe(1);
			patched++;
			return { ...native, facts };
		});
		expect(patched).toBe(COMPILER_VALUE_KIND_TOP * 2);
		const candidate = lowerNativeStorage(
			{ ...image, native: { ...image.native, functions } },
			"precise",
		);
		const binary = buildNativeProgramImage(candidate, {
			name: "truthiness",
			outDir: directory,
			config,
			nativeStackRoots: "precise",
		});
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		expect(runToStdout(binary)).toBe(expected);
		expect(runToStdout(binary, { env: STRESS_ENV, timeoutMs: 120000 })).toBe(expected);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 300000);
