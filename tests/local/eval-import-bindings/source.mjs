export let counter = 1;
export function setCounter(value) {
	counter = value;
}
export default function receiver() {
	return this;
}
