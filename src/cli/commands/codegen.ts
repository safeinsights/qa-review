import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { parseTrace } from '@/codegen/action-trace'
import { generateSuite } from '@/codegen/generate-suite'

// Repo root, anchored to this file's location (src/cli/commands -> ../../..).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

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

    try {
        execFileSync('pnpm', ['typecheck'], { stdio: 'pipe', cwd: REPO_ROOT })
    } catch (e) {
        fs.rmSync(outPath, { force: true })
        const err = e as { stdout?: Buffer; stderr?: Buffer }
        const detail = err.stdout?.toString() || err.stderr?.toString() || (e as Error).message
        console.error('Generated suite failed typecheck; removed it.\n' + detail)
        process.exit(1)
    }
    console.log(`ok: ${outPath} typechecks`)
}
