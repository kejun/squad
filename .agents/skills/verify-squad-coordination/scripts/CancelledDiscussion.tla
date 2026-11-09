----------------------- MODULE CancelledDiscussion -----------------------
EXTENDS Naturals, TLC
CONSTANTS Mode, Physical, Origin
VARIABLES work1, work2, local, cancelled, recoveries, continued, ownerClaimed, newStage, new1, new2, primaryBusy, receiptAfterCancel
vars == <<work1, work2, local, cancelled, recoveries, continued, ownerClaimed, newStage, new1, new2, primaryBusy, receiptAfterCancel>>
Init == work1 = 1 /\ work2 = 1 /\ local = (IF Physical THEN 1 ELSE 0) /\ cancelled = FALSE /\ recoveries = 0 /\ continued = FALSE /\ ownerClaimed = FALSE /\ newStage = 0 /\ new1 = FALSE /\ new2 = FALSE /\ primaryBusy = (Origin = "discussion") /\ receiptAfterCancel = FALSE
Cancel == /\ ~cancelled
    /\ cancelled' = (TRUE)
    /\ UNCHANGED <<work1, work2, local, recoveries, continued, ownerClaimed, newStage, new1, new2, primaryBusy, receiptAfterCancel>>
Recover == /\ cancelled /\ recoveries < 2 /\ newStage = 0 /\ ~ownerClaimed
    /\ work1' = (IF local \in {1,2} THEN 4 ELSE 2)
    /\ work2' = (2)
    /\ local' = (IF local = 1 THEN 2 ELSE local)
    /\ primaryBusy' = FALSE
    /\ recoveries' = (recoveries+1)
    /\ UNCHANGED <<cancelled, continued, ownerClaimed, newStage, new1, new2, receiptAfterCancel>>
RoomApplies == Mode # "end" \/ work2 = 1 \/ (work1 = 1 /\ local \in {0,3})
Reopen == /\ cancelled /\ recoveries < 2 /\ newStage = 0 /\ ~ownerClaimed
    /\ work1' = (IF RoomApplies THEN (IF local \in {1,2} THEN 4 ELSE 2) ELSE work1)
    /\ work2' = (IF RoomApplies THEN 2 ELSE work2)
    /\ local' = (IF RoomApplies /\ local = 1 THEN 2 ELSE local)
    /\ primaryBusy' = (IF RoomApplies THEN FALSE ELSE primaryBusy)
    /\ recoveries' = recoveries + 1
    /\ UNCHANGED <<cancelled, continued, ownerClaimed, newStage, new1, new2, receiptAfterCancel>>
KnownReceipt == /\ local \in {1,2}
    /\ work1' = (IF cancelled THEN 2 ELSE work1)
    /\ local' = (3)
    /\ receiptAfterCancel' = cancelled
    /\ UNCHANGED <<work2, cancelled, recoveries, continued, ownerClaimed, newStage, new1, new2, primaryBusy>>
BlockedContinue == /\ cancelled /\ recoveries > 0 /\ (local \in {1,2} \/ primaryBusy)
    /\ UNCHANGED <<work1, work2, local, cancelled, recoveries, continued, ownerClaimed, newStage, new1, new2, primaryBusy, receiptAfterCancel>>
Continue == /\ cancelled /\ recoveries > 0 /\ work1 = 2 /\ work2 = 2 /\ Mode # "goal" /\ ~continued /\ ~primaryBusy
    /\ continued' = (TRUE)
    /\ UNCHANGED <<work1, work2, local, cancelled, recoveries, ownerClaimed, newStage, new1, new2, primaryBusy, receiptAfterCancel>>
ClaimOwner == /\ cancelled /\ recoveries > 0 /\ work1 = 2 /\ work2 = 2 /\ (Mode = "goal" \/ continued) /\ ~ownerClaimed /\ ~primaryBusy
    /\ ownerClaimed' = (TRUE)
    /\ UNCHANGED <<work1, work2, local, cancelled, recoveries, continued, newStage, new1, new2, primaryBusy, receiptAfterCancel>>
