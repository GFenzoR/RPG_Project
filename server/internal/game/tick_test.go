package game

import (
	"testing"
	"time"
)

func TestTicksFor(t *testing.T) {
	tests := []struct {
		d    time.Duration
		want Tick
	}{
		{-time.Second, 0},
		{0, 0},
		{time.Millisecond, 1},
		{50 * time.Millisecond, 1},
		{51 * time.Millisecond, 2},
		{2 * time.Second, 40},
	}
	for _, tt := range tests {
		if got := TicksFor(tt.d); got != tt.want {
			t.Errorf("TicksFor(%v) = %d, want %d", tt.d, got, tt.want)
		}
	}
	if got := Tick(40).Duration(); got != 2*time.Second {
		t.Errorf("Tick(40).Duration() = %v, want 2s", got)
	}
}
