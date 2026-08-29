const { test } = require('node:test');
const assert = require('node:assert');
const { isOriginAllowed, tokenFromRequest, authorize, timingSafeEqual } = require('../lib/auth');

test('origins: web pages are rejected, extension and CLI clients pass', () => {
  assert.equal(isOriginAllowed(undefined), true, 'no Origin (curl/MCP) is allowed');
  assert.equal(isOriginAllowed('chrome-extension://abcdef'), true);
  assert.equal(isOriginAllowed('http://evil.example'), false);
  assert.equal(isOriginAllowed('https://evil.example'), false);
  assert.equal(isOriginAllowed('null'), false);
});

test('token extraction: Bearer, custom header, query string', () => {
  assert.equal(tokenFromRequest({ headers: { authorization: 'Bearer abc' }, url: '/send' }), 'abc');
  assert.equal(tokenFromRequest({ headers: { 'x-inspector-token': 'xyz' }, url: '/send' }), 'xyz');
  assert.equal(tokenFromRequest({ headers: {}, url: '/ws?token=qrs' }), 'qrs');
  assert.equal(tokenFromRequest({ headers: {}, url: '/send' }), null);
});

test('authorize: full flow', () => {
  const token = 'secret-token';
  const ok = authorize({ headers: { 'x-inspector-token': token }, url: '/send' }, token);
  assert.equal(ok.ok, true);

  const badToken = authorize({ headers: { 'x-inspector-token': 'wrong' }, url: '/send' }, token);
  assert.deepEqual([badToken.ok, badToken.code], [false, 401]);

  const noToken = authorize({ headers: {}, url: '/send' }, token);
  assert.deepEqual([noToken.ok, noToken.code], [false, 401]);

  const webPage = authorize(
    { headers: { origin: 'http://evil.example', 'x-inspector-token': token }, url: '/send' },
    token
  );
  assert.deepEqual([webPage.ok, webPage.code], [false, 403], 'valid token from a web page is still rejected');
});

test('timingSafeEqual handles length mismatch and non-strings', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual(null, 'abc'), false);
});
