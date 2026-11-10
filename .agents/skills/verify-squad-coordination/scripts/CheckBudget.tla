--------------------------- MODULE CheckBudget ---------------------------
EXTENDS Naturals, TLC
VARIABLES stage, requests, currentRequests, retry, revision, revisions, recoveries, checks, retries, revisionLimit, recordedRevisions
vars == <<stage, requests, currentRequests, retry, revision, revisions, recoveries, checks, retries, revisionLimit, recordedRevisions>>
\* stage: check pending=0/inflight=1; revision pending=2/inflight=3;
\* terminal=4; unknown request outcome waitingHuman=5.
\* retry: none=0/reserved=1/used=2. Retry is cycle-wide, not per candidate.
Ordinary == requests - (IF retry = 2 THEN 1 ELSE 0)
CanRetry == retry = 0 /\ currentRequests > 0 /\ requests < revisionLimit + 2
Init == /\ stage = 0 /\ requests = 0 /\ currentRequests = 0 /\ retry = 0
        /\ revision = FALSE /\ revisions = 0 /\ recoveries = 0 /\ checks = 0 /\ retries = 0
        /\ revisionLimit = 2 /\ recordedRevisions = 0
ClaimCheck == /\ stage = 0 /\ stage' = 1
              /\ UNCHANGED <<requests, currentRequests, retry, revision, revisions, recoveries, checks, retries, revisionLimit, recordedRevisions>>
Consume == /\ stage = 1 /\ (currentRequests = 0 \/ retry = 1)
           /\ requests < revisionLimit + 2 /\ (retry = 1 \/ Ordinary < revisionLimit + 1)
           /\ requests' = requests + 1 /\ checks' = checks + 1
           /\ currentRequests' = currentRequests + 1 /\ retry' = (IF retry = 1 THEN 2 ELSE retry)
           /\ UNCHANGED <<stage, revision, revisions, recoveries, retries, revisionLimit, recordedRevisions>>
Failure == /\ stage = 1
           /\ stage' = (IF CanRetry THEN 0 ELSE 4)
           /\ retry' = (IF CanRetry THEN 1 ELSE retry)
           /\ retries' = (IF CanRetry THEN retries + 1 ELSE retries)
           /\ UNCHANGED <<requests, currentRequests, revision, revisions, recoveries, checks, revisionLimit, recordedRevisions>>
Uncertain == /\ stage = 1 /\ stage' = 5
             /\ UNCHANGED <<requests, currentRequests, retry, revision, revisions, recoveries, checks, retries, revisionLimit, recordedRevisions>>
BadProtocol == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1
               /\ stage' = (IF CanRetry THEN 0 ELSE 4)
               /\ retry' = (IF CanRetry THEN 1 ELSE retry)
               /\ retries' = (IF CanRetry THEN retries + 1 ELSE retries)
               /\ UNCHANGED <<requests, currentRequests, revision, revisions, recoveries, checks, revisionLimit, recordedRevisions>>
CanRevise == revisions < revisionLimit /\ requests < revisionLimit + 2 /\ Ordinary < revisionLimit + 1
FailedJudgment == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1
                /\ stage' = (IF CanRevise THEN 2 ELSE 4)
                /\ revision' = (revision \/ CanRevise)
                /\ revisions' = revisions + (IF CanRevise THEN 1 ELSE 0)
                /\ recordedRevisions' = recordedRevisions + (IF CanRevise THEN 1 ELSE 0)
                /\ revisionLimit' = revisionLimit
                /\ UNCHANGED <<requests, currentRequests, retry, recoveries, checks, retries>>
FailedManyJudgment == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1
                /\ stage' = (IF CanRevise THEN 2 ELSE 4)
                /\ revision' = (revision \/ CanRevise)
                /\ revisions' = revisions + (IF CanRevise THEN 1 ELSE 0)
                /\ recordedRevisions' = recordedRevisions + (IF CanRevise THEN 1 ELSE 0)
                /\ revisionLimit' = (IF CanRevise /\ revisions = 0 THEN 3 ELSE revisionLimit)
                /\ UNCHANGED <<requests, currentRequests, retry, recoveries, checks, retries>>
PassedJudgment == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1 /\ stage' = 4
                  /\ UNCHANGED <<requests, currentRequests, retry, revision, revisions, recoveries, checks, retries, revisionLimit, recordedRevisions>>
ClaimRevision == /\ stage = 2 /\ stage' = 3
                 /\ UNCHANGED <<requests, currentRequests, retry, revision, revisions, recoveries, checks, retries, revisionLimit, recordedRevisions>>
DeliverRevision == /\ stage = 3 /\ stage' = 0 /\ currentRequests' = 0
                   /\ UNCHANGED <<requests, retry, revision, revisions, recoveries, checks, retries, revisionLimit, recordedRevisions>>
Recover == /\ stage \in {0,1} /\ recoveries < 2 /\ recoveries' = recoveries + 1
           /\ stage' = (IF stage = 1 /\ currentRequests > 0 /\ retry = 2 THEN 4 ELSE 0)
           /\ retry' = (IF stage = 1 /\ CanRetry THEN 1 ELSE retry)
           /\ retries' = (IF stage = 1 /\ CanRetry THEN retries + 1 ELSE retries)
           /\ UNCHANGED <<requests, currentRequests, revision, revisions, checks, revisionLimit, recordedRevisions>>
DeniedConsume == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1 /\ UNCHANGED vars
DuplicateResult == /\ stage \in {2,3,4} /\ UNCHANGED vars
Next == ClaimCheck \/ Consume \/ Failure \/ Uncertain \/ BadProtocol \/ FailedJudgment \/ FailedManyJudgment \/ PassedJudgment
        \/ ClaimRevision \/ DeliverRevision \/ Recover \/ DeniedConsume \/ DuplicateResult
Spec == Init /\ [][Next]_vars
TypeOK == /\ stage \in 0..5 /\ requests \in 0..5 /\ currentRequests \in 0..2 /\ retry \in 0..2
          /\ revision \in BOOLEAN /\ revisions \in 0..3 /\ recoveries \in 0..2 /\ checks \in 0..5 /\ retries \in 0..1 /\ revisionLimit \in 2..3 /\ recordedRevisions \in 0..3
CheckAccounting == checks = requests
BoundedChecks == requests <= revisionLimit + 2 /\ Ordinary <= revisionLimit + 1
OneTechnicalRetry == retries = (IF retry = 0 THEN 0 ELSE 1)
BoundedRevisions == revisions <= revisionLimit /\ revision = (revisions > 0) /\ recordedRevisions = revisions
NeverThreeRequests == requests < 3
NeverFiveRequests == requests < 5
NeverSecondRevision == revisions < 2
NeverThirdRevision == revisions < 3
NeverExpandedLimit == revisionLimit = 2
NeverTechnicalRetry == retry # 2
NeverRevised == ~revision
NeverRepeatedRecovery == ~(recoveries = 2 /\ retry = 1)
NeverBeforeRequestFailure == ~(stage = 4 /\ requests = 0)
NeverUncertain == stage # 5
=============================================================================
