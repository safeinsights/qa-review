#!/usr/bin/env tsx
import { spawnSync } from 'node:child_process'
import { renameSync } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
/**
 * Interactive release script: build the macOS .dmg and publish a GitHub release.
 *
 *   pnpm release
 *
 * 1. Fetches the latest GitHub release to suggest the next version.
 * 2. Prompts you to confirm or edit the version (semver, no leading "v").
 * 3. Runs `make dmg` (full signed + notarized build).
 * 4. Renames the output to qa-runner-<version>.dmg.
 * 5. Creates a GitHub release tagged v<version> and uploads the .dmg.
 */
import * as clack from '@clack/prompts'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const DMG_SRC = path.join(ROOT, 'gui', 'build', 'qa-runner.dmg')

function run(cmd: string, opts: { cwd?: string; stdio?: 'inherit' | 'pipe' } = {}) {
    return spawnSync(cmd, { shell: true, cwd: ROOT, stdio: 'pipe', ...opts })
}

function latestTag(): string | null {
    const r = run('gh release list --limit 1 --json tagName --jq ".[0].tagName"')
    const tag = r.stdout?.toString().trim()
    return tag && tag !== 'null' ? tag : null
}

function suggestNext(tag: string | null): string {
    if (!tag) return '0.0.1'
    const match = tag.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/)
    if (!match) return '0.0.1'
    return `${match[1]}.${match[2]}.${parseInt(match[3], 10) + 1}`
}

async function main() {
    clack.intro('QA Runner — release')

    // 1. Suggest next version
    const latest = latestTag()
    const suggested = suggestNext(latest)
    if (latest) {
        clack.log.info(`Latest release: ${latest}`)
    } else {
        clack.log.info('No existing releases found.')
    }

    const version = await clack.text({
        message: 'Version to release:',
        placeholder: suggested,
        defaultValue: suggested,
        validate: v => {
            const s = v || suggested
            if (!/^\d+\.\d+\.\d+$/.test(s)) return 'Must be semver (e.g. 1.2.3), no leading "v"'
        },
    })
    if (clack.isCancel(version)) {
        clack.cancel('Cancelled.')
        process.exit(0)
    }

    const tag = `v${version}`
    const dmgOut = path.join(ROOT, 'gui', 'build', `qa-runner-${version}.dmg`)

    const confirmed = await clack.confirm({
        message: `Build and release ${tag}?`,
    })
    if (clack.isCancel(confirmed) || !confirmed) {
        clack.cancel('Cancelled.')
        process.exit(0)
    }

    // 2. Build
    const buildSpinner = clack.spinner()
    buildSpinner.start('Running make dmg…')
    const build = run('make dmg', { stdio: 'inherit' })
    if (build.status !== 0) {
        buildSpinner.stop('Build failed.')
        process.exit(1)
    }
    buildSpinner.stop('Build complete.')

    await access(DMG_SRC).catch(() => {
        clack.log.error(`Expected DMG not found: ${DMG_SRC}`)
        process.exit(1)
    })

    // 3. Rename
    renameSync(DMG_SRC, dmgOut)
    clack.log.step(`Renamed → gui/build/qa-runner-${version}.dmg`)

    // 4. Create GitHub release + upload
    const releaseSpinner = clack.spinner()
    releaseSpinner.start(`Creating GitHub release ${tag}…`)
    const release = run(
        `gh release create ${tag} "${dmgOut}" --title "${tag}" --notes "" --latest`,
        { stdio: 'inherit' }
    )
    if (release.status !== 0) {
        releaseSpinner.stop('GitHub release failed.')
        process.exit(1)
    }
    releaseSpinner.stop(`Released ${tag}.`)

    // 5. Print the release URL
    const urlResult = run(`gh release view ${tag} --json url --jq .url`)
    const url = urlResult.stdout?.toString().trim()

    clack.outro(url ? `Done: ${url}` : `Done: gh release view ${tag}`)
}

main().catch(e => {
    clack.log.error(String(e))
    process.exit(1)
})
