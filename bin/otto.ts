import { parseArgs } from '@/cli/args'
import { loadSettings } from '@/engine/settings'
import { runCommand } from '@/cli/commands/run'
import { loginCommand } from '@/cli/commands/login'
import { cleanupCommand } from '@/cli/commands/cleanup'
import { codegenCommand } from '@/cli/commands/codegen'
import { listCommand } from '@/cli/commands/list'
import { migrateCommand } from '@/cli/commands/migrate'

const BOOLEANS = ['json', 'headed', 'screencast']

async function main() {
    const [subcommand, ...rest] = process.argv.slice(2)
    const opts = parseArgs(rest, { booleans: BOOLEANS })
    // `list` and `codegen` don't touch credentials; the rest resolve config from
    // the layered settings files (replacing the old dotenv-loaded .env).
    switch (subcommand) {
        case 'run':
            return runCommand(opts, await loadSettings())
        case 'login':
            return loginCommand(opts, await loadSettings())
        case 'cleanup':
            return cleanupCommand(opts, await loadSettings())
        case 'codegen':
            return codegenCommand(opts)
        case 'list':
            return listCommand()
        case 'migrate':
            return migrateCommand(opts)
        default:
            console.error(`Unknown command "${subcommand ?? ''}". Use: run | login | cleanup | codegen | list | migrate`)
            process.exit(1)
    }
}

main().catch((e) => {
    console.error('Error:', (e as Error).message)
    process.exit(1)
})
