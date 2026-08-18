/** Node half: registers the /api prefix route bridging to the api gateway. */
import { EventEmitter, once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { API_PATH, apply, HOST_EVENTS_PATH, inject, MUX_EVENTS_PATH, type HostConnectionHandle } from '../src/index.ts'

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
/** A non-loopback peer literal: what the kernel reports for a real LAN client. */
const LAN_PEER = '192.168.1.5'

/**
 * Attach a fake socket whose remoteAddress drives the loopback-peer decision.
 * The admission fence reads this, never the Host header — default loopback so
 * existing local cases stay tokenless; remote cases pass a LAN literal.
 */
function withPeer(request: IncomingMessage, remoteAddress: string): IncomingMessage {
  Object.assign(request, { socket: { remoteAddress } })
  return request
}

function fakeRequest(headers: Record<string, string>, url = `${API_PATH}/session.list`, remoteAddress = '127.0.0.1'): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers })
  return withPeer(request, remoteAddress)
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(headers: Record<string, string>, url: string, body: unknown, remoteAddress = '127.0.0.1'): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers: { 'content-type': 'application/json', ...headers } })
  return withPeer(request, remoteAddress)
}

/** Raw POST for malformed-body and media-type boundary cases. */
function fakeRawPost(headers: Record<string, string>, url: string, body: string, remoteAddress = '127.0.0.1'): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers })
  return withPeer(request, remoteAddress)
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { state.status = value; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      else if (value !== undefined) throw new TypeError('fake response only accepts string or Uint8Array bodies')
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

/** The deployment pairing token every non-loopback request must present. */
const AUTH_TOKEN = 'unit-pairing-token_A-1234'
/** Reference the plugin resolves through the credentials seam. */
const TOKEN_REF = 'DSH_TEST_PAIRING_TOKEN'

/** Minimal credentials seam returning the deployment token for its one reference. */
function fakeCredentials(value = AUTH_TOKEN) {
  return { resolve: async (ref: string) => (ref === TOKEN_REF ? { value, source: 'environment' } : undefined) }
}

/** Headers of an authenticated request: the pairing cookie beside the caller's own headers. */
function authed(headers: Record<string, string>): Record<string, string> {
  return { cookie: `dsh_auth=${AUTH_TOKEN}`, ...headers }
}

async function mounted(config?: { trustedHosts?: string[]; pairingTokenEnv?: string }): Promise<{
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  ctx.provide('apiProxy', {} as unknown as ApiProxy)
  ctx.provide('credentials', fakeCredentials() as never)
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return { routes, upgrades, dispose: () => fiber.dispose() }
}

describe('connection node half', () => {
  it('fails loud when the carrier cap cannot hold the configured image batch', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    ctx.provide('apiProxy', {} as ApiProxy)
    await expect(apply(ctx, { maxRequestBodyBytes: 1024 }))
      .rejects.toThrow(/must be at least .* aggregate image limit/)
    expect(routes).toHaveLength(0)
  })

  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    ctx.provide('credentials', fakeCredentials() as never)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('registers one HTTP route plus one upgrade route per downlink and removes all three with the fiber', async () => {
    const { routes, upgrades, dispose } = await mounted()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
    expect(upgrades.map(route => route.path)).toEqual([MUX_EVENTS_PATH, HOST_EVENTS_PATH])
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('requires WebSocket upgrade for network GETs to either event path', async () => {
    const { routes, dispose } = await mounted()
    for (const path of [MUX_EVENTS_PATH, HOST_EVENTS_PATH]) {
      const { response, state } = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, path), response)
      expect(state.status).toBe(426)
      expect(state.body).toBe('upgrade required')
    }
    await dispose()
  })

  it('rejects an untrusted WebSocket upgrade before protocol negotiation', async () => {
    const { upgrades, dispose } = await mounted()
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }, MUX_EVENTS_PATH), socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { routes, dispose } = await mounted()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }), response)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    await dispose()
  })

  it('pins privileged methods to a loopback peer even for a declared, authenticated remote authority', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'], pairingTokenEnv: TOKEN_REF })
    // The privileged set: native dialogs plus the whole settings/credential
    // configuration plane, reads included, plus the one method that makes the
    // host fetch a caller-chosen URL. This remote authority (LAN peer) presents
    // the valid pairing token and reaches ordinary reads (carrier-level 404
    // from the empty proxy proves admission passed), but each privileged method
    // stays pinned to a loopback socket peer and 403s — the pin, not missing
    // authentication, is what denies.
    for (const method of [
      'host.pickDirectory', 'host.openPath',
      'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
      'credentials.describe', 'credentials.set', 'credentials.unset',
      'llm.discoverModels',
      // A composition names the plugins a session runs: reading one is
      // reconnaissance, and copy/remove/openDocument manage the roster and
      // drive the host desktop.
      'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
      // The Gateway's slash form shares the pin's namespace.
      'pluginInventory/list',
    ]) {
      const denied = fakeResponse()
      await routes[0]!.handler(
        fakeRequest(authed({ host: 'harness.example' }), `${API_PATH}/${method}`, LAN_PEER),
        denied.response,
      )
      expect(denied.state.status).toBe(403)
      expect(denied.state.body).toBe('forbidden')
    }
    const read = fakeResponse()
    await routes[0]!.handler(fakeRequest(authed({ host: 'harness.example' }), `${API_PATH}/session.list`, LAN_PEER), read.response)
    expect(read.state.status).not.toBe(403)
    // The same privileged method from a genuine loopback peer IS allowed
    // (404 from the empty proxy), tokenless — the local machine owns itself.
    const local = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, `${API_PATH}/settings.describe`), local.response)
    expect(local.state.status).toBe(404)
    await dispose()
  })

  it('pins a privileged endpoint an interceptor claims, so the pin does not depend on routing order', async () => {
    // A claimed endpoint never reaches the fallback, so a pin enforced there
    // would be escapable by an interceptor claiming the endpoint.
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    ctx.provide('credentials', fakeCredentials() as never)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'], pairingTokenEnv: TOKEN_REF })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const reached: string[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint.includes('/'),
      async (endpoint) => {
        reached.push(endpoint)
        return { ok: true, value: null }
      },
      { authority: 'trusted-host' },
    )
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const requestFor = (method: string): ClientRequest => ({
      type: 'client-request', rpcId: RpcId('rpc-pinned'), method, payload: {},
    })

    const denied = fakeResponse()
    await route.handler(
      fakePost(authed({ host: 'harness.example' }), '/api/pluginInventory/list', requestFor('pluginInventory/list'), LAN_PEER),
      denied.response,
    )
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    // Denial happens before dispatch, so the claimed handler never ran.
    expect(reached).toEqual([])

    // The pin denies one endpoint, not the channel.
    const allowed = fakeResponse()
    await route.handler(
      fakePost(authed({ host: 'harness.example' }), '/api/goals/create', requestFor('goals/create'), LAN_PEER),
      allowed.response,
    )
    expect(allowed.state.status).not.toBe(403)
    expect(reached).toEqual(['goals/create'])

    const local = fakeResponse()
    await route.handler(
      fakePost({ host: '127.0.0.1:3080' }, '/api/pluginInventory/list', requestFor('pluginInventory/list')),
      local.response,
    )
    expect(local.state.status).not.toBe(403)
    expect(reached).toEqual(['goals/create', 'pluginInventory/list'])

    await remove()
    await fiber.dispose()
  })

  it('pins every method of a loopback-only Gateway namespace, including ones no list names', async () => {
    // The Gateway claims any `namespace/method` a live TypertRemoteService
    // exposes, so a per-method pin leaves each newly added endpoint reachable
    // by any paired device. dynamicCordisRunner is the case that matters: it
    // reports every dynamic plugin across all sessions and runs host code.
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    ctx.provide('credentials', fakeCredentials() as never)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'], pairingTokenEnv: TOKEN_REF })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const reached: string[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint.includes('/'),
      async (endpoint) => {
        reached.push(endpoint)
        return { ok: true, value: null }
      },
      { authority: 'trusted-host' },
    )
    const route = routes.find(candidate => candidate.path === API_PATH)!

    for (const method of [
      'dynamicCordisRunner/inventory', 'dynamicCordisRunner/invoke',
      'dynamicCordisRunner/runHostHalf', 'dynamicCordisRunner/resolveRequestRun',
      'dynamicCordisRunner/aMethodAddedLater',
      // An unknown namespace fails closed rather than defaulting LAN-reachable.
      'somethingUnclassified/read',
    ]) {
      const denied = fakeResponse()
      await route.handler(
        fakePost(authed({ host: 'harness.example' }), `/api/${method}`, {
          type: 'client-request', rpcId: RpcId('rpc-ns'), method, payload: {},
        }, LAN_PEER),
        denied.response,
      )
      expect([method, denied.state.status]).toEqual([method, 403])
    }
    // Denied before dispatch, every one of them.
    expect(reached).toEqual([])

    // The same namespace answers a genuine loopback peer.
    const local = fakeResponse()
    await route.handler(
      fakePost({ host: '127.0.0.1:3080' }, '/api/dynamicCordisRunner/inventory', {
        type: 'client-request', rpcId: RpcId('rpc-ns-local'), method: 'dynamicCordisRunner/inventory', payload: {},
      }),
      local.response,
    )
    expect(local.state.status).not.toBe(403)
    expect(reached).toEqual(['dynamicCordisRunner/inventory'])

    await remove()
    await fiber.dispose()
  })

  it('passes loopback tokenless and admits declared authorities only with the pairing token', async () => {
    const { routes, upgrades, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'], pairingTokenEnv: TOKEN_REF })
    // Loopback, no browser markers and no token (curl shape): the fence
    // passes; the carrier answers 404 for a GET unary path — proof the bridge ran.
    const loopback = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }), loopback.response)
    expect(loopback.state.status).toBe(404)
    // An all-interfaces composition derives port-less LAN IP literals; a
    // remote (LAN) peer presenting the pairing cookie is admitted on any port.
    const lan = fakeResponse()
    await routes[0]!.handler(fakeRequest(authed({ host: '192.168.1.5:3080' }), `${API_PATH}/session.list`, LAN_PEER), lan.response)
    expect(lan.state.status).toBe(404)
    // The same LAN authority without the token stops at the admission fence,
    // on the HTTP route and the WebSocket upgrade alike.
    const anonymous = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '192.168.1.5:3080' }, `${API_PATH}/session.list`, LAN_PEER), anonymous.response)
    expect(anonymous.state).toMatchObject({ status: 403, body: 'forbidden' })
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(fakeRequest({ host: '192.168.1.5:3080' }, MUX_EVENTS_PATH, LAN_PEER), socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    // A wrong token is refused like a missing one.
    const wrong = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '192.168.1.5:3080', cookie: 'dsh_auth=not-the-configured-token' }, `${API_PATH}/session.list`, LAN_PEER), wrong.response)
    expect(wrong.state.status).toBe(403)
    // SECURITY REGRESSION: a remote peer forging a loopback Host must NOT be
    // admitted tokenless — loopback trust is the socket peer, not the header.
    for (const forged of ['127.0.0.1:3080', 'localhost:3080', '[::1]:3080']) {
      const spoof = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: forged }, `${API_PATH}/session.list`, LAN_PEER), spoof.response)
      expect([forged, spoof.state.status]).toEqual([forged, 403])
    }
    // The same forged loopback Host on the WebSocket upgrade is rejected too.
    const wsSocket = new PassThrough()
    const wsChunks: Buffer[] = []
    wsSocket.on('data', (chunk: Buffer) => { wsChunks.push(chunk) })
    const wsEnded = once(wsSocket, 'end')
    await upgrades[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, MUX_EVENTS_PATH, LAN_PEER), wsSocket, Buffer.alloc(0))
    await wsEnded
    expect(Buffer.concat(wsChunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    // Declared public authority, same-origin browser shape, Bearer form (the
    // non-browser client path), from a remote peer.
    const declared = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example:3080', origin: 'http://harness.example:3080', 'sec-fetch-site': 'same-origin',
      authorization: `Bearer ${AUTH_TOKEN}`,
    }, `${API_PATH}/session.list`, LAN_PEER), declared.response)
    expect(declared.state.status).toBe(404)
    await dispose()
  })

  it.each([
    ['a reference the credential store cannot resolve', { pairingTokenEnv: 'DSH_ABSENT' }, fakeCredentials(), /holds no value/],
    ['a resolved token that is too weak to guard the network', { pairingTokenEnv: TOKEN_REF }, fakeCredentials('short'), /pairingToken must be at least 16 characters/],
    ['trusted authorities named without any reference', { trustedHosts: ['harness.example'] }, fakeCredentials(), /trustedHosts requires pairingTokenEnv/],
    ['a reference with no credentials service to resolve it', { pairingTokenEnv: TOKEN_REF }, undefined, /needs the credentials service/],
  ])('fails the load on %s', async (_case, config, credentials, message) => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    if (credentials !== undefined) ctx.provide('credentials', credentials as never)
    await expect(ctx.plugin({ inject: [...inject], apply }, config)).rejects.toThrow(message)
    expect(routes).toHaveLength(0)
  })

  it('provides a disposable dedicated RPC channel without requiring apiProxy', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })

    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.handle('/rpc', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { accepted: true } }
    }, { authority: 'trusted-host' })
    const route = routes.find(candidate => candidate.path === '/rpc')
    expect(route).toBeDefined()

    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-dedicated'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }
    const result = fakeResponse()
    await route!.handler(fakePost({ host: '127.0.0.1:3080' }, '/rpc/goals/create', request), result.response)
    expect(result.state.status).toBe(200)
    expect(JSON.parse(String(result.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-dedicated',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    expect(() => connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
    })).toThrow(/duplicate route/)
    await remove()
    expect(routes.map(candidate => candidate.path)).toEqual([API_PATH])
    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })

  it('dispatches claimed /api endpoints before the API Proxy fallback and withdraws the claim', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    ctx.provide('credentials', fakeCredentials() as never)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'], pairingTokenEnv: TOKEN_REF })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        return { ok: true, value: { accepted: true } }
      },
      { authority: 'trusted-host' },
    )
    expect(() => connection.rpc.intercept(
      '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('already has an interceptor')
    expect(() => connection.rpc.intercept(
      '/rpc' as '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('invalid shared RPC channel')
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-shared'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }

    const claimed = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), claimed.response)
    expect(JSON.parse(String(claimed.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-shared',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/api/goals/create', request), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls).toHaveLength(1)

    const unclaimed = fakeResponse()
    await route.handler(fakeRequest({ host: '127.0.0.1:3080' }, '/api/session.list'), unclaimed.response)
    expect(unclaimed.state.status).toBe(404)

    await remove()
    const withdrawn = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), withdrawn.response)
    expect(withdrawn.state.status).toBe(404)
    expect(calls).toHaveLength(1)

    const removeLoopback = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async () => ({ ok: true, value: null }),
      { authority: 'loopback' },
    )
    // A remote peer with a valid pairing token still cannot reach a
    // loopback-pinned interceptor — the pin is the socket peer, not the token.
    const loopbackOnly = fakeResponse()
    await route.handler(fakePost(authed({ host: 'harness.example' }), '/api/goals/create', request, LAN_PEER), loopbackOnly.response)
    expect(loopbackOnly.state.status).toBe(403)
    await removeLoopback()
    await fiber.dispose()
  })

  it('applies the configured trust fence and JSON envelope checks to generic channels', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('credentials', fakeCredentials() as never)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'], pairingTokenEnv: TOKEN_REF })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const remove = connection.rpc.handle('/rpc', async (endpoint) => {
      if (endpoint === 'fail') throw new Error('handler broke')
      return { ok: true, value: null }
    }, {
      authority: 'trusted-host',
    })
    const route = routes.find(candidate => candidate.path === '/rpc')!

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/rpc/goals/create', {}), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })

    const anonymous = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', {}, LAN_PEER), anonymous.response)
    expect(anonymous.state).toMatchObject({ status: 403, body: 'forbidden' })

    const methodMismatch = fakeResponse()
    await route.handler(fakePost(authed({ host: 'harness.example' }), '/rpc/goals/create', {
      type: 'client-request', rpcId: 'rpc-bad', method: 'other', payload: {},
    }), methodMismatch.response)
    expect(JSON.parse(String(methodMismatch.state.body))).toMatchObject({
      rpcId: 'rpc-bad',
      result: { ok: false, error: { code: 'bad-request' } },
    })

    for (const [request, status] of [
      [fakeRequest(authed({ host: 'harness.example' }), '/rpc/goals/create'), 404],
      [fakePost(authed({ host: 'harness.example' }), '/outside/goals/create', {}), 404],
      [fakePost(authed({ host: 'harness.example' }), '/rpc/goals//create', {}), 404],
      [fakeRawPost(authed({ host: 'harness.example' }), '/rpc/goals/create', '{}'), 415],
      [fakeRawPost(authed({ host: 'harness.example', 'content-type': 'text/plain' }), '/rpc/goals/create', '{}'), 415],
      [fakeRawPost(authed({ host: 'harness.example', 'content-type': 'application/json; charset=utf-8' }), '/rpc/goals/create', '{'), 400],
    ] as const) {
      const response = fakeResponse()
      await route.handler(request, response.response)
      expect(response.state.status).toBe(status)
    }

    for (const [body, rpcId] of [
      [{ rpcId: 'retained-id' }, 'retained-id'],
      [{ rpcId: 42 }, 'invalid-request'],
      [null, 'invalid-request'],
    ] as const) {
      const response = fakeResponse()
      await route.handler(fakePost(authed({ host: 'harness.example' }), '/rpc/goals/create', body), response.response)
      expect(JSON.parse(String(response.state.body))).toMatchObject({
        rpcId,
        result: { ok: false, error: { code: 'bad-request' } },
      })
    }

    const failed = fakeResponse()
    await route.handler(fakePost(authed({ host: 'harness.example' }), '/rpc/fail', {
      type: 'client-request', rpcId: 'rpc-fail', method: 'fail', payload: {},
    }), failed.response)
    expect(failed.state).toMatchObject({ status: 500, body: 'handler failure: Error: handler broke' })

    expect(() => connection.rpc.handle('/api', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')
    expect(() => connection.rpc.handle('api3', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')

    const removeLoopback = connection.rpc.handle('/loopback', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })
    const loopbackRoute = routes.find(candidate => candidate.path === '/loopback')!
    // The valid pairing token does not soften a loopback-authority channel.
    const publicResponse = fakeResponse()
    await loopbackRoute.handler(fakePost(authed({ host: 'harness.example' }), '/loopback/read', {
      type: 'client-request', rpcId: 'rpc-public', method: 'read', payload: {},
    }), publicResponse.response)
    expect(publicResponse.state.status).toBe(403)
    await removeLoopback()
    await remove()
    await fiber.dispose()
  })
})

