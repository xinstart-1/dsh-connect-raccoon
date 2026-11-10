#!/usr/bin/env node
/**
 * Read-only reconnaissance for 商汤小浣熊 desktop credentials on this machine.
 *
 * Answers six questions without touching anything it inspects:
 *   1. Where does the app resolve its credential directory, and does the file exist?
 *   2. Is the desktop client installed at all?
 *   3. What other credential shapes exist (Electron asar / Local Storage / Cookies)?
 *   4. What is the key structure of `auth.json`, and are its tokens JWTs?
 *   5. Can more than one account coexist?
 *   6. Does the third-party `agent2api.db` import source exist, and what is in it?
 *
 * Guarantees, and they are load-bearing:
 *   - never writes, renames, deletes or chmods any file;
 *   - never opens a network socket — no fetch, no http, no dns;
 *   - never prints a token, cookie, phone number or any other secret value.
 *     Token fields are reported as length plus JWT claims *names* and `exp`/`iat`
 *     only; claim values are deliberately discarded.
 *
 * Zero dependencies: Node built-ins only. Node 22.5+ for the optional
 * `node:sqlite` branch; everything else degrades gracefully on older runtimes.
 *
 * Usage:
 *   node tools/probe-desktop-creds.mjs            # human-readable report
 *   node tools/probe-desktop-creds.mjs --json     # machine-readable report
 *   node tools/probe-desktop-creds.mjs --json --no-registry   # skip reg.exe
 *
 * @module tools/probe-desktop-creds
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Contract constants, mirrored from dsh-raccoon-connect@0.2.4 lib/index.js
// (RACCOON_PRIMARY). Kept literal on purpose: the probe must be able to report
// a mismatch between these and what is actually on disk.
// ---------------------------------------------------------------------------

/** The app's own key order. A write-back must preserve exactly this. */
const DESKTOP_TOKEN_KEYS = [
  'access_token',
  'refresh_token',
  'office_identity',
  'office_org_name',
  'office_org_role',
]

/** Access-token aliases the app's own reader accepts. */
const ACCESS_TOKEN_ALIASES = ['access_token', 'token', 'auth_token']

/** Directory holding the credential file, relative to the home directory. */
const CONFIG_DIR_REL = ['.box-agent', 'config']

/** Names that would indicate the desktop client on disk or in the registry. */
const INSTALL_HINTS = [
  'raccoon',
  'xiaohuan',
  'sensetime',
  '商汤',
  '小浣熊',
  'box-agent',
  'boxagent',
  'raccoonwork',
]

/** Longest string we will echo; prefixes are only shown for non-secret fields. */
const MAX_TREE_DEPTH = 6

/** A value that looks like a bearer token / secret, so it is never echoed. */
const SECRET_KEY_PATTERN = /token|secret|cookie|password|passwd|credential|session|jwk|key$/i
/** Keys whose values are safe to echo in full. */
const SAFE_VALUE_KEYS = /^(exp|iat|nbf|version|format|type|alg|typ|kid|iss|aud|sub_type|provider|enabled)$/i

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Run a command without a shell; returns stdout or undefined on any failure. */
function runCommand(file, args, timeout = 20_000) {
  try {
    const result = spawnSync(file, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      shell: false,
      maxBuffer: 8 * 1024 * 1024,
    })
    if (result.error !== undefined || result.status !== 0) return null
    return result.stdout ?? ''
  } catch {
    return null
  }
}

/** `stat` that reports absence as undefined instead of throwing. */
async function statOrUndefined(target) {
  try {
    return await stat(target)
  } catch {
    return undefined
  }
}

