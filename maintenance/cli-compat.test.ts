import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { checkCandidatePackage, verifyCandidate } from './cli-compat.ts'
import { forkVersion, repository } from './sdk.ts'

const bytes = Buffer.from('fictional SDK candidate bytes')
const meta = {
	repository,
	sourceCommit: 'a'.repeat(40),
	upstreamVersion: '7.0.0-rc14',
	upstreamCommit: 'b'.repeat(40),
	version: forkVersion('7.0.0-rc14', 'a'.repeat(40)),
	integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64')
}

test('compatibility candidate rejects corrupted bytes and unrelated provenance before installation', () => {
	assert.equal(verifyCandidate(meta, bytes).sourceCommit, meta.sourceCommit)
	assert.throws(() => verifyCandidate(meta, Buffer.from('other bytes')))
	assert.throws(() => verifyCandidate({ ...meta, repository: 'WhiskeySockets/Baileys' }, bytes))
	assert.throws(() => verifyCandidate({ ...meta, version: '7.0.0-rc14' }, bytes))
})

test('compatibility check cannot accidentally test the previously installed SDK', () => {
	const candidate = verifyCandidate(meta, bytes)
	const pkg = {
		name: 'baileys',
		version: meta.version,
		baileysFork: {
			repository,
			sourceCommit: meta.sourceCommit,
			upstreamVersion: meta.upstreamVersion,
			upstreamCommit: meta.upstreamCommit
		}
	}
	checkCandidatePackage(pkg, candidate)
	assert.throws(() =>
		checkCandidatePackage({ ...pkg, baileysFork: { ...pkg.baileysFork, sourceCommit: 'c'.repeat(40) } }, candidate)
	)
})
