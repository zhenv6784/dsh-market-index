#!/usr/bin/env node
/**
 * Build a DSH plugin-market index (format 1) from the highest-starred repos
 * carrying the GitHub topic `dsh-plugin`.
 *
 * Only repositories whose package.json is a real DSH bundle are kept, and each
 * kept version is cross-checked against npm so that "one-click install"
 * actually resolves. Output: index.json + report.json.
 */
import { writeFile } from 'node:fs/promises'
import semver from 'semver'

const API = 'https://api.github.com'
const TOKEN = process.env.GITHUB_TOKEN ?? ''
const TOP_N = Math.max(1, Math.min(500, Number(process.env.TOP_N ?? 50)))
const TARGET_DSH = process.env.TARGET_DSH ?? '0.2.1-rc.3'
const OUT = process.env.OUT ?? 'index.json'
const REPORT = process.env.REPORT ?? 'report.json'
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 6)

const ghHeaders = {
  'user-agent': 'dsh-market-index-builder',
  accept: 'application/vnd.github+json',
}
if (TOKEN) ghHeaders.authorization = `Bearer ${TOKEN}`

const npmHeaders = { 'user-agent': 'dsh-market-index-builder', accept: 'application/json' }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ghJson(path, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + path, { headers: ghHeaders })
    if (res.ok) return res.json()
    if (res.status === 404) return null
    if ((res.status === 403 || res.status === 429 || res.status >= 500) && attempt < tries) {
      const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 2000 * attempt
      await sleep(wait)
      continue
    }
    throw new Error(`GitHub ${res.status} ${path}`)
  }
}

async function ghRaw(path) {
  const res = await fetch(API + path, {
    headers: { ...ghHeaders, accept: 'application/vnd.github.raw' },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub raw ${res.status} ${path}`)
  return res.text()
}

async function npmPackument(name) {
  const url = 'https://registry.npmjs.org/' + name.replace('/', '%2F')
  const res = await fetch(url, { headers: npmHeaders })
  if (res.status === 404) return null
  if (!res.ok) return null
  return res.json()
}

/** `dsh.bundle` is the manifest field that makes a package installable as a bundle. */
function dshBundleOf(manifest) {
  const bundle = manifest?.dsh?.bundle
  if (!bundle) return null
  if (typeof bundle === 'object' && (bundle.patch || bundle.profiles)) return bundle
  return null
}

/** Compatibility with the running DSH, mirroring the install-time check. */
function compatibleWith(manifest, target) {
  const engine = manifest?.engines?.dsh
  if (typeof engine === 'string' && engine.length > 0) {
    if (engine.startsWith('workspace:')) return { ok: false, reason: `engines.dsh is a workspace range` }
    const range = semver.validRange(engine)
    if (range === null) return { ok: false, reason: `engines.dsh is not a SemVer range: ${engine}` }
    return semver.satisfies(target, range, { includePrerelease: true })
      ? { ok: true, engine }
      : { ok: false, reason: `engines.dsh ${engine} excludes ${target}` }
  }
  const peers = Object.entries(manifest?.peerDependencies ?? {}).filter(([key]) =>
    key.startsWith('@deepseek-ai/dsh'),
  )
  if (peers.length === 0) return { ok: false, reason: 'no engines.dsh and no @deepseek-ai/dsh peer' }
  for (const [key, range] of peers) {
    const parsed = semver.validRange(range)
    if (parsed === null) return { ok: false, reason: `peer ${key} is not a SemVer range: ${range}` }
    if (!semver.satisfies(target, parsed, { includePrerelease: true })) {
      return { ok: false, reason: `peer ${key} ${range} excludes ${target}` }
    }
  }
  return { ok: true, peerDriven: true }
}

function repositoryUrl(manifest) {
  const raw = typeof manifest?.repository === 'string' ? manifest.repository : manifest?.repository?.url
  if (typeof raw !== 'string') return undefined
  const normalized = raw
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/\.git$/, '')
  let url
  try {
    url = new URL(normalized)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  return url.href.replace(/\/$/, '')
}

function homepageUrl(manifest) {
  const raw = manifest?.homepage
  if (typeof raw !== 'string') return undefined
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined
  } catch {
    return undefined
  }
}

function authorOf(manifest, packument) {
  const author = manifest?.author
  if (typeof author === 'string' && author.trim()) return author.replace(/\s*<[^>]*>/, '').trim()
  if (author && typeof author.name === 'string' && author.name.trim()) return author.name.trim()
  const maintainer = packument?.maintainers?.[0]
  if (maintainer && typeof maintainer.name === 'string' && maintainer.name.trim()) return maintainer.name.trim()
  return undefined
}

function titleOf(name) {
  const leaf = name.includes('/') ? name.slice(name.indexOf('/') + 1) : name
  return leaf
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => (word.length <= 3 && word === word.toLowerCase() ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(' ')
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

const diagnostics = []

async function evaluate(repo) {
  const fullName = repo.full_name
  const record = { repo: fullName, stars: repo.stargazers_count, status: 'skipped', reason: '' }
  try {
    const text = await ghRaw(`/repos/${fullName}/contents/package.json`)
    if (!text) {
      record.reason = 'no package.json at repository root'
      return record
    }
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch {
      record.reason = 'package.json is not valid JSON'
      return record
    }
    if (!dshBundleOf(manifest)) {
      record.reason = 'package.json has no dsh.bundle'
      return record
    }
    const name = manifest.name
    if (typeof name !== 'string' || name.length === 0) {
      record.reason = 'package.json has no name'
      return record
    }
    record.name = name

    const packument = await npmPackument(name)
    const latest = packument?.['dist-tags']?.latest
    const npmManifest = latest ? packument.versions?.[latest] : undefined
    const npmBundle = npmManifest ? dshBundleOf(npmManifest) : null

    let versionEntry
    if (npmManifest && npmBundle) {
      record.status = 'npm'
      const compatibility = compatibleWith(npmManifest, TARGET_DSH)
      if (!compatibility.ok) {
        record.reason = compatibility.reason
        return record
      }
      const publishedAt = packument.time?.[latest]
      versionEntry = {
        version: latest,
        publishTimestamp: Math.floor(new Date(publishedAt ?? Date.now()).getTime() / 1000),
        source: { type: 'npm' },
        engines: typeof npmManifest.engines?.dsh === 'string' ? { dsh: npmManifest.engines.dsh } : {},
      }
      record.version = latest
    } else {
      // Not on npm (or the published version lost its bundle): pin the git commit.
      const compatibility = compatibleWith(manifest, TARGET_DSH)
      if (!compatibility.ok) {
        record.reason = `${compatibility.reason} (git source)`
        return record
      }
      const commit = await ghJson(`/repos/${fullName}/commits/${repo.default_branch ?? 'main'}`)
      if (!commit?.sha) {
        record.reason = 'cannot resolve default-branch commit'
        return record
      }
      const version = typeof manifest.version === 'string' && semver.valid(manifest.version) ? manifest.version : '0.0.0'
      record.status = 'git'
      record.note = npmManifest ? 'npm version lacks dsh.bundle' : 'not published to npm'
      versionEntry = {
        version,
        publishTimestamp: Math.floor(new Date(commit.commit?.committer?.date ?? Date.now()).getTime() / 1000),
        source: { type: 'git', url: `https://github.com/${fullName}`, commit: commit.sha },
        engines: typeof manifest.engines?.dsh === 'string' ? { dsh: manifest.engines.dsh } : {},
      }
      record.version = version
    }

    const plugin = { name, title: titleOf(name) }
    if (typeof manifest.description === 'string' && manifest.description.trim()) {
      plugin.description = manifest.description.trim()
    }
    const author = authorOf(manifest, packument)
    if (author) plugin.author = author
    const homepage = homepageUrl(manifest)
    if (homepage) plugin.homepage = homepage
    const repository = repositoryUrl(manifest)
    if (repository) plugin.repository = { url: repository }
    const keywords = Array.isArray(manifest.keywords)
      ? manifest.keywords.filter((word) => typeof word === 'string').slice(0, 20)
      : []
    plugin.metadata = { keywords, sortKeys: { stars: repo.stargazers_count } }
    plugin.versions = [versionEntry]

    record.status = record.status === 'npm' ? 'included-npm' : 'included-git'
    record.plugin = plugin
    return record
  } catch (error) {
    record.status = 'error'
    record.reason = String(error?.message ?? error)
    return record
  }
}

