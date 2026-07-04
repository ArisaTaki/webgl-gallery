import crypto from 'node:crypto';
import { parseCookie, stringifySetCookie } from 'cookie';

const SESSION_COOKIE = 'gallery_admin';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const processSessionSecret = crypto.randomBytes(32).toString('hex');

export function verifyAdminPassword(password) {
  const supplied = String(password || '');
  const configuredHash = process.env.GALLERY_ADMIN_PASSWORD_HASH;
  if (!configuredHash) return false;
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

export function verifyLegacyUploadKey(suppliedKey) {
  const configuredKey = String(process.env.GALLERY_UPLOAD_KEY || '');
  return Boolean(configuredKey) && timingSafeStringEqual(String(suppliedKey || ''), configuredKey);
}

export function createPasswordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `scrypt:${salt}:${crypto.scryptSync(String(password), salt, 64).toString('hex')}`;
}

export function createAdminSessionCookie(request = null) {
  const issuedAt = String(Date.now());
  const signature = signSession(issuedAt);
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: `${issuedAt}.${signature}`,
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
    sameSite: 'lax',
    secure: shouldUseSecureCookie(request),
  });
}

export function clearAdminSessionCookie(request = null) {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    maxAge: 0,
    path: '/',
    sameSite: 'lax',
    secure: shouldUseSecureCookie(request),
  });
}

export function isAdminRequest(request) {
  if (!isSameOriginRequest(request)) return false;
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

function isSameOriginRequest(request) {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return true;
  const origin = headerValue(request, 'origin');
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host.toLowerCase();
    const forwardedHost = headerValue(request, 'x-forwarded-host').split(',')[0]?.trim().toLowerCase();
    const requestHost = forwardedHost || headerValue(request, 'host').toLowerCase();
    return Boolean(requestHost) && originHost === requestHost;
  } catch {
    return false;
  }
}

export function requireAdmin(request, response, next) {
  if (isAdminRequest(request)) {
    next();
    return;
  }
  response.status(401).json({ ok: false, message: 'Admin login required.' });
}

function signSession(issuedAt) {
  const secret = process.env.SESSION_SECRET || processSessionSecret;
  return crypto.createHmac('sha256', secret).update(String(issuedAt)).digest('hex');
}

function shouldUseSecureCookie(request) {
  const override = process.env.GALLERY_SESSION_COOKIE_SECURE || process.env.SESSION_COOKIE_SECURE;
  if (override) return ['1', 'true', 'yes', 'on'].includes(String(override).trim().toLowerCase());
  if (!request) return process.env.NODE_ENV === 'production';
  if (request.secure) return true;
  const forwardedProto = headerValue(request, 'x-forwarded-proto').split(',')[0]?.trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  const forwarded = headerValue(request, 'forwarded').toLowerCase();
  if (/(^|[;,]\s*)proto=https($|[;,])/.test(forwarded)) return true;
  const cfVisitor = headerValue(request, 'cf-visitor');
  return /"scheme"\s*:\s*"https"/i.test(cfVisitor);
}

function headerValue(request, name) {
  const value = request?.headers?.[name];
  return Array.isArray(value) ? value.join(',') : String(value || '');
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
