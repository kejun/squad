--------------------------- MODULE HostRetry ---------------------------
EXTENDS Naturals, TLC
VARIABLES mode, stage, parent, batch, retirement, successors, request, online, recovered, expired
vars == <<mode, stage, parent, batch, retirement, successors, request, online, recovered, expired>>
\* Four PUBLIC prefixes: queued, successful, denied, physically uncertain.
\* stage: queued=0/succeeded=1/failed=2/uncertain=3/cancelled=4.
\* parent: inflight=0/uncertain=1/pending=2/done=3.
Init == /\ mode \in 0..3 /\ stage = mode
        /\ parent = IF mode = 3 THEN 1 ELSE 0
        /\ batch = 1 /\ retirement = 0 /\ successors = 0
        /\ request = IF mode = 3 THEN 2 ELSE IF mode = 0 THEN 0 ELSE 1
        /\ online = TRUE /\ recovered = FALSE /\ expired = FALSE
End == /\ parent' = 3 /\ batch' = 2 /\ retirement' = 1 /\ successors' = 1
       /\ stage' = IF stage = 0 THEN 4 ELSE stage
       /\ request' = IF stage = 0 THEN IF expired THEN 4 ELSE 3 ELSE request
       /\ UNCHANGED <<mode, online, recovered, expired>>
EndOwner == online /\ batch = 1 /\ parent = 0 /\ stage # 3 /\ End
RejectOwner == online /\ batch = 1 /\ parent = 0 /\ stage \in {1,2} /\ End
DeniedEnd == online /\ stage = 3 /\ UNCHANGED vars
Reconcile == /\ online /\ stage = 3 /\ ~expired
             /\ stage' = 1 /\ parent' = 2 /\ request' = 1
             /\ UNCHANGED <<mode, batch, retirement, successors, online, recovered, expired>>
ClaimParent == /\ online /\ batch = 1 /\ parent = 2 /\ ~expired /\ parent' = 0
               /\ UNCHANGED <<mode, stage, batch, retirement, successors, request, online, recovered, expired>>
Crash == /\ online /\ ~recovered /\ ~expired /\ batch = 1 /\ online' = FALSE
         /\ UNCHANGED <<mode, stage, parent, batch, retirement, successors, request, recovered, expired>>
Reopen == /\ ~online /\ online' = TRUE /\ recovered' = TRUE
          /\ parent' = IF parent = 0 THEN 2 ELSE parent
          /\ UNCHANGED <<mode, stage, batch, retirement, successors, request, expired>>
Expire == /\ online /\ batch = 1 /\ parent = 0 /\ stage \in {1,2} /\ ~expired
          /\ expired' = TRUE /\ UNCHANGED <<mode, stage, parent, batch, retirement, successors, request, online, recovered>>
Sweep == online /\ ~expired /\ UNCHANGED vars
Duplicate == online /\ UNCHANGED vars
Next == EndOwner \/ RejectOwner \/ DeniedEnd \/ Reconcile \/ ClaimParent \/ Crash \/ Reopen \/ Expire \/ Sweep \/ Duplicate
Spec == Init /\ [][Next]_vars /\ WF_vars(Reopen) /\ WF_vars(ClaimParent) /\ WF_vars(EndOwner)
TypeOK == /\ mode \in 0..3 /\ stage \in 0..4 /\ parent \in 0..3 /\ batch \in 1..2
          /\ retirement \in 0..1 /\ successors \in 0..1 /\ request \in 0..4
          /\ online \in BOOLEAN /\ recovered \in BOOLEAN /\ expired \in BOOLEAN
NoUnknownAdvance == stage = 3 => (batch = 1 /\ retirement = 0 /\ successors = 0)
PreserveReceipt == mode \in {1,2} => stage = mode /\ request = 1
UniqueSuccessor == retirement = successors /\ successors <= 1
Progress == (batch = 1 /\ stage # 3) ~> successors = 1
NeverUnknown == stage # 3
NeverSuccessor == successors = 0
NeverRecovered == ~recovered
NeverLateReceipt == ~(mode = 2 /\ expired /\ successors = 1)
=============================================================================
