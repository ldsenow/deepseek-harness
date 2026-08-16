/** Shared loopback-hostname semantics for the Host fence and browser UI. */

import { describe, expect, it } from 'vitest'
import { isLoopbackAddress, isLoopbackHostname } from '../src/index.ts'

describe('isLoopbackHostname', () => {
  it('accepts localhost, IPv6 loopback, and the whole IPv4 127/8 block', () => {
    for (const hostname of ['localhost', '[::1]', '127.0.0.1', '127.8.9.10', '127.255.255.255']) {
      expect(isLoopbackHostname(hostname)).toBe(true)
    }
  })

  it('refuses malformed and non-loopback hostnames', () => {
    for (const hostname of ['remote.localhost', '::1', '128.0.0.1', '127.0.0', '127.0.0.256', '127.0.0.-1']) {
      expect(isLoopbackHostname(hostname)).toBe(false)
    }
  })
})

describe('isLoopbackAddress', () => {
  it('accepts real loopback socket peers, including IPv4-mapped IPv6', () => {
    for (const address of ['127.0.0.1', '127.8.9.10', '127.255.255.255', '::1', '::ffff:127.0.0.1']) {
      expect([address, isLoopbackAddress(address)]).toEqual([address, true])
    }
  })

  it('refuses LAN peers, an absent peer, and IPv4-mapped non-loopback', () => {
    for (const address of [undefined, '192.168.1.5', '10.0.0.9', '::ffff:192.168.1.5', '128.0.0.1', '0.0.0.0']) {
      expect([address, isLoopbackAddress(address)]).toEqual([address, false])
    }
  })
})
