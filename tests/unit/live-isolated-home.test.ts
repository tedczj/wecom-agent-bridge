import test from 'node:test';
import assert from 'node:assert/strict';
import { accessOnlyAuth } from '../live/isolated-home.ts';

test('OFFLINE isolated auth: only a valid access snapshot is retained; refresh and unrelated credentials never copied', () => {
  const now = Date.now(), access = 'header.' + Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 7200 })).toString('base64url') + '.signature';
  const auth = { auth_mode: 'chatgpt', OPENAI_API_KEY: 'DO_NOT_COPY_KEY', last_refresh: new Date(now - 1000).toISOString(),
    agent_identity: 'DO_NOT_COPY_IDENTITY', tokens: { id_token: 'synthetic-id', access_token: access, refresh_token: 'DO_NOT_COPY_REFRESH', account_id: 'synthetic-account' } };
  const copy = accessOnlyAuth(auth, now);
  assert.deepEqual(copy, { auth_mode: 'chatgpt', OPENAI_API_KEY: null, last_refresh: auth.last_refresh,
    tokens: { id_token: 'synthetic-id', access_token: access, refresh_token: '', account_id: 'synthetic-account' } });
  assert.equal(JSON.stringify(copy).includes('DO_NOT_COPY'), false); assert.equal(auth.tokens.refresh_token, 'DO_NOT_COPY_REFRESH');
  assert.throws(() => accessOnlyAuth(auth, now + 7200000), /LIVE_ISOLATED_AUTH_EXPIRING/);
  assert.throws(() => accessOnlyAuth({ ...auth, last_refresh: new Date(now - 8 * 86400000).toISOString() }, now), /LIVE_ISOLATED_AUTH_REFRESH_REQUIRED/);
  assert.throws(() => accessOnlyAuth({ ...auth, auth_mode: 'apikey' }, now), /LIVE_ISOLATED_AUTH_UNSUPPORTED/);
});
