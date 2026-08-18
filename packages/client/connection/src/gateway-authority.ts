/**
 * Where a caller of each Typert Gateway namespace must be. The Gateway claims
 * every `namespace/method` pair a live `TypertRemoteService` exposes, so this
 * endpoint space grows whenever a package gains a `./typert` export — which is
 * why the classification is per namespace and the default is the strict one.
 * `verify-gateway-endpoint-authority` fails the build on a namespace absent
 * here, so a new Gateway service cannot reach paired devices unnoticed.
 * @module
 */

/** Where a namespace's callers must be: at the machine, or any paired device. */
export type GatewayAuthority = 'loopback' | 'paired'

/**
 * Every Typert Gateway namespace this repository exposes. `loopback` joins the
 * privileged endpoint set — reachable only from a genuine loopback socket peer,
 * authenticated or not; `paired` is reachable by any token-authenticated
 * caller. Classify a namespace whole: a method added to a `loopback` namespace
 * inherits the pin rather than defaulting open.
 */
export const GATEWAY_NAMESPACE_AUTHORITY = {
  // The live Loader roster is the same composition reconnaissance
  // `agentPreset.read` is pinned for; its settings tab is loopback-only too.
  pluginInventory: 'loopback',
  // The self-modification runtime: `inventory` reports every dynamic plugin
  // across all sessions, `invoke` and `runHostHalf` execute host code, and
  // `resolveRequestRun` answers the approval a person is being asked for. Each
  // is a local-user gesture, so none of them travels to a paired device.
  dynamicCordisRunner: 'loopback',
  // Session-scoped content a paired device is expected to drive: these are the
  // same authority as `session.create`, which pairing already grants.
  commands: 'paired',
  goals: 'paired',
  messageFeedback: 'paired',
} as const satisfies Record<string, GatewayAuthority>

/**
 * Whether a slash-form Gateway endpoint is pinned to a loopback peer. An
 * unclassified namespace counts as pinned: a Gateway service this build does
 * not know about must not become LAN-reachable by appearing.
 * @param namespace - the segment before the first `/` of an endpoint.
 * @returns true when only a loopback peer may call into the namespace.
 */
export function isLoopbackOnlyNamespace(namespace: string): boolean {
  const authority: GatewayAuthority | undefined =
    (GATEWAY_NAMESPACE_AUTHORITY as Record<string, GatewayAuthority>)[namespace]
  return authority !== 'paired'
}
