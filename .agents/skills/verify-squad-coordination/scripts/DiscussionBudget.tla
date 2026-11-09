------------------------ MODULE DiscussionBudget ------------------------
EXTENDS Naturals, TLC
VARIABLES used, requests, member1, member2, summary, handoff, successor, reserve
vars == <<used, requests, member1, member2, summary, handoff, successor, reserve>>
Init == used = 2 /\ requests = 1 /\ member1 = 0 /\ member2 = 0 /\ summary = 0 /\ handoff = FALSE /\ successor = FALSE /\ reserve = 4
Claim1 == /\ member1 = 0
    /\ used' = (used+1)
    /\ member1' = (1)
    /\ reserve' = (reserve-1)
    /\ UNCHANGED <<requests, member2, summary, handoff, successor>>
Return1 == /\ member1 = 1
    /\ member1' = (2)
    /\ summary' = (IF member2 = 2 THEN 1 ELSE 0)
    /\ UNCHANGED <<used, requests, member2, handoff, successor, reserve>>
Claim2 == /\ member2 = 0
    /\ used' = (used+1)
    /\ member2' = (1)
    /\ reserve' = (reserve-1)
    /\ UNCHANGED <<requests, member1, summary, handoff, successor>>
Return2 == /\ member2 = 1
    /\ member2' = (2)
    /\ summary' = (IF member1 = 2 THEN 1 ELSE 0)
    /\ UNCHANGED <<used, requests, member1, handoff, successor, reserve>>
AdditionalRequest == /\ ~handoff /\ used + 1 + reserve <= 7
    /\ used' = (used+1)
    /\ requests' = (requests+1)
    /\ UNCHANGED <<member1, member2, summary, handoff, successor, reserve>>
DeniedRequest == /\ ~handoff /\ used + 1 + reserve > 7
    /\ UNCHANGED <<used, requests, member1, member2, summary, handoff, successor, reserve>>
ClaimSummary == /\ summary = 1
    /\ used' = (used+1)
    /\ summary' = (2)
    /\ reserve' = (reserve-1)
    /\ UNCHANGED <<requests, member1, member2, handoff, successor>>
ReturnSummary == /\ summary = 2
    /\ summary' = (3)
    /\ UNCHANGED <<used, requests, member1, member2, handoff, successor, reserve>>
Handoff == /\ summary = 3 /\ ~handoff
    /\ handoff' = (TRUE)
    /\ UNCHANGED <<used, requests, member1, member2, summary, successor, reserve>>
ClaimSuccessor == /\ handoff /\ ~successor
    /\ used' = (used+1)
    /\ successor' = (TRUE)
    /\ reserve' = (0)
    /\ UNCHANGED <<requests, member1, member2, summary, handoff>>
Next == Claim1 \/ Claim2 \/ Return1 \/ Return2 \/ AdditionalRequest \/ DeniedRequest \/ ClaimSummary \/ ReturnSummary \/ Handoff \/ ClaimSuccessor
ProgressStep == Claim1 \/ Claim2 \/ Return1 \/ Return2 \/ ClaimSummary \/ ReturnSummary \/ Handoff \/ ClaimSuccessor
Spec == Init /\ [][Next]_vars /\ WF_vars(ProgressStep)
TypeOK == /\ used \in 2..7 /\ requests \in 1..2 /\ member1 \in 0..2 /\ member2 \in 0..2
          /\ summary \in 0..3 /\ handoff \in BOOLEAN /\ successor \in BOOLEAN /\ reserve \in 0..4
ProtectedDiscussionBudget == used + reserve <= 7
AllSettledBudget == summary > 0 => member1 = 2 /\ member2 = 2
OwnerBudgetHandoff == successor => handoff
Progress == TRUE ~> successor
NeverFrontier == used + reserve < 7
NeverPaidSuccessor == ~successor
NeverConcurrentMembers == ~(member1 = 1 /\ member2 = 1)
======================================================================
