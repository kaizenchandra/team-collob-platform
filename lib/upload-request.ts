import {API,ApiError} from './contracts';
export type UploadProgress={phase:'reading'|'uploading';loaded:number;total:number|null}|{phase:'preparing'|'confirming'|'accepted'};
export function postUpload(path:string,body:unknown,signal?:AbortSignal,progress?:(value:UploadProgress)=>void):Promise<void>{
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();let settled=false;
    const finish=(error?:unknown)=>{
      if(settled)return;settled=true;signal?.removeEventListener('abort',abort);
      request.onload=request.onerror=request.onabort=request.ontimeout=null;request.upload.onprogress=request.upload.onload=null;
      if(error===undefined)resolve();else reject(error);
    };
    const abort=()=>{finish(signal?.reason??new DOMException('Upload interrupted','AbortError'));request.abort();};
    request.open('POST',`${API}/v1${path}`);request.withCredentials=true;request.timeout=20000;request.setRequestHeader('Content-Type','application/json');
    request.upload.onprogress=event=>{if(!settled&&!signal?.aborted)progress?.({phase:'uploading',loaded:event.loaded,total:event.lengthComputable&&event.total>0?event.total:null});};
    request.upload.onload=()=>{if(!settled&&!signal?.aborted)progress?.({phase:'confirming'});};
    request.onload=()=>{
      try{const data=JSON.parse(request.responseText);if(request.status<200||request.status>=300)throw new ApiError(typeof data?.error==='string'?data.error:'Upload request failed',request.status);finish();}
      catch(error){finish(error);}
    };
    request.onerror=()=>finish(new TypeError('Upload connection failed'));
    request.onabort=()=>finish(new DOMException('Upload interrupted','AbortError'));
    request.ontimeout=()=>finish(new DOMException('Upload confirmation timed out','TimeoutError'));
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    try{progress?.({phase:'uploading',loaded:0,total:null});request.send(JSON.stringify(body));}catch(error){finish(error);}
  });
}
