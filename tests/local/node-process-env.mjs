const env = process.env;
const key = "MALIGATOR_PROCESS_ENV_BOUNDARY";
let coercions = 0;
env[key] = {
	[Symbol.toPrimitive](hint) {
		if (hint !== "string") throw new Error(hint);
		coercions++;
		return 42;
	},
};
console.log(
	`${env === process.env} ${typeof env[key]} ${env[key]} ${coercions} ${Object.keys(env).includes(key)}`,
);

Reflect.defineProperty(env, key, {
	value: false,
	configurable: true,
	enumerable: true,
	writable: true,
});
console.log(`${typeof env[key]} ${env[key]}`);
console.log(`${structuredClone(env)[key]}`);
try {
	env[key] = Symbol();
} catch (error) {
	console.log(`${error.name}`);
}
console.log(`${delete env[key]} ${Object.hasOwn(env, key)}`);
