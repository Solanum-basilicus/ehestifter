-- 26_add_ats_vendor_to_job_offerings.sql

IF OBJECT_ID(N'dbo.JobOfferings', N'U') IS NULL
BEGIN
    RAISERROR('dbo.JobOfferings does not exist.', 16, 1);
    RETURN;
END;

IF COL_LENGTH(N'dbo.JobOfferings', N'AtsVendor') IS NULL
BEGIN
    ALTER TABLE dbo.JobOfferings
        ADD AtsVendor NVARCHAR(100) NULL;
END;
GO