import Ajv from 'ajv'
import type { RouteDockManifest, PaymentMode } from '../types.js'
import {
  RouteDockError,
  RouteDockManifestError,
  RouteDockNoSupportedModeError,
  RouteDockClientVersionError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import schema from '../schemas/routedock.schema.json' assert { type: 'json' }
import pkg from '../../package.json' assert { type: 'json' }

const ajv = new Ajv()
const validateManifest = ajv.compile(schema)

const SDK_VERSION = pkg.version as string

interface CacheEntry {
  manifest: RouteDockManifest
  fetchedAt: number
}

const CACHE_TTL_MS = 60_000
const DEFAULT_MANIFEST_CACHE_MAX_SIZE = 512

class LruCache<K, V> {
  private map = new Map<K, V>()

  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey)
      }
    }
    this.map.set(key, value)
  }

  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
  }
}

const manifestCache = new LruCache<string, CacheEntry>(DEFAULT_MANIFEST_CACHE_MAX_SIZE)

export function configureManifestCache(maxSize: number): void {
  if (!Number.isInteger(maxSize) || maxSize <= 0) {
    throw new RouteDockManifestError('Invalid manifest cache size: ' + maxSize)
  }
  manifestCache.setMaxSize(maxSize)
}

function parseMajorMinor(version: string): [number, number] {
  const parts = version.split('.')
  const major = Number(parts[0])
  const minor = Number(parts[1])
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    throw new RouteDockManifestError('Invalid version string: ' + version)
  }
  return [major, minor]
}

function isVersionBelow(clientVersion: string, minVersion: string): boolean {
  const client = parseMajorMinor(clientVersion)
  const min = parseMajorMinor(minVersion)
  if (client[0] !== min[0]) return client[0] < min[0]
  return client[1] < min[1]
}

function assertClientVersionSupported(manifest: RouteDockManifest, baseUrl: string): void {
  if (!manifest.min_client_version) return
  if (isVersionBelow(SDK_VERSION, manifest.min_client_version)) {
    throw new RouteDockClientVersionError(
      'Provider at ' + baseUrl + ' requires SDK version ' + manifest.min_client_version +
      ' or higher (installed: ' + SDK_VERSION + '). Upgrade @routedock/sdk to continue.',
    )
  }
}

export interface ModeSelectOptions {
  sustained?: boolean
  session?: boolean
  forceMode?: PaymentMode
}

export async function fetchManifest(
  baseUrl: string,
  retryPolicy?: RetryPolicy,
): Promise<RouteDockManifest> {
  const cached = manifestCache.get(baseUrl)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    assertClientVersionSupported(cached.manifest, baseUrl)
    return cached.manifest
  }

  const url = baseUrl.replace(/\/$/, '') + '/.well-known/routedock.json'

  return withRetry(async () => {
    let raw: unknown
    try {
      const resp = await fetch(url)
      if (!resp.ok) {
        if (resp.status >= 500 || resp.status === 429 || resp.status === 503) {
          throw httpStatusToError(
            'Manifest fetch failed: HTTP ' + resp.status + ' from ' + url,
            resp.status,
            resp,
          )
        }
        throw new RouteDockManifestError(
          'Manifest fetch failed: HTTP ' + resp.status + ' from ' + url,
        )
      }
      raw = await resp.json()
    } catch (err) {
      if (err instanceof RouteDockError) throw err
      throw wrapFetchError(err, 'Manifest fetch error from ' + url)
    }

    if (!validateManifest(raw)) {
      const msgs = ajv.errorsText(validateManifest.errors)
      throw new RouteDockManifestError('Invalid manifest at ' + url + ': ' + msgs)
    }

    const manifest = raw as unknown as RouteDockManifest
    assertClientVersionSupported(manifest, baseUrl)
    manifestCache.set(baseUrl, { manifest, fetchedAt: Date.now() })
    return manifest
  }, retryPolicy)
}

export function selectMode(
  manifest: RouteDockManifest,
  options: ModeSelectOptions = {},
): PaymentMode {
  const modes = manifest.modes

  if (options.forceMode) {
    if (!modes.includes(options.forceMode)) {
      throw new RouteDockNoSupportedModeError(
        'Provider does not support forced mode: ' + options.forceMode +
        ' (available: ' + modes.join(', ') + ')',
      )
    }
    console.log('[RouteDock] ' + manifest.name + ' -> ' + options.forceMode + ' (forced)')
    return options.forceMode
  }

  if ((options.sustained || options.session) && modes.includes('mpp-session')) {
    const mode: PaymentMode = 'mpp-session'
    console.log('[RouteDock] ' + manifest.name + ' -> ' + mode)
    return mode
  }

  if (modes.includes('mpp-charge')) {
    const mode: PaymentMode = 'mpp-charge'
    console.log('[RouteDock] ' + manifest.name + ' -> ' + mode)
    return mode
  }

  if (modes.includes('x402')) {
    const mode: PaymentMode = 'x402'
    console.log('[RouteDock] ' + manifest.name + ' -> ' + mode)
    return mode
  }

  throw new RouteDockNoSupportedModeError(
    'No supported payment mode found in manifest (modes: ' + modes.join(', ') + ')',
  )
}
