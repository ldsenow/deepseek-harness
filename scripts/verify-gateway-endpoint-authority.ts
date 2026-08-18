/**
 * Gate: every Typert Gateway namespace carries an explicit reachability
 * classification.
 *
 * The Gateway claims any `namespace/method` pair a live `TypertRemoteService`
 * exposes, and `dsh-client-connection` decides per namespace whether a caller
 * must be a loopback peer. That endpoint space grows whenever a package gains a
 * `./typert` export, so an unclassified namespace is a silent reachability
 * decision — this gate turns it into a build failure. The runtime already fails
 * closed (an unknown namespace is treated as loopback-only); the gate exists so
 * the choice is made deliberately rather than inherited.
 * @module
 */

import { readFile } from 'node:fs/promises'
import { glob } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AUTHORITY_MODULE = 'packages/client/connection/src/gateway-authority.ts'
/** `super(ctx, 'namespace')` in a TypertRemoteService subclass. */
const NAMESPACE_PATTERN = /super\(\s*ctx\s*,\s*'([A-Za-z][A-Za-z0-9]*)'/
/** The table's body, so its entries are read rather than imported: the client
 * face this module belongs to is excluded from the host program this gate
 * compiles under, and a gate must not straddle the two. */
const TABLE_PATTERN = /export const GATEWAY_NAMESPACE_AUTHORITY = \{([\s\S]*?)\n\} as const/
/** One `namespace: 'authority',` entry inside that body. */
const ENTRY_PATTERN = /^\s*([A-Za-z][A-Za-z0-9]*):\s*'(loopback|paired)',/gm

/**
 * Read the classified namespaces from the authority module's source.
 * @returns namespace to declared authority.
 */
async function readClassifiedNamespaces(): Promise<Map<string, string>> {
  const source = await readFile(join(ROOT, AUTHORITY_MODULE), 'utf8')
  const body = TABLE_PATTERN.exec(source)?.[1]
  if (body === undefined) {
    throw new Error(`${AUTHORITY_MODULE}: could not find the GATEWAY_NAMESPACE_AUTHORITY table this gate reads`)
  }
  const entries = new Map<string, string>()
  for (const [, namespace, declared] of body.matchAll(ENTRY_PATTERN)) {
    if (namespace !== undefined && declared !== undefined) entries.set(namespace, declared)
  }
  return entries
}

/** One package exposing a Gateway namespace. */
interface GatewayPackage {
  /** Repo-relative package directory. */
  directory: string
  /** The namespace its service registers, when one was found. */
  namespace: string | undefined
}

/**
 * Find every workspace package whose package.json declares a `./typert` export
 * and read the namespace its `TypertRemoteService` subclass registers.
 * @returns one entry per Gateway-exposing package.
 */
async function collectGatewayPackages(): Promise<GatewayPackage[]> {
  const found: GatewayPackage[] = []
  for await (const manifestPath of glob('packages/*/*/package.json', { cwd: ROOT })) {
    const manifest = await readFile(join(ROOT, manifestPath), 'utf8')
    if (!manifest.includes('"./typert"')) continue
    const directory = dirname(manifestPath)
    found.push({ directory, namespace: await readNamespace(join(ROOT, directory, 'src')) })
  }
  return found.sort((left, right) => left.directory.localeCompare(right.directory))
}

/**
 * Read the namespace a package's remote service registers.
 * @param sourceDirectory - absolute path of the package's `src`.
 * @returns the namespace, or undefined when no subclass constructor names one.
 */
async function readNamespace(sourceDirectory: string): Promise<string | undefined> {
  for await (const entry of glob('**/*.ts', { cwd: sourceDirectory })) {
    const source = await readFile(join(sourceDirectory, entry), 'utf8')
    if (!source.includes('TypertRemoteService')) continue
    const match = NAMESPACE_PATTERN.exec(source)
    if (match !== null) return match[1]
  }
  return undefined
}

const packages = await collectGatewayPackages()
const authority = await readClassifiedNamespaces()
const problems: string[] = []
const classified = new Set(authority.keys())

for (const { directory, namespace } of packages) {
  if (namespace === undefined) {
    problems.push(`${directory} exports ./typert but no TypertRemoteService subclass names a namespace`)
    continue
  }
  classified.delete(namespace)
  if (authority.has(namespace)) continue
  problems.push(
    `${directory} exposes the Gateway namespace "${namespace}", which ${AUTHORITY_MODULE} does not classify.\n`
    + `    Add "${namespace}" to GATEWAY_NAMESPACE_AUTHORITY as 'loopback' (only a caller at the machine may reach it)\n`
    + "    or 'paired' (any token-authenticated device may reach it). Until then it is treated as 'loopback'.",
  )
}

for (const stale of classified) {
  problems.push(`${AUTHORITY_MODULE} classifies "${stale}", which no package exposes — remove the entry`)
}

if (problems.length > 0) {
  console.error('verify-gateway-endpoint-authority: Gateway namespaces are not fully classified:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`verify-gateway-endpoint-authority: ${String(packages.length)} Gateway namespace(s) classified.`)
