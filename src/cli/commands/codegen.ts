import fs from 'node:fs'
import path from 'node:path'
import { parseTrace } from '@/codegen/action-trace'
import { generateSuite } from '@/codegen/generate-suite'
import { repoDir, suitesCompiledDir } from '@/engine/paths'
import { compileSuite } from '@/cli/commands/build-suites'

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

    // Compile the generated suite to suites-compiled/<name>.mjs so the bundled
    // engine can load it without a TS toolchain. A compile (i.e. type/syntax)
    // error means the generated suite is bad — remove it and fail, preserving the
    // previous "generated suite failed; removed it" UX.
    try {
        await compileSuite(outPath, suitesCompiledDir())
    } catch (e) {
        fs.rmSync(outPath, { force: true })
        console.error('Generated suite failed to compile; removed it.\n' + (e as Error).message)
        process.exit(1)
    }
    console.log(`ok: ${outPath} compiled`)
}
