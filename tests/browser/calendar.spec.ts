import {test,expect,type Page} from '@playwright/test';
const org='11111111-1111-4111-8111-111111111111',api='http://localhost:4100';
test('calendar automatically refreshes organizer edits, attendee removal, re-addition and cancellation',async({browser})=>{
  test.setTimeout(60000);
  const a=await browser.newContext(),b=await browser.newContext();let id='';
  const login=async(p:Page,email:string)=>{await p.goto('/');await p.getByLabel('Email address').fill(email);await p.getByLabel('Password',{exact:true}).fill('Development123!');await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByRole('button',{name:'Calendar',exact:true}).click();};
  try{
    const alice=await a.newPage(),bob=await b.newPage();await login(alice,'alice@acme.test');await login(bob,'bob@acme.test');
    const title=`Calendar edit ${Date.now()}`,base=`${api}/v1/organizations/${org}/meetings`;
    const created=await a.request.post(base,{headers:{origin:'http://localhost:3101'},data:{title,startsAt:'2026-12-21T10:00:00Z',endsAt:'2026-12-21T11:00:00Z',timezone:'UTC',attendees:['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']}});expect(created.status()).toBe(200);id=(await created.json()).id;
    await b.request.patch(`${base}/${id}`,{headers:{origin:'http://localhost:3101'},data:{response:'accepted'}});
    await alice.getByRole('button',{name:'Refresh calendar',exact:true}).click();const card=alice.locator('.meeting-card').filter({hasText:title});await card.getByRole('button',{name:'Edit meeting',exact:true}).click();
    const dialog=alice.getByRole('dialog',{name:'Edit meeting'});await dialog.getByLabel('Meeting title',{exact:true}).fill(title+' updated');await dialog.getByLabel('Description',{exact:true}).fill('Updated meeting details');await dialog.getByLabel('Starts',{exact:true}).fill('2026-12-22T10:00');await dialog.getByLabel('Ends',{exact:true}).fill('2026-12-22T11:00');await dialog.getByRole('button',{name:'Save meeting changes',exact:true}).click();await expect(dialog).toHaveCount(0);
    const received=bob.locator('.meeting-card').filter({hasText:title+' updated'});await expect(received).toBeVisible({timeout:12000});await expect(received.getByText('Updated meeting details',{exact:true})).toBeVisible();await expect(received.getByLabel('RSVP',{exact:true})).toHaveValue('pending');await expect(received.getByRole('button',{name:'Edit meeting',exact:true})).toHaveCount(0);await bob.screenshot({path:'docs/evidence/meeting-update.png'});
    await card.getByRole('button',{name:'Edit meeting',exact:true}).click();await dialog.getByLabel('Bob Chen',{exact:true}).uncheck();await dialog.getByRole('button',{name:'Save meeting changes',exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(received).toHaveCount(0,{timeout:12000});
    const denied=await b.request.patch(`${base}/${id}`,{headers:{origin:'http://localhost:3101'},data:{response:'accepted'}});expect(denied.status()).toBe(404);
    await card.getByRole('button',{name:'Edit meeting',exact:true}).click();await dialog.getByLabel('Bob Chen',{exact:true}).check();await alice.screenshot({path:'docs/evidence/meeting-attendees.png'});await dialog.getByRole('button',{name:'Save meeting changes',exact:true}).click();await expect(dialog).toHaveCount(0);
    await expect(received).toBeVisible({timeout:12000});await expect(received.getByLabel('RSVP',{exact:true})).toHaveValue('pending');
    await a.request.patch(`${base}/${id}`,{headers:{origin:'http://localhost:3101'},data:{cancelled:true}});await expect(received.getByRole('heading')).toContainText('Cancelled',{timeout:12000});
  }finally{if(id)await a.request.patch(`${api}/v1/organizations/${org}/meetings/${id}`,{headers:{origin:'http://localhost:3101'},data:{cancelled:true}});await a.close();await b.close();}
});

test('calendar date range loads beyond the first page and retries an unavailable page',async({page})=>{
  const {Pool}=await import('pg'),{randomUUID}=await import('node:crypto');const db=new Pool({connectionString:'postgres://concord:local-development-only@localhost:55432/concord'}),ids=Array.from({length:53},()=>randomUUID()),marker=`Calendar page ${Date.now()}`;
  try{
    await db.query("INSERT INTO meetings(id,org_id,title,starts_at,ends_at,timezone,organizer_id) SELECT id,$2,$3,'2033-06-04T10:00:00Z','2033-06-04T11:00:00Z','UTC','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' FROM unnest($1::uuid[]) id",[ids,org,marker]);
    await page.goto('/');await page.getByLabel('Email address').fill('alice@acme.test');await page.getByLabel('Password',{exact:true}).fill('Development123!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Calendar',exact:true}).click();
    await page.getByLabel('Calendar from',{exact:true}).fill('2033-06-04');await page.getByLabel('Calendar through',{exact:true}).fill('2033-06-04');await page.getByRole('button',{name:'Apply dates',exact:true}).click();const cards=page.locator('.meeting-card').filter({hasText:marker});await expect(cards).toHaveCount(50);
    let failed=false;await page.route('**/v1/organizations/*/meetings?*',async route=>{if(route.request().url().includes('afterStart=')&&!failed){failed=true;await route.abort();}else await route.continue();});
    await page.getByRole('button',{name:'Load more meetings',exact:true}).click();await expect(page.getByRole('button',{name:'Retry calendar',exact:true})).toBeVisible();await expect(cards).toHaveCount(50);await page.getByRole('button',{name:'Retry calendar',exact:true}).click();await expect(cards).toHaveCount(53);await expect(page.getByRole('button',{name:'Load more meetings',exact:true})).toHaveCount(0);await page.screenshot({path:'docs/evidence/calendar-pagination.png'});
    let counterFailed=false;await page.route('**/calendar-version',async route=>{if(!counterFailed){counterFailed=true;await route.abort();}else await route.continue();});
    await expect(page.getByText('Calendar updates unavailable. Retrying automatically; stale meetings have been cleared.',{exact:true})).toBeVisible({timeout:12000});await expect(cards).toHaveCount(0);await expect(cards).toHaveCount(50,{timeout:12000});await expect(page.getByRole('button',{name:'Load more meetings',exact:true})).toBeVisible();
  }finally{await db.query('DELETE FROM meetings WHERE id=ANY($1::uuid[])',[ids]);await db.end();}
});

test('scheduling rejects DST gaps and persists an explicitly chosen repeated-time occurrence',async({page})=>{
  const title=`Timezone ${Date.now()}`;let id='',posts=0;
  try{
    await page.goto('/');await page.getByLabel('Email address').fill('alice@acme.test');await page.getByLabel('Password',{exact:true}).fill('Development123!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Calendar',exact:true}).click();await page.getByRole('button',{name:'Schedule meeting',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Schedule a meeting'});await dialog.getByLabel('Meeting title',{exact:true}).fill(title);await dialog.getByLabel('Scheduling timezone',{exact:true}).fill('America/New_York');
    page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith(`/organizations/${org}/meetings`))posts++;});
    await dialog.getByLabel('Starts',{exact:true}).fill('2026-03-08T02:30');await dialog.getByLabel('Ends',{exact:true}).fill('2026-03-08T03:30');await dialog.getByRole('button',{name:'Schedule meeting',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('does not exist');expect(posts).toBe(0);
    await dialog.getByLabel('Starts',{exact:true}).fill('2026-11-01T01:30');await dialog.getByLabel('Ends',{exact:true}).fill('2026-11-01T02:30');await dialog.getByRole('button',{name:'Schedule meeting',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('occurs twice');expect(posts).toBe(0);
    await dialog.getByLabel('Repeated clock time',{exact:true}).selectOption('later');await page.screenshot({path:'docs/evidence/meeting-timezone.png'});
    const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/organizations/${org}/meetings`));await dialog.getByRole('button',{name:'Schedule meeting',exact:true}).click();const saved=await response;expect(saved.status()).toBe(200);id=(await saved.json()).id;await expect(dialog).toHaveCount(0);
    const rows=await (await page.request.get(`${api}/v1/organizations/${org}/meetings?from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z`)).json();const meeting=rows.meetings.find((m:{id:string})=>m.id===id);expect(meeting.starts_at).toBe('2026-11-01T06:30:00.000Z');expect(meeting.ends_at).toBe('2026-11-01T07:30:00.000Z');expect(meeting.timezone).toBe('America/New_York');
  }finally{if(id)await page.request.patch(`${api}/v1/organizations/${org}/meetings/${id}`,{headers:{origin:'http://localhost:3101'},data:{cancelled:true}});}
});
