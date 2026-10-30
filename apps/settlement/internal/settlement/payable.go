package settlement

import "github.com/filspay/settlement/internal/money"

// NetPayableFils derives the net payout from frozen gross and fee totals.
// Both inputs are already integer fils, so the net is their difference.
// A float conversion drops fils once the amounts get large.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}

/*
   CODE REVIEW NOTE:
   - This Go function correctly calculates the net payout by subtracting integer `feeFils` 
     from integer `grossFils` directly, avoiding precision loss from floating-point conversions.
   - No bugs, syntax errors, or structural issues were found in this code snippet.
*/
