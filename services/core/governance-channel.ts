import type {DB} from './db.ts';
import {channel,HttpError} from './security.ts';
export async function ownerTeamChannel(db:DB,user:string,id:string){
  await channel(db,user,id,true);const c=await channel(db,user,id);
  const role=(await db.query('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2 AND active FOR SHARE',[c.org_id,user])).rows[0];
  if(role?.role!=='owner')throw new HttpError(403,'Workspace owner role required');
  if(!['standard','private','shared'].includes(c.kind))throw new HttpError(400,'Channel governance is available only for team channels');
  return c;
}
