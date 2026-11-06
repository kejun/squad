------------------------------ MODULE Budget ------------------------------
EXTENDS Naturals, TLC
VARIABLES work, used, retries, requests, attempt, epoch, recovered, charges
vars == <<work, used, retries, requests, attempt, epoch, recovered, charges>>
Limit == IF epoch = 1 THEN 3 ELSE 5
Init == /\ work = 0 /\ used = 0 /\ retries = 0 /\ requests = 0
        /\ attempt = 0 /\ epoch = 1 /\ recovered = FALSE /\ charges = 0
\* work: pending=0, inflight=1, settled/waitingHuman=2, uncertain=3.
Claim == /\ work = 0 /\ used < Limit
         /\ work' = 1 /\ used' = used + 1 /\ charges' = charges + 1
         /\ attempt' = attempt + 1 /\ requests' = 0
         /\ UNCHANGED <<retries, epoch, recovered>>
Consume == /\ work = 1 /\ (requests = 0 \/ used < Limit)
           /\ requests' = requests + 1
           /\ used' = used + (IF requests = 0 THEN 0 ELSE 1)
           /\ charges' = charges + (IF requests = 0 THEN 0 ELSE 1)
           /\ UNCHANGED <<work, retries, attempt, epoch, recovered>>
Fail == /\ work = 1
        /\ IF retries < 1 /\ used < Limit
              THEN /\ work' = 0 /\ retries' = retries + 1
              ELSE /\ work' = 2 /\ UNCHANGED retries
        /\ UNCHANGED <<used, requests, attempt, epoch, recovered, charges>>
Uncertain == /\ work = 1 /\ work' = 3
             /\ UNCHANGED <<used, retries, requests, attempt, epoch, recovered, charges>>
Recover == /\ work = 1 /\ ~recovered /\ work' = 0 /\ recovered' = TRUE
           /\ UNCHANGED <<used, retries, requests, attempt, epoch, charges>>
Continue == /\ work = 2 /\ epoch = 1 /\ epoch' = 2 /\ work' = 0
            /\ requests' = 0 /\ attempt' = 0
            /\ UNCHANGED <<used, retries, recovered, charges>>
StaleAttempt == /\ attempt > 0 /\ UNCHANGED vars
DeniedClaim == /\ work = 0 /\ used = Limit /\ work' = 2
               /\ UNCHANGED <<used, retries, requests, attempt, epoch, recovered, charges>>
DeniedConsume == /\ work = 1 /\ requests > 0 /\ used = Limit /\ UNCHANGED vars
Next == Claim \/ Consume \/ Fail \/ Uncertain \/ Recover \/ Continue \/ StaleAttempt \/ DeniedClaim \/ DeniedConsume
Spec == Init /\ [][Next]_vars
TypeOK == /\ work \in 0..3 /\ used \in 0..5 /\ retries \in 0..1
          /\ requests \in 0..5 /\ attempt \in 0..4 /\ epoch \in 1..2
          /\ recovered \in BOOLEAN /\ charges \in 0..5
PaidBudget == used = charges /\ used <= Limit
RetryBound == retries <= 1
NeverRetry == retries = 0
NeverRecoveryCharge == ~(recovered /\ used >= 2)
NeverContinuation == epoch = 1
NeverBudgetExhausted == used < Limit
NeverUncertain == work # 3
=============================================================================
