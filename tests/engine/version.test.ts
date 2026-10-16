import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toolVersion, versionLine } from '@/engine/version'

function git(dir: string, ...args: string[]): string {
    return execFileSync(
        'git',
        [
            '-c',
            'user.name=t',
            '-c',
            'user.email=t@t',
            '-c',
            'commit.gpgsign=false',
            '-c',
            'tag.gpgsign=false',
            ...args,
        ],
        {
            cwd: dir,
            encoding: 'utf8',
        }
    ).trim()
}

describe('toolVersion', () => {
    const dirs: string[] = []
    afterEach(() => {
        for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    function repo(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-ver-'))
        dirs.push(dir)
        git(dir, 'init', '-q')
        git(dir, 'commit', '-q', '--allow-empty', '-m', 'one')
        git(dir, 'tag', 'v1.0.0')
        return dir
    }

    it('reports the tag when HEAD is a release', () => {
        const dir = repo()
        expect(toolVersion(dir)).toEqual({
            describe: 'v1.0.0',
            sha: git(dir, 'rev-parse', '--short', 'HEAD'),
            release: 'v1.0.0',
        })
    })

    it('reports commits past the tag and no release otherwise', () => {
        const dir = repo()
        git(dir, 'commit', '-q', '--allow-empty', '-m', 'two')
        const v = toolVersion(dir)
        expect(v?.describe).toMatch(/^v1\.0\.0-1-g[0-9a-f]+$/)
        expect(v?.release).toBeUndefined()
    })

    it('marks a working tree with uncommitted changes', () => {
        const dir = repo()
        fs.writeFileSync(path.join(dir, 'x'), 'x')
        git(dir, 'add', 'x')
        expect(toolVersion(dir)?.describe).toBe('v1.0.0-dirty')
    })

    it('is undefined outside a git checkout', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qar-nover-'))
        dirs.push(dir)
        expect(toolVersion(dir)).toBeUndefined()
    })
})

describe('versionLine', () => {
    it('links a release to its GitHub release page', () => {
        expect(versionLine({ describe: 'v0.2.1', sha: 'abc1234', release: 'v0.2.1' })).toBe(
            'Posted by qa-review [v0.2.1](https://github.com/safeinsights/qa-review/releases/tag/v0.2.1)'
        )
    })

    it('links a commit past the release to the commit', () => {
        expect(versionLine({ describe: 'v0.2.1-32-gabc1234-dirty', sha: 'abc1234' })).toBe(
            'Posted by qa-review [v0.2.1-32-gabc1234-dirty](https://github.com/safeinsights/qa-review/commit/abc1234)'
        )
    })

    it('names the tool without a link when the version is unknown', () => {
        expect(versionLine(undefined)).toBe('Posted by qa-review (version unknown)')
    })
})
