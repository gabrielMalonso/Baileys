import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const repository = 'gabrielMalonso/Baileys'
const upstream = 'https://github.com/WhiskeySockets/Baileys.git'
const branch = 'automation/upstream-update'
const preserved = ['.github/workflows', 'maintenance', 'upstream.json', 'OWNED_SDK.md']

export function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
	return value as Record<string, unknown>
}

function json(path: string): Record<string, unknown> {
	return record(JSON.parse(readFileSync(path, 'utf8')))
}

export function provenance(value: unknown): { version: string; commit: string } {
	const data = record(value)
	if (typeof data.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(data.version))
		throw new Error('Expected an exact upstream version')
	if (typeof data.commit !== 'string' || !/^[a-f0-9]{40}$/.test(data.commit))
		throw new Error('Expected an exact upstream commit')
	return { version: data.version, commit: data.commit }
}

export function assertUpdatePath(path: string): void {
	if (
		!/^[\w./-]+$/.test(path) ||
		path.startsWith('/') ||
		path.split('/').includes('..') ||
		preserved.some(p => path === p || path.startsWith(p + '/'))
	)
		throw new Error(`Upstream update cannot replace fork maintenance files: ${path}`)
}

function run(root: string, executable: string, args: string[], capture = false): string {
	process.stderr.write(`> ${executable} ${args.join(' ')}\n`)
	const result = spawnSync(executable, args, {
		cwd: root,
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
		maxBuffer: 32 * 1024 * 1024
	})
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`${executable} failed (${result.status})`)
	return result.stdout ?? ''
}

