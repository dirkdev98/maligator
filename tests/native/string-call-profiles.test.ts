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
	dynamicCallProfiles,
	dynamicCallProfileSource,
} from "../helpers/dynamic-call-profiles.ts";
import {
	constantStringCallCases,
	dynamicStringCallCases,
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

describe("dynamic string call differential", () => {
	it.each(["locked", "mutable"] as const)(
		"preserves dynamic string profiles with %s primordials",
		(primordials) => {
			const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-dynamic-string-profiles-"));
			try {
				const cases = dynamicStringCallCases.flatMap(
					([callee, receiver, args, expression], index) =>
						dynamicCallProfiles.map((profile) => ({
							entry: [callee, receiver, args] as const,
							expression,
							profile,
							name: `dynamic_${index}_${profile}`,
						})),
				);
				const fixture = path.join(outDir, "dynamic-string-profiles.mjs");
				const methods = ["includes", "indexOf", "lastIndexOf", "startsWith", "endsWith"];
				writeFileSync(
					fixture,
					`${cases.map(({ entry, expression, profile, name }) => dynamicCallProfileSource(entry, profile, expression, name)).join("\n")}
function encode(value){return typeof value+':'+JSON.stringify(value);}
const cases=[${cases.map(({ name, expression, profile }) => `[globalThis.${name},${expression === "+x"},${profile === "suspension"}]`).join(",")}];
for(let index=0;index<cases.length;index++){
 const [run,numeric,generator]=cases[index];
 const values=numeric?[-Infinity,-1,-0,0,0.5,1,2,65536,1114111,1114112,Infinity,NaN]:['','a','ab a','A😀Z',' IİΣ ','e\\u0301','\\ud800','%F0%9F%98%80','%GG'];
 for(const value of values)for(const count of [0,3]){
  const events=[];const input={[Symbol.toPrimitive](hint){events.push(hint);return value;}};
  try {
   const result=run(input,v=>{events.push(encode(v));return v;},count);
   if(generator){const first=result.next();const last=result.next();console.log(index,count,encode(first.value),first.done,encode(last.value),last.done,events.join('|'));}
   else console.log(index,count,encode(result),events.join('|'));
  }catch(error){console.log(index,count,error.name,events.join('|'));}
 }
 const sentinel={};let caught=false;
 try{const result=run({[Symbol.toPrimitive](){throw sentinel;}},v=>v,3);if(generator)result.next();}catch(error){caught=error===sentinel;}
 if(!caught)throw new Error('lost conversion exception '+index);
}
function* suspendedSearch(x,y,p){const s=String(x),n=String(y),i=+p;yield s;return s.includes(n,i);}
async function asyncSearch(x,y,p){const s=String(x),n=String(y),i=+p;await s;return s.includes(n,i);}
function* resumedSearch(x){const s=String(x);const n=yield s;return s.includes(n,0);}
function* unionSearch(x,y,flag){const s=String(x);const n=flag?String(y):yield s;return s.includes(n,0);}
for(const size of [1,64,1024]){
 let rope='';for(let i=0;i<size;i++)rope+='a😀b';
 const iterator=suspendedSearch(rope,'😀',1);iterator.next();
 console.log('suspended-rope',size,iterator.next().value,await asyncSearch(rope,'😀',1));
}
for(const run of [resumedSearch,unionSearch])for(const needle of ['b',/b/,{[Symbol.match]:false,toString(){return 'b';}}]){
 const events=[];const iterator=run({toString(){events.push('receiver');return 'abc';}},'',false);
 const first=iterator.next();
 try{console.log('resumed',encode(first.value),encode(iterator.next(needle).value),events.join('|'));}catch(error){console.log('resumed-error',error.name,events.join('|'));}
}
const sentinel={};
for(const run of [resumedSearch,unionSearch]){
 const iterator=run('abc','',false);iterator.next();let caught=false;
 try{iterator.next({get [Symbol.match](){throw sentinel;}});}catch(error){caught=error===sentinel;}
 if(!caught)throw new Error('lost resumed regexp check');
}
const suspendedOriginal=String.prototype.includes;
if(Object.getOwnPropertyDescriptor(String.prototype,'includes').writable){
 const iterator=suspendedSearch('abc','b',0);iterator.next();
 try{String.prototype.includes=()=> 'changed';if(iterator.next().value!=='changed')throw new Error('lost suspended mutation');}finally{String.prototype.includes=suspendedOriginal;}
}
${methods.map((method) => `function search_${method}(x,y,p){const s=String(x),n=String(y),i=+p;return s.${method}(n,i);}globalThis.search_${method}=search_${method};`).join("\n")}
for(const method of ${JSON.stringify(methods)}){
 const run=globalThis['search_'+method];
 for(const size of [0,1,64,1024])for(const position of [-Infinity,-1,0,0.5,1,64,Infinity,NaN]){
  let source='',needle='';for(let i=0;i<size;i++){source+='a😀b';needle+='a😀b';}
  console.log('rope',method,size,String(position),run(source,needle,position),run(source,'😀b',position));
 }
 const events=[];
 const input=value=>({[Symbol.toPrimitive](hint){events.push(hint);return value;}});
 console.log('order',method,run(input('ab'),input('b'),input(0)),events.join('|'));
 const original=String.prototype[method];
 if(Object.getOwnPropertyDescriptor(String.prototype,method).writable){
  try{String.prototype[method]=()=> 'changed';if(run('a','b',0)!=='changed')throw new Error('lost mutation');}finally{String.prototype[method]=original;}
 }
}
`,
				);
				const expected = execFileSync(process.execPath, [fixture], {
					encoding: "utf8",
					maxBuffer: 16 * 1024 * 1024,
				});
				const pair = buildBackendPairFromOneProgramImage({
					fixture,
					name: "dynamic-string-profiles",
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
});
