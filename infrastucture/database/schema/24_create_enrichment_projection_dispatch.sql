-- 24_create_enrichment_projection_dispatch.sql

IF OBJECT_ID(N'dbo.EnrichmentProjectionDispatch', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.EnrichmentProjectionDispatch
    (
        DispatchId       UNIQUEIDENTIFIER NOT NULL
            CONSTRAINT PK_EnrichmentProjectionDispatch PRIMARY KEY,
        RunId            UNIQUEIDENTIFIER NOT NULL,
        EnricherType     NVARCHAR(128) NOT NULL,
        ProjectionType   NVARCHAR(128) NOT NULL,
        TargetDomain     NVARCHAR(64) NOT NULL,
        TargetKey        NVARCHAR(256) NOT NULL,
        Status           NVARCHAR(32) NOT NULL,
        AttemptCount     INT NOT NULL
            CONSTRAINT DF_EnrichmentProjectionDispatch_AttemptCount DEFAULT (0),
        LastAttemptAt    DATETIMEOFFSET NULL,
        NextAttemptAt    DATETIMEOFFSET NULL,
        PayloadJson      NVARCHAR(MAX) NOT NULL,
        LastError        NVARCHAR(2000) NULL,
        CreatedAt        DATETIMEOFFSET NOT NULL,
        UpdatedAt        DATETIMEOFFSET NOT NULL,

        CONSTRAINT FK_EnrichmentProjectionDispatch_Run
            FOREIGN KEY (RunId) REFERENCES dbo.EnrichmentRuns(RunId),

        CONSTRAINT UQ_EnrichmentProjectionDispatch_Run_ProjectionType
            UNIQUE (RunId, ProjectionType),

        CONSTRAINT CK_EnrichmentProjectionDispatch_Status
            CHECK (Status IN ('Pending', 'Delivered', 'Failed', 'DeadLetter', 'Skipped'))
    );

    CREATE INDEX IX_EnrichmentProjectionDispatch_Status_NextAttemptAt
        ON dbo.EnrichmentProjectionDispatch(Status, NextAttemptAt);

    CREATE INDEX IX_EnrichmentProjectionDispatch_TargetDomain_Status_NextAttemptAt
        ON dbo.EnrichmentProjectionDispatch(TargetDomain, Status, NextAttemptAt);
END
GO