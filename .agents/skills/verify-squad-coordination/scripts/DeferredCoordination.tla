--------------------- MODULE DeferredCoordination ---------------------
EXTENDS Naturals, TLC
VARIABLES work, failures, changed, deferred, coordinations, stopped, recovered, progressed, activity, claimableTick
vars == <<work, failures, changed, deferred, coordinations, stopped, recovered, progressed, activity, claimableTick>>
Init == work = 1 /\ failures = 0 /\ changed = FALSE /\ deferred = FALSE /\ coordinations = 0 /\ stopped = FALSE /\ recovered = FALSE /\ progressed = FALSE /\ activity = FALSE /\ claimableTick = FALSE
FailureSignal == /\ ~stopped /\ coordinations = 0 /\ failures < 2
    /\ work' = (IF work = 0 /\ failures = 1 THEN 3 ELSE work)
    /\ failures' = (failures + 1)
    /\ deferred' = (IF work = 1 /\ failures = 1 THEN TRUE ELSE deferred)
    /\ coordinations' = (IF work # 1 /\ failures = 1 THEN 1 ELSE coordinations)
    /\ UNCHANGED <<changed, stopped, recovered, progressed, activity, claimableTick>>
ChangeFingerprint == /\ ~stopped /\ coordinations = 0 /\ ~changed
    /\ failures' = (1)
    /\ changed' = (TRUE)
    /\ UNCHANGED <<work, deferred, coordinations, stopped, recovered, progressed, activity, claimableTick>>
EvidencedProgress == /\ ~stopped /\ coordinations = 0 /\ ~progressed
    /\ failures' = (0)
    /\ progressed' = (TRUE)
    /\ UNCHANGED <<work, changed, deferred, coordinations, stopped, recovered, activity, claimableTick>>
Activity == /\ ~stopped /\ coordinations = 0 /\ ~activity
    /\ activity' = (TRUE)
    /\ UNCHANGED <<work, failures, changed, deferred, coordinations, stopped, recovered, progressed, claimableTick>>
Block == /\ ~stopped /\ coordinations = 0 /\ ~deferred
    /\ work' = (IF work = 0 THEN 3 ELSE work)
    /\ deferred' = ((work = 1))
    /\ coordinations' = (IF work = 1 THEN 0 ELSE 1)
    /\ UNCHANGED <<failures, changed, stopped, recovered, progressed, activity, claimableTick>>
Settle == /\ work = 1
    /\ work' = (2)
    /\ deferred' = (IF ~stopped /\ deferred THEN FALSE ELSE deferred)
    /\ coordinations' = (IF ~stopped /\ deferred THEN 1 ELSE coordinations)
    /\ UNCHANGED <<failures, changed, stopped, recovered, progressed, activity, claimableTick>>
ClaimTool == /\ work = 0 /\ ~stopped /\ coordinations = 0
    /\ work' = (1)
    /\ UNCHANGED <<failures, changed, deferred, coordinations, stopped, recovered, progressed, activity, claimableTick>>
TickClaimable == /\ work = 2 /\ ~stopped /\ coordinations = 0 /\ ~claimableTick
    /\ claimableTick' = TRUE
    /\ UNCHANGED <<work, failures, changed, deferred, coordinations, stopped, recovered, progressed, activity>>
Tick == /\ work = 2 /\ ~stopped /\ coordinations = 0
    /\ deferred' = (FALSE)
    /\ coordinations' = (1)
    /\ UNCHANGED <<work, failures, changed, stopped, recovered, progressed, activity, claimableTick>>
Recover == /\ ~recovered /\ ~stopped /\ coordinations = 0
    /\ work' = (IF work = 1 THEN (IF deferred THEN 3 ELSE 0) ELSE work)
    /\ deferred' = (FALSE)
    /\ coordinations' = (IF deferred THEN 1 ELSE 0)
    /\ recovered' = (TRUE)
    /\ UNCHANGED <<failures, changed, stopped, progressed, activity, claimableTick>>
Stop == /\ ~stopped /\ coordinations = 0
    /\ work' = (IF work = 0 THEN 3 ELSE work)
    /\ stopped' = (TRUE)
    /\ UNCHANGED <<failures, changed, deferred, coordinations, recovered, progressed, activity, claimableTick>>
LateSignal == /\ stopped
    /\ UNCHANGED <<work, failures, changed, deferred, coordinations, stopped, recovered, progressed, activity, claimableTick>>
Next == FailureSignal \/ ChangeFingerprint \/ EvidencedProgress \/ Activity \/ Block \/ Settle \/ ClaimTool \/ TickClaimable \/ Tick \/ Recover \/ Stop \/ LateSignal
ProgressStep == Settle \/ ClaimTool \/ Tick \/ Recover
Spec == Init /\ [][Next]_vars /\ WF_vars(ProgressStep)
TypeOK == /\ work \in 0..3 /\ failures \in 0..2 /\ changed \in BOOLEAN /\ deferred \in BOOLEAN
          /\ coordinations \in 0..1 /\ stopped \in BOOLEAN /\ recovered \in BOOLEAN /\ progressed \in BOOLEAN /\ activity \in BOOLEAN /\ claimableTick \in BOOLEAN
UniqueCoordination == coordinations <= 1
DeferredProgress == work = 2 /\ deferred /\ ~stopped => coordinations = 1
SafeCoordinationBoundary == work = 1 => coordinations = 0
StoppedCoordination == stopped => coordinations = 0
Progress == deferred /\ ~stopped ~> (coordinations = 1 \/ stopped)
NeverDeferred == ~deferred
NeverCoordinated == coordinations = 0
NeverReset == ~(progressed /\ failures = 0)
NeverRecoveredDeferred == ~(recovered /\ coordinations = 1)
NeverRetainedClaimable == ~claimableTick
======================================================================
