const urls = process.argv.length > 2 ? process.argv.slice(2) : ["http://localhost:3101", "http://localhost:4100/ready"];
for (const url of urls) {
  let ok = false;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) {
        ok = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!ok) throw new Error(`Not ready: ${url}`);
}
