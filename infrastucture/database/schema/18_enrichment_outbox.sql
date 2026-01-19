-- Table: dbo.EnrichmentOutbox

IF NOT EXISTS (
    SELECT 1 FROM sys.objects
    WHERE object_id = OBJECT_ID(N'[dbo].[EnrichmentOutbox]') AND type = 'U'
)
BEGIN
    CREATE TABLE dbo.EnrichmentOutbox
    (
        OutboxId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_EnrichmentOutbox PRIMARY KEY,
        EventType NVARCHAR(128) NOT NULL,              -- e.g. "EnrichmentRunCompleted"
        AggregateId UNIQUEIDENTIFIER NOT NULL,         -- RunId
        CreatedAt DATETIMEOFFSET(7) NOT NULL,
        PayloadJson NVARCHAR(MAX) NOT NULL,

        PublishedAt DATETIMEOFFSET(7) NULL,
        PublishAttempts INT NOT NULL CONSTRAINT DF_EnrichmentOutbox_Attempts DEFAULT 0,
        LastPublishError NVARCHAR(2000) NULL,

        LockedUntil DATETIMEOFFSET(7) NULL,
        LockToken UNIQUEIDENTIFIER NULL,

        CONSTRAINT CK_EnrichmentOutbox_Payload_IsJson CHECK (ISJSON(PayloadJson) = 1)
    );

    -- Optional FK back to runs (nice for cleanup integrity)
    IF OBJECT_ID('dbo.EnrichmentRuns','U') IS NOT NULL
    BEGIN
        ALTER TABLE dbo.EnrichmentOutbox
          ADD CONSTRAINT FK_EnrichmentOutbox_Runs
          FOREIGN KEY (AggregateId) REFERENCES dbo.EnrichmentRuns(RunId);
    END
END
GO

-- Find unpublished quickly
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes
    WHERE name = 'IX_EnrichmentOutbox_Unpublished'
      AND object_id = OBJECT_ID(N'[dbo].[EnrichmentOutbox]')
)
BEGIN
    CREATE INDEX IX_EnrichmentOutbox_Unpublished
    ON dbo.EnrichmentOutbox (PublishedAt, CreatedAt)
    INCLUDE (EventType, AggregateId, PublishAttempts, LockedUntil);
END
GO
