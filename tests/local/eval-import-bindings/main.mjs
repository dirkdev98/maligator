import receiver, { current as counter, setCounter } from "./barrel.mjs";
import { pending as unfinished } from "./main.mjs";
import * as source from "./source.mjs";

function observe(fn) {
	try {
		return fn();
	} catch (error) {
		return error.name;
	}
}

const results = [];
results.push(observe(() => eval("0")));
results.push(observe(() => eval("typeof unfinished")));
export let pending = 7;
results.push(observe(() => eval("unfinished")));
results.push(observe(() => eval("[counter, setCounter(3), counter]")));
const reader = observe(() => eval("() => counter"));
setCounter(9);
results.push(observe(() => reader()));
results.push(observe(() => eval("receiver() === undefined")));
results.push(observe(() => eval("counter = 8")));
results.push(observe(() => eval("counter++")));
results.push(observe(() => eval("({ counter } = { counter: 8 })")));
results.push(observe(() => eval("source.counter")));
{
	const counter = 42;
	results.push(observe(() => eval("counter")));
}
function first(value) {
	return eval("arguments[0]");
}
results.push(observe(() => first(11)));
console.log(JSON.stringify(results));
