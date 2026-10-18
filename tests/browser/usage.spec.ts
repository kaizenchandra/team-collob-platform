import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',team='33333333-3333-4333-8333-333333333333';
test('usage reports refresh real activity, reject mismatched scope and recover from failure without stale data',async({page})=>{
  test.setTimeout(60000);let channel='',message='';const name=`Usage fixture ${Date.now()}`,headers={origin:'http://localhost:3101'};
  try{
    await page.goto('/');await page.getByLabel('Email address').fill('alice@acme.test');await page.getByLabel('Password',{exact:true}).fill('Development123!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('button',{name:'Admin',exact:true})).toBeVisible();
    const created=await page.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name,kind:'private',teamId:team,members:[]}});expect(created.status()).toBe(200);channel=(await created.json()).id;
    await page.getByRole('button',{name:'Admin',exact:true}).click();const panel=page.getByRole('region',{name:'Usage report'}),refresh=panel.getByRole('button',{name:'Refresh usage report',exact:true});await expect(refresh).toBeEnabled();
    const from=await panel.getByLabel('Usage from (UTC)',{exact:true}).inputValue(),to=await panel.getByLabel('Usage before (UTC)',{exact:true}).inputValue(),path=`${api}/v1/organizations/${org}/usage?from=${from}&to=${to}`;
    const before=(await (await page.request.get(path)).json()).totals;
    const sent=await page.request.post(`${api}/v1/channels/${channel}/messages`,{headers,data:{clientId:crypto.randomUUID(),body:'Synthetic report activity'}});expect(sent.status()).toBe(201);message=(await sent.json()).id;
    await refresh.click();await expect(refresh).toBeEnabled();await expect(panel.locator('dt:has-text("Retained messages created") + dd')).toHaveText((BigInt(before.messagesCreated)+BigInt(1)).toLocaleString());
    await expect(panel.getByText('Actual call attendance, media quality and cost reporting are not available yet.',{exact:true})).toBeVisible();
    await panel.getByText('Daily activity (UTC)',{exact:true}).click();await expect(panel.locator('details article')).toHaveCount(7);
    const accessibility=await new AxeBuilder({page}).include('section[aria-label="Usage report"]').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa']).analyze();expect(accessibility.violations).toEqual([]);
    await panel.scrollIntoViewIfNeeded();await page.screenshot({path:'docs/evidence/usage-report.png'});
    const pattern='**/v1/organizations/*/usage?*';let injected=false;
    await page.route(pattern,async route=>{if(!injected){injected=true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Usage service temporarily unavailable'})});}else await route.continue();});
    await refresh.click();await expect(panel.getByRole('alert')).toContainText('Usage service temporarily unavailable');await expect(panel.locator('article')).toHaveCount(0);await refresh.click();await expect(panel.getByRole('status')).toContainText(`Report for ${from}`);await expect(panel.getByRole('alert')).toHaveCount(0);await page.unroute(pattern);
    await page.route(pattern,async route=>{const r=await route.fetch(),report=await r.json();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...report,organizationId:other})});});await refresh.click();await expect(panel.getByRole('alert')).toContainText('Usage report scope could not be verified');await expect(panel.locator('article')).toHaveCount(0);await page.unroute(pattern);await refresh.click();await expect(refresh).toBeEnabled();await expect(panel.getByRole('alert')).toHaveCount(0);
    await panel.getByLabel('Usage from (UTC)',{exact:true}).fill('2030-01-01');await panel.getByLabel('Usage before (UTC)',{exact:true}).fill('2030-02-02');await refresh.click();await expect(panel.getByRole('alert')).toContainText('at most 31 days');await expect(panel.locator('article')).toHaveCount(0);
    await panel.getByLabel('Usage before (UTC)',{exact:true}).fill('2030-01-02');await panel.getByLabel('Usage before (UTC)',{exact:true}).press('Enter');await expect(panel.getByRole('status')).toContainText('Report for 2030-01-01');await expect(panel.locator('dt:has-text("Retained messages created") + dd')).toHaveText('0');
    await page.getByLabel('WORKSPACE',{exact:true}).selectOption(other);await expect(panel.getByRole('alert')).toContainText('Administrator role required');await expect(panel.locator('article')).toHaveCount(0);await expect(panel.getByLabel('Usage from (UTC)',{exact:true})).not.toHaveValue('2030-01-01');
    await page.getByLabel('WORKSPACE',{exact:true}).selectOption(org);await expect(panel.getByRole('status')).toContainText(`Report for ${from}`);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  }finally{
    if(message)await page.request.delete(`${api}/v1/channels/${channel}/messages/${message}`,{headers});
    if(channel)await page.request.patch(`${api}/v1/channels/${channel}/details`,{headers,data:{name,description:'Synthetic usage verification',archived:true,revision:(await (await page.request.get(`${api}/v1/channels/${channel}/settings`)).json()).revision}});
  }
});
