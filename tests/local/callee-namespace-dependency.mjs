export function first(value) {
	return value + 700;
}

export function second(value) {
	return value + 800;
}

export function fixed(value) {
	return value + 600;
}

export let run = first;

export function select(secondTarget) {
	run = secondTarget ? second : first;
}

export function install(target) {
	run = target;
}
