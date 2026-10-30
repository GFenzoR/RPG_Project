package buildinfo

import "testing"

func TestString(t *testing.T) {
	oldVersion, oldCommit := Version, Commit
	t.Cleanup(func() { Version, Commit = oldVersion, oldCommit })

	if got, want := String(), "dev (unknown)"; got != want {
		t.Errorf("default String() = %q, want %q", got, want)
	}

	Version, Commit = "v1.2.3", "abc1234"
	if got, want := String(), "v1.2.3 (abc1234)"; got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
}
