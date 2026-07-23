import { EventEmitter } from "node:events";

function first() {}
function second() {}
function third() {}

const singleton = new EventEmitter();
singleton.on("only", first);
singleton.removeListener("only", first);

const promoted = new EventEmitter();
promoted.on("work", first);
promoted.prependListener("work", second);
promoted.on("work", third);
promoted.removeListener("work", third);
promoted.removeListener("work", second);
promoted.removeListener("work", first);

const once = new EventEmitter();
once.once("tick", first);
once.emit("tick");

console.log("RESULT 1/1");
