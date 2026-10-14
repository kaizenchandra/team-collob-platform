export const releaseServices = ['web','api','postgres','keycloak','clamav','file-worker','file-reconciler','object-store','mailpit','digest-worker'];

export function assertReleaseHealth(containers, images, version) {
  const expected = {
    web: `concord-web:${version}-local`,
    api: `concord-api:${version}-local`,
    'file-worker': `concord-api:${version}-local`,
    'file-reconciler': `concord-api:${version}-local`,
    'digest-worker': `concord-api:${version}-local`,
    mailpit: 'axllent/mailpit:v1.31.5',
    clamav: 'concord-scanner:0.1.10-local',
    'object-store': 'chrislusf/seaweedfs:4.48',
  };
  for (const service of releaseServices) {
    const state = containers[service];
    if (!state || state.status !== 'running' || state.health !== 'healthy' || !state.imageId)
      throw new Error(`Release blocked: ${service} must be running and healthy with an image identity`);
    const image = expected[service];
    if (image && (!images[image]?.imageId || state.imageId !== images[image].imageId))
      throw new Error(`Release blocked: ${service} is not running the expected image ${image}`);
  }
}
