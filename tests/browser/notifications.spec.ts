import {test,expect} from '@playwright/test';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',channel='44444444-4444-4444-8444-444444444444',bobId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('saved quiet hours suppress mention alerts; native browser construction is deduplicated across tabs',async({page,context,browser})=>{
  test.setTimeout(60000);
  const other=await browser.newContext();let message='',previous:unknown;
  await other.grantPermissions(['notifications'],{origin:'http://localhost:3101'});
  await other.addInitScript(()=>{
    const root=window as unknown as {notificationCalls:{title:string;body:string}[];Notification:typeof Notification};root.notificationCalls=[];
    const Native=root.Notification;
    root.Notification=new Proxy(Native,{construct(target,args){const result=Reflect.construct(target,args);root.notificationCalls.push({title:String(args[0]),body:args[1]?.body??''});return result;}});
  });
  const bob=await other.newPage();
  const login=async(p:typeof page,email:string)=>{await p.goto(`/?channel=${channel}`);await p.getByLabel('Email address').fill(email);await p.getByLabel('Password',{exact:true}).fill('Development123!');await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByRole('button',{name:'Settings',exact:true}).click();};
  try{
    await login(page,'alice@acme.test');await login(bob,'bob@acme.test');
    previous=await (await other.request.get(`${api}/v1/notification-settings`)).json();
    await bob.getByLabel('Enable hourly email digests',{exact:true}).check();await bob.getByLabel('Enable browser mention alerts',{exact:true}).check();await bob.getByLabel('Enable quiet hours',{exact:true}).check();
    await bob.getByLabel('Quiet hours start',{exact:true}).fill('00:00');await bob.getByLabel('Quiet hours end',{exact:true}).fill('00:00');await bob.getByRole('button',{name:'Save notification settings',exact:true}).click();await expect(bob.getByText('Notification settings saved.',{exact:true})).toBeVisible();
    await bob.reload();await bob.getByRole('button',{name:'Settings',exact:true}).click();await expect(bob.getByLabel('Enable quiet hours',{exact:true})).toBeChecked();await expect(bob.getByLabel('Enable hourly email digests',{exact:true})).toBeChecked();
    const second=await other.newPage();await second.goto(`/?channel=${channel}`);
    const sent=await context.request.post(`${api}/v1/channels/${channel}/messages`,{headers:{origin:'http://localhost:3101'},data:{clientId:crypto.randomUUID(),format:'markdown-v1',body:`Private body ${Date.now()} [Bob](concord-mention:${bobId})`}});expect(sent.status()).toBe(201);message=(await sent.json()).id;
    const suppressed=await other.request.post(`${api}/v1/organizations/${org}/notification-claims`,{headers:{origin:'http://localhost:3101'},data:{}});expect((await suppressed.json()).suppressed).toBe('quiet-hours');
    const calls=async()=>[...await bob.evaluate(()=>(window as unknown as {notificationCalls:unknown[]}).notificationCalls),...await second.evaluate(()=>(window as unknown as {notificationCalls:unknown[]}).notificationCalls)];
    expect(await calls()).toHaveLength(0);
    await bob.getByLabel('Enable hourly email digests',{exact:true}).uncheck();await bob.getByLabel('Enable quiet hours',{exact:true}).uncheck();await bob.getByRole('button',{name:'Save notification settings',exact:true}).click();
    await expect.poll(async()=>(await calls()).length,{timeout:20000}).toBe(1);
    expect(JSON.stringify(await calls())).toContain('General');expect(JSON.stringify(await calls())).not.toContain('Private body');
    const again=await other.request.post(`${api}/v1/organizations/${org}/notification-claims`,{headers:{origin:'http://localhost:3101'},data:{}});expect((await again.json()).items).toEqual([]);
    await bob.getByRole('heading',{name:'Browser message alerts',exact:true}).scrollIntoViewIfNeeded();await bob.screenshot({path:'docs/evidence/notification-settings.png'});
  }finally{
    if(previous)await other.request.put(`${api}/v1/notification-settings`,{headers:{origin:'http://localhost:3101'},data:previous});
    if(message)await context.request.delete(`${api}/v1/channels/${channel}/messages/${message}`,{headers:{origin:'http://localhost:3101'}});
    await other.close();
  }
});

test('explicit reply opt-in invokes one native reply notification across two tabs',async({browser})=>{
  const a=await browser.newContext(),b=await browser.newContext();let previous:unknown,parent='';
  await b.grantPermissions(['notifications'],{origin:'http://localhost:3101'});
  await b.addInitScript(()=>{
    const root=window as unknown as {replyCalls:string[];Notification:typeof Notification};root.replyCalls=[];const Native=root.Notification;
    root.Notification=new Proxy(Native,{construct(target,args){const result=Reflect.construct(target,args);root.replyCalls.push(args[1]?.body??'');return result;}});
  });
  const login=async(p:import('@playwright/test').Page,email:string)=>{await p.goto(`/?channel=${channel}`);await p.getByLabel('Email address').fill(email);await p.getByLabel('Password',{exact:true}).fill('Development123!');await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.getByRole('button',{name:'Settings',exact:true}).click();};
  const path=`${api}/v1/channels/${channel}/messages`;
  try{
    const alice=await a.newPage(),bob=await b.newPage();await login(alice,'alice@acme.test');await login(bob,'bob@acme.test');
    previous=await (await b.request.get(`${api}/v1/notification-settings`)).json();
    await bob.getByLabel('Enable browser mention alerts',{exact:true}).uncheck();await bob.getByLabel('Enable browser reply alerts',{exact:true}).check();await bob.getByLabel('Enable quiet hours',{exact:true}).uncheck();await bob.getByRole('button',{name:'Save notification settings',exact:true}).click();await expect(bob.getByText('Notification settings saved.',{exact:true})).toBeVisible();
    await bob.reload();await bob.getByRole('button',{name:'Settings',exact:true}).click();await expect(bob.getByLabel('Enable browser reply alerts',{exact:true})).toBeChecked();
    const second=await b.newPage();await second.goto(`/?channel=${channel}`);await second.getByRole('button',{name:'Settings',exact:true}).click();
    const r=await b.request.post(path,{headers:{origin:'http://localhost:3101'},data:{clientId:crypto.randomUUID(),body:'reply notification parent'}});expect(r.status()).toBe(201);parent=(await r.json()).id;
    const sent=await a.request.post(path,{headers:{origin:'http://localhost:3101'},data:{clientId:crypto.randomUUID(),body:'Private reply text must not enter alerts',parentId:parent}});expect(sent.status()).toBe(201);
    const calls=async()=>[...await bob.evaluate(()=>(window as unknown as {replyCalls:string[]}).replyCalls),...await second.evaluate(()=>(window as unknown as {replyCalls:string[]}).replyCalls)];
    await expect.poll(async()=>(await calls()).length,{timeout:20000}).toBe(1);expect(await calls()).toEqual(['New reply in General']);
    const again=await b.request.post(`${api}/v1/organizations/${org}/notification-claims`,{headers:{origin:'http://localhost:3101'},data:{}});expect((await again.json()).items).toEqual([]);
    await bob.getByLabel('Enable browser reply alerts',{exact:true}).scrollIntoViewIfNeeded();await bob.screenshot({path:'docs/evidence/reply-alert-settings.png'});
  }finally{if(previous)await b.request.put(`${api}/v1/notification-settings`,{headers:{origin:'http://localhost:3101'},data:previous});if(parent)await b.request.delete(`${path}/${parent}`,{headers:{origin:'http://localhost:3101'}});await a.close();await b.close();}
});
