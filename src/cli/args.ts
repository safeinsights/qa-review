export interface ParseArgsOptions {
    booleans: string[]
}

// Minimal `--key value` / `--bool` parser. Returns a flat string map. Boolean
// flags (listed in options.booleans) take no value and resolve to 'true'.
export function parseArgs(argv: string[], options: ParseArgsOptions): Record<string, string> {
    const out: Record<string, string> = {}
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i]
        if (!token.startsWith('--')) continue
        const key = token.slice(2)
        if (options.booleans.includes(key)) {
            out[key] = 'true'
        } else {
            out[key] = argv[++i] ?? ''
        }
    }
    return out
}
