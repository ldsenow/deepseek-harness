/** Browser pairing bootstrap: fragment adoption, storage republish, and privacy-mode containment. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { AUTH_STORAGE_KEY, bootstrapAuthToken } from '../src/client/auth.ts'
import { apply } from '../src/client/index.ts'

const TOKEN = 'browser-pairing-token_01234'

interface FakeGlobals {
  location?: { hash: string; pathname: string; search: string; hostname: string }
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void }
  document?: { cookie: string }
  history?: { replaceState(data: unknown, unused: string, url?: string): void }
}

const globals = globalThis as FakeGlobals

function fakeStorage(initial: Record<string, string> = {}): { data: Map<string, string>; storage: NonNullable<FakeGlobals['localStorage']> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    storage: {
      getItem: key => data.get(key) ?? null,
      setItem: (key, value) => { data.set(key, value) },
    },
  }
}

afterEach(() => {
  delete globals.location
  delete globals.localStorage
  delete globals.document
  delete globals.history
})

describe('bootstrapAuthToken', () => {
  it('is a no-op outside a browser (no location or no storage)', () => {
    expect(() => { bootstrapAuthToken() }).not.toThrow()
    globals.location = { hash: `#auth=${TOKEN}`, pathname: '/', search: '', hostname: '192.168.1.5' }
    expect(() => { bootstrapAuthToken() }).not.toThrow()
  })

  it('adopts the pairing fragment: stores, strips it, and sets the cookie', () => {
    const { data, storage } = fakeStorage()
    const replaced: string[] = []
    const doc = { cookie: '' }
    globals.location = { hash: `#auth=${TOKEN}`, pathname: '/app', search: '?fixture', hostname: '192.168.1.5' }
    globals.localStorage = storage
    globals.document = doc
    globals.history = { replaceState: (_data, _unused, url) => { replaced.push(String(url)) } }
    bootstrapAuthToken()
    expect(data.get(AUTH_STORAGE_KEY)).toBe(TOKEN)
    expect(replaced).toEqual(['/app?fixture'])
    expect(doc.cookie).toBe(`dsh_auth=${TOKEN}; path=/; SameSite=Strict`)
  })

  it('preserves unrelated fragment parameters when stripping the token', () => {
    const { storage } = fakeStorage()
    const replaced: string[] = []
    globals.location = { hash: `#tab=logs&auth=${TOKEN}`, pathname: '/', search: '', hostname: '192.168.1.5' }
    globals.localStorage = storage
    globals.history = { replaceState: (_data, _unused, url) => { replaced.push(String(url)) } }
    bootstrapAuthToken()
    expect(replaced).toEqual(['/#tab=logs'])
  })

  it('republishes a stored token as the cookie on a fragment-less boot', () => {
    const { storage } = fakeStorage({ [AUTH_STORAGE_KEY]: TOKEN })
    const doc = { cookie: '' }
    globals.location = { hash: '', pathname: '/', search: '', hostname: '192.168.1.5' }
    globals.localStorage = storage
    globals.document = doc
    bootstrapAuthToken()
    expect(doc.cookie).toContain(`dsh_auth=${TOKEN}`)
  })

  it('does nothing without a stored token, and survives missing history or document', () => {
    const { storage } = fakeStorage()
    const doc = { cookie: '' }
    globals.location = { hash: '', pathname: '/', search: '', hostname: '192.168.1.5' }
    globals.localStorage = storage
    globals.document = doc
    bootstrapAuthToken()
    expect(doc.cookie).toBe('')
    // A fragment with neither history nor document still stores the token.
    const second = fakeStorage()
    globals.location = { hash: `#auth=${TOKEN}`, pathname: '/', search: '', hostname: '192.168.1.5' }
    globals.localStorage = second.storage
    delete globals.document
    delete globals.history
    bootstrapAuthToken()
    expect(second.data.get(AUTH_STORAGE_KEY)).toBe(TOKEN)
  })
})

describe('connection client apply with auth bootstrap', () => {
  it('contains a privacy-mode storage denial and still mounts the handle', async () => {
    globals.location = { hash: `#auth=${TOKEN}`, pathname: '/', search: '', hostname: '192.168.1.5' }
    globals.localStorage = {
      getItem: () => { throw new Error('storage disabled') },
      setItem: () => { throw new Error('storage disabled') },
    }
    const ctx = new Context()
    await ctx.plugin({ apply, inject: [] })
    expect(ctx.get('connection')).toBeDefined()
  })
})
