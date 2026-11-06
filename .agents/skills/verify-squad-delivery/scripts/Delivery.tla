--------------------------- MODULE Delivery ---------------------------
EXTENDS Naturals, TLC
CONSTANT Mutation
VARIABLES online, published, finals, stopped, goalVersion, crashed, rolledBack, staleAccepted
vars == <<online, published, finals, stopped, goalVersion, crashed, rolledBack, staleAccepted>>
Init == /\ online = TRUE /\ published = FALSE /\ finals = 0 /\ stopped = FALSE
        /\ goalVersion = 1 /\ crashed = FALSE /\ rolledBack = FALSE /\ staleAccepted = FALSE
Eligible == ~published /\ ~stopped /\ goalVersion = 1
Publish == /\ online /\ Eligible /\ published' = TRUE
           /\ finals' = (IF Mutation = "drop-final" THEN 0 ELSE 1)
           /\ UNCHANGED <<online, stopped, goalVersion, crashed, rolledBack, staleAccepted>>
StaleRevision == /\ online
                 /\ IF Eligible /\ Mutation = "accept-stale" THEN
                      /\ published' = TRUE /\ finals' = 1 /\ staleAccepted' = TRUE
                    ELSE UNCHANGED <<published, finals, staleAccepted>>
                 /\ UNCHANGED <<online, stopped, goalVersion, crashed, rolledBack>>
Duplicate == /\ online /\ published /\ UNCHANGED vars
Stop == /\ online /\ ~published /\ ~stopped /\ stopped' = TRUE
        /\ UNCHANGED <<online, published, finals, goalVersion, crashed, rolledBack, staleAccepted>>
ChangeGoal == /\ online /\ ~published /\ ~stopped /\ goalVersion = 1 /\ goalVersion' = 2
              /\ UNCHANGED <<online, published, finals, stopped, crashed, rolledBack, staleAccepted>>
LateCheck == /\ online /\ (~Eligible) /\ UNCHANGED vars
Crash == /\ online /\ ~crashed /\ online' = FALSE /\ crashed' = TRUE
         /\ UNCHANGED <<published, finals, stopped, goalVersion, rolledBack, staleAccepted>>
Rollback == /\ online /\ Eligible /\ ~rolledBack /\ online' = FALSE /\ rolledBack' = TRUE
            /\ UNCHANGED <<published, finals, stopped, goalVersion, crashed, staleAccepted>>
Reopen == /\ ~online /\ online' = TRUE
          /\ UNCHANGED <<published, finals, stopped, goalVersion, crashed, rolledBack, staleAccepted>>
Next == Publish \/ StaleRevision \/ Duplicate \/ Stop \/ ChangeGoal \/ LateCheck \/ Crash \/ Rollback \/ Reopen
Spec == Init /\ [][Next]_vars /\ WF_vars(Reopen) /\ WF_vars(Publish)
TypeOK == /\ online \in BOOLEAN /\ published \in BOOLEAN /\ stopped \in BOOLEAN
          /\ crashed \in BOOLEAN /\ rolledBack \in BOOLEAN /\ staleAccepted \in BOOLEAN
          /\ finals \in 0..1 /\ goalVersion \in 1..2
AtomicPublication == published <=> (finals = 1)
CurrentCandidate == ~staleAccepted
VersionIsolation == published => (~stopped /\ goalVersion = 1)
Progress == Eligible ~> (published \/ stopped \/ goalVersion = 2)
NeverPublished == ~published
NeverStopped == ~stopped
NeverChangedGoal == goalVersion = 1
NeverRolledBack == ~rolledBack
NeverCrashed == ~crashed
=======================================================================
