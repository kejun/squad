--------------------------- MODULE ForwardDelivery ---------------------------
EXTENDS Naturals, TLC
CONSTANT Mutation
VARIABLES phase, verdict, revision, owners, published, gaps, verified, stopped, goal, reopened, online, rolledBack, history
vars == <<phase, verdict, revision, owners, published, gaps, verified, stopped, goal, reopened, online, rolledBack, history>>
\* Prefix: two settled map children (one success, one failure), reducer returned, owner claimed.
\* 0=owner,1=check pending,2=check claimed,3=request consumed,4=terminal/invalidated.
Init == /\ phase = 0 /\ verdict = 0 /\ revision = 0 /\ owners = 1
        /\ published = FALSE /\ gaps = FALSE /\ verified = FALSE /\ stopped = FALSE
        /\ goal = 1 /\ reopened = FALSE /\ online = TRUE /\ rolledBack = FALSE /\ history = TRUE
Submit == /\ online /\ phase = 0 /\ phase' = 1 /\ revision' = 1
    /\ UNCHANGED <<verdict, owners, published, gaps, verified, stopped, goal, reopened, online, rolledBack, history>>
Claim == /\ online /\ phase = 1 /\ phase' = 2
    /\ UNCHANGED <<verdict, revision, owners, published, gaps, verified, stopped, goal, reopened, online, rolledBack, history>>
Consume == /\ online /\ phase = 2 /\ phase' = 3
    /\ UNCHANGED <<verdict, revision, owners, published, gaps, verified, stopped, goal, reopened, online, rolledBack, history>>
Pass == /\ online /\ phase = 3 /\ phase' = 4 /\ verdict' = 1
    /\ published' = TRUE /\ gaps' = (1 > 1 /\ Mutation # "hide-gap")
    /\ verified' = (1 = 1) /\ revision' = revision
    /\ owners' = (IF Mutation = "return-owner" THEN owners + 1 ELSE owners)
    /\ UNCHANGED <<stopped, goal, reopened, online, rolledBack, history>>
DeclareFailed == /\ online /\ phase = 3 /\ phase' = 4 /\ verdict' = 2
    /\ published' = TRUE /\ gaps' = (2 > 1 /\ Mutation # "hide-gap")
    /\ verified' = (2 = 1) /\ revision' = revision
    /\ owners' = (IF Mutation = "return-owner" THEN owners + 1 ELSE owners)
    /\ UNCHANGED <<stopped, goal, reopened, online, rolledBack, history>>
DeclareUnverified == /\ online /\ phase = 3 /\ phase' = 4 /\ verdict' = 3
    /\ published' = TRUE /\ gaps' = (3 > 1 /\ Mutation # "hide-gap")
    /\ verified' = (3 = 1) /\ revision' = revision
    /\ owners' = (IF Mutation = "return-owner" THEN owners + 1 ELSE owners)
    /\ UNCHANGED <<stopped, goal, reopened, online, rolledBack, history>>
Repair == /\ online /\ phase = 3 /\ phase' = 4 /\ verdict' = 1
    /\ published' = TRUE /\ gaps' = (1 > 1 /\ Mutation # "hide-gap")
    /\ verified' = (1 = 1) /\ revision' = 2
    /\ owners' = (IF Mutation = "return-owner" THEN owners + 1 ELSE owners)
    /\ UNCHANGED <<stopped, goal, reopened, online, rolledBack, history>>
Stale == /\ online /\ phase = 3 /\ UNCHANGED vars
Duplicate == /\ online /\ phase = 4 /\ UNCHANGED vars
Stop == /\ online /\ phase < 4 /\ phase' = 4 /\ stopped' = TRUE
    /\ UNCHANGED <<verdict, revision, owners, published, gaps, verified, goal, reopened, online, rolledBack, history>>
ChangeGoal == /\ online /\ phase < 4 /\ phase' = 4 /\ goal' = 2
    /\ UNCHANGED <<verdict, revision, owners, published, gaps, verified, stopped, reopened, online, rolledBack, history>>
Reopen == /\ ~reopened /\ reopened' = TRUE /\ online' = TRUE
    /\ UNCHANGED <<phase, verdict, revision, owners, published, gaps, verified, stopped, goal, rolledBack, history>>
Rollback == /\ online /\ phase = 3 /\ ~rolledBack /\ ~reopened
    /\ online' = FALSE /\ rolledBack' = TRUE
    /\ UNCHANGED <<phase, verdict, revision, owners, published, gaps, verified, stopped, goal, reopened, history>>
Next == Submit \/ Claim \/ Consume \/ Pass \/ DeclareFailed \/ DeclareUnverified \/ Repair \/ Stale \/ Duplicate \/ Stop \/ ChangeGoal \/ Reopen \/ Rollback
Advance == Submit \/ Claim \/ Consume \/ Pass \/ DeclareFailed \/ DeclareUnverified \/ Repair
Spec == Init /\ [][Next]_vars /\ WF_vars(Reopen) /\ WF_vars(Advance)
TypeOK == /\ phase \in 0..4 /\ verdict \in 0..3 /\ revision \in 0..2 /\ owners \in 1..2
    /\ published \in BOOLEAN /\ gaps \in BOOLEAN /\ verified \in BOOLEAN /\ stopped \in BOOLEAN
    /\ goal \in 1..2 /\ reopened \in BOOLEAN /\ online \in BOOLEAN /\ rolledBack \in BOOLEAN /\ history \in BOOLEAN
NoReviewBackflow == owners = 1
DeclaredGaps == verdict > 1 => (published /\ gaps /\ ~verified)
CurrentVerdict == published => (phase = 4 /\ verdict > 0 /\ ~stopped /\ goal = 1)
HistoryImmutable == history
Progress == phase < 4 ~> phase = 4
NeverGapDelivery == ~(published /\ gaps)
NeverDirectRepair == revision < 2
NeverPublication == ~published
NeverRollback == ~rolledBack
NeverReopened == ~reopened
NeverStoppedCheck == ~(stopped /\ revision = 1)
NeverStaleGoal == goal = 1
=============================================================================
