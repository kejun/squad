------------------------ MODULE RetryComposition ------------------------
EXTENDS Naturals
CONSTANT Saved
VARIABLES savedInitial, command1, command2, successors, stage, retryPending, originalConsumed,
          resumes, memberRevoked, ownerChanged, recovered
vars == <<savedInitial, command1, command2, successors, stage, retryPending, originalConsumed,
          resumes, memberRevoked, ownerChanged, recovered>>
Init == /\ savedInitial = Saved /\ command1 = FALSE /\ command2 = FALSE
        /\ successors = 0 /\ stage = 0 /\ retryPending = FALSE /\ originalConsumed = FALSE
        /\ resumes = 0 /\ memberRevoked = FALSE /\ ownerChanged = FALSE /\ recovered = FALSE
Eligible == ~memberRevoked /\ ~ownerChanged /\ successors = 0 /\ ~originalConsumed
RetryFacts == /\ successors' = IF Eligible /\ ~savedInitial THEN 1 ELSE successors
              /\ stage' = IF Eligible /\ ~savedInitial THEN 1 ELSE stage
              /\ retryPending' = (retryPending \/ (Eligible /\ ~savedInitial))
              /\ originalConsumed' = (originalConsumed \/ (Eligible /\ savedInitial))
              /\ resumes' = IF Eligible /\ savedInitial THEN 1 ELSE resumes
Retry1 == /\ ~command1 /\ command1' = TRUE /\ RetryFacts
          /\ UNCHANGED <<savedInitial, command2, memberRevoked, ownerChanged, recovered>>
Retry2 == /\ ~command2 /\ command2' = TRUE /\ RetryFacts
          /\ UNCHANGED <<savedInitial, command1, memberRevoked, ownerChanged, recovered>>
RevokePermission == /\ ~memberRevoked /\ successors = 0 /\ ~originalConsumed
                    /\ memberRevoked' = TRUE
                    /\ UNCHANGED <<savedInitial, command1, command2, successors, stage, retryPending, originalConsumed, resumes, ownerChanged, recovered>>
ChangeOwner == /\ ~savedInitial /\ ~ownerChanged /\ successors = 0
               /\ ownerChanged' = TRUE
               /\ UNCHANGED <<savedInitial, command1, command2, successors, stage, retryPending, originalConsumed, resumes, memberRevoked, recovered>>
ClaimRetry == /\ retryPending /\ stage' = 2 /\ retryPending' = FALSE
              /\ UNCHANGED <<savedInitial, command1, command2, successors, originalConsumed, resumes, memberRevoked, ownerChanged, recovered>>
SaveRetry == /\ stage = 2 /\ ~retryPending /\ stage' = 3
             /\ UNCHANGED <<savedInitial, command1, command2, successors, retryPending, originalConsumed, resumes, memberRevoked, ownerChanged, recovered>>
ConsumeRetry == /\ stage = 3 /\ stage' = 4 /\ resumes' = 1
                /\ UNCHANGED <<savedInitial, command1, command2, successors, retryPending, originalConsumed, memberRevoked, ownerChanged, recovered>>
ConsumeOriginal == /\ savedInitial /\ ~originalConsumed /\ successors = 0
                   /\ originalConsumed' = TRUE /\ resumes' = 1
                   /\ UNCHANGED <<savedInitial, command1, command2, successors, stage, retryPending, memberRevoked, ownerChanged, recovered>>
Recover == /\ ~recovered /\ recovered' = TRUE
           /\ retryPending' = (retryPending \/ stage = 2)
           /\ UNCHANGED <<savedInitial, command1, command2, successors, stage, originalConsumed, resumes, memberRevoked, ownerChanged>>
ReplayCommand == /\ (command1 \/ command2) /\ UNCHANGED vars
LateOriginal == UNCHANGED vars
Next == Retry1 \/ Retry2 \/ RevokePermission \/ ChangeOwner \/ ClaimRetry \/ SaveRetry \/ ConsumeRetry
        \/ ConsumeOriginal \/ Recover \/ ReplayCommand \/ LateOriginal
Spec == Init /\ [][Next]_vars /\ WF_vars(ClaimRetry) /\ WF_vars(SaveRetry) /\ WF_vars(ConsumeRetry) /\ WF_vars(ConsumeOriginal)
TypeOK == /\ savedInitial \in BOOLEAN /\ command1 \in BOOLEAN /\ command2 \in BOOLEAN
          /\ successors \in 0..1 /\ stage \in 0..4 /\ retryPending \in BOOLEAN /\ originalConsumed \in BOOLEAN
          /\ resumes \in 0..1 /\ memberRevoked \in BOOLEAN /\ ownerChanged \in BOOLEAN /\ recovered \in BOOLEAN
UniqueRetry == successors <= 1
ExclusiveResultChoice == ~(originalConsumed /\ successors > 0)
RetryAuthority == successors > 0 => ~memberRevoked /\ ~ownerChanged
RetryHandoff == (stage = 4 \/ originalConsumed) => resumes = 1
Progress == (successors = 1 ~> resumes = 1) /\ (savedInitial ~> resumes = 1)
NeverRetry == successors = 0
NeverSavedConsumption == ~originalConsumed
NeverRecovery == ~recovered
NeverRevokedRequest == ~(memberRevoked /\ (command1 \/ command2))
NeverOwnerChangedRequest == ~(ownerChanged /\ (command1 \/ command2))
=============================================================================
