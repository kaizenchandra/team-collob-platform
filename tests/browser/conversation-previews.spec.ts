import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import AxeBuilder from '@axe-core/playwright';
test.use({actionTimeout:10000});
const api='http://localhost:4100',headers={origin:'http://localhost:3101'},users={alice:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',bob:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
async function login(page:Page,email:string,url='/') {
  await page.goto(url);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('Development123!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Calendar',exact:true})).toBeVisible();
}
test('literal conversation previews refresh safely without reading messages or replacing drafts',async({browser})=>{
  test.setTimeout(120000);
  const db=new pg.Pool({connectionString:'postgres://concord:local-development-only@localhost:55432/concord'}),org=randomUUID(),team=randomUUID(),channels:string[]=[],a=await browser.newContext(),b=await browser.newContext(),alice=await a.newPage(),bob=await b.newPage();let release:(()=>void)|undefined;
  try {
    await db.query("INSERT INTO organizations(id,name) VALUES($1,'Browser conversation preview fixture')",[org]);
    await db.query("INSERT INTO memberships(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[org,users.alice,users.bob]);
    await db.query("INSERT INTO teams(id,org_id,name) VALUES($1,$2,'Preview team')",[team,org]);
    await db.query("INSERT INTO team_members VALUES($1,$2,$3,'owner')",[org,team,users.alice]);
    await login(alice,'alice@acme.test');
    for(const name of ['Preview Alpha','Preview Beta','Preview Secret']) {
      const response=await a.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name,kind:'private',teamId:team,members:name==='Preview Secret'?[]:[users.bob]}});
      expect(response.status()).toBe(200);channels.push((await response.json()).id);
    }
    const [alpha,beta,secret]=channels;
    const send=async(id:string,body:string)=>{const r=await a.request.post(`${api}/v1/channels/${id}/messages`,{headers,data:{clientId:randomUUID(),body,format:'markdown-v1'}});expect(r.status()).toBe(201);return (await r.json()).id as string;};
    await send(secret,'Private snippet must never appear');
    const literal='<img src=x onerror=alert(1)> **literal** العربية 😀 '+ '😀'.repeat(110),bounded=Array.from(literal).slice(0,100).join('');
    const message=await send(beta,literal);
    await login(bob,'bob@acme.test',`/?org=${org}&channel=${alpha}`);
    const sidebar=bob.locator('aside'),betaRow=sidebar.getByRole('button',{name:/^Preview Beta/}),refresh=sidebar.getByRole('button',{name:'Refresh conversations',exact:true});
    await expect(betaRow.locator('.channel-preview')).toHaveText(bounded);await expect(betaRow).toHaveAccessibleDescription(bounded);await expect(betaRow.locator('img,a')).toHaveCount(0);
    await expect(sidebar.getByText('Private snippet must never appear',{exact:true})).toHaveCount(0);await expect(sidebar.getByRole('button',{name:/Preview Secret/})).toHaveCount(0);await expect(sidebar.getByRole('button',{name:'Preview Alpha',exact:true}).locator('.channel-preview')).toHaveCount(0);
    const before=(await db.query('SELECT * FROM read_positions WHERE channel_id=ANY($1::uuid[]) ORDER BY user_id,channel_id',[channels])).rows;
    const draft='Draft preserved while refreshing conversation previews';await bob.getByRole('textbox',{name:'Message',exact:true}).fill(draft);
    expect((await a.request.patch(`${api}/v1/channels/${beta}/messages/${message}`,{headers,data:{body:'Edited preview'}})).status()).toBe(200);
    await refresh.click();await expect(betaRow.locator('.channel-preview')).toHaveText('Edited preview');
    const snapshot=`**/v1/organizations/${org}/bootstrap`;
    let captured=false,started!:()=>void,finished!:()=>void;const waiting=new Promise<void>(resolve=>{started=resolve;}),done=new Promise<void>(resolve=>{finished=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
    await bob.route(snapshot,async route=>{if(captured){await route.continue();return;}captured=true;const response=await route.fetch();started();await held;await route.fulfill({response}).catch(()=>{});finished();});
    await refresh.click();await waiting;
    expect((await a.request.patch(`${api}/v1/channels/${beta}/messages/${message}`,{headers,data:{body:'Newer preview wins'}})).status()).toBe(200);
    await refresh.click();await expect(betaRow.locator('.channel-preview')).toHaveText('Newer preview wins');release?.();await done;await bob.unroute(snapshot);await bob.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await expect(betaRow.locator('.channel-preview')).toHaveText('Newer preview wins');
    await bob.route(snapshot,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Preview refresh temporarily unavailable"}'}));
    await refresh.click();await expect(sidebar.getByRole('status')).toContainText('Conversation previews unavailable');await expect(sidebar.locator('.channel-preview')).toHaveCount(0);await expect(betaRow).toBeVisible();await expect(bob.getByRole('textbox',{name:'Message',exact:true})).toHaveValue(draft);
    await bob.unroute(snapshot);await refresh.click();await expect(betaRow.locator('.channel-preview')).toHaveText('Newer preview wins');await expect(sidebar.getByRole('status')).toHaveCount(0);
    const latest=await send(beta,'Newest message to delete');await refresh.click();await expect(betaRow.locator('.channel-preview')).toHaveText('Newest message to delete');expect((await a.request.delete(`${api}/v1/channels/${beta}/messages/${latest}`,{headers})).status()).toBe(200);await refresh.click();await expect(betaRow.locator('.channel-preview')).toHaveText('Newer preview wins');
    expect((await b.request.patch(`${api}/v1/channels/${beta}/preferences`,{headers,data:{pinned:true,muted:true}})).status()).toBe(200);await refresh.click();await expect(betaRow).toHaveCount(2);await expect(betaRow.first().locator('.channel-preview')).toHaveText('Newer preview wins');await expect(betaRow.first().locator('b')).toHaveText('1');
    const filter=sidebar.getByRole('textbox',{name:'Filter conversations',exact:true});await filter.fill('not a channel');await expect(betaRow).toHaveCount(0);await filter.fill('Preview Beta');await expect(betaRow).toHaveCount(2);await filter.fill('');
    expect((await db.query('SELECT * FROM read_positions WHERE channel_id=ANY($1::uuid[]) ORDER BY user_id,channel_id',[channels])).rows).toEqual(before);await expect(bob.getByRole('textbox',{name:'Message',exact:true})).toHaveValue(draft);
    const dismiss=bob.getByRole('button',{name:'Dismiss error',exact:true});if(await dismiss.isVisible())await dismiss.click();
    const axe=await new AxeBuilder({page:bob}).include('aside').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();expect(axe.violations).toEqual([]);await bob.screenshot({path:'docs/evidence/conversation-previews.png'});
    await bob.setViewportSize({width:390,height:844});await bob.getByRole('button',{name:'Toggle conversations',exact:true}).click();await expect(betaRow.first()).toBeVisible();expect(await bob.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await sidebar.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);await sidebar.getByRole('button',{name:'Close conversations',exact:true}).click();await expect(sidebar).toBeHidden();await bob.setViewportSize({width:1280,height:720});
    expect((await b.request.patch(`${api}/v1/channels/${beta}/preferences`,{headers,data:{hidden:true}})).status()).toBe(200);await refresh.click();await expect(betaRow).toHaveCount(0);expect((await b.request.patch(`${api}/v1/channels/${beta}/preferences`,{headers,data:{hidden:false}})).status()).toBe(200);await refresh.click();await expect(betaRow).toHaveCount(2);
    await db.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[beta,users.bob]);await refresh.click();await expect(betaRow).toHaveCount(0);await expect(sidebar.getByText('Newer preview wins',{exact:true})).toHaveCount(0);
    await expect.poll(async()=>(await (await b.request.get(`${api}/v1/channels/${alpha}/draft`)).json()).body).toBe(draft);await bob.reload();await expect(bob.getByRole('textbox',{name:'Message',exact:true})).toHaveValue(draft);await expect(betaRow).toHaveCount(0);
  } finally {
    release?.();await a.close();await b.close();for(const channelId of channels){for(const table of ['messages','drafts','channel_preferences','read_positions','channel_members','outbox'])await db.query(`DELETE FROM ${table} WHERE channel_id=$1`,[channelId]);await db.query('DELETE FROM channels WHERE id=$1',[channelId]);}for(const table of ['audit','team_members','teams','presence','calendar_versions','memberships'])await db.query(`DELETE FROM ${table} WHERE org_id=$1`,[org]);await db.query('DELETE FROM organizations WHERE id=$1',[org]);await db.end();
  }
});
