// Injecting services by the parameter names in a function's source finds none, since Maligator keeps no source text.
const services = {
	clock: () => "12:00",
	greeting: () => "hello",
};

function inject(fn) {
	const source = Function.prototype.toString.call(fn);
	const names = source
		.slice(source.indexOf("(") + 1, source.indexOf(")"))
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");
	return fn(...names.map((name) => services[name]()));
}

console.log(inject((greeting, clock) => `${greeting} at ${clock}`));