/** Base64url-decode one JWT segment. Returns undefined when it is not JSON. */
function decodeSegment(segment) {
  if (typeof segment !== 'string' || segment === '') return undefined
  try {
    const padded = segment.replace(/-/gu, '+').replace(/_/gu, '/')
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** Epoch seconds -> ISO string, tolerating seconds/ms/fractional-seconds claims. */
function isoFromEpochSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  // Guard against a millisecond-typed claim masquerading as seconds.
  const ms = value > 1e11 ? value : value * 1000
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

/**
 * Describe a JWT without leaking it.
 *
 * Only the algorithm/type header, the *names* of the payload claims, and the
 * two timing claims are returned. `name`, `phone`, `sid`, `sub` and everything
 * else are reduced to booleans — the caller only needs to know they are there.
 */
function describeJwt(value) {
  if (typeof value !== 'string') return { isJwt: false }
  const segments = value.split('.')
  if (segments.length !== 3) return { isJwt: false, segments: segments.length }

  const header = decodeSegment(segments[0])
  const payload = decodeSegment(segments[1])
  const facts = {
    isJwt: true,
    length: value.length,
    header: header === undefined
      ? undefined
      : { alg: header.alg, typ: header.typ, kidPresent: header.kid !== undefined },
    claimNames: payload === undefined ? [] : Object.keys(payload).sort(),
    unparsable: payload === undefined,
  }

  if (payload !== undefined) {
    const exp = isoFromEpochSeconds(payload.exp)
    const iat = isoFromEpochSeconds(payload.iat)
    if (exp !== undefined) {
      facts.exp = exp
      facts.expiresInSeconds = Math.round((new Date(exp).getTime() - Date.now()) / 1000)
    }
    if (iat !== undefined) {
      facts.iat = iat
      facts.issuedAt = iat
    }
    // Presence booleans for the privacy-bearing claims; values never copied.
    facts.hasName = typeof payload.name === 'string'
    facts.hasPhone = typeof payload.phone === 'string'
    facts.hasSid = typeof payload.sid === 'string'
    facts.hasSub = typeof payload.sub === 'string'
    facts.hasIss = typeof payload.iss === 'string'
  }

  return facts
}

/**
 * Detect an encrypted envelope, e.g. `{"$safeStorageEncrypted":1,"envelope":"…"}`.
 *
 * The app's own auth.json is expected to be plaintext; an envelope here means a
 * future build moved to OS-keychain-backed encryption and the read path breaks.
 */
function detectEnvelope(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const keys = Object.keys(value)
  const marker = keys.find(key => /^\$.*encrypted$/i.test(key))
  const hasEnvelope = keys.some(key => /^(envelope|ciphertext|data|payload|iv|tag|salt|nonce)$/i.test(key))
  if (marker === undefined && !hasEnvelope) return undefined
  return { markerKeys: keys.filter(key => /^\$/.test(key)), envelopeKeys: keys, encrypted: true }
}

/**
 * Build a redacted structural view of a JSON document.
 *
 * Strings are summarised by length and character class rather than echoed, so a
 * token or a phone number cannot reach the report by accident. Only keys in
 * {@link SAFE_VALUE_KEYS} get their values printed.
 */
function describeNode(value, key, depth) {
  if (depth > MAX_TREE_DEPTH) return { type: 'truncated' }

  if (value === null) return { type: 'null' }

  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      items: depth >= MAX_TREE_DEPTH
        ? undefined
        : value.slice(0, 3).map(item => describeNode(item, undefined, depth + 1)),
    }
  }

  if (typeof value === 'object') {
    const envelope = detectEnvelope(value)
    const node = {
      type: 'object',
      keys: Object.keys(value),
      children: depth >= MAX_TREE_DEPTH
        ? undefined
        : Object.fromEntries(
          Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            describeNode(childValue, childKey, depth + 1),
          ]),
        ),
    }
    if (envelope !== undefined) node.envelope = envelope
    return node
  }

  if (typeof value === 'string') {
    const node = {
      type: 'string',
      length: value.length,
      empty: value.trim() === '',
    }
    const jwt = describeJwt(value)
    if (jwt.isJwt) {
      node.jwt = jwt
      return node
    }
    if (key !== undefined && SAFE_VALUE_KEYS.test(key) && value.length <= 64) {
      node.value = value
      return node
    }
    // Shape only: no prefix for anything secret-looking, and no digit runs that
    // could be a phone number.
    node.shape = /^\d+$/u.test(value)
      ? `digits(${value.length})`
      : /^[A-Za-z0-9+/=_-]+$/u.test(value)
        ? 'base64ish'
        : 'text'
    if (key !== undefined && !SECRET_KEY_PATTERN.test(key) && !/^\d+$/u.test(value)) {
      node.prefix = value.slice(0, 6)
    }
    return node
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    const node = { type: typeof value }
    if (key !== undefined && SAFE_VALUE_KEYS.test(key)) node.value = value
    return node
  }

  return { type: typeof value }
}

// ---------------------------------------------------------------------------
// 1. Credential directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolve candidate credential paths the same way the app does.
 *
 * Order mirrors `desktopAuthCandidatesFor()` in the reference implementation:
 * an explicit file env var wins outright, then the directory env var, then the
 * default under the home directory. The home directory itself is reported twice
 * — once from `os.homedir()` and once from the environment — because a mismatch
 * between them is a real source of "the file is there but the plugin cannot see
 * it" bugs on Windows (MSYS `HOME` vs `USERPROFILE`).
 */
