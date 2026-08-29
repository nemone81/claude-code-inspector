#!/usr/bin/env node
// Manual smoke test for the companion focus round-trip.
// Requires a running bridge (default http://127.0.0.1:3131).
// Simulates an extension: connects over WS, announces a fake profile,
// then asks the bridge to focus it and prints the result.
//
// Usage: node test/manual/focus-smoke.js

const http = require('http');
const WebSocket = require('ws');
const { readToken } = require('../../lib/auth');

const BRIDGE = process.env.INSPECTOR_BRIDGE_URL || 'http://127.0.0.1:3131';
const WS_URL = BRIDGE.replace(/^http/, 'ws') + '/ws?token=';
const PROFILE = 'focus-smoke-profile';

const token = readToken();
if (!token) {
  console.error('No token file — start the bridge first.');
  process.exit(1);
}

const ws = new WebSocket(WS_URL + encodeURIComponent(token));

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'companion_snapshot',
    profileId: PROFILE,
    email: 'smoke@test.local',
    windows: [{ id: 1, focused: true, state: 'normal', tabCount: 0 }],
    tabs: [],
    timestamp: Date.now(),
  }));

  setTimeout(() => {
    const req = http.request(`${BRIDGE}/browsers/${PROFILE}/focus`, {
      method: 'POST',
      headers: { 'X-Inspector-Token': token },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        console.log('focus result:', body);
        const ok = JSON.parse(body).success === true;
        console.log(ok ? 'PASS' : 'FAIL');
        process.exit(ok ? 0 : 1);
      });
    });
    req.end();
  }, 300);
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'focus_request') {
    // Behave like the extension: ack the focus.
    ws.send(JSON.stringify({ type: 'focus_ack', profileId: PROFILE, success: true, windowId: 1 }));
  }
});

ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
setTimeout(() => { console.error('FAIL: test timeout'); process.exit(1); }, 10000);
