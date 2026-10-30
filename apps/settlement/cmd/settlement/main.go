// Command settlement is apps/settlement's CLI entrypoint:
//
//  settlement daemon
//  settlement run-batch --date=2026-09-09 [--merchant=<uuid>]
//  settlement rebuild-balances [--merchant=<uuid>]
//  settlement export-scheme-file --batch=<uuid> --out=<path>
//
// Every subcommand is CLI-invoked (by a human, by the container's own CMD,
// or by `docker compose run`). `daemon` additionally starts
// internal/internalapi's small internal HTTP server, so apps/api's admin
// plane can trigger settlement runs, balance rebuilds and MDR
// recalculation.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/config"
	"github.com/filspay/settlement/internal/db"
	"github.com/filspay/settlement/internal/internalapi"
	"github.com/filspay/settlement/internal/ledger"
	"github.com/filspay/settlement/internal/scheduler"
	"github.com/filspay/settlement/internal/settlement"
)

// Imported purely for its side effect: bakes Go's standard-library
// embedded IANA zoneinfo directly into the compiled binary, so
// time.LoadLocation("Asia/Bahrain") (internal/settlement/window.go) works
// identically regardless of which final-stage container base image ops
// later chooses (a minimal/distroless image does not ship OS tzdata by
// default).
// FH: needed if Dockerfile.go copies zoneinfo anyway? (there's no ops/Dockerfile.go btw)
import _ "time/tzdata"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("settlement: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.NewPool(ctx, cfg)
	if err != nil {
		log.Fatalf("settlement: %v", err)
	}
	defer pool.Close()

	subcommand := os.Args[1]
	args := os.Args[2:]

	switch subcommand {
	case "daemon":
		// The internal HTTP server (apps/api's admin plane calls it to
		// trigger a settlement re-run or a balance rebuild) runs alongside
		// the scheduler loop for the lifetime of the daemon process. It
		// shares the daemon's ctx, so the same SIGTERM/SIGINT that stops
		// the scheduler also shuts the server down gracefully. Started
		// before the blocking scheduler.Run call; a listen failure (e.g.
		// the port is taken) is fatal — a half-started daemon whose admin
		// endpoints silently do not exist is worse than a crash.
		//
		// Only `daemon` actually starts this server, so only `daemon`
		// requires SETTLEMENT_INTERNAL_TOKEN to be set — the one-shot CLI
		// subcommands below never touch it.
		if err := cfg.RequireInternalToken(); err != nil {
			log.Fatalf("settlement: %v", err)
		}
		
		/*
		   BUG / IMPROVEMENT FIX: Goroutine `log.Fatalf` Bypassing Deferred Cleanup
		   - Old code: Called `log.Fatalf` directly inside the background goroutine if `internalapi.Serve` failed.
		   - What's wrong?: `log.Fatalf` calls `os.Exit(1)`, which immediately terminates the process and skips all deferred functions in `main()` (such as `defer pool.Close()`).
		   - Why did we change it? / How does the fix work?: Log the error and cancel the context (or let the main runner handle it) so cleanup routines can execute cleanly, or ensure proper error propagation.
		*/
		go func() {
			if err := internalapi.Serve(ctx, pool, cfg); err != nil {
				log.Printf("settlement daemon: internal api error: %v", err)
				// Gracefully stop via context or handle without abrupt os.Exit from goroutine
				stop()
			}
		}()

		scheduler.Run(ctx, pool, cfg)

	case "run-batch":
		fs := flag.NewFlagSet("run-batch", flag.ExitOnError)
		dateFlag := fs.String("date", "", "business date, YYYY-MM-DD (required)")
		merchantFlag := fs.String("merchant", "", "merchant UUID (optional; omit to run every active, non-test-mode merchant)")
		if err := fs.Parse(args); err != nil {
			log.Fatalf("settlement run-batch: %v", err)
		}
		if *dateFlag == "" {
			log.Fatal("settlement run-batch: --date=YYYY-MM-DD is required")
		}
		// MK: parsed as UTC midnight; BusinessDayWindow only uses Y/M/D so fine
		businessDate, err := time.Parse("2006-01-02", *dateFlag)
		if err != nil {
			log.Fatalf("settlement run-batch: invalid --date: %v", err)
		}

		var onlyMerchant *uuid.UUID
		if *merchantFlag != "" {
			id, err := uuid.Parse(*merchantFlag)
			if err != nil {
				log.Fatalf("settlement run-batch: invalid --merchant: %v", err)
			}
			onlyMerchant = &id
		}

		report, err := settlement.RunDailyBatch(ctx, pool, businessDate, onlyMerchant)
		if err != nil {
			log.Fatalf("settlement run-batch: %v", err)
		}
		fmt.Printf("run-batch: business date %s, %d merchant(s) processed\n", *dateFlag, len(report.MerchantResults))
		for _, r := range report.MerchantResults {
			fmt.Printf("  merchant=%s batch=%s alreadyClosed=%v alreadyPaid=%v gross=%d fee=%d netPayout=%d\n",
				r.MerchantID, r.BatchID, r.AlreadyClosed, r.AlreadyPaid, r.GrossFils, r.FeeFils, r.NetPayoutFils)
		}

		// A manually-triggered or backfill batch run produces merchant payout
		// notifications exactly like the daemon's own path does — the scan is
		// idempotent, so running it from both entrypoints is safe and keeps
		// "was this batch run by hand or by the daemon" from changing what a
		// merchant sees.
		enqueued, err := settlement.EnqueuePayoutNotifications(ctx, pool)
		if err != nil {
			log.Fatalf("settlement run-batch: enqueue payout notifications: %v", err)
		}
		fmt.Printf("run-batch: enqueued %d settlement.paid event(s)\n", enqueued)

	// YA: CLI rebuild goes from ledger_entries. the admin button goes somewhere else, see internalapi
	// MK: same thing, different source. both fine.
	case "rebuild-balances":
		fs := flag.NewFlagSet("rebuild-balances", flag.ExitOnError)
		merchantFlag := fs.String("merchant", "", "merchant UUID (optional; omit to rebuild every merchant)")
		if err := fs.Parse(args); err != nil {
			log.Fatalf("settlement rebuild-balances: %v", err)
		}

		if *merchantFlag != "" {
			id, err := uuid.Parse(*merchantFlag)
			if err != nil {
				log.Fatalf("settlement rebuild-balances: invalid --merchant: %v", err)
			}
			// am: --merchant writes the cache for that one merchant, same as the full rebuild
			rebuilt, err := ledger.RebuildMerchantBalance(ctx, pool, id)
			if err != nil {
				log.Fatalf("settlement rebuild-balances: %v", err)
			}
			_, err = pool.Exec(ctx, `
				INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
				VALUES ($1, $2, now())
				ON CONFLICT (merchant_id) DO UPDATE
				  SET cached_payable_fils = $2, updated_at = now()
			`, id, int64(rebuilt))
			if err != nil {
				log.Fatalf("settlement rebuild-balances: write cache: %v", err)
			}
			fmt.Printf("rebuild-balances: merchant=%s rebuilt=%d\n", id, rebuilt)
			return
		}

		diffs, err := ledger.RebuildAllBalances(ctx, pool)
		if err != nil {
			log.Fatalf("settlement rebuild-balances: %v", err)
		}
		fmt.Printf("rebuild-balances: %d merchant(s) recomputed\n", len(diffs))
		for merchantID, diff := range diffs {
			changed := ""
			if diff.Changed() {
				changed = " (CHANGED)"
			}
			fmt.Printf("  merchant=%s before=%d after=%d%s\n", merchantID, diff.CachedBefore, diff.Rebuilt, changed)
		}

	case "export-scheme-file":
		fs := flag.NewFlagSet("export-scheme-file", flag.ExitOnError)
		batchFlag := fs.String("batch", "", "settlement batch UUID (required)")
		outFlag := fs.String("out", "", "output file path (required)")
		if err := fs.Parse(args); err != nil {
			log.Fatalf("settlement export-scheme-file: %v", err)
		}
		if *batchFlag == "" || *outFlag == "" {
			log.Fatal("settlement export-scheme-file: --batch and --out are required")
		}
		batchID, err := uuid.Parse(*batchFlag)
		if err != nil {
			log.Fatalf("settlement export-scheme-file: invalid --batch: %v", err)
		}

		count, err := settlement.ExportSchemeFile(ctx, pool, batchID, *outFlag)
		if err != nil {
			log.Fatalf("settlement export-scheme-file: %v", err)
		}
		fmt.Printf("export-scheme-file: wrote %d line(s) to %s\n", count, *outFlag)

	default:
		usage()
		os.Exit(2)
	}
}

// usage lists every operation the settlement service supports.
func usage() {
	fmt.Fprintln(os.Stderr, "usage:")
	fmt.Fprintln(os.Stderr, "  settlement daemon")
	fmt.Fprintln(os.Stderr, "  settlement run-batch --date=YYYY-MM-DD [--merchant=<uuid>]")
	fmt.Fprintln(os.Stderr, "  settlement rebuild-balances [--merchant=<uuid>]")
	fmt.Fprintln(os.Stderr, "  settlement export-scheme-file --batch=<uuid> --out=<path>")
}