function resolveCandidates() {
  const explicitFile = process.env.RACCOON_AUTH_FILE?.trim()
  const configDirEnv = process.env.BOX_AGENT_CONFIG_DIR?.trim()
  const home = homedir()
  const homeFromEnv = process.env.HOME?.trim()
  const userProfile = process.env.USERPROFILE?.trim()

  const resolvedDir = configDirEnv !== undefined && configDirEnv !== ''
    ? configDirEnv
    : path.join(home, ...CONFIG_DIR_REL)

  const candidates = []
  const push = (file, via) => {
    if (file !== undefined && file !== '' && !candidates.some(entry => entry.file === file)) {
      candidates.push({ file, via })
    }
  }

  if (explicitFile !== undefined && explicitFile !== '') {
    push(explicitFile, 'RACCOON_AUTH_FILE')
  } else {
    if (configDirEnv !== undefined && configDirEnv !== '') {
      push(path.join(configDirEnv, 'auth.json'), 'BOX_AGENT_CONFIG_DIR')
    }
    push(path.join(home, ...CONFIG_DIR_REL, 'auth.json'), 'os.homedir()')
    // Only surface these alternates when they actually differ.
    if (userProfile !== undefined && userProfile !== '' && path.resolve(userProfile) !== path.resolve(home)) {
      push(path.join(userProfile, ...CONFIG_DIR_REL, 'auth.json'), 'USERPROFILE')
    }
    if (homeFromEnv !== undefined && homeFromEnv !== '' && path.resolve(homeFromEnv) !== path.resolve(home)) {
      push(path.join(homeFromEnv, ...CONFIG_DIR_REL, 'auth.json'), 'HOME')
    }
  }

  return {
    home,
    homeFromEnv,
    userProfile,
    explicitFile: explicitFile ?? null,
    configDirEnv: configDirEnv ?? null,
    resolvedDir,
    candidates,
  }
}

/** List a directory tree with sizes, bounded in depth and entry count. */
async function listTree(root, maxDepth = 3, maxEntries = 200) {
  const listing = []
  const walk = async (dir, depth) => {
    if (depth > maxDepth || listing.length >= maxEntries) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      listing.push({ path: dir, error: error.code ?? 'READ_ERROR' })
      return
    }
    for (const entry of entries) {
      if (listing.length >= maxEntries) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        listing.push({ path: full, type: 'dir' })
        await walk(full, depth + 1)
        continue
      }
      const info = await statOrUndefined(full)
      listing.push({
        path: full,
        type: 'file',
        size: info?.size,
        mtime: info?.mtime?.toISOString(),
        mode: info === undefined ? undefined : `0${(info.mode & 0o777).toString(8)}`,
      })
    }
  }
  await walk(root, 0)
  return listing
}

/** Probe candidate credential files without modifying anything. */
async function probeCredentials(resolution) {
  const results = []

  for (const candidate of resolution.candidates) {
    const info = await statOrUndefined(candidate.file)
    const entry = {
      file: candidate.file,
      via: candidate.via,
      exists: info !== undefined,
      isFile: info?.isFile() ?? false,
      size: info?.size,
      mtime: info?.mtime?.toISOString(),
      mode: info === undefined ? undefined : `0${(info.mode & 0o777).toString(8)}`,
      dirExists: existsSync(path.dirname(candidate.file)),
    }

    if (info === undefined || !info.isFile()) {
      results.push(entry)
      continue
    }

    let text
    try {
      text = await readFile(candidate.file, 'utf8')
    } catch (error) {
      entry.readError = error.code ?? 'READ_ERROR'
      results.push(entry)
      continue
    }

    entry.bytesRead = Buffer.byteLength(text, 'utf8')

    let document
    try {
      document = JSON.parse(text)
    } catch {
      entry.parseError = 'not JSON'
      results.push(entry)
      continue
    }

    entry.parses = true
    entry.topLevelKeys = typeof document === 'object' && document !== null && !Array.isArray(document)
      ? Object.keys(document)
      : []
    entry.structure = describeNode(document, undefined, 0)

    // Which access-token alias is actually in use, and is it usable?
    if (typeof document === 'object' && document !== null && !Array.isArray(document)) {
      const presentAliases = ACCESS_TOKEN_ALIASES.filter(alias => typeof document[alias] === 'string' && document[alias].trim() !== '')
      entry.accessTokenAlias = presentAliases[0] ?? null
      entry.accessTokenAliasesPresent = presentAliases
      entry.refreshTokenPresent = typeof document.refresh_token === 'string' && document.refresh_token.trim() !== ''

      const accessToken = presentAliases.length > 0 ? document[presentAliases[0]] : undefined
      const facts = describeJwt(accessToken)
      if (facts.isJwt) {
        entry.accessTokenIsJwt = true
        entry.accessExpiresAt = facts.exp
        entry.accessExpiresInSeconds = facts.expiresInSeconds
        entry.accessExpired = typeof facts.expiresInSeconds === 'number' && facts.expiresInSeconds <= 0
      } else {
        entry.accessTokenIsJwt = false
      }

      if (entry.refreshTokenPresent) {
        const refreshFacts = describeJwt(document.refresh_token)
        if (refreshFacts.isJwt) {
          entry.refreshTokenIsJwt = true
          entry.refreshExpiresAt = refreshFacts.exp
          entry.refreshExpiresInSeconds = refreshFacts.expiresInSeconds
        } else {
          entry.refreshTokenIsJwt = false
        }
      }

      // The write-back contract: does the file still match the expected key set?
      entry.expectedKeys = DESKTOP_TOKEN_KEYS
      entry.missingExpectedKeys = DESKTOP_TOKEN_KEYS.filter(key => !(key in document))
      entry.unexpectedKeys = Object.keys(document).filter(key => !DESKTOP_TOKEN_KEYS.includes(key))
      entry.keyOrderMatchesApp = Object.keys(document).slice(0, DESKTOP_TOKEN_KEYS.length).every(
        (key, index) => key === DESKTOP_TOKEN_KEYS[index],
      )
    }

    // Sibling files matter: the app may keep a lock, a cache or a backup.
    try {
      const siblings = await readdir(path.dirname(candidate.file), { withFileTypes: true })
      entry.siblings = siblings.map(item => (item.isDirectory() ? `${item.name}/` : item.name)).sort()
    } catch {
      entry.siblings = []
    }

    results.push(entry)
  }

  // Directory tree, so a future build's extra files show up.
  const configDir = path.dirname(resolution.candidates[0]?.file ?? '')
  const tree = configDir !== '' && existsSync(configDir) ? await listTree(configDir) : []

  return { candidates: results, configDir, tree }
}

