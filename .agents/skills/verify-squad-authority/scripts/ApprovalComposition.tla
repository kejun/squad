---------------------- MODULE ApprovalComposition ----------------------
EXTENDS Naturals, TLC
VARIABLES attempt, stage, approval, revoked, recovered, parentPending,
          permit2, initialApproved, starts
vars == <<attempt, stage, approval, revoked, recovered, parentPending,
          permit2, initialApproved, starts>>
Init == /\ attempt = 1 /\ stage = 0 /\ approval = 0
        /\ revoked = FALSE /\ recovered = FALSE /\ parentPending = FALSE
        /\ permit2 = FALSE /\ initialApproved = FALSE /\ starts = 0
Approve == /\ stage = 0 /\ stage' = 1
           /\ initialApproved' = (initialApproved \/ approval = 0)
           /\ UNCHANGED <<attempt, approval, revoked, recovered, parentPending, permit2, starts>>
Revoke == /\ stage = 1 /\ ~revoked /\ stage' = 0 /\ approval' = approval + 1 /\ revoked' = TRUE
          /\ UNCHANGED <<attempt, recovered, parentPending, permit2, initialApproved, starts>>
Recover == /\ stage < 2 /\ ~recovered /\ stage' = 0 /\ approval' = approval + 1
           /\ recovered' = TRUE /\ parentPending' = TRUE
           /\ UNCHANGED <<attempt, revoked, permit2, initialApproved, starts>>
ReclaimParent == /\ parentPending /\ stage = 1 /\ attempt' = 2 /\ parentPending' = FALSE
                 /\ UNCHANGED <<stage, approval, revoked, recovered, permit2, initialApproved, starts>>
NewPermit == /\ attempt = 2 /\ ~permit2 /\ permit2' = TRUE
             /\ UNCHANGED <<attempt, stage, approval, revoked, recovered, parentPending, initialApproved, starts>>
Claim == /\ stage = 1 /\ ~parentPending /\ (attempt = 1 \/ permit2) /\ stage' = 2
         /\ UNCHANGED <<attempt, approval, revoked, recovered, parentPending, permit2, initialApproved, starts>>
Start == /\ stage = 2 /\ stage' = 3 /\ starts' = starts + 1
         /\ UNCHANGED <<attempt, approval, revoked, recovered, parentPending, permit2, initialApproved>>
LateDecision == approval > 0 /\ UNCHANGED vars
LateClaim == attempt = 2 /\ stage = 1 /\ UNCHANGED vars
ReplayDecision == initialApproved /\ UNCHANGED vars
OldPermit == recovered /\ UNCHANGED vars
DuplicatePermit == attempt = 2 /\ permit2 /\ UNCHANGED vars
LateStart == UNCHANGED vars
Next == Approve \/ Revoke \/ Recover \/ ReclaimParent \/ NewPermit \/ Claim \/ Start
        \/ LateDecision \/ LateClaim \/ ReplayDecision \/ OldPermit \/ DuplicatePermit \/ LateStart
Spec == Init /\ [][Next]_vars /\ WF_vars(Approve) /\ WF_vars(ReclaimParent)
        /\ WF_vars(NewPermit) /\ WF_vars(Claim) /\ WF_vars(Start)
TypeOK == /\ attempt \in 1..2 /\ stage \in 0..3 /\ approval \in 0..2
          /\ revoked \in BOOLEAN /\ recovered \in BOOLEAN /\ parentPending \in BOOLEAN
          /\ permit2 \in BOOLEAN /\ initialApproved \in BOOLEAN /\ starts \in 0..1
OneHostStart == starts <= 1
CurrentAttemptOnly == attempt = 2 => recovered
StartedWithPermit == stage = 3 => (~parentPending /\ (attempt = 1 \/ permit2))
Progress == <> (starts = 1)
NeverReapproved == ~(approval > 0 /\ stage = 1)
NeverFreshAttempt == attempt = 1
NeverFreshStart == ~(attempt = 2 /\ starts = 1)
NeverRevokedRecovered == ~(revoked /\ recovered)
=======================================================================
