import type { Page } from '@playwright/test'
import { resultLine, stepLine } from '@/cli/step-stream'
import { defaultDeps, type RunDeps, runEngine } from '@/engine/run'
import type { Vars } from '@/engine/settings'
import type { EnvConfig, Role, RunResult } from '@/engine/types'

// Run a suite on a page the caller holds: `qar session`'s streamed page, so the run
// shows in the GUI's browser pane instead of in a browser of its own. The run's
// step and result lines are the ones `qar run --json` prints; the GUI already reads
// that format.
export async function runSuiteOnPage(
    page: Page,
    cdpPort: number,
    env: EnvConfig,
    vars: Vars,
    request: { suite: string; role: Role },
    write: (line: string) => void = line => process.stdout.write(line)
): Promise<RunResult> {
    const deps: RunDeps = {
        ...defaultDeps(vars),
        // The session owns the browser: no trace, no video, and close() keeps it open.
        openBrowser: async () => ({ page, cookieHeader: '', cdpPort, close: async () => {} }),
        onStep: event => write(stepLine(event)),
    }
    const result = await runEngine(
        { suite: request.suite, env: env.name, role: request.role, envConfig: env },
        deps
    )
    write(resultLine(result))
    return result
}
