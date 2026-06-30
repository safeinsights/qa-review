import 'dotenv/config'
import { parseArgs } from '@/cli/args'
import { runCommand } from '@/cli/commands/run'
import { loginCommand } from '@/cli/commands/login'
import { cleanupCommand } from '@/cli/commands/cleanup'
import { codegenCommand } from '@/cli/commands/codegen'

const BOOLEANS = ['json', 'headed']

async function main() {
    const [subcommand, ...rest] = process.argv.slice(2)
    const opts = parseArgs(rest, { booleans: BOOLEANS })
    switch (subcommand) {
        case 'run':
            return runCommand(opts)
        case 'login':
            return loginCommand(opts)
        case 'cleanup':
            return cleanupCommand(opts)
        case 'codegen':
            return codegenCommand(opts)
        default:
            console.error(`Unknown command "${subcommand ?? ''}". Use: run | login | cleanup | codegen`)
            process.exit(1)
    }
}

main().catch((e) => {
    console.error('Error:', (e as Error).message)
    process.exit(1)
})
