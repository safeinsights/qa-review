import { execFileSync } from 'node:child_process'
import { repoDir } from './paths'

// The version of this tool, read from the git checkout it runs from. The packaged
// app runs the engine from a clone, so git describes it like a dev checkout: a
// bare tag on a release, `<tag>-<n>-g<sha>` past one, `-dirty` with local edits.
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
