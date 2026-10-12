import {test,expect} from "@playwright/test";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {readFile} from "node:fs/promises";
const exec=promisify(execFile);
const channel="44444444-4444-4444-8444-444444444444", api="http://localhost:4100";
test.skip(process.env.TEST_SCANNING!=="true","Requires the real local scanner overlay; test doubles do not qualify");
test.setTimeout(180000);
test("real scanner persists queued uploads across worker restart, allows clean downloads and rejects EICAR",async({page,context})=>{
  await page.goto(`/?channel=${channel}`);
  await page.getByLabel("Email address").fill("alice@acme.test");await page.getByLabel("Password",{exact:true}).fill("Development123!");await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await page.locator(".tabs").getByRole("button",{name:"Files",exact:true}).click();
  const name=`scan-live-${Date.now()}.txt`,content="Real scanner integration, persistent clean bytes.";
  let stopped=false;
  try {
    await exec("docker",["stop","concord-collaboration-file-worker-1"]);stopped=true;
    await page.locator('input[type="file"]').setInputFiles({name,mimeType:"text/plain",buffer:Buffer.from(content)});
    const row=page.locator(".file-row").filter({hasText:name});
    await expect(row).toContainText("quarantined");
    await expect(row.getByRole("link",{name:"Download",exact:true})).toHaveCount(0);
    await exec("docker",["start","concord-collaboration-file-worker-1"]);stopped=false;
    await expect(row).toContainText("ready",{timeout:120000});
    const downloading=page.waitForEvent("download");await row.getByRole("link",{name:"Download",exact:true}).click();
    const downloaded=await downloading;expect(downloaded.suggestedFilename()).toBe(name);expect(await readFile((await downloaded.path())!,"utf8")).toBe(content);
    const eicar=String.raw`X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*`;
    const infectedName=`antivirus-test-${Date.now()}.txt`;
    await page.locator('input[type="file"]').setInputFiles({name:infectedName,mimeType:"text/plain",buffer:Buffer.from(eicar)});
    const rejected=page.locator(".file-row").filter({hasText:infectedName});await expect(rejected).toContainText("rejected",{timeout:120000});
    await expect(rejected.getByRole("link",{name:"Download",exact:true})).toHaveCount(0);
    const files=(await (await context.request.get(`${api}/v1/channels/${channel}/files`)).json()).files;
    const infected=files.find((f:{name:string})=>f.name===infectedName);
    expect((await context.request.get(`${api}/v1/channels/${channel}/files/${infected.id}/download`)).status()).toBe(409);
    await page.screenshot({path:"docs/evidence/file-scanning.png"});
    await row.getByRole("button",{name:"Delete",exact:true}).click();await rejected.getByRole("button",{name:"Delete",exact:true}).click();
  } finally {if(stopped)await exec("docker",["start","concord-collaboration-file-worker-1"]);}
});

test("scanned attachments reach another user, survive lost-response retry and disappear after file deletion",async({page,context,browser})=>{
  const other=await browser.newContext(),bob=await other.newPage();
  const login=async(p:typeof page,email:string)=>{
    await p.goto(`/?channel=${channel}`);await p.getByLabel("Email address").fill(email);await p.getByLabel("Password",{exact:true}).fill("Development123!");await p.getByRole("button",{name:"Sign in",exact:true}).click();
    await expect(p.getByRole("heading",{name:"General standard",exact:true})).toBeVisible();
  };
  try {
    await login(page,"alice@acme.test");await login(bob,"bob@acme.test");
    const name=`shared-${Date.now()}.txt`,content="Real scanned attachment content",text=`Attachment caption ${Date.now()}`;
    const upload=await context.request.post(`${api}/v1/channels/${channel}/files`,{headers:{origin:"http://localhost:3101"},data:{name,mime:"text/plain",content:Buffer.from(content).toString("base64")}});
    expect(upload.status()).toBe(200);const file=(await upload.json()).id;
    await expect.poll(async()=>{
      const r=await context.request.get(`${api}/v1/channels/${channel}/files`);return (await r.json()).files.find((f:{id:string})=>f.id===file)?.state;
    },{timeout:120000}).toBe("ready");
    const pattern=`**/v1/channels/${channel}/messages`;
    await page.route(pattern,async route=>{if(route.request().method()==="POST"){await route.fetch();await route.abort("failed");await page.unroute(pattern);}else await route.continue();});
    await page.getByRole("textbox",{name:"Message",exact:true}).fill(text);
    await page.getByRole("button",{name:"Attach file",exact:true}).click();
    await page.getByRole("button",{name:`Send file ${name}`,exact:true}).click();
    await expect(page.getByRole("button",{name:"Retry safely"})).toBeVisible();
    await page.reload();await expect(page.getByRole("button",{name:"Retry safely"})).toBeEnabled();
    await page.getByRole("button",{name:"Retry safely"}).click();
    await expect(page.getByRole("button",{name:"Retry safely"})).toHaveCount(0);
    const message=bob.locator("article").filter({hasText:text});await expect(message).toHaveCount(1);
    const downloadPromise=bob.waitForEvent("download");await message.getByRole("link",{name,exact:true}).click();
    const download=await downloadPromise;expect(download.suggestedFilename()).toBe(name);expect(await readFile((await download.path())!,"utf8")).toBe(content);
    await bob.reload();await expect(message.getByRole("link",{name,exact:true})).toBeVisible();
    await message.scrollIntoViewIfNeeded();
    await bob.screenshot({path:"docs/evidence/message-attachments.png"});
    expect((await context.request.delete(`${api}/v1/channels/${channel}/files/${file}`,{headers:{origin:"http://localhost:3101"}})).status()).toBe(200);
    await expect(message.getByText("Attachment unavailable",{exact:true})).toBeVisible();
    await expect(message.getByRole("link",{name,exact:true})).toHaveCount(0);
    expect((await other.request.get(`${api}/v1/channels/${channel}/files/${file}/download`)).status()).toBe(404);
    const history=await context.request.get(`${api}/v1/channels/${channel}/messages`);
    expect((await history.json()).messages.filter((m:{body:string})=>m.body===text)).toHaveLength(1);
  } finally {await other.close();}
});
