package httpapi

import (
	"testing"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
	"github.com/GFenzoR/RPG_Project/server/internal/clock"
)

// TestLimiterPoliciesWiring: the per-IP limit fails open (saturation must not lock
// everyone out), the per-account login limits fail closed.
func TestLimiterPoliciesWiring(t *testing.T) {
	a, err := newAPI(Config{Auth: (*auth.Service)(nil), Clock: clock.Real{}})
	if err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct {
		l    *limiter
		want collisionPolicy
		rl   RateLimit
	}{
		"ip":    {a.limiter, failOpen, DefaultAuthRateLimit},
		"pair":  {a.pairLimiter, failClosed, DefaultLoginPairRateLimit},
		"email": {a.emailLimiter, failClosed, DefaultLoginEmailRateLimit},
	} {
		if c.l.policy != c.want || c.l.cfg != c.rl {
			t.Errorf("%s limiter: policy %d cfg %+v, want policy %d cfg %+v", name, c.l.policy, c.l.cfg, c.want, c.rl)
		}
	}
}
