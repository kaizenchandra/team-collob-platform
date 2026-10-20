import type {UploadProgress} from '@/lib/upload-file';
export function UploadProgressView({value}:{value:UploadProgress|null}){
  if(!value)return null;
  if(value.phase==='accepted')return <p role="status">Upload accepted. It must pass malware scanning before download.</p>;
  const measurable=value.phase==='reading'||value.phase==='uploading';
  const percent=measurable&&value.total!==null&&value.total>0?Math.min(100,Math.max(0,Math.floor(value.loaded/value.total*100))):undefined;
  const label=value.phase==='reading'?'Reading selected file':value.phase==='preparing'?'Preparing upload':value.phase==='confirming'?'Waiting for upload confirmation':'Uploading file';
  return <div className="upload-progress"><p role="status">{label}{percent===undefined?'…':`… ${percent}%`}</p><progress aria-label={label} max={100} value={percent}/>{value.phase==='confirming'&&<p>Transfer finished. The server has not confirmed acceptance yet.</p>}</div>;
}
