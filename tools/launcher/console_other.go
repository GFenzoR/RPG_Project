//go:build !windows

package main

// setupConsole has nothing to do outside Windows: terminals there already speak UTF-8.
func setupConsole() func() { return func() {} }
