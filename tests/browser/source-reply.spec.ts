import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',team='33333333-3333-4333-8333-333333333333',bob='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',headers={origin:'http://localhost:3101'};
test.use({actionTimeout:10000});
test.skip(process.env.TEST_SCANNING!=='true','Requires actual scanned attachment processing');

test('an older exact source prepares a scoped reply with both drafts intact and preserves pending send identity',async({page,context,browser})=>{
  test.setTimeout(180000);
  const owner=await browser.newContext(),channels:string[]=[],messages:{channel:string;id:string}[]=[],gates=new Set<()=>void>();let file='';
  try{
    for(const [session,email] of [[owner,'alice@acme.test'],[context,'bob@acme.test']] as const)expect((await session.request.post(`${api}/v1/session`,{headers,data:{email,password:'Development123!'}})).ok()).toBe(true);
    const token=Date.now();
    for(const label of ['Active source reply draft','Older reply destination']){
      const response=await owner.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name:`${label} ${token}`,kind:'private',teamId:team,members:[bob]}});
      expect(response.ok()).toBe(true);channels.push((await response.json()).id);
    }
    const [active,destination]=channels,base=`${api}/v1/channels/${destination}`,body=`Older exact parent ${token}`;
    const make=async(text:string)=>{const response=await owner.request.post(base+'/messages',{headers,data:{clientId:crypto.randomUUID(),body:text}});expect(response.status()).toBe(201);const id=(await response.json()).id as string;messages.push({channel:destination,id});return id;};
    const parent=await make(body);for(let i=0;i<51;i++)await make(`Recent source reply fixture ${token} ${i}`);
    expect((await (await context.request.get(base+'/messages')).json()).messages.some((m:{id:string})=>m.id===parent)).toBe(false);
    expect((await context.request.post(`${base}/messages/${parent}/save`,{headers,data:{saved:true}})).ok()).toBe(true);
    const activeDraft=`Keep outgoing source reply text ${token}`,destinationDraft=`Prepared reply caption ${token}`,filename=`source-reply-${token}.txt`;
    for(const [channel,text] of [[active,activeDraft],[destination,destinationDraft]])expect((await context.request.put(`${api}/v1/channels/${channel}/draft`,{headers,data:{body:text}})).ok()).toBe(true);
    const upload=await context.request.post(base+'/files',{headers,data:{name:filename,mime:'text/plain',content:Buffer.from('Actual scanned source reply attachment').toString('base64')}});
    expect(upload.ok()).toBe(true);file=(await upload.json()).id;
    await expect.poll(async()=>(await context.request.get(`${base}/files/${file}/download`)).status(),{timeout:120000}).toBe(200);
    await page.goto(`/?org=${org}&channel=${destination}`);
    const input=page.getByRole('textbox',{name:'Message',exact:true}),send=page.getByRole('button',{name:'Send message',exact:true}),draft=page.getByRole('region',{name:'Reply draft',exact:true}),attachments=page.getByRole('region',{name:'Selected attachments',exact:true});
    await expect(input).toHaveValue(destinationDraft);await page.getByRole('button',{name:'Attach file',exact:true}).click();
    await page.getByRole('dialog',{name:'Attach files',exact:true}).getByRole('button',{name:`Add file ${filename}`,exact:true}).click();await expect(attachments).toContainText(filename);
    await page.goto(`/?org=${org}&channel=${active}`);await expect(input).toHaveValue(activeDraft);
    const dialog=page.getByRole('dialog',{name:'Linked message',exact:true}),selected=dialog.getByRole('article',{name:'Selected message',exact:true}),reply=dialog.getByRole('button',{name:'Reply to this message',exact:true});
    const openSaved=async()=>{await page.getByRole('button',{name:'Saved',exact:true}).click();await page.getByRole('region',{name:'Saved messages',exact:true}).getByRole('article').filter({hasText:body}).getByRole('button',{name:'Open saved message',exact:true}).click();await expect(selected).toContainText(body);};
    const source=`${api}/v1/organizations/${org}/channels/${destination}/messages/${parent}`,outgoing=`${api}/v1/channels/${active}/draft`;
    const posts:{parentId:string;body:string;attachmentIds:string[];clientId:string}[]=[];
    page.on('request',r=>{if(r.url()===base+'/messages'&&r.method()==='POST')posts.push(r.postDataJSON());});
    await openSaved();
    // Action-time validation must fail closed even when the earlier display was valid.
    await page.route(source,r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"Source reply check unavailable"}'}));
    await reply.click();await expect(dialog.getByRole('alert')).toContainText('Source reply check unavailable');await expect(selected).toHaveCount(0);await expect(reply).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('channel')).toBe(active);expect(posts).toHaveLength(0);
    await page.unroute(source);await dialog.getByRole('button',{name:'Retry message',exact:true}).click();await expect(reply).toBeEnabled();
    let timed=false,timedAborted=false,unblock:(()=>void)|undefined;
    page.on('requestfailed',r=>{if(r.url()===source)timedAborted=true;});
    await page.route(source,async r=>{const response=await r.fetch();timed=true;await new Promise<void>(resolve=>{unblock=resolve;gates.add(resolve);});await r.fulfill({response}).catch(()=>{});});
    await reply.click();await expect.poll(()=>timed).toBe(true);
    await expect(dialog.getByRole('alert')).toContainText('Message could not be checked',{timeout:12000});await expect.poll(()=>timedAborted).toBe(true);await expect(reply).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('channel')).toBe(active);expect(posts).toHaveLength(0);unblock?.();await page.unroute(source);
    await dialog.getByRole('button',{name:'Retry message',exact:true}).click();await expect(reply).toBeEnabled();
    // A failed outgoing flush cannot move the conversation or select a new target.
    await page.route(outgoing,r=>r.request().method()==='PUT'?r.fulfill({status:503,contentType:'application/json',body:'{"error":"Outgoing draft flush unavailable"}'}):r.continue());
    await reply.click();await expect(dialog.getByRole('alert')).toContainText('Reply could not be prepared');expect(new URL(page.url()).searchParams.get('channel')).toBe(active);
    expect(await page.evaluate(()=>sessionStorage.getItem('concord.draft-replies.v1'))).toBeNull();await page.unroute(outgoing);
    // Closing after a real draft commit aborts the held response and prevents late selection.
    let held=false,aborted=false,release:(()=>void)|undefined;
    page.on('requestfailed',r=>{if(r.url()===outgoing&&r.method()==='PUT')aborted=true;});
    await page.route(outgoing,async r=>{if(r.request().method()!=='PUT'){await r.continue();return;}const response=await r.fetch();held=true;await new Promise<void>(resolve=>{release=resolve;gates.add(resolve);});await r.fulfill({response}).catch(()=>{});});
    await reply.click();await expect.poll(()=>held).toBe(true);await expect(reply).toBeDisabled();
    await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await expect.poll(()=>aborted).toBe(true);release?.();await page.unroute(outgoing);
    expect(new URL(page.url()).searchParams.get('channel')).toBe(active);expect(await page.evaluate(()=>sessionStorage.getItem('concord.draft-replies.v1'))).toBeNull();
    await openSaved();
    // Invalid tab metadata cannot silently replace a target or bypass recovery.
    await page.evaluate(()=>sessionStorage.setItem('concord.draft-replies.v1','{invalid'));
    await reply.click();await expect(dialog.getByRole('alert')).toContainText('Saved reply selections are invalid');expect(new URL(page.url()).searchParams.get('channel')).toBe(active);
    await page.evaluate(()=>sessionStorage.removeItem('concord.draft-replies.v1'));
    await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await openSaved();
    const axe=await new AxeBuilder({page}).include('dialog[open]').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);
    await page.setViewportSize({width:390,height:844});expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.setViewportSize({width:1280,height:900});
    await dialog.screenshot({path:'docs/evidence/source-reply.png'});
    // Preparation does not send: destination text/files stay selected until explicit Send.
    let flushes=0;page.on('request',r=>{if(r.url()===outgoing&&r.method()==='PUT')flushes++;});
    await reply.evaluate(element=>{(element as HTMLButtonElement).click();(element as HTMLButtonElement).click();});await expect(dialog).toHaveCount(0);expect(flushes).toBe(1);expect(new URL(page.url()).searchParams.get('channel')).toBe(destination);
    await expect(input).toHaveValue(destinationDraft);await expect(draft).toContainText(body);await expect(attachments).toContainText(filename);await expect(send).toBeEnabled();expect(posts).toHaveLength(0);
    expect((await (await context.request.get(outgoing)).json()).body).toBe(activeDraft);
    // Actual accepted reply with a lost response keeps its immutable parent/body/files.
    const endpoint=base+'/messages';await page.route(endpoint,async r=>{if(r.request().method()!=='POST'){await r.continue();return;}expect((await r.fetch()).status()).toBe(201);await r.abort('connectionclosed');});
    await send.click();await expect(page.getByRole('button',{name:'Retry safely',exact:true})).toBeEnabled();expect(posts).toHaveLength(1);expect(posts[0].parentId).toBe(parent);expect(posts[0].body).toBe(destinationDraft);expect(posts[0].attachmentIds).toEqual([file]);await page.unroute(endpoint);
    // Pending destination operation cannot have its selected parent overwritten from another channel.
    await page.goto(`/?org=${org}&channel=${active}`);await expect(input).toHaveValue(activeDraft);await openSaved();await reply.click();await expect(dialog.getByRole('alert')).toContainText('Resolve the unconfirmed message');expect(new URL(page.url()).searchParams.get('channel')).toBe(active);expect(posts).toHaveLength(1);
    await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await page.goto(`/?org=${org}&channel=${destination}`);await expect(draft).toContainText(body);
    await page.evaluate(id=>{window.location.hash='message-'+id;},parent);await expect(selected).toContainText(body);await expect(reply).toBeDisabled();await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
    await page.getByRole('button',{name:'Retry safely',exact:true}).click();await expect(input).toHaveValue('');expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);
    const accepted=(await (await context.request.get(endpoint)).json()).messages.filter((m:{body:string})=>m.body===destinationDraft);expect(accepted).toHaveLength(1);expect(accepted[0].parent_id).toBe(parent);messages.push({channel:destination,id:accepted[0].id});
    await expect(attachments).toHaveCount(0);await expect(draft).toHaveCount(0);
    // The already-active conversation updates the current hook without a scope switch.
    await page.evaluate(id=>{window.location.hash='message-'+id;},parent);await expect(reply).toBeEnabled();await reply.click();await expect(dialog).toHaveCount(0);await expect(draft).toContainText(body);await expect(input).toHaveValue('');expect(posts).toHaveLength(2);
    await draft.getByRole('button',{name:'Cancel reply',exact:true}).click();await expect(draft).toHaveCount(0);
    // Real deletion after display is rejected by the action-time source read.
    await page.evaluate(id=>{window.location.hash='message-'+id;},parent);await expect(reply).toBeEnabled();
    expect((await owner.request.delete(`${base}/messages/${parent}`,{headers})).ok()).toBe(true);
    await reply.click();await expect(dialog.getByRole('alert')).toContainText('Message unavailable');await expect(selected).toHaveCount(0);await expect(reply).toHaveCount(0);await expect(draft).toHaveCount(0);expect(posts).toHaveLength(2);
  }finally{
    for(const release of gates)release();await page.unrouteAll({behavior:'wait'});
    for(const message of messages)await owner.request.delete(`${api}/v1/channels/${message.channel}/messages/${message.id}`,{headers});
    if(file&&channels[1])await context.request.delete(`${api}/v1/channels/${channels[1]}/files/${file}`,{headers});
    for(const channel of channels){const base=`${api}/v1/channels/${channel}`,r=await owner.request.get(base+'/settings');if(r.ok()){const s=await r.json();await owner.request.patch(base+'/details',{headers,data:{name:s.name,description:s.description,archived:true,revision:s.revision}});}}
    await owner.close();
  }
});
