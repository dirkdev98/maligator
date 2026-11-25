import { setTimeout as delay } from "node:timers/promises";

const response = new Response("body");
setTimeout(Object.setPrototypeOf, 0, response, { text: () => 42 });
await delay(10);
console.log(typeof (await response.text()) === "number");
