#!/usr/bin/env node
// In-container helper for the FIRST account and pairing codes of a Hosted Relay. It talks to the
// app listener on the container's own loopback, exactly like a browser on the host would.
//   docker exec -e RELAY_USERNAME -e RELAY_PASSWORD <relay> node deploy/relay-admin.mjs <command>
// Commands: state | register | pairing-code | enrollment-code [label]
// The password comes from the environment only and is never printed.
const APP = `http://127.0.0.1:${process.env.SERVER_PORT || 3001}`;
const [, , command, ...rest] = process.argv;
const username = process.env.RELAY_USERNAME;
const password = process.env.RELAY_PASSWORD;

async function call(path, { method = 'GET', body, bearer } = {}) {
  const response = await fetch(APP + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: response.status, json };
}

async function token() {
  if (!username || !password) throw new Error('RELAY_USERNAME and RELAY_PASSWORD must be set in the environment');
  const login = await call('/api/auth/login', { method: 'POST', body: { username, password } });
  if (!login.json?.token) throw new Error(`login refused (${login.status})`);
  return login.json.token;
}

try {
  if (command === 'state') {
    const status = await call('/api/auth/status');
    console.log(status.json?.needsSetup ? 'no account yet (needsSetup=true)' : 'an account exists (needsSetup=false)');
  } else if (command === 'register') {
    if (!username || !password) throw new Error('RELAY_USERNAME and RELAY_PASSWORD must be set in the environment');
    const result = await call('/api/auth/register', { method: 'POST', body: { username, password } });
    if (result.status !== 200 && result.status !== 201) throw new Error(`register refused (${result.status}): an account may already exist`);
    console.log(`account "${username}" created`);
  } else if (command === 'pairing-code') {
    const result = await call('/api/remote-access/pairing-codes', { method: 'POST', bearer: await token() });
    if (!result.json?.data?.code) throw new Error(`no code issued (${result.status})`);
    console.log(`pairing code: ${result.json.data.code}   (single use, expires ${result.json.data.expiresAt})`);
  } else if (command === 'enrollment-code') {
    const result = await call('/api/runtime-nodes/enrollments', { method: 'POST', body: { label: rest[0] || 'node' }, bearer: await token() });
    if (!result.json?.data?.code) throw new Error(`no code issued (${result.status})`);
    console.log(`node enrollment code: ${result.json.data.code}   (single use, expires ${result.json.data.expiresAt})`);
  } else {
    throw new Error('usage: relay-admin.mjs state | register | pairing-code | enrollment-code [label]');
  }
} catch (error) {
  console.error(`relay-admin: ${error.message}`);
  process.exit(1);
}
