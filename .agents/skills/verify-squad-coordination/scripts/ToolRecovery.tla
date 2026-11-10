--------------------------- MODULE ToolRecovery ---------------------------
EXTENDS Naturals, TLC
CONSTANT Limit
VARIABLES phase, used, charges, requests, webCalls, feedbacks, recordings,
          attempt, reopened, stopped, expired, blocked, identitiesValid
vars == <<phase, used, charges, requests, webCalls, feedbacks, recordings,
          attempt, reopened, stopped, expired, blocked, identitiesValid>>
\* phase: ordinary request ready=0, consumed Web request=1, recorded feedback=2,
\* safe recovery left parent pending=3, separately reclaimed parent=4.
\* Init is a public submit/CLAIM/first CONSUME prefix. There is one owner,
\* three consumed Web requests at most, one RECOVER, two parent attempts.
Active == ~stopped /\ ~expired
Init == /\ phase = 0 /\ used = 1 /\ charges = 1 /\ requests = 1
        /\ webCalls = 0 /\ feedbacks = 0 /\ recordings = 0 /\ attempt = 1
        /\ reopened = FALSE /\ stopped = FALSE /\ expired = FALSE
        /\ blocked = 0 /\ identitiesValid = TRUE
WebCall == /\ Active /\ phase \in {0,2} /\ webCalls < 3 /\ used < Limit
           /\ phase' = 1 /\ used' = used + 1 /\ charges' = charges + 1
           /\ requests' = requests + 1 /\ webCalls' = webCalls + 1
           /\ UNCHANGED <<feedbacks, recordings, attempt, reopened, stopped,
                          expired, blocked, identitiesValid>>
RecordFailure == /\ Active /\ phase = 1 /\ feedbacks < 2 /\ used < Limit
                 /\ phase' = 2 /\ feedbacks' = feedbacks + 1
                 /\ recordings' = recordings + 1
                 /\ UNCHANGED <<used, charges, requests, webCalls, attempt,
                                reopened, stopped, expired, blocked, identitiesValid>>
ModelRequest == /\ Active /\ phase \in {0,2} /\ used < Limit
                /\ phase' = 0 /\ used' = used + 1 /\ charges' = charges + 1
                /\ requests' = requests + 1
                /\ UNCHANGED <<webCalls, feedbacks, recordings, attempt,
                               reopened, stopped, expired, blocked, identitiesValid>>
Recover == /\ Active /\ phase = 2 /\ feedbacks = 1 /\ ~reopened
           /\ phase' = 3 /\ reopened' = TRUE
           /\ UNCHANGED <<used, charges, requests, webCalls, feedbacks, recordings,
                          attempt, stopped, expired, blocked, identitiesValid>>
Reclaim == /\ Active /\ phase = 3 /\ used < Limit
           /\ phase' = 4 /\ attempt' = attempt + 1 /\ requests' = 0
           /\ used' = used + 1 /\ charges' = charges + 1
           /\ UNCHANGED <<webCalls, feedbacks, recordings, reopened, stopped,
                          expired, blocked, identitiesValid>>
ResumeInitial == /\ Active /\ phase = 4
                 /\ phase' = 0 /\ requests' = 1
                 /\ UNCHANGED <<used, charges, webCalls, feedbacks, recordings,
                                attempt, reopened, stopped, expired, blocked, identitiesValid>>
Stop == /\ ~stopped /\ phase # 3
        /\ stopped' = TRUE /\ blocked' = feedbacks
        /\ UNCHANGED <<phase, used, charges, requests, webCalls, feedbacks,
                       recordings, attempt, reopened, expired, identitiesValid>>
Expire == /\ Active /\ phase = 1 /\ webCalls = 1 /\ feedbacks = 0
          /\ expired' = TRUE /\ blocked' = feedbacks
          /\ UNCHANGED <<phase, used, charges, requests, webCalls, feedbacks,
                         recordings, attempt, reopened, stopped, identitiesValid>>
DeniedFailure == /\ Active /\ phase = 1 /\ (feedbacks = 2 \/ used = Limit)
                 /\ UNCHANGED vars
DeniedWeb == /\ Active /\ phase = 0 /\ webCalls < 3 /\ used = Limit
             /\ UNCHANGED vars
DuplicateFailure == /\ Active /\ phase \in {0,1,2} /\ feedbacks > 0
                    /\ UNCHANGED vars
StaleAttempt == /\ Active /\ phase = 1 /\ UNCHANGED vars
StaleFence == /\ Active /\ phase = 1 /\ UNCHANGED vars
UnknownRequest == /\ Active /\ phase = 1 /\ UNCHANGED vars
MismatchedTool == /\ Active /\ phase = 1 /\ UNCHANGED vars
LateFailure == /\ (stopped \/ expired) /\ webCalls > 0 /\ UNCHANGED vars
Next == WebCall \/ RecordFailure \/ ModelRequest \/ Recover \/ Reclaim
        \/ ResumeInitial \/ Stop \/ Expire \/ DeniedFailure \/ DeniedWeb
        \/ DuplicateFailure \/ StaleAttempt \/ StaleFence \/ UnknownRequest
        \/ MismatchedTool \/ LateFailure
Spec == Init /\ [][Next]_vars
TypeOK == /\ phase \in 0..4 /\ used \in 1..Limit /\ charges \in 1..Limit
          /\ requests \in 0..Limit /\ webCalls \in 0..3
          /\ feedbacks \in 0..2 /\ recordings \in 0..2 /\ blocked \in 0..2
          /\ attempt \in 1..2 /\ reopened \in BOOLEAN /\ stopped \in BOOLEAN
          /\ expired \in BOOLEAN /\ identitiesValid \in BOOLEAN
BoundedToolRecovery == feedbacks <= 2 /\ feedbacks = recordings
ToolRecoveryAccounting == used = charges /\ used <= Limit
ToolFailureIdentity == identitiesValid /\ feedbacks <= webCalls
StoppedToolRecovery == stopped \/ expired => feedbacks = blocked
NeverFeedback == feedbacks = 0
NeverSecondFeedback == feedbacks < 2
NeverRecoveredFeedback == ~(reopened /\ attempt = 2 /\ feedbacks = 2)
NeverBudgetFrontier == ~(phase = 1 /\ used = Limit /\ feedbacks < 2)
NeverExpiredFeedback == ~expired
=============================================================================
