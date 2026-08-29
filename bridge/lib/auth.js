// Auth: shared-secret token + Origin validation.
// The token is generated on first start, persisted next to the bridge,
// and must be presented by every client (extension, curl, MCP server).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_FILE = path.join(__dirname, '..', '.inspector_token');

function loadOrCreateToken(tokenFile = TOKEN_FILE) {
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const token = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  return token;
}

function readToken(tokenFile = TOKEN_FILE) {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Extract the token from an incoming HTTP request (header or query string).
function tokenFromRequest(req) {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const headerToken = req.headers['x-inspector-token'];
  if (headerToken) return String(headerToken).trim();
  try {
    const url = new URL(req.url, 'http://localhost');
    const qs = url.searchParams.get('token');
    if (qs) return qs.trim();
  } catch { /* ignore */ }
  return null;
}

// A web page always sends an http(s) Origin. The extension sends
// chrome-extension://…, and curl/CLI clients send none. Reject the former.
function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser client (curl, MCP server)
  if (origin.startsWith('chrome-extension://')) return true;
  if (origin.startsWith('moz-extension://')) return true;
  return false;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Full check for an incoming request. Returns { ok, code, error }.
function authorize(req, expectedToken) {
  if (!isOriginAllowed(req.headers.origin)) {
    return { ok: false, code: 403, error: 'Forbidden origin' };
  }
  const presented = tokenFromRequest(req);
  if (!timingSafeEqual(presented || '', expectedToken)) {
    return { ok: false, code: 401, error: 'Invalid or missing token' };
  }
  return { ok: true };
}

module.exports = {
  TOKEN_FILE,
  loadOrCreateToken,
  readToken,
  tokenFromRequest,
  isOriginAllowed,
  timingSafeEqual,
  authorize,
};
