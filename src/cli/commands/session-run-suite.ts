import { onGuiGone } from '@/engine/gui-parent'
import { dispatchSessionAction } from '@/engine/session-rpc'
import type { Role } from '@/engine/types'

const ROLES: readonly Role[] = ['admin', 'researcher', 'reviewer']

// A whole suite can take as long as the enclave run inside it.
const RUN_SUITE_TIMEOUT_MS = 60 * 60_000

// `qar session-run-suite --suite <name> --role <role>` — run a suite on a running
// `qar session`'s held, streamed browser, so it shows in the GUI's browser pane. The
// session prints the step and result lines (the `qar run --json` format) on its own
// stdout; this prints one line `{ "ok", "bundleDir" }` and exits non-zero when the
// request itself fails (a failed suite is a result, not an error).
export async function sessionRunSuiteCommand(opts: Record<string, string>): Promise<void> {
    const suite = (opts.suite ?? '').trim()
    if (!suite || suite === 'true') throw new Error('session-run-suite requires --suite <name>')
    const role = opts.role as Role
    if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`)
    // The session stops with the app; do not wait out the hour for its answer.
    const unwatch = onGuiGone(() => {
        process.stderr.write('The QA Runner app is gone; the baseline stops with it.\n')
        process.exit(1)
    })
    const result = await dispatchSessionAction(
        { action: 'run-suite', suite, role },
        RUN_SUITE_TIMEOUT_MS,
        `run ${suite}`
    )
    unwatch()
    if (!result.ok) throw new Error(`run-suite failed: ${result.error ?? 'unknown error'}`)
    process.stdout.write(`${JSON.stringify({ ok: result.runOk, bundleDir: result.bundleDir })}\n`)
}
