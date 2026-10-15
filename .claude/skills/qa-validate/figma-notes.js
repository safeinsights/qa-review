const MODE = 'pages'
const TARGET = ''
// figma-notes.js — the ONLY code qa-validate sends to use_figma. Read-only.
// The hook .claude/hooks/figma-readonly.mjs denies any use_figma call whose code
// differs from this file in anything but the two lines above.
//   pages  → every page {id, name}
//   locate → for each id in TARGET (comma-separated): {id, name, type, page}
//   page   → TARGET is a page id: top-level frames + every annotation on the page
const cats = await figma.annotations.getAnnotationCategoriesAsync()
const catName = Object.fromEntries(cats.map(c => [c.id, c.label]))
const hasNotes = n => Array.isArray(n.annotations) && n.annotations.length > 0

if (MODE === 'pages') {
    return { pages: figma.root.children.map(p => ({ id: p.id, name: p.name })) }
}

if (MODE === 'locate') {
    const out = []
    for (const id of TARGET.split(',').map(s => s.trim()).filter(Boolean)) {
        const node = await figma.getNodeByIdAsync(id)
        if (!node) {
            out.push({ id, found: false })
            continue
        }
        let p = node
        while (p && p.type !== 'PAGE') p = p.parent
        out.push({
            id,
            found: true,
            name: node.name,
            type: node.type,
            page: p ? { id: p.id, name: p.name } : null,
        })
    }
    return { nodes: out }
}

if (MODE === 'page') {
    const page = await figma.getNodeByIdAsync(TARGET)
    if (!page || page.type !== 'PAGE') return { error: `not a page: ${TARGET}` }
    await figma.setCurrentPageAsync(page)
    const frames = page.children.map(f => ({
        id: f.id,
        name: f.name,
        type: f.type,
        annotations: ('findAll' in f ? f.findAll(hasNotes).length : 0) + (hasNotes(f) ? 1 : 0),
    }))
    const notes = []
    for (const top of page.children) {
        const nodes = [...(hasNotes(top) ? [top] : []), ...('findAll' in top ? top.findAll(hasNotes) : [])]
        for (const n of nodes) {
            const pathParts = []
            let p = n
            while (p && p.type !== 'PAGE') {
                pathParts.unshift(p.name)
                p = p.parent
            }
            for (const a of n.annotations) {
                notes.push({
                    frame: { id: top.id, name: top.name },
                    nodeId: n.id,
                    path: pathParts.join(' / '),
                    category: a.categoryId ? (catName[a.categoryId] ?? a.categoryId) : null,
                    text: a.labelMarkdown || a.label || '',
                    properties: (a.properties || []).map(p => p.type),
                })
            }
        }
    }
    return { page: { id: page.id, name: page.name }, categories: cats.map(c => c.label), frames, notes }
}

return { error: `unknown MODE: ${MODE}` }