describe('connection node half over a real HTTP server', () => {
  /** Serve the registered prefix route from a real server and return its port. */
  async function serve(routes: WebRoute[]): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      void routes[0]!.handler(request, response)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      }),
    }
  }

  /** One real request; `host` is the Host header, `headers` any extras. */
  function call(port: number, method: string, host: string, headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: `${API_PATH}/${method}`, method: 'GET', headers: { host, ...headers } },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  it('admits a genuine loopback peer tokenless and still defends it against rebinding, over real HTTP', async () => {
    // The admission input is a real IncomingMessage whose socket the kernel
    // filled: connecting over 127.0.0.1 makes req.socket.remoteAddress a real
    // loopback address, so this asserts the socket-derived loopback decision the
    // server actually performs — not a hand-set peer. A loopback peer owns the
    // machine, so it reaches everything tokenless, privileged plane included.
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'], pairingTokenEnv: TOKEN_REF })
    const { port, close } = await serve(routes)
    const loopbackHost = `127.0.0.1:${String(port)}`
    try {
      // Privileged, catalog, and ordinary methods all reach the empty proxy's
      // 404 carrier answer — a real loopback peer is admitted without a token.
      for (const method of [
        'settings.describe', 'credentials.describe', 'host.openPath', 'llm.discoverModels',
        'agentPreset.read', 'llm.providers', 'session.list',
      ]) {
        expect([method, await call(port, method, loopbackHost)]).toEqual([method, 404])
      }
      // Rebinding defense still binds a loopback-peer browser: an untrusted
      // Host (attacker's rebound domain) is refused even from a loopback peer.
      expect(await call(port, 'session.list', 'evil.example')).toBe(403)
      // A cross-site marker is refused too, loopback peer notwithstanding.
      expect(await call(port, 'session.list', loopbackHost, { 'sec-fetch-site': 'cross-site' })).toBe(403)
    } finally {
      await close()
      await dispose()
    }
  })
})
