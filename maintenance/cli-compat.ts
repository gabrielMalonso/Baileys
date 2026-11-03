import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { forkVersion, provenance, record, repository } from './sdk.ts'

type Candidate = {
	sourceCommit: string
	upstreamVersion: string
	upstreamCommit: string
	version: string
}

export function verifyCandidate(value: unknown, archive: Buffer): Candidate {
	const meta = record(value)
	const upstream = provenance({ version: meta.upstreamVersion, commit: meta.upstreamCommit })
	const source = provenance({ version: upstream.version, commit: meta.sourceCommit })
	const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64')
	const version = forkVersion(upstream.version, source.commit)
	if (meta.repository !== repository || meta.version !== version || meta.integrity !== integrity)
		throw new Error('CLI compatibility candidate provenance or digest mismatch')
	return { sourceCommit: source.commit, upstreamVersion: upstream.version, upstreamCommit: upstream.commit, version }
}

export function checkCandidatePackage(value: unknown, candidate: Candidate): void {
	const pkg = record(value)
	if (
		pkg.name !== 'baileys' ||
		pkg.version !== candidate.version ||
		!isDeepStrictEqual(pkg.baileysFork, {
			repository,
			sourceCommit: candidate.sourceCommit,
			upstreamVersion: candidate.upstreamVersion,
			upstreamCommit: candidate.upstreamCommit
		})
	)
		throw new Error('CLI tests must use the exact candidate SDK package')
}

function run(root: string, args: string[], capture = false): string {
	const executable = args[0]!
	process.stderr.write(`> ${args.join(' ')}\n`)
	const result = spawnSync(executable, args.slice(1), {
		cwd: root,
		encoding: 'utf8',
		stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit'
	})
	if (result.error) throw result.error
	if (result.status !== 0) throw new Error(`${executable} failed (${result.status})`)
	return result.stdout ?? ''
}

function check(cli: string, artifact: string): void {
	const candidate = verifyCandidate(
		JSON.parse(readFileSync(join(artifact, 'sdk-release.json'), 'utf8')),
		readFileSync(join(artifact, 'baileys.tgz'))
	)
	const cliCommit = run(cli, ['git', 'rev-parse', 'HEAD'], true).trim()
	if (!/^[a-f0-9]{40}$/.test(cliCommit)) throw new Error('Expected an exact CLI revision')
	run(cli, ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'])
	const path = join(cli, 'package.json')
	const pkg = record(JSON.parse(readFileSync(path, 'utf8')))
	const dependencies = record(pkg.dependencies)
	if (typeof dependencies.baileys !== 'string') throw new Error('Expected the CLI Baileys dependency')
	// The candidate has not been published yet: only this disposable CLI checkout uses a file dependency.
	dependencies.baileys = `file:${relative(cli, join(artifact, 'baileys.tgz'))}`
	writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
	run(cli, ['pnpm', 'install', '--no-frozen-lockfile', '--ignore-scripts'])
	checkCandidatePackage(JSON.parse(readFileSync(join(cli, 'node_modules/baileys/package.json'), 'utf8')), candidate)
	run(cli, ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'])
	for (const task of ['lint', 'format:check', 'check', 'test', 'verify:build']) run(cli, ['pnpm', task])
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `commit=${cliCommit}\n`)
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(
			process.env.GITHUB_STEP_SUMMARY,
			`SDK candidate: ${candidate.sourceCommit}\n\nCLI revision tested: ${cliCommit}\n\nThe CLI checks used the candidate tarball from this workflow, with its digest and installed provenance verified.\n`
		)
	process.stdout.write(`CLI ${cliCommit} passed with SDK candidate ${candidate.sourceCommit}.\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (!process.argv[2] || !process.argv[3]) throw new Error('Expected CLI_CHECKOUT and SDK_ARTIFACT_DIRECTORY')
		check(resolve(process.argv[2]), resolve(process.argv[3]))
	} catch (error: unknown) {
		process.stderr.write(`${error instanceof Error ? error.message : 'CLI compatibility check failed'}\n`)
		process.exitCode = 1
	}
}
