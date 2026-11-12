--------------------------- MODULE Verification ---------------------------
EXTENDS Naturals, TLC
CONSTANT Mutation
VARIABLES stage, changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge
vars == <<stage, changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
Init == /\ stage = 0 /\ changed = FALSE /\ published = FALSE /\ stopped = FALSE
        /\ online = TRUE /\ rolledBack = FALSE /\ earlyCheckAllowed = FALSE /\ versioned = FALSE /\ validated = FALSE /\ versionRejected = FALSE /\ gapsDeclared = FALSE /\ verifiedBadge = FALSE
ConsumeEarly == /\ online /\ stage \in 0..3 /\ ~earlyCheckAllowed
    /\ earlyCheckAllowed' = TRUE
    /\ UNCHANGED <<stage, changed, published, stopped, online, rolledBack, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
RequestValidation == /\ online /\ stage = 0
    /\ stage' = 1
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
ClaimValidation == /\ online /\ stage = 1
    /\ stage' = 2
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
StartValidation == /\ online /\ stage = 2
    /\ stage' = 3
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
ValidationPassed == /\ online /\ stage = 3
    /\ stage' = 4
    /\ validated' = TRUE
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, versionRejected, gapsDeclared, verifiedBadge>>
ValidationFailed == /\ online /\ stage = 3
    /\ stage' = 4
    /\ validated' = FALSE
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, versionRejected, gapsDeclared, verifiedBadge>>
FailWork == /\ online /\ stage = 4 /\ ~validated
    /\ stage' = 11
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
Consume == /\ online /\ stage = 4
    /\ stage' = 5
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
ModelResult == /\ online /\ stage = 5
    /\ stage' = 6
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
ChangeWorkspace == /\ online /\ stage \in 4..9 /\ ~changed
    /\ changed' = TRUE
    /\ UNCHANGED <<stage, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
RequestVersion == /\ online /\ stage = 6 /\ validated
    /\ stage' = 7
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
ClaimVersion == /\ online /\ stage = 7
    /\ stage' = 8
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
StartVersion == /\ online /\ stage = 8
    /\ stage' = 9
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
VersionResult == /\ online /\ stage = 9
    /\ stage' = 10
    /\ versioned' = TRUE
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, validated, versionRejected, gapsDeclared, verifiedBadge>>
Publish == /\ online /\ stage = 10
    /\ stage' = 11 /\ published' = TRUE
    /\ gapsDeclared' = (IF Mutation = "hide-validation-gap" \/ Mutation = "skip-version" \/ (Mutation = "accept-changed" /\ versioned /\ ~versionRejected) THEN FALSE ELSE (~validated \/ ~versioned \/ changed \/ versionRejected))
    /\ verifiedBadge' = (Mutation = "ignore-verification-badge" \/ (validated /\ (Mutation = "skip-version" \/ (versioned /\ ~versionRejected /\ (~changed \/ Mutation = "accept-changed")))))
    /\ UNCHANGED <<changed, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected>>
PublishWithoutVersion == /\ online /\ stage = 6
    /\ stage' = 11 /\ published' = TRUE
    /\ gapsDeclared' = (Mutation # "hide-validation-gap" /\ Mutation # "skip-version")
    /\ verifiedBadge' = (Mutation = "ignore-verification-badge" \/ (validated /\ (Mutation = "skip-version" \/ (versioned /\ ~versionRejected /\ (~changed \/ Mutation = "accept-changed")))))
    /\ UNCHANGED <<changed, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected>>
Stop == /\ online /\ stage < 11
    /\ stage' = 11
    /\ stopped' = TRUE
    /\ UNCHANGED <<changed, published, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
Late == /\ online /\ stage = 11
    /\ UNCHANGED <<stage, changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
Rollback == /\ online /\ stage = 10 /\ ~rolledBack
    /\ online' = FALSE
    /\ rolledBack' = TRUE
    /\ UNCHANGED <<stage, changed, published, stopped, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
Reopen == /\ ~online
    /\ online' = TRUE
    /\ UNCHANGED <<stage, changed, published, stopped, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected, gapsDeclared, verifiedBadge>>
VersionFailure == /\ online /\ stage = 9 /\ changed /\ stage' = 10 /\ versionRejected' = TRUE
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, gapsDeclared, verifiedBadge>>
FailVersionWork == /\ online /\ stage = 10 /\ versionRejected
    /\ stage' = 11 /\ published' = TRUE /\ gapsDeclared' = (Mutation # "hide-validation-gap" /\ Mutation # "skip-version")
    /\ verifiedBadge' = (Mutation = "ignore-verification-badge" \/ (validated /\ (Mutation = "skip-version" \/ (versioned /\ ~versionRejected /\ (~changed \/ Mutation = "accept-changed")))))
    /\ UNCHANGED <<changed, stopped, online, rolledBack, earlyCheckAllowed, versioned, validated, versionRejected>>
Next == VersionFailure \/ FailVersionWork \/ ConsumeEarly \/ RequestValidation \/ ClaimValidation \/ StartValidation \/ ValidationPassed \/ ValidationFailed \/ FailWork \/ Consume \/ ModelResult \/ ChangeWorkspace \/ RequestVersion \/ ClaimVersion \/ StartVersion \/ VersionResult \/ Publish \/ PublishWithoutVersion \/ Stop \/ Late \/ Rollback \/ Reopen
Spec == Init /\ [][Next]_vars /\ WF_vars(Publish) /\ WF_vars(Reopen)
TypeOK == /\ stage \in 0..11 /\ changed \in BOOLEAN /\ published \in BOOLEAN /\ stopped \in BOOLEAN /\ online \in BOOLEAN /\ rolledBack \in BOOLEAN /\ earlyCheckAllowed \in BOOLEAN /\ versioned \in BOOLEAN /\ validated \in BOOLEAN /\ versionRejected \in BOOLEAN /\ gapsDeclared \in BOOLEAN /\ verifiedBadge \in BOOLEAN
HonestVerification == published /\ (~validated \/ ~versioned \/ changed \/ versionRejected) => (gapsDeclared /\ ~verifiedBadge)
OrderedPublication == published => (stage = 11 /\ ~stopped)
Progress == stage = 10 ~> stage = 11
NeverModelRequested == stage # 5
NeverEarlyCheck == ~earlyCheckAllowed
NeverFailedValidationDelivery == ~(published /\ ~validated)
NeverPublished == ~published
NeverChanged == ~changed
NeverRolledBack == ~rolledBack
=======================================================================
