import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',team='33333333-3333-4333-8333-333333333333',bob='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',headers={origin:'http://localhost:3101'};
test.use({actionTimeout:10000});
test('mention picker waits for saved text and bounds member reads with validation, retry and close cancellation',async({page,context})=>{
  test.setTimeout(90000);let channel='',release:(()=>void)|undefined;
  try{
    expect((await context.request.post(`${api}/v1/session`,{headers,data:{email:'alice@acme.test',password:'Development123!'}})).ok()).toBe(true);
    const made=await context.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name:`Mention picker ${Date.now()}`,kind:'private',teamId:team,members:[bob]}});expect(made.ok()).toBe(true);channel=(await made.json()).id;const base=`${api}/v1/channels/${channel}`,caption=`Preserved mention draft ${Date.now()} `;
    expect((await context.request.put(base+'/draft',{headers,data:{body:caption}})).ok()).toBe(true);
    let draftStarted=false;const draftGate=new Promise<void>(resolve=>{release=resolve;});
    await page.route(base+'/draft',async route=>{if(route.request().method()!=='GET'){await route.continue();return;}draftStarted=true;await draftGate;await route.continue().catch(()=>{});});
    await page.goto(`/?org=${org}&channel=${channel}`);await expect.poll(()=>draftStarted).toBe(true);const mention=page.getByRole('button',{name:'Mention a person',exact:true}),input=page.getByRole('textbox',{name:'Message',exact:true});await expect(mention).toBeDisabled();release?.();await page.unroute(base+'/draft');await expect(input).toHaveValue(caption);await expect(mention).toBeEnabled();
    const posts:unknown[]=[];page.on('request',r=>{if(r.url()===base+'/messages'&&r.method()==='POST')posts.push(r.postDataJSON());});
    let mode:'503'|'denied'|'invalid'|'duplicate'|'timeout'|'empty'|'real'|'held'='503',reads=0,aborted=0;
    page.on('requestfailed',r=>{if(r.url()===base+'/members')aborted++;});
    await page.route(base+'/members',async route=>{
      reads++;
      if(mode==='real'){await route.continue();return;}
      if(mode==='timeout'||mode==='held'){await new Promise<void>(resolve=>{release=resolve;});await route.continue().catch(()=>{});return;}
      const body=mode==='empty'?{members:[]}:mode==='invalid'?{members:[{id:'bad',name:42}]}:mode==='duplicate'?{members:[{id:bob,name:'Bob Chen'},{id:bob,name:'Bob Chen'}]}:{error:'Synthetic picker read failure'};
      await route.fulfill({status:mode==='denied'?403:mode==='503'?503:200,contentType:'application/json',body:JSON.stringify(body)});
    });
    await mention.click();const dialog=page.getByRole('dialog',{name:'Mention someone',exact:true}),retry=dialog.getByRole('button',{name:'Retry members',exact:true}),search=dialog.getByLabel('Find a channel member');await expect(retry).toBeEnabled();await search.fill('Bob');
    for(const failure of ['denied','invalid','duplicate'] as const){mode=failure;const count=reads;await retry.click();await expect.poll(()=>reads).toBe(count+1);await expect(retry).toBeEnabled();await expect(dialog.getByRole('button',{name:'Bob Chen',exact:true})).toHaveCount(0);await expect(search).toHaveValue('Bob');expect(posts).toEqual([]);}
    mode='timeout';await retry.click();await expect(dialog.getByRole('status')).toContainText('Loading channel members');await expect(retry).toHaveCount(0);await expect(retry).toBeEnabled({timeout:12000});release?.();await expect(search).toHaveValue('Bob');expect(posts).toEqual([]);await expect(input).toHaveValue(caption);
    mode='empty';await retry.click();await expect(dialog.getByText('No channel members are available.',{exact:true})).toBeVisible();await dialog.getByRole('button',{name:'Close dialog'}).click();mode='real';await mention.click();await search.fill('Nobody matches this');await expect(dialog.getByText('No matching channel members.',{exact:true})).toBeVisible();await search.fill('Bob');await expect(dialog.getByRole('button',{name:'Bob Chen',exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'Alice Morgan',exact:true})).toHaveCount(0);
    const axe=await new AxeBuilder({page}).include('dialog').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'docs/evidence/mention-picker.png'});
    await dialog.getByRole('button',{name:'Bob Chen',exact:true}).click();const composed=caption+`[@Bob Chen](concord-mention:${bob}) `;await expect(input).toHaveValue(composed);expect(posts).toEqual([]);await expect.poll(async()=>(await (await context.request.get(base+'/draft')).json()).body).toBe(composed);
    mode='held';const before=reads,aborts=aborted;await mention.click();await expect.poll(()=>reads).toBe(before+1);await dialog.getByRole('button',{name:'Close dialog'}).click();await expect.poll(()=>aborted).toBeGreaterThan(aborts);release?.();await page.unroute(base+'/members');await expect(dialog).toHaveCount(0);await expect(input).toHaveValue(composed);expect(posts).toEqual([]);
    await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(input).toHaveValue('');expect(posts).toHaveLength(1);const messages=(await (await context.request.get(base+'/messages')).json()).messages;expect(messages).toHaveLength(1);expect(messages[0].body).toBe(composed.trim());expect(messages[0].mentions.map((m:{id:string})=>m.id)).toContain(bob);
  }finally{release?.();await page.unrouteAll({behavior:'wait'});if(channel){const base=`${api}/v1/channels/${channel}`;for(const message of (await (await context.request.get(base+'/messages')).json()).messages??[])if(!message.deleted)await context.request.delete(`${base}/messages/${message.id}`,{headers});const response=await context.request.get(base+'/settings');if(response.ok()){const settings=await response.json();await context.request.patch(base+'/details',{headers,data:{name:settings.name,description:settings.description,archived:true,revision:settings.revision}});}}}
});
