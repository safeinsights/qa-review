import 'dotenv/config'
import { parseArgs } from '@/cli/args'
import { runCommand } from '@/cli/commands/run'
import { loginCommand } from '@/cli/commands/login'
import { cleanupCommand } from '@/cli/commands/cleanup'
import { codegenCommand } from '@/cli/commands/codegen'
import { listCommand } from '@/cli/commands/list'

const BOOLEANS = ['json', 'headed', 'screencast']

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
        case 'list':
            return listCommand()
        default:
            console.error(`Unknown command "${subcommand ?? ''}". Use: run | login | cleanup | codegen | list`)
            process.exit(1)
    }
}

main().catch((e) => {
    console.error('Error:', (e as Error).message)
    process.exit(1)
})
