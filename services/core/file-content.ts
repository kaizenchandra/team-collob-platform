import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { HttpError } from "./security.ts";
export const fileRoot = () => path.resolve(process.env.FILE_ROOT ?? ".data/files");
export function validateFile(name: string, mime: string, bytes: Buffer) {
  const ext = path.extname(name).toLowerCase();
  let detected = "";
  if ([".txt",".md",".csv"].includes(ext)) {
    try { new TextDecoder("utf-8",{fatal:true}).decode(bytes); } catch { throw new HttpError(400,"Text files must contain UTF-8 text"); }
    if (bytes.includes(0)) throw new HttpError(400,"Binary content is not allowed in text files");
    detected = ext === ".csv" ? "text/csv" : ext === ".md" ? "text/markdown" : "text/plain";
  } else if (ext === ".pdf" && bytes.subarray(0,5).equals(Buffer.from("%PDF-"))) detected="application/pdf";
  else if (ext === ".png" && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) detected="image/png";
  else if ([".jpg",".jpeg"].includes(ext) && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) detected="image/jpeg";
  if (!detected) throw new HttpError(400,"Supported uploads: UTF-8 TXT/MD/CSV, PDF, PNG and JPEG with matching content signatures");
  if (mime !== detected && mime !== "application/octet-stream" && !([".md",".csv"].includes(ext) && mime==="text/plain")) throw new HttpError(400,"File type does not match the declared content type");
  return detected;
}
export async function storedBytes(file: {storage_key:string; bytes:string|number;sha256:string}) {
  const key=z.uuid().parse(file.storage_key);
  const handle=await open(path.join(fileRoot(),key),constants.O_RDONLY|constants.O_NOFOLLOW);
  let data:Buffer;
  try {
    const meta=await handle.stat();
    if(!meta.isFile() || meta.size>1048576 || meta.size!==Number(file.bytes))throw new Error("Invalid stored file size");
    const buffer=Buffer.alloc(meta.size+1);let offset=0;
    while(offset<buffer.length){const part=await handle.read(buffer,offset,buffer.length-offset,offset);if(!part.bytesRead)break;offset+=part.bytesRead;}
    data=buffer.subarray(0,offset);
  } finally {await handle.close();}
  if(data.length>1048576 || data.length!==Number(file.bytes) || createHash("sha256").update(data).digest("hex")!==file.sha256) throw new Error("File integrity verification failed");
  return data;
}
