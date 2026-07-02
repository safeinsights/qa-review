import { stdin as input, stdout as output } from 'node:process'
import readline from 'node:readline/promises'
import { resolvePrEnv } from '@/engine/env'
import { defaultDeps, runEngine } from '@/engine/run'
import { loadSettings, type Vars } from '@/engine/settings'
import { listSuites } from '@/engine/suite-registry'
import type { EnvConfig, Role } from '@/engine/types'
import { ENVIRONMENTS } from '../../config/environments'

const ROLES: Role[] = ['admin', 'researcher', 'reviewer']
const PR_PREVIEW_CHOICE = 'PR preview (enter a PR number)'

async function pick(rl: readline.Interface, label: string, options: string[]): Promise<string> {
    console.log(`\n${label}:`)
    options.forEach((o, i) => {
        console.log(`  ${i + 1}. ${o}`)
    })
    while (true) {
        const answer = await rl.question('> ')
        const idx = Number(answer) - 1
        if (idx >= 0 && idx < options.length) return options[idx]
        console.log('Please enter a number from the list.')
    }
}

// Resolve which environment to run against. Named stable envs (qa, staging) are
// resolved by the engine from `env`; a PR preview is resolved here from a number
// and passed as a pre-resolved envConfig.
async function chooseEnv(
    rl: readline.Interface,
    vars: Vars
): Promise<{ env: string; envConfig?: EnvConfig }> {
    const choice = await pick(rl, 'Environment', [
        ...ENVIRONMENTS.map(e => e.name),
        PR_PREVIEW_CHOICE,
    ])
    if (choice !== PR_PREVIEW_CHOICE) return { env: choice }

    while (true) {
        const answer = await rl.question('PR number: ')
        const prNumber = Number(answer.trim())
        if (Number.isInteger(prNumber) && prNumber > 0) {
            const envConfig = resolvePrEnv(prNumber, vars)
            return { env: envConfig.name, envConfig }
        }
        console.log('Please enter a positive PR number.')
    }
}

async function main() {
    const vars = await loadSettings()
    const rl = readline.createInterface({ input, output })
    try {
        const { env, envConfig } = await chooseEnv(rl, vars)
        const role = (await pick(rl, 'Role', ROLES)) as Role
        const suites = await listSuites()
        const suite = await pick(
            rl,
            'Suite',
            suites.map(s => `${s.name} — ${s.description}`)
        )
        const suiteName = suite.split(' — ')[0]

        console.log(`\nRunning "${suiteName}" as ${role} on ${envConfig?.baseURL ?? env}...\n`)
        const deps = defaultDeps(vars)
        const result = await runEngine({ suite: suiteName, env, role, envConfig }, deps)

        console.log('\n--- Result ---')
        for (const s of result.steps) {
            const mark = s.status === 'passed' ? '✓' : s.status === 'failed' ? '✗' : '…'
            console.log(`${mark} ${s.name}${s.error ? ` (${s.error})` : ''}`)
        }
        console.log(result.ok ? '\nPASSED' : `\nFAILED — ${result.failureCategory}`)
        if (!result.cleanup.ok) console.log(`⚠ Cleanup failed: ${result.cleanup.failed.join(', ')}`)
        console.log(`\nReport: ${result.bundleDir}/report.html`)
    } finally {
        rl.close()
    }
}

main().catch(e => {
    console.error('Error:', e.message)
    process.exit(1)
})
