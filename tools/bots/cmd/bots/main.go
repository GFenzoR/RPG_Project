// Command bots runs headless load-testing clients against a game server.
//
// This is the T0.1 skeleton: it only validates its flags. The real bots arrive in T1.4/T1.17.
package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	n := flag.Int("n", 10, "number of bots to run")
	flag.Parse()

	if err := validateCount(*n); err != nil {
		fmt.Fprintln(os.Stderr, "bots:", err)
		os.Exit(2)
	}
	fmt.Printf("bots: load testing is not implemented yet (requested %d bots, see T1.17)\n", *n)
}

// validateCount checks that the requested number of bots is usable.
func validateCount(n int) error {
	if n < 1 || n > 1000 {
		return fmt.Errorf("n must be between 1 and 1000, got %d", n)
	}
	return nil
}
