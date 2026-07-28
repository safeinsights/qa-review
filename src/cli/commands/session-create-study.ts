import { newRequestId, waitForSessionResult, writeSessionRequest } from '@/engine/session-rpc'

// `qar session-create-study` — create a study proposal from scratch on a running
// `qar session`'s held (streamed) browser: log in as researcher, then fill and submit
// a full proposal (org + language, title, dataset, the Lexical fields, PI). Prints
// one JSON line `{ "studyId" }` so Claude can track it for cleanup
// (`qar cleanup --studies <id>`). Exits non-zero on failure so Claude can react.
// Reuses the exact tested create-study flow — no MCP hand-driving.
export async function sessionCreateStudyCommand(): Promise<void> {
    const id = newRequestId()
    writeSessionRequest(id, { action: 'create-study' })

    // Researcher login + the multi-step proposal form; allow a generous window.
    const result = await waitForSessionResult(id, 120_000)
    if (!result) {
        throw new Error(
            'timed out waiting for the session to create the study — is a `qar session` running?'
        )
    }
    if (!result.ok) {
        throw new Error(`create-study failed: ${result.error ?? 'unknown error'}`)
    }
    process.stdout.write(`${JSON.stringify({ studyId: result.studyId })}\n`)
}
