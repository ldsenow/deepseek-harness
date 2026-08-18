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

  it('refuses names that only lead with or contain the loopback literal', () => {
    // A hostname reaches this predicate from a client-supplied authority, so a
    // name an attacker registers must not pass on a prefix or suffix match.
    for (const hostname of ['', '127.0.0.1.evil.com', 'evil.com.127.0.0.1', 'x127.0.0.1', '[::ffff:127.0.0.1]']) {
      expect([hostname, isLoopbackHostname(hostname)]).toEqual([hostname, false])
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

  it('fails closed on loopback spellings it does not canonicalize', () => {
    // These all denote loopback to some resolver, and none is a form node
    // reports in `remoteAddress`. Reading them as non-loopback costs a paired
    // device nothing (it presents a token); reading any of them as loopback
    // would hand out the tokenless exemption and the privileged-method pin.
    for (const address of [
      '::FFFF:127.0.0.1', // uppercase mapped prefix: the prefix test is case-sensitive
      '::ffff:7f00:1', //    the same mapped address written in hex
      '2130706433', //       32-bit integer form of 127.0.0.1
      '127.1', //            short form curl and ping accept
      '0127.0.0.1', //       zero-padded, read as octal by some parsers
      '127.0.0.01', //       zero-padded final octet
      '127.000.000.001', //  every octet zero-padded
      '::ffff:127.0.0.1%eth0', // zone-id suffix
      ' 127.0.0.1', //       leading space
      '127.0.0.1 ', //       trailing space
      '', //                 empty peer
    ]) {
      expect([address, isLoopbackAddress(address)]).toEqual([address, false])
    }
  })
})
