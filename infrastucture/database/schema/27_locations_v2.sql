-- 27_locations_v2.sql
-- Additive Locations v2 storage. Locations v1 stays active until issue #21.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'dbo.JobOfferings', N'U') IS NULL
BEGIN
    RAISERROR('dbo.JobOfferings does not exist.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END;

IF OBJECT_ID(N'dbo.JobOfferingLocationsV2', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.JobOfferingLocationsV2 (
        Id BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_JobOfferingLocationsV2 PRIMARY KEY,
        JobOfferingId UNIQUEIDENTIFIER NOT NULL,
        LocationKind VARCHAR(20) NOT NULL,
        LocationId NVARCHAR(64) NOT NULL,
        DisplayName NVARCHAR(300) NOT NULL,
        CountryCode CHAR(2) NULL,
        SourceLocationV1Id BIGINT NULL,
        CatalogVersion NVARCHAR(64) NOT NULL,

        CONSTRAINT FK_JobOfferingLocationsV2_JobOfferings
            FOREIGN KEY (JobOfferingId) REFERENCES dbo.JobOfferings(Id) ON DELETE CASCADE,
        CONSTRAINT CK_JobOfferingLocationsV2_Kind
            CHECK (LocationKind IN ('city', 'adminRegion', 'country', 'globalRegion')),
        CONSTRAINT CK_JobOfferingLocationsV2_CountryCode
            CHECK (CountryCode IS NULL OR (LEN(CountryCode) = 2 AND CountryCode = UPPER(CountryCode)))
    );

    CREATE UNIQUE INDEX UX_JobOfferingLocationsV2_JobLocation
        ON dbo.JobOfferingLocationsV2 (JobOfferingId, LocationKind, LocationId);

    CREATE INDEX IX_JobOfferingLocationsV2_LocationJob
        ON dbo.JobOfferingLocationsV2 (LocationKind, LocationId, JobOfferingId)
        INCLUDE (CountryCode, DisplayName);
END;

IF OBJECT_ID(N'dbo.JobOfferingLocationFactsV2', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.JobOfferingLocationFactsV2 (
        JobOfferingId UNIQUEIDENTIFIER NOT NULL,
        LocationKind VARCHAR(20) NOT NULL,
        LocationId NVARCHAR(64) NOT NULL,

        CONSTRAINT PK_JobOfferingLocationFactsV2
            PRIMARY KEY (JobOfferingId, LocationKind, LocationId),
        CONSTRAINT FK_JobOfferingLocationFactsV2_JobOfferings
            FOREIGN KEY (JobOfferingId) REFERENCES dbo.JobOfferings(Id) ON DELETE CASCADE,
        CONSTRAINT CK_JobOfferingLocationFactsV2_Kind
            CHECK (LocationKind IN ('city', 'adminRegion', 'country', 'globalRegion'))
    );

    CREATE INDEX IX_JobOfferingLocationFactsV2_LocationJob
        ON dbo.JobOfferingLocationFactsV2 (LocationKind, LocationId, JobOfferingId);
END;

IF OBJECT_ID(N'dbo.JobOfferingLocationUtcOffsetsV2', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.JobOfferingLocationUtcOffsetsV2 (
        JobOfferingId UNIQUEIDENTIFIER NOT NULL,
        UtcOffsetMinutes SMALLINT NOT NULL,

        CONSTRAINT PK_JobOfferingLocationUtcOffsetsV2
            PRIMARY KEY (JobOfferingId, UtcOffsetMinutes),
        CONSTRAINT FK_JobOfferingLocationUtcOffsetsV2_JobOfferings
            FOREIGN KEY (JobOfferingId) REFERENCES dbo.JobOfferings(Id) ON DELETE CASCADE
    );

    CREATE INDEX IX_JobOfferingLocationUtcOffsetsV2_OffsetJob
        ON dbo.JobOfferingLocationUtcOffsetsV2 (UtcOffsetMinutes, JobOfferingId);
END;

IF OBJECT_ID(N'dbo.JobOfferingWorkTimeConstraintsV2', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.JobOfferingWorkTimeConstraintsV2 (
        Id BIGINT IDENTITY(1,1) NOT NULL
            CONSTRAINT PK_JobOfferingWorkTimeConstraintsV2 PRIMARY KEY,
        JobOfferingId UNIQUEIDENTIFIER NOT NULL,
        OffsetRangeStartMinutes SMALLINT NOT NULL,
        OffsetRangeEndMinutes SMALLINT NOT NULL,

        CONSTRAINT FK_JobOfferingWorkTimeConstraintsV2_JobOfferings
            FOREIGN KEY (JobOfferingId) REFERENCES dbo.JobOfferings(Id) ON DELETE CASCADE,
        CONSTRAINT CK_JobOfferingWorkTimeConstraintsV2_Order
            CHECK (OffsetRangeStartMinutes <= OffsetRangeEndMinutes)
    );

    CREATE UNIQUE INDEX UX_JobOfferingWorkTimeConstraintsV2_JobRange
        ON dbo.JobOfferingWorkTimeConstraintsV2 (
            JobOfferingId,
            OffsetRangeStartMinutes,
            OffsetRangeEndMinutes
        );
END;

COMMIT TRANSACTION;
GO
