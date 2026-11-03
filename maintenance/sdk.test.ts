import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyUpstream, assertUpdatePath, forkVersion, provenance } from './sdk.ts'

test('release provenance requires exact versions and commits', () => {
	const commit = 'a'.repeat(40)
	assert.deepEqual(provenance({ version: '7.0.0-rc14', commit }), { version: '7.0.0-rc14', commit })
	assert.equal(forkVersion('7.0.0-rc14', commit), '7.0.0-rc14-gabriel.aaaaaaaaaaaa')
	assert.throws(() => provenance({ version: 'latest', commit }))
	assert.throws(() => forkVersion('7.0.0', '../outside'))
})

test('proposed upstream changes cannot replace the fork automation', () => {
	assertUpdatePath('src/Socket/chats.ts')
	for (const path of [
		'../outside',
		'/tmp/outside',
		'.github/workflows/publish.yml',
		'maintenance/sdk.ts',
		'upstream.json',
		'OWNED_SDK.md'
	])
		assert.throws(() => assertUpdatePath(path))
})

function fixture() {
	mkdirSync('.tmp', { recursive: true })
	const directory = mkdtempSync(join(process.cwd(), '.tmp/merge-fixture-'))
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
	git('init', '-q')
	git('config', 'user.name', 'Fictional test')
	git('config', 'user.email', 'fictional@example.invalid')
	const original = Array.from({ length: 20 }, (_, i) => `line-${i}`)
	const write = (lines: string[]) => writeFileSync(join(directory, 'source.txt'), lines.join('\n') + '\n')
	write(original)
	mkdirSync(join(directory, '.github/workflows'), { recursive: true })
	writeFileSync(join(directory, '.github/workflows/ci.yml'), 'original workflow\n')
	writeFileSync(join(directory, '.gitignore'), '.tmp/\n')
	git('add', '.')
	git('commit', '-qm', 'base')
	const base = git('rev-parse', 'HEAD')
	git('checkout', '-qb', 'upstream')
	const first = [...original]
	first[18] = 'upstream-first'
	write(first)
	writeFileSync(join(directory, '.github/workflows/ci.yml'), 'upstream workflow\n')
	git('commit', '-qam', 'upstream first')
	const next = git('rev-parse', 'HEAD')
	const second = [...first]
	second[9] = 'upstream-second'
	write(second)
	git('commit', '-qam', 'upstream second')
	const last = git('rev-parse', 'HEAD')
	git('checkout', '-qb', 'fork', base)
	return { directory, git, base, next, last, original, write }
}

test('successive three-way updates preserve fork changes after squash commits and keep owned workflows', () => {
	const f = fixture()
	const ours = [...f.original]
	ours[0] = 'our-feature'
	f.write(ours)
	writeFileSync(join(f.directory, '.github/workflows/ci.yml'), 'our workflow\n')
	f.git('commit', '-qam', 'our feature')
	applyUpstream(f.directory, f.base, f.next)
	f.git('commit', '-qm', 'squashed first update')
	applyUpstream(f.directory, f.next, f.last)
	const result = readFileSync(join(f.directory, 'source.txt'), 'utf8')
	assert.ok(result.includes('our-feature'))
	assert.ok(result.includes('upstream-first'))
	assert.ok(result.includes('upstream-second'))
	assert.equal(readFileSync(join(f.directory, '.github/workflows/ci.yml'), 'utf8'), 'our workflow\n')
})

test('conflicting upstream updates stop without discarding either side', () => {
	const f = fixture()
	const ours = [...f.original]
	ours[18] = 'our-conflicting-feature'
	f.write(ours)
	f.git('commit', '-qam', 'our conflicting feature')
	assert.throws(() => applyUpstream(f.directory, f.base, f.next))
	assert.match(f.git('status', '--porcelain'), /UU source.txt/)
	const result = readFileSync(join(f.directory, 'source.txt'), 'utf8')
	assert.ok(result.includes('our-conflicting-feature'))
	assert.ok(result.includes('upstream-first'))
})
