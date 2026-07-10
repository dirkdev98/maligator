// Second dependency module: a distinct namespace object, so the fixture exercises
// more than one MalModuleNamespaceObject exports allocation.
export const x = 10;
export const y = 20;
export const z = 30;
export function sum() {
	return x + y + z;
}
