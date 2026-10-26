import path from 'node:path'
import { repoDir } from './paths'

// One directory per release holds everything the plan and run sessions produce.
// It is gitignored (.tmp/) and is also what the GUI editor reads and writes.
export function releaseDir(tag: string): string {
    if (!/^[\w.-]+$/.test(tag)) throw new Error(`"${tag}" is not a release tag`)
    return path.join(repoDir(), '.tmp', 'release', tag)
}

export const PLAN_FILE = 'plan.md'
export const PLAN_ASSET = 'regression-plan.md'
export const PLAN_LINES_FILE = 'plan-lines.json'
export const PRS_FILE = 'prs.json'

export function resultsFile(env: string): string {
    return `results-${env}.json`
}

// The asset name for one run. The stamp is what keeps runs from replacing each
// other; the env is in the name so History can group without opening the file.
export function resultsAssetName(env: string, when: Date): string {
    const p = (n: number) => String(n).padStart(2, '0')
    const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}`
    return `regression-results-${env}-${stamp}.md`
}
