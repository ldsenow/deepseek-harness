/**
 * Browser-safe, zero-dependency loopback classification shared by the `/api`
 * Host fence and the package's `ctx.connection` state. The predicate stays
 * package-internal; client plugins consume the derived state through Cordis.
 */

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIpv4Loopback(hostname)
}

/** Whether a dotted-quad literal falls in IPv4 `127.0.0.0/8`. */
function isIpv4Loopback(literal: string): boolean {
  const parts = literal.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a socket peer address (`req.socket.remoteAddress`) is the loopback
 * interface: IPv4 `127.0.0.0/8`, IPv6 `::1`, or an IPv4-mapped loopback
 * (`::ffff:127.x.x.x`). Unlike {@link isLoopbackHostname}, this reads the real
 * connection origin the kernel reports, which a client cannot forge — the
 * tokenless loopback exemption and the privileged-method pin depend on it, not
 * on the client-supplied `Host` header. An undefined address (no socket, a
 * non-IP transport) is not loopback, so it fails closed to token-required.
 * @param address - the socket's remote address, or undefined.
 * @returns true only for a genuine loopback peer.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1') return true
  return isIpv4Loopback(address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address)
}
