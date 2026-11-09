------------------------ MODULE ReservedRequests ------------------------
EXTENDS Naturals, TLC
CONSTANTS InitialUsed, Limit, Reserve
VARIABLES used, requests, reserve
vars == <<used, requests, reserve>>
Init == used = InitialUsed /\ requests = 0 /\ reserve = Reserve
FirstRequest == /\ requests = 0 /\ requests' = 1 /\ UNCHANGED <<used, reserve>>
AdditionalRequest == /\ requests > 0 /\ used + 1 + reserve <= Limit
                     /\ used' = used + 1 /\ requests' = requests + 1 /\ UNCHANGED reserve
DeniedRequest == /\ requests > 0 /\ used + 1 + reserve > Limit /\ UNCHANGED vars
Next == FirstRequest \/ AdditionalRequest \/ DeniedRequest
Spec == Init /\ [][Next]_vars
TypeOK == used \in 0..Limit /\ requests \in 0..Limit /\ reserve \in 1..3
ProtectedContinuation == used + reserve <= Limit
SharedRequestAccounting == used = InitialUsed + (IF requests = 0 THEN 0 ELSE requests - 1)
NeverAdditional == requests < 2
NeverReservedFrontier == used + reserve < Limit
======================================================================
