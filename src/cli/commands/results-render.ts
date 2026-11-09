import fs from 'node:fs'
import path from 'node:path'
import type { Inventory } from '@/engine/inventory'
import { releaseDir, resultsAssetName, securityResultsFile } from '@/engine/release-paths'
import {
    hasSecurityResults,
    renderResults,
    renderSecurityResults,
    secretValues,
} from '@/engine/release-results'
import type { ResultEntry } from '@/engine/results'
import type { Vars } from '@/engine/settings'

// `qar results-render --tag <tag> --env <env> --plan <plan-lines.json> --results <results.json>
//     [--page-url <url>]` — the url is the private Confluence page (release-confluence).
// Writes .tmp/release/<tag>/<regression-results-<env>-<stamp>.md> without any S- line
// (management-app is public), and, when the run has S- results, the local-only
// security-results-<env>.md. Prints {"output","asset","securityOutput"}; release-upload
// takes `output`, and `securityOutput` is "" when there is none.
export async function resultsRenderCommand(
    opts: Record<string, string>,
    vars: Vars
): Promise<void> {
    const need = (k: string) => {
        const v = (opts[k] ?? '').trim()
        if (!v || v === 'true') throw new Error(`results-render requires --${k}`)
        return v
    }
    const tag = need('tag')
    const env = need('env')
    const plan = JSON.parse(fs.readFileSync(need('plan'), 'utf8')) as Inventory
    const parsed = JSON.parse(fs.readFileSync(need('results'), 'utf8')) as {
        results?: ResultEntry[]
    }
    if (!Array.isArray(parsed.results))
        throw new Error('--results JSON must have a "results" array')
    const input = {
        tag,
        env,
        plan,
        results: parsed.results,
        secrets: secretValues(vars),
        now: new Date(),
        pageUrl: (opts['page-url'] ?? '').trim() || undefined,
    }
    const dir = releaseDir(tag)
    fs.mkdirSync(dir, { recursive: true })
    const output = path.join(dir, resultsAssetName(env, input.now))
    fs.writeFileSync(output, renderResults({ ...input, publicOnly: true }))
    let securityOutput = ''
    if (hasSecurityResults(input.results)) {
        securityOutput = path.join(dir, securityResultsFile(env))
        fs.writeFileSync(securityOutput, renderSecurityResults(input))
    }
    process.stdout.write(
        `${JSON.stringify({ output, asset: path.basename(output), securityOutput })}\n`
    )
}