// ---------------------------------------------------------------------------
// 2. Is the desktop client installed?
// ---------------------------------------------------------------------------

const UNINSTALL_HIVES = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
]

/** Does a line of text carry an install hint? */
function matchesHint(text) {
  const lower = text.toLowerCase()
  return INSTALL_HINTS.some(hint => lower.includes(hint.toLowerCase()))
}

/** Scan the three Uninstall hives for DisplayName/InstallLocation matches. */
function scanRegistry(enabled) {
  if (!enabled) return { skipped: true }
  if (process.platform !== 'win32') return { skipped: true, reason: 'not windows' }

  const hits = []
  const hives = []
  for (const hive of UNINSTALL_HIVES) {
    const stdout = runCommand('reg.exe', ['query', hive, '/s', '/v', 'DisplayName'])
    if (stdout === null) {
      hives.push({ hive, readable: false })
      continue
    }
    hives.push({ hive, readable: true, subkeys: (stdout.match(/DisplayName/gu) ?? []).length })
    for (const line of stdout.split(/\r?\n/u)) {
      if (line.trim() === '' || !matchesHint(line)) continue
      // Only the key path and the display name; nothing else on the line.
      hits.push({ hive, line: line.trim().slice(0, 240) })
    }
  }

  // Protocol handler: an installed Electron app usually registers one.
  const protocols = []
  for (const scheme of ['xiaohuanxiong', 'raccoon', 'sensetime', 'box-agent']) {
    const stdout = runCommand('reg.exe', ['query', `HKCU\\SOFTWARE\\Classes\\${scheme}`])
    if (stdout !== null) protocols.push(scheme)
  }

  return { skipped: false, hives, hits, protocols }
}

/** Scan well-known install roots for a directory whose name matches a hint. */
async function scanInstallRoots() {
  const localAppData = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local')
  const appData = process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
  const roots = [
    { label: 'LOCALAPPDATA', dir: localAppData },
    { label: 'APPDATA', dir: appData },
    { label: 'ProgramFiles', dir: process.env.ProgramFiles ?? 'C:\\Program Files' },
    { label: 'ProgramFiles(x86)', dir: process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)' },
    {
      label: 'StartMenu',
      dir: path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    },
    { label: 'LocalPrograms', dir: path.join(localAppData, 'Programs') },
  ]

  const hits = []
  const scanned = []
  for (const root of roots) {
    const info = await statOrUndefined(root.dir)
    if (info === undefined || !info.isDirectory()) {
      scanned.push({ ...root, exists: false })
      continue
    }
    scanned.push({ ...root, exists: true })
    let entries
    try {
      entries = await readdir(root.dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!matchesHint(entry.name)) continue
      hits.push({
        root: root.label,
        path: path.join(root.dir, entry.name),
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : 'file',
      })
    }
  }

  // A second, deeper pass only over the two app-data roots: an Electron app can
  // live one level down (e.g. under Programs/<vendor>/).
  const deepRoots = [path.join(localAppData, 'Programs'), appData]
  const deepHits = []
  for (const root of deepRoots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const inner = path.join(root, entry.name)
      let subEntries
      try {
        subEntries = await readdir(inner, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sub of subEntries) {
        if (matchesHint(sub.name)) deepHits.push({ path: path.join(inner, sub.name), name: sub.name })
      }
    }
  }

  return { scanned, hits, deepHits }
}

