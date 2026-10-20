import { resolveBaseUrl } from '@/engine/env'
import { fetchDeployedRelease } from '@/engine/release'
import type { Vars } from '@/engine/settings'

// `qar deployed-release (--env <env> | --pr <n>)` — prints the management-app
// release an environment runs, as JSON, for the validation's "is the PR deployed?"
// compare.
export async function deployedReleaseCommand(
    opts: Record<string, string>,
    vars: Vars
): Promise<void> {
    const baseUrl = resolveBaseUrl({ env: opts.env, pr: opts.pr }, vars)
    const { aboutUrl, release, rows } = await fetchDeployedRelease(baseUrl)
    process.stdout.write(`${JSON.stringify({ aboutUrl, ...release, rows })}\n`)
}
