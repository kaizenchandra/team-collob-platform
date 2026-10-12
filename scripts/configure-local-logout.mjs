import { request } from './local-identity-admin.mjs';
const username = 'concord-local-admin';
if (process.argv.includes('--remove-admin')) {
  const users = await request(`master/users?username=${username}&exact=true`);
  if (users.length !== 1) throw new Error('Expected one temporary administrator');
  await request(`master/users/${users[0].id}`, 'DELETE');
  console.log('Removed temporary local administrator.');
} else {
  const clients = await request('concord-local/clients?clientId=concord-local');
  if (clients.length !== 1) throw new Error('Expected one local application client');
  const client = clients[0];
  client.attributes = {...client.attributes,'backchannel.logout.url':'http://api:4100/v1/auth/backchannel-logout','backchannel.logout.session.required':'true'};
  await request(`concord-local/clients/${client.id}`, 'PUT', client);
  console.log('Configured local client back-channel logout; existing realm/users retained.');
}
