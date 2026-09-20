-- 28_locations_v2_branch_facts.sql
-- Preserve the direct location branch that produced each Locations v2 fact.
-- Direct Locations v2 rows and Locations v1 data are not changed.

SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'dbo.JobOfferingLocationsV2', N'U') IS NULL
BEGIN
    RAISERROR('dbo.JobOfferingLocationsV2 does not exist. Apply 27_locations_v2.sql first.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END;

-- Derived facts can be rebuilt from direct Locations v2 rows and the catalog.
-- Drop only the two derived tables so the schema does not keep both aggregate
-- and branch-aware representations.
IF OBJECT_ID(N'dbo.JobOfferingLocationUtcOffsetsV2', N'U') IS NOT NULL
    DROP TABLE dbo.JobOfferingLocationUtcOffsetsV2;

IF OBJECT_ID(N'dbo.JobOfferingLocationFactsV2', N'U') IS NOT NULL
    DROP TABLE dbo.JobOfferingLocationFactsV2;

CREATE TABLE dbo.JobOfferingLocationFactsV2 (
    DirectLocationV2Id BIGINT NOT NULL,
    LocationKind VARCHAR(20) NOT NULL,
    LocationId NVARCHAR(64) NOT NULL,

    CONSTRAINT PK_JobOfferingLocationFactsV2
        PRIMARY KEY (DirectLocationV2Id, LocationKind, LocationId),
    CONSTRAINT FK_JobOfferingLocationFactsV2_DirectLocation
        FOREIGN KEY (DirectLocationV2Id)
        REFERENCES dbo.JobOfferingLocationsV2(Id) ON DELETE CASCADE,
    CONSTRAINT CK_JobOfferingLocationFactsV2_Kind
        CHECK (LocationKind IN ('city', 'adminRegion', 'country', 'globalRegion'))
);

CREATE INDEX IX_JobOfferingLocationFactsV2_LocationBranch
    ON dbo.JobOfferingLocationFactsV2 (LocationKind, LocationId, DirectLocationV2Id);

CREATE TABLE dbo.JobOfferingLocationUtcOffsetsV2 (
    DirectLocationV2Id BIGINT NOT NULL,
    UtcOffsetMinutes SMALLINT NOT NULL,

    CONSTRAINT PK_JobOfferingLocationUtcOffsetsV2
        PRIMARY KEY (DirectLocationV2Id, UtcOffsetMinutes),
    CONSTRAINT FK_JobOfferingLocationUtcOffsetsV2_DirectLocation
        FOREIGN KEY (DirectLocationV2Id)
        REFERENCES dbo.JobOfferingLocationsV2(Id) ON DELETE CASCADE
);

CREATE INDEX IX_JobOfferingLocationUtcOffsetsV2_OffsetBranch
    ON dbo.JobOfferingLocationUtcOffsetsV2 (UtcOffsetMinutes, DirectLocationV2Id);

COMMIT TRANSACTION;
GO
