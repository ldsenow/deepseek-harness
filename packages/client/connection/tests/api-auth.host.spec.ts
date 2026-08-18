/** Pairing-token admission: token format, presentation forms, and socket-peer trust. */
import { describe, expect, it } from 'vitest'
import { admitApiRequest, assertPairingToken } from '../src/api-auth.ts'

const TOKEN = 'pairing-token_0123456789-ab'
const TRUSTED = ['harness.example', '192.168.1.5']

function request(headers: Record<string, string>): { headers: Record<string, string> } {
  return { headers }
}

describe('assertPairingToken', () => {
  it('accepts 16+ characters of the URL/cookie/shell-safe alphabet', () => {
    expect(() => { assertPairingToken('A-Za-z0-9_-16chr') }).not.toThrow()
    expect(() => { assertPairingToken(TOKEN) }).not.toThrow()
  })

  it.each([
    ['too short', 'only15chars_ab-'],
    ['cookie-breaking punctuation', 'token;with=bad,chars****'],
    ['whitespace', 'token with spaces padding'],
    ['non-ASCII', 'token-ünïcode-0123456789'],
    ['empty', ''],
  ])('rejects %s loudly', (_kind, token) => {
    expect(() => { assertPairingToken(token) }).toThrow(/pairingToken must be at least 16 characters of A-Za-z0-9_-/)
  })
})

describe('admitApiRequest', () => {
  it('admits a loopback peer without any token, configured or presented', () => {
    expect(admitApiRequest(request({ host: '127.0.0.1:3080' }), TRUSTED, TOKEN, true)).toBe(true)
    expect(admitApiRequest(request({ host: 'localhost:3080' }), [], undefined, true)).toBe(true)
  })

  it('refuses a non-loopback peer forging a loopback Host (the token-bypass regression)', () => {
    // A LAN attacker reaches the socket and claims Host: 127.0.0.1. The Host
    // fence passes it (loopback-looking), but the peer is not loopback and no
    // token is presented — admission must refuse.
    for (const host of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080']) {
      expect([host, admitApiRequest(request({ host }), TRUSTED, TOKEN, false)]).toEqual([host, false])
    }
  })

  it('refuses a fence-rejected authority no matter the peer or token', () => {
    expect(admitApiRequest(
      request({ host: 'evil.example', authorization: `Bearer ${TOKEN}` }),
      TRUSTED,
      TOKEN,
      false,
    )).toBe(false)
    // Even a loopback peer is refused when the Host fails the rebinding fence.
    expect(admitApiRequest(request({ host: 'evil.example' }), TRUSTED, TOKEN, true)).toBe(false)
  })

  it('refuses an explicit cross-site marker even with a valid token', () => {
    expect(admitApiRequest(
      request({ host: 'harness.example', 'sec-fetch-site': 'cross-site', authorization: `Bearer ${TOKEN}` }),
      TRUSTED,
      TOKEN,
      false,
    )).toBe(false)
  })

  it('refuses every non-loopback-peer request when no token is configured', () => {
    expect(admitApiRequest(request({ host: 'harness.example' }), TRUSTED, undefined, false)).toBe(false)
    expect(admitApiRequest(
      request({ host: 'harness.example', authorization: `Bearer ${TOKEN}` }),
      TRUSTED,
      undefined,
      false,
    )).toBe(false)
  })

  it('refuses a non-loopback peer without a presented token', () => {
    expect(admitApiRequest(request({ host: '192.168.1.5:3080' }), TRUSTED, TOKEN, false)).toBe(false)
  })

  it('admits the pairing cookie from a non-loopback peer, including among other cookies and with spacing', () => {
    expect(admitApiRequest(request({ host: '192.168.1.5:3080', cookie: `dsh_auth=${TOKEN}` }), TRUSTED, TOKEN, false)).toBe(true)
    expect(admitApiRequest(request({
      host: 'harness.example',
      cookie: `theme=dark; dsh_auth=${TOKEN} ; sid=abc`,
    }), TRUSTED, TOKEN, false)).toBe(true)
  })

  it('admits the Bearer authorization form and works over Fetch Headers', () => {
    expect(admitApiRequest(
      { headers: new Headers({ host: 'harness.example', authorization: `Bearer ${TOKEN}` }) },
      TRUSTED,
      TOKEN,
      false,
    )).toBe(true)
  })

  it('refuses wrong tokens, other authorization schemes, and malformed cookie pairs', () => {
    expect(admitApiRequest(request({ host: 'harness.example', cookie: 'dsh_auth=wrong-token-0123456789' }), TRUSTED, TOKEN, false)).toBe(false)
    expect(admitApiRequest(request({ host: 'harness.example', authorization: `Basic ${TOKEN}` }), TRUSTED, TOKEN, false)).toBe(false)
    expect(admitApiRequest(request({ host: 'harness.example', cookie: 'no-separator; other=1' }), TRUSTED, TOKEN, false)).toBe(false)
  })

  it.each([
    ['a name the cookie name is a prefix of', `dsh_auth_extra=${TOKEN}`],
    ['a name ending in the cookie name', `xdsh_auth=${TOKEN}`],
    ['the token as some other cookie value', `session=${TOKEN}`],
    ['the token as a cookie name', `${TOKEN}=1`],
    ['an empty pairing cookie', 'dsh_auth='],
  ])('refuses %s', (_kind, cookie) => {
    // The cookie name is compared whole, so a neighbouring name carrying a
    // valid token never satisfies it — the parser bug that turns a substring
    // test into an authentication bypass.
    expect(admitApiRequest(request({ host: 'harness.example', cookie }), TRUSTED, TOKEN, false)).toBe(false)
  })

  it('admits a valid pairing cookie sent alongside an invalid one', () => {
    // A browser can hold duplicates for the same name across paths or a stale
    // domain, and sends them all; a rotated-but-not-yet-evicted value must not
    // lock out the device whose current value is right.
    expect(admitApiRequest(request({
      host: 'harness.example',
      cookie: `dsh_auth=stale-token-0123456789; dsh_auth=${TOKEN}`,
    }), TRUSTED, TOKEN, false)).toBe(true)
  })

  it('refuses a token presented under a lowercase Bearer scheme', () => {
    // RFC 7235 makes the auth-scheme case-insensitive, so this is stricter than
    // the spec. It is pinned rather than fixed silently: the shipped browser
    // half sends `Bearer`, and loosening an auth parser is its own decision.
    expect(admitApiRequest(request({ host: 'harness.example', authorization: `bearer ${TOKEN}` }), TRUSTED, TOKEN, false)).toBe(false)
  })
})
