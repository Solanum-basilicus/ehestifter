SET XACT_ABORT ON;
BEGIN TRANSACTION;



------------------------------------------------------------
-- UserJobStatus: make job-driven join covering
-- Current unique index exists, but this avoids lookups for
-- Status / LastUpdated in list queries.
------------------------------------------------------------
IF OBJECT_ID(N'dbo.UserJobStatus', N'U') IS NULL
BEGIN
    RAISERROR('dbo.UserJobStatus does not exist.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_UserJobStatus_JobUser_Incl'
      AND object_id = OBJECT_ID(N'dbo.UserJobStatus')
)
BEGIN
    CREATE INDEX IX_UserJobStatus_JobUser_Incl
        ON dbo.UserJobStatus (JobOfferingId, UserId)
        INCLUDE (Status, LastUpdated);
END;



------------------------------------------------------------
-- JobOfferingLocations: fast location hydration for selected
-- cards after main page query
------------------------------------------------------------
IF OBJECT_ID(N'dbo.JobOfferingLocations', N'U') IS NULL
BEGIN
    RAISERROR('dbo.JobOfferingLocations does not exist.', 16, 1);
    ROLLBACK TRANSACTION;
    RETURN;
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_JobOfferingLocations_JobOfferingId_Order'
      AND object_id = OBJECT_ID(N'dbo.JobOfferingLocations')
)
BEGIN
    CREATE INDEX IX_JobOfferingLocations_JobOfferingId_Order
        ON dbo.JobOfferingLocations (JobOfferingId, CountryName, CityName)
        INCLUDE (CountryCode, Region);
END;




COMMIT TRANSACTION;