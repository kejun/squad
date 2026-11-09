--------------------------- MODULE LocalEffects ---------------------------
EXTENDS Naturals, TLC
CONSTANT Mutation
VARIABLES op, journal, online, crashed, rolledBack, stopped, lease, pending,
          receipts, starts, competitor, badSession, falseNotStarted
vars == <<op, journal, online, crashed, rolledBack, stopped, lease, pending,
          receipts, starts, competitor, badSession, falseNotStarted>>
\* op: 1 claimed, 2 running, 3 uncertain, 4 succeeded, 6 cancelling.
\* journal: 1 prepared/possibly spawned, 2 trusted settled receipt.
\* lease: 0 free, 1 original operation, 2 competing room.
Unsettled == op \in {1,2,3,6}
Init == /\ op = 1 /\ journal = 1 /\ online = TRUE
        /\ crashed = FALSE /\ rolledBack = FALSE /\ stopped = FALSE
        /\ lease = 1 /\ pending = TRUE /\ receipts = 0 /\ starts = 0
        /\ competitor = FALSE /\ badSession = FALSE /\ falseNotStarted = FALSE
Start == /\ online /\ op = 1 /\ ~stopped
         /\ op' = 2 /\ starts' = starts + 1
         /\ UNCHANGED <<journal, online, crashed, rolledBack, stopped, lease, pending, receipts, competitor, badSession, falseNotStarted>>
SaveReceipt == /\ online /\ Unsettled /\ journal = 1 /\ journal' = 2
               /\ UNCHANGED <<op, online, crashed, rolledBack, stopped, lease, pending, receipts, starts, competitor, badSession, falseNotStarted>>
UnknownResult == /\ online /\ op \in {1,2,6} /\ journal = 1
                 /\ op' = 3 /\ lease' = IF Mutation = "release-unknown" THEN 0 ELSE lease
                 /\ UNCHANGED <<journal, online, crashed, rolledBack, stopped, pending, receipts, starts, competitor, badSession, falseNotStarted>>
Stop == /\ online /\ ~stopped /\ stopped' = TRUE
        /\ op' = IF op \in {1,2} THEN 6 ELSE op
        /\ UNCHANGED <<journal, online, crashed, rolledBack, lease, pending, receipts, starts, competitor, badSession, falseNotStarted>>
Crash == /\ online /\ ~crashed /\ online' = FALSE /\ crashed' = TRUE
         /\ UNCHANGED <<op, journal, rolledBack, stopped, lease, pending, receipts, starts, competitor, badSession, falseNotStarted>>
Reopen == /\ ~online /\ online' = TRUE
          /\ op' = IF op \in {1,2,6} THEN 3 ELSE op
          /\ UNCHANGED <<journal, crashed, rolledBack, stopped, lease, pending, receipts, starts, competitor, badSession, falseNotStarted>>
Commit == /\ online /\ Unsettled /\ journal = 2
          /\ op' = 4 /\ pending' = (Mutation = "drop-checkpoint")
          /\ receipts' = 1 /\ lease' = 0
          /\ UNCHANGED <<journal, online, crashed, rolledBack, stopped, starts, competitor, badSession, falseNotStarted>>
Rollback == /\ online /\ Unsettled /\ journal = 2 /\ ~rolledBack
            /\ online' = FALSE /\ rolledBack' = TRUE
            /\ UNCHANGED <<op, journal, crashed, stopped, lease, pending, receipts, starts, competitor, badSession, falseNotStarted>>
UnknownProbe == /\ online /\ op = 3 /\ journal = 1
                /\ falseNotStarted' = (Mutation = "replay-unknown")
                /\ UNCHANGED <<op, journal, online, crashed, rolledBack, stopped, lease, pending, receipts, starts, competitor, badSession>>
WrongSession == /\ online /\ Unsettled
                /\ IF Mutation = "wrong-session" THEN
                     /\ op' = 4 /\ pending' = FALSE /\ receipts' = 1 /\ lease' = 0 /\ badSession' = TRUE
                     /\ UNCHANGED <<journal, online, crashed, rolledBack, stopped, starts, competitor, falseNotStarted>>
                   ELSE UNCHANGED vars
Duplicate == /\ online /\ op = 4 /\ UNCHANGED vars
Compete == /\ online /\ lease = 0 /\ ~competitor
           /\ lease' = 2 /\ competitor' = TRUE
           /\ UNCHANGED <<op, journal, online, crashed, rolledBack, stopped, pending, receipts, starts, badSession, falseNotStarted>>
BusyProbe == /\ online /\ lease = 1 /\ ~competitor /\ UNCHANGED vars
Next == Start \/ SaveReceipt \/ UnknownResult \/ Stop \/ Crash \/ Reopen \/ Commit \/ Rollback
        \/ UnknownProbe \/ WrongSession \/ Duplicate \/ Compete \/ BusyProbe
Spec == Init /\ [][Next]_vars /\ WF_vars(Reopen) /\ WF_vars(Commit)
TypeOK == /\ op \in {0,1,2,3,4,6} /\ journal \in {1,2}
          /\ online \in BOOLEAN /\ crashed \in BOOLEAN /\ rolledBack \in BOOLEAN
          /\ stopped \in BOOLEAN /\ lease \in 0..2 /\ pending \in BOOLEAN
          /\ receipts \in 0..1 /\ starts \in 0..1 /\ competitor \in BOOLEAN /\ badSession \in BOOLEAN /\ falseNotStarted \in BOOLEAN
UnconfirmedKeepsLease == Unsettled => lease = 1
AtomicCheckpoint == (op = 4) <=> (~pending /\ receipts = 1)
CompetitorAfterSettlement == competitor => op = 4
OneStart == starts <= 1
NoUnsafeReplay == op # 0
SessionBound == ~badSession
NoFalseNotStarted == ~falseNotStarted
SettledProgress == (journal = 2) ~> (op = 4)
NeverStarted == starts = 0
NeverUnknown == op # 3
NeverCommitted == op # 4
NeverStoppedReceipt == ~(stopped /\ op = 4)
NeverRollback == ~rolledBack
NeverCompetitor == ~competitor
=============================================================================
