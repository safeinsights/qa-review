import type { Role } from '@/engine/types'

// Committed declaration of which environments exist and which env-var holds each
// value. NO secrets here — only the *names* of the env vars to read from .env.
// resolveEnv() (Task 4) merges this with process.env.
export interface EnvDeclaration {
    name: string
    baseUrlVar: string
    accounts: Record<Role, { emailVar: string; passwordVar: string }>
}

export const ENVIRONMENTS: EnvDeclaration[] = [
    {
        name: 'qa',
        baseUrlVar: 'QA_BASE_URL',
        accounts: {
            admin: { emailVar: 'QA_ADMIN_EMAIL', passwordVar: 'QA_ADMIN_PASSWORD' },
            researcher: { emailVar: 'QA_RESEARCHER_EMAIL', passwordVar: 'QA_RESEARCHER_PASSWORD' },
            reviewer: { emailVar: 'QA_REVIEWER_EMAIL', passwordVar: 'QA_REVIEWER_PASSWORD' },
        },
    },
    {
        name: 'staging',
        baseUrlVar: 'STAGING_BASE_URL',
        accounts: {
            admin: { emailVar: 'STAGING_ADMIN_EMAIL', passwordVar: 'STAGING_ADMIN_PASSWORD' },
            researcher: { emailVar: 'STAGING_RESEARCHER_EMAIL', passwordVar: 'STAGING_RESEARCHER_PASSWORD' },
            reviewer: { emailVar: 'STAGING_REVIEWER_EMAIL', passwordVar: 'STAGING_REVIEWER_PASSWORD' },
        },
    },
]