Invite == /\ ownerClaimed /\ newStage = 0
    /\ newStage' = (1)
    /\ UNCHANGED <<work1, work2, local, cancelled, recoveries, continued, ownerClaimed, new1, new2, primaryBusy, receiptAfterCancel>>
ClaimPlanner == /\ newStage = 1
    /\ newStage' = (2)
    /\ UNCHANGED <<work1, work2, local, cancelled, recoveries, continued, ownerClaimed, new1, new2, primaryBusy, receiptAfterCancel>>
Plan == /\ newStage = 2
    /\ newStage' = (3)
    /\ UNCHANGED <<work1, work2, local, cancelled, recoveries, continued, ownerClaimed, new1, new2, primaryBusy, receiptAfterCancel>>
ClaimNew1 == /\ newStage = 3 /\ ~new1
    /\ new1' = (TRUE)
    /\ UNCHANGED <<work1, work2, local, cancelled, recoveries, continued, ownerClaimed, newStage, new2, primaryBusy, receiptAfterCancel>>
ClaimNew2 == /\ newStage = 3 /\ ~new2
    /\ new2' = (TRUE)
    /\ UNCHANGED <<work1, work2, local, cancelled, recoveries, continued, ownerClaimed, newStage, new1, primaryBusy, receiptAfterCancel>>
Late1 == /\ cancelled
    /\ work1' = (IF local \in {0,3} THEN 2 ELSE work1)
    /\ UNCHANGED <<work2, local, cancelled, recoveries, continued, ownerClaimed, newStage, new1, new2, primaryBusy, receiptAfterCancel>>
Late2 == /\ cancelled
    /\ work2' = (2)
    /\ UNCHANGED <<work1, local, cancelled, recoveries, continued, ownerClaimed, newStage, new1, new2, primaryBusy, receiptAfterCancel>>
LateOwner == /\ cancelled /\ primaryBusy
    /\ primaryBusy' = FALSE
    /\ UNCHANGED <<work1, work2, local, cancelled, recoveries, continued, ownerClaimed, newStage, new1, new2, receiptAfterCancel>>
Next == LateOwner \/ Cancel \/ Recover \/ Reopen \/ KnownReceipt \/ BlockedContinue \/ Continue \/ ClaimOwner \/ Invite \/ ClaimPlanner \/ Plan \/ ClaimNew1 \/ ClaimNew2 \/ Late1 \/ Late2
Spec == Init /\ [][Next]_vars /\ WF_vars(Recover) /\ WF_vars(KnownReceipt)
TypeOK == /\ work1 \in {1,2,4} /\ work2 \in {1,2} /\ local \in 0..3 /\ cancelled \in BOOLEAN
          /\ recoveries \in 0..2 /\ continued \in BOOLEAN /\ ownerClaimed \in BOOLEAN
          /\ newStage \in 0..3 /\ new1 \in BOOLEAN /\ new2 \in BOOLEAN /\ primaryBusy \in BOOLEAN /\ receiptAfterCancel \in BOOLEAN
CancelledRetirement == cancelled /\ recoveries > 0 => work2 = 2 /\ (local \in {0,3} => work1 = 2)
UnknownMemberRetention == cancelled /\ recoveries > 0 /\ local \in {1,2} => work1 \in {1,4}
KnownReceiptRetirement == receiptAfterCancel => work1 = 2
RoundIsolation == new1 \/ new2 => work1 = 2 /\ work2 = 2 /\ ~primaryBusy
RetirementProgress == cancelled ~> (work1 = 2 /\ work2 = 2)
NeverRecoveredUnknown == ~(recoveries > 0 /\ local = 2 /\ work1 = 4)
NeverRetired == ~(cancelled /\ work1 = 2 /\ work2 = 2)
NeverReinvited == ~(new1 /\ new2)
======================================================================
