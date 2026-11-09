import { describe, expect, it } from 'vitest'
import { studyStateCommand } from '@/cli/commands/study-state'
import { JOB_STATUSES } from '@/engine/qa-api'

describe('qar study-state --job-status', () => {
    // The app's QA route accepts CODE-REJECTED since management-app #1279; the CLI used to
    // refuse it client-side, so a code-rejected study could only be built by hand-calling the API.
    it('accepts CODE-REJECTED', () => {
        expect(JOB_STATUSES).toContain('CODE-REJECTED')
    })

    // Validation runs before the admin browser launches, so a typo fails instantly.
    it('rejects an unknown status before doing anything else', async () => {
        await expect(
            studyStateCommand({ study: 's1', 'job-status': 'CODE-DECLINED' }, {})
        ).rejects.toThrow(/--job-status must be one of .*CODE-REJECTED.* \(got "CODE-DECLINED"\)/)
    })
})