/** Look for a running client process, and for an installer left in Downloads. */
function scanProcessesAndDownloads() {
  const processes = []
  if (process.platform === 'win32') {
    const stdout = runCommand('tasklist.exe', ['/FO', 'CSV', '/NH'])
    if (stdout !== null) {
      for (const line of stdout.split(/\r?\n/u)) {
        if (line.trim() === '' || !matchesHint(line)) continue
        // First CSV field is the image name only.
        const image = line.split(',')[0]?.replace(/^"|"$/gu, '')
        if (image !== undefined && image !== '') processes.push(image)
      }
    }
  }

  const downloads = []
  const dir = path.join(homedir(), 'Downloads')
  try {
    const entries = readdirSync(dir)
    for (const name of entries) if (matchesHint(name)) downloads.push(name)
  } catch {
    // Downloads is optional; absence is not a finding.
  }

  return { processes, downloads }
}

// ---------------------------------------------------------------------------
// 3. Other credential locations
// ---------------------------------------------------------------------------

/** Glob-free scan for Electron credential artefacts under one root. */
async function scanElectronArtefacts(root, maxDepth = 3) {
  const artefacts = []
  const multiAccount = []
  const walk = async (dir, depth) => {
    if (depth > maxDepth || artefacts.length > 120) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const name = entry.name.toLowerCase()
        if (name === 'local storage' || name === 'cookies' || name === 'network' || name === 'session storage') {
          artefacts.push({ path: full, kind: entry.name, type: 'dir' })
          continue
        }
        if (name === 'accounts' || name === 'profiles' || name === 'users' || name === 'multi-account' || name === 'sessions') {
          let count = 0
          try {
            count = (await readdir(full)).length
          } catch {
            count = -1
          }
          multiAccount.push({ path: full, entries: count })
          continue
        }
        await walk(full, depth + 1)
        continue
      }
      const name = entry.name.toLowerCase()
      if (name.endsWith('.asar') || name === 'cookies' || name === 'auth.json' || name === 'config.json') {
        const info = await statOrUndefined(full)
        artefacts.push({ path: full, kind: entry.name, type: 'file', size: info?.size })
      }
    }
  }
  const info = await statOrUndefined(root)
  if (info !== undefined && info.isDirectory()) await walk(root, 0)
  return { artefacts, multiAccount }
}

