import crypto from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';

const SESSION_COOKIE = 'gallery_admin';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function verifyAdminPassword(password) {
  const supplied = String(password || '');
  const configuredHash = process.env.GALLERY_ADMIN_PASSWORD_HASH;
  if (!configuredHash) {
    return timingSafeStringEqual(supplied, process.env.GALLERY_UPLOAD_KEY || '13209');
  }
  if (configuredHash.startsWith('sha256:')) {
    const digest = crypto.createHash('sha256').update(supplied).digest('hex');
    return timingSafeStringEqual(digest, configuredHash.slice('sha256:'.length));
  }
  if (configuredHash.startsWith('scrypt:')) {
    const [, salt, expected] = configuredHash.split(':');
    if (!salt || !expected) return false;
    const digest = crypto.scryptSync(supplied, salt, 64).toString('hex');
    return timingSafeStringEqual(digest, expected);
  }
  return false;
}

export function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `scrypt:${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}

export function createAdminSessionCookie() {
  const issuedAt = String(Date.now());
  const signature = signSession(issuedAt);
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: `${issuedAt}.${signature}`,
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

export function clearAdminSessionCookie() {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });
}

export function isAdminRequest(request) {
  const header = request.headers.cookie || '';
  const cookies = parseCookie(header);
  const token = cookies[SESSION_COOKIE];
  if (!token) return false;
  const [issuedAt, signature] = String(token).split('.');
  if (!issuedAt || !signature) return false;
  const age = Date.now() - Number(issuedAt);
  if (!Number.isFinite(age) || age < 0 || age > SESSION_MAX_AGE_SECONDS * 1000) return false;
  return timingSafeStringEqual(signature, signSession(issuedAt));
}

export function requireAdmin(request, response, next) {
  if (isAdminRequest(request)) {
    next();
    return;
  }
  response.status(401).json({ ok: false, message: 'Admin login required.' });
}

function signSession(issuedAt) {
  const secret = process.env.SESSION_SECRET || process.env.GALLERY_UPLOAD_KEY || 'dev-gallery-session-secret';
  return crypto.createHmac('sha256', secret).update(String(issuedAt)).digest('hex');
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
