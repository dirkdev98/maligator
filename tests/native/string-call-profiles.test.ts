import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";
import {
	constantCallProfiles,
	constantCallProfileSource,
} from "../helpers/constant-call-profiles.ts";
import {
	constantStringCallCases,
	localeCaseTags,
	localeCaseText,
} from "../helpers/string-call-profiles.ts";

describe("constant string call differential", () => {
	it.each(["locked", "mutable"] as const)(
		"preserves scalar string calls, effects and suspension with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-call-profiles-"));
			try {
				const cases = constantStringCallCases.flatMap((entry, index) =>
					constantCallProfiles.map((profile) => ({
						entry,
						profile,
						name: `probe_${index}_${profile}`,
					})),
				);
				const fixture = path.join(outDir, "string-call-profiles.mjs");
				writeFileSync(
					fixture,
					`${cases.map(({ entry, profile, name }) => constantCallProfileSource(entry, profile, name)).join("\n")}
function encode(value) { return typeof value + ':' + JSON.stringify(value); }
const cases = [${cases.map(({ name, profile }) => `[globalThis.${name},${profile === "suspension"}]`).join(",")}];
for(let index=0;index<cases.length;index++) {
  const [run,generator] = cases[index];
  for(const count of [0,3]) {
    const events=[];
    const result=run(value=>{events.push(encode(value));return value;},count);
    if(generator) {
      const first=result.next(); const last=result.next();
      console.log(index,count,encode(first.value),first.done,encode(last.value),last.done,events.join('|'));
    } else console.log(index,count,encode(result),events.join('|'));
  }
  const sentinel={};let caught=false;
  try { const result=run(()=>{throw sentinel;},3);if(generator)result.next(); }
  catch(error){caught=error===sentinel;}
  if(!caught)throw new Error('lost callback exception '+index);
}
const original=String.prototype.toLowerCase;
if(Object.getOwnPropertyDescriptor(String.prototype,'toLowerCase').writable) {
  const iterator=globalThis.probe_${constantStringCallCases.findIndex(([callee]) => callee === "String.prototype.toLowerCase")}_suspension(value=>value);
  const first=iterator.next().value;
  try { String.prototype.toLowerCase=()=> 'changed';if(iterator.next().value!=='changed')throw new Error('missed mutation'); }
  finally {String.prototype.toLowerCase=original;}
  if(first!==${JSON.stringify(localeCaseText.toLowerCase())})throw new Error('initial text');
}
function lower(locale){return 'IİiıJ\\u0301i\\u0307Σ AΣ'.toLocaleLowerCase(locale);}
function upper(locale){return 'IİiıJ\\u0301i\\u0307Σ AΣ'.toLocaleUpperCase(locale);}
for(const run of [lower,upper]) {
  for(const locale of ['TR','tr-TR',['tr'],'bad!',null,new String('tr')]) {
    try {console.log('locale',encode(run(locale)));}catch(error){console.log('locale-error',error.name);}
  }
  const events=[];
  const locales={get length(){events.push('length');return 1;},get 0(){events.push('locale');return 'tr';}};
  console.log('locale-getters',encode(run(locales)),events.join('|'));
  const sentinel={};let caught=false;
  try {run({length:1,get 0(){throw sentinel;}});}catch(error){caught=error===sentinel;}
  if(!caught)throw new Error('lost locale exception');
}
const events=[];
console.log('apply-getters',String.prototype.toLocaleLowerCase.apply('I',{
  get length(){events.push('length');return 1;},get 0(){events.push('locale');return 'tr';}
}),events.join('|'));
`,
				);
				const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "string-call-profiles",
					config: resolveBuildConfig({
						engine: { primordials, intl: { enabled: true } },
					}),
					outDir,
				});
				for (const binary of [pair.compiled, pair.interpreted]) {
					expect(runToStdout(binary)).toBe(expected);
					expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
				}
			} finally {
				rmSync(outDir, { recursive: true, force: true });
			}
		},
		600_000,
	);
	it("uses root case rules with Intl disabled while retaining argument evaluation", () => {
		const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-string-case-no-intl-"));
		try {
			const fixture = path.join(outDir, "string-case-no-intl.mjs");
			const text = JSON.stringify(localeCaseText);
			const calls = localeCaseTags
				.flatMap((tag) => [
					`if(${text}.toLocaleLowerCase(${JSON.stringify(tag)})!==${JSON.stringify(localeCaseText.toLowerCase())})throw new Error('lower ${tag}');`,
					`if(${text}.toLocaleUpperCase(${JSON.stringify(tag)})!==${JSON.stringify(localeCaseText.toUpperCase())})throw new Error('upper ${tag}');`,
				])
				.join("\n");
			writeFileSync(
				fixture,
				`${calls}
const events=[];
function locale(){events.push('argument');return {get length(){throw new Error('unexpected locale read');}};}
if('I'.toLocaleLowerCase(locale())!=='i'||events.join('|')!=='argument')throw new Error('argument evaluation');
const sentinel={};let caught=false;
try{'I'.toLocaleLowerCase((()=>{throw sentinel;})());}catch(error){caught=error===sentinel;}
if(!caught)throw new Error('lost argument exception');
console.log('root case passed');
`,
			);
			const pair = buildBackendPairFromOneProgramImage({
				fixture,
				name: "string-case-no-intl",
				config: resolveBuildConfig({
					engine: { primordials: "locked", intl: { enabled: false } },
				}),
				outDir,
			});
			for (const binary of [pair.compiled, pair.interpreted]) {
				expect(runToStdout(binary)).toBe("root case passed\n");
				expect(runToStdout(binary, { env: STRESS_ENV })).toBe("root case passed\n");
			}
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	}, 600_000);
});
