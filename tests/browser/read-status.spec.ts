import {test,expect} from '@playwright/test';
import pg from 'pg';
import AxeBuilder from '@axe-core/playwright';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',team='33333333-3333-4333-8333-333333333333',alice='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bob='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',headers={origin:'http://localhost:3101'};
test.use({actionTimeout:10000});

test('visible shared read status recovers without writes, honors privacy, cancels on exit and compares exact bigint positions',async({page,context,browser})=>{
  test.setTimeout(180000);
  const db=new pg.Pool({connectionString:'postgres://concord:local-development-only@localhost:55432/concord'}),reader=await browser.newContext(),messages:string[]=[],gates=new Set<()=>void>();let channel='',preferences:unknown;
  try{
    for(const [session,email] of [[context,'alice@acme.test'],[reader,'bob@acme.test']] as const)expect((await session.request.post(`${api}/v1/session`,{headers,data:{email,password:'Development123!'}})).ok()).toBe(true);
    preferences=(await db.query('SELECT preferences FROM users WHERE id=$1',[bob])).rows[0].preferences;
    await db.query(`UPDATE users SET preferences=jsonb_set(preferences,'{readReceipts}','true') WHERE id=$1`,[bob]);
    const token=Date.now(),made=await context.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name:`Visible read status ${token}`,kind:'private',teamId:team,members:[bob]}});expect(made.ok()).toBe(true);channel=(await made.json()).id;
    const base=`${api}/v1/channels/${channel}`,endpoint=base+'/receipts',url=`/?org=${org}&channel=${channel}`;
    const make=async(body:string)=>{const r=await context.request.post(base+'/messages',{headers,data:{clientId:crypto.randomUUID(),body}});expect(r.status()).toBe(201);const m=await r.json();messages.push(m.id);return m as {id:string;seq:string};};
    const firstBody=`Read status first ${token}`,secondBody=`Read status second ${token}`,first=await make(firstBody),second=await make(secondBody),text=`Keep read status draft ${token}`;
    expect((await context.request.put(base+'/draft',{headers,data:{body:text}})).ok()).toBe(true);
    expect((await reader.request.post(base+'/read',{headers,data:{seq:Number(first.seq)}})).ok()).toBe(true);
    await page.goto(url);const row=(body:string)=>page.getByRole('article').filter({hasText:body}),status=(body:string)=>row(body).locator('.receipt'),input=page.getByRole('textbox',{name:'Message',exact:true}),retry=page.getByRole('button',{name:'Retry read status',exact:true}),notice=page.getByRole('region',{name:'Read status',exact:true});
    await expect(status(firstBody)).toHaveText('Read');await expect(status(firstBody)).toHaveAttribute('aria-label','Read by Bob Chen');await expect(status(secondBody)).toHaveText('Sent');await expect(input).toHaveValue(text);
    const writes:{url:string;body:unknown}[]=[];page.on('request',r=>{if(r.method()==='POST'&&(r.url()===base+'/read'||r.url()===base+'/messages'))writes.push({url:r.url(),body:r.postDataJSON()});});
    // Actual opt-out removes names/read indicators even without a history write/event.
    await db.query(`UPDATE users SET preferences=jsonb_set(preferences,'{readReceipts}','false') WHERE id=$1`,[bob]);
    await expect(status(firstBody)).toHaveText('Sent',{timeout:10000});await expect(status(firstBody)).not.toHaveAttribute('aria-label',/Bob/);
    await db.query(`UPDATE users SET preferences=jsonb_set(preferences,'{readReceipts}','true') WHERE id=$1`,[bob]);await expect(status(firstBody)).toHaveText('Read',{timeout:10000});
    expect((await reader.request.post(base+'/read',{headers,data:{seq:second.seq}})).ok()).toBe(true);await expect(status(secondBody)).toHaveText('Read',{timeout:10000});
    // Real unread rewind withdraws only the later message's shared read state.
    expect((await reader.request.post(`${base}/messages/${second.id}/unread`,{headers,data:{}})).ok()).toBe(true);await expect(status(secondBody)).toHaveText('Sent',{timeout:10000});await expect(status(firstBody)).toHaveText('Read');
    // Failed and malformed snapshots cannot leave stale names or imply unread.
    await page.route(endpoint,r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"Shared receipt unavailable"}'}));
    await expect(notice).toContainText('Read status unavailable',{timeout:10000});await expect(status(firstBody)).toHaveText('Sent · read status unavailable');await expect(status(firstBody)).not.toHaveAttribute('aria-label',/Bob/);
    await page.unroute(endpoint);await page.route(endpoint,r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({receipts:[{user_id:bob,name:'Bob Chen',seq:second.seq},{user_id:bob,name:'Bob Chen',seq:first.seq}]})}));
    await retry.click();await expect(notice).toContainText('Read status unavailable');await expect(status(firstBody)).toHaveText('Sent · read status unavailable');
    await page.unroute(endpoint);await retry.click();await expect(status(firstBody)).toHaveText('Read');await expect(status(secondBody)).toHaveText('Sent');await expect(notice).toHaveCount(0);
    // Real8s timeout then retry cancelled on view exit; late bytes cannot restore readers.
    let started=0,aborted=0;page.on('requestfailed',r=>{if(r.url()===endpoint)aborted++;});
    await page.route(endpoint,async r=>{const response=await r.fetch();started++;await new Promise<void>(resolve=>gates.add(resolve));await r.fulfill({response}).catch(()=>{});});
    await page.reload();await expect.poll(()=>started).toBe(1);await expect(status(firstBody)).toHaveText('Sent · checking read status');
    await expect(notice).toContainText('Read status unavailable',{timeout:12000});await expect.poll(()=>aborted).toBe(1);await retry.click();await expect.poll(()=>started).toBe(2);
    await page.getByRole('button',{name:'Saved',exact:true}).click();await expect.poll(()=>aborted).toBe(2);
    for(const release of gates)release();await page.unroute(endpoint);await page.getByRole('button',{name:'Chat',exact:true}).click();await expect(status(firstBody)).toHaveText('Read');await expect(input).toHaveValue(text);expect(writes).toEqual([]);
    // Actual adjacent PostgreSQL positions beyond JS safe integers must stay distinct.
    await db.query('UPDATE channels SET sequence=$2 WHERE id=$1',[channel,'9007199254740991']);
    const lowerBody=`Exact lower read ${token}`,upperBody=`Exact upper read ${token}`,lower=await make(lowerBody),upper=await make(upperBody);
    expect(lower.seq).toBe('9007199254740992');expect(upper.seq).toBe('9007199254740993');
    expect((await reader.request.post(base+'/read',{headers,data:{seq:lower.seq}})).ok()).toBe(true);
    await expect(status(lowerBody)).toHaveText('Read',{timeout:10000});await expect(status(upperBody)).toHaveText('Sent');
    await page.getByRole('button',{name:'Mark as read',exact:true}).click();
    await expect.poll(async()=>(await db.query('SELECT seq FROM read_positions WHERE channel_id=$1 AND user_id=$2',[channel,alice])).rows[0]?.seq).toBe(upper.seq);
    expect(writes).toEqual([{url:base+'/read',body:{seq:upper.seq}}]);
    expect((await reader.request.post(base+'/read',{headers,data:{seq:upper.seq}})).ok()).toBe(true);await expect(status(upperBody)).toHaveText('Read',{timeout:10000});await expect(input).toHaveValue(text);
    const axe=await new AxeBuilder({page}).include('.message-list').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);
    await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.setViewportSize({width:1280,height:900});await row(upperBody).scrollIntoViewIfNeeded();await page.screenshot({path:'docs/evidence/read-status.png'});
  }finally{
    for(const release of gates)release();await page.unrouteAll({behavior:'wait'});
    if(preferences!==undefined)await db.query('UPDATE users SET preferences=$2 WHERE id=$1',[bob,preferences]);
    if(channel){for(const id of messages)await context.request.delete(`${api}/v1/channels/${channel}/messages/${id}`,{headers});const r=await context.request.get(`${api}/v1/channels/${channel}/settings`);if(r.ok()){const s=await r.json();await context.request.patch(`${api}/v1/channels/${channel}/details`,{headers,data:{name:s.name,description:s.description,archived:true,revision:s.revision}});}}
    await reader.close();await db.end();
  }
});
