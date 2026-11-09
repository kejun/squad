------------------------ MODULE InputBoundary ------------------------
EXTENDS Naturals, TLC
CONSTANT Kind
VARIABLES supplement, saved, consumed, applied, analysis, interpreter, owner, stopped, recovered, epoch, evidence, published
vars == <<supplement, saved, consumed, applied, analysis, interpreter, owner, stopped, recovered, epoch, evidence, published>>
Init == supplement = FALSE /\ saved = FALSE /\ consumed = FALSE /\ applied = FALSE /\ analysis = 0 /\ interpreter = FALSE /\ owner = 0 /\ stopped = FALSE /\ recovered = FALSE /\ epoch = 1 /\ evidence = (Kind = "check") /\ published = FALSE
Supplement == /\ ~supplement /\ ~stopped
    /\ supplement' = (TRUE)
    /\ analysis' = (1)
    /\ UNCHANGED <<saved, consumed, applied, interpreter, owner, stopped, recovered, epoch, evidence, published>>
Save == /\ Kind = "help" /\ ~saved /\ ~stopped
    /\ saved' = (TRUE)
    /\ UNCHANGED <<supplement, consumed, applied, analysis, interpreter, owner, stopped, recovered, epoch, evidence, published>>
ReturnCheck == /\ Kind = "check" /\ supplement /\ ~saved /\ ~stopped
    /\ saved' = (TRUE)
    /\ consumed' = (TRUE)
    /\ interpreter' = (TRUE)
    /\ UNCHANGED <<supplement, applied, analysis, owner, stopped, recovered, epoch, evidence, published>>
Flush == /\ Kind = "help" /\ supplement /\ saved /\ ~consumed
    /\ consumed' = (TRUE)
    /\ applied' = (IF stopped THEN applied ELSE TRUE)
    /\ interpreter' = (~stopped)
    /\ UNCHANGED <<supplement, saved, analysis, owner, stopped, recovered, epoch, evidence, published>>
ClaimAnalysis == /\ interpreter /\ analysis = 1 /\ ~stopped
    /\ analysis' = (2)
    /\ UNCHANGED <<supplement, saved, consumed, applied, interpreter, owner, stopped, recovered, epoch, evidence, published>>
Resolve == /\ analysis = 2 /\ ~stopped
    /\ applied' = (TRUE)
    /\ analysis' = (3)
    /\ owner' = (1)
    /\ evidence' = (FALSE)
    /\ UNCHANGED <<supplement, saved, consumed, interpreter, stopped, recovered, epoch, published>>
Clarify == /\ analysis = 2 /\ ~stopped
    /\ analysis' = (4)
    /\ UNCHANGED <<supplement, saved, consumed, applied, interpreter, owner, stopped, recovered, epoch, evidence, published>>
Continue == /\ analysis = 4 /\ epoch = 1 /\ ~stopped
    /\ analysis' = (1)
    /\ epoch' = (2)
    /\ evidence' = (FALSE)
    /\ UNCHANGED <<supplement, saved, consumed, applied, interpreter, owner, stopped, recovered, published>>
Stop == /\ supplement /\ ~stopped /\ analysis # 3
    /\ analysis' = (5)
    /\ owner' = (0)
    /\ stopped' = (TRUE)
    /\ UNCHANGED <<supplement, saved, consumed, applied, interpreter, recovered, epoch, evidence, published>>
Recover == /\ saved /\ ~recovered /\ ~stopped /\ analysis # 3
    /\ analysis' = (IF analysis = 2 THEN 1 ELSE analysis)
    /\ recovered' = (TRUE)
    /\ UNCHANGED <<supplement, saved, consumed, applied, interpreter, owner, stopped, epoch, evidence, published>>
LateAnalysis == /\ stopped /\ interpreter
    /\ UNCHANGED <<supplement, saved, consumed, applied, analysis, interpreter, owner, stopped, recovered, epoch, evidence, published>>
Next == Supplement \/ Save \/ ReturnCheck \/ Flush \/ ClaimAnalysis \/ Resolve \/ Clarify \/ Continue \/ Stop \/ Recover \/ LateAnalysis
ProgressStep == Flush \/ ClaimAnalysis \/ Resolve \/ Continue
Spec == Init /\ [][Next]_vars /\ WF_vars(ProgressStep)
TypeOK == /\ supplement \in BOOLEAN /\ saved \in BOOLEAN /\ consumed \in BOOLEAN /\ applied \in BOOLEAN
          /\ analysis \in 0..5 /\ interpreter \in BOOLEAN /\ owner \in 0..1 /\ stopped \in BOOLEAN
          /\ recovered \in BOOLEAN /\ epoch \in 1..2 /\ evidence \in BOOLEAN /\ published \in BOOLEAN
NoPrematureInterpretation == interpreter => consumed
AppliedInputBoundary == analysis = 3 => applied /\ ~evidence /\ owner = 1
NoUnresolvedPublication == ~published
NoUnresolvedOwner == owner > 0 => analysis \in {0,3}
StopCancelsInputSuccessor == stopped => owner = 0
Progress == (supplement /\ saved /\ ~stopped) ~> (analysis \in {3,4} \/ stopped)
NeverWaitingBoundary == ~(supplement /\ saved /\ ~consumed)
NeverResolved == analysis # 3
NeverClarified == analysis # 4
NeverStoppedSaved == ~(stopped /\ saved)
NeverRecoveredParsing == ~(recovered /\ interpreter /\ analysis = 1)
======================================================================
