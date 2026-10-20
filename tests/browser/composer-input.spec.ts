import {test,expect} from '@playwright/test';
const api='http://localhost:4100',org='11111111-1111-4111-8111-111111111111',team='33333333-3333-4333-8333-333333333333',headers={origin:'http://localhost:3101'};
test.use({actionTimeout:10000});
test('composition Enter preserves multilingual drafts until ordinary Enter explicitly sends; Shift Enter stays multiline',async({page,context})=>{
  test.setTimeout(45000);let channel='';
  try{
    expect((await context.request.post(`${api}/v1/session`,{headers,data:{email:'alice@acme.test',password:'Development123!'}})).ok()).toBe(true);
    const made=await context.request.post(`${api}/v1/organizations/${org}/channels`,{headers,data:{name:`Composer input ${Date.now()}`,kind:'private',teamId:team,members:[]}});expect(made.ok()).toBe(true);channel=(await made.json()).id;const base=`${api}/v1/channels/${channel}`;
    await page.goto(`/?org=${org}&channel=${channel}`);const input=page.getByRole('textbox',{name:'Message',exact:true});await expect(input).toBeEnabled();
    const posts:{body:string;clientId:string}[]=[];page.on('request',request=>{if(request.url()===base+'/messages'&&request.method()==='POST')posts.push(request.postDataJSON());});
    const body=`入力中 中文 हिन्दी ${Date.now()}`;await input.fill(body);
    // Controlled native event fields exercise React's handler boundary. This is
    // not an emulation of an OS candidate window or installation of an IME.
    const allowed=await input.evaluate(element=>{
      element.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));
      element.dispatchEvent(new CompositionEvent('compositionupdate',{bubbles:true,data:'中'}));
      return element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',isComposing:true,bubbles:true,cancelable:true}));
    });
    expect(allowed).toBe(true);expect(posts).toEqual([]);await expect(input).toHaveValue(body);
    await input.evaluate(element=>element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'})));
    const legacyAllowed=await input.evaluate(element=>element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,bubbles:true,cancelable:true})));
    expect(legacyAllowed).toBe(true);expect(posts).toEqual([]);await expect(input).toHaveValue(body);
    await expect.poll(async()=>(await (await context.request.get(base+'/draft')).json()).body).toBe(body);expect((await (await context.request.get(base+'/messages')).json()).messages).toHaveLength(0);
    await input.focus();await input.press('ControlOrMeta+End');await input.press('Shift+Enter');await input.press('Shift+Enter');await input.pressSequentially('next line');const multiline=body+'\n\nnext line';await expect(input).toHaveValue(multiline);expect(posts).toEqual([]);
    await input.press('Enter');await expect(input).toHaveValue('');expect(posts).toHaveLength(1);expect(posts[0].body).toBe(multiline);const accepted=(await (await context.request.get(base+'/messages')).json()).messages;expect(accepted).toHaveLength(1);expect(accepted[0].body).toBe(multiline);
    // A later normal Enter remains usable after composition and acknowledgement.
    await input.fill('通常の送信');await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();await input.press('Enter');await expect(input).toHaveValue('');expect(posts).toHaveLength(2);expect(posts[1].clientId).not.toBe(posts[0].clientId);expect((await (await context.request.get(base+'/messages')).json()).messages).toHaveLength(2);
  }finally{if(channel){const base=`${api}/v1/channels/${channel}`;for(const message of (await (await context.request.get(base+'/messages')).json()).messages??[])if(!message.deleted)await context.request.delete(`${base}/messages/${message.id}`,{headers});const response=await context.request.get(base+'/settings');if(response.ok()){const settings=await response.json();await context.request.patch(base+'/details',{headers,data:{name:settings.name,description:settings.description,archived:true,revision:settings.revision}});}}}
});
