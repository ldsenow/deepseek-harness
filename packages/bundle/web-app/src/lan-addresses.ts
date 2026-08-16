/**
 * The machine's non-internal IPv4 addresses, shared by the LAN trust fence and
 * the TLS certificate's subject alternative names. Its own module so the
 * `web-tls` row does not import the bundle entry — and its whole plugin graph —
 * to read one list.
 * @module @deepseek-ai/dsh-web-app/lan-addresses
 */

import { networkInterfaces } from 'node:os'

/**
 * Sample the host's LAN IPv4 literals.
 * @returns every non-internal IPv4 address currently configured, in interface order.
 */
export function lanIpv4Addresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((iface): iface is NonNullable<typeof iface> => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map(iface => iface.address)
}
