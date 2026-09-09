export const constantCallProfiles = [
	"effects",
	"escape",
	"loop",
	"suspension",
	"repeated",
	"unused",
	"apply",
] as const;

export function constantCallProfileSource(
	[callee, receiver, args]: ReadonlyArray<string>,
	profile: (typeof constantCallProfiles)[number],
	name = "probe",
) {
	const call = `${callee}.call(${receiver}${args ? `,${args}` : ""})`;
	let body: string;
	switch (profile) {
		case "effects":
			body = `x('before');const value=${call};x('after');return value;`;
			break;
		case "escape":
			body = `const value=${call};x(value);return value;`;
			break;
		case "loop":
			body = `let value;for(let i=0;i<n;i++){value=${call};x(value);}return value;`;
			break;
		case "suspension":
			body = `const value=${call};yield x(value);return ${call};`;
			break;
		case "repeated":
			body = `const value=${call};x(value);return value===${call};`;
			break;
		case "unused":
			body = `x('before');${call};x('after');return 17;`;
			break;
		case "apply":
			body = `return Reflect.apply(${callee},(x('extra'),${receiver}),[${args}]);`;
			break;
	}
	return `function${profile === "suspension" ? "*" : ""} ${name}(x,n){${body}}globalThis.${name}=${name};`;
}
