import { test, expect } from '@playwright/test';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',team='33333333-3333-4333-8333-333333333333',headers={origin:'http://localhost:3101'};
test.use({actionTimeout:10000});
test('draft hydration publishes saved text before live reconnect and cancels abandoned reads',async({page,context})=>{
  test.setTimeout(45000);
  let channel='';
  try {
    expect((await context.request.post(`${api}/v1/session`,{headers,data:{email:'alice@acme.test',password:'Development123!'}})).ok()).toBe(true);
    const made=await context.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name:`Draft hydration ${Date.now()}`,kind:'private',teamId:team,members:[]}});
    expect(made.ok()).toBe(true);channel=(await made.json()).id;
    const draftUrl=`${api}/v1/channels/${channel}/draft`,body=`Saved draft ${Date.now()}`;
    expect((await context.request.put(draftUrl,{headers,data:{body}})).ok()).toBe(true);
    // Deliver a controlled live-open callback just after the actual draft JSON
    // resolves, before React's passive state-ref effect. Reads/writes stay real.
    await page.addInitScript(({channel})=>{
      const sources:EventSource[]=[];const Native=window.EventSource;
      window.EventSource=class extends Native {
        constructor(url:string|URL,options?:EventSourceInit){super(url,options);if(String(url).includes(`/channels/${channel}/events`))sources.push(this);}
      };
      const nativeFetch=window.fetch;
      window.fetch=async(...args:Parameters<typeof fetch>)=>{
        const response=await nativeFetch(...args);
        if(String(args[0]).endsWith(`/channels/${channel}/draft`)&&(!args[1]?.method||args[1].method==='GET')){
          const json=response.json.bind(response);
          response.json=async()=>{
            const data=await json();
            queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>{for(const source of sources)source.onopen?.call(source,new Event('open'));})));
            return data;
          };
        }
        return response;
      };
    },{channel});
    const puts:string[]=[];
    page.on('request',r=>{if(r.url()===draftUrl&&r.method()==='PUT')puts.push(r.postDataJSON().body);});
    await page.goto(`/?org=${org}&channel=${channel}`);
    await expect(page.getByRole('textbox',{name:'Message',exact:true})).toHaveValue(body);
    await expect.poll(()=>puts.length).toBeGreaterThan(0);
    expect(puts.every(value=>value===body)).toBe(true);
    expect((await (await context.request.get(draftUrl)).json()).body).toBe(body);
    // Hold the next real GET, leave through SPA navigation, then release it.
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    let started=false,aborted=false;
    page.on('requestfailed',r=>{if(r.url()===draftUrl)aborted=true;});
    await page.route(draftUrl,async route=>{
      if(route.request().method()!=='GET'){await route.continue();return;}
      started=true;await gate;await route.continue().catch(()=>{});
    });
    try{
      await page.reload();await expect.poll(()=>started).toBe(true);
      await page.getByRole('button',{name:/^General(?: \d+)?$/}).click();
      await expect.poll(()=>aborted).toBe(true);
    }finally{release();await page.unroute(draftUrl);}
    expect((await (await context.request.get(draftUrl)).json()).body).toBe(body);
  }finally{
    if(channel){const base=`${api}/v1/channels/${channel}`;const response=await context.request.get(base+'/settings');if(response.ok()){const settings=await response.json();await context.request.patch(base+'/details',{headers,data:{name:settings.name,description:settings.description,archived:true,revision:settings.revision}});}}
  }
});
