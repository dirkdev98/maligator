"use strict";

/* oxlint-disable -- This compatibility fixture intentionally uses untyped CommonJS. */

const { EventEmitter } = require("events");
const iconv = require("iconv-lite");
const onFinished = require("on-finished");

let finishObserved = false;
let decoded;

function report() {
	if (!finishObserved || decoded === undefined) return;
	console.log("RESULT " + (decoded === "hé €" ? "1/1" : "0/1"));
}

const message = new EventEmitter();
message.finished = false;
message.socket = new EventEmitter();
message.socket.writable = true;
onFinished(message, () => {
	finishObserved = true;
	report();
});
message.emit("finish");

const decoder = iconv.decodeStream("utf8");
decoder.collect((error, text) => {
	decoded = error ? null : text;
	report();
});
decoder.write(Buffer.from("hé ", "utf8"));
decoder.write(Buffer.from([0xe2]));
decoder.end(Buffer.from([0x82, 0xac]));
