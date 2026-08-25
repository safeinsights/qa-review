import { BOOLEANS, parseArgs } from '@/cli/args'
import { accessStatusCommand } from '@/cli/commands/access-status'
import { cleanupCommand } from '@/cli/commands/cleanup'
import { codegenCommand } from '@/cli/commands/codegen'
import { fixAccountCommand } from '@/cli/commands/fix-account'
import { getSecretCommand } from '@/cli/commands/get-secret'
import { inviteCommand } from '@/cli/commands/invite'
import { jiraCommentCommand, jiraDeleteCommentCommand } from '@/cli/commands/jira'
import { listCommand } from '@/cli/commands/list'
import { loginCommand } from '@/cli/commands/login'
import { mailInboxCommand, mailWaitCommand } from '@/cli/commands/mail'
import { migrateCommand } from '@/cli/commands/migrate'
import { openAccessPrCommand } from '@/cli/commands/open-access-pr'
import { rekeyCommand } from '@/cli/commands/rekey'
import { requestAccessCommand } from '@/cli/commands/request-access'
import { runCommand } from '@/cli/commands/run'
import { sessionCommand } from '@/cli/commands/session'
import { sessionCreateStudyCommand } from '@/cli/commands/session-create-study'
import { sessionCreateUserCommand } from '@/cli/commands/session-create-user'
import { sessionLoginCommand } from '@/cli/commands/session-login'
import { sessionSignInCommand } from '@/cli/commands/session-signin'
import { setSecretCommand } from '@/cli/commands/set-secret'
import { shareWorkCommand } from '@/cli/commands/share-work'
import { studyStateCommand } from '@/cli/commands/study-state'
import { syncCommand } from '@/cli/commands/sync'
import { totpCommand } from '@/cli/commands/totp'
import { verdictPostedCommand } from '@/cli/commands/verdict'
import { commandHelp, topLevelHelp, unknownCommandMessage } from '@/cli/help'
import { loadSettings } from '@/engine/settings'

async function main() {
    const [subcommand, ...rest] = process.argv.slice(2)
    const opts = parseArgs(rest, { booleans: BOOLEANS })

    if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
        console.log(topLevelHelp())
        return
    }
    if (opts.help) {
        const text = commandHelp(subcommand)
        if (!text) {
            console.error(unknownCommandMessage(subcommand))
            process.exit(1)
        }
        console.log(text)
        return
    }
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
        case 'access-status':
            return accessStatusCommand(opts)
        case 'open-access-pr':
            return openAccessPrCommand(opts)
        case 'rekey':
            return rekeyCommand()
        case 'set-secret':
            return setSecretCommand(opts)
        case 'get-secret':
            return getSecretCommand(opts, await loadSettings())
        case 'sync':
            return syncCommand()
        case 'share-work':
            return shareWorkCommand(String(opts.description ?? ''))
        case 'session':
            return sessionCommand(opts, await loadSettings())
        case 'session-login':
            return sessionLoginCommand(opts)
        case 'session-signin':
            return sessionSignInCommand(opts)
        case 'session-create-user':
            return sessionCreateUserCommand(opts)
        case 'session-create-study':
            return sessionCreateStudyCommand()
        case 'mail-inbox':
            return mailInboxCommand()
        case 'mail-wait':
            return mailWaitCommand(opts)
        case 'totp':
            return totpCommand(opts, await loadSettings())
        case 'invite':
            return inviteCommand(opts, await loadSettings())
        case 'fix-account':
            return fixAccountCommand(opts, await loadSettings())
        case 'study-state':
            return studyStateCommand(opts, await loadSettings())
        case 'jira-comment':
            return jiraCommentCommand(opts, await loadSettings())
        case 'jira-delete-comment':
            return jiraDeleteCommentCommand(opts, await loadSettings())
        case 'verdict-posted':
            return verdictPostedCommand(opts)
        default:
            console.error(unknownCommandMessage(subcommand))
            process.exit(1)
    }
}

main().catch(e => {
    console.error('Error:', (e as Error).message)
    process.exit(1)
})
