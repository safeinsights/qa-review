import 'dotenv/config'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { ENVIRONMENTS } from '../../config/environments'
import { listSuites } from '@/engine/suite-registry'
import { runEngine, defaultDeps } from '@/engine/run'
import type { Role } from '@/engine/types'

const ROLES: Role[] = ['admin', 'researcher', 'reviewer']

async function pick(rl: readline.Interface, label: string, options: string[]): Promise<string> {
    console.log(`\n${label}:`)
    options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`))
    while (true) {
        const answer = await rl.question('> ')
        const idx = Number(answer) - 1
        if (idx >= 0 && idx < options.length) return options[idx]
        console.log('Please enter a number from the list.')
    }
}

async function main() {
    const rl = readline.createInterface({ input, output })
    try {
        const env = await pick(rl, 'Environment', ENVIRONMENTS.map((e) => e.name))
        const role = (await pick(rl, 'Role', ROLES)) as Role
        const suites = listSuites()
        const suite = await pick(rl, 'Suite', suites.map((s) => `${s.name} — ${s.description}`))
        const suiteName = suite.split(' — ')[0]

        console.log(`\nRunning "${suiteName}" as ${role} on ${env}...\n`)
        const deps = defaultDeps()
        const result = await runEngine({ suite: suiteName, env, role }, deps)

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

main().catch((e) => {
    console.error('Error:', e.message)
    process.exit(1)
})
