import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { SecurityError, ValidationError } from './errors.mjs';
import { sha256 } from './canonical.mjs';

const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) blocked4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2001:10::', 28],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) blocked6.addSubnet(address, prefix, 'ipv6');

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions?/i,
  /system\s+prompt/i,
  /developer\s+message/i,
  /do\s+not\s+follow\s+(the\s+)?(previous|above)/i,
  /reveal\s+(your\s+)?(prompt|secrets?|credentials?)/i,
  /exfiltrat(e|ion)/i,
  /call\s+(the\s+)?tool/i,
  /you\s+are\s+(chatgpt|claude|an\s+ai)/i,
];

function decodeEntities(text) {
  const named = new Map([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
    ['nbsp', ' '],
    ['ndash', '–'],
    ['mdash', '—'],
    ['hellip', '…'],
  ]);
  return text.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z]+);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named.get(entity.toLowerCase()) ?? match;
  });
}

export function normalizeText(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToText(html) {
  let text = String(html);
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|svg|template|iframe|object|embed)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  text = text.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  text = text.replace(/<\/(p|div|section|article|header|footer|li|tr|h[1-6])\s*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  return normalizeText(decodeEntities(text));
}

export function detectPromptInjection(text) {
  const flags = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) flags.push(pattern.source);
  }
  return flags;
}

export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return blocked4.check(address, 'ipv4');
  if (family === 6) return blocked6.check(address, 'ipv6');
  return true;
}

export function validateUrlSyntax(rawUrl, allowedDomains = []) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('Source URL is invalid');
  }
  if (url.protocol !== 'https:') throw new SecurityError('Only HTTPS source URLs are allowed');
  if (url.username || url.password) throw new SecurityError('Source URLs must not contain credentials');
  if (url.port && url.port !== '443') throw new SecurityError('Only HTTPS port 443 is allowed');
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253) throw new SecurityError('Source hostname is invalid');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new SecurityError('Local or internal hostnames are blocked');
  }
  const literalFamily = net.isIP(hostname.replace(/^\[|\]$/g, ''));
  if (literalFamily && isBlockedAddress(hostname.replace(/^\[|\]$/g, ''))) throw new SecurityError('Private or reserved IP addresses are blocked');
  if (allowedDomains.length) {
    const allowed = allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    if (!allowed) throw new SecurityError('Source hostname is outside the configured allowlist', { hostname });
  }
  url.hash = '';
  return url;
}

export async function resolvePublicAddress(hostname, resolver = dns.lookup) {
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal)) {
    if (isBlockedAddress(literal)) throw new SecurityError('Private or reserved IP addresses are blocked');
    return { address: literal, family: net.isIP(literal) };
  }
  let answers;
  try {
    answers = await resolver(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new SecurityError('DNS resolution failed', { hostname, cause: error.message });
  }
  if (!Array.isArray(answers) || answers.length === 0) throw new SecurityError('DNS returned no addresses', { hostname });
  for (const answer of answers) {
    if (!answer?.address || isBlockedAddress(answer.address)) {
      throw new SecurityError('DNS resolved to a private or reserved address', { hostname, address: answer?.address });
    }
  }
  return answers[0];
}

function requestOnce(url, address, { timeoutMs, maxBytes, requestImpl }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = requestImpl(
      {
        protocol: 'https:',
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'User-Agent': 'ProofGraph-Claude/0.2 (+local evidence verifier)',
          Accept: 'text/html, text/plain, application/json, application/xml, application/xhtml+xml;q=0.9',
          'Accept-Encoding': 'identity',
          Connection: 'close',
        },
        servername: url.hostname,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        rejectUnauthorized: true,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const headers = response.headers;
        if (status >= 300 && status < 400) {
          response.resume();
          finish(resolve, { redirect: headers.location, status, headers });
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          finish(reject, new SecurityError(`Source returned HTTP ${status}`, { status }));
          return;
        }
        const contentLength = Number(headers['content-length'] ?? 0);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          response.destroy();
          finish(reject, new SecurityError('Source exceeds maximum size', { content_length: contentLength, max_bytes: maxBytes }));
          return;
        }
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > maxBytes) {
            response.destroy(new SecurityError('Source exceeds maximum size', { max_bytes: maxBytes }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => finish(resolve, { status, headers, body: Buffer.concat(chunks) }));
        response.on('error', (error) => finish(reject, error));
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new SecurityError('Source request timed out')));
    request.on('error', (error) => finish(reject, error));
    request.end();
  });
}

