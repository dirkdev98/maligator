import { describe, expect, it } from "vitest";
import { inspectStaticValueFunction } from "./helpers/static-values.ts";

describe("virtual local state", () => {
	it.each([
		"new Boolean(x)",
		"new Number(x)",
		"new Number(+x)",
		"new String(x)",
		"Object(String(x))",
		"Object(!!x)",
		"Object(+x)",
		"Object(BigInt(x))",
		"Object(Symbol.for(x))",
	])("eliminates private own-property transitions on %s", (producer) => {
		const inspected = inspectStaticValueFunction(
			`function probe(x) {
				const box = ${producer};
				const alias = box;
				box.note = x;
				alias.note = 7;
				delete box.note;
				box.other = x;
				return (box.note === undefined) + alias.other;
			} globalThis.probe = probe;`,
			"probe",
		);
		expect(
			inspected.core.some(
				(op) =>
					op.opcode === "callKnown" &&
					(op.attributes.construct || op.attributes.operation === "Object"),
			),
		).toBe(false);
		expect(
			inspected.core.some((op) =>
				["storePropertyStatic", "loadPropertyStatic", "deleteProperty"].includes(
					op.opcode,
				),
			),
		).toBe(false);
	});
	it.each([
		"new Boolean(x)",
		"new Number(x)",
		"new Number(+x)",
		"new String(x)",
		"Object(String(x))",
		"Object(BigInt(x))",
	])(
		"materializes the current own state and primitive slot of %s at escape",
		(producer) => {
			const inspected = inspectStaticValueFunction(
				`function probe(x) {
					const box = ${producer};
					box.note = x;
					delete box.note;
					box.other = x;
					return box;
				} globalThis.probe = probe;`,
				"probe",
			);
			expect(
				inspected.core.filter(
					(op) =>
						op.opcode === "callKnown" &&
						(op.attributes.construct || op.attributes.operation === "Object"),
				),
			).toHaveLength(1);
			expect(inspected.core.filter((op) => op.opcode === "defineProperty")).toHaveLength(
				1,
			);
			expect(inspected.core.some((op) => op.opcode === "deleteProperty")).toBe(false);
		},
	);
	it.each(["Object(x)", "Reflect.construct(Boolean, [x], globalThis.Target)"])(
		"retains conversion, exotic state or newTarget behavior in %s",
		(producer) => {
			const inspected = inspectStaticValueFunction(
				`function probe(x) { const box = ${producer}; box.note = x; return box.note; }
			globalThis.probe = probe;`,
				"probe",
			);
			expect(inspected.core.some((op) => op.opcode === "storePropertyStatic")).toBe(true);
		},
	);
	it.each(["Number", "String"])(
		"preserves %s conversion while discarding initializer state",
		(brand) => {
			const result = inspectStaticValueFunction(
				`function probe(x) { const box = new ${brand}(x()); box.note = 17; return 0; } globalThis.probe=probe;`,
				"probe",
			);
			expect(result.structure.allocations).toBe(0);
			expect(result.core.some((op) => op.attributes.construct)).toBe(false);
			expect(result.structure.genericCalls).toBe(1);
			expect(
				result.core.filter((op) =>
					brand === "Number"
						? op.attributes.operation === "Number"
						: op.attributes.operator === "tostring",
				),
			).toHaveLength(1);
		},
	);
	it.each(["new String(x)", "Object(String(x))"])(
		"retains String exotic state after named writes in %s",
		(producer) => {
			for (const observation of [
				"box[0] = 'z';",
				"box.length = 0;",
				"delete box[0];",
				"Object.defineProperty(box, '0', {value:'z'});",
			]) {
				const result = inspectStaticValueFunction(
					`function probe(x) { const box = ${producer}; box.note = 1; delete box.note; ${observation} return box; } globalThis.probe=probe;`,
					"probe",
				);
				expect(
					result.core.some(
						(op) => op.attributes.construct || op.attributes.operation === "Object",
					),
				).toBe(true);
			}
		},
	);
	it("retains inherited setters and nonconfigurable wrapper properties", () => {
		for (const body of [
			"box.__proto__ = x; return box.__proto__;",
			"Object.defineProperty(box, 'note', {value:x}); delete box.note; return 0;",
		]) {
			const inspected = inspectStaticValueFunction(
				`function probe(x) { const box = new Boolean(x); ${body} } globalThis.probe = probe;`,
				"probe",
			);
			expect(inspected.core.some((op) => op.attributes.construct)).toBe(true);
		}
	});
	it("retains mutable prototype observations during wrapper state updates", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x) { const box = new Boolean(x); box.note = x; return box.note; } globalThis.probe = probe;",
			"probe",
			{ locked: false },
		);
		expect(inspected.core.some((op) => op.opcode === "construct")).toBe(true);
		expect(inspected.core.some((op) => op.opcode === "storePropertyStatic")).toBe(true);
	});
	it.each(["[x()]", "({value:x()})", "({[x()]:1})"])(
		"discards private initializer storage after preserving effects in %s",
		(expression) => {
			const inspected = inspectStaticValueFunction(
				`function probe(x) { ${expression}; return 0; } globalThis.probe=probe;`,
				"probe",
			);
			expect(inspected.structure.allocations).toBe(0);
			expect(inspected.structure.genericCalls).toBe(1);
			if (expression.includes("[x()]:"))
				expect(
					inspected.core.some((operation) => operation.opcode === "toPropertyKey"),
				).toBe(true);
		},
	);
	it("retains initializer storage exposed to a producer's later observation", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x) { const value = [x()]; x(value); return 0; } globalThis.probe=probe;",
			"probe",
		);
		expect(inspected.structure.allocations).toBe(1);
		expect(inspected.structure.genericCalls).toBe(2);
	});
	it("scalar-replaces repeated exact data spreads", () => {
		const inspected = inspectStaticValueFunction(
			`function probe(limit) {
				const source = {kind: 3, flags: 5};
				const alias = source;
				let total = 0;
				for (let index = 0; index < limit; index++) {
					const copy = {...alias, value: index, next: index + 1};
					total += copy.kind + copy.flags + copy.value + copy.next;
				}
				return total;
			} globalThis.probe = probe;`,
			"probe",
		);
		expect(inspected.structure.allocations).toBe(0);
		expect(
			inspected.core.some((operation) => operation.opcode === "mergeDataProperties"),
		).toBe(false);
		expect(
			inspected.core.some((operation) =>
				["defineProperty", "loadPropertyStatic"].includes(operation.opcode),
			),
		).toBe(false);
	});
	it.each([
		"source.kind = limit;",
		"sink(source);",
		"const alias = source; alias.flags = limit;",
	])("retains a spread when its source is not private and stable: %s", (effect) => {
		const inspected = inspectStaticValueFunction(
			`function probe(limit, sink) {
				const source = {kind: 3, flags: 5};
				${effect}
				const copy = {...source, value: limit};
				return copy.kind + copy.value;
			} globalThis.probe = probe;`,
			"probe",
		);
		expect(
			inspected.core.some((operation) => operation.opcode === "mergeDataProperties"),
		).toBe(true);
	});
	it("retains enumerable getter behavior during spread", () => {
		const inspected = inspectStaticValueFunction(
			`function probe(effect) {
				const source = {get value() { return effect(); }};
				return {...source}.value;
			} globalThis.probe = probe;`,
			"probe",
		);
		expect(
			inspected.core.some((operation) => operation.opcode === "mergeDataProperties"),
		).toBe(true);
	});
	it.each([
		"const a = [1, 2]; a.push(x); const last = a.pop(); return last + a.length;",
		"const a = [1, 2]; a[0] = x; delete a[1]; a.length = 1; return a[0];",
		"const a = {x: 1}; const b = a; b.x = x; delete b.x; return b.x;",
		"const a = {v: 1}; if (x) a.v = 2; else a.v = 3; return a.v;",
		"let sum = 0; for (let i = 0; i < 3; i++) { const a = [i]; a.push(x); sum += a.pop(); } return sum;",
	])("erases the private storage after local transitions: %s", (body) => {
		const inspected = inspectStaticValueFunction(
			`function probe(x) { ${body} } globalThis.probe = probe;`,
			"probe",
		);
		expect(inspected.structure.allocations).toBe(0);
		expect(inspected.structure.operations).toHaveLength(0);
	});

	it("materializes the current state at an escaping call", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x, sink) { const a = [1, 2]; a.push(x); a.pop(); a[0] = x; sink(a); return a; } globalThis.probe = probe;",
			"probe",
		);
		expect(inspected.structure.allocations).toBe(1);
		expect(inspected.structure.operations).toHaveLength(0);
		expect(inspected.structure.pooledMaterializations).toBe(0);
	});

	it.each([
		["const a=[1,2,3]; a.reverse(); return a[0]*10+a[2];", 31],
		["const a=[1,2]; const before=a[0]; a.reverse(); return before*10+a[0];", 12],
		["const a=[1,2]; a.reverse().push(3); return a.pop()*10+a[0];", 32],
		["const a=[]; a.reverse(); return a.length;", 0],
		["const a=[9]; a.reverse(); return a[0];", 9],
		[
			"const a=[1,2,3]; const before=a[1]; const first=a.shift(); return first*100+before*10+a[0];",
			122,
		],
		[
			"const a=[,2,undefined,4]; const first=a.shift(); return (first===undefined)*100+a.length*10+a[0];",
			undefined,
		],
		["const a=[]; a['-1']=7; a.shift(); return a['-1'];", 7],
		["const a=[]; a['-1']=7; a.pop(); return a['-1'];", 7],
		["const a=[1]; a.shift(); return a.length;", 0],
		["const a=[3,4]; a.reverse(); const first=a.shift(); return first*10+a[0];", 43],
		[
			"const a=[1,2]; const before=a[1]; const count=a.unshift(7,8); return count*100+before*10+a[3];",
			422,
		],
		["const a=[,2]; return a.unshift()*10+a.length;", 22],
		["const a=[]; a['-1']=9; return a.unshift()+a['-1'];", 9],
		["const a=[undefined,,4]; return a.unshift(1)*10+a[3];", 44],
		[
			"const a=[1,2,3,4]; const before=a[2]; a.fill(9,-2,undefined); return before*100+a[2]*10+a[3];",
			399,
		],
		[
			"const a=[1,,3]; a.fill(); return (a[0]===undefined)*10+(a[1]===undefined);",
			undefined,
		],
		["const a=[1,2,3]; a.fill(9,'1.9',undefined); return a[0]*100+a[1]*10+a[2];", 199],
		["const a=[1,2,3]; a.fill(8,-Infinity,Infinity); return a[0]+a[2];", 16],
		["const a=[1,2,3]; a.fill(8,NaN,null); return a[0]+a[2];", 4],
		["const a=[1,2]; return a.fill(7).pop();", 7],
		[
			"const a=[1,2,3,4,5]; a.copyWithin(1,0,4); return a[0]*10000+a[1]*1000+a[2]*100+a[3]*10+a[4];",
			11234,
		],
		[
			"const a=[1,2,3,4,5]; a.copyWithin(0,1); return a[0]*10000+a[1]*1000+a[2]*100+a[3]*10+a[4];",
			23455,
		],
		["const a=[1,2,3,4,5]; a.copyWithin(3,0,2); return a[3]*10+a[4];", 12],
		[
			"const a=[1,2,3]; const before=a[1]; a.copyWithin(1,0,2); return before*100+a[1]*10+a[2];",
			212,
		],
		["const a=[1,2,3,4]; a.copyWithin('-2.9',0,undefined); return a[2]*10+a[3];", 12],
		["const a=[1,2,3]; a.copyWithin(0,1,undefined); return a[0]*100+a[1]*10+a[2];", 233],
		["const a=[1,2,3]; a.copyWithin(0,1,null); return a[0]*100+a[1]*10+a[2];", 123],
		["const a=[1,2]; a.copyWithin(Infinity,0); return a[0]*10+a[1];", 12],
		["const a=[1,,undefined,4]; a.copyWithin(1,0,3); return a[0]*10+a[1];", 11],
		["const a=[1,2,3]; return a.copyWithin(1,0,2).shift()*100+a[0]*10+a[1];", 112],
		["const a=[]; a['-1']=7; a.copyWithin(); return a['-1'];", 7],
	] as const)("transfers private array state: %s", (body, expected) => {
		const inspected = inspectStaticValueFunction(
			`function probe() { ${body} } globalThis.probe=probe;`,
			"probe",
		);
		expect(inspected.structure.allocations).toBe(0);
		expect(inspected.structure.operations).toHaveLength(0);
		const returned = inspected.fn.instructions.find(
			(instruction) => instruction.opcode === "RETURN",
		);
		expect(returned).toBeDefined();
		const result = inspected.fn.instructions.findLast(
			(instruction) => "dst" in instruction && instruction.dst === returned!.value,
		);
		if (expected !== undefined) expect(result).toMatchObject({ value: expected });
	});

	it("materializes a reversed alias with sparse cells and dynamic child identities", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x,sink) { const a=[x,,undefined,4]; const b=a.reverse(); sink(b); return a; } globalThis.probe=probe;",
			"probe",
		);
		expect(inspected.structure.allocations).toBe(1);
		expect(
			inspected.core.some((op) => op.attributes.operation === "Array.prototype.reverse"),
		).toBe(false);
		expect(inspected.structure.genericCalls).toBe(1);
	});

	it("materializes a returned reverse receiver without copying its dynamic child", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x) { const a=[x,,4]; return a.reverse(); } globalThis.probe=probe;",
			"probe",
		);
		expect(inspected.structure.allocations).toBe(1);
		expect(
			inspected.core.some((op) => op.attributes.operation === "Array.prototype.reverse"),
		).toBe(false);
	});

	it("retains a method call when argument evaluation stops the state transfer", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(effect) { const a=[1,2]; a.reverse(effect()); return a[0]; } globalThis.probe=probe;",
			"probe",
		);
		expect(inspected.structure.allocations).toBeGreaterThan(0);
		expect(
			inspected.core.some((op) => op.attributes.operation === "Array.prototype.reverse"),
		).toBe(true);
	});

	it.each([
		"Object.freeze(a);",
		"Object.defineProperty(a,'1',{writable:false});",
		"Object.setPrototypeOf(a,proto);",
		"sink(a);",
	])("retains reverse after an observable state boundary: %s", (boundary) => {
		const inspected = inspectStaticValueFunction(
			`function probe(proto,sink) { const a=[1,2]; ${boundary} Array.prototype.reverse.call(a); return a; } globalThis.probe=probe;`,
			"probe",
		);
		expect(inspected.structure.allocations).toBeGreaterThan(0);
		expect(
			inspected.core.some((op) => op.attributes.operation === "Array.prototype.reverse"),
		).toBe(true);
	});

	it.each([
		"Object.freeze(a);",
		"Object.defineProperty(a,'1',{writable:false});",
		"Object.setPrototypeOf(a,proto);",
		"sink(a);",
	])("retains shift after an observable state boundary: %s", (boundary) => {
		const inspected = inspectStaticValueFunction(
			`function probe(proto,sink) { const a=[1,2,3]; ${boundary} Array.prototype.shift.call(a); return a; } globalThis.probe=probe;`,
			"probe",
		);
		expect(inspected.structure.allocations).toBeGreaterThan(0);
		expect(
			inspected.core.some((op) => op.attributes.operation === "Array.prototype.shift"),
		).toBe(true);
	});

	it.each(["unshift", "fill"])(
		"materializes %s state with dynamic child identity",
		(method) => {
			const inspected = inspectStaticValueFunction(
				`function probe(x) { const a=[1,,3]; const result=a.${method}(x); return a; } globalThis.probe=probe;`,
				"probe",
			);
			expect(inspected.structure.allocations).toBe(1);
			expect(
				inspected.core.some(
					(op) => op.attributes.operation === `Array.prototype.${method}`,
				),
			).toBe(false);
		},
	);

	it.each(["unshift", "fill"])(
		"retains %s after observable state boundaries",
		(method) => {
			for (const boundary of [
				"Object.freeze(a);",
				"Object.defineProperty(a,'1',{writable:false});",
				"Object.setPrototypeOf(a,proto);",
				"sink(a);",
			]) {
				const inspected = inspectStaticValueFunction(
					`function probe(proto,sink) { const a=[1,2,3]; ${boundary} Array.prototype.${method}.call(a,9); return a; } globalThis.probe=probe;`,
					"probe",
				);
				expect(inspected.structure.allocations).toBeGreaterThan(0);
				expect(
					inspected.core.some(
						(op) => op.attributes.operation === `Array.prototype.${method}`,
					),
				).toBe(true);
			}
		},
	);

	it("retains unshift growth beyond the virtual array limit", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x) { const a=[]; a.length=64; return a.unshift(x); } globalThis.probe=probe;",
			"probe",
		);
		expect(
			inspected.core.some((op) => op.attributes.operation === "Array.prototype.unshift"),
		).toBe(true);
	});

	it("retains dynamic fill bounds and their coercion", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(start,end) { const a=[1,2,3]; return a.fill(9,start,end); } globalThis.probe=probe;",
			"probe",
		);
		expect(
			inspected.core.some((op) => op.attributes.operation === "Array.prototype.fill"),
		).toBe(true);
	});

	it("materializes the copyWithin receiver with repeated dynamic children and sparse deletion", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(x) { const a=[x,,undefined,4]; return a.copyWithin(1,0,3); } globalThis.probe=probe;",
			"probe",
		);
		expect(inspected.structure.allocations).toBe(1);
		expect(
			inspected.core.some(
				(op) => op.attributes.operation === "Array.prototype.copyWithin",
			),
		).toBe(false);
	});

	it.each([
		"Object.freeze(a);",
		"Object.defineProperty(a,'1',{writable:false});",
		"Object.defineProperty(a,'1',{configurable:false});",
		"Object.setPrototypeOf(a,proto);",
		"sink(a);",
	])("retains copyWithin after an observable state boundary: %s", (boundary) => {
		const inspected = inspectStaticValueFunction(
			`function probe(proto,sink) { const a=[1,2,,4]; ${boundary} Array.prototype.copyWithin.call(a,0,1,3); return a; } globalThis.probe=probe;`,
			"probe",
		);
		expect(inspected.structure.allocations).toBeGreaterThan(0);
		expect(
			inspected.core.some(
				(op) => op.attributes.operation === "Array.prototype.copyWithin",
			),
		).toBe(true);
	});

	it("retains all dynamic copyWithin coercions even for a known empty range", () => {
		const inspected = inspectStaticValueFunction(
			"function probe(start,end) { const a=[1,2,3]; return a.copyWithin(Infinity,start,end); } globalThis.probe=probe;",
			"probe",
		);
		expect(
			inspected.core.some(
				(op) => op.attributes.operation === "Array.prototype.copyWithin",
			),
		).toBe(true);
	});
});
