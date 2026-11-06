package httpapi

// SetUploadSlotHook replaces the hook told when an upload takes (+1) or frees (-1) a slot,
// and returns a function that restores the previous one.
func SetUploadSlotHook(f func(delta int)) (restore func()) {
	prev := uploadSlotHook
	uploadSlotHook = f
	return func() { uploadSlotHook = prev }
}
