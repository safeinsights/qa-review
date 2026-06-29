import 'dotenv/config'
import { resolvePrEnv } from '@/engine/env'
import { runEngine, defaultDeps } from '@/engine/run'
import type { Role } from '@/engine/types'

// Ad-hoc runner for driving a suite against a PR preview without the interactive
// CLI (handy for scripted / non-TTY runs). Usage:
//   tsx bin/run-pr.ts <prNumber> <role> <suite>
async function main() {
    const [prArg, roleArg = 'admin', suiteArg = 'signin'] = process.argv.slice(2)
    const prNumber = Number(prArg)
    const envConfig = resolvePrEnv(prNumber)
    console.log(`Running "${suiteArg}" as ${roleArg} on ${envConfig.baseURL}\n`)

    const result = await runEngine(
        { suite: suiteArg, env: envConfig.name, role: roleArg as Role, envConfig },
        defaultDeps(),
    )

    console.log('--- Result ---')
    for (const s of result.steps) {
        const mark = s.status === 'passed' ? 'PASS' : s.status === 'failed' ? 'FAIL' : '...'
        console.log(mark, s.name, s.error ? `:: ${s.error}` : '')
    }
    console.log(`\nok: ${result.ok} | category: ${result.failureCategory ?? '-'}`)
    console.log(`cleanup ok: ${result.cleanup.ok}`)
    if (!result.cleanup.ok) {
        console.log(`cleanup failed: ${result.cleanup.failed.join(', ')}`)
        if (result.cleanup.statuses) console.log(`cleanup statuses: ${JSON.stringify(result.cleanup.statuses)}`)
    }
    console.log(`report: ${result.bundleDir}/report.html`)
}

main().catch((e) => {
    console.error('Error:', e.message)
    process.exit(1)
})
