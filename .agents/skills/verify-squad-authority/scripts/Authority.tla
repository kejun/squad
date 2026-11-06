--------------------------- MODULE Authority ---------------------------
EXTENDS Naturals, TLC
CONSTANTS Domain, Fault
VARIABLES stage, stopped, expired, recovered, busy, starts, unsafe
vars == <<stage, stopped, expired, recovered, busy, starts, unsafe>>
Init == /\ stage = 0 /\ stopped = FALSE /\ expired = FALSE
        /\ recovered = FALSE /\ busy = FALSE /\ starts = 0 /\ unsafe = FALSE
Valid == ~stopped /\ ~expired /\ ~recovered
Approve == /\ Domain = "host" /\ stage = 0 /\ Valid
           /\ stage' = 1 /\ UNCHANGED <<stopped, expired, recovered, busy, starts, unsafe>>
Claim == /\ Domain = "host" /\ stage = 1 /\ Valid /\ ~busy
         /\ stage' = 2 /\ UNCHANGED <<stopped, expired, recovered, busy, starts, unsafe>>
Start == /\ (Valid \/ Fault = "revocation") /\ stage = (IF Domain = "host" THEN 2 ELSE 0)
         /\ stage' = 3 /\ starts' = starts + 1 /\ unsafe' = (unsafe \/ ~Valid)
         /\ UNCHANGED <<stopped, expired, recovered, busy>>
Stop == /\ ~stopped /\ stopped' = TRUE /\ UNCHANGED <<stage, expired, recovered, busy, starts, unsafe>>
Expire == /\ Domain = "host" /\ ~expired /\ expired' = TRUE
          /\ UNCHANGED <<stage, stopped, recovered, busy, starts, unsafe>>
Recover == /\ ~recovered /\ recovered' = TRUE /\ UNCHANGED <<stage, stopped, expired, busy, starts, unsafe>>
LeaseBusy == /\ Domain = "host" /\ stage < 2 /\ ~busy /\ busy' = TRUE
             /\ UNCHANGED <<stage, stopped, expired, recovered, starts, unsafe>>
StartDenied == /\ (~Valid \/ stage # (IF Domain = "host" THEN 2 ELSE 0)) /\ UNCHANGED vars
Next == StartDenied \/ Approve \/ Claim \/ Start \/ Stop \/ Expire \/ Recover \/ LeaseBusy
Spec == Init /\ [][Next]_vars
TypeOK == stage \in 0..3 /\ starts \in 0..1 /\ stopped \in BOOLEAN /\ expired \in BOOLEAN /\ recovered \in BOOLEAN /\ busy \in BOOLEAN
OneStart == starts <= 1
NoUnauthorizedStart == ~unsafe
StartedReachable == starts = 0
RevokedReachable == ~stopped
RecoveredReachable == ~recovered
ApprovedReachable == stage # 1
LeaseReachable == ~busy
=============================================================================
