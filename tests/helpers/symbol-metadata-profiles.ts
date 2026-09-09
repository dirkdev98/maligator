export const symbolMetadataCases = [
	["Symbol", "String(x)"],
	["Symbol.for", "String(x)"],
	["Symbol.for", "x"],
	["Symbol", "+x"],
	["Symbol", "Boolean(+x)"],
	["Symbol", "BigInt(x)"],
] as const;

export const symbolMetadataConsumers = [
	"symbol.description",
	"Object(symbol).description",
	"Reflect.get(Symbol.prototype,'description',symbol)",
	"Object.getOwnPropertyDescriptor(Symbol.prototype,'description').get.call(symbol)",
	"Symbol.keyFor(symbol)",
	"Reflect.apply(Symbol.keyFor,undefined,[symbol])",
] as const;

export const symbolMetadataProfiles = [
	"direct",
	"escape",
	"consumer",
	"repeated",
	"loop",
	"suspension",
	"unused",
	"apply",
] as const;

export function symbolMetadataSource(
	[producer, key]: readonly [string, string],
	consumer: string,
	profile: (typeof symbolMetadataProfiles)[number],
	name = "probe",
) {
	const create =
		profile === "apply"
			? `Reflect.apply(${producer},undefined,[${key}])`
			: `${producer}(${key})`;
	let body: string;
	switch (profile) {
		case "direct":
			body = `return ${consumer};`;
			break;
		case "consumer":
			body = `effect(symbol);return typeof ${consumer};`;
			break;
		case "escape":
		case "apply":
			body = `effect(symbol);return ${consumer};`;
			break;
		case "repeated":
			body = `effect(symbol);effect(${consumer});return ${consumer};`;
			break;
		case "loop":
			body = `effect(symbol);let result;for(let i=0;i<n;i++){result=${consumer};effect(result);}return result;`;
			break;
		case "suspension":
			body = `yield effect(symbol);return ${consumer};`;
			break;
		case "unused":
			body = `effect(symbol);${consumer};return 17;`;
			break;
	}
	return `function${profile === "suspension" ? "*" : ""} ${name}(x,effect,n){const symbol=${create};${body}}globalThis.${name}=${name};`;
}
