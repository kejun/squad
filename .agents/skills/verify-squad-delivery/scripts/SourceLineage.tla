--------------------------- MODULE SourceLineage ---------------------------
EXTENDS Naturals, TLC
CONSTANT Mutation
VARIABLES stage, sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent
vars == <<stage, sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
Init == /\ stage = 0 /\ sourceVersion = 1 /\ frozenVersion = 0
        /\ direct = TRUE /\ reopened = FALSE /\ staleRejected = FALSE /\ recovered = FALSE /\ badFrozenContent = FALSE
FreezeB == /\ stage = 0
    /\ stage' = 1
    /\ frozenVersion' = 1 /\ badFrozenContent' = (Mutation = "corrupt-freeze")
    /\ UNCHANGED <<sourceVersion, direct, reopened, staleRejected, recovered>>
StopB == /\ stage = 1
    /\ stage' = 2
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
ContinueA == /\ stage = 2
    /\ stage' = 3
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
ClaimA == /\ stage = 3
    /\ stage' = 4
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
DeliverA == /\ stage = 4
    /\ stage' = 5
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
ClaimCheckA == /\ stage = 5
    /\ stage' = 6
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
ConsumeA == /\ stage = 6
    /\ stage' = 7
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
RepublishA == /\ stage = 7
    /\ stage' = 8
    /\ sourceVersion' = 2
    /\ frozenVersion' = frozenVersion
    /\ UNCHANGED <<direct, reopened, staleRejected, recovered, badFrozenContent>>
ResumeB == /\ stage = 8
    /\ stage' = 9
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
ClaimB == /\ stage = 9
    /\ stage' = 10
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
DeliverB == /\ stage = 10
    /\ stage' = 11
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
ClaimCheckB == /\ stage = 11
    /\ stage' = 12
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
ConsumeB == /\ stage = 12
    /\ stage' = 13
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
PublishB == /\ stage = 13
    /\ stage' = 14
    /\ UNCHANGED <<sourceVersion, frozenVersion, direct, reopened, staleRejected, recovered, badFrozenContent>>
FreezeC == /\ stage = 14
    /\ stage' = 15
    /\ direct' = (Mutation # "transitive-source")
    /\ UNCHANGED <<sourceVersion, frozenVersion, reopened, staleRejected, recovered, badFrozenContent>>
RejectStale == /\ stage = 8 /\ ~staleRejected /\ staleRejected' = TRUE
    /\ UNCHANGED <<stage, sourceVersion, frozenVersion, direct, reopened, recovered, badFrozenContent>>
ReplayFreeze == /\ stage > 0 /\ UNCHANGED vars
ConflictReplay == /\ stage >= 8 /\ UNCHANGED vars
Reopen == /\ ~reopened /\ reopened' = TRUE
    /\ UNCHANGED <<stage, sourceVersion, frozenVersion, direct, staleRejected, recovered, badFrozenContent>>
RecoverFrozen == /\ reopened /\ ~recovered /\ stage \in {1,2,3,4,5,6,7,8,9,11,14,15}
    /\ recovered' = TRUE /\ UNCHANGED <<stage, sourceVersion, frozenVersion, direct, reopened, staleRejected, badFrozenContent>>
Next == RecoverFrozen \/ FreezeB \/ StopB \/ ContinueA \/ ClaimA \/ DeliverA \/ ClaimCheckA \/ ConsumeA \/ RepublishA \/ ResumeB \/ ClaimB \/ DeliverB \/ ClaimCheckB \/ ConsumeB \/ PublishB \/ FreezeC \/ RejectStale \/ ReplayFreeze \/ ConflictReplay \/ Reopen
Spec == Init /\ [][Next]_vars /\ WF_vars(FreezeB) /\ WF_vars(StopB) /\ WF_vars(ContinueA) /\ WF_vars(ClaimA) /\ WF_vars(DeliverA) /\ WF_vars(ClaimCheckA) /\ WF_vars(ConsumeA) /\ WF_vars(RepublishA) /\ WF_vars(ResumeB) /\ WF_vars(ClaimB) /\ WF_vars(DeliverB) /\ WF_vars(ClaimCheckB) /\ WF_vars(ConsumeB) /\ WF_vars(PublishB) /\ WF_vars(FreezeC)
TypeOK == /\ stage \in 0..15 /\ sourceVersion \in 1..2 /\ frozenVersion \in 0..2
    /\ direct \in BOOLEAN /\ reopened \in BOOLEAN /\ staleRejected \in BOOLEAN /\ recovered \in BOOLEAN /\ badFrozenContent \in BOOLEAN
FrozenSource == (stage > 0) => (frozenVersion = 1 /\ ~badFrozenContent)
DirectLineage == direct
Progress == stage = 1 ~> stage = 15
NeverSourceReplaced == sourceVersion = 1
NeverDirectChild == stage # 15
NeverRejectedStale == ~staleRejected
NeverReopened == ~reopened
=======================================================================
