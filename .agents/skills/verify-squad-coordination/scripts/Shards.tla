------------------------------ MODULE Shards ------------------------------

EXTENDS Naturals, TLC

\* The public implementation prefix must pass current dispatch capacity for
\* exactly two shards. Capacity preparation/refresh/fallback examples live in
\* capacity-probes.mjs; this graph does not enumerate those resource states.

VARIABLES w1, w2, r1, r2, summary, handoffs, incomplete, stopped, goal, reopened, round, interrupted

vars == <<w1, w2, r1, r2, summary, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

Init == /\ w1 = 0 /\ w2 = 0 /\ r1 = 0 /\ r2 = 0 /\ summary = 0
        /\ handoffs = 0 /\ incomplete = FALSE /\ stopped = FALSE
        /\ goal = 1 /\ reopened = FALSE /\ round = 0 /\ interrupted = FALSE
\* work pending=0/inflight=1/settled=2/cancelled=3;
\* results none=0/success=1/partial=2/failure=3;
\* summary absent=0/pending=1/inflight=2/settled=3/cancelled=4;
\* round collecting=0/summarizing=1/delivered=2/cancelled=3.
Active == ~stopped /\ goal = 1 /\ round < 2

Claim1 == Active /\ w1 = 0 /\ w1' = (1) /\ UNCHANGED <<w2, r1, r2, summary, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

Success1 == Active /\ w1 = 1 /\ w1' = (2) /\ r1' = (1) /\ incomplete' = (incomplete) /\ summary' = (IF w2 = 2 THEN 1 ELSE 0) /\ round' = (IF w2 = 2 THEN 1 ELSE 0) /\ UNCHANGED <<w2, r2, handoffs, stopped, goal, reopened, interrupted>>

Partial1 == Active /\ w1 = 1 /\ w1' = (2) /\ r1' = (2) /\ incomplete' = (TRUE) /\ summary' = (IF w2 = 2 THEN 1 ELSE 0) /\ round' = (IF w2 = 2 THEN 1 ELSE 0) /\ UNCHANGED <<w2, r2, handoffs, stopped, goal, reopened, interrupted>>

Failure1 == Active /\ w1 = 1 /\ w1' = (2) /\ r1' = (3) /\ incomplete' = (TRUE) /\ summary' = (IF w2 = 2 THEN 1 ELSE 0) /\ round' = (IF w2 = 2 THEN 1 ELSE 0) /\ UNCHANGED <<w2, r2, handoffs, stopped, goal, reopened, interrupted>>

Duplicate1 == r1 > 0 /\ UNCHANGED <<w1, w2, r1, r2, summary, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

Late1 == ~Active /\ w1 = 1 /\ w1' = (2) /\ UNCHANGED <<w2, r1, r2, summary, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

Claim2 == Active /\ w2 = 0 /\ w2' = (1) /\ UNCHANGED <<w1, r1, r2, summary, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

Success2 == Active /\ w2 = 1 /\ w2' = (2) /\ r2' = (1) /\ incomplete' = (incomplete) /\ summary' = (IF w1 = 2 THEN 1 ELSE 0) /\ round' = (IF w1 = 2 THEN 1 ELSE 0) /\ UNCHANGED <<w1, r1, handoffs, stopped, goal, reopened, interrupted>>

Partial2 == Active /\ w2 = 1 /\ w2' = (2) /\ r2' = (2) /\ incomplete' = (TRUE) /\ summary' = (IF w1 = 2 THEN 1 ELSE 0) /\ round' = (IF w1 = 2 THEN 1 ELSE 0) /\ UNCHANGED <<w1, r1, handoffs, stopped, goal, reopened, interrupted>>

Failure2 == Active /\ w2 = 1 /\ w2' = (2) /\ r2' = (3) /\ incomplete' = (TRUE) /\ summary' = (IF w1 = 2 THEN 1 ELSE 0) /\ round' = (IF w1 = 2 THEN 1 ELSE 0) /\ UNCHANGED <<w1, r1, handoffs, stopped, goal, reopened, interrupted>>

Duplicate2 == r2 > 0 /\ UNCHANGED <<w1, w2, r1, r2, summary, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

Late2 == ~Active /\ w2 = 1 /\ w2' = (2) /\ UNCHANGED <<w1, r1, r2, summary, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

