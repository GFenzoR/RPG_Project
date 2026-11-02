package auth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/GFenzoR/RPG_Project/server/internal/auth"
)

func TestPlayToken(t *testing.T) {
	ctx := context.Background()
	svc, _, clk := newService(t)
	acc, _ := svc.Register(ctx, "ana@example.org", "secreto123")
	other, _ := svc.Register(ctx, "bob@example.org", "secreto123")
	c, err := svc.CreateCharacter(ctx, acc, "Mira", "guardian")
	if err != nil {
		t.Fatal(err)
	}

	if _, err := svc.IssuePlayToken(ctx, other, c.ID); !errors.Is(err, auth.ErrUnknownCharacter) {
		t.Fatalf("other account's character: %v", err)
	}
	if _, err := svc.IssuePlayToken(ctx, acc, 0); !errors.Is(err, auth.ErrUnknownCharacter) {
		t.Fatalf("character 0: %v", err)
	}

	tok, err := svc.IssuePlayToken(ctx, acc, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !tok.ExpiresAt.Equal(clk.Now().Add(auth.PlayTokenTTL)) {
		t.Fatalf("expires %v", tok.ExpiresAt)
	}
	// A play token is not an account token.
	if _, err := svc.Authenticate(ctx, tok.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("play token as account token: %v", err)
	}
	gotAcc, gotChar, err := svc.RedeemPlayToken(ctx, tok.Token)
	if err != nil || gotAcc != acc || gotChar != c.ID {
		t.Fatalf("redeem = %d, %d, %v", gotAcc, gotChar, err)
	}
	if _, _, err := svc.RedeemPlayToken(ctx, tok.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("second redeem: %v", err)
	}

	late, _ := svc.IssuePlayToken(ctx, acc, c.ID)
	clk.Advance(auth.PlayTokenTTL + time.Second)
	if _, _, err := svc.RedeemPlayToken(ctx, late.Token); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("expired redeem: %v", err)
	}
	if _, _, err := svc.RedeemPlayToken(ctx, ""); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("empty redeem: %v", err)
	}
}
