------------------------- MODULE ReviewQueue -------------------------
EXTENDS Naturals, TLC
VARIABLES work1, work2, result1, result2, saved1, saved2, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch
vars == <<work1, work2, result1, result2, saved1, saved2, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch>>
Init == work1 = 1 /\ work2 = 0 /\ result1 = 0 /\ result2 = 0 /\ saved1 = FALSE /\ saved2 = FALSE /\ completed1 = FALSE /\ completed2 = FALSE /\ round = 0 /\ incomplete = FALSE /\ syntheses = 0 /\ liveOwner = FALSE /\ stopped = FALSE /\ recovered = FALSE /\ retried = FALSE /\ epoch = 1
Claim1 == /\ round = 0 /\ ~stopped /\ work1 = 1
    /\ work1' = (2)
    /\ UNCHANGED <<work2, result1, result2, saved1, saved2, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch>>
Success1 == /\ round = 0 /\ ~stopped /\ work1 = 2
    /\ work1' = (3)
    /\ result1' = (1)
    /\ saved1' = (TRUE)
    /\ UNCHANGED <<work2, result2, saved2, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch>>
Failure1 == /\ round = 0 /\ ~stopped /\ work1 = 2
    /\ work1' = (3)
    /\ result1' = (2)
    /\ saved1' = (TRUE)
    /\ UNCHANGED <<work2, result2, saved2, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch>>
Fail1 == /\ round = 0 /\ ~stopped /\ work1 = 2
    /\ work1' = (3)
    /\ work2' = (IF completed2 THEN work2 ELSE 1)
    /\ result1' = (2)
    /\ saved1' = (FALSE)
    /\ completed1' = (TRUE)
    /\ round' = (IF completed2 THEN 1 ELSE 0)
    /\ incomplete' = (incomplete \/ (2 = 2))
    /\ syntheses' = (IF completed2 THEN syntheses+1 ELSE syntheses)
    /\ liveOwner' = (completed2)
    /\ UNCHANGED <<result2, saved2, completed2, stopped, recovered, retried, epoch>>
Flush1 == /\ saved1 /\ epoch = 1
    /\ work2' = (IF stopped THEN work2 ELSE (IF completed2 THEN work2 ELSE 1))
    /\ saved1' = (FALSE)
    /\ completed1' = (IF stopped THEN completed1 ELSE (TRUE))
    /\ round' = (IF stopped THEN round ELSE (IF completed2 THEN 1 ELSE 0))
    /\ incomplete' = (IF stopped THEN incomplete ELSE (incomplete \/ (result1 = 2)))
    /\ syntheses' = (IF stopped THEN syntheses ELSE (IF completed2 THEN syntheses+1 ELSE syntheses))
    /\ liveOwner' = (IF stopped THEN liveOwner ELSE (completed2))
    /\ UNCHANGED <<work1, result1, result2, saved2, completed2, stopped, recovered, retried, epoch>>
Late1 == /\ (completed1 \/ (stopped /\ work1 = 2) \/ (retried /\ ~stopped)) /\ work1 # 0
    /\ work1' = (IF stopped /\ work1 = 2 THEN 3 ELSE work1)
    /\ UNCHANGED <<work2, result1, result2, saved1, saved2, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch>>
Claim2 == /\ round = 0 /\ ~stopped /\ work2 = 1
    /\ work2' = (2)
    /\ UNCHANGED <<work1, result1, result2, saved1, saved2, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch>>
Success2 == /\ round = 0 /\ ~stopped /\ work2 = 2
    /\ work2' = (3)
    /\ result2' = (1)
    /\ saved2' = (TRUE)
    /\ UNCHANGED <<work1, result1, saved1, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch>>
Failure2 == /\ round = 0 /\ ~stopped /\ work2 = 2
    /\ work2' = (3)
    /\ result2' = (2)
    /\ saved2' = (TRUE)
    /\ UNCHANGED <<work1, result1, saved1, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch>>
Fail2 == /\ round = 0 /\ ~stopped /\ work2 = 2
    /\ work2' = (3)
    /\ result2' = (2)
    /\ saved2' = (FALSE)
    /\ completed2' = (TRUE)
    /\ round' = (1)
    /\ incomplete' = (incomplete \/ (2 = 2))
    /\ syntheses' = (syntheses+1)
    /\ liveOwner' = (TRUE)
    /\ UNCHANGED <<work1, result1, saved1, completed1, stopped, recovered, retried, epoch>>
