import { describe, expect, it } from "vitest";
import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import { COMPILER_UINT32_RANGE } from "../src/compiler/shared/integer-range.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	inspectStaticValueFunction,
	inspectStaticValueFunctions,
} from "./helpers/static-values.ts";

const helpers = `const assign=function assign(value,other,observe){const result=Object.assign(value,other);for(let i=0;i<3;i++)observe();return result;};
const unbox=function unbox(value,observe){const result=Number.prototype.valueOf.call(value);for(let i=0;i<3;i++)observe();return result;};
const branched=function branched(value,flag,observe){const result=flag?value:Object.assign(value,{});for(let i=0;i<3;i++)observe();return result;};
const reverse=function reverse(observe){const result=Array.prototype.reverse.call(this);for(let i=0;i<3;i++)observe();return result;};
const object=function object(value){const result=Object(value);for(let i=0;i<3;i++)globalThis.gc?.();return result;};
const assignMiddle=function assignMiddle(value,other,observe){const result=assign(value,other,observe);for(let i=0;i<3;i++)observe();return result;};
const assignOuter=function assignOuter(value,other,observe){const result=assignMiddle(value,other,observe);for(let i=0;i<3;i++)observe();return result;};
const numberOuter=function numberOuter(value,observe){const result=unbox(value,observe);for(let i=0;i<3;i++)observe();return result;};
const reordered=function reordered(other,observe,value){const result=assignOuter(value,other,observe);for(let i=0;i<3;i++)observe();return result;};
const recursive=function recursive(value,steps,observe){if(steps>0)return recursive(value,steps-1,observe);const result=assign(value,{},observe);for(let i=0;i<3;i++)observe();return result;};
const joined=function joined(value,flag,observe){const result=flag?assignOuter(value,{},observe):value;for(let i=0;i<3;i++)observe();return result;};
const prefix=function prefix(value,observe,args){const result=assignOuter(value,{},observe,...args);for(let i=0;i<3;i++)observe();return result;};
const list=function list(value,observe,args){const result=assignOuter(...args);for(let i=0;i<3;i++)observe();return result;};`;
const bodies = {
	assignObject:
		"const target=value?{}:[];const result=assign(target,other,observe);observe();return Object.is(result,target);",
	assignPrimitive:
		"const number=value|0;const result=assign(number,other,observe);observe();return Object.is(result,number);",
	assignUnknown:
		"const result=assign(value,other,observe);observe();return Object.is(result,value);",
	assignReturn: "const result=assign(value?{}:[],other,observe);observe();return result;",
	chainObject:
		"const target=value?{}:[];const result=assignOuter(target,other,observe);observe();return Object.is(result,target);",
	chainPrimitive:
		"const number=value|0;const result=assignOuter(number,other,observe);observe();return Object.is(result,number);",
	chainUnknown:
		"const result=assignOuter(value,other,observe);observe();return Object.is(result,value);",
	chainNumber:
		"const number=value|0;const result=numberOuter(number,observe);observe();return Object.is(result,number);",
	chainNaN:
		"const number=+value;const result=numberOuter(number,observe);observe();return Object.is(result,number);",
	chainNumberUnknown:
		"const result=numberOuter(value,observe);observe();return Object.is(result,value);",
	chainRange:
		"const number=value>>>0;const result=numberOuter(number,observe);observe();return result;",
	chainReordered:
		"const target=value?{}:[];const result=reordered(other,observe,target);return Object.is(result,target);",
	chainRecursive:
		"const target=value?{}:[];const result=recursive(target,3,observe);return Object.is(result,target);",
	chainJoined:
		"const target=value?{}:[];const result=joined(target,key,observe);return Object.is(result,target);",
	chainJoinedUnknown:
		"const result=joined(value,key,observe);return Object.is(result,value);",
	chainPrefix:
		"const target=value?{}:[];const result=prefix(target,observe,other);return Object.is(result,target);",
	chainList:
		"const target=value?{}:[];const result=list(target,observe,other);return Object.is(result,target);",
	numberInteger:
		"const number=value|0;const result=unbox(number,observe);observe();return Object.is(result,number);",
	numberRange:
		"const number=value>>>0;const result=unbox(number,observe);observe();return result;",
	numberBox:
		"const target=new Number(value);const result=unbox(target,observe);observe();return Object.is(result,target);",
	numberUnknown:
		"const result=unbox(value,observe);observe();return Object.is(result,value);",
	branchObject:
		"const target=value?{}:[];const result=branched(target,key,observe);observe();return Object.is(result,target);",
	branchPrimitive:
		"const number=value|0;const result=branched(number,key,observe);observe();return Object.is(result,number);",
	receiverObject:
		"const target={pass:reverse,length:0};const result=target.pass(observe);observe();return Object.is(result,target);",
	receiverPrimitive:
		"const number=value|0;const result=reverse.call(number,observe);observe();return Object.is(result,number);",
	omitted: "return object();",
};

