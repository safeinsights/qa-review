import { parseArgs } from '@/cli/args'
import { cleanupCommand } from '@/cli/commands/cleanup'
import { codegenCommand } from '@/cli/commands/codegen'
import { jiraCommentCommand, jiraDeleteCommentCommand } from '@/cli/commands/jira'
import { listCommand } from '@/cli/commands/list'
import { loginCommand } from '@/cli/commands/login'
import { mailInboxCommand, mailWaitCommand } from '@/cli/commands/mail'
import { migrateCommand } from '@/cli/commands/migrate'
import { rekeyCommand } from '@/cli/commands/rekey'
import { requestAccessCommand } from '@/cli/commands/request-access'
import { runCommand } from '@/cli/commands/run'
import { sessionCommand } from '@/cli/commands/session'
import { sessionCreateStudyCommand } from '@/cli/commands/session-create-study'
import { sessionCreateUserCommand } from '@/cli/commands/session-create-user'
import { sessionLoginCommand } from '@/cli/commands/session-login'
import { setSecretCommand } from '@/cli/commands/set-secret'
import { syncCommand } from '@/cli/commands/sync'
import { totpCommand } from '@/cli/commands/totp'
import { loadSettings } from '@/engine/settings'

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
        case 'request-access':
            return requestAccessCommand(opts)
        case 'rekey':
            return rekeyCommand()
        case 'set-secret':
            return setSecretCommand(opts)
        case 'sync':
            return syncCommand()
        case 'session':
            return sessionCommand(opts, await loadSettings())
        case 'session-login':
            return sessionLoginCommand(opts)
        case 'session-create-user':
            return sessionCreateUserCommand(opts)
        case 'session-create-study':
            return sessionCreateStudyCommand()
        case 'mail-inbox':
            return mailInboxCommand()
        case 'mail-wait':
            return mailWaitCommand(opts)
        case 'totp':
            return totpCommand(opts)
        case 'jira-comment':
            return jiraCommentCommand(opts)
        case 'jira-delete-comment':
            return jiraDeleteCommentCommand(opts)
        default:
            console.error(
                `Unknown command "${subcommand ?? ''}". Use: run | login | cleanup | codegen | list | migrate | request-access | rekey | set-secret | sync | session | session-login | session-create-user | session-create-study | mail-inbox | mail-wait | totp | jira-comment | jira-delete-comment`
            )
            process.exit(1)
    }
}

main().catch(e => {
    console.error('Error:', (e as Error).message)
    process.exit(1)
})
