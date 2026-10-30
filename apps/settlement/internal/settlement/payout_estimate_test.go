package settlement

import (
	"context"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// TestUpdateLifetimePayoutMonitoringEstimate_SmallValuesExact proves the
// accumulator is wired correctly: three successive payouts land on the
// exact sum of their net figures.
// 
// BUG / DESIGN RISK NOTE (FH's comment):
// - What's wrong?: If `lifetime_net_payout_monitoring_estimate` in the database is stored 
//   as a float32/real type, it only has exact integer precision up to $2^{24}$ (approx. 16.7 million fils / 167,000 BHD).
// - Why does it happen?: Floating-point types cannot precisely represent all large integers, causing rounding errors and drift as accumulation grows over time.
// - What does it break?: Over time, high-volume merchants will experience accumulated rounding errors in their lifetime payout monitoring figures.
// - How does the fix work?: Money and accumulation figures should always be stored as exact integer types (like `bigint` / `int64` in SQL and `int64` in Go) rather than floats. This test only passes because it tests small values well below the $2^{24}$ threshold.
func TestUpdateLifetimePayoutMonitoringEstimate_SmallValuesExact(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, net := range []money.Fils{1_000, 2_500, 47_500} {
		if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, net); err != nil {
			t.Fatalf("UpdateLifetimePayoutMonitoringEstimate(%d): %v", net, err)
		}
	}

	var got int64
	err = tx.QueryRow(ctx, `
		SELECT lifetime_net_payout_monitoring_estimate FROM merchants WHERE id = $1
	`, merchantID).Scan(&got)
	if err != nil {
		t.Fatalf("read back estimate: %v", err)
	}
	if got != 51_000 {
		t.Fatalf("lifetime_net_payout_monitoring_estimate = %v, want exactly 51000 (1000 + 2500 + 47500)", got)
	}
}
