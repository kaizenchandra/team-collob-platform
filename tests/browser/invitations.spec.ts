import {test,expect,type Page} from '@playwright/test';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
test('global notice opens invitations; recipient declines without membership then accepts a new invitation',async({browser})=>{
  const db=new Pool({connectionString:'postgres://concord:local-development-only@localhost:55432/concord'}),org=randomUUID(),name=`Invitation browser ${Date.now()}`;
  const a=await browser.newContext(),b=await browser.newContext();
  const login=async(page:Page,email:string)=>{await page.goto('/');await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('Development123!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();};
  try{
    await db.query('INSERT INTO organizations(id,name) VALUES($1,$2)',[org,name]);await db.query("INSERT INTO memberships VALUES($1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','owner',true)",[org]);
    const alice=await a.newPage(),bob=await b.newPage();await login(alice,'alice@acme.test');await login(bob,'bob@acme.test');await bob.getByRole('button',{name:'Chat',exact:true}).click();
    const invitation=await a.request.post(`http://localhost:4100/v1/organizations/${org}/invitations`,{headers:{origin:'http://localhost:3101'},data:{email:'bob@acme.test',role:'guest'}});expect(invitation.status()).toBe(200);
    await bob.getByRole('button',{name:'Review workspace invitations',exact:true}).click();await expect(bob.getByRole('heading',{name:'Your invitations',exact:true})).toBeVisible();
    const inbox=bob.getByRole('region',{name:'Workspace invitations'});const accept=inbox.getByRole('button',{name:`Accept invitation to ${name}`,exact:true});await expect(accept).toBeVisible({timeout:12000});await expect(inbox.getByText('Role: guest',{exact:false}).first()).toBeVisible();
    await inbox.getByRole('button',{name:`Decline invitation to ${name}`,exact:true}).click();await expect(inbox.getByText(`Declined invitation to ${name}.`,{exact:true})).toBeVisible();await expect(accept).toHaveCount(0);
    expect((await b.request.get(`http://localhost:4100/v1/organizations/${org}/bootstrap`)).status()).toBe(404);
    const replacement=await a.request.post(`http://localhost:4100/v1/organizations/${org}/invitations`,{headers:{origin:'http://localhost:3101'},data:{email:'bob@acme.test',role:'guest'}});expect(replacement.status()).toBe(200);await expect(accept).toBeVisible({timeout:12000});
    await accept.scrollIntoViewIfNeeded();await bob.screenshot({path:'docs/evidence/invitation-inbox.png'});await accept.click();
    await expect(inbox.getByText(`Joined ${name}. Choose it from the workspace selector.`,{exact:true})).toBeVisible();await expect(accept).toHaveCount(0);
    const session=await b.request.get('http://localhost:4100/v1/session');expect((await session.json()).organizations.some((o:{id:string})=>o.id===org)).toBe(true);
    expect((await b.request.get(`http://localhost:4100/v1/organizations/${org}/bootstrap`)).status()).toBe(200);
  }finally{
    await db.query('UPDATE invitations SET revoked=true WHERE org_id=$1',[org]);await db.query('UPDATE memberships SET active=false WHERE org_id=$1',[org]);await db.end();await a.close();await b.close();
  }
});