async function main() {
  const search = await ghJson(
    `/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=${Math.min(100, TOP_N)}`,
  )
  const repos = (search?.items ?? []).slice(0, TOP_N)
  console.log(`topic candidates: ${repos.length} (requested ${TOP_N})`)

  const records = await mapLimit(repos, CONCURRENCY, evaluate)
  const plugins = records.filter((record) => record.plugin).map((record) => record.plugin)
  plugins.sort((left, right) => right.metadata.sortKeys.stars - left.metadata.sortKeys.stars)

  const index = {
    format: 1,
    title: { en: 'DSH Community Plugins', zh: 'DSH 社区插件' },
    description: {
      en: `Highest-starred installable DeepSeek Harness bundles from GitHub topic dsh-plugin, rebuilt automatically. Verified against DSH ${TARGET_DSH}.`,
      zh: `从 GitHub 话题 dsh-plugin 中挑选的高星、可安装的 DeepSeek Harness 组合包，自动重建。已按 DSH ${TARGET_DSH} 校验。`,
    },
    metadata: {
      sortKeys: { stars: { title: { en: 'GitHub stars', zh: 'GitHub 星标' }, order: 'desc' } },
    },
    plugins,
  }

  await writeFile(OUT, JSON.stringify(index, null, 2) + '\n', 'utf8')
  await writeFile(
    REPORT,
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        targetDsh: TARGET_DSH,
        requested: TOP_N,
        candidates: repos.length,
        included: plugins.length,
        counts: records.reduce((acc, record) => {
          acc[record.status] = (acc[record.status] ?? 0) + 1
          return acc
        }, {}),
        records,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  console.log(`included ${plugins.length} plugin(s) -> ${OUT}`)
}

await main()
