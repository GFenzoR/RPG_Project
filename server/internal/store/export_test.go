package store

// SetTransferHook makes SaveTransfer call f inside its transaction after each step (0:
// after the snapshots, i: after market change i); an error aborts it. Tests only.
func SetTransferHook(f func(step int) error) { transferHook = f }
