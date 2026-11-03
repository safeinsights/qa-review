import fs from 'node:fs'
import { releaseSavedPath, resultsRoot } from '@/engine/paths'

// `qar release-saved --tag <tag> --asset <name> [--url <url>]` — tell the GUI an
// asset was uploaded. Claude runs it right after `qar release-upload`.
export async function releaseSavedCommand(opts: Record<string, string>): Promise<void> {
    const tag = (opts.tag ?? '').trim()
    if (!tag || tag === 'true') throw new Error('release-saved requires --tag <tag>')
    const asset = (opts.asset ?? '').trim()
    if (!asset || asset === 'true') throw new Error('release-saved requires --asset <name>')
    const url = (opts.url ?? '').trim()
    fs.mkdirSync(resultsRoot(), { recursive: true })
    const tmp = `${releaseSavedPath()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ tag, asset, url: url === 'true' ? '' : url }))
    fs.renameSync(tmp, releaseSavedPath())
    process.stdout.write(`${JSON.stringify({ tag, asset, url })}\n`)
}