describe.each(["precise", "conservative"] as const)(
	"conditional return identities with %s roots",
	(stackRoots) => {
		it.each([false, true])("checks every input condition with locked=%s", (locked) => {
			const source = `${helpers}${Object.entries(bodies)
				.map(
					([name, body]) =>
						`function ${name}(value,key,other,observe){${body}}globalThis.${name}=${name};`,
				)
				.join("\n")}`;
			const results = inspectStaticValueFunctions(source, Object.keys(bodies), {
				locked,
				stackRoots,
			});
			for (const name of [
				"assignObject",
				"numberInteger",
				"branchObject",
				"receiverObject",
				"chainObject",
				"chainPrimitive",
				"chainNumber",
				"chainNaN",
				"chainReordered",
				"chainRecursive",
				"chainJoined",
				"chainPrefix",
			]) {
				const out = results.get(name)!;
				expect(
					out.core.some((op) => op.opcode === "call"),
					name,
				).toBe(true);
				if (locked)
					expect(
						out.core.some((op) => op.attributes.operation === "Object.is"),
						name,
					).toBe(false);
			}
			for (const name of [
				"assignUnknown",
				"numberUnknown",
				"chainNumberUnknown",
				"branchPrimitive",
				"chainUnknown",
				"chainJoinedUnknown",
				"chainList",
			]) {
				const out = results.get(name)!;
				expect(
					out.core.some(
						(op) =>
							op.attributes.operation === "Object.is" ||
							(op.attributes.knownBuiltinCall as { operation?: string } | undefined)
								?.operation === "Object.is",
					),
					name,
				).toBe(true);
			}
			if (!locked) return;
			for (const name of ["numberRange", "chainRange"]) {
				const range = results.get(name)!;
				const ip = range.native.body.instructions.findIndex(
					(op) => op.opcode === "CALL" && op.arguments.length === 2,
				);
				expect(ip).toBeGreaterThanOrEqual(0);
				expect(range.native.facts![ip]!.resultIntegerRanges).toEqual([
					COMPILER_UINT32_RANGE,
				]);
				expect(range.native.facts![ip]!.resultKindMasks).toEqual([
					COMPILER_VALUE_KIND_NUMBER,
				]);
				const artifact = deserializeCompilerArtifact(
					serializeCompilerArtifact(range.image),
				);
				expect(
					artifact.native.functions[range.image.native.functions.indexOf(range.native)]!
						.facts,
				).toEqual(range.native.facts);
			}
			const omitted = results.get("omitted")!;
			const omittedCall = omitted.native.body.instructions.findIndex(
				(op) => op.opcode === "CALL",
			);
			expect(omitted.native.facts![omittedCall]!.resultKindMasks).toEqual([
				COMPILER_VALUE_KIND_OBJECT,
			]);
		});
	},
);

it.each([false, true])(
	"uses an Object receiver without assuming primitive normalization preserves identity (script=%s)",
	(script) => {
		const source = `const receiver=function receiver(observe){for(let i=0;i<3;i++)observe();return this;};function target(value,observe){const input={pass:receiver};const result=input.pass(observe);return Object.is(result,input);}globalThis.receiver=receiver;globalThis.target=target;`;
		const out = inspectStaticValueFunction(source, "target", { script });
		expect(out.core.some((op) => op.attributes.operation === "Object.is")).toBe(false);
		const primitive = inspectStaticValueFunction(
			source.replace(
				"const input={pass:receiver};const result=input.pass(observe);",
				"const input=value|0;const result=receiver.call(input,observe);",
			),
			"target",
			{ script },
		);
		expect(primitive.core.some((op) => op.attributes.operation === "Object.is")).toBe(
			true,
		);
	},
);
