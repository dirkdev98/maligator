const response = Response.json({ value: "é" });
console.log(await response.text());
