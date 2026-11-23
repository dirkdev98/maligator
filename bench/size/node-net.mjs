import { createServer } from "node:net";

const server = createServer();
console.log(typeof server.listen);
