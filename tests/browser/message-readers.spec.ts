import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import AxeBuilder from '@axe-core/playwright';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',team='33333333-3333-4333-8333-333333333333',bob='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',headers={origin:'http://localhost:3101'};
test.use({actionTimeout:10000});

test('message readers page beyond one hundred with scoped retry, current privacy, cancellation and no composition/read writes',async({page,context,browser})=>{
  test.setTimeout(180000);
  const db=new pg.Pool({connectionString:'postgres://concord:local-development-only@localhost:55432/concord'}),reader=await browser.newContext(),people=Array.from({length:105},()=>randomUUID()).sort(),gates=new Set<()=>void>();let channel='',message='';
  try{
    for(const [session,email] of [[context,'alice@acme.test'],[reader,'bob@acme.test']] as const)expect((await session.request.post(`${api}/v1/session`,{headers,data:{email,password:'Development123!'}})).ok()).toBe(true);
    const token=Date.now(),made=await context.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name:`Paged message readers ${token}`,kind:'private',teamId:team,members:[bob]}});expect(made.ok()).toBe(true);channel=(await made.json()).id;
    const base=`${api}/v1/channels/${channel}`,marker=`Reader source ${token} <img src=x onerror=alert(1)> **literal** `,body=marker+'🙂'.repeat(600),draft=`Keep reader browsing draft ${token}`;
    await db.query('UPDATE channels SET sequence=$2 WHERE id=$1',[channel,'9007199254740992']);
    const sent=await context.request.post(base+'/messages',{headers,data:{clientId:randomUUID(),body}});expect(sent.status()).toBe(201);message=(await sent.json()).id;
    await db.query(`INSERT INTO users(id,email,name) SELECT id,id::text||'@reader-ui.test','Reader '||lpad(n::text,3,'0') FROM unnest($1::uuid[]) WITH ORDINALITY t(id,n)`,[people]);
    await db.query(`INSERT INTO memberships(org_id,user_id,role) SELECT $2,id,'member' FROM unnest($1::uuid[]) id`,[people,org]);
    await db.query(`INSERT INTO channel_members SELECT $2,$3,id FROM unnest($1::uuid[]) id`,[people,org,channel]);
    await db.query(`INSERT INTO read_positions SELECT $2,id,$3::bigint FROM unnest($1::uuid[]) id`,[people,channel,'9007199254740993']);
    // One real shared position below the source cannot count as a reader through rounding.
    expect((await reader.request.post(base+'/read',{headers,data:{seq:'9007199254740992'}})).ok()).toBe(true);
    expect((await context.request.put(base+'/draft',{headers,data:{body:draft}})).ok()).toBe(true);
    expect((await (await context.request.get(base+'/receipts')).json()).receipts.length).toBe(100);
    await page.goto(`/?org=${org}&channel=${channel}`);const input=page.getByRole('textbox',{name:'Message',exact:true});await expect(input).toHaveValue(draft);
    const article=page.getByRole('article').filter({hasText:marker}),open=article.getByRole('button',{name:'View message readers',exact:true});await open.click();
    const dialog=page.getByRole('dialog',{name:'Message readers',exact:true}),list=dialog.getByRole('list',{name:'Shared message readers',exact:true}),pageStatus=dialog.getByRole('status').filter({hasText:/^Reader page /}),more=dialog.getByRole('button',{name:'More readers',exact:true}),previous=dialog.getByRole('button',{name:'Previous readers',exact:true}),retry=dialog.getByRole('button',{name:'Retry message readers',exact:true}),refresh=dialog.getByRole('button',{name:'Refresh message readers',exact:true}),source=dialog.getByRole('article',{name:'Reader source message',exact:true}),endpoint=`${api}/v1/organizations/${org}/channels/${channel}/messages/${message}/readers`;
    const positions=(await db.query('SELECT * FROM read_positions WHERE channel_id=$1 ORDER BY user_id',[channel])).rows,writes:string[]=[];page.on('request',r=>{if(r.method()!=='GET'&&(r.url()===base+'/messages'||r.url()===base+'/read'))writes.push(r.method()+' '+r.url());});
    await expect(pageStatus).toHaveText('Reader page 1 · 50 shared readers');await expect(list.getByRole('listitem')).toHaveCount(50);await expect(source).toContainText(marker);await expect(source.locator('img')).toHaveCount(0);
    const excerpt=await source.locator('p').last().textContent();expect(Array.from(excerpt??'').length).toBe(500);expect(excerpt!.length).toBeGreaterThan(500);
    const full=source.locator('summary');await full.focus();await full.press('Enter');await expect(source.locator('details')).toHaveAttribute('open','');await full.press('Enter');await expect(source.locator('details')).not.toHaveAttribute('open','');
    const secondUrl=endpoint+'?afterId='+people[49];await page.route(secondUrl,r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"Reader page temporarily unavailable"}'}));
    await more.click();await expect(dialog.getByRole('alert')).toContainText('Reader page temporarily unavailable');await expect(list).toHaveCount(0);await expect(source).toHaveCount(0);await expect(more).toHaveCount(0);await page.unroute(secondUrl);await retry.click();await expect(pageStatus).toHaveText('Reader page 2 · 50 shared readers');
    await more.click();await expect(pageStatus).toHaveText('Reader page 3 · 5 shared readers');await expect(list).toContainText('Reader 105');await expect(more).toBeDisabled();
    // The page contains only current shared readers, not a cached history of who once read it.
    await db.query(`UPDATE users SET preferences='{"readReceipts":false}' WHERE id=$1`,[people[104]]);await expect(list).not.toContainText('Reader 105',{timeout:10000});await expect(pageStatus).toHaveText('Reader page 3 · 4 shared readers');
    await db.query(`UPDATE users SET preferences='{"readReceipts":true}' WHERE id=$1`,[people[104]]);await expect(list).toContainText('Reader 105',{timeout:10000});
    await db.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channel,people[103]]);await expect(list).not.toContainText('Reader 104',{timeout:10000});await db.query('INSERT INTO channel_members VALUES($1,$2,$3)',[org,channel,people[103]]);await expect(list).toContainText('Reader 104',{timeout:10000});
    await previous.click();await expect(pageStatus).toHaveText('Reader page 2 · 50 shared readers');await previous.click();await expect(pageStatus).toHaveText('Reader page 1 · 50 shared readers');
    await page.route(endpoint,r=>r.fulfill({status:200,contentType:'application/json',body:'{"readers":"invalid"}'}));await refresh.click();await expect(dialog.getByRole('alert')).toContainText('Message readers could not be loaded');await expect(list).toHaveCount(0);await page.unroute(endpoint);await retry.click();await expect(pageStatus).toHaveText('Reader page 1 · 50 shared readers');
    let started=0,aborted=0;page.on('requestfailed',r=>{if(r.url()===endpoint)aborted++;});
    await page.route(endpoint,async r=>{const response=await r.fetch();started++;await new Promise<void>(resolve=>gates.add(resolve));await r.fulfill({response}).catch(()=>{});});
    await refresh.click();await expect.poll(()=>started).toBe(1);await expect(dialog.getByRole('alert')).toContainText('Message readers could not be loaded',{timeout:12000});await expect.poll(()=>aborted).toBe(1);await retry.click();await expect.poll(()=>started).toBe(2);
    await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await expect.poll(()=>aborted).toBe(2);for(const release of gates)release();await page.unroute(endpoint);await open.click();await expect(pageStatus).toHaveText('Reader page 1 · 50 shared readers');
    await more.click();await more.click();await expect(pageStatus).toHaveText('Reader page 3 · 5 shared readers');
    const axe=await new AxeBuilder({page}).include('dialog[open]').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);
    await page.setViewportSize({width:390,height:844});expect(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.setViewportSize({width:1280,height:900});await dialog.screenshot({path:'docs/evidence/message-readers.png'});
    expect(writes).toEqual([]);expect((await db.query('SELECT * FROM read_positions WHERE channel_id=$1 ORDER BY user_id',[channel])).rows).toEqual(positions);expect((await (await context.request.get(base+'/draft')).json()).body).toBe(draft);
    // Actual source deletion withdraws excerpt and names on the next current-page check.
    expect((await context.request.delete(`${base}/messages/${message}`,{headers})).ok()).toBe(true);await expect(dialog.getByRole('alert')).toContainText('Message readers unavailable',{timeout:10000});await expect(list).toHaveCount(0);await expect(source).toHaveCount(0);
  }finally{
    for(const release of gates)release();await page.unrouteAll({behavior:'wait'});
    if(channel){if(message)await context.request.delete(`${api}/v1/channels/${channel}/messages/${message}`,{headers});const r=await context.request.get(`${api}/v1/channels/${channel}/settings`);if(r.ok()){const s=await r.json();await context.request.patch(`${api}/v1/channels/${channel}/details`,{headers,data:{name:s.name,description:s.description,archived:true,revision:s.revision}});}}
    await db.query('DELETE FROM read_positions WHERE user_id=ANY($1::uuid[])',[people]);await db.query('DELETE FROM channel_members WHERE user_id=ANY($1::uuid[])',[people]);await db.query('DELETE FROM memberships WHERE user_id=ANY($1::uuid[])',[people]);await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[people]);
    await reader.close();await db.end();
  }
});
