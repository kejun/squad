--------------------------- MODULE MapRecovery ---------------------------
EXTENDS Naturals, TLC
\* Init is a public prefix: two terminal map failures, reducer handoff, owner
\* claimed, one complete settled CLI source. No actual CLI or semantic oracle.
VARIABLES phase, claims, requests, retry, accepted, resolved, published,
          incomplete, history, binding, stopped, goal, reopened
vars == <<phase, claims, requests, retry, accepted, resolved, published,
          incomplete, history, binding, stopped, goal, reopened>>
\* phase owner-ready=0/check-pending=1/check-inflight=2/check-settled=3.
\* claims none=0/one of two=1/both=2. retry none=0/reserved=1/used=2.
Init == /\ phase = 0 /\ claims = 0 /\ requests = 0 /\ retry = 0
        /\ accepted = FALSE /\ resolved = 0 /\ published = FALSE
        /\ incomplete = TRUE /\ history = TRUE /\ binding = TRUE
        /\ stopped = FALSE /\ goal = 1 /\ reopened = FALSE
Current == ~stopped /\ goal = 1
SubmitNone == /\ Current /\ phase = 0 /\ phase' = 1 /\ claims' = 0
              /\ UNCHANGED <<requests,retry,accepted,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
SubmitPartial == /\ Current /\ phase = 0 /\ phase' = 1 /\ claims' = 1
                 /\ UNCHANGED <<requests,retry,accepted,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
SubmitFull == /\ Current /\ phase = 0 /\ phase' = 1 /\ claims' = 2
              /\ UNCHANGED <<requests,retry,accepted,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
ClaimCheck == /\ Current /\ phase = 1 /\ phase' = 2
              /\ UNCHANGED <<claims,requests,retry,accepted,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
ConsumeCheck == /\ Current /\ phase = 2 /\ (requests = 0 \/ retry = 1)
                /\ requests' = requests + 1 /\ retry' = IF retry = 1 THEN 2 ELSE retry
                /\ UNCHANGED <<phase,claims,accepted,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
PassCheck == /\ Current /\ phase = 2 /\ requests > 0 /\ retry # 1
             /\ phase' = 3 /\ accepted' = (claims > 0)
             /\ resolved' = IF claims = 2 THEN 2 ELSE 0
             /\ published' = (claims = 2) /\ incomplete' = (claims # 2)
             /\ UNCHANGED <<claims,requests,retry,history,binding,stopped,goal,reopened>>
FailedCheck == /\ Current /\ phase = 2 /\ requests > 0 /\ retry # 1
               /\ phase' = 3 /\ accepted' = (claims > 0)
               /\ UNCHANGED <<claims,requests,retry,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
UnverifiedCheck == /\ Current /\ phase = 2 /\ requests > 0 /\ retry # 1
                   /\ phase' = 3 /\ accepted' = (claims > 0)
                   /\ UNCHANGED <<claims,requests,retry,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
MissingQuote == /\ Current /\ phase = 2 /\ requests > 0 /\ retry = 0 /\ claims > 0
                /\ phase' = 1 /\ retry' = 1
                /\ UNCHANGED <<claims,requests,accepted,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
WrongQuote == /\ Current /\ phase = 2 /\ requests > 0 /\ retry = 0 /\ claims > 0
              /\ phase' = 1 /\ retry' = 1
              /\ UNCHANGED <<claims,requests,accepted,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
UnrequestedResult == Current /\ phase = 2 /\ requests = 0 /\ UNCHANGED vars
StaleRevision == Current /\ phase = 2 /\ requests > 0 /\ UNCHANGED vars
StaleAttempt == Current /\ phase = 2 /\ requests > 0 /\ UNCHANGED vars
DuplicateResult == phase = 3 /\ UNCHANGED vars
Stop == /\ Current /\ phase < 3 /\ stopped' = TRUE
        /\ phase' = IF phase = 1 THEN 3 ELSE phase
        /\ UNCHANGED <<claims,requests,retry,accepted,resolved,published,incomplete,history,binding,goal,reopened>>
ChangeGoal == /\ Current /\ phase < 3 /\ goal' = 2
              /\ phase' = IF phase = 1 THEN 3 ELSE phase
              /\ UNCHANGED <<claims,requests,retry,accepted,resolved,published,incomplete,history,binding,stopped,reopened>>
LateResult == /\ ~Current /\ phase = 2 /\ phase' = 3
              /\ UNCHANGED <<claims,requests,retry,accepted,resolved,published,incomplete,history,binding,stopped,goal,reopened>>
Reopen == /\ ~reopened /\ reopened' = TRUE
          /\ UNCHANGED <<phase,claims,requests,retry,accepted,resolved,published,incomplete,history,binding,stopped,goal>>
Next == SubmitNone \/ SubmitPartial \/ SubmitFull \/ ClaimCheck \/ ConsumeCheck
        \/ PassCheck \/ FailedCheck \/ UnverifiedCheck \/ MissingQuote \/ WrongQuote
        \/ UnrequestedResult \/ StaleRevision \/ StaleAttempt \/ DuplicateResult
        \/ Stop \/ ChangeGoal \/ LateResult \/ Reopen
ProgressStep == ClaimCheck \/ ConsumeCheck \/ PassCheck
Spec == Init /\ [][Next]_vars /\ WF_vars(ProgressStep)
TypeOK == /\ phase \in 0..3 /\ claims \in 0..2 /\ requests \in 0..2 /\ retry \in 0..2
          /\ resolved \in {0,2} /\ accepted \in BOOLEAN /\ published \in BOOLEAN
          /\ incomplete \in BOOLEAN /\ history \in BOOLEAN /\ binding \in BOOLEAN
          /\ stopped \in BOOLEAN /\ goal \in 1..2 /\ reopened \in BOOLEAN
NoUnresolvedPublication == published => claims = 2 /\ resolved = 2 /\ accepted /\ ~incomplete
NoUnverifiedRecovery == resolved > 0 => published /\ accepted /\ claims = 2
RecoveryHistoryImmutable == history
VerifiedRecoveryEvidence == binding
RecoveryIsolation == stopped \/ goal = 2 => ~published /\ resolved = 0
OutstandingRecoveryDebt == incomplete = (resolved < 2)
RecoveryProgress == (phase \in {1,2} /\ Current) ~> (phase = 3 \/ ~Current)
NeverFullClaim == claims # 2
NeverRecoveredPublication == ~published
NeverPartialClaimSettled == ~(claims = 1 /\ phase = 3 /\ accepted)
NeverCitationRetry == retry # 1
NeverReopenedProof == ~(reopened /\ resolved = 2)
NeverStoppedCheck == ~(stopped /\ phase = 2)
NeverStaleCheck == ~(goal = 2 /\ phase = 2)
=============================================================================