Flush2 == /\ saved2 /\ epoch = 1
    /\ saved2' = (FALSE)
    /\ completed2' = (IF stopped THEN completed2 ELSE (TRUE))
    /\ round' = (IF stopped THEN round ELSE (1))
    /\ incomplete' = (IF stopped THEN incomplete ELSE (incomplete \/ (result2 = 2)))
    /\ syntheses' = (IF stopped THEN syntheses ELSE (syntheses+1))
    /\ liveOwner' = (IF stopped THEN liveOwner ELSE (TRUE))
    /\ UNCHANGED <<work1, work2, result1, result2, saved1, completed1, stopped, recovered, retried, epoch>>
Late2 == /\ (completed2 \/ (stopped /\ work2 = 2)) /\ work2 # 0
    /\ work2' = (IF stopped /\ work2 = 2 THEN 3 ELSE work2)
    /\ UNCHANGED <<work1, result1, result2, saved1, saved2, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, recovered, retried, epoch>>
Stop == /\ ~stopped /\ round = 0
    /\ work1' = (IF work1 = 1 THEN 4 ELSE work1)
    /\ work2' = (IF work2 = 1 THEN 4 ELSE work2)
    /\ round' = (2)
    /\ liveOwner' = (FALSE)
    /\ stopped' = (TRUE)
    /\ UNCHANGED <<result1, result2, saved1, saved2, completed1, completed2, incomplete, syntheses, recovered, retried, epoch>>
Continue == /\ stopped /\ epoch = 1 /\ work1 # 2 /\ work2 # 2
    /\ work1' = (0)
    /\ work2' = (0)
    /\ result1' = (0)
    /\ result2' = (0)
    /\ saved1' = (FALSE)
    /\ saved2' = (FALSE)
    /\ completed1' = (FALSE)
    /\ completed2' = (FALSE)
    /\ round' = (3)
    /\ incomplete' = (FALSE)
    /\ stopped' = (FALSE)
    /\ epoch' = (2)
    /\ UNCHANGED <<syntheses, liveOwner, recovered, retried>>
Recover == /\ ~recovered /\ ~stopped /\ epoch = 1
    /\ work1' = (IF work1 = 2 THEN 1 ELSE work1)
    /\ work2' = (IF work2 = 2 THEN 1 ELSE work2)
    /\ recovered' = (TRUE)
    /\ UNCHANGED <<result1, result2, saved1, saved2, completed1, completed2, round, incomplete, syntheses, liveOwner, stopped, retried, epoch>>
RetryFirst == /\ round = 1 /\ result1 = 2 /\ ~retried
    /\ work1' = (1)
    /\ result1' = (0)
    /\ saved1' = (FALSE)
    /\ completed1' = (FALSE)
    /\ round' = (0)
    /\ incomplete' = (result2 = 2)
    /\ liveOwner' = (FALSE)
    /\ retried' = (TRUE)
    /\ UNCHANGED <<work2, result2, saved2, completed2, syntheses, stopped, recovered, epoch>>
Next == Claim1 \/ Success1 \/ Failure1 \/ Fail1 \/ Flush1 \/ Late1 \/ Claim2 \/ Success2 \/ Failure2 \/ Fail2 \/ Flush2 \/ Late2 \/ Stop \/ Continue \/ Recover \/ RetryFirst
ProgressStep == Claim1 \/ Claim2 \/ Success1 \/ Success2 \/ Flush1 \/ Flush2
Spec == Init /\ [][Next]_vars /\ WF_vars(ProgressStep)
TypeOK == /\ work1 \in 0..4 /\ work2 \in 0..4 /\ result1 \in 0..2 /\ result2 \in 0..2
          /\ saved1 \in BOOLEAN /\ saved2 \in BOOLEAN /\ completed1 \in BOOLEAN /\ completed2 \in BOOLEAN
          /\ round \in 0..3 /\ incomplete \in BOOLEAN /\ syntheses \in 0..2 /\ liveOwner \in BOOLEAN
          /\ stopped \in BOOLEAN /\ recovered \in BOOLEAN /\ retried \in BOOLEAN /\ epoch \in 1..2
AllReviewersSettled == round = 1 => completed1 /\ completed2
UniqueReviewSynthesis == syntheses <= (IF retried THEN 2 ELSE 1)
PreserveReviewFailure == ((completed1 /\ result1 = 2) \/ (completed2 /\ result2 = 2)) => incomplete
StoppedReview == stopped => ~liveOwner
Progress == round = 0 /\ ~stopped ~> (round = 1 \/ stopped)
NeverSynthesis == syntheses = 0
NeverRecoveredSaved == ~(recovered /\ (saved1 \/ saved2))
NeverRepairedReview == ~(retried /\ syntheses = 2)
NeverNewRound == epoch = 1
======================================================================
