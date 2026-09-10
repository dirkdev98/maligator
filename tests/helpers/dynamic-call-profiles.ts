export const dynamicCallProfiles = [
	"typed",
	"consumer",
	"escape",
	"loop",
	"suspension",
	"apply",
	"unused",
	"repeated",
	"repeatedLoop",
] as const;

export function dynamicCallProfileSource(
	[callee, receiver, args]: readonly [string, string, string],
	profile: (typeof dynamicCallProfiles)[number],
	valueExpression: string,
	name = "probe",
) {
	const call = `${callee}.call(${receiver}${args ? `,${args}` : ""})`;
	let body: string;
	switch (profile) {
		case "typed":
			body = `return ${call};`;
			break;
		case "consumer":
			body = `return typeof ${call};`;
			break;
		case "escape":
			body = `const result=${call};effect(result);return result;`;
			break;
		case "loop":
			body = `let result;for(let i=0;i<n;i++){result=${call};effect(result);}return result;`;
			break;
		case "suspension":
			body = `yield effect(value);return ${call};`;
			break;
		case "apply":
			body = `return Reflect.apply(${callee},${receiver},[${args}]);`;
			break;
		case "repeatedLoop":
			body = `for(let i=0;i<n;i++){const result=${call};effect(result);if(result!==${call})return false;}return true;`;
			break;
		case "repeated":
			body = `const result=${call};effect(result);return result===${call};`;
			break;
		case "unused":
			body = `${call};return 17;`;
			break;
	}
	return `function${profile === "suspension" ? "*" : ""} ${name}(x,effect,n){const value=${valueExpression};${body}}globalThis.${name}=${name};`;
}
