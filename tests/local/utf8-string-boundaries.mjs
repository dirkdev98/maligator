import { Buffer, constants } from "node:buffer";
import { StringDecoder } from "node:string_decoder";

const maximum = constants.MAX_STRING_LENGTH;
function check(condition) {
	if (!condition) throw new Error("UTF-8 output boundary mismatch");
}

const count = Math.floor((maximum * 2) / 3) + 1;
const multibyte = Buffer.alloc(count * 3, "€");
const stream = new StringDecoder();
check(stream.write(multibyte).length === count);
check(stream.end() === "");
check(new TextDecoder().decode(multibyte).length === count);
check((await new Response(multibyte).text()).length === count);

const withBom = Buffer.alloc(maximum + 3, "a");
withBom[0] = 0xef;
withBom[1] = 0xbb;
withBom[2] = 0xbf;
check(new TextDecoder().decode(withBom).length === maximum);
check((await new Response(withBom).text()).length === maximum);

let rejected = false;
try {
	new TextDecoder("utf-8", { ignoreBOM: true }).decode(withBom);
} catch (error) {
	rejected = error instanceof RangeError;
}
check(rejected);
rejected = false;
try {
	new StringDecoder().end(withBom);
} catch (error) {
	rejected = error instanceof RangeError;
}
check(rejected);
console.log("utf8-string-boundaries PASS");
