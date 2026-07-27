import { readFileSync } from 'node:fs'
import path from 'node:path'
import { chromium } from '@playwright/test'
import { loginAs } from '@/engine/auth'
import { resolveEnv, resolvePrEnv } from '@/engine/env'
import {
    JOB_STATUSES,
    type JobStatus,
    QaApiClient,
    type QaStudyStateUpdate,
    STUDY_STATUSES,
    type StudyStatus,
} from '@/engine/qa-api'
import type { Vars } from '@/engine/settings'

function assertOneOf<T extends string>(value: string, allowed: readonly T[], flag: string): T {
    if (!(allowed as readonly string[]).includes(value)) {
        throw new Error(`${flag} must be one of ${allowed.join(', ')} (got "${value}")`)
    }
    return value as T
}

// Read an artifact to attach. Sent as PLAINTEXT — the server encrypts it to the
// reviewing org, because QA has no enclave to produce ciphertext.
function readArtifact(file: string): { name: string; content: Uint8Array } {
    const resolved = path.resolve(file)
    return { name: path.basename(resolved), content: new Uint8Array(readFileSync(resolved)) }
}

// `qar study-state --study <id> [--env <e> | --pr <n>] [--status <s>] [--job-status <s>]
//                 [--result <file>] [--log <file>]`
//
// Drive a study and its latest job to a given state, optionally attaching result/log
// artifacts — without an enclave run. Reaching "results are back and awaiting review"
// normally needs a real run that takes minutes, and on a PR preview can't happen at
// all (no compute backend), so this is the only way to reach it there.
//
// Omitted fields are left untouched. Setting nothing at all is an error, not a no-op.
export async function studyStateCommand(opts: Record<string, string>, vars: Vars): Promise<void> {
    const studyId = opts.study
    if (!studyId) throw new Error('study-state requires --study <id>')

    const update: QaStudyStateUpdate = {}
    if (opts.status) {
        update.studyStatus = assertOneOf<StudyStatus>(opts.status, STUDY_STATUSES, '--status')
    }
    if (opts['job-status']) {
        update.jobStatus = assertOneOf<JobStatus>(opts['job-status'], JOB_STATUSES, '--job-status')
    }
    if (opts.result) update.result = readArtifact(opts.result)
    if (opts.log) update.log = readArtifact(opts.log)

    if (Object.keys(update).length === 0) {
        throw new Error(
            'nothing to do — pass at least one of --status, --job-status, --result, --log'
        )
    }

    const env = opts.pr ? resolvePrEnv(Number(opts.pr), vars) : resolveEnv(opts.env ?? 'qa', vars)

    // The endpoint authorizes with an SI-admin Clerk session JWT, which loginAs returns.
    const browser = await chromium.launch({ channel: 'chrome' })
    const context = await browser.newContext({ baseURL: env.baseURL })
    const page = await context.newPage()
    let token: string
    try {
        token = await loginAs(page, env, 'admin')
    } finally {
        await context.close()
        await browser.close()
    }
    if (!token) {
        throw new Error('could not read an admin Clerk session token — cannot call the QA API')
    }

    const api = new QaApiClient(env.baseURL, token)
    const result = await api.setStudyState(studyId, update)
    process.stdout.write(`${JSON.stringify(result)}\n`)
}
