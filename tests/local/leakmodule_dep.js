// Dependency module for the module-namespace leak fixture. Its exported bindings
// back a MalModuleNamespaceObject (with a malloc'd `exports` array) when imported
// via `import * as ns`.
export const alpha = 1;
export const beta = "two";
export let counter = 0;
export function bump() {
	counter++;
	return counter;
}
export const table = { a: 1, b: 2, c: 3 };
