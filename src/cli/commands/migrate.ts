import * as fs from 'node:fs'
import * as path from 'node:path'
import { configDir, knownVarNames, LOCAL_FILE } from '@/engine/settings'
import { emailVar, mfaCodeVar, passwordVar, SHARED_ACCOUNTS } from '../../../config/environments'

// Minimal .env parser: KEY=VALUE per line, ignores blanks and # comments, strips
// surrounding quotes. Enough to migrate the old qar .env; not a full dotenv.
function parseEnvFile(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('#')) continue
        const eq = line.indexOf('=')
        if (eq === -1) continue
        const key = line.slice(0, eq).trim()
        let value = line.slice(eq + 1).trim()
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1)
        }
        if (key) out[key] = value
    }
    return out
}

// One-time migration: read the legacy .env (repo root) and write its known,
// non-empty values into config/settings.local.json (plaintext, gitignored) so
// existing users keep running without reconfiguring. Shared secrets can later be
// encrypted project-wide via the Settings panel.
export async function migrateCommand(opts: Record<string, string>): Promise<void> {
    const envPath = opts.from ?? path.resolve(configDir(), '..', '.env')
    if (!fs.existsSync(envPath)) {
        console.error(`No .env found at ${envPath}. Nothing to migrate.`)
        process.exitCode = 1
        return
    }

    const parsed = parseEnvFile(fs.readFileSync(envPath, 'utf8'))
    const known = new Set(knownVarNames())
    const migrated: Record<string, string> = {}
    const skipped: string[] = []
    for (const [key, value] of Object.entries(parsed)) {
        if (!value) continue
        if (known.has(key)) migrated[key] = value
        else skipped.push(key)
    }

    // Accounts used to be shared across envs with un-suffixed vars (<ROLE>_EMAIL,
    // <ROLE>_PASSWORD, and a single global MFA_CODE); they are now per-account AND
    // per-env. Legacy .env setups used the same values on qa and staging, so fan
    // each legacy value out to that account's qa + staging vars that weren't set
    // explicitly. (production uses different accounts / a TOTP seed, so it's
    // intentionally excluded — set it in the Accounts panel.)
    const unSuffix = (v: string): void => {
        const idx = skipped.indexOf(v)
        if (idx !== -1) skipped.splice(idx, 1)
    }
    for (const a of Object.values(SHARED_ACCOUNTS)) {
        const legacyEmail = parsed[a.emailPrefix]
        const legacyPassword = parsed[a.passwordPrefix]
        const legacyMfa = parsed.MFA_CODE
        for (const env of ['qa', 'staging'] as const) {
            if (legacyEmail && !migrated[emailVar(a, env)]) migrated[emailVar(a, env)] = legacyEmail
            if (legacyPassword && !migrated[passwordVar(a, env)])
                migrated[passwordVar(a, env)] = legacyPassword
            if (legacyMfa && !migrated[mfaCodeVar(a, env)]) migrated[mfaCodeVar(a, env)] = legacyMfa
        }
        if (legacyEmail) unSuffix(a.emailPrefix)
        if (legacyPassword) unSuffix(a.passwordPrefix)
    }
    if (parsed.MFA_CODE) unSuffix('MFA_CODE')

    const localPath = path.join(configDir(), LOCAL_FILE)
    const existing: Record<string, string> = fs.existsSync(localPath)
        ? (JSON.parse(fs.readFileSync(localPath, 'utf8') || '{}') as Record<string, string>)
        : {}
    const merged = { ...existing, ...migrated }
    fs.writeFileSync(localPath, `${JSON.stringify(merged, null, 2)}\n`)

    console.log(`Migrated ${Object.keys(migrated).length} value(s) into ${localPath}`)
    console.log(`Keys: ${Object.keys(migrated).join(', ') || '(none)'}`)
    if (skipped.length) console.log(`Ignored unknown keys: ${skipped.join(', ')}`)
    console.log('\nNext: run `qar request-access --name "..."` (or the Settings ▸ Request')
    console.log('access button) to get an identity, then save the shared accounts as')
    console.log('"Project (encrypted)" to commit them — they encrypt to the team keyring.')
}
