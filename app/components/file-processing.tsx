export function FileProcessing({state,status,attempts}:{state:string;status:string|null;attempts?:number|null}){
  let explanation='Processing information is unavailable.';
  if(state==='ready')explanation='Scan passed. Downloads still require access.';
  else if(state==='rejected')explanation='Scan rejected this file. Download is blocked.';
  else if(state==='quarantined'){
    explanation=status==='dead'?'Scan attempts exhausted. Download stays blocked. The uploader can retry scanning.':status==='running'?'Scanning in progress. Download stays blocked.':status==='queued'?'Waiting for a scan or scheduled retry. Download stays blocked.':status==='cancelled'?'Scanning was cancelled. Download stays blocked.':'Scan status is unavailable. Download stays blocked.';
  }
  return <p className="file-processing">{explanation}{attempts!==undefined&&attempts!==null&&<> Scan attempts: {attempts} of 5.</>}</p>;
}
