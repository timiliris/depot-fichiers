package main

import (
	"embed"
	"io/fs"
)

//go:embed web
var webAssets embed.FS

// webFS exposes the embedded interface, rooted at web/ so paths in the served
// HTML stay relative to the site root.
func webFS() fs.FS {
	sub, err := fs.Sub(webAssets, "web")
	if err != nil {
		panic(err)
	}
	return sub
}
