const response = new Response("AB");
const text = await response.text();
console.log(`${text},${response.body.locked}`);