ClaimSummary == Active /\ summary = 1 /\ summary' = (2) /\ UNCHANGED <<w1, w2, r1, r2, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

SummaryResult == Active /\ summary = 2 /\ summary' = (3) /\ round' = (2) /\ handoffs' = (handoffs + 1) /\ UNCHANGED <<w1, w2, r1, r2, incomplete, stopped, goal, reopened, interrupted>>

SummaryFailure == Active /\ summary = 2 /\ summary' = (3) /\ round' = (2) /\ handoffs' = (handoffs + 1) /\ incomplete' = (TRUE) /\ UNCHANGED <<w1, w2, r1, r2, stopped, goal, reopened, interrupted>>

DuplicateSummary == summary = 3 /\ UNCHANGED <<w1, w2, r1, r2, summary, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

LateSummary == ~Active /\ summary = 2 /\ summary' = (3) /\ UNCHANGED <<w1, w2, r1, r2, handoffs, incomplete, stopped, goal, reopened, round, interrupted>>

Stop == Active /\ stopped' = (TRUE) /\ round' = (3) /\ w1' = (IF w1 = 0 THEN 3 ELSE w1) /\ w2' = (IF w2 = 0 THEN 3 ELSE w2) /\ summary' = (IF summary = 1 THEN 4 ELSE summary) /\ UNCHANGED <<r1, r2, handoffs, incomplete, goal, reopened, interrupted>>

ChangeGoal == Active /\ goal' = (2) /\ round' = (3) /\ w1' = (IF w1 = 0 THEN 3 ELSE w1) /\ w2' = (IF w2 = 0 THEN 3 ELSE w2) /\ summary' = (IF summary = 1 THEN 4 ELSE summary) /\ UNCHANGED <<r1, r2, handoffs, incomplete, stopped, reopened, interrupted>>

Reopen == ~reopened /\ (Active \/ (w1 # 1 /\ w2 # 1 /\ summary # 2)) /\ reopened' = (TRUE) /\ interrupted' = (w1 = 1 \/ w2 = 1 \/ summary = 2) /\ w1' = (IF w1 = 1 THEN 0 ELSE w1) /\ w2' = (IF w2 = 1 THEN 0 ELSE w2) /\ summary' = (IF summary = 2 THEN 1 ELSE summary) /\ UNCHANGED <<r1, r2, handoffs, incomplete, stopped, goal, round>>

Next == Claim1 \/ Success1 \/ Partial1 \/ Failure1 \/ Duplicate1 \/ Late1 \/ Claim2 \/ Success2 \/ Partial2 \/ Failure2 \/ Duplicate2 \/ Late2 \/ ClaimSummary \/ SummaryResult \/ SummaryFailure \/ DuplicateSummary \/ LateSummary \/ Stop \/ ChangeGoal \/ Reopen

ProgressStep == Claim1 \/ Claim2 \/ Success1 \/ Success2 \/ ClaimSummary \/ SummaryResult
Spec == Init /\ [][Next]_vars /\ WF_vars(ProgressStep)
TypeOK == /\ w1 \in 0..3 /\ w2 \in 0..3 /\ r1 \in 0..3 /\ r2 \in 0..3
          /\ summary \in 0..4 /\ handoffs \in 0..1 /\ round \in 0..3
          /\ interrupted \in BOOLEAN /\ incomplete \in BOOLEAN /\ stopped \in BOOLEAN /\ reopened \in BOOLEAN /\ goal \in 1..2
AllSettledBeforeReduce == summary > 0 => r1 > 0 /\ r2 > 0
UniqueHandoff == handoffs <= 1
PreserveIncomplete == (r1 > 1 \/ r2 > 1) => incomplete
NoStaleHandoff == stopped \/ goal = 2 => handoffs = 0
Progress == Active ~> (round = 2 \/ round = 3)
NeverSecondFirst == ~(r2 > 0 /\ r1 = 0)
NeverPartial == ~(r1 = 2 /\ handoffs = 1)
NeverFailure == ~(r1 = 3 /\ handoffs = 1)
NeverHandoff == handoffs = 0
NeverStoppedInflight == ~(stopped /\ w1 = 1)
NeverStaleInflight == ~(goal = 2 /\ w1 = 1)
NeverInterruptedRecovery == ~interrupted
NeverReopenedSaved == ~(reopened /\ r1 > 0)
=============================================================================
