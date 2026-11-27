// Naming the services next to the function works without its source text.
const services = {
	clock: () => "12:00",
	greeting: () => "hello",
};

function inject(names, fn) {
	return fn(...names.map((name) => services[name]()));
}

console.log(
	inject(["greeting", "clock"], (greeting, clock) => `${greeting} at ${clock}`),
);
