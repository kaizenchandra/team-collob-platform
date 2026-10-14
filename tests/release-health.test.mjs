import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertReleaseHealth,releaseServices} from '../scripts/release-health.mjs';
function fixture(){
  const names=['concord-web:0.1.14-local','concord-api:0.1.14-local','concord-scanner:0.1.10-local','chrislusf/seaweedfs:4.48','axllent/mailpit:v1.31.5'];
  const images=Object.fromEntries(names.map(image=>[image,{imageId:`sha256:${image}`} ]));
  const indices={web:0,api:1,'file-worker':1,'file-reconciler':1,clamav:2,'object-store':3,mailpit:4,'digest-worker':1};
  const containers=Object.fromEntries(releaseServices.map(service=>[service,{status:'running',health:'healthy',imageId:indices[service]===undefined?'sha256:infrastructure':images[names[indices[service]]].imageId}]));
  return {images,containers};
}
test('release evidence requires every service and actual expected images',()=>{
  const {images,containers}=fixture();assert.doesNotThrow(()=>assertReleaseHealth(containers,images,'0.1.14'));
  for(const service of releaseServices){
    const missing=structuredClone(containers);delete missing[service];assert.throws(()=>assertReleaseHealth(missing,images,'0.1.14'),/Release blocked/);
    for(const patch of [{status:'exited'},{health:'starting'},{health:'unhealthy'},{imageId:''}]){
      assert.throws(()=>assertReleaseHealth({...containers,[service]:{...containers[service],...patch}},images,'0.1.14'),/Release blocked/);
    }
  }
  for(const service of ['web','api','file-worker','file-reconciler','clamav','object-store','mailpit','digest-worker']){
    assert.throws(()=>assertReleaseHealth({...containers,[service]:{...containers[service],imageId:'sha256:stale'}},images,'0.1.14'),/expected image/);
  }
  assert.throws(()=>assertReleaseHealth(containers,{},'0.1.14'),/expected image/);
  assert.throws(()=>assertReleaseHealth(containers,images,'0.1.15'),/expected image/);
});