export async function fetchVerifiedSource(rawUrl, {
  allowedDomains = [],
  timeoutMs = 15000,
  maxBytes = 1_500_000,
  maxRedirects = 5,
  resolver = dns.lookup,
  requestImpl = https.request,
} = {}) {
  let current = validateUrlSyntax(rawUrl, allowedDomains);
  const redirectChain = [];
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const address = await resolvePublicAddress(current.hostname, resolver);
    const response = await requestOnce(current, address, { timeoutMs, maxBytes, requestImpl });
    if (response.redirect !== undefined) {
      if (!response.redirect) throw new SecurityError('Redirect response omitted Location header');
      if (redirectCount === maxRedirects) throw new SecurityError('Too many redirects');
      const next = new URL(response.redirect, current);
      redirectChain.push({ from: current.toString(), to: next.toString(), status: response.status });
      current = validateUrlSyntax(next.toString(), allowedDomains);
      continue;
    }
    const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
    const allowedType = contentType.startsWith('text/') ||
      contentType.includes('application/json') ||
      contentType.includes('application/xml') ||
      contentType.includes('application/xhtml+xml');
    if (!allowedType) throw new SecurityError('Source content type is not supported', { content_type: contentType || 'unknown' });
    const rawText = response.body.toString('utf8');
    const normalized = contentType.includes('html') || /<html[\s>]/i.test(rawText) ? htmlToText(rawText) : normalizeText(rawText);
    if (!normalized) throw new SecurityError('Source contained no usable text');
    const injectionFlags = detectPromptInjection(normalized);
    return {
      requested_url: rawUrl,
      final_url: current.toString(),
      hostname: current.hostname.toLowerCase(),
      fetched_at: new Date().toISOString(),
      status: response.status,
      content_type: contentType || 'unknown',
      raw_sha256: sha256(response.body),
      text_sha256: sha256(normalized),
      text: normalized,
      bytes: Buffer.byteLength(normalized, 'utf8'),
      redirect_chain: redirectChain,
      prompt_injection_flags: injectionFlags,
      prompt_injection_suspected: injectionFlags.length > 0,
    };
  }
  throw new SecurityError('Unexpected redirect state');
}

export function findTextMatches(text, query, maxMatches = 5) {
  const normalizedText = normalizeText(text);
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) throw new ValidationError('Search query is empty');
  const haystack = normalizedText.toLocaleLowerCase('en-US');
  const needle = normalizedQuery.toLocaleLowerCase('en-US');
  const matches = [];
  let offset = 0;
  while (matches.length < maxMatches) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    const start = Math.max(0, index - 300);
    const end = Math.min(normalizedText.length, index + normalizedQuery.length + 300);
    matches.push({
      start: index,
      end: index + normalizedQuery.length,
      snippet: normalizedText.slice(start, end),
    });
    offset = index + Math.max(1, normalizedQuery.length);
  }
  return matches;
}

export function exactQuoteMatch(text, quote) {
  const normalizedText = normalizeText(text);
  const normalizedQuote = normalizeText(quote);
  if (normalizedQuote.length < 12) throw new ValidationError('Evidence quote must contain at least 12 normalized characters');
  const index = normalizedText.indexOf(normalizedQuote);
  if (index < 0) return null;
  return { quote: normalizedQuote, start: index, end: index + normalizedQuote.length };
}
