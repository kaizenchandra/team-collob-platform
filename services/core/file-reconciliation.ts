import {opendir,lstat,unlink} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {transaction} from "./db.ts";
import {fileRoot} from "./file-content.ts";
// Application-generated UUID names only. Never purge soft-deleted but referenced bytes here.
export async function reconcileFiles() {
  const root=fileRoot(),result={examined:0,removed:0,skippedBatches:0};
  const directory=await opendir(root).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return null;throw error;});
  if(!directory)return result;
  const batch=async(names:string[])=>transaction(async db=>{
    const lock=await db.query("SELECT pg_try_advisory_xact_lock(712341) locked");
    if(!lock.rows[0].locked){result.skippedBatches++;return;}
    const existing=await db.query("SELECT storage_key FROM files WHERE storage_key=ANY($1::text[])",[names]);
    const referenced=new Set(existing.rows.map(r=>r.storage_key));
    for(const name of names){
      result.examined++;
      if(referenced.has(name))continue;
      const filename=path.join(root,name);
      const stat=await lstat(filename).catch((error:NodeJS.ErrnoException)=>{if(error.code==="ENOENT")return null;throw error;});
      if(!stat?.isFile() || stat.mtimeMs>Date.now()-3600000)continue;
      await unlink(filename);result.removed++;
    }
  });
  let names:string[]=[];
  for await(const entry of directory){
    if(!z.uuid().safeParse(entry.name).success)continue;
    names.push(entry.name);
    if(names.length>=500){await batch(names);names=[];}
  }
  if(names.length)await batch(names);
  return result;
}
