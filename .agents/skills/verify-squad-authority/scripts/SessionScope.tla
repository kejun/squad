-------------------------- MODULE SessionScope --------------------------
EXTENDS Naturals, TLC
VARIABLES mask, revoked, allowed
vars == <<mask, revoked, allowed>>
Init == /\ mask \in 0..255 /\ revoked = FALSE /\ allowed = (mask = 0)
Revoke == /\ ~revoked /\ revoked' = TRUE /\ allowed' = FALSE /\ UNCHANGED mask
Next == Revoke
Spec == Init /\ [][Next]_vars
ScopeBound == allowed => (mask = 0 /\ ~revoked)
UsableReachable == ~allowed
RevokedReachable == ~revoked
=============================================================================
