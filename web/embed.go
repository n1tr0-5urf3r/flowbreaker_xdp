// Package web embeds the browser game.
package web

import "embed"

//go:embed index.html style.css js vendor img
var FS embed.FS
