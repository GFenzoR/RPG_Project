package main

import "testing"

func TestValidateCount(t *testing.T) {
	for _, tc := range []struct {
		n       int
		wantErr bool
	}{
		{0, true},
		{1, false},
		{100, false},
		{1000, false},
		{1001, true},
	} {
		if err := validateCount(tc.n); (err != nil) != tc.wantErr {
			t.Errorf("validateCount(%d) error = %v, wantErr %v", tc.n, err, tc.wantErr)
		}
	}
}
