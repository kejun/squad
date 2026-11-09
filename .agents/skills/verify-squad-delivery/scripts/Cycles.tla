--------------------------- MODULE Cycles ---------------------------
EXTENDS Naturals, TLC
CONSTANT Mutation
VARIABLES cycle, mode, candidate, publication, finals, revised, stopped, online, rolledBack, oldAccepted
vars == <<cycle, mode, candidate, publication, finals, revised, stopped, online, rolledBack, oldAccepted>>
Init == /\ cycle = 1 /\ mode = 0 /\ candidate = 1 /\ publication = 1 /\ finals = 1
        /\ revised = FALSE /\ stopped = FALSE /\ online = TRUE /\ rolledBack = FALSE /\ oldAccepted = FALSE
Continue == /\ online /\ mode = 0 /\ cycle < 3 /\ cycle' = cycle + 1 /\ mode' = 1
            /\ publication' = (IF Mutation = "drop-publication" THEN 0 ELSE publication)
            /\ UNCHANGED <<candidate, finals, revised, stopped, online, rolledBack, oldAccepted>>
Draft == /\ online /\ mode = 2 /\ mode' = 3 /\ candidate' = candidate + 1
         /\ UNCHANGED <<cycle, publication, finals, revised, stopped, online, rolledBack, oldAccepted>>
Pass == /\ online /\ mode = 5 /\ mode' = 0 /\ publication' = candidate /\ finals' = finals + 1
        /\ UNCHANGED <<cycle, candidate, revised, stopped, online, rolledBack, oldAccepted>>
Fail == /\ online /\ mode = 5 /\ ~revised /\ revised' = TRUE /\ mode' = 1
        /\ UNCHANGED <<cycle, candidate, publication, finals, stopped, online, rolledBack, oldAccepted>>
OldReceipt == /\ online /\ mode = 5 /\ oldAccepted' = (Mutation = "accept-stale")
              /\ UNCHANGED <<cycle, mode, candidate, publication, finals, revised, stopped, online, rolledBack>>
LateReceipt == /\ online /\ cycle > 1 /\ UNCHANGED vars
Duplicate == /\ online /\ mode = 0 /\ UNCHANGED vars
Stop == /\ online /\ mode \in 1..5 /\ mode' = 6 /\ stopped' = TRUE
        /\ UNCHANGED <<cycle, candidate, publication, finals, revised, online, rolledBack, oldAccepted>>
Rollback == /\ online /\ mode = 5 /\ ~rolledBack /\ online' = FALSE /\ rolledBack' = TRUE
            /\ UNCHANGED <<cycle, mode, candidate, publication, finals, revised, stopped, oldAccepted>>
Reopen == /\ ~online /\ online' = TRUE
          /\ UNCHANGED <<cycle, mode, candidate, publication, finals, revised, stopped, rolledBack, oldAccepted>>
ClaimOwner == /\ online /\ mode = 1 /\ mode' = 2
    /\ UNCHANGED <<cycle, candidate, publication, finals, revised, stopped, online, rolledBack, oldAccepted>>
ClaimCheck == /\ online /\ mode = 3 /\ mode' = 4
    /\ UNCHANGED <<cycle, candidate, publication, finals, revised, stopped, online, rolledBack, oldAccepted>>
Consume == /\ online /\ mode = 4 /\ mode' = 5
    /\ UNCHANGED <<cycle, candidate, publication, finals, revised, stopped, online, rolledBack, oldAccepted>>
Next == ClaimOwner \/ ClaimCheck \/ Consume \/ Continue \/ Draft \/ Pass \/ Fail \/ OldReceipt \/ LateReceipt \/ Duplicate \/ Stop \/ Rollback \/ Reopen
Spec == Init /\ [][Next]_vars /\ WF_vars(ClaimOwner) /\ WF_vars(ClaimCheck) /\ WF_vars(Consume) /\ WF_vars(Draft) /\ WF_vars(Pass) /\ WF_vars(Reopen)
TypeOK == /\ cycle \in 1..3 /\ mode \in 0..6 /\ candidate \in 1..4 /\ publication \in 0..4 /\ finals \in 1..3
          /\ revised \in BOOLEAN /\ stopped \in BOOLEAN /\ online \in BOOLEAN /\ rolledBack \in BOOLEAN /\ oldAccepted \in BOOLEAN
RetainedPublication == publication >= 1 /\ publication <= candidate
CurrentCandidate == ~oldAccepted
OneFinalPerCycle == finals = (IF mode = 0 THEN cycle ELSE cycle - 1)
Progress == (mode \in 1..5) ~> (mode = 0 \/ stopped)
NeverThirdPublication == finals < 3
NeverRevised == ~revised
NeverRolledBack == ~rolledBack
=======================================================================
