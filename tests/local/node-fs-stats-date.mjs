import { statSync } from "node:fs";

const Timestamp = statSync("bench/size/hello.txt").mtime.constructor;
console.log(
	new Timestamp(0).getTimezoneOffset(),
	new Timestamp(15638400000).getTimezoneOffset(),
);