function writeJson(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

function output(key: string, value: string): void {
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}

export function applyUpstream(root: string, previous: string, next: string): void {
	const diff = run(
		root,
		'git',
		['diff', '--no-renames', '--binary', previous, next, '--', '.', ...preserved.map(p => `:(exclude)${p}`)],
		true
	)
	mkdirSync(join(root, '.tmp'), { recursive: true })
	const patch = join(root, '.tmp/upstream-release.patch')
	writeFileSync(patch, diff)
	if (diff) {
		for (const row of run(root, 'git', ['apply', '--numstat', patch], true).trim().split('\n'))
			assertUpdatePath(row.split('\t')[2] ?? '')
		// A three-way patch retains our edits without depending on merge ancestry after squash merges.
		run(root, 'git', ['apply', '--3way', patch])
	}
}

function prepare(root: string): void {
	if (run(root, 'git', ['status', '--porcelain'], true).trim())
		throw new Error('Prepare an upstream update in a clean checkout')
	const current = provenance(json(join(root, 'upstream.json')))
	const npm = record(
		JSON.parse(
			run(
				root,
				'npm',
				['view', 'baileys@latest', 'version', 'gitHead', '--registry=https://registry.npmjs.org', '--json'],
				true
			)
		)
	)
	const next = provenance({ version: npm.version, commit: npm.gitHead })
	if (next.version === current.version) {
		if (next.commit !== current.commit) throw new Error('An existing upstream release changed commit')
		output('changed', 'false')
		process.stdout.write(`Upstream ${current.version} is already integrated.\n`)
		return
	}
	const base = run(root, 'git', ['rev-parse', 'HEAD'], true).trim()
	run(root, 'git', ['fetch', '--depth=1', upstream, current.commit, next.commit])
	applyUpstream(root, current.commit, next.commit)
	mkdirSync(join(root, '.tmp/upstream-update'), { recursive: true })
	writeJson(join(root, 'upstream.json'), next)
	run(root, 'git', ['add', '--all'])
	run(root, 'git', ['diff', '--cached', '--check'])
	writeFileSync(
		join(root, '.tmp/upstream-update/changes.patch'),
		run(root, 'git', ['diff', '--cached', '--binary', 'HEAD'], true)
	)
	writeJson(join(root, '.tmp/upstream-update/update.json'), { base, ...next })
	output('changed', 'true')
}

function publishUpdate(root: string): void {
	const meta = json(join(root, '.tmp/upstream-update/update.json'))
	const next = provenance(meta)
	if (run(root, 'git', ['rev-parse', 'HEAD'], true).trim() !== meta.base)
		throw new Error('Fork main advanced; prepare the update again')
	const patch = join(root, '.tmp/upstream-update/changes.patch')
	for (const row of run(root, 'git', ['apply', '--numstat', patch], true).trim().split('\n')) {
		const path = row.split('\t')[2] ?? ''
		if (path !== 'upstream.json') assertUpdatePath(path)
	}
	run(root, 'git', ['apply', '--check', patch])
	run(root, 'git', ['apply', patch])
	if (
		!isDeepStrictEqual(provenance(json(join(root, 'upstream.json'))), next) ||
		json(join(root, 'package.json')).version !== next.version
	)
		throw new Error('Proposed source does not match the upstream release')
	run(root, 'gh', ['auth', 'setup-git'])
	const remote =
		run(root, 'git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], true).split(/\s+/)[0] ?? ''
	if (remote) {
		const commit = record(JSON.parse(run(root, 'gh', ['api', `repos/${repository}/commits/${remote}`], true)))
		if (record(commit.author).login !== 'github-actions[bot]')
			throw new Error('Update branch contains human work; preserve it')
	}
	const prs: unknown = JSON.parse(
		run(root, 'gh', ['api', `repos/${repository}/pulls?state=open&head=gabrielMalonso:${branch}`], true)
	)
	if (
		!Array.isArray(prs) ||
		prs.length > 1 ||
		(prs.length && record(record(prs[0]).user).login !== 'github-actions[bot]')
	)
		throw new Error('Expected one bot-owned update PR')
	run(root, 'git', ['checkout', '-B', branch])
	run(root, 'git', ['config', 'user.name', 'github-actions[bot]'])
	run(root, 'git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
	run(root, 'git', ['add', '--all'])
	const title = `chore(upstream): integrate Baileys ${next.version}`
	run(root, 'git', ['commit', '-m', title])
	run(root, 'git', ['push', `--force-with-lease=refs/heads/${branch}:${remote}`, 'origin', `HEAD:refs/heads/${branch}`])
	const body = join(root, '.tmp/upstream-update/body.md')
	writeFileSync(
		body,
		`Integrate upstream ${next.version} (${next.commit}) into our SDK, retaining our changes with a three-way merge. Fork-owned workflows and maintenance files are preserved.\n\nReview the source changes and required SDK CI before manual squash merge. This PR targets ${repository}, not WhiskeySockets/Baileys.\n`
	)
	if (prs.length)
		run(root, 'gh', [
			'pr',
			'edit',
			String(record(prs[0]).number),
			'--repo',
			repository,
			'--title',
			title,
			'--body-file',
			body
		])
	else
		run(root, 'gh', [
			'pr',
			'create',
			'--repo',
			repository,
			'--base',
			'main',
			'--head',
			branch,
			'--title',
			title,
			'--body-file',
			body
		])
	run(root, 'gh', ['workflow', 'run', 'owned-ci.yml', '--repo', repository, '--ref', branch])
}

export function forkVersion(upstreamVersion: string, commit: string): string {
	provenance({ version: upstreamVersion, commit })
	return `${upstreamVersion}-gabriel.${commit.slice(0, 12)}`
}

function pack(root: string): void {
	const sourceCommit = run(root, 'git', ['rev-parse', 'HEAD'], true).trim()
	const origin = provenance(json(join(root, 'upstream.json')))
	const pkg = json(join(root, 'package.json'))
	if (pkg.version !== origin.version) throw new Error('SDK package version differs from upstream.json')
	const version = forkVersion(origin.version, sourceCommit)
	mkdirSync(join(root, '.tmp'), { recursive: true })
	const stage = mkdtempSync(join(root, '.tmp/package-'))
	const destination = mkdtempSync(join(root, '.tmp/release-'))
	for (const path of ['lib', 'WAProto', 'engine-requirements.js', 'LICENSE', 'README.md'])
		cpSync(join(root, path), join(stage, path), { recursive: true })
	pkg.version = version
	pkg.repository = { type: 'git', url: `https://github.com/${repository}.git` }
	pkg.baileysFork = { repository, sourceCommit, upstreamVersion: origin.version, upstreamCommit: origin.commit }
	writeJson(join(stage, 'package.json'), pkg)
	const result: unknown = JSON.parse(
		run(stage, 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], true)
	)
	if (!Array.isArray(result) || result.length !== 1) throw new Error('Expected one SDK package')
	const filename = record(result[0]).filename
	if (typeof filename !== 'string' || !/^[\w.-]+\.tgz$/.test(filename)) throw new Error('Invalid package filename')
	copyFileSync(join(destination, filename), join(destination, 'baileys.tgz'))
	const integrity =
		'sha512-' +
		createHash('sha512')
			.update(readFileSync(join(destination, 'baileys.tgz')))
			.digest('base64')
	writeJson(join(destination, 'sdk-release.json'), {
		repository,
		sourceCommit,
		upstreamVersion: origin.version,
		upstreamCommit: origin.commit,
		version,
		tag: `sdk-${sourceCommit}`,
		integrity,
		tarball: `https://github.com/${repository}/releases/download/sdk-${sourceCommit}/baileys.tgz`
	})
	output('directory', destination)
	process.stdout.write(`SDK package: ${destination}\n`)
}

function release(root: string): void {
	const directory = join(root, '.tmp/release')
	const meta = json(join(directory, 'sdk-release.json'))
	const commit = run(root, 'git', ['rev-parse', 'HEAD'], true).trim()
	const actual =
		'sha512-' +
		createHash('sha512')
			.update(readFileSync(join(directory, 'baileys.tgz')))
			.digest('base64')
	if (
		meta.repository !== repository ||
		meta.sourceCommit !== commit ||
		meta.tag !== `sdk-${commit}` ||
		actual !== meta.integrity
	)
		throw new Error('Release artifact provenance or integrity mismatch')
	const existing = spawnSync(
		'gh',
		['release', 'view', String(meta.tag), '--repo', repository, '--json', 'assets,isDraft'],
		{ cwd: root, encoding: 'utf8' }
	)
	if (existing.status === 0) {
		const data = record(JSON.parse(existing.stdout))
		if (
			data.isDraft ||
			!Array.isArray(data.assets) ||
			!['baileys.tgz', 'sdk-release.json'].every(name =>
				(data.assets as unknown[]).some(asset => record(asset).name === name)
			)
		)
			throw new Error('Existing release is incomplete; inspect it without replacing its assets')
		process.stdout.write('Validated SDK release already exists; assets preserved.\n')
		return
	}
	run(root, 'gh', [
		'release',
		'create',
		String(meta.tag),
		join(directory, 'baileys.tgz'),
		join(directory, 'sdk-release.json'),
		'--repo',
		repository,
		'--target',
		commit,
		'--title',
		`Baileys ${meta.version}`,
		'--notes',
		`Validated SDK from ${repository} at ${commit}, based on upstream ${meta.upstreamVersion}. No npm credentials or upstream approval required.`
	])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
	try {
		if (process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY !== repository)
			throw new Error('This automation only runs in the owned SDK repository')
		switch (process.argv[2]) {
			case 'prepare':
				prepare(root)
				break
			case 'publish-update':
				publishUpdate(root)
				break
			case 'pack':
				pack(root)
				break
			case 'release':
				release(root)
				break
			default:
				throw new Error('Expected prepare, publish-update, pack or release')
		}
	} catch (error: unknown) {
		process.stderr.write(`${error instanceof Error ? error.message : 'SDK maintenance failed'}\n`)
		process.exitCode = 1
	}
}