/** Locate any auth.json / config.json that sits in a box-agent-shaped path. */
async function scanForBoxAgentElsewhere() {
  const hits = []
  const searchRoots = [
    process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local'),
    process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
    homedir(),
  ]
  for (const root of searchRoots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!/box[-_.]?agent/iu.test(entry.name)) continue
      const full = path.join(root, entry.name)
      const hasConfig = existsSync(path.join(full, 'config', 'auth.json'))
      hits.push({ path: full, hasConfigAuthJson: hasConfig })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// 4. Multi-account capability
// ---------------------------------------------------------------------------

/**
 * Decide whether the desktop client can hold more than one account.
 *
 * Evidence, in order of strength:
 *   - the app writes exactly one `auth.json` document with a flat token pair, so
 *     the file format itself is single-account;
 *   - `BOX_AGENT_CONFIG_DIR` relocates the whole directory, which is the only
 *     supported way to keep a second account — but each relocated directory is a
 *     whole separate profile, not a slot inside one installation;
 *   - the plugin-owned store keeps exactly one Raccoon record (`raccoon?:`), not
 *     a map, so it cannot fan out to a pool either.
 */
function assessMultiAccount(credentials, electronScan) {
  const authCandidates = credentials.candidates.filter(entry => entry.exists && entry.isFile)
  const structures = authCandidates.map(entry => entry.structure)
  const arrayShaped = structures.some(node => node?.type === 'array')
  const nestedAccountish = structures.some(node => {
    const keys = node?.keys ?? []
    return keys.some(key => /^(accounts|users|profiles|sessions|slots)$/i.test(key))
  })

  return {
    singleAccountFileShape: !arrayShaped && !nestedAccountish,
    authFilesFound: authCandidates.length,
    arrayShaped,
    nestedAccountish,
    relocatedProfilesPossible: true,
    relocatedProfilesNote:
      'BOX_AGENT_CONFIG_DIR relocates the whole credential directory, so a second account needs a '
      + 'second complete profile directory, not a slot inside the first.',
    electronMultiAccountDirs: electronScan.multiAccount.filter(entry => entry.entries > 1),
    conclusion: authCandidates.length === 0
      ? 'no credential file to judge; the app writes one flat token document per profile'
      : arrayShaped || nestedAccountish
        ? 'credential file may hold several accounts; inspect structure above'
        : 'one account per credential file; a pool must come from separate profiles or another source',
  }
}

// ---------------------------------------------------------------------------
// 5. agent2api import source
// ---------------------------------------------------------------------------

/** Probe the third-party SQLite account store, strictly read-only. */
async function probeAgent2Api() {
  const candidates = [
    path.join(homedir(), '.agent2api', 'agent2api.db'),
    path.join(process.env.APPDATA ?? '', 'agent2api', 'agent2api.db'),
    path.join(process.env.LOCALAPPDATA ?? '', 'agent2api', 'agent2api.db'),
  ].filter(file => file !== '')

  const found = []
  for (const file of candidates) {
    const info = await statOrUndefined(file)
    if (info === undefined) continue
    found.push({
      file,
      size: info.size,
      mtime: info.mtime.toISOString(),
      mode: `0${(info.mode & 0o777).toString(8)}`,
    })
  }

  if (found.length === 0) {
    return { exists: false, searched: candidates, sqliteAvailable: await hasNodeSqlite() }
  }

  const sqliteAvailable = await hasNodeSqlite()
  const databases = []
  for (const entry of found) {
    const probe = { ...entry }
    if (!sqliteAvailable) {
      probe.note = 'node:sqlite unavailable (needs Node 22.5+); existence and size only'
      databases.push(probe)
      continue
    }
    try {
      const { DatabaseSync } = await import('node:sqlite')
      // `readOnly: true` is the whole point: this must not create a WAL or lock.
      const db = new DatabaseSync(entry.file, { readOnly: true })
      try {
        const tables = db
          .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
          .all()
          .map(row => ({ name: row.name, type: row.type }))

        probe.tables = []
        for (const table of tables) {
          const row = { name: table.name, type: table.type }
          try {
            const count = db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get()
            row.rows = count?.n ?? 0
            const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all()
            row.columns = columns.map(column => ({ name: column.name, type: column.type, notnull: column.notnull }))
          } catch (error) {
            row.error = error.code ?? 'QUERY_ERROR'
          }
          probe.tables.push(row)
        }

        // If the expected accounts table is there, report its shape without
        // dumping provider data: counts per provider and how many rows are enabled.
        const accounts = probe.tables.find(table => table.name === 'accounts')
        if (accounts !== undefined && accounts.columns !== undefined) {
          const names = accounts.columns.map(column => column.name)
          if (names.includes('provider')) {
            try {
              probe.providerCounts = db
                .prepare('SELECT provider, COUNT(*) AS n FROM accounts GROUP BY provider ORDER BY n DESC')
                .all()
                .map(row => ({ provider: row.provider, rows: row.n }))
            } catch {
              // Provider column exists but is not groupable; not a finding.
            }
          }
          if (names.includes('enabled')) {
            try {
              probe.enabledCounts = db
                .prepare('SELECT enabled, COUNT(*) AS n FROM accounts GROUP BY enabled')
                .all()
                .map(row => ({ enabled: row.enabled, rows: row.n }))
            } catch {
              // Same.
            }
          }
          // Does a `data` JSON column look like it holds Raccoon accounts? Only
          // the count of rows whose payload mentions a raccoon-ish provider key.
          if (names.includes('data')) {
            try {
              probe.dataRowsMentioningRaccoon = db
                .prepare("SELECT COUNT(*) AS n FROM accounts WHERE data LIKE '%raccoon%' OR data LIKE '%xiaohuan%' OR data LIKE '%sensetime%'")
                .get()?.n ?? 0
            } catch {
              // Optional.
            }
          }
        }
      } finally {
        db.close()
      }
    } catch (error) {
      probe.error = error.code ?? error.message ?? 'SQLITE_ERROR'
    }
    databases.push(probe)
  }

  return { exists: true, databases, sqliteAvailable }
}

/** Whether `node:sqlite` can be imported on this runtime. */
async function hasNodeSqlite() {
  try {
    await import('node:sqlite')
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 6. Write-back feasibility
// ---------------------------------------------------------------------------

/**
 * Report what a write-back would have to deal with — without trying it.
 *
 * The reference implementation writes `auth.json.<pid>.tmp` then renames, with
 * mode 0600, and takes a one-time backup before the first overwrite. Whether
 * that is safe here depends on facts only the filesystem can answer: who owns
 * the file, whether it is writable, and whether a stale temp file or lock file
 * from the app is already sitting next to it.
 */
async function assessWriteBack(credentials) {
  const files = credentials.candidates.filter(entry => entry.exists && entry.isFile)
  if (files.length === 0) {
    return {
      applicable: false,
      note: 'no credential file present, so there is nothing to write back; a first write would have to create the directory',
    }
  }

  return {
    applicable: true,
    files: files.map(entry => ({
      file: entry.file,
      mode: entry.mode,
      ownerWritable: entry.mode === undefined
        ? undefined
        : (Number.parseInt(entry.mode, 8) & 0o200) !== 0,
      staleTempFiles: (entry.siblings ?? []).filter(name => /\.tmp$/u.test(name)),
      lockFiles: (entry.siblings ?? []).filter(name => /\.lock$/u.test(name)),
      siblings: entry.siblings,
    })),
    recommendedStrategy: [
      'default to read-only: use the access token as-is while it is unexpired, send no refresh',
      'only refresh inside the margin, single-flight, because the refresh token is single-use',
      'after a refresh, write the rotated pair back to the app\'s own auth.json',
      'atomic write: write auth.json.<pid>.tmp with mode 0600, then rename over auth.json',
      'preserve key order (access_token, refresh_token, office_identity, office_org_name, office_org_role) and any unknown keys',
      'take a one-time backup of the replaced document under $DSH_HOME before the first overwrite',
      'on refresh_conflict, re-read the app file first; the app may have just rotated it',
    ],
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Run every probe, tolerating individual failures. */
async function collect(options) {
  const resolution = resolveCandidates()

  const credentials = await probeCredentials(resolution).catch(error => ({
    candidates: [], configDir: '', tree: [], error: error.message,
  }))

  const registry = (() => {
    try {
      return scanRegistry(options.registry)
    } catch (error) {
      return { error: error.message }
    }
  })()

  const installRoots = await scanInstallRoots().catch(error => ({ error: error.message }))
  const processesAndDownloads = (() => {
    try {
      return scanProcessesAndDownloads()
    } catch (error) {
      return { error: error.message }
    }
  })()

  const electronScan = await scanElectronArtefacts(
    process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
  ).catch(error => ({ error: error.message, artefacts: [], multiAccount: [] }))

  const boxAgentElsewhere = await scanForBoxAgentElsewhere().catch(() => [])

  const agent2api = await probeAgent2Api().catch(error => ({ error: error.message, exists: false }))

  const installed = Boolean(
    (registry.hits?.length ?? 0) > 0
    || (registry.protocols?.length ?? 0) > 0
    || (installRoots.hits?.length ?? 0) > 0
    || (installRoots.deepHits?.length ?? 0) > 0
    || (processesAndDownloads.processes?.length ?? 0) > 0,
  )

  return {
    probedAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    nodeSqlite: await hasNodeSqlite(),
    resolution: {
      home: resolution.home,
      homeFromEnv: resolution.homeFromEnv,
      userProfile: resolution.userProfile,
      explicitFile: resolution.explicitFile,
      configDirEnv: resolution.configDirEnv,
      resolvedDir: resolution.resolvedDir,
      candidates: resolution.candidates,
      envOverridesActive: Boolean(resolution.explicitFile ?? resolution.configDirEnv),
    },
    credentials,
    install: {
      installed,
      verdict: installed ? 'installed' : 'not installed (no registry, filesystem or process evidence)',
      registry,
      installRoots,
      processesAndDownloads,
      boxAgentElsewhere,
    },
    otherCredentialLocations: electronScan,
    multiAccount: assessMultiAccount(credentials, electronScan),
    writeBack: await assessWriteBack(credentials),
    agent2api,
  }
}

/** Human-readable rendering. */
function render(report) {
  const lines = []
  const push = (...args) => lines.push(...args)

  push('商汤小浣熊 desktop credential probe (read-only)', `  at ${report.probedAt} · ${report.platform} · ${report.nodeVersion}`, '')

  push('1. Credential directory resolution')
  push(`   home (os.homedir) : ${report.resolution.home}`)
  if (report.resolution.homeFromEnv !== report.resolution.home) {
    push(`   HOME env          : ${report.resolution.homeFromEnv ?? '<unset>'}`)
  }
  if (report.resolution.userProfile !== undefined) {
    push(`   USERPROFILE       : ${report.resolution.userProfile}`)
  }
  push(`   RACCOON_AUTH_FILE : ${report.resolution.explicitFile ?? '<unset>'}`)
  push(`   BOX_AGENT_CONFIG_DIR: ${report.resolution.configDirEnv ?? '<unset>'}`)
  push(`   resolved dir      : ${report.resolution.resolvedDir}`)
  for (const entry of report.credentials.candidates ?? []) {
    push(`   - ${entry.file}  [via ${entry.via}]`)
    push(`     exists=${entry.exists}${entry.isFile ? ` size=${entry.size} mode=${entry.mode}` : ''}`)
    if (entry.parses) {
      push(`     keys: ${(entry.topLevelKeys ?? []).join(', ')}`)
      push(`     access_token alias in use: ${entry.accessTokenAlias ?? '<none>'}`)
      if (entry.accessExpiresAt !== undefined) {
        push(`     access token exp: ${entry.accessExpiresAt} (${entry.accessExpiresInSeconds}s, ${entry.accessExpired ? 'EXPIRED' : 'live'})`)
      }
      if (entry.refreshExpiresAt !== undefined) push(`     refresh token exp: ${entry.refreshExpiresAt}`)
      if ((entry.missingExpectedKeys ?? []).length > 0) {
        push(`     missing expected keys: ${entry.missingExpectedKeys.join(', ')}`)
      }
    } else if (entry.exists) {
      push(`     unreadable or not JSON: ${entry.parseError ?? entry.readError ?? 'unknown'}`)
    }
  }
  push('')

  push('2. Desktop client installed?')
  push(`   verdict: ${report.install.verdict}`)
  if (report.install.registry?.hits?.length) {
    for (const hit of report.install.registry.hits) push(`   registry: ${hit.line}`)
  }
  if (report.install.registry?.protocols?.length) {
    push(`   protocols: ${report.install.registry.protocols.join(', ')}`)
  }
  for (const hit of report.install.installRoots?.hits ?? []) {
    push(`   filesystem: ${hit.path}`)
  }
  for (const hit of report.install.installRoots?.deepHits ?? []) {
    push(`   filesystem (deep): ${hit.path}`)
  }
  if (report.install.processesAndDownloads?.processes?.length) {
    push(`   processes: ${report.install.processesAndDownloads.processes.join(', ')}`)
  }
  if (report.install.processesAndDownloads?.downloads?.length) {
    push(`   downloads: ${report.install.processesAndDownloads.downloads.join(', ')}`)
  }
  if (report.install.boxAgentElsewhere?.length) {
    for (const hit of report.install.boxAgentElsewhere) push(`   box-agent dir: ${hit.path}`)
  }
  push('')

  push('3. Other credential locations (Electron shapes)')
  const artefacts = report.otherCredentialLocations?.artefacts ?? []
  push(`   ${artefacts.length} artefact(s) under APPDATA`)
  for (const artefact of artefacts.slice(0, 12)) push(`   - [${artefact.kind}] ${artefact.path}`)
  if (artefacts.length > 12) push(`   … ${artefacts.length - 12} more`)
  push('')

  push('4. Multi-account feasibility')
  push(`   ${report.multiAccount?.conclusion}`)
  push('')

  push('5. Write-back')
  if (!report.writeBack?.applicable) {
    push(`   ${report.writeBack?.note}`)
  } else {
    for (const file of report.writeBack.files ?? []) {
      push(`   ${file.file} mode=${file.mode} ownerWritable=${file.ownerWritable}`)
      if ((file.staleTempFiles ?? []).length) push(`     stale temp files: ${file.staleTempFiles.join(', ')}`)
      if ((file.lockFiles ?? []).length) push(`     lock files: ${file.lockFiles.join(', ')}`)
    }
  }
  push('')

  push('6. agent2api import source')
  if (!report.agent2api?.exists) {
    push('   not present')
  } else {
    for (const db of report.agent2api.databases ?? []) {
      push(`   ${db.file} size=${db.size}`)
      if (db.note !== undefined) push(`     ${db.note}`)
      if (db.error !== undefined) push(`     error: ${db.error}`)
      for (const table of db.tables ?? []) {
        push(`     table ${table.name}: ${table.rows ?? '?'} row(s)`)
      }
      if (db.providerCounts !== undefined) {
        push(`     providers: ${db.providerCounts.map(row => `${row.provider}=${row.rows}`).join(', ')}`)
      }
    }
  }

  return `${lines.join('\n')}\n`
}

/** Entry point. */
async function main() {
  const argv = process.argv.slice(2)
  const asJson = argv.includes('--json')
  const noRegistry = argv.includes('--no-registry')

  const report = await collect({ registry: !noRegistry })

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  process.stdout.write(render(report))
}

main().catch(error => {
  process.stderr.write(`probe failed: ${error?.stack ?? error}\n`)
  process.exitCode = 1
})
