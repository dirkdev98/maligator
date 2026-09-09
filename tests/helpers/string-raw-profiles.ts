export const stringRawSegments = [
	"[x]",
	"[x,x]",
	"['<',x,'>',x]",
	"[String(x),x]",
	"[+x,y]",
	"[BigInt(x),y]",
] as const;

export const stringRawProfiles = [
	"direct",
	"escape",
	"consumer",
	"unused",
	"loop",
	"suspension",
	"call",
	"apply",
	"reflect",
	"bind",
] as const;

export function stringRawSource(
	segments: string,
	profile: (typeof stringRawProfiles)[number],
	name = "probe",
) {
	const args = `{raw:${segments}},y,effect('argument'),y`;
	const call =
		profile === "call"
			? `String.raw.call(undefined,${args})`
			: profile === "apply"
				? `String.raw.apply(undefined,[${args}])`
				: profile === "reflect"
					? `Reflect.apply(String.raw,undefined,[${args}])`
					: profile === "bind"
						? `String.raw.bind(undefined)(${args})`
						: `String.raw(${args})`;
	let body: string;
	switch (profile) {
		case "loop":
			body = `let value;for(let i=0;i<n;i++){value=${call};effect(value);}return value;`;
			break;
		case "suspension":
			body = `const value=${call};yield effect(value);return value;`;
			break;
		case "unused":
			body = `${call};return 17;`;
			break;
		case "consumer":
			body = `return ${call}.length;`;
			break;
		case "escape":
			body = `const value=${call};effect(value);return value;`;
			break;
		default:
			body = `return ${call};`;
	}
	return `function${profile === "suspension" ? "*" : ""} ${name}(x,y,effect,n){${body}}globalThis.${name}=${name};`;
}
