--------------------------- MODULE CheckBudget ---------------------------
EXTENDS Naturals, TLC
VARIABLES stage, requests, currentRequests, retry, recoveries, checks, retries, protocolErrors, completed, gapsDeclared
vars == <<stage, requests, currentRequests, retry, recoveries, checks, retries, protocolErrors, completed, gapsDeclared>>
\* One current check work, checks=5; real configured retry limit is MAX_SAFE_INTEGER.
\* 0=pending, 1=inflight, 4=ended, 5=uncertain. Retry 0=none,1=reserved,2=used.
CanRetry == currentRequests > 0 /\ requests < 5 /\ retry # 1
CanProtocolRetry == CanRetry /\ retry = 0
Init == /\ stage = 0 /\ requests = 0 /\ currentRequests = 0 /\ retry = 0
        /\ recoveries = 0 /\ checks = 0 /\ retries = 0 /\ protocolErrors = 0
        /\ completed = FALSE /\ gapsDeclared = FALSE
ClaimCheck == /\ stage = 0 /\ stage' = 1
    /\ UNCHANGED <<requests, currentRequests, retry, recoveries, checks, retries, protocolErrors, completed, gapsDeclared>>
Consume == /\ stage = 1 /\ requests < 5
    /\ requests' = requests + 1 /\ checks' = checks + 1 /\ currentRequests' = currentRequests + 1
    /\ retry' = (IF retry = 1 THEN 2 ELSE retry)
    /\ UNCHANGED <<stage, recoveries, retries, protocolErrors, completed, gapsDeclared>>
Failure == /\ stage = 1
    /\ stage' = (IF CanRetry THEN 0 ELSE 4)
    /\ retry' = (IF CanRetry THEN 1 ELSE retry)
    /\ retries' = (IF CanRetry THEN retries + 1 ELSE retries)
    /\ UNCHANGED <<requests, currentRequests, recoveries, checks, protocolErrors, completed, gapsDeclared>>
BadProtocol == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1
    /\ stage' = (IF CanProtocolRetry THEN 0 ELSE 4)
    /\ retry' = (IF CanProtocolRetry THEN 1 ELSE retry)
    /\ retries' = (IF CanProtocolRetry THEN retries + 1 ELSE retries)
    /\ protocolErrors' = protocolErrors + 1
    /\ UNCHANGED <<requests, currentRequests, recoveries, checks, completed, gapsDeclared>>
Uncertain == /\ stage = 1 /\ stage' = 5
    /\ UNCHANGED <<requests, currentRequests, retry, recoveries, checks, retries, protocolErrors, completed, gapsDeclared>>
FailedJudgment == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1
    /\ stage' = 4 /\ completed' = TRUE /\ gapsDeclared' = TRUE
    /\ UNCHANGED <<requests, currentRequests, retry, recoveries, checks, retries, protocolErrors>>
FailedManyJudgment == FailedJudgment
PassedJudgment == /\ stage = 1 /\ currentRequests > 0 /\ retry # 1
    /\ stage' = 4 /\ completed' = TRUE /\ gapsDeclared' = FALSE
    /\ UNCHANGED <<requests, currentRequests, retry, recoveries, checks, retries, protocolErrors>>
Recover == /\ stage \in {0,1} /\ recoveries < 2 /\ recoveries' = recoveries + 1
    /\ stage' = (IF stage = 1 /\ currentRequests > 0 /\ retry # 1 /\ ~CanRetry THEN 4 ELSE 0)
    /\ retry' = (IF stage = 1 /\ CanRetry THEN 1 ELSE retry)
    /\ retries' = (IF stage = 1 /\ CanRetry THEN retries + 1 ELSE retries)
    /\ UNCHANGED <<requests, currentRequests, checks, protocolErrors, completed, gapsDeclared>>
DeniedConsume == /\ stage = 1 /\ requests = 5 /\ UNCHANGED vars
DuplicateResult == /\ stage = 4 /\ UNCHANGED vars
Next == ClaimCheck \/ Consume \/ Failure \/ Uncertain \/ BadProtocol \/ FailedJudgment \/ FailedManyJudgment \/ PassedJudgment \/ Recover \/ DeniedConsume \/ DuplicateResult
Spec == Init /\ [][Next]_vars
TypeOK == /\ stage \in {0,1,4,5} /\ requests \in 0..5 /\ currentRequests \in 0..5
          /\ retry \in 0..2 /\ recoveries \in 0..2 /\ checks \in 0..5 /\ retries \in 0..4
          /\ protocolErrors \in 0..2 /\ completed \in BOOLEAN /\ gapsDeclared \in BOOLEAN
CheckAccounting == checks = requests /\ requests = currentRequests
BoundedChecks == requests <= 5 /\ ~(requests = 5 /\ retry = 1)
RetryAccounting == retries <= requests /\ (retry = 0 <=> retries = 0)
ProtocolRetryOnce == protocolErrors = 2 => stage = 4
DeclaredDelivery == completed => stage = 4
NeverFiveRequests == requests < 5
NeverMultipleNetworkRetries == retries < 3
NeverTechnicalRetry == retry # 2
NeverDeclaredDelivery == ~gapsDeclared
NeverRepeatedRecovery == ~(recoveries = 2 /\ retry = 1)
NeverBeforeRequestFailure == ~(stage = 4 /\ requests = 0)
NeverUncertain == stage # 5
NeverProtocolExhaustion == protocolErrors < 2
=============================================================================
