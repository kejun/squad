--------------------------- MODULE Handoff ---------------------------
EXTENDS Naturals, TLC
CONSTANT Mutation
VARIABLES online, marker, consumed, resumes, live, answers, helpLive,
          stopped, epoch, goalVersion, crashed, rolledBack
vars == <<online, marker, consumed, resumes, live, answers, helpLive,
          stopped, epoch, goalVersion, crashed, rolledBack>>

\* Reachable prefix: A requests B, B is claimed, RECORD_RESULT saves R1.
Init == /\ online = TRUE /\ marker = FALSE /\ consumed = FALSE
        /\ resumes = 0 /\ live = FALSE /\ answers = 0 /\ helpLive = TRUE
        /\ stopped = FALSE /\ epoch = 1 /\ goalVersion = 1
        /\ crashed = FALSE /\ rolledBack = FALSE
Eligible == ~marker /\ helpLive /\ ~stopped /\ epoch = 1 /\ goalVersion = 1

\* Each transition below is one committed engine/store transaction, except
\* Crash (lose the process) and Reopen (constructor + one RECOVER transaction).
Accept == /\ marker' = (Mutation # "drop-marker")
          /\ consumed' = TRUE
          /\ resumes' = resumes + (IF Mutation = "double-resume" THEN 2 ELSE 1)
          /\ live' = TRUE /\ answers' = answers + 1 /\ helpLive' = FALSE
          /\ UNCHANGED <<online, stopped, epoch, goalVersion, crashed, rolledBack>>
Flush == /\ online /\ ~marker /\ Mutation # "starve-flush"
         /\ IF Eligible THEN
                 \* flushResults refuses to persist next unless its marker is set.
                 IF Mutation = "drop-marker" THEN UNCHANGED vars ELSE Accept
            ELSE /\ marker' = TRUE
                 /\ UNCHANGED <<online, consumed, resumes, live, answers,
                                helpLive, stopped, epoch, goalVersion, crashed, rolledBack>>
Direct == /\ online /\ IF Eligible THEN Accept
                         ELSE /\ marker' = TRUE
                              /\ UNCHANGED <<online, consumed, resumes, live, answers,
                                             helpLive, stopped, epoch, goalVersion, crashed, rolledBack>>
RetrySaved == /\ online /\ Eligible /\ Accept
DuplicateRecord == /\ online /\ UNCHANGED vars
Stop == /\ online /\ ~stopped
        /\ stopped' = TRUE /\ helpLive' = FALSE
        /\ live' = (IF Mutation = "skip-cancel" THEN live ELSE FALSE)
        /\ UNCHANGED <<online, marker, consumed, resumes, answers, epoch, goalVersion, crashed, rolledBack>>
Continue == /\ online /\ stopped /\ epoch < 2
            /\ epoch' = epoch + 1 /\ stopped' = FALSE
            /\ UNCHANGED <<online, marker, consumed, resumes, live, answers, helpLive, goalVersion, crashed, rolledBack>>
ChangeGoal == /\ online /\ ~stopped /\ goalVersion < 2
              /\ goalVersion' = goalVersion + 1 /\ helpLive' = FALSE /\ live' = FALSE
              /\ UNCHANGED <<online, marker, consumed, resumes, answers, stopped, epoch, crashed, rolledBack>>
Crash == /\ online /\ ~crashed /\ online' = FALSE /\ crashed' = TRUE
         /\ UNCHANGED <<marker, consumed, resumes, live, answers, helpLive, stopped, epoch, goalVersion, rolledBack>>
Rollback == /\ online /\ ~marker /\ ~rolledBack /\ online' = FALSE /\ rolledBack' = TRUE
            /\ UNCHANGED <<marker, consumed, resumes, live, answers, helpLive, stopped, epoch, goalVersion, crashed>>
Reopen == /\ ~online /\ online' = TRUE
          /\ UNCHANGED <<marker, consumed, resumes, live, answers, helpLive, stopped, epoch, goalVersion, crashed, rolledBack>>
Next == Flush \/ Direct \/ RetrySaved \/ DuplicateRecord \/ Stop \/ Continue
        \/ ChangeGoal \/ Crash \/ Rollback \/ Reopen
\* Recovery eventually runs; continuously enabled Flush is eventually called.
Spec == Init /\ [][Next]_vars /\ WF_vars(Reopen) /\ WF_vars(Flush)
TypeOK == /\ online \in BOOLEAN /\ marker \in BOOLEAN /\ consumed \in BOOLEAN
          /\ live \in BOOLEAN /\ helpLive \in BOOLEAN /\ stopped \in BOOLEAN
          /\ crashed \in BOOLEAN /\ rolledBack \in BOOLEAN
          /\ resumes \in 0..2 /\ answers \in 0..2 /\ epoch \in 1..2 /\ goalVersion \in 1..2
AtomicHandoff == (consumed <=> (resumes > 0)) /\ (consumed => marker)
AtMostOnce == resumes <= 1 /\ answers <= 1
StopCancelsResume == stopped => ~live
\* Current eligible saved result cannot be silently lost: it is handed off,
\* or the user explicitly stops/replaces its round or goal.
Progress == Eligible ~> (consumed \/ stopped \/ epoch # 1 \/ goalVersion # 1)
\* Reachability checks intentionally violate these in separate witness runs.
NeverEligible == ~Eligible
NeverHandedOff == ~consumed
NeverStoppedSaved == ~(stopped /\ ~marker)
NeverStaleSaved == ~(goalVersion = 2 /\ ~marker)
NeverRolledBack == ~rolledBack
NeverNewEpochSaved == ~(epoch = 2 /\ ~marker)
======================================================================
