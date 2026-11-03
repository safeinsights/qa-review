import fs from 'node:fs'
import path from 'node:path'
import { assertOk, authHeader, type JiraConfig, jiraFetch } from './jira'

// Confluence Cloud on the same Atlassian site as Jira. The Jira API token is an
// account token, so it works here too: no second secret.

export interface ConfluencePage {
    id: string
    title: string
    version: number
    url: string
}

function headers(config: JiraConfig): Record<string, string> {
    return {
        Authorization: authHeader(config),
        Accept: 'application/json',
        'Content-Type': 'application/json',
    }
}

// By id, not the title slug Confluence links to: a title can change (a republish, an
// edit), and a link on a Jira card must keep working.
function pageUrl(config: JiraConfig, id: string): string {
    return `${config.baseUrl}/wiki/pages/viewpage.action?pageId=${id}`
}

interface RawPage {
    id: string
    title: string
    version?: { number: number }
    _links?: { webui?: string }
}

function toPage(config: JiraConfig, raw: RawPage): ConfluencePage {
    return {
        id: raw.id,
        title: raw.title,
        version: raw.version?.number ?? 1,
        url: pageUrl(config, raw.id),
    }
}

// The folder the release pages live under (RELEASE_CONFLUENCE_FOLDER). Its space is
// where every page is created.
export async function folderById(
    config: JiraConfig,
    id: string
): Promise<{ id: string; spaceId: string; title: string }> {
    const response = await jiraFetch(`${config.baseUrl}/wiki/api/v2/folders/${id}`, {
        headers: headers(config),
    })
    await assertOk(response, `Reading Confluence folder ${id}`)
    const folder = (await response.json()) as { id: string; spaceId: string; title: string }
    return { id: folder.id, spaceId: folder.spaceId, title: folder.title }
}

// Accepts the folder id, or a folder URL (…/wiki/spaces/<KEY>/folder/<id>).
export function folderIdFrom(value: string): string {
    const v = value.trim()
    const fromUrl = v.match(/\/folder\/(\d+)/)
    if (fromUrl) return fromUrl[1]
    if (/^\d+$/.test(v)) return v
    throw new Error(`"${value}" is not a Confluence folder id or folder URL`)
}

// A page directly under a folder or a page, by exact title, or null.
export async function childPage(
    config: JiraConfig,
    parent: { id: string; type: 'folder' | 'page' },
    title: string
): Promise<ConfluencePage | null> {
    const kind = parent.type === 'folder' ? 'folders' : 'pages'
    let next: string | null = `/wiki/api/v2/${kind}/${parent.id}/direct-children?limit=250`
    while (next) {
        const response = await jiraFetch(`${config.baseUrl}${next}`, { headers: headers(config) })
        await assertOk(response, `Listing the pages under ${parent.id}`)
        const body = (await response.json()) as {
            results: { id: string; title: string; type: string }[]
            _links?: { next?: string }
        }
        const hit = body.results.find(p => p.type === 'page' && p.title === title)
        if (hit) return pageById(config, hit.id)
        next = body._links?.next ?? null
    }
    return null
}

export async function pageById(config: JiraConfig, id: string): Promise<ConfluencePage> {
    const response = await jiraFetch(`${config.baseUrl}/wiki/api/v2/pages/${id}`, {
        headers: headers(config),
    })
    await assertOk(response, `Reading Confluence page ${id}`)
    return toPage(config, (await response.json()) as RawPage)
}

// `storage` is Confluence's XHTML storage format.
export async function createPage(
    config: JiraConfig,
    page: { spaceId: string; parentId: string; title: string; storage: string }
): Promise<ConfluencePage> {
    const response = await jiraFetch(`${config.baseUrl}/wiki/api/v2/pages`, {
        method: 'POST',
        headers: headers(config),
        body: JSON.stringify({
            spaceId: page.spaceId,
            parentId: page.parentId,
            status: 'current',
            title: page.title,
            body: { representation: 'storage', value: page.storage },
        }),
    })
    await assertOk(response, `Creating Confluence page "${page.title}"`)
    return toPage(config, (await response.json()) as RawPage)
}

export async function updatePage(
    config: JiraConfig,
    page: ConfluencePage,
    storage: string
): Promise<ConfluencePage> {
    const response = await jiraFetch(`${config.baseUrl}/wiki/api/v2/pages/${page.id}`, {
        method: 'PUT',
        headers: headers(config),
        body: JSON.stringify({
            id: page.id,
            status: 'current',
            title: page.title,
            body: { representation: 'storage', value: storage },
            version: { number: page.version + 1 },
        }),
    })
    await assertOk(response, `Updating Confluence page "${page.title}"`)
    return toPage(config, (await response.json()) as RawPage)
}

// Attaches a file to a page. The page body then shows it by filename
// (<ri:attachment ri:filename="…"/>).
export async function attachToPage(
    config: JiraConfig,
    pageId: string,
    filePath: string,
    // The attachment's name on the page, when it is not the file's own.
    name = path.basename(filePath)
): Promise<void> {
    const form = new FormData()
    form.append('file', new Blob([fs.readFileSync(filePath)]), name)
    form.append('minorEdit', 'true')
    const response = await jiraFetch(
        `${config.baseUrl}/wiki/rest/api/content/${pageId}/child/attachment`,
        {
            method: 'PUT',
            headers: { Authorization: authHeader(config), 'X-Atlassian-Token': 'no-check' },
            body: form,
        }
    )
    await assertOk(response, `Attaching ${name} to page ${pageId}`)
}

// Confluence draws a page at a narrow fixed width unless its appearance properties
// say otherwise; a results table needs the full width.
export async function setFullWidth(config: JiraConfig, pageId: string): Promise<void> {
    for (const key of ['content-appearance-published', 'content-appearance-draft']) {
        const base = `${config.baseUrl}/wiki/api/v2/pages/${pageId}/properties`
        const found = await jiraFetch(`${base}?key=${key}`, { headers: headers(config) })
        await assertOk(found, `Reading the ${key} property of page ${pageId}`)
        const existing = (
            (await found.json()) as {
                results: { id: string; version: { number: number } }[]
            }
        ).results[0]
        const response = existing
            ? await jiraFetch(`${base}/${existing.id}`, {
                  method: 'PUT',
                  headers: headers(config),
                  body: JSON.stringify({
                      key,
                      value: 'full-width',
                      version: { number: existing.version.number + 1 },
                  }),
              })
            : await jiraFetch(base, {
                  method: 'POST',
                  headers: headers(config),
                  body: JSON.stringify({ key, value: 'full-width' }),
              })
        await assertOk(response, `Setting page ${pageId} to full width`)
    }
}
