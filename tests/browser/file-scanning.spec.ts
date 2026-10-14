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

test("upload lost-response recovery reuses the original operation after reload and file reselection",async({page,context})=>{
  await page.goto(`/?channel=${channel}`);
  await page.getByLabel("Email address").fill("alice@acme.test");await page.getByLabel("Password",{exact:true}).fill("Development123!");await page.getByRole("button",{name:"Sign in",exact:true}).click();
  await page.locator(".tabs").getByRole("button",{name:"Files",exact:true}).click();
  const name=`retry-upload-${Date.now()}.txt`,file={name,mimeType:"text/plain",buffer:Buffer.from("Same operation after browser reload")};
  const pattern=`**/v1/channels/${channel}/files`;
  let firstId="",acceptedFile="";
  await page.route(pattern,async route=>{
    if(route.request().method()==="POST"){
      firstId=route.request().postDataJSON().clientId;
      const accepted=await route.fetch();expect(accepted.status()).toBe(200);acceptedFile=(await accepted.json()).id;
      await route.abort("failed");await page.unroute(pattern);
    }else await route.continue();
  });
  await page.locator('input[type="file"]').setInputFiles(file);
  await expect(page.getByRole("alert").filter({hasText:/fetch|network|failed/i})).toBeVisible();
  expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
  await page.reload();await page.locator(".tabs").getByRole("button",{name:"Files",exact:true}).click();
  const retry=page.waitForRequest(r=>r.method()==="POST" && r.url()===`${api}/v1/channels/${channel}/files`);
  await page.locator('input[type="file"]').setInputFiles(file);
  expect((await retry).postDataJSON().clientId).toBe(firstId);
  const row=page.locator(".file-row").filter({hasText:name});await expect(row).toHaveCount(1);await expect(row).toContainText("ready",{timeout:120000});
  const response=await context.request.get(`${api}/v1/channels/${channel}/files`);
  const matches=(await response.json()).files.filter((f:{name:string})=>f.name===name);expect(matches).toHaveLength(1);expect(matches[0].id).toBe(acceptedFile);
  await expect.poll(()=>page.evaluate(()=>sessionStorage.getItem("concord.pending-uploads.v1"))).toBeNull();
  await row.getByRole("button",{name:"Delete",exact:true}).click();
});

test("real scanned text previews escape markup, recover failures and withdraw deleted content",async({page,context,browser})=>{
  const other=await browser.newContext(),bob=await other.newPage();
  const login=async(p:typeof page,email:string)=>{
    await p.goto(`/?channel=${channel}`);await p.getByLabel("Email address").fill(email);await p.getByLabel("Password",{exact:true}).fill("Development123!");await p.getByRole("button",{name:"Sign in",exact:true}).click();
    await p.locator(".tabs").getByRole("button",{name:"Files",exact:true}).click();
  };
  let file="";
  try {
    await login(page,"alice@acme.test");await login(bob,"bob@acme.test");
    const name=`preview-${Date.now()}.md`,source='<img src="https://example.invalid/beacon" onerror="alert(1)">\n[link](https://example.invalid)\n'+"x".repeat(40000);
    const uploaded=await context.request.post(`${api}/v1/channels/${channel}/files`,{headers:{origin:"http://localhost:3101"},data:{name,mime:"text/markdown",content:Buffer.from(source).toString("base64")}});
    expect(uploaded.status()).toBe(200);file=(await uploaded.json()).id;
    const row=bob.locator(".file-row").filter({hasText:name});
    await expect(row).toContainText("ready",{timeout:120000});
    const pattern=`**/v1/channels/${channel}/files/${file}/preview`;
    await bob.route(pattern,route=>route.abort("failed"));
    await row.getByRole("button",{name:"Preview",exact:true}).click();
    const dialog=bob.getByRole("dialog",{name:`Preview: ${name}`,exact:true});
    await expect(dialog.getByRole("alert")).toBeVisible();
    await bob.unroute(pattern);await dialog.getByRole("button",{name:"Retry preview"}).click();
    await expect(dialog.getByLabel("File source text")).toHaveText(source.slice(0,32768));
    await expect(dialog.getByRole("status")).toContainText("Preview truncated");
    await expect(dialog.locator("img,script,a,iframe")).toHaveCount(0);
    await dialog.getByLabel("File source text").focus();await bob.keyboard.press("Escape");await expect(dialog).toHaveCount(0);
    await row.getByRole("button",{name:"Preview",exact:true}).click();await expect(dialog.getByLabel("File source text")).toBeVisible();
    await bob.screenshot({path:"docs/evidence/file-preview.png"});
    expect((await context.request.delete(`${api}/v1/channels/${channel}/files/${file}`,{headers:{origin:"http://localhost:3101"}})).status()).toBe(200);
    await expect(dialog.getByRole("alert")).toContainText("File unavailable",{timeout:15000});
    await expect(dialog.getByLabel("File source text")).toHaveCount(0);
  } finally {
    if(file)await context.request.delete(`${api}/v1/channels/${channel}/files/${file}`,{headers:{origin:"http://localhost:3101"}});
    await other.close();
  }
});

