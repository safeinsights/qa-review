package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// HelpDoc is one rendered help page for the in-app Help drawer. Content lives as
// plain markdown under <repo>/docs/help/*.md so it's editable via PR and shipped
// to everyone by `qar sync` — the app just reads and renders it.
type HelpDoc struct {
	Slug  string `json:"slug"`  // filename without extension, e.g. "01-getting-started"
	Title string `json:"title"` // the page's first "# " heading, else a slug-derived fallback
	Body  string `json:"body"`  // raw markdown (the leading H1 stripped; it's the title)
}

// HelpDocs reads every docs/help/*.md page from the cloned repo, sorted by
// filename (the numeric prefix sets the order). Returns an empty slice (not an
// error) if the directory is absent, so a stale/partial checkout just shows no
// help rather than breaking the drawer.
func (a *App) HelpDocs() ([]HelpDoc, error) {
	dir := filepath.Join(repoDir(), "docs", "help")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []HelpDoc{}, nil
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	docs := make([]HelpDoc, 0, len(names))
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		slug := strings.TrimSuffix(name, ".md")
		title, body := splitTitle(string(data), slug)
		docs = append(docs, HelpDoc{Slug: slug, Title: title, Body: body})
	}
	return docs, nil
}

// splitTitle pulls the page title from a leading "# Heading" line and returns the
// remaining body. If there's no H1, the title is derived from the slug (drop the
// numeric ordering prefix, turn dashes into spaces) and the body is returned whole.
func splitTitle(md, slug string) (string, string) {
	trimmed := strings.TrimLeft(md, "\n")
	if strings.HasPrefix(trimmed, "# ") {
		nl := strings.IndexByte(trimmed, '\n')
		if nl == -1 {
			return strings.TrimSpace(trimmed[2:]), ""
		}
		title := strings.TrimSpace(trimmed[2:nl])
		return title, strings.TrimLeft(trimmed[nl+1:], "\n")
	}
	return slugToTitle(slug), md
}

func slugToTitle(slug string) string {
	// Drop a leading numeric-ordering prefix like "01-".
	if i := strings.IndexByte(slug, '-'); i > 0 && strings.Trim(slug[:i], "0123456789") == "" {
		slug = slug[i+1:]
	}
	return strings.ReplaceAll(slug, "-", " ")
}
