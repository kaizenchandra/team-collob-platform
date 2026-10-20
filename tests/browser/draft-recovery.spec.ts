import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',team='33333333-3333-4333-8333-333333333333',headers={origin:'http://localhost:3101'};
test.use({actionTimeout:10000});
test('saved draft failures have read-only retry without losing text, reply or pending send identity',async({page,context})=>{
  test.setTimeout(90000);let channel='',release:(()=>void)|undefined;
  try{
    expect((await context.request.post(`${api}/v1/session`,{headers,data:{email:'alice@acme.test',password:'Development123!'}})).ok()).toBe(true);
    const created=await context.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name:`Draft recovery ${Date.now()}`,kind:'private',teamId:team,members:[]}});expect(created.ok()).toBe(true);channel=(await created.json()).id;
    const base=`${api}/v1/channels/${channel}`,draftUrl=base+'/draft',caption=`Restored saved text ${Date.now()}`;
    const parentResponse=await context.request.post(base+'/messages',{headers,data:{clientId:crypto.randomUUID(),body:'Draft recovery parent'}});expect(parentResponse.status()).toBe(201);const parent=(await parentResponse.json()).id;
    expect((await context.request.put(draftUrl,{headers,data:{body:caption}})).ok()).toBe(true);
    await page.goto(`/?org=${org}&channel=${channel}`);const input=page.getByRole('textbox',{name:'Message',exact:true}),send=page.getByRole('button',{name:'Send message',exact:true}),reply=page.getByRole('region',{name:'Reply draft'}),saved=page.getByRole('region',{name:'Saved text draft'}),retry=page.getByRole('button',{name:'Retry saved draft',exact:true});
    await expect(input).toHaveValue(caption);await page.locator('article').filter({hasText:'Draft recovery parent'}).getByRole('button',{name:'Reply to message',exact:true}).click();await expect(reply).toContainText('Draft recovery parent');
    let mode:'503'|'invalid'|'denied'|'timeout'|'real'='503',gets=0,eventConnections=0;const writes:unknown[]=[],posts:unknown[]=[];
    page.on('request',r=>{if(r.url()===draftUrl&&r.method()==='PUT')writes.push(r.postDataJSON());if(r.url()===base+'/messages'&&r.method()==='POST')posts.push(r.postDataJSON());if(r.url().startsWith(base+'/events?'))eventConnections++;});
    await page.route(draftUrl,async route=>{
      if(route.request().method()!=='GET'){await route.continue();return;}gets++;
      if(mode==='real'){await route.continue();return;}
      if(mode==='timeout'){await new Promise<void>(resolve=>{release=resolve;});await route.continue().catch(()=>{});return;}
      await route.fulfill({status:mode==='invalid'?200:mode==='denied'?403:503,contentType:'application/json',body:mode==='invalid'?'{"body":42}':'{"error":"Synthetic draft read failure"}'});
    });
    await page.reload();await expect(retry).toBeEnabled();await expect(input).toBeDisabled();await expect(send).toBeDisabled();await expect(page.getByRole('button',{name:'Add emoji',exact:true})).toBeDisabled();await expect(reply).toContainText('Draft recovery parent');
    expect(writes).toEqual([]);expect(posts).toEqual([]);expect((await (await context.request.get(draftUrl)).json()).body).toBe(caption);const connections=eventConnections;
    for(const failure of ['invalid','denied'] as const){mode=failure;const count=gets;await retry.click();await expect.poll(()=>gets).toBe(count+1);await expect(retry).toBeEnabled();await expect(input).toBeDisabled();expect(writes).toEqual([]);expect(posts).toEqual([]);}
    mode='timeout';await retry.click();await expect(saved.getByRole('status')).toContainText('Loading saved draft');await expect(retry).toHaveCount(0);await expect(saved.getByRole('alert')).toContainText('timed out',{timeout:12000});await expect(retry).toBeEnabled();expect(writes).toEqual([]);expect(eventConnections).toBe(connections);release?.();
    const axe=await new AxeBuilder({page}).include('.composer-wrap').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.setViewportSize({width:1280,height:900});await saved.scrollIntoViewIfNeeded();await page.screenshot({path:'docs/evidence/draft-recovery.png'});
    mode='real';await retry.click();await expect(input).toHaveValue(caption);await expect(input).toBeEnabled();await expect(saved).toHaveCount(0);await expect(reply).toContainText('Draft recovery parent');expect(posts).toEqual([]);expect(eventConnections).toBe(connections);
    // Real acceptance with lost response produces an immutable pending operation.
    await page.route(base+'/messages',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}expect((await route.fetch()).status()).toBe(201);await route.abort('connectionclosed');});await send.click();await expect(page.getByRole('button',{name:'Retry safely',exact:true})).toBeEnabled();expect(posts).toHaveLength(1);const operation=posts[0];await page.unroute(base+'/messages');mode='503';await page.reload();await expect(retry).toBeEnabled();await expect(page.getByRole('button',{name:'Retry safely',exact:true})).toBeDisabled();expect(posts).toHaveLength(1);
    mode='real';await retry.click();await expect(page.getByRole('button',{name:'Retry safely',exact:true})).toBeEnabled();expect(posts).toHaveLength(1);await page.getByRole('button',{name:'Retry safely',exact:true}).click();await expect(page.getByRole('button',{name:'Retry safely',exact:true})).toHaveCount(0);expect(posts).toHaveLength(2);expect(posts[1]).toEqual(operation);const messages=(await (await context.request.get(base+'/messages')).json()).messages.filter((m:{body:string})=>m.body===caption);expect(messages).toHaveLength(1);expect(messages[0].parent_id).toBe(parent);
  }finally{
    release?.();await page.unrouteAll({behavior:'wait'});
    if(channel){const base=`${api}/v1/channels/${channel}`;for(const m of (await (await context.request.get(base+'/messages')).json()).messages??[])if(!m.deleted)await context.request.delete(`${base}/messages/${m.id}`,{headers});const r=await context.request.get(base+'/settings');if(r.ok()){const s=await r.json();await context.request.patch(base+'/details',{headers,data:{name:s.name,description:s.description,archived:true,revision:s.revision}});}}
  }
});
