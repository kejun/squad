--------------------------- MODULE CheckBudget ---------------------------
EXTENDS Naturals, TLC
VARIABLES stage, requests, currentRequests, retry, revision, revisions, recoveries, checks, retries
vars == <<stage, requests, currentRequests, retry, revision, revisions, recoveries, checks, retries>>
\* stage: check pending=0/inflight=1; revision pending=2/inflight=3;
\* terminal=4; unknown request outcome waitingHuman=5.
\* retry: none=0/reserved=1/used=2. Retry is cycle-wide, not per candidate.
Ordinary == requests - (IF retry = 2 THEN 1 ELSE 0)
CanRetry == retry = 0 /\ currentRequests > 0 /\ requests < 3
Init == /\ stage = 0 /\ requests = 0 /\ currentRequests = 0 /\ retry = 0
        /\ revision = FALSE /\ revisions = 0 /\ recoveries = 0 /\ checks = 0 /\ retries = 0
ClaimCheck == /\ stage = 0 /\ stage' = 1
              /\ UNCHANGED <<requests, currentRequests, retry, revision, revisions, recoveries, checks, retries>>
Consume == /\ stage = 1 /\ (currentRequests = 0 \/ retry = 1)
           /\ requests < 3 /\ (retry = 1 \/ Ordinary < 2)
           /\ requests' = requests + 1 /\ checks' = checks + 1
           /\ currentRequests' = currentRequests + 1 /\ retry' = (IF retry = 1 THEN 2 ELSE retry)
           /\ UNCHANGED <<stage, revision, revisions, recoveries, retries>>
Failure == /\ stage = 1
           /\ stage' = (IF CanRetry THEN 0 ELSE 4)
           /\ retry' = (IF CanRetry THEN 1 ELSE retry)
           /\ retries' = (IF CanRetry THEN retries + 1 ELSE retries)
           /\ UNCHANGED <<requests, currentRequests, revision, revisions, recoveries, checks>>
Uncertain == /\ stage = 1 /\ stage' = 5
             /\ UNCHANGED <<requests, currentRequests, retry, revision, revisions, recoveries, checks, retries>>
BadProtocol == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1
               /\ stage' = (IF CanRetry THEN 0 ELSE 4)
               /\ retry' = (IF CanRetry THEN 1 ELSE retry)
               /\ retries' = (IF CanRetry THEN retries + 1 ELSE retries)
               /\ UNCHANGED <<requests, currentRequests, revision, revisions, recoveries, checks>>
FailedJudgment == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1
                  /\ stage' = (IF ~revision /\ requests < 3 /\ Ordinary < 2 THEN 2 ELSE 4)
                  /\ revision' = (revision \/ (requests < 3 /\ Ordinary < 2))
                  /\ revisions' = revisions + (IF ~revision /\ requests < 3 /\ Ordinary < 2 THEN 1 ELSE 0)
                  /\ UNCHANGED <<requests, currentRequests, retry, recoveries, checks, retries>>
PassedJudgment == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1 /\ stage' = 4
                  /\ UNCHANGED <<requests, currentRequests, retry, revision, revisions, recoveries, checks, retries>>
ClaimRevision == /\ stage = 2 /\ stage' = 3
                 /\ UNCHANGED <<requests, currentRequests, retry, revision, revisions, recoveries, checks, retries>>
DeliverRevision == /\ stage = 3 /\ stage' = 0 /\ currentRequests' = 0
                   /\ UNCHANGED <<requests, retry, revision, revisions, recoveries, checks, retries>>
Recover == /\ stage \in {0,1} /\ recoveries < 2 /\ recoveries' = recoveries + 1
           /\ stage' = (IF stage = 1 /\ currentRequests > 0 /\ retry = 2 THEN 4 ELSE 0)
           /\ retry' = (IF stage = 1 /\ CanRetry THEN 1 ELSE retry)
           /\ retries' = (IF stage = 1 /\ CanRetry THEN retries + 1 ELSE retries)
           /\ UNCHANGED <<requests, currentRequests, revision, revisions, checks>>
DeniedConsume == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1 /\ UNCHANGED vars
DuplicateResult == /\ stage \in {2,3,4} /\ UNCHANGED vars
Next == ClaimCheck \/ Consume \/ Failure \/ Uncertain \/ BadProtocol \/ FailedJudgment \/ PassedJudgment
        \/ ClaimRevision \/ DeliverRevision \/ Recover \/ DeniedConsume \/ DuplicateResult
Spec == Init /\ [][Next]_vars
TypeOK == /\ stage \in 0..5 /\ requests \in 0..3 /\ currentRequests \in 0..2 /\ retry \in 0..2
          /\ revision \in BOOLEAN /\ revisions \in 0..1 /\ recoveries \in 0..2 /\ checks \in 0..3 /\ retries \in 0..1
CheckAccounting == checks = requests
BoundedChecks == requests <= 3 /\ Ordinary <= 2
OneTechnicalRetry == retries = (IF retry = 0 THEN 0 ELSE 1)
OneRevision == revisions <= 1 /\ revision = (revisions = 1)
NeverThreeRequests == requests < 3
NeverTechnicalRetry == retry # 2
NeverRevised == ~revision
NeverRepeatedRecovery == ~(recoveries = 2 /\ retry = 1)
NeverBeforeRequestFailure == ~(stage = 4 /\ requests = 0)
NeverUncertain == stage # 5
=============================================================================
