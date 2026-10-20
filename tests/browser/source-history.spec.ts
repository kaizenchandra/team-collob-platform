import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const api='http://localhost:4100';
const org='11111111-1111-4111-8111-111111111111';
const team='33333333-3333-4333-8333-333333333333';
const bob='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const headers={origin:'http://localhost:3101'};
test.use({actionTimeout:10000});

test('previous sources are freshly read, cancellable and cleared by independent selection, close and reload',async({page,context,browser})=>{
  test.setTimeout(120000);
  const owner=await browser.newContext(),channels:string[]=[],messages:{channel:string;id:string}[]=[];
  const gates=new Set<()=>void>();
  try{
    for(const [session,email] of [[owner,'alice@acme.test'],[context,'bob@acme.test']] as const){
      expect((await session.request.post(`${api}/v1/session`,{headers,data:{email,password:'Development123!'}})).ok()).toBe(true);
    }
    const token=Date.now();
    for(const label of ['History active draft','History sources']){
      const response=await owner.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name:`${label} ${token}`,kind:'private',teamId:team,members:[bob]}});
      expect(response.ok()).toBe(true);channels.push((await response.json()).id);
    }
    const [active,source]=channels,base=`${api}/v1/channels/${source}`;
    const make=async(body:string,parentId?:string)=>{
      const response=await owner.request.post(base+'/messages',{headers,data:{clientId:crypto.randomUUID(),body,parentId}});
      expect(response.status()).toBe(201);const id=(await response.json()).id as string;
      messages.push({channel:source,id});return id;
    };
    const rootBody=`History root ${token}`,middleBody=`History middle ${token}`,leafBody=`History leaf ${token}`,siblingBody=`History sibling ${token}`;
    const root=await make(rootBody),middle=await make(middleBody,root),leaf=await make(leafBody,middle),sibling=await make(siblingBody,root);
    expect((await context.request.post(`${base}/messages/${leaf}/save`,{headers,data:{saved:true}})).ok()).toBe(true);
    const draft=`Keep history draft ${token}`;
    expect((await context.request.put(`${api}/v1/channels/${active}/draft`,{headers,data:{body:draft}})).ok()).toBe(true);
    await page.goto(`/?org=${org}&channel=${active}`);
    await expect(page.getByRole('textbox',{name:'Message',exact:true})).toHaveValue(draft);
    const receipts=await (await context.request.get(base+'/receipts')).json();
    await page.getByRole('button',{name:'Saved',exact:true}).click();
    await page.getByRole('region',{name:'Saved messages',exact:true}).getByRole('article').filter({hasText:leafBody}).getByRole('button',{name:'Open saved message',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Linked message',exact:true});
    const selected=dialog.getByRole('article',{name:'Selected message',exact:true});
    const back=dialog.getByRole('button',{name:'Back to previous message',exact:true});
    const writes:string[]=[];
    page.on('request',r=>{if(r.url().startsWith(base+'/')&&r.method()!=='GET'&&/\/(messages|read)(?:\/|$)/.test(r.url()))writes.push(r.method()+' '+r.url());});
    const openParent=async()=>{
      await dialog.getByRole('button',{name:'View replied-to message',exact:true}).click();
      await dialog.getByRole('region',{name:'Replied-to message',exact:true}).getByRole('button',{name:'Open replied-to message',exact:true}).click();
    };
    const path=(id:string)=>`${api}/v1/organizations/${org}/channels/${source}/messages/${id}`;
    await expect(selected).toContainText(leafBody);await expect(back).toHaveCount(0);
    await openParent();await expect(selected).toContainText(middleBody);
    await openParent();await expect(selected).toContainText(rootBody);
    await dialog.getByRole('button',{name:'View direct replies',exact:true}).click();
    await dialog.getByRole('region',{name:'Direct replies',exact:true}).getByRole('article').filter({hasText:siblingBody}).getByRole('button',{name:'Open reply source',exact:true}).click();
    await expect(selected).toContainText(siblingBody);
    await back.click();await expect(selected).toContainText(rootBody);

    // History holds identities only: edits are read again when revisiting.
    const edited=`Updated middle ${token}`;
    expect((await owner.request.patch(`${base}/messages/${middle}`,{headers,data:{body:edited}})).ok()).toBe(true);
    await back.click();await expect(selected).toContainText(edited);await expect(selected).not.toContainText(middleBody);
    await back.click();await expect(selected).toContainText(leafBody);await expect(back).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('channel')).toBe(active);

    // Failed destination reads retain a way back without displaying cached text.
    await openParent();await expect(selected).toContainText(edited);
    await page.route(path(leaf),route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"History source unavailable"}'}));
    await back.click();await expect(dialog.getByRole('alert')).toContainText('History source unavailable');
    await expect(selected).toHaveCount(0);await expect(back).toHaveCount(0);
    await page.unroute(path(leaf));await dialog.getByRole('button',{name:'Retry message',exact:true}).click();await expect(selected).toContainText(leafBody);
    await openParent();await expect(selected).toContainText(edited);await openParent();await expect(selected).toContainText(rootBody);
    await page.route(path(middle),route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"History source unavailable"}'}));
    await back.click();await expect(dialog.getByRole('alert')).toContainText('History source unavailable');
    await expect(selected).toHaveCount(0);await expect(back).toBeEnabled();
    await back.click();await expect(selected).toContainText(leafBody);await page.unroute(path(middle));

    // Leaving a pending source cancels its request; late bytes cannot replace the destination.
    await openParent();await expect(selected).toContainText(edited);await openParent();await expect(selected).toContainText(rootBody);
    let started=false,aborted=false,release:(()=>void)|undefined;
    page.on('requestfailed',r=>{if(r.url()===path(middle))aborted=true;});
    await page.route(path(middle),async route=>{
      const response=await route.fetch();started=true;
      await new Promise<void>(resolve=>{release=resolve;gates.add(resolve);});
      await route.fulfill({response}).catch(()=>{});
    });
    await back.click();await expect.poll(()=>started).toBe(true);await expect(selected).toHaveCount(0);
    await back.click();await expect(selected).toContainText(leafBody);await expect.poll(()=>aborted).toBe(true);
    release?.();await page.unroute(path(middle));await expect(selected).toContainText(leafBody);

    // A deleted previous source is unavailable; Back never resurrects its old body.
    await openParent();await expect(selected).toContainText(edited);await openParent();await expect(selected).toContainText(rootBody);
    expect((await owner.request.delete(`${base}/messages/${middle}`,{headers})).ok()).toBe(true);
    await back.click();await expect(dialog.getByRole('alert')).toContainText('Message unavailable');await expect(selected).toHaveCount(0);
    await back.click();await expect(selected).toContainText(leafBody);await expect(back).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(await (await context.request.get(base+'/receipts')).json()).toEqual(receipts);
    expect((await (await context.request.get(`${api}/v1/channels/${active}/draft`)).json()).body).toBe(draft);

    // New canonical selection starts fresh; matching fragments follow Back, reload resets history.
    await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
    await page.goto(`/?org=${org}&channel=${source}#message-${sibling}`);
    await expect(selected).toContainText(siblingBody);await expect(back).toHaveCount(0);
    await openParent();await expect(selected).toContainText(rootBody);expect(new URL(page.url()).hash).toBe('#message-'+root);
    await back.click();await expect(selected).toContainText(siblingBody);expect(new URL(page.url()).hash).toBe('#message-'+sibling);
    await openParent();await expect(selected).toContainText(rootBody);await page.reload();await expect(selected).toContainText(rootBody);await expect(back).toHaveCount(0);
    await dialog.getByRole('button',{name:'View direct replies',exact:true}).click();
    await dialog.getByRole('region',{name:'Direct replies',exact:true}).getByRole('article').filter({hasText:siblingBody}).getByRole('button',{name:'Open reply source',exact:true}).click();
    await expect(selected).toContainText(siblingBody);await expect(back).toBeEnabled();
    const axe=await new AxeBuilder({page}).include('dialog[open]').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);
    await page.setViewportSize({width:390,height:844});expect(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.setViewportSize({width:1280,height:900});
    await dialog.screenshot({path:'docs/evidence/source-history.png'});
    await page.evaluate(id=>{window.location.hash='message-'+id;},leaf);await expect(selected).toContainText(leafBody);await expect(back).toHaveCount(0);
    await page.evaluate(id=>{window.location.hash='message-'+id;},sibling);await expect(selected).toContainText(siblingBody);await openParent();await expect(selected).toContainText(rootBody);await expect(back).toBeEnabled();
    await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await page.evaluate(id=>{window.location.hash='message-'+id;},root);await expect(selected).toContainText(rootBody);await expect(back).toHaveCount(0);
  }finally{
    for(const release of gates)release();await page.unrouteAll({behavior:'wait'});
    for(const message of messages)await owner.request.delete(`${api}/v1/channels/${message.channel}/messages/${message.id}`,{headers});
    for(const channel of channels){
      const base=`${api}/v1/channels/${channel}`,response=await owner.request.get(base+'/settings');
      if(response.ok()){const settings=await response.json();await owner.request.patch(base+'/details',{headers,data:{name:settings.name,description:settings.description,archived:true,revision:settings.revision}});}
    }
    await owner.close();
  }
});
