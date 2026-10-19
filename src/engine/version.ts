import { execFileSync } from 'node:child_process'
import { repoDir } from './paths'

// The version of this tool, read from the repo checkout (`repoDir()`): a bare tag
// on a release, `<tag>-<n>-g<sha>` past one, `-dirty` with local edits. In the
// packaged app that is the CLONE, not the engine: the engine runs from the bundle
// in Resources/engine, and only suites, skills and config come from the clone. The
// clone can be ahead of the bundle, so this names the skill text that drove the
// session rather than the engine code that posted.
export const QA_REVIEW_REPO = 'https://github.com/safeinsights/qa-review'

export interface ToolVersion {
    describe: string
    sha: string
    // Set only when HEAD is exactly a release tag.
    release?: string
}

function git(dir: string, ...args: string[]): string {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

export function toolVersion(dir: string = repoDir()): ToolVersion | undefined {
    try {
        const describe = git(dir, 'describe', '--tags', '--always', '--dirty')
        const sha = git(dir, 'rev-parse', '--short', 'HEAD')
        let release: string | undefined
        try {
            release = git(dir, 'describe', '--tags', '--exact-match')
        } catch {
            release = undefined
        }
        return release ? { describe, sha, release } : { describe, sha }
    } catch {
        return undefined
    }
}

// The last line of every posted comment, so a reader knows which build of the
// validator wrote it.
export function versionLine(version: ToolVersion | undefined): string {
    if (!version) return 'Posted by qa-review (version unknown)'
    const url = version.release
        ? `${QA_REVIEW_REPO}/releases/tag/${version.release}`
        : `${QA_REVIEW_REPO}/commit/${version.sha}`
    return `Posted by qa-review [${version.describe}](${url})`
}
