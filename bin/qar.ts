import { booleansFor, parseArgs } from '@/cli/args'
import { accessStatusCommand } from '@/cli/commands/access-status'
import { cleanupCommand } from '@/cli/commands/cleanup'
import { clockCommand } from '@/cli/commands/clock'
import { codegenCommand } from '@/cli/commands/codegen'
import { deployedReleaseCommand } from '@/cli/commands/deployed-release'
import { fixAccountCommand } from '@/cli/commands/fix-account'
import { followupAdviceCommand } from '@/cli/commands/followup-advice'
import { getSecretCommand } from '@/cli/commands/get-secret'
import { inventoryRenderCommand } from '@/cli/commands/inventory-render'
import { inviteCommand } from '@/cli/commands/invite'
import {
    jiraAttachmentsCommand,
    jiraCommentCommand,
    jiraDeleteCommentCommand,
} from '@/cli/commands/jira'
import { jiraCreateIssueCommand } from '@/cli/commands/jira-create-issue'
import { listCommand } from '@/cli/commands/list'
import { loginCommand } from '@/cli/commands/login'
import { mailInboxCommand, mailWaitCommand } from '@/cli/commands/mail'
import { migrateCommand } from '@/cli/commands/migrate'
import { openAccessPrCommand } from '@/cli/commands/open-access-pr'
import { planLinesCommand } from '@/cli/commands/plan-lines'
import { rekeyCommand } from '@/cli/commands/rekey'
import {
    releaseDownloadCommand,
    releaseListCommand,
    releasePrsCommand,
    releaseStatusCommand,
    releaseUploadCommand,
} from '@/cli/commands/release'
import { releaseSavedCommand } from '@/cli/commands/release-saved'
import { requestAccessCommand } from '@/cli/commands/request-access'
import { resultsCheckCommand } from '@/cli/commands/results-check'
import { resultsRenderCommand } from '@/cli/commands/results-render'
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
    const opts = parseArgs(rest, { booleans: booleansFor(subcommand) })

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
        case 'deployed-release':
            return deployedReleaseCommand(opts, await loadSettings())
        case 'jira-comment':
            return jiraCommentCommand(opts, await loadSettings())
        case 'jira-attachments':
            return jiraAttachmentsCommand(opts, await loadSettings())
        case 'jira-create-issue':
            return jiraCreateIssueCommand(opts, await loadSettings())
        case 'jira-delete-comment':
            return jiraDeleteCommentCommand(opts, await loadSettings())
        case 'verdict-posted':
            return verdictPostedCommand(opts)
        case 'followup-advice':
            return followupAdviceCommand(opts)
        case 'inventory-render':
            return inventoryRenderCommand(opts)
        case 'results-check':
            return resultsCheckCommand(opts)
        case 'plan-lines':
            return planLinesCommand(opts)
        case 'release-list':
            return releaseListCommand(opts, await loadSettings())
        case 'release-prs':
            return releasePrsCommand(opts, await loadSettings())
        case 'release-status':
            return releaseStatusCommand(opts, await loadSettings())
        case 'release-download':
            return releaseDownloadCommand(opts, await loadSettings())
        case 'release-upload':
            return releaseUploadCommand(opts, await loadSettings())
        case 'release-saved':
            return releaseSavedCommand(opts)
        case 'results-render':
            return resultsRenderCommand(opts, await loadSettings())
        case 'clock':
            return clockCommand(opts)
        default:
            console.error(unknownCommandMessage(subcommand))
            process.exit(1)
    }
}

main().catch(e => {
    console.error('Error:', (e as Error).message)
    process.exit(1)
})
