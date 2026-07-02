import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseTrace } from '@/codegen/action-trace'
import { generateSuite } from '@/codegen/generate-suite'
import { repoDir } from '@/engine/paths'
import { discoverSuites } from '@/suites/discover'

// Repo root for writing the generated suite into src/suites. In the packaged app
// this is the cloned repo (QAR_REPO_DIR); for `pnpm qar` it's this checkout.
const REPO_ROOT = repoDir()

export async function codegenCommand(opts: Record<string, string>): Promise<void> {
    if (!opts.trace) {
        console.error('Usage: qar codegen --trace <path> [--out <file>]')
        process.exit(1)
    }
    const raw = fs.readFileSync(opts.trace, 'utf8')
    const trace = parseTrace(raw)

    // Suite names become a filename + a TS identifier; restrict to a safe charset
    // so a bad name can't write outside src/suites or break codegen.
    if (!/^[a-z0-9-]+$/i.test(trace.name)) {
        console.error(`Invalid suite name "${trace.name}". Use letters, digits, and hyphens only.`)
        process.exit(1)
    }

    const outPath = opts.out ?? path.join(REPO_ROOT, 'src', 'suites', `${trace.name}.ts`)

    fs.writeFileSync(outPath, generateSuite(trace))
    console.log(`wrote ${outPath}`)

    // Validate the generated suite by importing it (tsx transpiles the .ts on the
    // fly — no compile step). An import error (bad syntax) or a missing Suite export
    // means the generated suite is bad — remove it and fail, preserving the previous
    // "generated suite failed; removed it" UX.
    try {
        const found = await discoverSuites([pathToFileURL(outPath).href], f => import(f))
        if (!found.length) throw new Error('no Suite export found')
    } catch (e) {
        fs.rmSync(outPath, { force: true })
        console.error(`Generated suite failed to load; removed it.\n${(e as Error).message}`)
        process.exit(1)
    }
    console.log(`ok: ${outPath} validated`)
}
