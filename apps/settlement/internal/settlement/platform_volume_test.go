package settlement

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// resetPlatformStats puts the single counter row back at zero, mirroring
// what db/seed/generate.ts's own TRUNCATE + re-INSERT does on every seed.
func resetPlatformStats(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		UPDATE platform_stats SET total_processed_fils = 0, updated_at = now() WHERE id = 1
	`)
	if err != nil {
		t.Fatalf("resetPlatformStats: %v", err)
	}
}

// TestRecordPlatformProcessedVolume_SmallValuesExact proves the
// accumulator is wired correctly: three successive batch closes land on
// the exact integer sum of their gross figures.
func TestRecordPlatformProcessedVolume_SmallValuesExact(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	resetPlatformStats(t, pool)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, gross := range []int64{1_000_000, 2_500_000, 47_500_000} {
		current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
		if err != nil {
			t.Fatalf("ReadAndLockPlatformProcessedFils: %v", err)
		}
		if err := RecordPlatformProcessedVolume(ctx, tx, current, gross); err != nil {
			t.Fatalf("RecordPlatformProcessedVolume(%d): %v", gross, err)
		}
	}

	var got int64
	err = tx.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&got)
	if err != nil {
		t.Fatalf("read back total: %v", err)
	}
	if got != 51_000_000 {
		t.Fatalf("total_processed_fils = %v, want exactly 51000000 (1000000 + 2500000 + 47500000)", got)
	}
}

// TestVolumeTierMdrBonusBps_BelowAndAtThreshold proves the tier comparison
// is correct on both sides of the threshold.
// MK: no test above the threshold, or near int32 max. TODO
func TestVolumeTierMdrBonusBps_BelowAndAtThreshold(t *testing.T) {
	if got := VolumeTierMdrBonusBps(0); got != 0 {
		t.Errorf("zero volume: got %d, want 0", got)
	}
	if got := VolumeTierMdrBonusBps(1_999_999_999); got != 0 {
		t.Errorf("just below threshold: got %d, want 0", got)
	}
	if got := VolumeTierMdrBonusBps(2_000_000_000); got != 15 {
		t.Errorf("exactly at threshold: got %d, want 15", got)
	}
}

/*
   CODE REVIEW & EXPLANATION NOTE:
   - What’s correct here?: The test suite correctly resets platform stats, runs tests inside 
     isolated database transactions (`tx`), and checks both sides of the volume tier threshold using exact `int64` arithmetic.
   - Are there any bugs?: No syntax or critical compilation bugs exist in this test file. However, as noted in the TODO comment by MK, 
     it is missing test coverage for volumes *above* the threshold (e.g., higher tier volumes) or edge cases near integer limits.
   - Why did we review it?: To ensure platform volume tracking and bonus thresholds remain robust, deterministic, and free of precision drift.
*/
