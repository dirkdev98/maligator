export const registryKeys = [
	"String(x)",
	"+x",
	"Boolean(x)",
	"BigInt(x)",
	"'static'",
	"undefined",
	"null",
] as const;
export const registryProfiles = [
	"escape",
	"consumer",
	"unused",
	"loop",
	"call",
	"apply",
	"reflect",
	"bind",
] as const;

export function registrySource(key: string, profile: string, name = "target") {
	const invoke =
		profile === "call"
			? "Symbol.for.call(null,key,effect('argument'))"
			: profile === "apply"
				? "Symbol.for.apply(null,[key,effect('argument')])"
				: profile === "reflect"
					? "Reflect.apply(Symbol.for,null,[key,effect('argument')])"
					: profile === "bind"
						? "Symbol.for.bind(null,key)(effect('argument'))"
						: "Symbol.for(key)";
	const body =
		profile === "unused"
			? `${invoke};effect('between');${invoke};return 0;`
			: profile === "consumer"
				? `const a=${invoke};effect(a);return a===${invoke};`
				: profile === "loop"
					? `let result;for(let i=0;i<count;i++){const a=${invoke};effect(a);const b=${invoke};effect(b);result=a===b;}return result;`
					: `const a=${invoke};effect(a);const b=${invoke};effect(b);return [a,b,a===b];`;
	return `function ${name}(x,effect,count){const key=${key};${body}}globalThis.${name}=${name};`;
}
