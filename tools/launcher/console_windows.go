//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// setupConsole switches the console to UTF-8 (the messages have accents) and names the
// window; the returned func restores the code pages of a console the launcher borrowed.
func setupConsole() func() {
	k := syscall.NewLazyDLL("kernel32.dll")
	getOut, setOut := k.NewProc("GetConsoleOutputCP"), k.NewProc("SetConsoleOutputCP")
	getIn, setIn := k.NewProc("GetConsoleCP"), k.NewProc("SetConsoleCP")
	oldOut, _, _ := getOut.Call()
	oldIn, _, _ := getIn.Call()
	_, _, _ = setOut.Call(65001)
	_, _, _ = setIn.Call(65001)
	if t, err := syscall.UTF16PtrFromString("Neque's Realm - Servidor"); err == nil {
		_, _, _ = k.NewProc("SetConsoleTitleW").Call(uintptr(unsafe.Pointer(t)))
	}
	return func() {
		if oldOut != 0 {
			_, _, _ = setOut.Call(oldOut)
		}
		if oldIn != 0 {
			_, _, _ = setIn.Call(oldIn)
		}
	}
}