test('file versions preserve old bytes, recover accepted uploads and revoke history after root deletion',async({page,context,browser})=>{
  const other=await browser.newContext(),bob=await other.newPage();let root='';
  const login=async(p:typeof page,email:string)=>{
    await p.goto(`/?channel=${channel}`);await p.getByLabel('Email address').fill(email);await p.getByLabel('Password',{exact:true}).fill('Development123!');await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.locator('.tabs').getByRole('button',{name:'Files',exact:true}).click();
  };
  try{
    await login(page,'alice@acme.test');await login(bob,'bob@acme.test');
    const name=`versions-${Date.now()}.txt`;
    const upload=await context.request.post(`${api}/v1/channels/${channel}/files`,{headers:{origin:'http://localhost:3101'},data:{name,mime:'text/plain',content:Buffer.from('original version').toString('base64')}});expect(upload.status()).toBe(200);root=(await upload.json()).id;
    const row=page.locator('.file-row').filter({hasText:name});await expect(row).toContainText('ready',{timeout:120000});
    await row.getByRole('button',{name:'Versions',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:`Versions: ${name}`,exact:true});
    const pattern=`**/v1/channels/${channel}/files`;let operation='';
    await page.route(pattern,async route=>{if(route.request().method()==='POST'){operation=route.request().postDataJSON().clientId;await route.fetch();await route.abort('failed');await page.unroute(pattern);}else await route.continue();});
    const selection={name,mimeType:'text/plain',buffer:Buffer.from('updated version')};
    await dialog.getByLabel('Upload new version',{exact:true}).setInputFiles(selection);await expect(dialog.getByRole('alert')).toBeVisible();
    await page.reload();await page.locator('.tabs').getByRole('button',{name:'Files',exact:true}).click();await row.getByRole('button',{name:'Versions',exact:true}).click();
    const retry=page.waitForRequest(r=>r.method()==='POST' && r.url()===`${api}/v1/channels/${channel}/files`);
    await dialog.getByLabel('Upload new version',{exact:true}).setInputFiles(selection);expect((await retry).postDataJSON().clientId).toBe(operation);
    await expect(dialog.getByRole('link',{name:'Download version 2',exact:true})).toBeVisible({timeout:120000});
    await bob.locator('.file-row').filter({hasText:name}).getByRole('button',{name:'Versions',exact:true}).click();
    const bobDialog=bob.getByRole('dialog',{name:`Versions: ${name}`,exact:true});await expect(bobDialog.getByText('Version 2',{exact:true})).toBeVisible();await expect(bobDialog.getByLabel('Upload new version',{exact:true})).toHaveCount(0);
    for(const [number,content] of [[1,'original version'],[2,'updated version']] as const){const pending=bob.waitForEvent('download');await bobDialog.getByRole('link',{name:`Download version ${number}`,exact:true}).click();expect(await readFile((await (await pending).path())!,'utf8')).toBe(content);}
    const history=await context.request.get(`${api}/v1/channels/${channel}/files/${root}/versions`);expect((await history.json()).versions).toHaveLength(2);
    await bob.screenshot({path:'docs/evidence/file-versions.png'});
    expect((await context.request.delete(`${api}/v1/channels/${channel}/files/${root}`,{headers:{origin:'http://localhost:3101'}})).status()).toBe(200);
    await expect(bobDialog.getByRole('alert')).toContainText('File unavailable');await expect(bobDialog.getByRole('link')).toHaveCount(0);
  }finally{if(root)await context.request.delete(`${api}/v1/channels/${channel}/files/${root}`,{headers:{origin:'http://localhost:3101'}});await other.close();}
});
