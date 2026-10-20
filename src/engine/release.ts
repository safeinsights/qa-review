// What management-app build an environment is running, read from its public /about
// page. There is no version endpoint: an unknown route returns the app shell with
// HTTP 200, so a guessed URL "succeeds" and says nothing.
//
// This exists so the validation session can read the release without a blanket
// `Bash(curl:*)` pre-approval, which would also approve `curl -F f=@<any file>`
// to any allowlisted host that accepts uploads.

const REPO_LINK =
    /href="(https:\/\/github\.com\/safeinsights\/management-app\/(commit|releases\/tag)\/([^"/?#]+))"/g
// A row label as the server renders it: `>Release<!-- -->:</div>`.
const LABEL = />([^<>]+?)(?:<!-- -->)?:<\/div>/g

export interface ReleaseRow {
    label: string
    kind: 'commit' | 'tag'
    ref: string
    url: string
}

// Each repo link on the page, named by the nearest row label before it. The page has
// more than one ("Release", "Editor Release"), so the label is what tells them apart.
export function parseReleaseRows(html: string): ReleaseRow[] {
    const labels = [...html.matchAll(LABEL)].map(m => ({ at: m.index ?? 0, text: m[1].trim() }))
    const rows: ReleaseRow[] = []
    for (const link of html.matchAll(REPO_LINK)) {
        const at = link.index ?? 0
        const label = labels.filter(l => l.at < at).at(-1)
        if (!label) continue
        rows.push({
            label: label.text,
            kind: link[2] === 'commit' ? 'commit' : 'tag',
            ref: link[3],
            url: link[1],
        })
    }
    return rows
}

export async function fetchDeployedRelease(
    baseUrl: string
): Promise<{ aboutUrl: string; release: ReleaseRow; rows: ReleaseRow[] }> {
    const aboutUrl = `${baseUrl.replace(/\/+$/, '')}/about`
    let response: Response
    try {
        response = await fetch(aboutUrl)
    } catch (cause) {
        // undici's own message is always "fetch failed"; the real reason is one level down.
        const inner =
            cause instanceof Error ? (cause.cause as NodeJS.ErrnoException | undefined) : undefined
        const reason =
            inner?.code ??
            inner?.message ??
            (cause instanceof Error ? cause.message : String(cause))
        throw new Error(
            `Could not reach ${new URL(aboutUrl).host} (${reason}). Either you are offline, the ` +
                'preview is not deployed, or the command sandbox is blocking the host.',
            { cause }
        )
    }
    if (!response.ok) throw new Error(`${aboutUrl} returned HTTP ${response.status}`)
    const rows = parseReleaseRows(await response.text())
    const release = rows.find(r => r.label === 'Release')
    if (!release) {
        throw new Error(
            `No "Release" row linking to safeinsights/management-app on ${aboutUrl} ` +
                `(rows found: ${rows.map(r => r.label).join(', ') || 'none'})`
        )
    }
    return { aboutUrl, release, rows }
}
