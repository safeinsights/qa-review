package main

import "context"

// App is the Wails backend. Its exported methods are callable from the frontend
// via the generated bindings; it emits events the frontend listens to.
type App struct {
	ctx context.Context
}

func NewApp() *App {
	return &App{}
}

// startup stores the Wails runtime context (needed to emit events).
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}
