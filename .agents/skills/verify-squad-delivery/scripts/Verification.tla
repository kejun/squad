--------------------------- MODULE Verification ---------------------------
EXTENDS Naturals, TLC
CONSTANT Mutation
VARIABLES stage, changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected
vars == <<stage, changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
Init == /\ stage = 0 /\ changed = FALSE /\ published = FALSE /\ stopped = FALSE
        /\ online = TRUE /\ rolledBack = FALSE /\ unsafeModel = FALSE /\ versioned = FALSE /\ validated = FALSE /\ versionRejected = FALSE
ConsumeEarly == /\ online /\ stage \in 0..3
    /\ unsafeModel' = (Mutation = "skip-validation")
    /\ UNCHANGED <<stage, changed, published, stopped, online, rolledBack, versioned, validated, versionRejected>>
RequestValidation == /\ online /\ stage = 0
    /\ stage' = 1
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
ClaimValidation == /\ online /\ stage = 1
    /\ stage' = 2
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
StartValidation == /\ online /\ stage = 2
    /\ stage' = 3
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
ValidationPassed == /\ online /\ stage = 3
    /\ stage' = 4
    /\ validated' = TRUE
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, versionRejected>>
ValidationFailed == /\ online /\ stage = 3
    /\ stage' = 4
    /\ validated' = FALSE
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, versionRejected>>
FailWork == /\ online /\ stage = 4 /\ ~validated
    /\ stage' = 11
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
Consume == /\ online /\ stage = 4 /\ validated
    /\ stage' = 5
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
ModelResult == /\ online /\ stage = 5
    /\ stage' = 6
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
ChangeWorkspace == /\ online /\ stage \in 4..9 /\ ~changed
    /\ changed' = TRUE
    /\ UNCHANGED <<stage, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
RequestVersion == /\ online /\ stage = 6
    /\ stage' = 7
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
ClaimVersion == /\ online /\ stage = 7
    /\ stage' = 8
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
StartVersion == /\ online /\ stage = 8
    /\ stage' = 9
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
VersionResult == /\ online /\ stage = 9
    /\ stage' = 10
    /\ versioned' = TRUE
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, validated, versionRejected>>
Publish == /\ online /\ stage = 10
    /\ stage' = 11
    /\ published' = (~changed \/ (Mutation = "accept-changed" /\ ~versionRejected))
    /\ UNCHANGED <<changed, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
PublishWithoutVersion == /\ online /\ stage = 6
    /\ stage' = 11
    /\ published' = (Mutation = "skip-version")
    /\ UNCHANGED <<changed, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
Stop == /\ online /\ stage < 11
    /\ stage' = 11
    /\ stopped' = TRUE
    /\ UNCHANGED <<changed, published, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
Late == /\ online /\ stage = 11
    /\ UNCHANGED <<stage, changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
Rollback == /\ online /\ stage = 10 /\ ~rolledBack
    /\ online' = FALSE
    /\ rolledBack' = TRUE
    /\ UNCHANGED <<stage, changed, published, stopped, unsafeModel, versioned, validated, versionRejected>>
Reopen == /\ ~online
    /\ online' = TRUE
    /\ UNCHANGED <<stage, changed, published, stopped, rolledBack, unsafeModel, versioned, validated, versionRejected>>
VersionFailure == /\ online /\ stage = 9 /\ changed /\ stage' = 10 /\ versionRejected' = TRUE
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated>>
FailVersionWork == /\ online /\ stage = 10 /\ versionRejected /\ stage' = 11
    /\ UNCHANGED <<changed, published, stopped, online, rolledBack, unsafeModel, versioned, validated, versionRejected>>
Next == VersionFailure \/ FailVersionWork \/ ConsumeEarly \/ RequestValidation \/ ClaimValidation \/ StartValidation \/ ValidationPassed \/ ValidationFailed \/ FailWork \/ Consume \/ ModelResult \/ ChangeWorkspace \/ RequestVersion \/ ClaimVersion \/ StartVersion \/ VersionResult \/ Publish \/ PublishWithoutVersion \/ Stop \/ Late \/ Rollback \/ Reopen
Spec == Init /\ [][Next]_vars /\ WF_vars(Publish) /\ WF_vars(Reopen)
TypeOK == /\ stage \in 0..11 /\ changed \in BOOLEAN /\ published \in BOOLEAN /\ stopped \in BOOLEAN /\ online \in BOOLEAN /\ rolledBack \in BOOLEAN /\ unsafeModel \in BOOLEAN /\ versioned \in BOOLEAN /\ validated \in BOOLEAN /\ versionRejected \in BOOLEAN
ModelNeedsValidation == ~unsafeModel
OrderedPublication == published => (stage = 11 /\ validated /\ versioned /\ ~changed /\ ~stopped)
Progress == stage = 10 ~> stage = 11
NeverModelRequested == stage # 5
NeverPublished == ~published
NeverChanged == ~changed
NeverRolledBack == ~rolledBack
=======================================================================
